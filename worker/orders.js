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

import { quote, PricingError, checkRequestShape } from './pricing.js';
import { newReference, moneyState, NO_CHARGE_SQL } from './payments/store.js';
import { readPostcode, townsOf } from './site-data.js';

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
function basketOf(items) {
  return Object.entries(items || {})
    .map(([key, qty]) => [String(key), Math.floor(Number(qty))])
    .filter(([, qty]) => Number.isFinite(qty) && qty > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function orderIdentity(body) {
  const items = basketOf(body && body.items);
  const delivery = !!body && body.type !== 'pickup';
  const identity = {
    items,
    type: delivery ? 'delivery' : 'pickup',
    business: !!(body && body.business),
    postcode: delivery ? clip(body.postcode, 16) : null
  };
  /* A delivery chosen from the list also names its town (PO-15): 68723 is three
     towns, and two of them are not the same destination. A request without a
     town -- every order from before the list -- keeps exactly the identity it
     always had, so an old order is still found by its replay. */
  if (delivery && typeof body.town === 'string') identity.town = clip(body.town, 80);
  return JSON.stringify(identity);
}

/* Is this request going where a stored row (an order or a payment) goes?
   ---------------------------------------------------------------------------
   Two rows made from the list match only as the exact same pair.

   A row or request from before the list holds the postcode as typed ("68799
   Reilingen") and no town. Either side may be one. They are the same place only
   when both read as the same five-digit postcode (a value with no postcode in it
   is never a place, so "Schwetzingen" never matches "Schwetzingen"), and
   - both name the same town, or neither names one; or
   - one names a town and the other none, and the list has exactly that one
     town for the postcode: "68799" is Reilingen, while a bare "68723" is three
     towns and matches none of them.
   So "68723 Oftersheim" never pays for "68723 Plankstadt". DP-22-02. */
function placeOf(postcode, town) {
  if (town != null) {
    return typeof postcode === 'string' && typeof town === 'string'
      ? { code: postcode, town, listed: true } : { code: null };
  }
  /* Read as written. A stored row already holds what it was clipped to then; a
     request is never cut down here, so a conflicting suffix beyond the old
     16-character column cannot be dropped to make it match (DP-23-01). */
  if (typeof postcode !== 'string' || postcode.length > 64) return { code: null };
  const read = readPostcode(postcode);
  return { code: read.code, town: read.town, listed: false };
}

function sameDestination(storedPostcode, storedTown, body) {
  const was = placeOf(storedPostcode, storedTown);
  const now = placeOf(body.postcode, body.town);
  if (!was.code || was.code !== now.code) return false;
  if (was.listed && now.listed) return was.town === now.town;
  const fold = (town) => town.toLocaleLowerCase('de');
  if (was.town && now.town) return fold(was.town) === fold(now.town);
  if (!was.town && !now.town) return true;
  const towns = townsOf(was.code);
  return towns.length === 1 && fold(towns[0]) === fold(was.town || now.town);
}

/** The basket a stored row was priced for, from its own lines. */
function basketOfLines(json) {
  let lines;
  try { lines = JSON.parse(json || '[]'); } catch { return null; }
  if (!Array.isArray(lines)) return null;
  const items = {};
  for (const line of lines) items[line.id] = (items[line.id] || 0) + Number(line.qty);
  return items;
}

/* Is this handover the order a stored row is for: an order already stored, or
   the payment the guest made? The same basket (from the row's own lines, never
   re-priced), the same type, the same company flag and, for a delivery, the
   same destination (above). The money is the row's own: a menu price changed
   since does not make the paid dinner a different one. DP-22-02. */
function sameOrder(row, body) {
  if (row.order_type !== body.type) return false;
  if (!!row.business !== !!body.business) return false;
  const items = basketOfLines(row.lines);
  if (!items || JSON.stringify(basketOf(items)) !== JSON.stringify(basketOf(body.items))) return false;
  return body.type !== 'delivery' || sameDestination(row.postcode, row.town, body);
}

export { checkRequestShape };

/* The order this handover repeats, if it is a repeat.
   ---------------------------------------------------------------------------
   A handover is a replay only if it names the same payment AND carries the
   same order. A row is that order when it is the same order read from its own
   columns (sameOrder), or, for a row from before the towns, when its identity
   is exactly this handover's: that is how an old order whose typed postcode no
   longer reads as a place is still answered with its own reference. A row with
   a town is never matched on its identity alone (DP-23-01). */
const REPEAT_COLUMNS = `id, reference, total, requested_time, customer_address,
       customer_phone, notes, details_purged_at`;
const ORDER_ROW = `${REPEAT_COLUMNS}, order_identity, lines, order_type, business, postcode, town,
       payment_id, claimed_payment_id`;

function isThisOrder(row, body, identity) {
  if (sameOrder(row, body)) return true;
  /* The identity holds the postcode as the old column clipped it (16
     characters). A request longer than that would only match by being cut
     down, so it never does: the shortcut is for the exact old handover, as
     it was sent then (DP-24-01). */
  const uncut = body.type !== 'delivery' || body.postcode == null
    || (typeof body.postcode === 'string' && body.postcode.trim().length <= 16);
  return row.town == null && uncut && row.order_identity === identity;
}

/** Every order stored under this payment id, as paid or as claimed. */
async function ordersUnder(env, paymentId) {
  const { results } = await env.DB.prepare(
    `SELECT ${ORDER_ROW} FROM orders WHERE payment_id = ?1 OR claimed_payment_id = ?1`
  ).bind(paymentId).all();
  return results || [];
}

/* The one row among `rows` that this handover is, or a conflict when two are.
   On a match the identity is written onto a row that has none, once; a stored
   identity is never rewritten. R4-01, DP-22-02. */
async function repeatAmong(env, rows, body, identity) {
  const matches = rows.filter((row) => isThisOrder(row, body, identity));
  if (matches.length > 1) return { ambiguous: true, reference: matches[0].reference };
  const match = matches[0];
  if (!match) return null;
  if (match.order_identity == null) {
    await env.DB.prepare(
      'UPDATE orders SET order_identity = ?2 WHERE id = ?1 AND order_identity IS NULL'
    ).bind(match.id, identity).run();
  }
  return match;
}

/* The payment this id names, in whatever state the provider left it. */
async function paymentRow(env, paymentId) {
  if (!paymentId) return null;
  return env.DB.prepare(
    `SELECT id, reference, provider, status, amount, currency, subtotal, discount, fee,
            order_type, business, postcode, town, lines, failure_code
       FROM payments WHERE id = ?1`
  ).bind(paymentId).first();
}

/* States in which the money may still arrive: the guest was sent to the
   provider, or approved there, and the capture has not been seen yet. */
const IN_FLIGHT = new Set(['created', 'approved']);

/* Is a payment's own snapshot whole enough to stand for an order? Whole cents,
   in euros, the figures adding up, and lines that name dishes. A snapshot that
   is not is a matter for a person, never a reason to price it again. */
function wholeSnapshot(payment) {
  const cents = (n, min) => Number.isSafeInteger(n) && n >= min;
  // The currency column is NOT NULL and every payment this site made is EUR.
  if (payment.currency !== 'EUR') return false;
  if (!cents(payment.amount, 1) || !cents(payment.subtotal, 0)
      || !cents(payment.discount, 0) || !cents(payment.fee, 0)) return false;
  // A discount is on food, so never more than the food it is taken from.
  if (payment.discount > payment.subtotal) return false;
  if (payment.subtotal - payment.discount + payment.fee !== payment.amount) return false;
  if (payment.order_type !== 'delivery' && payment.order_type !== 'pickup') return false;
  let lines;
  try { lines = JSON.parse(payment.lines || ''); } catch { return false; }
  if (!Array.isArray(lines) || !lines.length) return false;
  const seen = new Set();
  let sum = 0;
  for (const line of lines) {
    if (!line || typeof line.id !== 'string' || !line.id || seen.has(line.id)) return false;
    if (!cents(line.qty, 1) || !cents(line.amount, 0)) return false;
    seen.add(line.id);
    sum += line.amount;
    if (!Number.isSafeInteger(sum)) return false;
  }
  return sum === payment.subtotal;
}

/* The order as it was paid for: the payment's own lines and money, and its own
   destination. Never re-priced. */
function asPaid(payment) {
  return {
    lines: JSON.parse(payment.lines || '[]'),
    subtotal: payment.subtotal,
    discount: payment.discount,
    fee: payment.fee,
    total: payment.amount,
    destination: payment.order_type === 'delivery'
      ? { postcode: payment.postcode, town: payment.town ?? null }
      : null
  };
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

/* Only what the guest actually sent counts as a correction. A field left empty
   or missing -- a page that lost its form on a reload, a quiet retry of a
   handover whose answer never arrived -- is not an instruction to erase the
   address or the phone the kitchen already has (DP-24-02). And a handover the
   page marks as a recovery corrects nothing at all: its form may belong to a
   different basket the guest has started since. */
const isRecovery = (body) => !!body && body.recovery === true;
const given = (v) => typeof v === 'string' && v.trim() !== '';
const contactGiven = (body) => given(body.name) && given(body.phone)
  && (body.type === 'pickup' || given(body.address));

/* A recovery is the page asking, after a reload or a lost answer, whether the
   order for its payment is in. It carries the basket and where it goes, never
   the guest's details (the page keeps none). It finds a stored order and is
   answered with its reference; it never creates one, because an order with no
   name, phone or address is no order the kitchen can cook. With nothing stored
   the page is told so and asks the guest to confirm their details (DP-24-02). */
function corrections(row, body) {
  if (isRecovery(body)) return [];
  return AMENDABLE
    .filter(([, read]) => read(body) !== null)
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
 * @returns {Promise<object | null>} the order, or one of
 *          { paymentConflict, reference, payment? }  a person must resolve it,
 *          { paymentUnsettled, reference }           the money is not in yet,
 *          { detailsNeeded, reference }              a recovery found no order,
 *          { closed: true }                          nothing new while closed,
 *          null                                      throttled
 */
export async function recordOrder(env, body, ip, { recoveryOnly = false } = {}) {
  checkRequestShape(body);
  const claimed = clip(body.paymentId, 64);
  const identity = orderIdentity(body);

  /* The payment is read first, and its state decides (DP-23-01):
     - real money (captured, or pending with the provider): handed over only as
       the order its own snapshot is, linked once. Anything else under that id,
       linked or not, is a conflict for a person, never another order;
     - money that may still arrive (created, approved): nothing is stored yet;
       the guest's page keeps the payment and asks again;
     - no money (failed, cancelled, refunded) or an id that is not a payment: a
       claim, stored to be paid on site and flagged, as before (R3-01, W01-05). */
  const payment = await paymentRow(env, claimed);
  if (payment && LINKABLE.has(payment.status)) return handOverPaid(env, body, ip, payment, claimed, identity);
  if (payment && IN_FLIGHT.has(payment.status)) {
    return { paymentUnsettled: true, reference: payment.reference };
  }
  /* A payment nobody has shown to hold no money (a refund, part of one, an
     amount that did not match, a failure never classified) is a person's to
     resolve. An order already stored under it is answered as before; a new
     one is never made from it, to be paid on site or otherwise (DP-25-01). */
  const manual = !!payment && moneyState(payment) === 'manual';

  /* One claimed id, one order. Asked before the throttle: after a reload the
     browser hands the same dinner over again, and it gets the same reference
     back, not a second row and not a 202. A replay that changes when, where to,
     how to reach the guest or a note is a correction. W02-04, R3-03, R4-02. */
  if (claimed) {
    const already = await repeatAmong(env, await ordersUnder(env, claimed), body, identity);
    if (already && already.ambiguous) return { paymentConflict: true, reference: already.reference };
    if (already) return correctOrder(env, already, body, ip);
  }
  if (manual) return { paymentConflict: true, reference: payment.reference, payment };
  if (isRecovery(body)) return { detailsNeeded: true, reference: payment ? payment.reference : null };

  if (await throttled(env, ip)) return null;
  await recordAttempt(env, ip);

  /* While the restaurant is closed, only money already taken is recorded. */
  if (recoveryOnly) return { closed: true };

  // Prices come from the menu, never from the browser. Throws PricingError for
  // an unknown dish or an empty basket, which the route turns into a plain 400.
  const priced = await quote(env, body);
  // A new delivery goes only to a listed postcode-and-town pair. An enquiry for
  // any other postcode is a question in the chat, not an order in the books
  // (PO-15). Nothing is stored and nobody is told an order is real.
  if (!priced.deliverable) {
    throw new PricingError('postcode_not_listed', 'Please choose your postcode and town from the list.');
  }
  return insertOrder(env, body, priced, null, claimed, identity);
}

/* Real money handed over with an order.
   ---------------------------------------------------------------------------
   Its own snapshot is the agreed order. The same basket, type, company flag and
   destination link it, at the money it was paid for, whatever the menu, the
   tariff, the list or the service mode says now; a replay of it is answered
   with its reference (and a correction reaches the kitchen). Everything else is
   NOT this payment's order and is not guessed at: a different order under the
   same id, an order claimed under it before the money arrived, two candidates,
   or a snapshot that does not add up. Nothing is stored, the payment keeps its
   reference and status, the counter is told once, and a person resolves it.
   It is never turned into an order to be paid on site. DP-22-02, DP-23-01. */
async function handOverPaid(env, body, ip, payment, claimed, identity) {
  const conflict = { paymentConflict: true, reference: payment.reference, payment };
  const rows = await ordersUnder(env, payment.id);
  const linked = rows.filter((row) => row.payment_id === payment.id);
  if (linked.length) {
    const already = await repeatAmong(env, linked, body, identity);
    return already && !already.ambiguous ? correctOrder(env, already, body, ip) : conflict;
  }
  // An order claimed under this id while the money was not in. It is not linked
  // here, and it is not answered as if it were settled: a person reconciles it.
  if (rows.length) return conflict;
  if (!wholeSnapshot(payment) || !sameOrder(payment, body)) return conflict;
  // A quiet recovery finds an order; it never makes one without the guest.
  if (isRecovery(body)) return { detailsNeeded: true, reference: payment.reference };
  /* A new paid order is made only with who to cook for and how to reach them:
     a name, a phone, and for a delivery an address. Without them the page is
     told to ask; nothing half-filled is stored (DP-25-02). A replay of an order
     already stored is answered above and is never held to this. */
  if (!contactGiven(body)) return { detailsNeeded: true, reference: payment.reference };
  return insertOrder(env, body, asPaid(payment), payment, claimed, identity);
}

async function insertOrder(env, body, priced, payment, claimed, identity) {
  const insert = async (link) => {
    const id = crypto.randomUUID();
    const reference = link ? link.reference : newReference();
    const unverified = !!claimed && !link;
    /* A linked order is written only while the payment still stands as it was
       read: the same status family and the same amount, checked in the same
       statement. A payment refunded or failed in between writes nothing. */
    const result = await env.DB.prepare(
      `INSERT INTO orders (id, reference, payment_id, order_type, business,
         pay_method, postcode, lines, subtotal, discount, fee, total, currency,
         requested_time, customer_name, customer_phone, customer_address,
         customer_company, notes, claimed_payment_id, payment_check,
         order_identity, created_at, town)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'EUR',?13,?14,?15,?16,?17,?18,
              ?19,?20,?21, datetime('now'), ?22
        WHERE (?3 IS NULL AND (?19 IS NULL OR NOT EXISTS (
                SELECT 1 FROM payments WHERE id = ?19 AND NOT ${NO_CHARGE_SQL})))
           OR (?3 IS NOT NULL AND EXISTS (
                SELECT 1 FROM payments WHERE id = ?3 AND amount = ?23
                   AND status IN ('captured', 'pending')))`
    ).bind(
      id, reference, link ? link.id : null,
      body.type === 'pickup' ? 'pickup' : 'delivery',
      body.business ? 1 : 0,
      link ? 'online' : 'onsite',
      priced.destination ? clip(priced.destination.postcode, 16) : null,
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
      identity,
      priced.destination ? priced.destination.town : null,
      link ? link.amount : null
    ).run();
    if (Number(result?.meta?.changes || 0) === 0) return null;
    /* A captured payment was announced the moment the money arrived, and
       announcing it again would buzz the phone twice for one dinner. Every
       other order is announced here, because nothing else will: cash, a
       payment still under review, a claim that did not check out. The state is
       read as it is now: a capture that landed since the first read was already
       announced by the capture itself. */
    let now = link ? link.status : null;
    if (link) {
      const current = await env.DB.prepare('SELECT status FROM payments WHERE id = ?1').bind(link.id).first();
      now = current ? current.status : now;
    }
    return { id, reference, total: priced.total, alerted: !link || now !== 'captured' };
  };

  try {
    const stored = await insert(payment);
    if (stored) return stored;
    /* Nothing was written: the payment changed between the read and the write.
       Money that arrived (or may yet) beside a claim is never answered with an
       order to be paid on site; a paid link that no longer stands goes to a
       person (DP-24-01). */
    const now = await paymentRow(env, payment ? payment.id : claimed);
    if (now && IN_FLIGHT.has(now.status)) return { paymentUnsettled: true, reference: now.reference };
    return { paymentConflict: true, reference: (now || payment).reference, payment: now || payment };
  } catch (err) {
    /* Only a race the unique indexes settled is answered here; any other failure
       is a failure. The winner is found the way a replay is, so two spellings of
       one dinner racing each other are one order. A paid handover that lost to
       something that is NOT this order is a conflict for a person: it is never
       stored again as an order to be paid on site. DP-22-02. */
    if (!/UNIQUE/i.test(String(err && err.message))) throw err;
    const rows = claimed ? await ordersUnder(env, claimed) : [];
    const winner = await repeatAmong(env, payment ? rows.filter((r) => r.payment_id === payment.id) : rows,
                                     body, identity);
    if (winner && !winner.ambiguous) {
      return { id: winner.id, reference: winner.reference, total: winner.total,
               alerted: false, replay: true };
    }
    if (payment) return { paymentConflict: true, reference: payment.reference, payment };
    throw err;
  }
}

/** One order for the admin page, details and all. */
export async function getOrder(env, id) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
}
