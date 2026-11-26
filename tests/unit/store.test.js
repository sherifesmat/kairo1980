/* The payment state machine, against the real schema.

   The two properties everything else depends on:
     a payment can only ever be captured once, and
     an event that arrives twice is only ever acted on once. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from '../helpers/d1.js';
import * as store from '../../worker/payments/store.js';

function newPayment(overrides = {}) {
  return {
    id: 'pay-1',
    reference: 'K7F3QA',
    provider: 'paypal',
    providerOrderId: 'PP-ORDER-1',
    amount: 2810,
    currency: 'EUR',
    subtotal: 2900,
    discount: 290,
    fee: 200,
    orderType: 'delivery',
    business: false,
    postcode: '69168', town: 'Wiesloch',
    lines: [{ id: 'hummus', name: 'Hummus', qty: 2, unit: 950, amount: 1900 }],
    ...overrides
  };
}

test('a new payment starts as created and records why it exists', async () => {
  const db = freshDatabase();
  const payment = await store.create(db, newPayment());

  assert.equal(payment.status, 'created');
  assert.equal(payment.amount, 2810);
  assert.equal(payment.reference, 'K7F3QA');

  const { results } = await db.prepare('SELECT * FROM payment_events').all();
  assert.equal(results.length, 1);
  assert.equal(results[0].event_type, 'payment.created');
});

test('capturing moves the payment forward and stamps the time', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());

  const { changed, payment } = await store.settle(db, 'pay-1', 'captured', {
    captureId: 'CAP-1',
    paymentSource: 'applepay'
  });

  assert.equal(changed, true);
  assert.equal(payment.status, 'captured');
  assert.equal(payment.capture_id, 'CAP-1');
  assert.equal(payment.payment_source, 'applepay');
  assert.ok(payment.captured_at);
});

test('a payment cannot be captured twice', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());

  const first = await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-1' });
  const second = await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-DUPLICATE' });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  // The second attempt must not have overwritten anything.
  assert.equal(second.payment.capture_id, 'CAP-1');
  assert.equal(second.payment.status, 'captured');
});

test('a captured payment can never be walked back to failed or cancelled', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());
  await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-1' });

  for (const status of ['failed', 'cancelled', 'approved', 'pending']) {
    const { changed, payment } = await store.settle(db, 'pay-1', status, {});
    assert.equal(changed, false, `${status} must not be reachable from captured`);
    assert.equal(payment.status, 'captured');
  }
});

test('a cancelled payment cannot later be captured', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());
  await store.settle(db, 'pay-1', 'cancelled', {});

  const { changed } = await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-1' });
  assert.equal(changed, false);
});

test('a pending capture can still resolve either way', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());
  await store.settle(db, 'pay-1', 'pending', {});

  const { changed, payment } = await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-1' });
  assert.equal(changed, true);
  assert.equal(payment.status, 'captured');
});

test('the same provider event is only ever recorded once', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());

  const event = {
    paymentId: 'pay-1', provider: 'paypal', eventKey: 'paypal:WH-1',
    eventType: 'PAYMENT.CAPTURE.COMPLETED', source: 'webhook'
  };

  assert.equal(await store.logEvent(db, event), true);
  assert.equal(await store.logEvent(db, event), false, 'a replay must be refused');

  const { results } = await db.prepare(
    "SELECT * FROM payment_events WHERE event_key = 'paypal:WH-1'"
  ).all();
  assert.equal(results.length, 1);
});

test('a partial refund leaves the payment partly settled, a full one closes it', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());
  await store.settle(db, 'pay-1', 'captured', { captureId: 'CAP-1' });

  const partial = await store.settle(db, 'pay-1', 'partially_refunded', { refundedAmount: 1000 });
  assert.equal(partial.payment.refunded_amount, 1000);

  const full = await store.settle(db, 'pay-1', 'refunded', { refundedAmount: 2810 });
  assert.equal(full.changed, true);
  assert.equal(full.payment.status, 'refunded');
});

test('settling an unknown payment reports nothing rather than inventing one', async () => {
  const db = freshDatabase();
  const { changed, payment } = await store.settle(db, 'nope', 'captured', {});
  assert.equal(changed, false);
  assert.equal(payment, null);
});

test('what the browser is told carries no provider detail', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment());
  const { payment } = await store.settle(db, 'pay-1', 'captured', {
    captureId: 'CAP-1', payerEmail: 'guest@example.com', payerId: 'PAYER1'
  });

  const view = store.publicView(payment);
  assert.equal(view.status, 'captured');
  assert.equal(view.amount, 2810);
  assert.equal(view.reference, 'K7F3QA');
  assert.equal(view.final, true);
  // Never leaked to the page.
  assert.equal(view.payerEmail, undefined);
  assert.equal(view.capture_id, undefined);
  assert.equal(view.lines, undefined);
});

test('references are readable and unlikely to collide', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const ref = store.newReference();
    assert.match(ref, /^[0-9ACDEFGHJKLMNPQRTUVWXYZ]{6}$/, 'no letters that get misread aloud');
    seen.add(ref);
  }
  assert.ok(seen.size > 1990, 'references must not repeat in normal volumes');
});

test('the settlement view counts money taken, net of refunds', async () => {
  const db = freshDatabase();
  await store.create(db, newPayment({ id: 'p1', reference: 'AAA111' }));
  await store.create(db, newPayment({ id: 'p2', reference: 'BBB222' }));
  await store.settle(db, 'p1', 'captured', { captureId: 'C1' });
  await store.settle(db, 'p2', 'captured', { captureId: 'C2' });
  await store.settle(db, 'p2', 'partially_refunded', { refundedAmount: 810 });

  const { results } = await db.prepare('SELECT * FROM payments_settled').all();
  const totals = results.reduce((a, r) => ({ gross: a.gross + r.gross, net: a.net + r.net }), { gross: 0, net: 0 });
  assert.equal(totals.gross, 5620);
  assert.equal(totals.net, 5620 - 810);
});
