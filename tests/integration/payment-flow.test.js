/* The whole Worker, end to end: real routes, real SQL, real state machine,
   with PayPal replaced so the awkward cases can actually be produced —
   a decline, a replayed webhook, a callback that never arrives.

   Each test is a thing that can happen to a guest on a Friday night. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
import {
  workerEnv, fakePayPal, orderResponse, webhookEvent, webhookHeaders
} from '../helpers/env.js';

const MENU = {
  hummus: { price: 950, name: 'Hummus' },
  koshari: { price: 1450, name: 'Koshari' }
};

// Two Koshari, collected: 29.00 less the 10 % direct discount = 26.10.
const BASKET = { items: { koshari: 2 }, type: 'pickup', business: false, method: 'paypal' };
const BASKET_TOTAL = 2610;

function ctx() {
  const promises = [];
  return {
    waitUntil: (p) => promises.push(p),
    settled: () => Promise.all(promises)
  };
}

function post(path, body, headers = {}) {
  return new Request('https://kairo1980.de' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

const get = (path, headers = {}) =>
  new Request('https://kairo1980.de' + path, { headers });

/** Create a payment through the real route and return the JSON. */
async function createPayment(env, c, body = BASKET, orderId = 'PP-ORDER-1') {
  const res = await worker.fetch(post('/api/payments', body), env, c);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}

const captureOk = (paymentId, reference, amount = BASKET_TOTAL, orderId = 'PP-ORDER-1') =>
  orderResponse({
    id: orderId, status: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'COMPLETED',
    amount, paymentId, reference
  });

test('a guest pays and the order is recorded as paid for the exact amount', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let created = null;

  const paypal = fakePayPal({
    '/v2/checkout/orders': ({ body }) => {
      created = body;
      return orderResponse({ id: 'PP-ORDER-1' });
    },
    '/v2/checkout/orders/PP-ORDER-1/capture': () =>
      captureOk(payment.id, payment.reference)
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c);

  // The server priced it, and that is what PayPal was told.
  assert.equal(payment.amount, BASKET_TOTAL);
  assert.equal(created.purchase_units[0].amount.value, '26.10');
  assert.equal(created.purchase_units[0].amount.breakdown.item_total.value, '29.00');
  assert.equal(created.purchase_units[0].amount.breakdown.discount.value, '2.90');
  assert.equal(created.intent, 'CAPTURE');
  // Our identifiers travel with it, so any later event finds its way home.
  assert.equal(created.purchase_units[0].custom_id, payment.id);
  assert.equal(created.purchase_units[0].invoice_id, payment.reference);

  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.payment.status, 'captured');
  assert.equal(body.payment.amount, BASKET_TOTAL);
});

test('the amount is never taken from the browser', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let created = null;
  const paypal = fakePayPal({
    '/v2/checkout/orders': ({ body }) => { created = body; return orderResponse({}); }
  });
  t.after(() => paypal.restore());

  // A tampered client claims the order costs one cent.
  const payment = await createPayment(env, c, {
    ...BASKET, amount: 1, total: 1, subtotal: 1, discount: 9999
  });

  assert.equal(payment.amount, BASKET_TOTAL);
  assert.equal(created.purchase_units[0].amount.value, '26.10');
});

test('a price that is not on the menu cannot be invented', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(post('/api/payments', { items: { caviar: 1 }, type: 'pickup', method: 'paypal' }), env, ctx());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'unknown_item');
  // PayPal was never contacted for an order that could not be priced.
  assert.equal(paypal.calls.filter((call) => call.path.includes('/checkout/orders')).length, 0);
});

test('double-clicking pay captures once and charges once', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let captures = 0;
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => {
      captures++;
      return captureOk(payment.id, payment.reference);
    }
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);

  const [a, b] = await Promise.all([
    worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c),
    worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c)
  ]);

  const bodies = [await a.json(), await b.json()];
  assert.ok(bodies.every((x) => x.payment.status === 'captured'));

  // Whatever the race did, the payment is captured exactly once in our books.
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'captured');
  const events = await env.DB.prepare(
    "SELECT * FROM payment_events WHERE payment_id = ?1 AND status_to = 'captured'"
  ).bind(payment.id).all();
  assert.equal(events.results.length, 1, 'exactly one capture may be recorded');
});

test('a capture replayed after PayPal already took the money is not a failure', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => ({
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }
    }),
    '/v2/checkout/orders/PP-ORDER-1': () => captureOk(payment.id, payment.reference)
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.payment.status, 'captured', 'the guest paid; say so');
});

test('a declined card fails cleanly and says nothing was charged', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => ({
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] }
    })
  });
  t.after(() => paypal.restore());

  const payment = await createPayment(env, c);
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  const body = await res.json();

  assert.equal(res.status, 402);
  assert.equal(body.payment.status, 'failed');
  assert.equal(body.error, 'declined');

  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.failure_code, 'INSTRUMENT_DECLINED');
});

test('a capture PayPal is holding for review is not reported as paid', async (t) => {
  // This happened with real money. A PayPal ORDER reads COMPLETED as soon as
  // the capture call succeeds, even when the capture inside it is PENDING with
  // reason PENDING_REVIEW and PayPal is still holding the funds. Believing the
  // order told the kitchen "PAID ONLINE" for money that had not arrived.
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => {
      const order = orderResponse({
        id: 'PP-ORDER-1', status: 'COMPLETED', captureId: 'CAP-1',
        captureStatus: 'PENDING', amount: BASKET_TOTAL,
        paymentId: payment.id, reference: payment.reference
      });
      order.purchase_units[0].payments.captures[0].status_details = { reason: 'PENDING_REVIEW' };
      return order;
    }
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  const body = await res.json();

  assert.equal(body.payment.status, 'pending', 'the order says COMPLETED; the capture does not');
  assert.notEqual(body.payment.status, 'captured');

  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'pending');
  assert.equal(row.captured_at, null, 'nothing was captured, so nothing is stamped');
  assert.equal(row.failure_code, 'PENDING_REVIEW', 'why it is held is worth keeping');

  // And it must not appear in the money actually taken.
  const settled = await env.DB.prepare('SELECT * FROM payments_settled').all();
  assert.equal(settled.results.length, 0, 'a held payment is not revenue');
});

test('a review that clears later settles the payment', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' })
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  await store_settle_pending(env, payment.id);

  const event = webhookEvent({
    id: 'WH-CLEARED', paymentId: payment.id, reference: payment.reference,
    amount: BASKET_TOTAL, orderId: 'PP-ORDER-1'
  });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'captured', 'PayPal released it; the books follow');
});

async function store_settle_pending(env, id) {
  const store = await import('../../worker/payments/store.js');
  await store.settle(env.DB, id, 'pending', { failureCode: 'PENDING_REVIEW' });
}

test('a payment for the wrong amount is refused even if PayPal accepted it', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    // PayPal reports a capture of 1.00 against a 26.10 order.
    '/v2/checkout/orders/PP-ORDER-1/capture': () =>
      captureOk(payment.id, payment.reference, 100)
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  const body = await res.json();

  assert.equal(body.payment.status, 'failed');
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.failure_code, 'amount_mismatch');
});

test('a guest who closes the PayPal window leaves a cancelled payment, not a stuck one', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const payment = await createPayment(env, c);
  const res = await worker.fetch(post(`/api/payments/${payment.id}/cancel`), env, c);
  assert.equal((await res.json()).payment.status, 'cancelled');
});

/* --- webhooks ------------------------------------------------------------ */

const verified = () => ({ verification_status: 'SUCCESS' });

test('a verified capture webhook settles the payment', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': verified
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);

  const event = webhookEvent({
    id: 'WH-1', paymentId: payment.id, reference: payment.reference,
    amount: BASKET_TOTAL, orderId: 'PP-ORDER-1'
  });
  const res = await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  assert.equal(res.status, 200);
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'captured');
});

test('the same webhook delivered five times is acted on once', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': verified
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  const event = webhookEvent({
    id: 'WH-REPLAY', paymentId: payment.id, reference: payment.reference,
    amount: BASKET_TOTAL, orderId: 'PP-ORDER-1'
  });

  const responses = [];
  for (let i = 0; i < 5; i++) {
    responses.push(await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c));
  }
  await c.settled();

  const bodies = await Promise.all(responses.map((r) => r.json()));
  assert.equal(bodies.filter((b) => b.duplicate).length, 4, 'four of five are duplicates');

  const events = await env.DB.prepare(
    "SELECT * FROM payment_events WHERE event_key = 'paypal:WH-REPLAY'"
  ).all();
  assert.equal(events.results.length, 1);
});

test('an unverified webhook is refused and changes nothing', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'FAILURE' })
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  const event = webhookEvent({
    id: 'WH-FORGED', paymentId: payment.id, amount: BASKET_TOTAL, orderId: 'PP-ORDER-1'
  });

  const res = await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'created', 'a forged event must not move a payment');
});

test('a webhook with no signature headers is refused', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({ '/v1/notifications/verify-webhook-signature': verified });
  t.after(() => paypal.restore());

  const res = await worker.fetch(
    post('/api/webhooks/paypal', webhookEvent({}), { 'content-type': 'application/json' }),
    env, ctx()
  );
  assert.equal(res.status, 400);
});

test('the guest approved but never came back: the money is still taken', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;
  let captured = false;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v1/notifications/verify-webhook-signature': verified,
    '/v2/checkout/orders/PP-ORDER-1/capture': () => {
      captured = true;
      return captureOk(payment.id, payment.reference);
    }
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);

  // The browser never calls capture. Only this arrives.
  const event = webhookEvent({
    id: 'WH-APPROVED', type: 'CHECKOUT.ORDER.APPROVED',
    paymentId: payment.id, reference: payment.reference, orderId: 'PP-ORDER-1'
  });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  assert.equal(captured, true, 'an approved order must be captured server-side');
  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'captured');
});

test('a refund webhook is carried into the books', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference),
    '/v1/notifications/verify-webhook-signature': verified
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const event = webhookEvent({
    id: 'WH-REFUND', type: 'PAYMENT.CAPTURE.REFUNDED',
    paymentId: payment.id, reference: payment.reference,
    amount: 1000, orderId: 'PP-ORDER-1'
  });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  const row = await env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.refunded_amount, 1000);
  assert.equal(row.status, 'partially_refunded');
});

/* --- coming back to an interrupted checkout ------------------------------ */

test('a refresh mid-checkout is answered by asking the provider, not by guessing', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;
  let reads = 0;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1': () => {
      reads++;
      return captureOk(payment.id, payment.reference);
    }
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);

  // The webhook never arrived and the browser never captured. The page asks.
  const res = await worker.fetch(get(`/api/payments/${payment.id}`), env, c);
  const body = await res.json();

  assert.equal(reads, 1, 'an unresolved payment is reconciled with the provider');
  assert.equal(body.payment.status, 'captured');
  assert.equal(body.payment.final, true);
});

test('a settled payment is reported without troubling the provider again', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;
  let reads = 0;

  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference),
    '/v2/checkout/orders/PP-ORDER-1': () => { reads++; return captureOk(payment.id, payment.reference); }
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const res = await worker.fetch(get(`/api/payments/${payment.id}`), env, c);
  assert.equal((await res.json()).payment.status, 'captured');
  assert.equal(reads, 0);
});

test('an unknown payment id is a 404, never an invented payment', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(get('/api/payments/not-a-real-payment-id'), env, ctx());
  assert.equal(res.status, 404);
});

/* --- what the page and the books are allowed to see ---------------------- */

test('the public config never carries the secret', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(get('/api/payments/config'), env, ctx());
  const body = await res.json();
  const text = JSON.stringify(body);

  assert.equal(body.online, true);
  assert.equal(body.keys.paypal.clientId, 'test-client-id');
  assert.ok(!text.includes('test-secret'), 'the client secret must never be served');
  assert.ok(!text.includes('test-webhook-id'), 'the webhook id must never be served');
  // Wallets first: what a phone pays with in two taps comes before what needs
  // a card number typed. Three of these four need no PayPal account.
  assert.deepEqual(body.methods, ['applepay', 'googlepay', 'card', 'paypal']);
});

test('online payment disappears entirely when it is not configured', async (t) => {
  const env = workerEnv(MENU, { PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const config = await (await worker.fetch(get('/api/payments/config'), env, ctx())).json();
  assert.equal(config.online, false);
  assert.deepEqual(config.methods, []);

  const res = await worker.fetch(post('/api/payments', BASKET), env, ctx());
  assert.equal(res.status, 503);
});

test('every offered method creates a payment, and each is recorded as itself', async (t) => {
  // Apple Pay, Google Pay and card are guest checkout: no PayPal account is
  // involved for any of them. All four are still one provider underneath, and
  // the row must say which the guest actually used.
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' })
  });
  t.after(() => paypal.restore());

  for (const method of ['applepay', 'googlepay', 'card', 'paypal']) {
    const res = await worker.fetch(post('/api/payments', { ...BASKET, method }), env, c);
    assert.equal(res.status, 201, `${method} must be accepted`);
    const payment = await res.json();
    assert.equal(payment.amount, BASKET_TOTAL);
    assert.equal(payment.provider, 'paypal');
  }
});

test('a method the guest was never offered cannot be forced', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  for (const method of ['bitcoin', '', null, 'PAYPAL']) {
    const res = await worker.fetch(post('/api/payments', { ...BASKET, method }), env, ctx());
    assert.equal(res.status, 503, `method ${method} must not be accepted`);
  }
});

test('sandbox credentials are never served to the live site', async (t) => {
  // The single worst failure this system could have: a real guest on
  // kairo1980.de decides to pay, and meets a checkout wired to sandbox that
  // cannot take their money. It must be impossible, not merely unlikely.
  const env = workerEnv(MENU, { PAYPAL_ENV: 'sandbox' });
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const live = (path, init) => new Request('https://kairo1980.de' + path, init);

  const config = await (await worker.fetch(live('/api/payments/config'), env, ctx())).json();
  assert.equal(config.online, false, 'no payment methods on the live domain');
  assert.deepEqual(config.methods, []);

  // And the route refuses too — hiding the buttons is not a control.
  const forced = await worker.fetch(live('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(BASKET)
  }), env, ctx());
  assert.equal(forced.status, 503);

  // Localhost is where sandbox belongs, and still works.
  const localConfig = await (await worker.fetch(
    new Request('http://127.0.0.1:8788/api/payments/config'), env, ctx())).json();
  assert.equal(localConfig.online, true);
});

test('live credentials serve the live site normally', async (t) => {
  const env = workerEnv(MENU, { PAYPAL_ENV: 'live' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const config = await (await worker.fetch(
    new Request('https://kairo1980.de/api/payments/config'), env, ctx())).json();
  assert.equal(config.online, true);
  assert.deepEqual(config.methods, ['applepay', 'googlepay', 'card', 'paypal']);
});

test('a paid order that never reached the restaurant can be found', async (t) => {
  // Payment and order travel different roads: the money through the provider,
  // the order through the guest's own WhatsApp. A guest who pays and closes
  // the tab is owed food and would otherwise be invisible.
  const env = workerEnv(MENU, { REPORT_TOKEN: 'tok' });
  const c = ctx();
  let payment;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference)
  });
  t.after(() => paypal.restore());

  payment = await createPayment(env, c);
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const report = () => worker.fetch(get('/api/reports/settlement', { authorization: 'Bearer tok' }), env, c)
    .then((r) => r.json());

  let body = await report();
  assert.equal(body.paidButNotSent.length, 1, 'paid, not yet handed over');
  assert.equal(body.paidButNotSent[0].reference, payment.reference);
  assert.equal(body.paidButNotSent[0].amount, BASKET_TOTAL);
  assert.ok(body.paidButNotSent[0].items.length, 'enough to recognise the order');
  // Never more than the ledger already holds.
  assert.equal(JSON.stringify(body).includes('@'), false, 'no contact details');

  // Once the guest taps send, it stops being an orphan — and tapping three
  // times does not record it three times.
  for (let i = 0; i < 3; i++) {
    const res = await worker.fetch(post(`/api/payments/${payment.id}/handover`), env, c);
    assert.equal(res.status, 200);
  }
  body = await report();
  assert.equal(body.paidButNotSent.length, 0);

  const events = await env.DB.prepare(
    "SELECT * FROM payment_events WHERE event_type = 'order.handed_over'"
  ).all();
  assert.equal(events.results.length, 1, 'recorded once, however many taps');
});

test('handover cannot be reported for a payment that does not exist', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());
  const res = await worker.fetch(post('/api/payments/00000000-0000-4000-8000-000000000000/handover'), env, ctx());
  assert.equal(res.status, 404);
});

test('the settlement report is closed without the token', async (t) => {
  const env = workerEnv(MENU, { REPORT_TOKEN: 'sekret' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  assert.equal((await worker.fetch(get('/api/reports/settlement'), env, ctx())).status, 401);
  assert.equal((await worker.fetch(get('/api/reports/settlement', {
    authorization: 'Bearer wrong'
  }), env, ctx())).status, 401);

  const ok = await worker.fetch(get('/api/reports/settlement', {
    authorization: 'Bearer sekret'
  }), env, ctx());
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).totals, { orders: 0, gross: 0, refunded: 0, net: 0 });
});

test('the site itself is still served straight from the assets', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(get('/'), env, ctx());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /mitem/);
});

test('malformed and oversized requests are refused politely', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const bad = await worker.fetch(post('/api/payments', '{not json'), env, ctx());
  assert.equal(bad.status, 400);

  const wrongType = await worker.fetch(new Request('https://kairo1980.de/api/payments', {
    method: 'POST', body: 'items=1', headers: { 'Content-Type': 'text/plain' }
  }), env, ctx());
  assert.equal(wrongType.status, 400);

  const huge = await worker.fetch(post('/api/payments', 'x'.repeat(20000)), env, ctx());
  assert.equal(huge.status, 400);
});

/* --- telling the restaurant ----------------------------------------------
   A guest paid, closed the tab, and the restaurant heard nothing: the money is
   taken server-side, but the ORDER was only ever composed in the guest's own
   browser and handed to WhatsApp by the guest. These tests hold the server to
   announcing a paid order itself — once, whatever path the capture arrives by,
   and never at the cost of the payment. */

const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242' };
const SEND = '/botbot-token/sendMessage';
const sent = (paypal) => paypal.calls.filter((c) => c.path === SEND);

/* --- the sweep that chases what nobody came back for ---------------------
   The webhook covers a browser that dies mid-checkout, and it is one channel.
   Everything that silences it silences it completely — a rolled credential,
   a refusing endpoint, a subscription edited in the dashboard — and the guest
   who approved a payment then has agreed to pay, believes they have paid, and
   is never charged. These hold the quarter-hourly sweep to finding them. */

const SWEEP = { cron: '*/15 * * * *' };

/** Push a payment back in time, so the sweep's grace window is past. */
const age = (env, id, minutes) => env.DB.prepare(
  'UPDATE payments SET created_at = ?2 WHERE id = ?1'
).bind(id, new Date(Date.now() - minutes * 60000).toISOString()).run();

const statusOf = (env, id) => env.DB.prepare(
  'SELECT status FROM payments WHERE id = ?1'
).bind(id).first();

test('a guest who approved and never came back is captured by the sweep', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    // The guest approved at PayPal. No webhook ever arrived, so we never knew.
    '/v2/checkout/orders/PP-ORDER-1': () =>
      orderResponse({ id: 'PP-ORDER-1', status: 'APPROVED' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c);
  await age(env, payment.id, 20);

  await worker.scheduled(SWEEP, env, c);
  await c.settled();

  assert.equal((await statusOf(env, payment.id)).status, 'captured',
    'the money the guest agreed to pay is taken');
  assert.equal(sent(paypal).length, 1, 'and the kitchen is told the order exists');
  assert.ok(sent(paypal)[0].body.text.includes(payment.reference));
});

test('the sweep leaves a payment that is still in flight alone', async (t) => {
  /* A guest is at the PayPal window right now. Reading their order back and
     acting on it would race the capture their own browser is about to make. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1': () =>
      orderResponse({ id: 'PP-ORDER-1', status: 'APPROVED' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  const payment = await createPayment(env, c);      // seconds old, not aged

  await worker.scheduled(SWEEP, env, c);
  await c.settled();

  assert.equal(paypal.calls.some((k) => k.method === 'GET' && k.path.endsWith('PP-ORDER-1')),
    false, 'PayPal was not asked about it at all');
  assert.equal((await statusOf(env, payment.id)).status, 'created');
});

test('a payment the sweep has already settled is never announced twice', async (t) => {
  /* The sweep runs every quarter of an hour and will see the same captured row
     for three days. The guard is `changed` from store.settle — the ledger's
     own replay guard — and not a second one that could disagree with it. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1': () =>
      orderResponse({ id: 'PP-ORDER-1', status: 'APPROVED' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c);
  await age(env, payment.id, 20);

  await worker.scheduled(SWEEP, env, c);
  await worker.scheduled(SWEEP, env, c);
  await c.settled();

  assert.equal(sent(paypal).length, 1, 'one dinner, one message');
});

test('one dead order does not stop the sweep reaching the next', async (t) => {
  /* An order the guest abandoned expires at PayPal and reads 404 for ever.
     If that threw out of the loop it would hide every payment behind it —
     which is the one thing a backstop must never do. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let n = 0;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-' + (++n) }),
    '/v2/checkout/orders/PP-ORDER-1': () =>
      ({ status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }),
    '/v2/checkout/orders/PP-ORDER-2': () =>
      orderResponse({ id: 'PP-ORDER-2', status: 'APPROVED' }),
    '/v2/checkout/orders/PP-ORDER-2/capture': () =>
      captureOk(second.id, second.reference, BASKET_TOTAL, 'PP-ORDER-2'),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  const first = await createPayment(env, c);
  var second = await createPayment(env, c);
  await age(env, first.id, 30);
  await age(env, second.id, 20);

  // Must not reject, however badly the first one goes.
  await worker.scheduled(SWEEP, env, c);
  await c.settled();

  assert.equal((await statusOf(env, first.id)).status, 'created', 'the dead one is left as it was');
  assert.equal((await statusOf(env, second.id)).status, 'captured', 'and the live one is settled');
  assert.equal(sent(paypal).length, 1);
});

test('the nightly tick scrubs as well as sweeping; the others only sweep', async (t) => {
  /* The dispatch itself, because it is the kind of thing that is written once
     and never looked at again. Retention answers to its own expression; every
     other tick is a reconciliation and nothing else. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  // A payer whose identity is long past the 180-day window.
  await env.DB.prepare(
    `INSERT INTO payments (id, reference, provider, status, amount, currency,
       subtotal, discount, fee, order_type, business, lines, payer_email,
       created_at, updated_at)
     VALUES ('old','OLD123','paypal','captured',1000,'EUR',1000,0,0,'pickup',0,'[]',
             'someone@example.com', ?1, ?1)`
  ).bind(new Date(Date.now() - 300 * 86400000).toISOString()).run();

  await worker.scheduled(SWEEP, env, c);
  await c.settled();
  assert.equal((await env.DB.prepare("SELECT payer_email AS e FROM payments WHERE id='old'").first()).e,
    'someone@example.com', 'a sweep tick does not scrub');

  await worker.scheduled({ cron: '17 3 * * *' }, env, c);
  await c.settled();
  assert.equal((await env.DB.prepare("SELECT payer_email AS e FROM payments WHERE id='old'").first()).e,
    null, 'the nightly one does');
});

test('a paid order is announced to the restaurant, with what it needs to cook it', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => captureOk(payment.id, payment.reference),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c);
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  await c.settled();          // the send is handed to waitUntil, not awaited

  const calls = sent(paypal);
  assert.equal(calls.length, 1, 'announced exactly once');
  assert.equal(calls[0].body.chat_id, '4242');

  const text = calls[0].body.text;
  assert.match(text, /26,10 €/, 'the amount the server computed');
  assert.ok(text.includes(payment.reference), 'the reference printed in both');
  assert.match(text, /2x Koshari/, 'enough to start cooking');
  assert.match(text, /Abholung/, 'and to know whether to drive it out');

  // The server has never held a name, a phone number or an address, and this
  // must not become the first thing that does.
  assert.equal(text.includes('@'), false, 'no contact details');
});

test('the order is announced even when the browser never comes back', async (t) => {
  /* The failure that started this: the guest approves, the tab dies, and the
     capture happens in the webhook. That is precisely the case where nobody
     will ever press send, so it is the case the announcement matters most in. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-2' }),
    '/v2/checkout/orders/PP-ORDER-2/capture': () => captureOk(payment.id, payment.reference),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c, BASKET, 'PP-ORDER-2');

  const event = webhookEvent({
    id: 'WH-APPROVED', type: 'CHECKOUT.ORDER.APPROVED',
    paymentId: payment.id, reference: payment.reference, orderId: 'PP-ORDER-2'
  });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();

  assert.equal(sent(paypal).length, 1, 'the webhook announced it');
});

test('a replayed webhook does not announce the same order twice', async (t) => {
  /* PayPal retries for days. The announcement hangs off the same conditional
     UPDATE the ledger does, so the replay guard is not a second mechanism that
     could disagree with it — it is the same one. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-3' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c, BASKET, 'PP-ORDER-3');

  for (const id of ['WH-CAP-1', 'WH-CAP-1', 'WH-CAP-2']) {
    const event = webhookEvent({
      id, type: 'PAYMENT.CAPTURE.COMPLETED',
      paymentId: payment.id, reference: payment.reference,
      amount: BASKET_TOTAL, orderId: 'PP-ORDER-3'
    });
    await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
    await c.settled();
  }

  assert.equal(sent(paypal).length, 1, 'one order, one announcement');
});

test('an announcement that fails never costs the guest their payment', async (t) => {
  /* By the time this runs the money is taken. A revoked bot token, a Telegram
     outage or a chat the bot was thrown out of must leave the payment exactly
     as captured — the order is still in /admin, which is where it was before
     any of this existed. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-4' }),
    '/v2/checkout/orders/PP-ORDER-4/capture': () => captureOk(payment.id, payment.reference),
    [SEND]: () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c, BASKET, 'PP-ORDER-4');
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  await c.settled();

  assert.equal(res.status, 200);
  assert.equal((await res.json()).payment.status, 'captured');
});

test('with no token configured the site behaves exactly as it did before', async (t) => {
  // An unconfigured notifier is off, not broken — the same call the admin area
  // makes about its own credentials.
  const env = workerEnv(MENU);          // no TELEGRAM_* at all
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-5' }),
    '/v2/checkout/orders/PP-ORDER-5/capture': () => captureOk(payment.id, payment.reference)
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c, BASKET, 'PP-ORDER-5');
  const res = await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  await c.settled();

  assert.equal(res.status, 200);
  assert.equal((await res.json()).payment.status, 'captured');
  assert.equal(paypal.calls.some((k) => k.path.includes('sendMessage')), false);
});

/* --- the order itself ----------------------------------------------------
   Until /api/orders/announce existed, an order paid on arrival reached this
   server nowhere at all: the kitchen learned of it only if the guest remembered
   to press send in WhatsApp. These tests hold the route to the three things
   that make it worth having — the order is recorded, the restaurant is told,
   and nothing about it can lose an order that would otherwise have been fine. */

const CASH_ORDER = {
  items: { koshari: 2 },
  type: 'delivery',
  business: false,
  postcode: '68766',
  time: 'Heute 19:30',
  name: 'Sherif Esmat',
  phone: '+49 176 79906621',
  address: 'Hauptstrasse 12',
  notes: 'Bitte 2x klingeln'
};

const orderRow = (env, ref) => env.DB
  .prepare('SELECT * FROM orders WHERE reference = ?1').bind(ref).first();

test('a cash order is recorded and the restaurant is told', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.recorded, true);
  assert.ok(body.reference, 'the chat and the kitchen quote the same code');
  await c.settled();

  const row = await orderRow(env, body.reference);
  assert.equal(row.customer_name, 'Sherif Esmat');
  assert.equal(row.customer_phone, '+49 176 79906621');
  assert.equal(row.customer_address, 'Hauptstrasse 12');
  assert.equal(row.notes, 'Bitte 2x klingeln');
  assert.equal(row.pay_method, 'onsite');
  assert.equal(row.order_type, 'delivery');

  // Priced by the server from the published menu, never from the body.
  assert.equal(row.subtotal, 2900);
  assert.equal(row.total, 2610 + row.fee);

  const calls = sent(paypal);
  assert.equal(calls.length, 1, 'the restaurant was told');
  assert.match(calls[0].body.text, /ZAHLUNG BEI ERHALT/);
  assert.ok(calls[0].body.text.includes(body.reference));
});

test('the alert never carries the customer\'s name, phone or address', async (t) => {
  /* Telegram FZ-LLC is in the UAE, which has no adequacy decision. The details
     stay in D1 and are read at /admin; the message carries a reference and a
     basket, and that is the whole reason this split exists. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  await c.settled();

  const text = sent(paypal)[0].body.text;
  assert.equal(text.includes('Sherif Esmat'), false, 'no name');
  assert.equal(text.includes('79906621'), false, 'no telephone number');
  assert.equal(text.includes('Hauptstrasse'), false, 'no address');
  assert.equal(text.includes('klingeln'), false, 'and no free-text note');
  assert.match(text, /68766/, 'the postcode is enough to know the trip');
});

test('an order paid online is recorded but not announced twice', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-9' }),
    '/v2/checkout/orders/PP-ORDER-9/capture': () => captureOk(payment.id, payment.reference),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());

  var payment = await createPayment(env, c, BASKET, 'PP-ORDER-9');
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  await c.settled();
  assert.equal(sent(paypal).length, 1, 'announced once, on capture');

  // The handover carries the basket that was paid for (BASKET is a pickup). It
  // used to be sent as a delivery here, which only passed because the route
  // believed any paymentId; a payment now links only to its own basket.
  const res = await worker.fetch(post('/api/orders/announce', {
    ...CASH_ORDER, type: BASKET.type, postcode: undefined, paymentId: payment.id
  }), env, c);
  await c.settled();
  const body = await res.json();

  assert.equal(sent(paypal).length, 1, 'and not a second time on handover');
  assert.equal(body.reference, payment.reference, 'the payment keeps its own code');

  const row = await orderRow(env, payment.reference);
  assert.equal(row.pay_method, 'online');
  assert.equal(row.customer_name, 'Sherif Esmat', 'but the details did arrive');
});

test('a flood of announcements is throttled without refusing the first ones', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  const from = { 'CF-Connecting-IP': '203.0.113.55' };
  let recorded = 0;
  for (let i = 0; i < 14; i++) {
    const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER, from), env, c);
    if ((await res.json()).recorded) recorded++;
  }
  await c.settled();

  assert.ok(recorded >= 8 && recorded <= 10, `real orders got through (${recorded})`);
  assert.ok(recorded < 14, 'and the flood did not');
});

test('an announcement that fails never costs the guest their order', async (t) => {
  /* By the time this route is called the guest has pressed send. Every failure
     here has to be survivable, because the WhatsApp handover is already under
     way and losing an order to our own bookkeeping would be worse than the
     problem this route was added to solve. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    [SEND]: () => ({ status: 500, body: { ok: false } })
  });
  t.after(() => paypal.restore());

  const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  await c.settled();
  assert.equal(res.status, 200, 'the order is still recorded');
  assert.equal((await res.json()).recorded, true);

  // An unknown dish is the guest's basket disagreeing with the menu, which is
  // a plain 400 rather than a 500 the browser would treat as a crash.
  const bad = await worker.fetch(
    post('/api/orders/announce', { ...CASH_ORDER, items: { caviar: 1 } }), env, c);
  assert.equal(bad.status, 400);
});

/* --- the orders report ---------------------------------------------------
   What the bookkeeping system reads. The settlement report answers "what money
   arrived"; this answers "what was sold", which is what the books are built
   from. Held to the same three things the route was written for: it is closed
   without the token, it carries the sale in full, and it carries no guest. */

const ordersReport = (env, c, query = '', token = 'tok') => worker
  .fetch(get('/api/reports/orders' + query, { authorization: 'Bearer ' + token }), env, c)
  .then((r) => r.json());

test('the orders report is closed without the token', async (t) => {
  const env = workerEnv(MENU, { REPORT_TOKEN: 'sekret' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  assert.equal((await worker.fetch(get('/api/reports/orders'), env, ctx())).status, 401);
  assert.equal((await worker.fetch(get('/api/reports/orders', {
    authorization: 'Bearer wrong'
  }), env, ctx())).status, 401);
  assert.equal((await worker.fetch(get('/api/reports/orders', {
    authorization: 'Bearer sekret'
  }), env, ctx())).status, 200);
});

test('the orders report carries the sale, and the guest the books need', async (t) => {
  const env = workerEnv(MENU, { ...TELEGRAM, REPORT_TOKEN: 'tok' });
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  const { reference } = await res.json();
  await c.settled();

  const body = await ordersReport(env, c);
  assert.equal(body.orders.length, 1);
  const order = body.orders[0];

  // The sale, in full: what it was, what it cost, and where it went.
  assert.equal(order.reference, reference);
  assert.equal(order.orderType, 'delivery');
  assert.equal(order.payMethod, 'onsite');
  assert.equal(order.postcode, '68766');
  assert.ok(order.lines.length, 'the dishes, or the books cannot say what sold');
  assert.equal(order.money.subtotal - order.money.discount + order.money.deliveryFee,
    order.money.total, 'the parts must add up to what the guest owes');
  assert.equal(order.money.net, order.money.total, 'nothing refunded');
  assert.equal(order.payment, null, 'paid on arrival — there is no payment to describe');

  // An instant, and the restaurant's own day for it. A reader must never have
  // to guess which of the two a bare timestamp meant.
  assert.match(order.placedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(order.tradingDay, /^\d{4}-\d{2}-\d{2}$/);

  /* Who ordered, for the restaurant's own books.

     This report used to carry no guest at all, on the same reasoning that keeps
     a name out of a Telegram message. The books are the one place these details
     are genuinely needed: without them the restaurant's own system cannot tell
     that the guest who ordered here is the same regular who orders through a
     marketplace, so one person counts as two customers and neither shows what
     they are worth. Same controller, same purpose, one more source — and a
     token only that system holds. */
  assert.equal(order.customer.name, 'Sherif Esmat');
  assert.ok(order.customer.phone, 'the books cannot match a guest without a way to know them');
  assert.ok(order.customer.address, 'a delivery address is part of who a regular is');
  assert.equal(order.detailsPurgedAt, null, 'nothing has been scrubbed yet');

  /* The note still travels nowhere. It is free text a guest writes, it is where
     an allergy gets mentioned, and health data under Art. 9 needs a reason to
     move rather than an absence of one. Knowing who somebody is does not
     require knowing what they are allergic to. */
  assert.equal('notes' in order, false, 'the note must not be in the report at all');
  assert.equal(JSON.stringify(body).includes('klingeln'), false, 'the report leaks the note');
});

test('a scrubbed order says so instead of looking like a guest who gave no name', async (t) => {
  /* Once the details are purged there is nothing to send, and two very different
     facts would otherwise look identical: an order whose guest details were
     deleted on schedule, and an order taken from somebody who never gave any.
     The books must be able to tell them apart, or a purge reads as a data loss. */
  const env = workerEnv(MENU, { ...TELEGRAM, REPORT_TOKEN: 'tok' });
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  await c.settled();
  await env.DB.prepare(
    `UPDATE orders SET customer_name = NULL, customer_phone = NULL,
                       customer_address = NULL, customer_company = NULL, notes = NULL,
                       details_purged_at = datetime('now')`
  ).run();

  const order = (await ordersReport(env, c)).orders[0];
  assert.equal(order.customer, null, 'a purged order carries no guest object at all');
  assert.ok(order.detailsPurgedAt, 'and says when they were deleted');
  // The sale itself survives the purge, exactly as it must.
  assert.ok(order.money.total > 0);
  assert.ok(order.lines.length);
});

test('the orders report states that no VAT is charged', async (t) => {
  /* This restaurant is a Kleinunternehmer under § 19 UStG, so these figures
     carry no tax to split out. A reader that simply found no tax field could
     not tell "exempt" from "forgotten", and would have to assume one. */
  const env = workerEnv(MENU, { REPORT_TOKEN: 'tok' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const body = await ordersReport(env, ctx());
  assert.equal(body.vat.charged, false);
  assert.equal(body.vat.scheme, 'kleinunternehmer');
  assert.equal(body.currency, 'EUR');
  assert.equal(body.timezone, 'Europe/Berlin');
  assert.equal(body.complete, true, 'a partial window must say so');
});

test('a closed kitchen is not given a cash order either', async (t) => {
  /* The disaster of 14 August 2026. Closing the restaurant stopped orders that were
     paid for and let through the ones that were not: /api/payments checked the switch
     and /api/orders/announce, added later, never did. A guest whose page had been open
     since before the switch pressed send, and a closed kitchen was told it had an
     order — which then sat in the books as a real sale. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('ordering', ?1)"
  ).bind(JSON.stringify({ open: false, resumesAt: '2099-01-01T00:00:00.000Z' })).run();

  const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  await c.settled();

  assert.equal(res.status, 503, 'a closed kitchen was handed an order it had refused');
  assert.equal((await res.json()).error.code, 'ordering_closed');

  // Nothing recorded, and nothing announced: no row to become a sale, and no alert
  // telling a closed kitchen to cook.
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM orders').first();
  assert.equal(rows.n, 0, 'the order was still written to the books');
  assert.equal(paypal.calls.some((k) => k.path.includes('sendMessage')), false);
});

test('an order for after we reopen is ordinary, closure or not', async (t) => {
  /* A closure withholds a MOMENT, not the order. Refusing a Tuesday order because
     Monday night is off would cost the restaurant business it wanted. */
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('ordering', ?1)"
  ).bind(JSON.stringify({ open: false, resumesAt: '2026-08-15T10:00:00.000Z' })).run();

  const res = await worker.fetch(
    post('/api/orders/announce', { ...CASH_ORDER, when: { date: '2026-08-16', time: '19:00' } }),
    env, c);
  await c.settled();

  assert.equal(res.status, 200);
  assert.equal((await res.json()).recorded, true);
});

test('an order the restaurant never took is marked, not deleted, and says so in the report', async (t) => {
  /* The disaster of 14 August has a second half. Closing the kitchen now refuses
     new orders — but an order can always turn out not to have been taken: the guest
     rings to cancel, nobody can reach the address, somebody pressed send twice. The
     restaurant marks it where the orders arrive, and the books must learn that
     without anyone deciding it a second time over there. */
  const ADMIN = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };
  const env = workerEnv(MENU, { ...TELEGRAM, ...ADMIN, REPORT_TOKEN: 'tok' });
  const c = ctx();
  const paypal = fakePayPal({ [SEND]: () => ({ ok: true }) });
  t.after(() => paypal.restore());

  const signIn = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN.ADMIN_USER, password: ADMIN.ADMIN_PASSWORD })
  }), env, c);
  const cookie = (signIn.headers.get('set-cookie') || '').split(';')[0];

  const res = await worker.fetch(post('/api/orders/announce', CASH_ORDER), env, c);
  const { reference } = await res.json();
  await c.settled();
  const row = await orderRow(env, reference);

  const form = new URLSearchParams({ id: row.id, reason: 'We were closed', day: '2026-08-14' });
  const marked = await worker.fetch(new Request('https://kairo1980.de/admin/orders/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: form
  }), env, c);
  assert.equal(marked.status, 303, 'a refresh must not repeat it');

  // Still there. It happened, and money may have moved.
  const after = await orderRow(env, reference);
  assert.ok(after, 'the order was deleted rather than marked');
  assert.ok(after.cancelled_at);
  assert.equal(after.cancelled_reason, 'We were closed');

  // And the books are told, on the order rather than by its absence.
  const report = await ordersReport(env, c);
  const reported = report.orders.find((o) => o.reference === reference);
  assert.ok(reported, 'a cancelled order vanished from the report instead of being marked');
  assert.equal(reported.cancelled, true);
  assert.equal(reported.cancelledReason, 'We were closed');

  // Reversible: pressed by mistake, put back.
  await worker.fetch(new Request('https://kairo1980.de/admin/orders/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ id: row.id, restore: '1' })
  }), env, c);
  const restored = await orderRow(env, reference);
  assert.equal(restored.cancelled_at, null);
});
