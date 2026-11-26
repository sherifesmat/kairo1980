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
  env.DB._raw.prepare("UPDATE payments SET status = 'failed', failure_code = 'DECLINED' WHERE id = ?").run(payment.id);
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

/* --- Round 24 (DP-24-01, DP-24-02) ------------------------------------------ */

/** Run `change` at the moment the order INSERT is prepared: the state moved
    between the read and the write. */
function atInsert(env, change) {
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT INTO orders/.test(sql)) change();
    return prepare(sql);
  };
  return () => { env.DB.prepare = prepare; };
}

for (const [to, reason] of [['captured', 'payment_conflict'], ['pending', 'payment_conflict'], ['approved', 'payment_unsettled']]) {
  test(`a failed payment that turns ${to} between the read and the claim's write stores no order to be paid on site`, async (t) => {
    const { env, c, alerts } = world(t);
    const payment = await created(env, c, PICKUP);
    env.DB._raw.prepare("UPDATE payments SET status = 'failed', failure_code = 'DECLINED' WHERE id = ?").run(payment.id);
    const undo = atInsert(env, () => env.DB._raw.prepare('UPDATE payments SET status = ? WHERE id = ?').run(to, payment.id));
    const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
    undo();
    assert.deepEqual([res.status, res.body.reason, res.body.reference], [409, reason, payment.reference]);
    assert.equal(rows(env, 'orders').length, 0, 'no onsite row beside the money');
    assert.equal(alerts().filter((m) => /NICHT BESTÄTIGT|BEI ERHALT/.test(m)).length, 0);
  });
}

test('a capture that lands between the read and the write is not announced as still under review', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await created(env, c, PICKUP);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.PENDING', 'WH-P');
  const undo = atInsert(env, () => env.DB._raw.prepare(
    "UPDATE payments SET status = 'captured', captured_at = datetime('now') WHERE id = ?").run(payment.id));
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
  undo();
  assert.equal(res.body.reference, payment.reference);
  assert.equal(rows(env, 'orders')[0].payment_id, payment.id);
  assert.equal(alerts().filter((m) => /NOCH IN PRÜFUNG/.test(m)).length, 0);
});

test('a lost answer retried from an empty or different form keeps what the kitchen has; a real correction still lands', async (t) => {
  const { env, c } = world(t);
  const payment = await created(env, c, REILINGEN);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  const first = { ...GUEST, ...REILINGEN, notes: 'Klingel defekt, bitte anrufen', paymentId: payment.id };
  const stored = await call(env, c, '/api/orders/announce', first);
  assert.equal(stored.status, 200);
  const original = rows(env, 'orders')[0];
  const keep = (row) => [row.customer_name, row.customer_phone, row.customer_address, row.notes, row.requested_time];

  // The answer never arrived; the page reloads with nothing, or with a new basket's form.
  const basket = { ...REILINGEN, paymentId: payment.id };
  const retries = [
    { ...basket, recovery: true },
    { ...basket, recovery: true, name: 'Jemand Anders', phone: '+49 1', address: 'Andere Straße 9', notes: '', time: '20:00' },
    { ...basket, name: '', phone: '', address: '', notes: '' }
  ];
  for (const retry of retries) {
    const res = await call(env, c, '/api/orders/announce', retry);
    assert.deepEqual([res.status, res.body.reference], [200, payment.reference], JSON.stringify(retry));
    assert.deepEqual(keep(rows(env, 'orders')[0]), keep(original), JSON.stringify(retry));
  }
  assert.equal(rows(env, 'orders').length, 1);

  const fixed = await call(env, c, '/api/orders/announce', { ...first, address: 'Hauptstraße 11' });
  assert.equal(fixed.status, 200);
  const [now] = rows(env, 'orders');
  assert.deepEqual([now.customer_address, now.notes, now.customer_phone],
                   ['Hauptstraße 11', original.notes, original.customer_phone]);
});

for (const [order, name] of [[REILINGEN, 'delivery'], [PICKUP, 'pickup']]) {
  test(`${name}: a quiet recovery with nothing stored creates nothing and asks for the guest's details`, async (t) => {
    const { env, c, alerts } = world(t);
    const payment = await created(env, c, order);
    await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
    const quiet = await call(env, c, '/api/orders/announce', { ...order, recovery: true, paymentId: payment.id });
    assert.deepEqual([quiet.status, quiet.body.reason, quiet.body.reference], [409, 'details_needed', payment.reference]);
    assert.equal(rows(env, 'orders').length, 0, 'no order with no name, phone or address');
    const before = alerts().length;

    const confirmed = await call(env, c, '/api/orders/announce', { ...GUEST, ...order, paymentId: payment.id });
    assert.deepEqual([confirmed.status, confirmed.body.reference], [200, payment.reference]);
    const [row] = rows(env, 'orders');
    assert.deepEqual([row.customer_name, row.customer_phone, row.payment_id], [GUEST.name, GUEST.phone, payment.id]);
    assert.equal(alerts().length, before, 'a captured payment was announced by its capture, not again');
  });
}

test('a quiet recovery under a claim that is not money creates no order either', async (t) => {
  const { env, c } = world(t);
  const res = await call(env, c, '/api/orders/announce', { ...PICKUP, recovery: true, paymentId: 'made-up-id' });
  assert.deepEqual([res.status, res.body.reason], [409, 'details_needed']);
  assert.equal(rows(env, 'orders').length, 0);
});

test('an old town-less linked order is replayed only by its exact old postcode, never by a longer one cut down', async (t) => {
  const { env, c } = world(t);
  const id = crypto.randomUUID();
  const lines = JSON.stringify([{ id: 'feast', dish: 'feast', name: 'Feast', qty: 1, unit: 5300, amount: 5300 }]);
  env.DB._raw.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status, amount, currency,
       subtotal, discount, fee, order_type, business, postcode, lines, created_at, updated_at)
     VALUES (?, 'K-LEG1', 'paypal', 'PP-K-LEG1', 'captured', 5300, 'EUR', 5300, 0, 0, 'delivery', 0,
             '68799 Reilingen', ?, datetime('now'), datetime('now'))`).run(id, lines);
  const old = { items: { feast: 1 }, type: 'delivery', business: false, postcode: '68799 Reilingen' };
  const longer = { ...old, postcode: '68799 Reilingen 68766 Hockenheim' };
  env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, order_type, business, pay_method, lines, subtotal, discount, fee,
       total, currency, payment_id, postcode, town, order_identity, created_at)
     VALUES ('legacy', 'K-LEG1', 'delivery', 0, 'online', ?, 5300, 0, 0, 5300, 'EUR', ?, '68799 Reilingen', NULL, ?, datetime('now'))`
  ).run(lines, id, orderIdentity(longer));

  const cut = await call(env, c, '/api/orders/announce', { ...GUEST, ...longer, paymentId: id });
  assert.equal(cut.body.reason, 'payment_conflict');

  env.DB._raw.prepare('UPDATE orders SET order_identity = ?').run(orderIdentity(old));
  const exact = await call(env, c, '/api/orders/announce', { ...GUEST, ...old, paymentId: id });
  assert.deepEqual([exact.status, exact.body.reference], [200, 'K-LEG1']);
  assert.equal(rows(env, 'orders').length, 1);
});

test('the snapshot invariants: no discount above the food, no blank or repeated line', async (t) => {
  const { env, c } = world(t);
  const breaks = [
    // Adds up, with the fee paying for a discount larger than the food.
    (p) => ['UPDATE payments SET discount = ?, fee = ? WHERE id = ?', p.subtotal + 100, p.amount + 100, p.id],
    // A line with no dish, handed over as a basket of no dish.
    (p) => ['UPDATE payments SET lines = ? WHERE id = ?',
            JSON.stringify(JSON.parse(p.lines).map((l) => ({ ...l, id: '' }))), p.id],
    (p) => {
      const [line] = JSON.parse(p.lines);
      const half = { ...line, qty: 1, amount: p.subtotal / 2 };
      return ['UPDATE payments SET lines = ? WHERE id = ?', JSON.stringify([half, half]), p.id];
    }
  ];
  for (const breakIt of breaks) {
    env.DB._raw.prepare('DELETE FROM payments').run();
    const payment = await created(env, c, PICKUP);
    env.DB._raw.prepare("UPDATE payments SET status = 'captured' WHERE id = ?").run(payment.id);
    const row = env.DB._raw.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
    const [sql, ...args] = breakIt(row);
    env.DB._raw.prepare(sql).run(...args);
    const lines = JSON.parse(env.DB._raw.prepare('SELECT lines FROM payments WHERE id = ?').get(payment.id).lines);
    const items = {};
    for (const l of lines) items[l.id] = (items[l.id] || 0) + l.qty;
    // The handover is exactly the basket the snapshot names, so only the snapshot can refuse it.
    const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, items, paymentId: payment.id });
    assert.equal(res.body.reason, 'payment_conflict', sql + ' ' + JSON.stringify(args));
  }
  assert.equal(rows(env, 'orders').length, 0);
});

test('a conflict stays on /admin, and an alert Telegram refused is sent again, once', async (t) => {
  const CREDS = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };
  const env = workerEnv(MENU, { ...SECRETS, ...CREDS });
  const c = ctx();
  let telegramUp = false;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }),
    [SEND]: () => (telegramUp ? { ok: true } : { status: 500, body: { ok: false, description: 'down' } })
  });
  t.after(() => paypal.restore());
  const sends = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body.text);
  const payment = await created(env, c, PICKUP);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  const other = { ...GUEST, ...PICKUP, items: { koshari: 3 }, paymentId: payment.id };

  const login = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kairo1980.de' },
    body: new URLSearchParams({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD })
  }), env, c);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const admin = async () => (await worker.fetch(new Request('https://kairo1980.de/admin/orders', { headers: { cookie } }), env, c)).text();

  await call(env, c, '/api/orders/announce', other);
  assert.equal(sends().filter((m) => /^ZAHLUNG PRÜFEN/.test(m)).length, 1, 'tried');
  let html = await admin();
  assert.ok(html.includes('an order did not match its payment'));
  assert.ok(html.includes(payment.reference));
  assert.ok(html.includes('Telegram alert NOT delivered'));

  telegramUp = true;
  await call(env, c, '/api/orders/announce', other);
  await call(env, c, '/api/orders/announce', other);
  assert.equal(sends().filter((m) => /^ZAHLUNG PRÜFEN/.test(m)).length, 2, 'retried once, then never again');
  html = await admin();
  assert.ok(html.includes('Telegram alert sent'));
  assert.ok(!html.includes('Telegram alert NOT delivered'));
  assert.ok(html.includes('an order did not match its payment'), 'still listed after the alert');
});

test('the conflict alert names the payment as it is now, not as it was read', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await created(env, c, PICKUP);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  const undo = atInsert(env, () => env.DB._raw.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id));
  await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, paymentId: payment.id });
  undo();
  assert.match(alerts().at(-1), /\(erstattet\)/);
  assert.doesNotMatch(alerts().at(-1), /\(bezahlt\)/);
});

test('a refund landing after a mismatch was decided is named in the alert as a refund', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await created(env, c, PICKUP);
  await webhook(env, c, payment, 'PAYMENT.CAPTURE.COMPLETED', 'WH-C');
  // The mismatch is decided on the payment as read; the refund lands just after.
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT OR IGNORE INTO payment_events/.test(sql) || /SELECT id, reference, provider, status, amount, currency FROM payments/.test(sql)) {
      env.DB._raw.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
    }
    return prepare(sql);
  };
  await call(env, c, '/api/orders/announce', { ...GUEST, ...PICKUP, items: { koshari: 3 }, paymentId: payment.id });
  env.DB.prepare = prepare;
  assert.match(alerts().at(-1), /\(erstattet\)/);
});

test('the create answer carries the priced lines; the public status still carries no basket', async (t) => {
  const { env, c } = world(t);
  const payment = await created(env, c, { ...PICKUP, items: { koshari: 2, feast: 1 } });
  assert.deepEqual(payment.lines.map((l) => [l.id, l.qty, l.amount]).sort(), [['feast', 1, 5300], ['koshari', 2, 2900]]);
  assert.equal(payment.lines.reduce((s, l) => s + l.amount, 0), payment.breakdown.subtotal);
  const res = await worker.fetch(new Request('https://kairo1980.de/api/payments/' + payment.id), env, ctx());
  const text = await res.text();
  assert.equal(res.status, 200);
  for (const leak of ['Koshari', 'Feast', 'koshari', 'lines', 'subtotal']) assert.ok(!text.includes(leak), leak);
});
