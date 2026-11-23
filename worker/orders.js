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

/* Does this payment pay for exactly this order?
   ---------------------------------------------------------------------------
   A matching amount is not enough: two different baskets can cost the same.
   The payment's lines were priced by the same function from the same menu at
   payment time, so they are compared as canonical JSON, together with the
   order type, the company flag and every amount. A menu price changed between
   paying and sending makes them differ — and that is right: such an order is
   then resolved by a person, not guessed at. W02-04. */
async function verifiedPayment(env, paymentId, priced, body) {
  if (!paymentId) return null;
  const row = await env.DB.prepare(
    `SELECT id, reference, status, amount, currency, subtotal, discount, fee,
            order_type, business, lines
       FROM payments WHERE id = ?1`
  ).bind(paymentId).first();
  if (!row || !LINKABLE.has(row.status)) return null;

  let lines;
  try { lines = JSON.stringify(JSON.parse(row.lines || '[]')); } catch { return null; }
  const same =
    lines === JSON.stringify(priced.lines) &&
    row.order_type === (body.type === 'pickup' ? 'pickup' : 'delivery') &&
    !!row.business === !!body.business &&
    row.amount === priced.total &&
    row.subtotal === priced.subtotal &&
    row.discount === priced.discount &&
    row.fee === priced.fee &&
    (row.currency || 'EUR') === 'EUR';
  return same ? row : null;
}

/** The order a verified payment already paid for, if it has been stored. */
async function orderForPayment(env, paymentId) {
  if (!paymentId) return null;
  return env.DB.prepare(
    'SELECT id, reference, total FROM orders WHERE payment_id = ?1'
  ).bind(paymentId).first();
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

  /* One payment, one order — asked before the throttle. The recovery path in
     the browser hands a paid order over again after a reload; that is the same
     dinner, and it must get the same reference back, not a second row and not
     a 202 that reads like a refusal. W02-04. */
  const already = await orderForPayment(env, claimed);
  if (already) return { ...already, alerted: false, replay: true };

  if (await throttled(env, ip)) return null;
  await recordAttempt(env, ip);

  // Prices come from the menu, never from the browser. Throws PricingError for
  // an unknown dish or an empty basket, which the route turns into a plain 400.
  const priced = await quote(env, body);

  /* A payment counts only when it is real and is for this food. An order paid
     online reuses the payment's reference — printed on the payment and in the
     chat — and only an order without a verified payment mints a new one.

     A payment the browser named but that does not check out is kept beside the
     order, never as its payment: the order is stored as to be paid on site,
     marked `unverified`, shown that way at /admin and ALWAYS announced, so the
     counter checks it by hand rather than handing food over on a claim or
     charging a guest twice. W01-05. */
  const payment = await verifiedPayment(env, claimed, priced, body);
  const unverified = !!claimed && !payment;
  const reference = payment ? payment.reference : newReference();

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO orders (id, reference, payment_id, order_type, business,
         pay_method, postcode, lines, subtotal, discount, fee, total, currency,
         requested_time, customer_name, customer_phone, customer_address,
         customer_company, notes, claimed_payment_id, payment_check, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'EUR',?13,?14,?15,?16,?17,?18,
               ?19,?20, datetime('now'))`
    ).bind(
      id, reference, payment ? payment.id : null,
      body.type === 'pickup' ? 'pickup' : 'delivery',
      body.business ? 1 : 0,
      payment ? 'online' : 'onsite',
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
      unverified ? 'unverified' : null
    ).run();
  } catch (err) {
    /* Two handovers of the same payment racing each other: the unique index
       let exactly one in. The loser answers with the winner's order. */
    const winner = payment ? await orderForPayment(env, payment.id) : null;
    if (winner) return { ...winner, alerted: false, replay: true };
    throw err;
  }

  return {
    id,
    reference,
    total: priced.total,
    /* A captured payment was announced the moment the money arrived, and
       announcing it again would buzz the phone twice for one dinner. Every
       other order — cash, a payment still under review, a claim that did not
       check out — is announced here, because nothing else will. */
    alerted: !payment || payment.status !== 'captured'
  };
}

/** One order for the admin page, details and all. */
export async function getOrder(env, id) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first();
}
