/* An order names a payment only when the payment is real and is for this food.
   Loop WEBSITE_ORDERING (KBOSS), W01-05 / W02-03 / W02-04.

   /api/orders/announce used to believe any `paymentId` the browser sent: the
   order was stored as paid online and the restaurant was never told about it,
   whether or not that payment existed, had taken money, or was for this basket.
   Every case here uses a REAL payment row, created through the real route, so
   the linkage is proven against the database and not against a stub. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
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

  const { body } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.notEqual(body.reference, payment.reference);
  const [row] = orders(env);
  assert.equal(row.payment_check, 'unverified');
  assert.equal(row.pay_method, 'onsite');
  assert.equal(alerts().length, 1);
});

test('a captured pickup payment does not pay for a delivery', async (t) => {
  const { env, c } = world(t);
  const payment = await paymentIn(env, c, 'captured');
  await announce(env, c, { ...HANDOVER, type: 'delivery', postcode: '68766', paymentId: payment.id });
  const [row] = orders(env);
  assert.equal(row.payment_check, 'unverified');
  assert.equal(row.payment_id, null);
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
  // Money taken for a pickup; the handover says delivery — a mismatch.
  await announce(env, c, { ...HANDOVER, type: 'delivery', postcode: '68766', name: 'Mismatch Gast', paymentId: payment.id });

  const login = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kairo1980.de' },
    body: new URLSearchParams({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD })
  }), env, c);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const html = await (await worker.fetch(new Request('https://kairo1980.de/admin/orders', { headers: { cookie } }), env, c)).text();

  assert.ok(html.includes('Mismatch Gast'));
  assert.ok(html.includes('PAYMENT NOT VERIFIED — CHECK'));
  assert.ok(html.includes('Online-Zahlung nicht bestätigt — bitte prüfen'));
  assert.equal(/class="tag paid">\s*PAID ONLINE/.test(html), false, 'nowhere on the page is it called paid');
  assert.equal(html.includes('Started, never finished'), false, 'its payment is accounted for by the claim');
});
