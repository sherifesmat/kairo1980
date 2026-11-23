/* Recording the order, not only the money.
   ---------------------------------------------------------------------------
   The rule that shapes every route on this server holds here too: the browser
   says WHAT it wants, the server says what it COSTS. The basket, the order type
   and the postcode are read from the request; every figure is recomputed by
   worker/pricing.js from the published menu. Nothing about money is believed.

   What IS taken from the body is the part no server can compute: who the guest
   is and where the food goes. Those four fields are the only personal data this
   site has ever stored, they are read at /admin behind the login, they are
   never put in a notification, and the nightly sweep nulls them after 90 days.

   NEVER BLOCKS THE ORDER. This is the rule the whole basket is built on and it
   applies with particular force here, because by the time this is called the
   guest has already pressed send. A throttled caller, an unpriceable basket, a
   database that will not answer — all of them return a plain failure that the
   browser ignores, and the WhatsApp handover proceeds exactly as it did before
   this file existed. Losing an order to our own bookkeeping would be worse than
   the problem this solves. */

import { quote } from './pricing.js';
import { newReference } from './payments/store.js';

/* Ten announcements from one address in ten minutes is far beyond a person
   ordering dinner and far below anything a real guest could trip. Counting
   rows in a window rather than holding a counter keeps this stateless across
   isolates, which is the only way it can work on Workers at all. */
const MAX_PER_WINDOW = 10;
const WINDOW_MINUTES = 10;

export async function throttled(env, ip) {
  if (!ip) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM order_rate
        WHERE ip = ?1 AND at > datetime('now', ?2)`
    ).bind(ip, `-${WINDOW_MINUTES} minutes`).first();
    return !!row && row.n >= MAX_PER_WINDOW;
  } catch {
    // A counter that cannot be read must never refuse a real order. The cost
    // of failing open is a noisy phone; the cost of failing closed is a lost
    // dinner, and this whole file exists to stop losing those.
    return false;
  }
}

async function recordAttempt(env, ip) {
  if (!ip) return;
  try {
    // The write pays for the cleanup, so the table never grows and an IP —
    // which is personal data — is held for minutes rather than kept.
    await env.DB.prepare(
      `DELETE FROM order_rate WHERE at <= datetime('now', ?1)`
    ).bind(`-${WINDOW_MINUTES} minutes`).run();
    await env.DB.prepare('INSERT INTO order_rate (ip) VALUES (?1)').bind(ip).run();
  } catch { /* counting is best-effort; it must not fail an order */ }
}

/** Trim to something a database column and a printed ticket can both hold.
 *  Long enough for a real Egyptian name, a real street and a real note. */
const clip = (value, max) => {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
};

/* Which payment states may stand behind an order.
   ---------------------------------------------------------------------------
   `captured` is money taken. `pending` is a capture the provider is still
   reviewing: real, linked, and announced as awaiting settlement, never as paid.
   Everything else — created, approved (approved to capture is not captured),
   failed, cancelled, or a refund before the food was even handed over — cannot
   claim to have paid for anything. Loop WEBSITE_ORDERING, W02-03. */
const LINKABLE = new Set(['captured', 'pending']);

/* What makes two handovers the SAME order.
   ---------------------------------------------------------------------------
   Two handovers are the same order when these agree:
   - the basket as the guest built it: dish keys and quantities, never prices.
     A menu price that changes between two handovers of one dinner therefore
     cannot make it look new;
   - the order type;
   - the company flag;
   - for a delivery, where it goes.
   Notes, name and the chosen time are not part of it. A guest who corrects a
   typo and presses send again is sending the same dinner.

   This is read from the request alone, before pricing and before the
   throttle, so a replay at the limit is still answered with its order. Loop
   WEBSITE_ORDERING, R3-01 / R3-03. */
export function orderIdentity(body) {
  const items = Object.entries((body && body.items) || {})
    .map(([key, qty]) => [String(key), Math.floor(Number(qty))])
    .filter(([, qty]) => Number.isFinite(qty) && qty > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const delivery = !!body && body.type !== 'pickup';
  return JSON.stringify({
    items,
    type: delivery ? 'delivery' : 'pickup',
    business: !!(body && body.business),
    postcode: delivery ? clip(body.postcode, 16) : null
  });
}

/* Does this payment pay for exactly this order?
   ---------------------------------------------------------------------------
   A matching amount is not enough: two different baskets can cost the same,
   and two delivery postcodes can carry the same fee.

   The payment's lines were priced by the same function from the same menu at
   payment time, so they are compared as canonical JSON. So are the order
   type, the company flag and every amount, and, for a delivery, the postcode
   the guest paid to have it brought to.

   A menu price changed between paying and sending makes them differ, and that
   is right: such an order is resolved by a person, not guessed at.
   W02-04, R3-02. */
async function verifiedPayment(env, paymentId, priced, body) {
  if (!paymentId) return null;
  const row = await env.DB.prepare(
    `SELECT id, reference, status, amount, currency, subtotal, discount, fee,
            order_type, business, postcode, lines
       FROM payments WHERE id = ?1`
  ).bind(paymentId).first();
  if (!row || !LINKABLE.has(row.status)) return null;

  let lines;
  try { lines = JSON.stringify(JSON.parse(row.lines || '[]')); } catch { return null; }
  const delivery = body.type !== 'pickup';
  const same =
    lines === JSON.stringify(priced.lines) &&
    row.order_type === (delivery ? 'delivery' : 'pickup') &&
    !!row.business === !!body.business &&
    (!delivery || clip(row.postcode, 16) === clip(body.postcode, 16)) &&
    row.amount === priced.total &&
    row.subtotal === priced.subtotal &&
    row.discount === priced.discount &&
    row.fee === priced.fee &&
    (row.currency || 'EUR') === 'EUR';
  return same ? row : null;
}

/* The order this handover repeats, if it is a repeat.
   ---------------------------------------------------------------------------
   A handover is a replay only if it names the same payment AND carries the
   same order. It does not matter whether that payment was verified for the
   order or only claimed.

   A different basket, type or destination under a known payment id is a NEW
   order. It is stored and announced as one. It never inherits another order's
   payment or reference, and it is never swallowed as a repeat. R3-01. */
const REPEAT_COLUMNS = `id, reference, total, requested_time, customer_address,
       customer_phone, notes, details_purged_at`;

async function repeatedOrder(env, paymentId, identity) {
  if (!paymentId) return null;
  const row = await env.DB.prepare(
    `SELECT ${REPEAT_COLUMNS} FROM orders
      WHERE order_identity = ?2 AND (payment_id = ?1 OR claimed_payment_id = ?1)
      LIMIT 1`
  ).bind(paymentId, identity).first();
  return row || legacyRepeat(env, paymentId, identity);
}

/* The identity of an order stored before migration 0006, rebuilt from what it
   kept. Pricing writes one line per basket key with the guest's quantity
   (`{id: key, qty}`), under the same whole-number rule `orderIdentity` uses, so
   nothing is lost in the rebuild. R4-01. */
function storedIdentity(row) {
  let lines;
  try { lines = JSON.parse(row.lines || '[]'); } catch { return null; }
  if (!Array.isArray(lines)) return null;
  const items = {};
  for (const line of lines) items[line.id] = (items[line.id] || 0) + Number(line.qty);
  return orderIdentity({
    items,
    type: row.order_type,
    business: !!row.business,
    postcode: row.postcode
  });
}

/* An order from before 0006 carries no identity, so the lookup above can never
   find it. Without this, a guest's browser handing an old paid order over again
   would meet a payment already taken and be stored as a second, flagged order.
   The rebuilt identity must equal this handover's; a different basket under the
   same payment id is still a new order. On a match the identity is written onto
   the row, once, so the next replay is found directly. R4-01. */
async function legacyRepeat(env, paymentId, identity) {
  const { results } = await env.DB.prepare(
    `SELECT ${REPEAT_COLUMNS}, lines, order_type, business, postcode FROM orders
      WHERE order_identity IS NULL AND (payment_id = ?1 OR claimed_payment_id = ?1)`
  ).bind(paymentId).all();
  const match = (results || []).find((row) => storedIdentity(row) === identity);
  if (!match) return null;
  await env.DB.prepare(
    'UPDATE orders SET order_identity = ?2 WHERE id = ?1 AND order_identity IS NULL'
  ).bind(match.id, identity).run();
  return match;
}

/* What a guest may still change about an order they already sent.
   ---------------------------------------------------------------------------
   These fields change what the kitchen or the driver does: when, where to, how
   to reach the guest, and what to cook differently. A replay that changes any
   of them is a CORRECTION to the same order. The order is updated and the
   kitchen is told, so the counter never works from an old address or an old
   time. The name and the company are labels; a change there is a typo fixed,
   kept silently.

   A correction never touches the basket, the money or the payment: those are
   the order's identity, and a change there is a new order. R4-02. */
const AMENDABLE = [
  ['requested_time', (b) => clip(b.time, 120), 'Termin'],
  ['customer_address', (b) => clip(b.address, 240), 'Adresse'],
  ['customer_phone', (b) => clip(b.phone, 40), 'Telefon'],
  ['notes', (b) => clip(b.notes, 500), 'Anmerkung']
];

function corrections(row, body) {
  return AMENDABLE
    .filter(([column, read]) => (row[column] ?? null) !== read(body))
    .map(([column, read, label]) => ({ column, before: row[column] ?? null, after: read(body), label }));
}

/* Apply a correction, once. The update names the values it read, so two
   identical corrections racing each other change the row once, and only the one
   that changed it tells the kitchen. */
async function amend(env, row, changes) {
  const sets = changes.map((c, i) => `${c.column} = ?${i + 2}`).join(', ');
  const guards = changes.map((c, i) => `${c.column} IS ?${i + 2 + changes.length}`).join(' AND ');
  const result = await env.DB.prepare(
    `UPDATE orders SET ${sets}, amended_at = datetime('now'),
            amendments = COALESCE(amendments, 0) + 1
      WHERE id = ?1 AND details_purged_at IS NULL AND ${guards}`
  ).bind(row.id, ...changes.map((c) => c.after), ...changes.map((c) => c.before)).run();
  return Number(result?.meta?.changes || 0) > 0;
}

/** Is this payment already the payment of some order? */
async function paymentTaken(env, paymentId) {
  const row = await env.DB.prepare('SELECT 1 AS taken FROM orders WHERE payment_id = ?1')
    .bind(paymentId).first();
  return !!row;
}

const CORRECTION_ATTEMPTS = 3;

/* A replay of an order already stored: either nothing changed, or a correction.

   - An order whose personal details were already deleted by the retention
     sweep is never amended. Writing a phone, an address or a note into it
     would bring back data that was deliberately removed, and the sweep never
     looks at a row twice, so nothing would remove it again. An order that old
     has nothing left to correct anyway. R5-02.
   - Two DIFFERENT corrections can race. The guarded update lets one in; the
     other then reads the row again and tries against the current values. Each
     correction that is actually written tells the kitchen. One that is already
     present (an identical correction that won) tells nobody. One that still
     cannot be written after a few tries is answered as a conflict, never as
     "recorded". R5-01. */
async function correctOrder(env, stored, body, ip) {
  const answer = { id: stored.id, reference: stored.reference, total: stored.total,
                   alerted: false, replay: true };
  if (stored.details_purged_at) return answer;
  if (!corrections(stored, body).length) return answer;

  if (await throttled(env, ip)) return null;
  await recordAttempt(env, ip);

  let current = stored;
  let labels = corrections(stored, body).map((c) => c.label);
  /* Every pass, including the one after the last failed try, asks the row as
     it now stands: purged, or already holding what was asked, ends it as a
     plain replay. Only a row that still differs after the last try is a
     conflict (R6-02). The update itself also refuses a purged row, so a sweep
     landing between the read and the write cannot be undone by it (R6-01). */
  for (let attempt = 0; ; attempt++) {
    if (!current || current.details_purged_at) return answer;
    const changes = corrections(current, body);
    if (!changes.length) return answer;
    if (attempt === CORRECTION_ATTEMPTS) break;
    labels = changes.map((c) => c.label);
    if (await amend(env, current, changes)) return { ...answer, amended: labels };
    current = await env.DB.prepare(`SELECT ${REPEAT_COLUMNS} FROM orders WHERE id = ?1`)
      .bind(stored.id).first();
  }
  return { ...answer, conflict: true, amended: labels };
}

/**
 * Store one order and answer with the reference to print in the chat.
 *
 * @returns {Promise<{id: string, reference: string, total: number,
 *                    alerted: boolean, replay?: boolean} | null>}
 *          null when nothing was stored (throttled)
 */
export async function recordOrder(env, body, ip) {
  const claimed = clip(body.paymentId, 64);
  const identity = orderIdentity(body);

  /* One payment, one order. This is asked before the throttle.

     After a reload, the browser's recovery path hands a paid order over again.
     That is the same dinner, so it must get the same reference back. Not a
     second row, not a second alert, and not a 202 that reads like a refusal.
     W02-04, R3-03.

     A replay that changes when, where to, how to reach the guest or what to
     cook differently is a correction. It counts against the throttle like any
     other write, and it reaches the kitchen. R4-02. */
  const already = await repeatedOrder(env, claimed, identity);
  if (already) return correctOrder(env, already, body, ip);

  if (await throttled(env, ip)) return null;
  await recordAttempt(env, ip);

  // Prices come from the menu, never from the browser. Throws PricingError for
  // an unknown dish or an empty basket, which the route turns into a plain 400.
  const priced = await quote(env, body);

  /* A payment counts only when it is real, is for this food, and is not
     already the payment of another order. An order paid online reuses the
     payment's reference, which is printed on the payment and in the chat. Only
     an order without a verified payment mints a new reference.

     A payment the browser named but that does not check out is kept beside the
     order, never as its payment. The order is:
     - stored as to be paid on site and marked `unverified`;
     - reported that way to the books and shown that way at /admin;
     - ALWAYS announced.
     That way the counter checks it by hand rather than handing food over on a
     claim or charging a guest twice. W01-05. */
  let payment = await verifiedPayment(env, claimed, priced, body);
  if (payment && await paymentTaken(env, payment.id)) payment = null;

  const insert = async (link) => {
    const id = crypto.randomUUID();
    const reference = link ? link.reference : newReference();
    const unverified = !!claimed && !link;
    await env.DB.prepare(
      `INSERT INTO orders (id, reference, payment_id, order_type, business,
         pay_method, postcode, lines, subtotal, discount, fee, total, currency,
         requested_time, customer_name, customer_phone, customer_address,
         customer_company, notes, claimed_payment_id, payment_check,
         order_identity, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'EUR',?13,?14,?15,?16,?17,?18,
               ?19,?20,?21, datetime('now'))`
    ).bind(
      id, reference, link ? link.id : null,
      body.type === 'pickup' ? 'pickup' : 'delivery',
      body.business ? 1 : 0,
      link ? 'online' : 'onsite',
      clip(body.postcode, 16),
      JSON.stringify(priced.lines),
      priced.subtotal, priced.discount, priced.fee, priced.total,
      clip(body.time, 120),
      clip(body.name, 120),
      clip(body.phone, 40),
      clip(body.address, 240),
      clip(body.company, 120),
      clip(body.notes, 500),
      unverified ? claimed : null,
      unverified ? 'unverified' : null,
      identity
    ).run();
    return {
      id,
      reference,
      total: priced.total,
      /* A captured payment was announced the moment the money arrived, and
         announcing it again would buzz the phone twice for one dinner. Every
         other order is announced here, because nothing else will: cash, a
         payment still under review, a claim that did not check out. */
      alerted: !link || link.status !== 'captured'
    };
  };

  try {
    return await insert(payment);
  } catch (err) {
    /* A race that the unique indexes settled.
       - If the winner is this same order (two handovers of one dinner arriving
         together), answer with it.
       - If the winner is a DIFFERENT order that took this payment first, this
         one is still a real order. It is stored as an unverified claim and
         announced. */
    const winner = await repeatedOrder(env, claimed, identity);
    if (winner) {
      return { id: winner.id, reference: winner.reference, total: winner.total,
               alerted: false, replay: true };
    }
    if (payment) return insert(null);
    throw err;
  }
}

/** One order for the admin page, details and all. */
export async function getOrder(env, id) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
}
