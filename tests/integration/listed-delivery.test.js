/* A delivery goes to a postcode AND a town chosen from the list (PO-15).
   KBOSS loop DELIVERY_PRICING, rounds 20-22 (G3, G4, G5, G7; DP-21-02/03/04,
   DP-22-01/02/03/04).

   The defect this replaces: the basket read "68799 Reilingen" as 68799 and showed
   Reilingen's fee, while the server wanted exactly five digits, called it outside
   the area and charged no fee. Three real deliveries were taken that way.

   Every case uses the real routes and a real migrated database, and asserts the
   rows, not only the status code. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/index.js';
import { orderIdentity } from '../../worker/orders.js';
import { closeOrdering } from '../../worker/settings.js';
import { scrubExpiredIdentities } from '../../worker/retention.js';
import { workerEnv, fakePayPal, orderResponse, menuHtml } from '../helpers/env.js';

const MENU = {
  koshari: { price: 1450, name: 'Koshari' },
  feast: { price: 5300, name: 'Feast' }
};
const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242' };
const REPORT = { REPORT_TOKEN: 'report-token-for-tests' };
const SEND = '/botbot-token/sendMessage';

function ctx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settled: () => Promise.all(promises) };
}
const post = (path, body) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

function world(t) {
  const env = workerEnv(MENU, { ...TELEGRAM, ...REPORT });
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const providerCalls = () => paypal.calls.filter((k) => k.path === '/v2/checkout/orders').length;
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);
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
const OFTERSHEIM = { items: { koshari: 1 }, type: 'delivery', business: false,
                     postcode: '68723', town: 'Oftersheim' };

/** A payment created as the page creates it: for the total it was shown. */
async function paid(env, c, order, status = 'captured') {
  const shown = (await call(env, c, '/api/payments/quote', order)).body.total;
  const created = await call(env, c, '/api/payments', { ...order, method: 'paypal', expectedTotal: shown });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  env.DB._raw.prepare('UPDATE payments SET status = ?, captured_at = ? WHERE id = ?')
    .run(status, status === 'captured' ? new Date().toISOString() : null, created.body.id);
  return created.body;
}

/** A payment as the site stored it before 0007: typed postcode, no town, the old price. */
function paymentBeforeTheList(env, { status = 'captured', postcode = '68799 Reilingen', reference = 'K-OLD1' } = {}) {
  const id = crypto.randomUUID();
  env.DB._raw.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status, amount, currency,
       subtotal, discount, fee, order_type, business, postcode, lines, created_at, updated_at)
     VALUES (?, ?, 'paypal', ?, ?, 4770, 'EUR', 5300, 530, 0, 'delivery', 0, ?,
             ?, datetime('now'), datetime('now'))`
  ).run(id, reference, 'PP-' + reference, status, postcode, JSON.stringify([
    { id: 'feast', dish: 'feast', name: 'Feast', qty: 1, unit: 5300, amount: 5300 }]));
  return id;
}

/* --- the price -------------------------------------------------------------- */

test('a €53 order to Reilingen pays Reilingen\'s €1 fee: 53.00 - 5.30 + 1.00 = 48.70', async (t) => {
  const { env, c } = world(t);
  const { status, body } = await call(env, c, '/api/payments/quote', REILINGEN);
  assert.equal(status, 200);
  assert.deepEqual([body.subtotal, body.discount, body.fee, body.total], [5300, 530, 100, 4870]);
  assert.equal(body.deliverable, true);
});

test('a delivery that is not on the list has no price: no total, no fee, only the food', async (t) => {
  const { env, c } = world(t);
  for (const postcode of ['68799 Reilingen', 'Schwetzingen', '68799']) {
    const { status, body } = await call(env, c, '/api/payments/quote',
      { items: { feast: 1 }, type: 'delivery', postcode });
    assert.equal(status, 200, postcode);
    assert.equal(body.deliverable, false, postcode);
    assert.equal(body.reason, 'postcode_not_listed');
    assert.deepEqual([body.total, body.fee], [null, null], postcode + ': not a zero-fee price');
    assert.deepEqual([body.food.subtotal, body.food.discount], [5300, 530]);
  }
});

test('68723 is three towns, each with 68723\'s one price, and no other town', async (t) => {
  const { env, c } = world(t);
  for (const town of ['Oftersheim', 'Plankstadt', 'Schwetzingen']) {
    const { body } = await call(env, c, '/api/payments/quote', { ...OFTERSHEIM, town });
    assert.equal(body.deliverable, true, town);
    assert.equal(body.fee, 200, town);
  }
  for (const town of ['Hockenheim', 'Schwetzingen / Plankstadt', 'oftersheim', ' Oftersheim']) {
    const { body } = await call(env, c, '/api/payments/quote', { ...OFTERSHEIM, town });
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

/* --- the request says what it is (DP-22-01) ---------------------------------- */

test('a listed pair without a type, or with another one, is refused everywhere and costs nothing', async (t) => {
  const { env, c, providerCalls, alerts } = world(t);
  for (const type of [undefined, null, 'Delivery', 'shipping', 1]) {
    for (const path of ['/api/payments/quote', '/api/payments', '/api/orders/announce']) {
      const body = { ...GUEST, ...OFTERSHEIM, type, method: 'paypal', expectedTotal: 1505 };
      const res = await call(env, c, path, body);
      assert.equal(res.status, 400, path + ' ' + type);
      assert.equal(res.body.error.code, 'invalid_type', path + ' ' + type);
    }
  }
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, business: 'yes' });
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(providerCalls(), 0);
  assert.deepEqual([rows(env, 'payments').length, rows(env, 'orders').length, alerts().length], [0, 0, 0]);
});

/* --- the server refuses before any side effect ----------------------------- */

test('no payment is started for a delivery that is not on the list', async (t) => {
  const { env, c, providerCalls } = world(t);
  for (const where of [{ postcode: '68799 Reilingen' }, { postcode: '68799' },
                       { postcode: '68799', town: 'Hockenheim' }, { postcode: 68799, town: 'Reilingen' }]) {
    const { status, body } = await call(env, c, '/api/payments',
      { items: { feast: 1 }, type: 'delivery', method: 'paypal', expectedTotal: 4870, ...where });
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
  assert.equal(alerts().length, 0);
});

/* --- the shown total binds the payment (G5, DP-22-03) ----------------------- */

test('a payment is started only for the total the guest was shown, in whole cents', async (t) => {
  const { env, c, providerCalls } = world(t);
  const order = { ...REILINGEN, method: 'paypal' };
  const refused = [
    [undefined, 'reload_required'], [null, 'reload_required'], ['4870', 'reload_required'],
    [48.7, 'reload_required'], [0, 'reload_required'], [-4870, 'reload_required'],
    [4770, 'total_changed'], [4871, 'total_changed']
  ];
  for (const [expectedTotal, code] of refused) {
    const res = await call(env, c, '/api/payments', { ...order, expectedTotal });
    assert.equal(res.status, 409, String(expectedTotal));
    assert.equal(res.body.error.code, code, String(expectedTotal));
  }
  assert.equal(providerCalls(), 0, 'no refused figure reached the provider');
  assert.equal(rows(env, 'payments').length, 0);

  const shown = await call(env, c, '/api/payments', { ...order, expectedTotal: 4870 });
  assert.equal(shown.status, 201, JSON.stringify(shown.body));
  assert.equal(rows(env, 'payments')[0].amount, 4870);

  // A pickup is held to the same rule.
  const pickup = await call(env, c, '/api/payments',
    { items: { koshari: 1 }, type: 'pickup', business: false, method: 'paypal' });
  assert.equal(pickup.body.error.code, 'reload_required');
});

/* --- a listed delivery, stored and reported --------------------------------- */

test('a listed delivery is stored with its pair, and the report hands both on (and NULL before the list)', async (t) => {
  const { env, c } = world(t);
  const listed = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const pickup = await call(env, c, '/api/orders/announce',
    { ...GUEST, items: { koshari: 1 }, type: 'pickup', business: false, postcode: '68723', town: 'Oftersheim' });
  assert.equal(pickup.status, 200);
  // An order stored before 0007, as it was: typed postcode, no town.
  env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, order_type, business, pay_method, postcode, lines,
       subtotal, discount, fee, total, currency, created_at)
     VALUES ('old-1', 'K-OLD9', 'delivery', 0, 'onsite', '68799 Reilingen', '[]', 5300, 530, 0, 4770,
             'EUR', datetime('now'))`).run();

  const order = rows(env, 'orders').find((r) => r.reference === listed.body.reference);
  assert.deepEqual([order.postcode, order.town, order.fee], ['68723', 'Oftersheim', 200]);

  const res = await worker.fetch(new Request('https://kairo1980.de/api/reports/orders',
    { headers: { Authorization: `Bearer ${REPORT.REPORT_TOKEN}` } }), env, c);
  assert.equal(res.status, 200);
  const byRef = Object.fromEntries((await res.json()).orders.map((o) => [o.reference, o]));
  assert.deepEqual([byRef[listed.body.reference].postcode, byRef[listed.body.reference].town],
                   ['68723', 'Oftersheim']);
  assert.deepEqual([byRef[pickup.body.reference].postcode, byRef[pickup.body.reference].town], [null, null],
                   'a pickup goes nowhere');
  assert.deepEqual([byRef['K-OLD9'].postcode, byRef['K-OLD9'].town], ['68799 Reilingen', null],
                   'an old order keeps what it held, and no town is made up for it');
});

/* --- a real payment and the order handed over with it (DP-22-02) ------------- */

test('a paid delivery is stored with its pair, and a payment never pays for another town', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paid(env, c, OFTERSHEIM);
  const [row] = rows(env, 'payments');
  assert.deepEqual([row.postcode, row.town, row.fee], ['68723', 'Oftersheim', 200]);

  // Same postcode, same fee, another town: not this payment's order, and not an
  // order to be paid on site either. Nothing is stored; the counter is told.
  const other = await call(env, c, '/api/orders/announce',
    { ...GUEST, ...OFTERSHEIM, town: 'Plankstadt', paymentId: payment.id });
  assert.equal(other.status, 409);
  assert.deepEqual([other.body.reason, other.body.reference], ['payment_conflict', payment.reference]);
  assert.equal(rows(env, 'orders').length, 0);
  assert.match(alerts().at(-1), /^ZAHLUNG PRÜFEN/);
  assert.equal(rows(env, 'payments')[0].status, 'captured', 'the payment is untouched');

  // The pair it was paid for links, once.
  const same = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: payment.id });
  assert.equal(same.body.reference, payment.reference);
  const [order] = rows(env, 'orders');
  assert.deepEqual([order.pay_method, order.payment_id, order.town], ['online', payment.id, 'Oftersheim']);
});

test('a paid order links at the price it was paid, after the menu and the tariff changed', async (t) => {
  const { env, c } = world(t);
  for (const status of ['captured', 'pending']) {
    env.DB._raw.prepare('DELETE FROM orders').run();
    const payment = await paid(env, c, REILINGEN, status);
    // As if a price had changed since: today's quote is no longer what was paid.
    env.DB._raw.prepare("UPDATE payments SET lines = ?, subtotal = 5000, discount = 500, amount = 4600 WHERE id = ?")
      .run(JSON.stringify([{ id: 'feast', dish: 'feast', name: 'Feast', qty: 1, unit: 5000, amount: 5000 }]), payment.id);
    const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: payment.id });
    assert.equal(res.body.reference, payment.reference, status);
    const [order] = rows(env, 'orders');
    assert.deepEqual([order.total, order.subtotal, order.payment_id, order.pay_method],
                     [4600, 5000, payment.id, 'online'], status);
    const stored = rows(env, 'payments').find((p) => p.id === payment.id);
    assert.equal(stored.status, status, 'pending stays pending');
  }
});

/* --- payments and orders from before the list ------------------------------- */

test('an old paid delivery handed over after the list links as it was paid: not re-priced, not re-charged', async (t) => {
  const { env, c } = world(t);
  for (const status of ['captured', 'pending']) {
    env.DB._raw.prepare('DELETE FROM orders').run();
    env.DB._raw.prepare('DELETE FROM payments').run();
    const id = paymentBeforeTheList(env, { status });
    // The old page hands over exactly what the guest typed then.
    const res = await call(env, c, '/api/orders/announce',
      { ...GUEST, items: { feast: 1 }, type: 'delivery', business: false, postcode: '68799 Reilingen', paymentId: id });
    assert.equal(res.status, 200, status + ' ' + JSON.stringify(res.body));
    assert.equal(res.body.reference, 'K-OLD1');
    const [order] = rows(env, 'orders');
    assert.equal(order.payment_id, id, status);
    assert.equal(order.pay_method, 'online');
    // The amount agreed then, not today's €1 fee.
    assert.deepEqual([order.fee, order.total, order.postcode, order.town], [0, 4770, '68799 Reilingen', null]);
    assert.equal(rows(env, 'payments')[0].status, status, 'the payment\'s own state is untouched');

    // Handed over again, under either spelling: the same order, nothing new.
    for (const where of [{ postcode: '68799 Reilingen' }, { postcode: '68799', town: 'Reilingen' },
                         { postcode: '68799 reilingen' }, { postcode: '68799' }]) {
      const again = await call(env, c, '/api/orders/announce',
        { ...GUEST, items: { feast: 1 }, type: 'delivery', business: false, ...where, paymentId: id });
      assert.equal(again.body.reference, 'K-OLD1', JSON.stringify(where));
    }
    assert.equal(rows(env, 'orders').length, 1);
  }
});

test('an old paid delivery recovered by a new page, with the town chosen again, links as paid', async (t) => {
  const { env, c } = world(t);
  const id = paymentBeforeTheList(env);
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: id });
  assert.equal(res.body.reference, 'K-OLD1');
  const [order] = rows(env, 'orders');
  assert.deepEqual([order.payment_id, order.total, order.fee], [id, 4770, 0], 'at the price paid then');
});

test('an old payment never pays for another postcode, another town, or a value with no postcode', async (t) => {
  const { env, c, alerts } = world(t);
  const cases = [
    ['68799 Reilingen', { postcode: '68766 Hockenheim' }],
    ['68799 Reilingen', { postcode: '68766', town: 'Hockenheim' }],
    // Identical text with no postcode in it is not the same place.
    ['Schwetzingen', { postcode: 'Schwetzingen' }],
    ['-----', { postcode: '-----' }],
    // The same code, another town.
    ['68723 Oftersheim', { postcode: '68723 Plankstadt' }],
    ['68723 Oftersheim', { postcode: '68723', town: 'Plankstadt' }],
    // A bare 68723 is three towns: no town chosen now is read into it.
    ['68723', { postcode: '68723', town: 'Oftersheim' }]
  ];
  for (const [i, [stored, where]] of cases.entries()) {
    const id = paymentBeforeTheList(env, { postcode: stored, reference: 'K-OLD' + (10 + i) });
    const res = await call(env, c, '/api/orders/announce',
      { ...GUEST, items: { feast: 1 }, type: 'delivery', business: false, ...where, paymentId: id });
    assert.equal(res.status, 409, stored + ' -> ' + JSON.stringify(where));
    assert.equal(res.body.reason, 'payment_conflict');
  }
  assert.equal(rows(env, 'orders').length, 0, 'nothing stored, nothing to be paid on site');
  assert.equal(alerts().length, cases.length);
});

test('an order stored before 0006 under a typed postcode is found again from a new page', async (t) => {
  const { env, c, alerts } = world(t);
  const id = paymentBeforeTheList(env);
  // Linked then, with no identity and the typed postcode, as 0004/0005 stored it.
  env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, business, pay_method, postcode, lines,
       subtotal, discount, fee, total, currency, customer_address, created_at)
     VALUES ('o-1', 'K-OLD1', ?, 'delivery', 0, 'online', '68799 Reilingen', ?, 5300, 530, 0, 4770,
             'EUR', 'Hauptstraße 1', datetime('now'))`
  ).run(id, rows(env, 'payments')[0].lines);
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: id });
  assert.equal(res.body.reference, 'K-OLD1');
  assert.equal(rows(env, 'orders').length, 1, 'no second order under a paid payment');
  // The phone and time it adds are a correction the kitchen hears; nothing else.
  assert.equal(alerts().filter((m) => /ZAHLUNG PRÜFEN|NEUE/.test(m)).length, 0);
  assert.equal(rows(env, 'orders')[0].order_identity, orderIdentity({ ...REILINGEN }),
               'and the identity is written once, so the next replay is found directly');
});

test('an old order with an identity in the old spelling is found again from a new page', async (t) => {
  const { env, c, alerts } = world(t);
  const id = paymentBeforeTheList(env);
  const raw = { items: { feast: 1 }, type: 'delivery', business: false, postcode: '68799 Reilingen' };
  env.DB._raw.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, business, pay_method, postcode, lines,
       subtotal, discount, fee, total, currency, order_identity, created_at)
     VALUES ('o-1', 'K-OLD1', ?, 'delivery', 0, 'online', '68799 Reilingen', ?, 5300, 530, 0, 4770,
             'EUR', ?, datetime('now'))`).run(id, rows(env, 'payments')[0].lines, orderIdentity(raw));
  for (const handed of [{ ...GUEST, ...REILINGEN, paymentId: id }, { ...GUEST, ...raw, paymentId: id }]) {
    const res = await call(env, c, '/api/orders/announce', handed);
    assert.equal(res.body.reference, 'K-OLD1', JSON.stringify(handed.postcode));
  }
  assert.equal(rows(env, 'orders').length, 1);
  assert.equal(rows(env, 'orders')[0].order_identity, orderIdentity(raw), 'a stored identity is never rewritten');
  assert.equal(alerts().filter((m) => /ZAHLUNG PRÜFEN|NEUE/.test(m)).length, 0);
});

test('created, captured by the provider, menu changed, then handed over: linked as paid, nothing charged twice', async (t) => {
  for (const order of [REILINGEN, { items: { koshari: 2 }, type: 'pickup', business: false }]) {
    const env = workerEnv(MENU, { ...TELEGRAM, ...REPORT });
    const c = ctx();
    let payment;
    let captures = 0;
    const paypal = fakePayPal({
      '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
      '/v2/checkout/orders/PP-ORDER-1/capture': () => {
        captures++;
        return orderResponse({ id: 'PP-ORDER-1', status: 'COMPLETED', captureId: 'CAP-1',
          amount: payment.amount, paymentId: payment.id, reference: payment.reference });
      },
      [SEND]: () => ({ ok: true })
    });
    try {
      const shown = (await call(env, c, '/api/payments/quote', order)).body.total;
      payment = (await call(env, c, '/api/payments', { ...order, method: 'paypal', expectedTotal: shown })).body;
      const captured = await call(env, c, `/api/payments/${payment.id}/capture`, {});
      assert.equal(captured.body.payment.status, 'captured', order.type);

      // The menu changes before the handover: the dish costs more, and is gone from the list.
      const html = `<!doctype html><html><body>${menuHtml({ koshari: { price: 1999, name: 'Koshari' } })}</body></html>`;
      env.ASSETS = { fetch: async () => new Response(html, { status: 200,
        headers: { 'Content-Type': 'text/html', ETag: '"stub-changed"' } }) };

      const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...order, paymentId: payment.id });
      assert.equal(res.body.reference, payment.reference, order.type + ' ' + JSON.stringify(res.body));
      const [stored] = rows(env, 'orders');
      assert.deepEqual([stored.total, stored.pay_method, stored.payment_id], [shown, 'online', payment.id], order.type);
      assert.equal(rows(env, 'orders').length, 1);
      assert.equal(captures, 1, 'captured once');
    } finally { paypal.restore(); }
  }
});

test('two spellings of one paid order racing each other make one order and no conflict', async (t) => {
  const { env, c, alerts } = world(t);
  const id = paymentBeforeTheList(env);
  const [a, b] = await Promise.all([
    call(env, c, '/api/orders/announce', { ...GUEST, items: { feast: 1 }, type: 'delivery', business: false,
                                            postcode: '68799 Reilingen', paymentId: id }),
    call(env, c, '/api/orders/announce', { ...GUEST, ...REILINGEN, paymentId: id })
  ]);
  assert.deepEqual([a.body.reference, b.body.reference], ['K-OLD1', 'K-OLD1']);
  assert.equal(rows(env, 'orders').length, 1);
  assert.equal(alerts().filter((m) => /ZAHLUNG PRÜFEN/.test(m)).length, 0);
});

test('a failure that is not a race is a failure: never a second order to be paid on site', async (t) => {
  const { env, c } = world(t);
  const payment = await paid(env, c, OFTERSHEIM);
  const prepare = env.DB.prepare.bind(env.DB);
  let inserts = 0;
  env.DB.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/INSERT INTO orders/.test(sql)) return stmt;
    inserts++;
    return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: disk I/O error'); } }) };
  };
  let failed = false;
  try {
    const res = await worker.fetch(post('/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: payment.id }), env, c);
    failed = res.status >= 500;
  } catch { failed = true; }
  env.DB.prepare = prepare;
  assert.equal(failed, true, 'the failure is reported as one');
  assert.equal(inserts, 1, 'and not retried as an order to be paid on site');
  assert.equal(rows(env, 'orders').length, 0);
});

test('a paid handover that loses a race to something that is not its order is a conflict, never an on-site order', async (t) => {
  const { env, c, alerts } = world(t);
  const payment = await paid(env, c, OFTERSHEIM);
  const prepare = env.DB.prepare.bind(env.DB);
  let inserts = 0;
  // The insert collides (as if another row took the reference or the payment),
  // and no order that is this one can be found afterwards.
  env.DB.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!/INSERT INTO orders/.test(sql)) return stmt;
    inserts++;
    if (inserts > 1) return stmt;
    return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: UNIQUE constraint failed: orders.payment_id'); } }) };
  };
  const res = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: payment.id });
  env.DB.prepare = prepare;
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'payment_conflict');
  assert.equal(inserts, 1, 'not stored a second time under another payment method');
  assert.equal(rows(env, 'orders').length, 0);
  assert.match(alerts().at(-1), /^ZAHLUNG PRÜFEN/);
});

test('a paid order handed over while the restaurant is closed is still recorded; nothing new is', async (t) => {
  const { env, c } = world(t);
  const payment = await paid(env, c, OFTERSHEIM);
  await closeOrdering(env, { reason: 'demand', minutes: 60 });

  const cash = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM });
  assert.equal(cash.body.error.code, 'ordering_closed');
  const claim = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: 'made-up' });
  assert.equal(claim.body.error.code, 'ordering_closed', 'a made-up payment id admits nothing');

  const handed = await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: payment.id });
  assert.equal(handed.body.reference, payment.reference);
  assert.equal(rows(env, 'orders').length, 1);
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

/* --- retention (DP-21-04) --------------------------------------------------- */

test('the retention sweep keeps the postcode and town, removes the person, and a replay brings nothing back', async (t) => {
  const { env, c } = world(t);
  const payment = await paid(env, c, OFTERSHEIM);
  await call(env, c, '/api/orders/announce', { ...GUEST, ...OFTERSHEIM, paymentId: payment.id });
  env.DB._raw.prepare("UPDATE orders SET created_at = datetime('now', '-4 years')").run();
  await scrubExpiredIdentities(env);
  let [order] = rows(env, 'orders');
  assert.deepEqual([order.customer_name, order.customer_phone, order.customer_address],
                   [null, null, null]);
  assert.deepEqual([order.postcode, order.town], ['68723', 'Oftersheim']);
  assert.ok(order.details_purged_at);

  await call(env, c, '/api/orders/announce',
    { ...GUEST, ...OFTERSHEIM, address: 'Neue Straße 9', paymentId: payment.id });
  [order] = rows(env, 'orders');
  assert.equal(order.customer_address, null, 'never restored');
  assert.equal(rows(env, 'orders').length, 1);
});

/* --- the schema upgrade (0007) on rows written before it --------------------- */

test('0007 adds the town to a database with orders and payments in it, and changes nothing else', () => {
  const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  for (const name of files.filter((n) => n < '0007')) db.exec(readFileSync(dir + name, 'utf8'));
  db.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status, amount, currency,
       subtotal, discount, fee, order_type, business, postcode, lines, created_at, updated_at)
     VALUES ('p1', 'K-1', 'paypal', 'PP-1', 'captured', 4770, 'EUR', 5300, 530, 0, 'delivery', 0,
             '68799 Reilingen', '[]', datetime('now'), datetime('now'))`).run();
  db.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, business, pay_method, postcode, lines,
       subtotal, discount, fee, total, currency, order_identity, created_at)
     VALUES ('o1', 'K-1', 'p1', 'delivery', 0, 'online', '68799 Reilingen', '[]', 5300, 530, 0, 4770,
             'EUR', 'identity-1', datetime('now'))`).run();
  const before = [db.prepare('SELECT * FROM payments').get(), db.prepare('SELECT * FROM orders').get()];

  for (const name of files.filter((n) => n >= '0007' && n < '0008')) db.exec(readFileSync(dir + name, 'utf8'));
  const after = [db.prepare('SELECT * FROM payments').get(), db.prepare('SELECT * FROM orders').get()];
  for (const [i, row] of after.entries()) {
    assert.equal(row.town, null);
    const { town, ...rest } = row;
    assert.deepEqual(rest, { ...before[i] }, 'every other value as it was');
  }
  // The one-payment-one-order index survives the upgrade.
  assert.throws(() => db.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, pay_method, lines, subtotal, total, created_at)
     VALUES ('o2', 'K-2', 'p1', 'pickup', 'online', '[]', 0, 0, 'now')`).run(), /UNIQUE/);
});

test('0008 adds the capture count to a database with payments in it: 0 for every row, nothing else changed', () => {
  const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  for (const name of files.filter((n) => n < '0008')) db.exec(readFileSync(dir + name, 'utf8'));
  db.prepare(`INSERT INTO payments (id, reference, provider, status, amount, currency, subtotal, discount, fee,
                order_type, business, lines, created_at, updated_at)
              VALUES ('p1', 'K-1', 'paypal', 'approved', 100, 'EUR', 100, 0, 0, 'pickup', 0, '[]', 'now', 'now')`).run();
  const before = db.prepare('SELECT * FROM payments').get();
  for (const name of files.filter((n) => n >= '0008' && n < '0009')) db.exec(readFileSync(dir + name, 'utf8'));
  const after = db.prepare('SELECT * FROM payments').get();
  const { captures_in_flight: count, ...rest } = after;
  assert.equal(count, 0);
  assert.deepEqual(rest, { ...before });
});
