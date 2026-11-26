/* What a handover may do depends on what the payment it names IS (DP-23-01).
   KBOSS loop DELIVERY_PRICING, round 23 (ChatGPT).

   - captured or pending: the order its own snapshot is, linked once; anything
     else under that id, linked or not, is a conflict for a person;
   - created or approved: the money may still arrive, so nothing is stored yet;
   - failed, cancelled, refunded, or an id that is no payment: a flagged claim,
     to be paid on site, as before (R3-01, W01-05).

   Every case runs the real routes on a migrated database, through the provider
   fake, and asserts the rows, the alerts and the report. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
import { orderIdentity } from '../../worker/orders.js';
import { workerEnv, fakePayPal, orderResponse, webhookEvent, webhookHeaders } from '../helpers/env.js';

const MENU = { koshari: { price: 1450, name: 'Koshari' }, feast: { price: 5300, name: 'Feast' } };
const SECRETS = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242', REPORT_TOKEN: 'report-token-for-tests' };
const SEND = '/botbot-token/sendMessage';
const GUEST = { time: 'So schnell wie möglich', name: 'Test Gast', phone: '+49 176 1234567', address: 'Hauptstraße 1' };
const REILINGEN = { items: { feast: 1 }, type: 'delivery', business: false, postcode: '68799', town: 'Reilingen' };
const PICKUP = { items: { koshari: 2 }, type: 'pickup', business: false };

function ctx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settled: () => Promise.all(promises) };
}
const request = (path, body, headers = {}) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

function world(t) {
  const env = workerEnv(MENU, SECRETS);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);
  const providerOrders = () => paypal.calls.filter((k) => k.path === '/v2/checkout/orders').length;
  return { env, c, alerts, providerOrders };
}

async function call(env, c, path, body, headers) {
  const res = await worker.fetch(request(path, body, headers), env, c);
  await c.settled();
  return { status: res.status, body: await res.json().catch(() => null) };
}
const rows = (env, table) => env.DB._raw.prepare(`SELECT * FROM ${table}`).all();

async function created(env, c, order) {
  const shown = (await call(env, c, '/api/payments/quote', order)).body.total;
  const res = await call(env, c, '/api/payments', { ...order, method: 'paypal', expectedTotal: shown });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** The provider says so, by signed webhook. No capture response ever reaches the page. */
async function webhook(env, c, payment, type, id) {
  const res = await call(env, c, '/api/webhooks/paypal', webhookEvent({
    id, type, paymentId: payment.id, reference: payment.reference, amount: payment.amount, orderId: 'PP-ORDER-1'
  }), webhookHeaders());
  assert.ok(res.status < 300, JSON.stringify(res.body));
}

const status = (env, id) => env.DB._raw.prepare('SELECT status FROM payments WHERE id = ?').get(id).status;

/* --- settled only by webhook ------------------------------------------------- */

for (const [order, name] of [[REILINGEN, 'delivery'], [PICKUP, 'pickup']]) {
  test(`${name}: created, handed over, settled only by webhook, handed over again: one order, linked, paid once`, async (t) => {
    const { env, c, alerts, providerOrders } = world(t);
    const payment = await created(env, c, order);

    // The page hands over before the money is seen: nothing is stored.
    const early = await call(env, c, '/api/orders/announce', { ...GUEST, ...order, paymentId: payment.id });
    assert.deepEqual([early.status, early.body.reason, early.body.reference], [409, 'payment_unsettled', payment.reference]);
    assert.equal(rows(env, 'orders').length, 0, 'no order to be paid on site beside the money');
    assert.equal(alerts().length, 0);

    // Under review first, then captured, by webhook only.
    await webhook(env, c, payment, 'PAYMENT.CAPTURE.PENDING', 'WH-P');
    assert.equal(status(env, payment.id), 'pending');
    const pending = await call(env, c, '/api/orders/announce', { ...GUEST, ...order, paymentId: payment.id });
    assert.equal(pending.body.reference, payment.reference);
    let [stored] = rows(env, 'orders');
    assert.deepEqual([stored.payment_id, stored.pay_method, stored.payment_check], [payment.id, 'online', null]);
    assert.match(alerts().at(-1), /NOCH IN PRÜFUNG/, 'a pending payment is announced as awaiting settlement');

    await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
    assert.equal(status(env, payment.id), 'captured');
    const late = await call(env, c, '/api/orders/announce', { ...GUEST, ...order, paymentId: payment.id });
    assert.equal(late.body.reference, payment.reference);

    assert.equal(rows(env, 'orders').length, 1);
    [stored] = rows(env, 'orders');
    assert.deepEqual([stored.total, stored.pay_method], [payment.amount, 'online']);
    assert.equal(providerOrders(), 1, 'one provider order: nothing charged twice');
    assert.equal(alerts().filter((m) => /NICHT BESTÄTIGT|BEI ERHALT/.test(m)).length, 0,
                 'never announced as an order to be paid on site');

    const report = await worker.fetch(new Request('https://kairo1980.de/api/reports/orders',
      { headers: { Authorization: `Bearer ${SECRETS.REPORT_TOKEN}` } }), env, c);
    const [reported] = (await report.json()).orders;
    assert.deepEqual([reported.reference, reported.payMethod, reported.paymentCheck], [payment.reference, 'online', null]);
  });
}

test('approved and never seen again: nothing stored, however often it is handed over', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await created(env, c, PICKUP);
  env.DB._raw.prepare("UPDATE payments SET status = 'approved' WHERE id = ?").run(payment.id);
  for (let i = 0; i < 3; i++) {
    const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
    assert.equal(res.body.reason, 'payment_unsettled');
  }
  assert.equal(rows(env, 'orders').length, 0);
  assert.equal(alerts().length, 0);
});

/* --- a claim made while the money was not in --------------------------------- */

test('an order claimed under a failed payment that is captured after all is reconciled by a person, never answered as settled', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await created(env, c, PICKUP);
  env.DB._raw.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(payment.id);
  const claim = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
  assert.equal(claim.status, 200);
  assert.equal(rows(env, 'orders')[0].payment_check, 'unverified');
  const before = rows(env, 'orders')[0];

  env.DB._raw.prepare("UPDATE payments SET status = 'captured', captured_at = datetime('now') WHERE id = ?").run(payment.id);
  const again = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
  assert.deepEqual([again.status, again.body.reason], [409, 'payment_conflict']);
  const [order] = rows(env, 'orders');
  assert.deepEqual([rows(env, 'orders').length, order.payment_id, order.pay_method, order.total],
                   [1, null, 'onsite', before.total], 'the stored claim is not rewritten');
  assert.match(alerts().at(-1), /^ZAHLUNG PRÜFEN/);
});

test('an id that is no payment stays a flagged claim, distinct from real money', async (t) => {
  const { env, c, alerts } = world(t);
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: 'made-up-id' });
  assert.equal(res.status, 200);
  const [order] = rows(env, 'orders');
  assert.deepEqual([order.pay_method, order.payment_id, order.claimed_payment_id, order.payment_check],
                   ['onsite', null, 'made-up-id', 'unverified']);
  assert.match(alerts().at(-1), /NICHT BESTÄTIGT/);
});

/* --- a real payment and another order, in sequence and in a race ------------- */

test('the paid order and a different one racing under the same payment: one linked order, one conflict', async (t) => {
  for (let round = 0; round < 5; round++) {
    const { env, c } = world(t);
    const payment = await created(env, c, REILINGEN);
    await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-' + round);
    const results = await Promise.all([
      call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: payment.id }),
      call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, town: 'Reilingen', items: { feast: 2 }, paymentId: payment.id }),
      call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: payment.id })
    ]);
    assert.deepEqual(results.map((r) => r.status), [200, 409, 200], 'round ' + round);
    assert.equal(rows(env, 'orders').length, 1);
    assert.equal(rows(env, 'orders')[0].payment_id, payment.id);
  }
});

test('a payment refunded between the read and the write links nothing', async (t) => {
  const { env, c } = world(t);
  const payment = await created(env, c, PICKUP);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT INTO orders/.test(sql)) {
      env.DB._raw.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
    }
    return prepare(sql);
  };
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
  env.DB.prepare = prepare;
  assert.deepEqual([res.status, res.body.reason], [409, 'payment_conflict']);
  assert.equal(rows(env, 'orders').length, 0);
});

/* --- the snapshot itself ----------------------------------------------------- */

test('a payment whose own figures do not add up is not linked, and not priced again', async (t) => {
  const { env, c, alerts } = world(t);
  const breaks = [
    'UPDATE payments SET amount = amount + 1 WHERE id = ?',
    "UPDATE payments SET currency = 'USD' WHERE id = ?",
    "UPDATE payments SET lines = '[]' WHERE id = ?",
    "UPDATE payments SET lines = 'not json' WHERE id = ?",
    'UPDATE payments SET subtotal = subtotal + 100, amount = amount + 100 WHERE id = ?'
  ];
  for (const sql of breaks) {
    env.DB._raw.prepare('DELETE FROM payments').run();
    const payment = await created(env, c, PICKUP);
    env.DB._raw.prepare("UPDATE payments SET status = 'captured' WHERE id = ?").run(payment.id);
    env.DB._raw.prepare(sql).run(payment.id);
    const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
    assert.equal(res.body.reason, 'payment_conflict', sql);
  }
  assert.equal(rows(env, 'orders').length, 0);
  assert.equal(alerts().filter((m) => /^ZAHLUNG PRÜFEN/.test(m)).length, breaks.length);
});

/* --- what a stored row is matched on ----------------------------------------- */

test('a row with a town is never matched on its identity alone', async (t) => {
  const { env, c } = world(t);
  const oftersheim = { items: { koshari: 1 }, type: 'delivery', business: false, postcode: '68723', town: 'Oftersheim' };
  const payment = await created(env, c, oftersheim);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  await call(env, c, '/api/orders/announce', { ...GUEST, ...oftersheim, paymentId: payment.id });
  // As if the stored identity said Plankstadt while the row says Oftersheim.
  const plankstadt = { ...oftersheim, town: 'Plankstadt' };
  env.DB._raw.prepare('UPDATE orders SET order_identity = ?').run(orderIdentity(plankstadt));
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...plankstadt, paymentId: payment.id });
  assert.equal(res.body.reason, 'payment_conflict');
});

test('a fresh request is never cut down to match an old one', async (t) => {
  const { env, c } = world(t);
  const id = crypto.randomUUID();
  env.DB._raw.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status, amount, currency,
       subtotal, discount, fee, order_type, business, postcode, lines, created_at, updated_at)
     VALUES (?, 'K-OLD1', 'paypal', 'PP-K-OLD1', 'captured', 4770, 'EUR', 5300, 530, 0, 'delivery', 0,
             '68799 Reilingen', ?, datetime('now'), datetime('now'))`
  ).run(id, JSON.stringify([{ id: 'feast', dish: 'feast', name: 'Feast', qty: 1, unit: 5300, amount: 5300 }]));
  // The first sixteen characters are the old postcode; the rest names another place.
  const res = await call(env, c, '/api/orders/announce', {
    ...GUEST, items: { feast: 1 }, type: 'delivery', business: false,
    postcode: '68799 Reilingen 68766 Hockenheim', paymentId: id
  });
  assert.equal(res.body.reason, 'payment_conflict');
  assert.equal(rows(env, 'orders').length, 0);
});

test('two stored claims that a handover could both be: nothing stored, and the counter is told', async (t) => {
  const { env, c, alerts } = world(t);
  const first = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: 'made-up-id' });
  // A second row for the same claim, as two old handovers could have left.
  env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, order_type, business, pay_method, lines, subtotal, discount, fee,
       total, currency, claimed_payment_id, payment_check, created_at)
     SELECT 'dup', 'K-DUP1', order_type, business, pay_method, lines, subtotal, discount, fee, total, currency,
            claimed_payment_id, payment_check, created_at FROM orders WHERE reference = ?`).run(first.body.reference);
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: 'made-up-id' });
  assert.equal(res.body.reason, 'payment_conflict');
  assert.equal(rows(env, 'orders').length, 2);
  assert.match(alerts().at(-1), /^BESTELLUNG PRÜFEN/);
  await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: 'made-up-id' });
  assert.equal(alerts().filter((m) => /^BESTELLUNG PRÜFEN/.test(m)).length, 1, 'once');
});
