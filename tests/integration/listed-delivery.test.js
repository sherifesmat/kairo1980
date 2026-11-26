/* A delivery goes to a postcode AND a town chosen from the list (PO-15).
   KBOSS loop DELIVERY_PRICING, rounds 20-21 (G3, G4, G7; DP-21-02/03/04).

   The defect this replaces: the basket read "68799 Reilingen" as 68799 and showed
   Reilingen's fee, while the server wanted exactly five digits, called it outside
   the area and charged no fee. Three real deliveries were taken that way.

   Every case uses the real routes and a real migrated database. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
import { orderIdentity } from '../../worker/orders.js';
import { workerEnv, fakePayPal, orderResponse } from '../helpers/env.js';

const MENU = {
  koshari: { price: 1450, name: 'Koshari' },
  feast: { price: 5300, name: 'Feast' }
};
const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242' };
const SEND = '/botbot-token/sendMessage';

function ctx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settled: () => Promise.all(promises) };
}
const post = (path, body) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

function world(t) {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const providerCalls = () => paypal.calls.filter((k) => k.path === '/v2/checkout/orders').length;
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).length;
  return { env, c, providerCalls, alerts };
}

async function call(env, c, path, body) {
  const res = await worker.fetch(post(path, body), env, c);
  await c.settled();
  return { status: res.status, body: await res.json() };
}

const rows = (env, table) => env.DB._raw.prepare(`SELECT * FROM ${table}`).all();

const GUEST = { time: 'So schnell wie möglich', name: 'Test Gast', phone: '+49 176 1234567',
                address: 'Hauptstraße 1' };
const REILINGEN = { items: { feast: 1 }, type: 'delivery', business: false,
                    postcode: '68799', town: 'Reilingen' };

/* --- the price -------------------------------------------------------------- */

test('a €53 order to Reilingen pays Reilingen\'s €1 fee: 53.00 - 5.30 + 1.00 = 48.70', async (t) => {
  const { env, c } = world(t);
  const { status, body } = await call(env, c, '/api/payments/quote', REILINGEN);
  assert.equal(status, 200);
  assert.deepEqual([body.subtotal, body.discount, body.fee, body.total], [5300, 530, 100, 4870]);
  assert.equal(body.deliverable, true);
});

test('the free text that was charged nothing is not a delivery any more', async (t) => {
  const { env, c } = world(t);
  for (const postcode of ['68799 Reilingen', 'Schwetzingen', '68799']) {
    const { body } = await call(env, c, '/api/payments/quote',
      { items: { feast: 1 }, type: 'delivery', postcode });
    assert.equal(body.deliverable, false, postcode);
    assert.equal(body.zone, null, postcode);
  }
});

test('68723 is three towns, each with 68723\'s one price, and no other town', async (t) => {
  const { env, c } = world(t);
  for (const town of ['Oftersheim', 'Plankstadt', 'Schwetzingen']) {
    const { body } = await call(env, c, '/api/payments/quote',
      { items: { koshari: 1 }, type: 'delivery', postcode: '68723', town });
    assert.equal(body.deliverable, true, town);
    assert.equal(body.fee, 200, town);
  }
  for (const town of ['Hockenheim', 'Schwetzingen / Plankstadt', 'oftersheim', ' Oftersheim']) {
    const { body } = await call(env, c, '/api/payments/quote',
      { items: { koshari: 1 }, type: 'delivery', postcode: '68723', town });
    assert.equal(body.deliverable, false, town);
  }
});

test('pickup needs no postcode and ignores one left over from a delivery', async (t) => {
  const { env, c } = world(t);
  const { body } = await call(env, c, '/api/payments/quote',
    { items: { koshari: 1 }, type: 'pickup', postcode: '68799 Reilingen' });
  assert.equal(body.deliverable, true);
  assert.equal(body.fee, 0);
});

/* --- the server refuses before any side effect ----------------------------- */

test('no payment is started for a delivery that is not on the list', async (t) => {
  const { env, c, providerCalls } = world(t);
  for (const where of [{ postcode: '68799 Reilingen' }, { postcode: '68799' },
                       { postcode: '68799', town: 'Hockenheim' }, { postcode: 68799, town: 'Reilingen' }]) {
    const { status, body } = await call(env, c, '/api/payments',
      { items: { feast: 1 }, type: 'delivery', method: 'paypal', ...where });
    assert.equal(status, 400, JSON.stringify(where));
    assert.equal(body.error.code, 'postcode_not_listed', JSON.stringify(body));
  }
  assert.equal(providerCalls(), 0, 'the provider was never asked');
  assert.equal(rows(env, 'payments').length, 0);
});

test('a hand-made order for an unlisted delivery is not stored and nobody is told it is real', async (t) => {
  const { env, c, alerts } = world(t);
  const { status } = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { feast: 1 }, type: 'delivery', postcode: '68799 Reilingen' });
  assert.equal(status, 400);
  assert.equal(rows(env, 'orders').length, 0);
  assert.equal(alerts(), 0);
});

test('a listed delivery is stored with its postcode and town, and the report hands both on', async (t) => {
  const { env, c } = world(t);
  const { status, body } = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { koshari: 1 }, type: 'delivery', postcode: '68723', town: 'Oftersheim' });
  assert.equal(status, 200, JSON.stringify(body));
  const [order] = rows(env, 'orders');
  assert.deepEqual([order.postcode, order.town, order.fee], ['68723', 'Oftersheim', 200]);
});

test('a paid delivery is stored with its pair, and pays only for that pair', async (t) => {
  const { env, c } = world(t);
  const created = await call(env, c, '/api/payments',
    { items: { koshari: 1 }, type: 'delivery', method: 'paypal', postcode: '68723', town: 'Oftersheim' });
  assert.equal(created.status, 201);
  const [payment] = rows(env, 'payments');
  assert.deepEqual([payment.postcode, payment.town, payment.fee], ['68723', 'Oftersheim', 200]);
  env.DB._raw.prepare("UPDATE payments SET status = 'captured' WHERE id = ?").run(payment.id);

  // Same postcode, same fee, another town: not this payment's order.
  const other = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { koshari: 1 }, type: 'delivery', postcode: '68723', town: 'Plankstadt',
      paymentId: payment.id });
  assert.equal(other.status, 200);
  let [order] = rows(env, 'orders');
  assert.equal(order.pay_method, 'onsite');
  assert.equal(order.payment_check, 'unverified');

  // The pair it was paid for links.
  env.DB._raw.prepare('DELETE FROM orders').run();
  const same = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { koshari: 1 }, type: 'delivery', postcode: '68723', town: 'Oftersheim',
      paymentId: payment.id });
  assert.equal(same.body.reference, payment.reference);
  [order] = rows(env, 'orders');
  assert.equal(order.pay_method, 'online');
  assert.equal(order.payment_id, payment.id);
});

/* --- payments and orders from before the list ------------------------------- */

/** A payment as the site stored it before 0007: typed postcode, no town, the old price. */
function paymentBeforeTheList(env, { status = 'captured', postcode = '68799 Reilingen' } = {}) {
  const id = crypto.randomUUID();
  env.DB._raw.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status, amount, currency,
       subtotal, discount, fee, order_type, business, postcode, lines, created_at, updated_at)
     VALUES (?, 'K-OLD1', 'paypal', 'PP-OLD', ?, 4770, 'EUR', 5300, 530, 0, 'delivery', 0, ?,
             ?, datetime('now'), datetime('now'))`
  ).run(id, status, postcode, JSON.stringify([
    { id: 'feast', dish: 'feast', name: 'Feast', qty: 1, unit: 5300, amount: 5300 }]));
  return id;
}

test('an old paid delivery handed over after the list links as it was paid: not re-priced, not re-charged', async (t) => {
  const { env, c } = world(t);
  for (const status of ['captured', 'pending']) {
    env.DB._raw.prepare('DELETE FROM orders').run();
    env.DB._raw.prepare('DELETE FROM payments').run();
    const id = paymentBeforeTheList(env, { status });
    // The old page hands over exactly what the guest typed then.
    const res = await call(env, c, '/api/orders/announce',
      { ...GUEST, items: { feast: 1 }, type: 'delivery', postcode: '68799 Reilingen', paymentId: id });
    assert.equal(res.status, 200, status + ' ' + JSON.stringify(res.body));
    assert.equal(res.body.reference, 'K-OLD1');
    const [order] = rows(env, 'orders');
    assert.equal(order.payment_id, id, status);
    assert.equal(order.pay_method, 'online');
    // The amount agreed then, not today's €1 fee.
    assert.deepEqual([order.fee, order.total, order.town], [0, 4770, null]);
    const [payment] = rows(env, 'payments');
    assert.equal(payment.amount, 4770);
    assert.equal(payment.status, status, 'the payment\'s own state is untouched');

    // Handed over again: the same order, nothing new.
    const again = await call(env, c, '/api/orders/announce',
      { ...GUEST, items: { feast: 1 }, type: 'delivery', postcode: '68799 Reilingen', paymentId: id });
    assert.equal(again.body.reference, 'K-OLD1');
    assert.equal(rows(env, 'orders').length, 1);
  }
});

test('an old payment pays for its own postcode only, and never for one without a postcode', async (t) => {
  const { env, c } = world(t);
  const id = paymentBeforeTheList(env);
  // Another postcode under the old payment id is not that payment's order.
  const elsewhere = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { feast: 1 }, type: 'delivery', postcode: '68766 Hockenheim', paymentId: id });
  assert.equal(elsewhere.status, 400, 'and it is not a listed delivery either');
  assert.equal(rows(env, 'orders').length, 0);

  // Two values with no postcode in them are not the same place.
  const nowhere = paymentBeforeTheList(env, { postcode: 'Schwetzingen' });
  const res = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { feast: 1 }, type: 'delivery', postcode: 'Plankstadt', paymentId: nowhere });
  assert.equal(res.status, 400);
  assert.equal(rows(env, 'orders').length, 0);
});

test('an old order\'s identity is exactly what it was, so its replay is still found', () => {
  const old = { items: { feast: 1 }, type: 'delivery', business: false, postcode: '68799 Reilingen' };
  assert.equal(orderIdentity(old),
    '{"items":[["feast",1]],"type":"delivery","business":false,"postcode":"68799 Reilingen"}');
  // A listed pair names its town, so two towns of 68723 are two destinations.
  assert.notEqual(
    orderIdentity({ ...old, postcode: '68723', town: 'Oftersheim' }),
    orderIdentity({ ...old, postcode: '68723', town: 'Plankstadt' }));
});

/* --- the guest pays only what they were shown (G5) -------------------------- */

test('a payment is started only for the total the guest was shown', async (t) => {
  const { env, c, providerCalls } = world(t);
  const order = { items: { feast: 1 }, type: 'delivery', method: 'paypal', ...REILINGEN };

  // A page holding an older menu or tariff showed another figure: refused, before the provider.
  const stale = await call(env, c, '/api/payments', { ...order, expectedTotal: 4770 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'total_changed');
  assert.equal(providerCalls(), 0);
  assert.equal(rows(env, 'payments').length, 0);

  // The figure the server agrees with starts the payment, for exactly that amount.
  const shown = await call(env, c, '/api/payments', { ...order, expectedTotal: 4870 });
  assert.equal(shown.status, 201, JSON.stringify(shown.body));
  assert.equal(rows(env, 'payments')[0].amount, 4870);

  // A page from before the check sends no figure, and is priced as it always was.
  const older = await call(env, c, '/api/payments', order);
  assert.equal(older.status, 201);
  // A figure that is not a number of cents is not the shown total either.
  const text = await call(env, c, '/api/payments', { ...order, expectedTotal: '4870' });
  assert.equal(text.status, 409);
});
