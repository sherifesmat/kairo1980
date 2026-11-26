/* An order names a payment only when the payment is real and is for this food.
   Loop WEBSITE_ORDERING (KBOSS), W01-05 / W02-03 / W02-04.

   /api/orders/announce used to believe any `paymentId` the browser sent: the
   order was stored as paid online and the restaurant was never told about it,
   whether or not that payment existed, had taken money, or was for this basket.
   Every case here uses a REAL payment row, created through the real route, so
   the linkage is proven against the database and not against a stub. */

import { test } from 'node:test';
import { scrubExpiredIdentities } from '../../worker/retention.js';
import assert from 'node:assert/strict';
import worker from '../helpers/page-worker.js';
import { workerEnv, fakePayPal, orderResponse } from '../helpers/env.js';

const MENU = {
  hummus: { price: 950, name: 'Hummus' },
  koshari: { price: 1450, name: 'Koshari' }
};
const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242' };
const SEND = '/botbot-token/sendMessage';

// Two Koshari, collected: 2900 less 10 % = 2610 cents.
const PAID = { items: { koshari: 2 }, type: 'pickup', business: false, method: 'paypal' };
const HANDOVER = {
  items: { koshari: 2 }, type: 'pickup', business: false,
  time: 'So schnell wie möglich', name: 'Test Gast', phone: '+49 176 1234567'
};

function ctx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settled: () => Promise.all(promises) };
}
const post = (path, body, headers = {}) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** A world with Telegram configured and PayPal answering order creation. */
function world(t) {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);
  return { env, c, alerts };
}

/** A real payment row for `basket`, then put into `status` the way the store would. */
async function paymentIn(env, c, status, basket = PAID) {
  const res = await worker.fetch(post('/api/payments', basket), env, c);
  assert.equal(res.status, 201, await res.clone().text());
  const payment = await res.json();
  env.DB._raw.prepare('UPDATE payments SET status = ?, captured_at = ? WHERE id = ?')
    .run(status, status === 'captured' ? new Date().toISOString() : null, payment.id);
  return payment;
}

async function announce(env, c, body, headers) {
  const res = await worker.fetch(post('/api/orders/announce', body, headers), env, c);
  await c.settled();
  return { status: res.status, body: await res.json() };
}

const orders = (env) => env.DB._raw.prepare('SELECT * FROM orders ORDER BY created_at').all();

test('a captured payment for exactly this basket links, keeps its code, and is not announced twice', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');

  const { status, body } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(status, 200);
  assert.equal(body.recorded, true);
  assert.equal(body.reference, payment.reference, 'the code on the payment is the code in the chat');

  const [row] = orders(env);
  assert.equal(row.pay_method, 'online');
  assert.equal(row.payment_id, payment.id);
  assert.equal(row.payment_check, null);
  assert.equal(row.total, 2610);
  assert.equal(alerts().length, 0, 'it was announced at capture, not again on handover');
});

test('a payment still under review links, and is announced as not yet paid', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'pending');

  const { body } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(body.reference, payment.reference);
  const [row] = orders(env);
  assert.equal(row.pay_method, 'online');
  assert.equal(row.payment_id, payment.id);
  assert.equal(alerts().length, 1, 'nothing else would tell the kitchen');
  assert.match(alerts()[0], /ONLINE-ZAHLUNG NOCH IN PRÜFUNG/);
  assert.doesNotMatch(alerts()[0], /ZAHLUNG BEI ERHALT/);
});

for (const status of ['created', 'approved', 'failed', 'cancelled', 'refunded']) {
  test(`a payment that is ${status} cannot pay for an order`, async (t) => {
    const { env, c, alerts } = world(t);
    const payment = await paymentIn(env, c, status);

    const { status: http, body } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
    assert.equal(http, 200);
    assert.equal(body.recorded, true, 'the order is real and is kept');
    assert.notEqual(body.reference, payment.reference, 'it is not given the payment\'s code');

    const [row] = orders(env);
    assert.equal(row.pay_method, 'onsite', 'never stored as paid online');
    assert.equal(row.payment_id, null);
    assert.equal(row.claimed_payment_id, payment.id, 'the claim is kept for a person to check');
    assert.equal(row.payment_check, 'unverified');
    assert.equal(alerts().length, 1, 'and the restaurant is always told');
    assert.match(alerts()[0], /ONLINE-ZAHLUNG NICHT BESTÄTIGT/);
  });
}

test('a payment id nobody ever created pays for nothing', async (t) => {
  const { env, c, alerts } = world(t);
  const { body } = await announce(env, c, { ...HANDOVER, paymentId: 'made-up-id' });
  assert.equal(body.recorded, true);
  const [row] = orders(env);
  assert.equal(row.pay_method, 'onsite');
  assert.equal(row.payment_id, null);
  assert.equal(row.payment_check, 'unverified');
  assert.equal(alerts().length, 1);
});

test('a captured payment for a different basket of the same price does not link', async (t) => {
  /* The dangerous case: the same money for different food. The payment's
     lines are rewritten to another dish at the same total, which is exactly
     what a check on the amount alone would let through. */
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  env.DB._raw.prepare('UPDATE payments SET lines = ? WHERE id = ?')
    .run(JSON.stringify([{ id: 'hummus', name: 'Hummus', qty: 3, unit: 967, amount: 2900 }]), payment.id);

  /* DELIVERY_PRICING DP-22-02 supersedes the flagged order here: a real payment
     handed over with an order it does not pay for stores no order at all. The
     payment keeps its reference, the counter is told to resolve it with the
     guest, and nobody is asked to pay on site. */
  const res = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(res.status, 409);
  assert.deepEqual([res.body.reason, res.body.reference], ['payment_conflict', payment.reference]);
  assert.equal(orders(env).length, 0);
  const said = alerts();
  assert.equal(said.length, 1);
  assert.match(said[0], /^ZAHLUNG PRÜFEN/);
  assert.match(said[0], new RegExp(payment.reference));
  assert.match(said[0], /Nicht noch einmal kassieren/);
  assert.equal(/Test Gast|\+49/.test(said[0]), false, 'no personal data in the message');
});

test('a captured pickup payment does not pay for a delivery', async (t) => {
  const { env, c } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  /* DELIVERY_PRICING DP-22-02 supersedes the flagged order here: a real payment
     handed over with an order it does not pay for stores no order at all. The
     payment keeps its reference, the counter is told to resolve it with the
     guest, and nobody is asked to pay on site. */
  const res = await announce(env, c, { ...HANDOVER, type: 'delivery', postcode: '68766', town: 'Hockenheim', paymentId: payment.id });
  assert.equal(res.body.reason, 'payment_conflict');
  assert.equal(orders(env).length, 0);
  const [stored] = env.DB._raw.prepare('SELECT status, reference FROM payments').all();
  assert.deepEqual([stored.status, stored.reference], ['captured', payment.reference], 'the payment is untouched');
});

test('handing the same paid order over twice stores it once and returns the same code', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');

  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const again = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.recorded, true);
  assert.equal(again.body.reference, first.body.reference);
  assert.equal(orders(env).length, 1, 'one payment, one order');
  assert.equal(alerts().length, 0);
});

test('a replay at the throttle limit is answered with the order, not a 202', async (t) => {
  const { env, c } = world(t);
  const from = { 'CF-Connecting-IP': '203.0.113.77' };
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);

  // Fill the window for this address with cash orders until it is throttled.
  let throttled = false;
  for (let i = 0; i < 12 && !throttled; i++) {
    throttled = (await announce(env, c, HANDOVER, from)).status === 202;
  }
  assert.ok(throttled, 'the address really is at the limit');

  const replay = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reference, first.body.reference);
});

test('two handovers of one payment racing each other still make one order', async (t) => {
  const { env, c } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  const [a, b] = await Promise.all([
    announce(env, c, { ...HANDOVER, paymentId: payment.id }),
    announce(env, c, { ...HANDOVER, paymentId: payment.id })
  ]);
  assert.equal(a.body.reference, payment.reference);
  assert.equal(b.body.reference, payment.reference);
  assert.equal(orders(env).filter((o) => o.payment_id === payment.id).length, 1);
});

test('the database itself refuses a second order for one payment', async (t) => {
  const { env, c } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.throws(() => env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, pay_method, lines,
       subtotal, total, created_at) VALUES ('x','R',?,'pickup','online','[]',0,0,'now')`
  ).run(payment.id), /UNIQUE/);
});

test('/admin flags a captured payment that does not match its order, and never as paid', async (t) => {
  const CREDS = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };
  const env = { ...workerEnv(MENU, { ...TELEGRAM, ...CREDS }) };
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const payment = await paymentIn(env, c, 'captured');
  // Money taken for a pickup; the handover says delivery — a mismatch. Since
  // DP-22-02 it stores no order; the payment is listed as money with no order.
  await announce(env, c, { ...HANDOVER, type: 'delivery', postcode: '68766', town: 'Hockenheim', name: 'Mismatch Gast', paymentId: payment.id });

  const login = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kairo1980.de' },
    body: new URLSearchParams({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD })
  }), env, c);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const html = await (await worker.fetch(new Request('https://kairo1980.de/admin/orders', { headers: { cookie } }), env, c)).text();

  assert.equal(html.includes('Mismatch Gast'), false, 'the mismatched handover was not stored');
  assert.ok(html.includes('Paid, but no order details'), 'the money is on the page, loudly');
  assert.ok(html.includes(payment.reference));
});

/* --- round 3 of the loop: a replay is a replay only when it is the same order ---
   Loop WEBSITE_ORDERING, R3-01 .. R3-04. On a3041508 each of these got through
   silently, because the payment id alone decided what an announce was. */

const DELIVERY_PAID = { items: { koshari: 2 }, type: 'delivery', postcode: '68766', town: 'Hockenheim', business: false, method: 'paypal' };
const DELIVERY_HANDOVER = { ...HANDOVER, type: 'delivery', postcode: '68766', town: 'Hockenheim', address: 'Hauptstraße 1' };

test('R3-01: a different basket under a paid order payment id is a new, flagged order, never swallowed', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id });

  const other = await announce(env, c, {
    ...HANDOVER, items: { koshari: 2, hummus: 1 }, name: 'Someone Else', paymentId: payment.id
  });
  assert.equal(other.status, 200);
  assert.equal(other.body.recorded, true);
  assert.notEqual(other.body.reference, first.body.reference, 'it does not inherit the paid order code');

  const rows = orders(env);
  assert.equal(rows.length, 2, 'both orders are in the books');
  const second = rows.find((r) => r.reference === other.body.reference);
  assert.equal(second.pay_method, 'onsite');
  assert.equal(second.payment_id, null);
  assert.equal(second.payment_check, 'unverified');
  assert.equal(second.claimed_payment_id, payment.id);
  assert.equal(alerts().length, 1, 'and the kitchen is told about the new one');
  assert.match(alerts()[0], /NICHT BESTÄTIGT/);
});

test('R3-01: the same payment id with a changed order type is a new order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const changed = await announce(env, c, { ...DELIVERY_HANDOVER, paymentId: payment.id });
  assert.equal(changed.body.recorded, true);
  assert.equal(orders(env).length, 2);
  assert.equal(alerts().length, 1);
});

test('R3-01: the same payment id with a changed delivery postcode is a new order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured', DELIVERY_PAID);
  const first = await announce(env, c, { ...DELIVERY_HANDOVER, paymentId: payment.id });
  assert.equal(first.body.reference, payment.reference, 'the paid delivery links');
  const moved = await announce(env, c, { ...DELIVERY_HANDOVER, postcode: '68799', town: 'Reilingen', paymentId: payment.id });
  assert.notEqual(moved.body.reference, payment.reference);
  assert.equal(orders(env).length, 2);
  assert.equal(alerts().length, 1);
});

test('R3-01: a true replay of a claim at the throttle limit is still the stored order', async (t) => {
  const { env, c } = world(t);
  const from = { 'CF-Connecting-IP': '203.0.113.78' };
  const payment = await paymentIn(env, c, 'created');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);
  let throttled = false;
  for (let i = 0; i < 12 && !throttled; i++) throttled = (await announce(env, c, HANDOVER, from)).status === 202;
  assert.ok(throttled);
  const replay = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reference, first.body.reference);
});

test('R3-02: a paid delivery does not pay for a delivery to another postcode with the same fee', async (t) => {
  /* 68766 Hockenheim and 68799 Reilingen have the same 1 € fee and the same
     15 € minimum, so every amount on the two quotes is identical. Only the
     address differs. */
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured', DELIVERY_PAID);
  /* DELIVERY_PRICING DP-22-02 supersedes the flagged order here: a real payment
     handed over with an order it does not pay for stores no order at all. The
     payment keeps its reference, the counter is told to resolve it with the
     guest, and nobody is asked to pay on site. */
  const paidQuote = await (await worker.fetch(post('/api/payments/quote', DELIVERY_PAID), env, c)).json();
  const other = await (await worker.fetch(post('/api/payments/quote', { ...DELIVERY_PAID, postcode: '68799', town: 'Reilingen' }), env, c)).json();
  assert.deepEqual([other.total, other.fee], [paidQuote.total, paidQuote.fee], 'the money is identical; only the destination differs');
  const res = await announce(env, c, { ...DELIVERY_HANDOVER, postcode: '68799', town: 'Reilingen', paymentId: payment.id });
  assert.equal(res.body.reason, 'payment_conflict');
  assert.equal(orders(env).length, 0, 'never linked as paid, never stored to be paid on site');
  assert.equal(alerts().length, 1);
});

test('R3-03: an unverified claim handed over twice is one order and one alert', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'created');
  const a = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const b = await announce(env, c, { ...HANDOVER, name: 'Test Gast (typo fixed)', paymentId: payment.id });
  assert.equal(b.body.reference, a.body.reference);
  assert.equal(orders(env).length, 1);
  assert.equal(alerts().length, 1);
});

test('R3-03: an unverified claim racing itself is still one order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'created');
  const [a, b] = await Promise.all([
    announce(env, c, { ...HANDOVER, paymentId: payment.id }),
    announce(env, c, { ...HANDOVER, paymentId: payment.id })
  ]);
  assert.equal(a.body.reference, b.body.reference);
  assert.equal(orders(env).length, 1);
  assert.equal(alerts().length, 1);
});

test('R3-03: a captured payment whose menu price drifted links at the price paid, however often it is handed over', async (t) => {
  /* DP-22-02 supersedes the flag: the payment's own lines are the agreed order,
     so a menu price changed since does not make the paid dinner another one. */
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  // As if the menu had changed after paying: the payment's own lines no longer
  // equal today's pricing of the same basket.
  env.DB._raw.prepare('UPDATE payments SET lines = ? WHERE id = ?')
    .run(JSON.stringify([{ id: 'koshari', name: 'Koshari', qty: 2, unit: 1400, amount: 2800 }]), payment.id);
  const a = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const b = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(a.body.reference, b.body.reference);
  assert.equal(a.body.reference, payment.reference);
  const rows = orders(env);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].payment_id, rows[0].pay_method, rows[0].payment_check],
                   [payment.id, 'online', null]);
  assert.deepEqual([rows[0].total, JSON.parse(rows[0].lines)[0].unit], [payment.amount, 1400], 'at the price paid');
  assert.equal(alerts().length, 0, 'a captured payment was announced when the money arrived');
});

test('R3-03: the same claimed id with a different basket is a second, distinct flagged order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'created');
  const a = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const b = await announce(env, c, { ...HANDOVER, items: { hummus: 1 }, paymentId: payment.id });
  assert.notEqual(a.body.reference, b.body.reference);
  assert.equal(orders(env).length, 2);
  assert.equal(alerts().length, 2);
});

test('R3-04: the books can tell an unverified claim from cash, in both reports', async (t) => {
  const REPORT = { REPORT_TOKEN: 'report-token-for-tests' };
  const env = workerEnv(MENU, { ...TELEGRAM, ...REPORT });
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  // A captured pickup payment that pays for its own order, then a different
  // basket handed over under the same payment id: a claim, not a payment.
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const mismatch = await announce(env, c, { ...HANDOVER, items: { hummus: 1 }, paymentId: payment.id });
  // And an ordinary cash order beside it.
  const cash = await announce(env, c, HANDOVER);

  const auth = { Authorization: `Bearer ${REPORT.REPORT_TOKEN}` };
  const report = await (await worker.fetch(new Request('https://kairo1980.de/api/reports/orders', { headers: auth }), env, c)).json();
  const byRef = Object.fromEntries(report.orders.map((o) => [o.reference, o]));

  const flagged = byRef[mismatch.body.reference];
  assert.equal(flagged.payMethod, 'onsite', 'the documented enum is unchanged');
  assert.equal(flagged.paymentCheck, 'unverified');
  assert.deepEqual(
    { id: flagged.claimedPayment.id, status: flagged.claimedPayment.status, amount: flagged.claimedPayment.amount },
    { id: payment.id, status: 'captured', amount: 2610 },
    'and says the named payment did take money'
  );
  assert.ok(flagged.claimedPayment.capturedAt);

  const ordinary = byRef[cash.body.reference];
  assert.equal(ordinary.paymentCheck, null);
  assert.equal(ordinary.claimedPayment, null);

  // The capture is in the settlement report too. The marker is what lets a
  // reader of both see one sale, not a cash sale plus a payment.
  const settled = await (await worker.fetch(new Request('https://kairo1980.de/api/reports/settlement', { headers: auth }), env, c)).json();
  assert.equal(settled.totals.gross, 2610);
});

/* --- round 4 of the loop: orders from before 0006, and corrections ---
   Loop WEBSITE_ORDERING, R4-01 / R4-02. Each of these got through silently on
   38c3b5d. */

/** As if this order had been stored before migration 0006: no identity. */
const forgetIdentity = (env) => env.DB._raw.prepare('UPDATE orders SET order_identity = NULL').run();

const REPORT_TOKEN = 'report-token-for-tests';
async function reported(env, c, reference) {
  const res = await worker.fetch(new Request('https://kairo1980.de/api/reports/orders',
    { headers: { Authorization: `Bearer ${REPORT_TOKEN}` } }), env, c);
  return (await res.json()).orders.find((o) => o.reference === reference);
}
function reportWorld(t) {
  const env = workerEnv(MENU, { ...TELEGRAM, REPORT_TOKEN });
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);
  return { env, c, alerts };
}

test('R4-01: a paid order stored before 0006, handed over again, is the same order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  forgetIdentity(env);

  const again = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.reference, first.body.reference);
  const rows = orders(env);
  assert.equal(rows.length, 1, 'no second, flagged order');
  assert.equal(rows[0].payment_check, null);
  assert.equal(rows[0].payment_id, payment.id);
  assert.ok(rows[0].order_identity, 'and its identity is written back');
  assert.equal(alerts().length, 0, 'a captured payment was already announced; nothing more');
});

test('R4-01: a different basket under an old order\'s payment id is still a new, flagged order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  forgetIdentity(env);

  const other = await announce(env, c, { ...HANDOVER, items: { koshari: 3 }, paymentId: payment.id });
  assert.notEqual(other.body.reference, first.body.reference);
  assert.equal(orders(env).length, 2);
  assert.equal(orders(env).find((r) => r.reference === other.body.reference).payment_check, 'unverified');
  assert.equal(alerts().length, 1);
});

test('R4-01: an old delivery handed over to another postcode is a new order', async (t) => {
  const { env, c } = world(t);
  const payment = await paymentIn(env, c, 'captured', DELIVERY_PAID);
  await announce(env, c, { ...DELIVERY_HANDOVER, paymentId: payment.id });
  forgetIdentity(env);
  const moved = await announce(env, c, { ...DELIVERY_HANDOVER, postcode: '68799', town: 'Reilingen', paymentId: payment.id });
  assert.notEqual(moved.body.reference, payment.reference);
  assert.equal(orders(env).length, 2);
});

test('R4-01: an old order is found again at the throttle limit, and under a race', async (t) => {
  const { env, c, alerts } = world(t);
  const from = { 'CF-Connecting-IP': '203.0.113.79' };
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);
  forgetIdentity(env);
  let throttled = false;
  for (let i = 0; i < 12 && !throttled; i++) throttled = (await announce(env, c, HANDOVER, from)).status === 202;
  assert.ok(throttled);
  const atLimit = await announce(env, c, { ...HANDOVER, paymentId: payment.id }, from);
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.body.reference, first.body.reference);

  forgetIdentity(env);
  const [a, b] = await Promise.all([
    announce(env, c, { ...HANDOVER, paymentId: payment.id }),
    announce(env, c, { ...HANDOVER, paymentId: payment.id })
  ]);
  assert.equal(a.body.reference, first.body.reference);
  assert.equal(b.body.reference, first.body.reference);
  assert.equal(orders(env).filter((r) => r.payment_id === payment.id).length, 1);
  assert.equal(orders(env).filter((r) => r.claimed_payment_id === payment.id).length, 0);
  const cash = orders(env).filter((r) => !r.payment_id && !r.claimed_payment_id).length;
  assert.equal(alerts().length, cash, 'only the cash orders that filled the throttle were announced');
});

test('R4-02: an unchanged replay changes nothing and tells nobody', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'pending');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const before = orders(env)[0];
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  const after = orders(env)[0];
  assert.equal(after.amended_at, null);
  assert.equal(after.amendments, null);
  assert.equal(after.requested_time, before.requested_time);
  assert.equal(alerts().length, 1, 'the pending payment was announced once');
});

test('R4-02: a changed pickup time is a correction the kitchen hears, and the books keep', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  const moved = await announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id });

  assert.equal(moved.status, 200);
  assert.equal(moved.body.reference, first.body.reference, 'one payment, one order');
  const rows = orders(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requested_time, 'Do, 26.11. 19:30');
  assert.equal(rows[0].amendments, 1);
  assert.ok(rows[0].amended_at);
  assert.equal((await reported(env, c, first.body.reference)).requestedTime, 'Do, 26.11. 19:30');

  assert.equal(alerts().length, 1, 'captured: no new-order alert, one correction');
  assert.match(alerts()[0], new RegExp(`KORREKTUR ZU BESTELLUNG ${first.body.reference}`));
  assert.match(alerts()[0], /Geändert: Termin/);
  assert.match(alerts()[0], /Neuer Termin: Do, 26\.11\. 19:30/);
});

test('R4-02: a changed street in the same postcode reaches the driver, without the address in the chat', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured', DELIVERY_PAID);
  const first = await announce(env, c, { ...DELIVERY_HANDOVER, paymentId: payment.id });
  assert.equal(first.body.reference, payment.reference);
  await announce(env, c, { ...DELIVERY_HANDOVER, address: 'Karlsruher Straße 7', paymentId: payment.id });

  const rows = orders(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer_address, 'Karlsruher Straße 7');
  assert.equal(rows[0].payment_id, payment.id, 'still the paid order');
  const report = await reported(env, c, payment.reference);
  assert.equal(report.customer.address, 'Karlsruher Straße 7');

  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /Geändert: Adresse/);
  assert.doesNotMatch(alerts()[0], /Karlsruher|Hauptstraße/, 'no address in a third-country chat');
});

test('R4-02: the same correction racing itself is applied and announced once', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  await Promise.all([
    announce(env, c, { ...HANDOVER, notes: 'ohne Zwiebeln', paymentId: payment.id }),
    announce(env, c, { ...HANDOVER, notes: 'ohne Zwiebeln', paymentId: payment.id })
  ]);
  assert.equal(orders(env)[0].notes, 'ohne Zwiebeln');
  assert.equal(orders(env)[0].amendments, 1);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /Geändert: Anmerkung/);
});

test('R4-02: a fixed typo in the name is kept quietly', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  await announce(env, c, { ...HANDOVER, name: 'Test Gast-Müller', paymentId: payment.id });
  assert.equal(orders(env).length, 1);
  assert.equal(orders(env)[0].amendments, null);
  assert.equal(alerts().length, 0);
});

/* --- round 5 of the loop: racing corrections, deleted details, the right day ---
   Loop WEBSITE_ORDERING, R5-01 .. R5-03. Each of these got through silently on
   17c0bcc. */

test('R5-01: two different corrections racing each other are both written and both told', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  const [a, b] = await Promise.all([
    announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id }),
    announce(env, c, { ...HANDOVER, time: 'Fr, 27.11. 12:00', paymentId: payment.id })
  ]);
  for (const r of [a, b]) {
    assert.equal(r.status, 200, 'neither is answered as recorded without being written');
    assert.equal(r.body.reference, first.body.reference);
  }
  const [row] = orders(env);
  assert.equal(orders(env).length, 1);
  assert.equal(row.amendments, 2, 'both corrections were written, one after the other');
  const corrections = alerts().filter((m) => /^KORREKTUR/.test(m));
  assert.equal(corrections.length, 2, 'and the kitchen heard both');
  // The stored time is the last one written, and the kitchen's last message says so.
  assert.ok(corrections[1].includes(`Neuer Termin: ${row.requested_time}`));
});

test('R5-01: a correction that keeps losing is answered as a conflict, and the kitchen is told to check', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  // Every guarded update now finds the row changed under it, as if another
  // correction always landed first.
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/^\s*UPDATE orders SET requested_time/.test(sql)) return stmt;
    return { bind: (...args) => ({ run: async () => {
      env.DB._raw.prepare(`UPDATE orders SET requested_time = 'someone else ' || abs(random()) WHERE id = ?`).run(args[0]);
      return { success: true, meta: { changes: 0 } };
    } }) };
  };

  const lost = await announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id });
  assert.equal(lost.status, 409);
  assert.deepEqual(lost.body, { recorded: false, reason: 'conflict', reference: first.body.reference });
  assert.notEqual(orders(env)[0].requested_time, 'Do, 26.11. 19:30', 'nothing claimed that was not written');
  const last = alerts().at(-1);
  assert.match(last, /KORREKTUR ZU BESTELLUNG .* NICHT GESPEICHERT, BITTE WHATSAPP PRÜFEN/);
});

test('R5-02: a replay never brings back details the retention sweep deleted', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  // Past the three-year retention of an order's details (worker/retention.js), and swept.
  env.DB._raw.prepare(`UPDATE orders SET created_at = datetime('now', '-4 years')`).run();
  const swept = await scrubExpiredIdentities(env);
  assert.equal(swept.orders, 1);

  const again = await announce(env, c, {
    ...HANDOVER, phone: '+49 170 9999999', address: 'Neue Straße 1', notes: 'bitte klingeln', paymentId: payment.id
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.reference, first.body.reference);
  const [row] = orders(env);
  assert.deepEqual(
    { phone: row.customer_phone, address: row.customer_address, notes: row.notes, amendments: row.amendments },
    { phone: null, address: null, notes: null, amendments: null },
    'nothing written back'
  );
  assert.equal(alerts().length, 0);

  // And a later sweep has nothing it would have to find.
  assert.equal((await scrubExpiredIdentities(env)).orders, 0);
  const report = await reported(env, c, first.body.reference);
  assert.equal(report.customer, null);
});

test('R5-03: a correction to yesterday\'s order links to yesterday\'s page, at that order', async (t) => {
  const CREDS = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };
  const env = workerEnv(MENU, { ...TELEGRAM, ...CREDS, REPORT_TOKEN });
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);

  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  // Placed yesterday evening, Berlin time: 20:30 Berlin is 19:30 UTC in winter.
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  env.DB._raw.prepare(`UPDATE orders SET created_at = ?`).run(`${yesterday} 19:30:00`);

  await announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id });
  const message = alerts().at(-1);
  const link = `kairo1980.de/admin/orders?day=${yesterday}#o-${first.body.reference}`;
  assert.ok(message.includes(link), message);

  const login = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kairo1980.de' },
    body: new URLSearchParams({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD })
  }), env, c);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const page = await (await worker.fetch(new Request(`https://${link.split('#')[0]}`, { headers: { cookie } }), env, c)).text();
  assert.ok(page.includes(`id="o-${first.body.reference}"`), 'the card the link points at is on that page');
  assert.ok(page.includes('Do, 26.11. 19:30'), 'showing the corrected time');

  const today = await (await worker.fetch(new Request('https://kairo1980.de/admin/orders', { headers: { cookie } }), env, c)).text();
  assert.ok(!today.includes(`id="o-${first.body.reference}"`), 'the plain link would not have found it');
});

/* --- round 6 of the loop: the edges of a correction ---
   Loop WEBSITE_ORDERING, R6-01 .. R6-03. Each of these got through on 3e3ca1a. */

/** Run `before` just ahead of every correction's guarded update, then the
 *  update itself, exactly as the Worker wrote it. */
function aheadOfEachCorrection(env, before) {
  const prepare = env.DB.prepare.bind(env.DB);
  let n = 0;
  env.DB.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/^\s*UPDATE orders SET (requested_time|customer_address|customer_phone|notes) = \?2/.test(sql)) return stmt;
    return { bind: (...args) => ({ run: async () => { await before(++n, args); return stmt.bind(...args).run(); } }) };
  };
}

test('R6-01: a retention sweep landing between the read and the write is not undone', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  const first = await announce(env, c, { ...HANDOVER, phone: null, paymentId: payment.id });
  // Old enough to be swept, but not swept yet when the correction reads it.
  env.DB._raw.prepare(`UPDATE orders SET created_at = datetime('now', '-4 years')`).run();
  aheadOfEachCorrection(env, () => scrubExpiredIdentities(env));

  const again = await announce(env, c, { ...HANDOVER, phone: '+49 170 9999999', paymentId: payment.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.reference, first.body.reference);
  const [row] = orders(env);
  assert.ok(row.details_purged_at, 'the sweep ran');
  assert.equal(row.customer_phone, null, 'and the phone was not written back into the swept row');
  assert.equal(row.amendments, null);
  assert.equal(alerts().length, 0);
});

test('R6-02: a competitor that wrote exactly what was asked, just before the last try, is not a conflict', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  aheadOfEachCorrection(env, (n, args) => {
    // Tries 1 and 2: someone else moves it elsewhere. Try 3: someone else
    // writes exactly what this guest asked for.
    const time = n < 3 ? `elsewhere ${n}` : 'Do, 26.11. 19:30';
    env.DB._raw.prepare('UPDATE orders SET requested_time = ? WHERE id = ?').run(time, args[0]);
  });

  const res = await announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id });
  assert.equal(res.status, 200, 'what was asked is what is stored');
  assert.equal(res.body.recorded, true);
  assert.equal(orders(env)[0].requested_time, 'Do, 26.11. 19:30');
  assert.ok(!alerts().some((m) => /NICHT GESPEICHERT/.test(m)), 'and nobody is told it was not saved');
});

test('R6-03: a correction that was not saved never calls the stored time new', async (t) => {
  const { env, c, alerts } = reportWorld(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, time: 'Mi, 25.11. 18:00', paymentId: payment.id });
  aheadOfEachCorrection(env, (n, args) => {
    env.DB._raw.prepare('UPDATE orders SET requested_time = ? WHERE id = ?').run(`competing ${n}`, args[0]);
  });

  const res = await announce(env, c, { ...HANDOVER, time: 'Do, 26.11. 19:30', paymentId: payment.id });
  assert.equal(res.status, 409);
  const message = alerts().at(-1);
  assert.match(message, /NICHT GESPEICHERT, BITTE WHATSAPP PRÜFEN/);
  assert.doesNotMatch(message, /Neuer Termin/);
  assert.match(message, new RegExp(`Aktuell gespeichert: ${orders(env)[0].requested_time}`));
});
