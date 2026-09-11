/* Someone trying to take money, break the books, or make the restaurant work
   for free.
   ---------------------------------------------------------------------------
   The other suites ask "does it work". This one asks "what can a hostile
   person do with it". Every test here is an attack that would cost the
   restaurant money, food, or its licence to take payments if it succeeded.

   Written after three real bugs shipped past a green suite: a fake more
   capable than the SDK, a message that only broke in transit, and a capture
   believed on the strength of the wrong field. The lesson taken is that tests
   which only assert the happy path assert almost nothing. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.js';
import {
  workerEnv, fakePayPal, orderResponse, webhookEvent, webhookHeaders
} from '../helpers/env.js';
// The week config.js ships with, read rather than retyped: with no settings row
// saved, that is exactly what /api/status hands back. Spelling it out here made
// this test fail the day Wednesday's real opening was corrected, which is the
// bug this file exists to catch, asserted against the wrong thing.
import { CONFIG } from '../../worker/site-data.js';

const MENU = {
  hummus: { price: 950, name: 'Hummus' },
  koshari: { price: 1450, name: 'Koshari' }
};
const BASKET = { items: { koshari: 2 }, type: 'pickup', business: false, method: 'paypal' };
const TOTAL = 2610;

const ctx = () => {
  const p = [];
  return { waitUntil: (x) => p.push(x), settled: () => Promise.all(p) };
};

const post = (path, body, headers = {}) => new Request('https://kairo1980.de' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const get = (path, headers = {}) => new Request('https://kairo1980.de' + path, { headers });

/* --- paying less than the food costs ------------------------------------- */

test('no field in the request can change the price', async (t) => {
  const env = workerEnv(MENU);
  let sentToPayPal = null;
  const paypal = fakePayPal({
    '/v2/checkout/orders': ({ body }) => { sentToPayPal = body; return orderResponse({}); }
  });
  t.after(() => paypal.restore());

  // Every shape a tamperer might try, in one basket.
  const tampered = {
    ...BASKET,
    amount: 1, total: 1, subtotal: 1, price: 1, value: 1,
    discount: 100000, discountPercent: 99, fee: -5000,
    currency: 'VND', lines: [{ id: 'koshari', qty: 2, unit: 1, amount: 2 }],
    quote: { total: 1 }, breakdown: { subtotal: 1 }
  };

  const res = await worker.fetch(post('/api/payments', tampered), env, ctx());
  const payment = await res.json();

  assert.equal(payment.amount, TOTAL, 'the server priced it, not the request');
  assert.equal(sentToPayPal.purchase_units[0].amount.value, '26.10');
  assert.equal(sentToPayPal.purchase_units[0].amount.currency_code, 'EUR', 'currency is ours to choose');
});

test('quantities cannot be negative, fractional, or a credit', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  // A negative line would subtract from the total if it were honoured.
  const res = await worker.fetch(post('/api/payments', {
    ...BASKET, items: { koshari: 2, hummus: -10 }
  }), env, ctx());
  const payment = await res.json();
  assert.equal(payment.amount, TOTAL, 'the negative line is ignored, not subtracted');

  for (const qty of [0.5, -1, 0, '2; DROP TABLE payments', Infinity, NaN, null]) {
    const r = await worker.fetch(post('/api/payments', { ...BASKET, items: { koshari: qty } }), env, ctx());
    assert.ok(r.status >= 400, `quantity ${String(qty)} must not create a payment`);
  }
});

test('a basket cannot be inflated into a denial of service', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const huge = {};
  for (let i = 0; i < 5000; i++) huge['item-' + i] = 1;
  const res = await worker.fetch(post('/api/payments', { ...BASKET, items: huge }), env, ctx());
  assert.ok(res.status >= 400, 'refused before anything expensive happens');
});

/* --- interfering with somebody else's payment ---------------------------- */

test('a payment id is the only key, and it is not guessable', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const a = await (await worker.fetch(post('/api/payments', BASKET), env, ctx())).json();
  const b = await (await worker.fetch(post('/api/payments', BASKET), env, ctx())).json();

  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'a v4 uuid, not a counter somebody can walk');
  assert.notEqual(a.reference, b.reference);
});

test('sequential and malformed ids find nothing', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  for (const id of ['1', '00000000-0000-0000-0000-000000000001', '../../etc/passwd',
                    "' OR 1=1 --", '%2e%2e%2f', 'null', 'undefined']) {
    const res = await worker.fetch(get('/api/payments/' + encodeURIComponent(id)), env, ctx());
    assert.ok(res.status === 404 || res.status === 400, `${id} must not resolve`);
  }
});

test('what a payment discloses is only what its own payer needs', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-1' }),
    '/v2/checkout/orders/PP-1/capture': () => orderResponse({
      id: 'PP-1', status: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'COMPLETED',
      amount: TOTAL, paymentId: payment.id, reference: payment.reference
    })
  });
  t.after(() => paypal.restore());

  payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const body = await (await worker.fetch(get(`/api/payments/${payment.id}`), env, c)).json();
  const text = JSON.stringify(body);

  // The provider's account holder is nobody else's business.
  assert.ok(!text.includes('guest@example.com'), 'no payer email');
  assert.ok(!text.includes('PAYER1'), 'no payer id');
  assert.ok(!text.includes('CAP-1'), 'no capture id');
  assert.ok(!/hummus|koshari/i.test(text), 'no basket contents');
});

/* --- forged and replayed provider events --------------------------------- */

test('an unsigned webhook cannot settle a payment', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'FAILURE' })
  });
  t.after(() => paypal.restore());

  const payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();

  // Exactly the event PayPal would send on success — but not signed by PayPal.
  const forged = webhookEvent({
    id: 'FORGED-1', paymentId: payment.id, reference: payment.reference,
    amount: TOTAL, orderId: 'PP-1'
  });
  const res = await worker.fetch(post('/api/webhooks/paypal', forged, webhookHeaders()), env, c);
  await c.settled();

  assert.equal(res.status, 400);
  const row = await env.DB.prepare('SELECT status FROM payments WHERE id = ?1').bind(payment.id).first();
  assert.equal(row.status, 'created', 'a forged event moves nothing');
});

test('the webhook cannot be verified against a certificate of the attacker\'s choosing', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({ '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }) });
  t.after(() => paypal.restore());

  const headers = { ...webhookHeaders(), 'paypal-cert-url': 'https://evil.example.com/cert.pem' };
  const res = await worker.fetch(post('/api/webhooks/paypal', webhookEvent({}), headers), env, ctx());
  assert.equal(res.status, 400, 'only PayPal\'s own certificate host is acceptable');
});

test('a webhook cannot be used to overpay or underpay the books', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-1' }),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' })
  });
  t.after(() => paypal.restore());

  const payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();

  // A genuine, signed event — reporting an amount that is not what was owed.
  const wrong = webhookEvent({
    id: 'WH-WRONG', paymentId: payment.id, reference: payment.reference,
    amount: 1, orderId: 'PP-1'
  });
  await worker.fetch(post('/api/webhooks/paypal', wrong, webhookHeaders()), env, c);
  await c.settled();

  const row = await env.DB.prepare('SELECT status, failure_code FROM payments WHERE id = ?1')
    .bind(payment.id).first();
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, 'amount_mismatch', 'never silently accepted');
});

/* --- the books ------------------------------------------------------------ */

test('the settlement report cannot be read without the token, or with a near miss', async (t) => {
  const env = workerEnv(MENU, { REPORT_TOKEN: 'correct-horse-battery-staple' });
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const attempts = [
    undefined,
    'Bearer ',
    'Bearer correct-horse-battery-stapl',    // one short
    'Bearer correct-horse-battery-staplex',  // one long
    'Bearer CORRECT-HORSE-BATTERY-STAPLE',   // case
    'correct-horse-battery-staple'           // no scheme
  ];
  for (const authorization of attempts) {
    const res = await worker.fetch(
      get('/api/reports/settlement', authorization ? { authorization } : {}), env, ctx());
    assert.equal(res.status, 401, `must reject: ${authorization}`);
  }

  const ok = await worker.fetch(get('/api/reports/settlement', {
    authorization: 'Bearer correct-horse-battery-staple'
  }), env, ctx());
  assert.equal(ok.status, 200);
});

test('money held for review is never counted as revenue', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  let payment;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-1' }),
    '/v2/checkout/orders/PP-1/capture': () => {
      const o = orderResponse({
        id: 'PP-1', status: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'PENDING',
        amount: TOTAL, paymentId: payment.id, reference: payment.reference
      });
      o.purchase_units[0].payments.captures[0].status_details = { reason: 'PENDING_REVIEW' };
      return o;
    }
  });
  t.after(() => paypal.restore());

  payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const settled = await env.DB.prepare('SELECT * FROM payments_settled').all();
  assert.equal(settled.results.length, 0);
});

/* --- the admin area -------------------------------------------------------
   The one door in the whole site that a person walks through. Everything else
   here defends money; this defends the switch that turns the shop off. */

const CREDS = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };

const form = (path, fields, headers = {}) => new Request('https://kairo1980.de' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString()
});

/** Sign in and return the session cookie, as a browser would hold it. */
async function signIn(env, fields = { username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD }) {
  const res = await worker.fetch(form('/admin/login', fields), env, ctx());
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, cookie: setCookie.split(';')[0] };
}

test('the admin area is closed to every wrong username and every wrong password', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const wrong = [
    {},
    { username: '', password: '' },
    { username: 'sherif', password: 'wrong' },
    { username: 'sherif', password: 'correct-horse-battery-stapl' },   // one short
    { username: 'sherif', password: 'correct-horse-battery-staplex' }, // one long
    { username: 'sherif', password: 'CORRECT-HORSE-BATTERY-STAPLE' },  // case
    // The password alone is not enough — this is the bug being fixed. The page
    // this replaces ignored the username entirely.
    { username: 'admin', password: 'correct-horse-battery-staple' },
    { username: '', password: 'correct-horse-battery-staple' },
    { username: 'sherif', password: '' }
  ];

  for (const fields of wrong) {
    const { res, cookie } = await signIn(env, fields);
    assert.equal(res.status, 401, JSON.stringify(fields));
    assert.equal(cookie, '', 'no session may be issued');
    const body = await res.text();
    assert.ok(body.includes('Wrong username or password'), 'says no, without saying which half');
    assert.ok(!body.includes('Paid orders') || body.includes('form'),
      'never renders what is behind the door');
  }

  const right = await signIn(env);
  assert.equal(right.res.status, 303);
  assert.ok(right.cookie.startsWith('kairo_session='));
});

test('no session, no page — and a forged cookie is not a session', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const payload = cookie.split('=')[1].split('.')[0];

  const forgeries = [
    null,
    'kairo_session=',
    'kairo_session=nonsense',
    'kairo_session=' + payload,                       // payload, no signature
    'kairo_session=' + payload + '.badsignature',     // wrong signature
    // A far-future expiry the holder wrote themselves. Unsigned, so worthless.
    'kairo_session=' + btoa(JSON.stringify({ exp: 9999999999 })).replace(/=+$/, '') + '.x'
  ];

  for (const value of forgeries) {
    for (const path of ['/admin', '/admin/orders']) {
      const res = await worker.fetch(get(path, value ? { cookie: value } : {}), env, ctx());
      const body = await res.text();
      assert.ok(body.includes('name="password"'), `${path} must show the login form: ${value}`);
      assert.ok(!body.includes('Paid orders'), 'and nothing behind it');
    }
  }
});

test('a session dies when the password changes, with nothing to clean up', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const before = await worker.fetch(get('/admin', { cookie }), env, ctx());
  // Any dashboard content proves the session; "Opening hours" is the one label
  // that is not going to be reworded next time the page is.
  assert.ok((await before.text()).includes('Opening hours'), 'signed in');

  // The signing key is derived from the credentials, so changing either one
  // invalidates every cookie ever issued — a phone lost on Friday is logged
  // out by changing the password, and no session store has to be swept.
  const rotated = { ...env, ADMIN_PASSWORD: 'a-brand-new-password' };
  const after = await worker.fetch(get('/admin', { cookie }), rotated, ctx());
  assert.ok((await after.text()).includes('name="password"'), 'logged out everywhere');
});

test('with no credentials configured the admin area opens for nobody', async (t) => {
  const env = workerEnv(MENU);              // no ADMIN_USER, no ADMIN_PASSWORD
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(get('/admin'), env, ctx());
  const body = await res.text();
  assert.ok(body.includes('not set up yet'), 'says so plainly');
  assert.ok(!body.includes('name="password"'), 'and offers nothing to guess at');

  // An unconfigured lock is not an unlocked door.
  const { res: attempt, cookie } = await signIn(env, { username: '', password: '' });
  assert.equal(attempt.status, 401);
  assert.equal(cookie, '');
});

test('logging out ends the session', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const out = await worker.fetch(form('/admin/logout', {}, { cookie }), env, ctx());
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('the session cookie cannot be read by script, or sent by another site', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(form('/admin/login', {
    username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD
  }), env, ctx());
  const setCookie = res.headers.get('set-cookie') || '';

  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/, 'https, so the cookie must say so');
});

test('the admin area is never cached and never indexed', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  for (const path of ['/admin', '/admin/orders']) {
    const res = await worker.fetch(get(path, { cookie }), env, ctx());
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('cache-control') || '', /no-store/, path);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, path);
    // No script anywhere in here, and the policy says so rather than trusting it.
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/, path);
  }
});

test('signing in cannot be used to bounce a visitor off the site', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  // An open redirect on a login page is a phishing primitive: the victim sees
  // the real domain, signs in, and lands somewhere else entirely.
  for (const next of ['https://evil.example', '//evil.example', '/', '/../etc']) {
    const res = await worker.fetch(form('/admin/login', {
      username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD, next
    }), env, ctx());
    assert.equal(res.headers.get('location'), '/admin', `refused: ${next}`);
  }

  const inside = await worker.fetch(form('/admin/login', {
    username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD, next: '/admin/orders'
  }), env, ctx());
  assert.equal(inside.headers.get('location'), '/admin/orders', 'but a real one is honoured');
});

/* Order details now DO reach this server — but only through /api/orders/announce,
   and never from the payment provider. A payment on its own must still show no
   contact details and no provider identifiers, because none of those belong to
   us: PayPal's payer e-mail is not the guest's order, and a capture id is ours
   to keep, not to print. */
test('a payment alone shows no contact details and no provider identifiers', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  let payment;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-1' }),
    '/v2/checkout/orders/PP-1/capture': () => orderResponse({
      id: 'PP-1', status: 'COMPLETED', captureId: 'CAP-1', captureStatus: 'COMPLETED',
      amount: TOTAL, paymentId: payment.id, reference: payment.reference
    })
  });
  t.after(() => paypal.restore());

  payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();

  assert.ok(html.includes(payment.reference), 'the reference is the whole point');
  // Contact details never reached this server and must not appear.
  assert.ok(!html.includes('guest@example.com'));
  assert.ok(!html.includes('PAYER1'));
  assert.ok(!html.includes('CAP-1'), 'no provider identifiers');
});

/* --- the shape of the API itself ----------------------------------------- */

test('endpoints refuse the wrong method rather than doing something surprising', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const wrong = [
    ['GET', '/api/payments'],
    ['GET', '/api/webhooks/paypal'],
    ['POST', '/api/payments/config'],
    ['DELETE', '/api/payments'],
    ['PUT', '/api/reports/settlement']
  ];
  for (const [method, path] of wrong) {
    const res = await worker.fetch(new Request('https://kairo1980.de' + path, { method }), env, ctx());
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test('an unknown provider name cannot be routed to', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  for (const name of ['evil', 'paypal2', '../paypal', 'stripe']) {
    const res = await worker.fetch(post('/api/webhooks/' + name, {}, webhookHeaders()), env, ctx());
    assert.equal(res.status, 404, name);
  }
});

test('api responses are never cached, anywhere', async (t) => {
  const env = workerEnv(MENU);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  // A cached payment status is a guest being shown somebody else's order.
  for (const path of ['/api/payments/config', '/api/payments/nope-nope-nope']) {
    const res = await worker.fetch(get(path), env, ctx());
    assert.match(res.headers.get('cache-control') || '', /no-store/, path);
  }
});

test('an error never hands the provider\'s words to the browser', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => ({
      status: 500,
      body: { name: 'INTERNAL', message: 'merchant 4XYZ credential invalid', debug_id: 'abc123' }
    })
  });
  t.after(() => paypal.restore());

  const res = await worker.fetch(post('/api/payments', BASKET), env, c);
  const text = await res.text();

  assert.ok(!text.includes('debug_id'), 'no provider diagnostics');
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('credential'));
  assert.ok(!text.includes('merchant 4XYZ'));
});

/* --- the switch and the hours ---------------------------------------------
   Two things the restaurant changes from its phone. One stops money moving;
   the other decides what the site tells Google. */

test('a closed shop refuses a payment, however the request is made', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  await worker.fetch(form('/admin/ordering', { open: '0', reason: 'demand' }, { cookie }), env, ctx());

  // A tab opened before the switch was thrown still has a live checkout in it.
  const res = await worker.fetch(post('/api/payments', BASKET), env, ctx());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'ordering_closed');

  /* But a closure withholds a MOMENT, not the order. An order scheduled for
     after we reopen is an ordinary order and must go through — that is the
     difference between pausing a kitchen and turning customers away. */
  const soon = await worker.fetch(post('/api/payments', {
    ...BASKET, when: { date: '2020-01-01', time: '12:00' }
  }), env, ctx());
  assert.equal(soon.status, 503, 'a moment in the past is not "after we reopen"');

  const later = await worker.fetch(post('/api/payments', {
    ...BASKET, when: { date: '2099-01-01', time: '19:00' }
  }), env, ctx());
  assert.equal(later.status, 201, 'scheduled past the closure, so it is taken');

  await worker.fetch(form('/admin/ordering', { open: '1' }, { cookie }), env, ctx());
  const after = await worker.fetch(post('/api/payments', BASKET), env, ctx());
  assert.equal(after.status, 201, 'and taking orders again the moment it is released');
});

test('a holiday refuses a payment too — COSTS MONEY', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);

  /* Announced for today, back in five days, and the ordering switch left
     alone — which is what the /admin holiday card does on its own, and what
     the restaurant did. The till went on taking orders for a shop with nobody
     in it, because these were two facts and the routes only asked one. */
  const from = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const until = new Date(Date.now() + 5 * 86400000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  await worker.fetch(form('/admin/holiday',
    { mode: 'set', from, until }, { cookie }), env, ctx());

  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.open, false, 'the page is told the truth');
  assert.equal(ordering.reason, 'holiday');

  const res = await worker.fetch(post('/api/payments', BASKET), env, ctx());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'ordering_closed');

  const announced = await worker.fetch(post('/api/orders/announce', {
    ...BASKET, reference: 'ABC123'
  }), env, ctx());
  assert.equal(announced.status, 503, 'and a cash order is not recorded either');

  /* But the day we are back is an ordinary order, and the most valuable one on
     the site that fortnight. A holiday withholds a MOMENT, not the order. */
  const back = await worker.fetch(post('/api/payments', {
    ...BASKET, when: { date: until, time: '19:00' }
  }), env, ctx());
  assert.equal(back.status, 201, 'ordering ahead for the evening we reopen');

  await worker.fetch(form('/admin/holiday', { mode: 'clear' }, { cookie }), env, ctx());
  const after = await worker.fetch(post('/api/payments', BASKET), env, ctx());
  assert.equal(after.status, 201, 'and the band coming down puts the till back');
});

test('closing always carries its own end, and the default is today', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  await worker.fetch(form('/admin/ordering', { open: '0' }, { cookie }), env, ctx());

  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.open, false);
  assert.equal(ordering.reason, null, 'no reason given is a valid choice');

  // The shop that stays shut because nobody came back to release it is the
  // failure this guards against.
  const resumes = Date.parse(ordering.resumesAt);
  assert.ok(resumes > Date.now(), 'in the future');
  assert.ok(resumes - Date.now() <= 24 * 3600 * 1000, 'and never more than a day away');
  assert.equal(ordering.namedEnd, false, 'because nobody named it');
});

test('a closure that has run its course is simply over', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  // Written straight to the row: this is the state a browser meets the morning
  // after somebody stopped the till at midnight. Nothing runs to release it.
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('ordering', ?1, datetime('now'))`
  ).bind(JSON.stringify({
    open: false, reason: 'demand', namedEnd: false,
    resumesAt: new Date(Date.now() - 60000).toISOString()
  })).run();

  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.open, true, 'expired by the clock, with nothing swept');
  assert.equal(ordering.resumesAt, null);
});

test('a date chosen for reopening survives, and is marked as chosen', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const iso = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
  await worker.fetch(form('/admin/ordering',
    { open: '0', reason: 'holiday', untilDate: iso }, { cookie }), env, ctx());

  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.reason, 'holiday');
  assert.equal(ordering.namedEnd, true, 'so the page says a date, not "later"');

  /* The date asked for, read back as a date in Hockenheim. Asserting on a
     duration instead would be a test that fails at some hours of the day and
     not others — the first version of this one did exactly that, because
     "nine days from 01:20 in the morning" and "the 14th at midnight" are not
     the same distance apart. The default is "tomorrow"; what matters is that
     it did not win. */
  const berlin = new Date(Date.parse(ordering.resumesAt))
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  assert.equal(berlin, iso, 'reopens on the day that was chosen');
});

test('an invented reason is not published as if it were one of ours', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  await worker.fetch(form('/admin/ordering',
    { open: '0', reason: '<script>alert(1)</script>' }, { cookie }), env, ctx());

  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.reason, null, 'falls back to the plain sentence');
});

test('saved hours are what the site publishes, in the markup itself', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const fields = { lunch_enabled: '1', mon_closed: '1', tue_closed: '1' };
  for (const day of ['wed', 'thu', 'fri', 'sat', 'sun']) {
    fields[`${day}_evening_from`] = '17:00';
    fields[`${day}_evening_to`] = '22:00';
  }
  const saved = await worker.fetch(form('/admin/hours', fields, { cookie }), env, ctx());
  assert.equal(saved.status, 303);

  const { hours } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  // Only the evening box was filled, so it normalises into the day's first
  // window — one window is stored one way, whichever box it was typed into.
  assert.deepEqual(hours.days.wed.lunch, ['17:00', '22:00']);
  assert.equal(hours.days.wed.evening, null);
  assert.equal(hours.days.mon.closed, true);

  /* The point of the whole exercise: a crawler that runs no JavaScript has to
     read the hours the restaurant actually keeps. Applebot and Bingbot feed
     the Apple Maps and Bing place cards, and neither renders reliably. */
  const html = await (await worker.fetch(get('/'), env, ctx())).text();
  assert.ok(html.includes('"opens":"17:00"') || html.includes('"opens": "17:00"'),
    'the structured data carries the saved hours');
  assert.ok(!html.includes('"opens":"18:00"'), 'and not the ones config.js shipped with');
  assert.ok(html.includes('id="kairoLive"'), 'and the browser gets them without a fetch');
});

test('half-understood hours are refused rather than half-saved', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const bad = { wed_evening_from: '18:00', wed_evening_to: '09:00' };  // ends before it starts
  const res = await worker.fetch(form('/admin/hours', bad, { cookie }), env, ctx());
  assert.match(res.headers.get('location') || '', /failed/);

  const { hours, } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.deepEqual(hours.days.wed.lunch, CONFIG.hours.days.wed.lunch,
    'the old hours still stand');
  assert.equal(hours.days.wed.evening, CONFIG.hours.days.wed.evening,
    'and nothing was half-written');
});

test('the hours page and the switch are behind the login like everything else', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const page = await worker.fetch(get('/admin/hours'), env, ctx());
  assert.ok((await page.text()).includes('name="password"'));

  // And a POST from a stranger changes nothing.
  await worker.fetch(form('/admin/ordering', { open: '0' }), env, ctx());
  const { ordering } = await (await worker.fetch(get('/api/status'), env, ctx())).json();
  assert.equal(ordering.open, true, 'still taking orders');
});

/* The rewrite in worker/page-render.js finds its three targets by marker: the
   `restaurantSchema` id, the hours:start/end comment pair, and `</head>`. Every
   other test here proves the rewrite works against a stub that has them. This
   one proves the published files still do — the one way the whole mechanism
   can fail silently, in production, with a green suite. */
test('the published pages still carry the markers the rewrite needs', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

  assert.match(index, /<script id="restaurantSchema"/, 'the JSON-LD block');
  assert.match(index, /<!--hours:start-->[\s\S]*<!--hours:end-->/, 'the hours fallback');
  assert.ok(index.includes('</head>'), 'somewhere to put the data island');

  // Both live pages go through the Worker, or one of them publishes whatever
  // config.js said on the day it shipped.
  const wrangler = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
  for (const path of ['"/"', '"/firmencatering"']) {
    assert.ok(wrangler.includes(path), `run_worker_first must name ${path}`);
  }
});

test('a page is not re-sent when nothing it says has changed, and is when it has', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const first = await worker.fetch(get('/'), env, ctx());
  const etag = first.headers.get('etag');
  assert.ok(etag, 'the page is taggable');

  const again = await worker.fetch(get('/', { 'if-none-match': etag }), env, ctx());
  assert.equal(again.status, 304, 'unchanged, so not re-sent');

  // Now change what the page SAYS without changing the file behind it. The
  // asset's own ETag cannot notice this; that is the whole reason ours exists.
  const { cookie } = await signIn(env);
  await worker.fetch(form('/admin/ordering', { open: '0', reason: 'demand' }, { cookie }), env, ctx());

  const after = await worker.fetch(get('/', { 'if-none-match': etag }), env, ctx());
  assert.equal(after.status, 200, 'changed, so sent in full');
  const html = await after.text();
  assert.match(html, /<html[^>]*data-ordering="off"/, 'and says so before any script runs');
});

test('guessing is throttled, and the throttle says nothing new to the guesser', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const from = { 'cf-connecting-ip': '203.0.113.9' };
  const guess = (fields, headers = from) =>
    worker.fetch(form('/admin/login', fields, headers), env, ctx());

  for (let i = 0; i < 8; i++) {
    const res = await guess({ username: CREDS.ADMIN_USER, password: `try-${i}` });
    assert.equal(res.status, 401);
  }

  // Locked now — and the right password is refused too, which is the point.
  const locked = await guess({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD });
  assert.equal(locked.status, 401);
  assert.equal(locked.headers.get('set-cookie'), null, 'no session while locked out');
  // Same page, same words: a guesser must not learn that a lockout exists.
  assert.ok((await locked.text()).includes('Wrong username or password'));

  // Somebody else's connection is unaffected — a lockout must never become a
  // way for a stranger to shut the restaurant out of its own switch.
  const elsewhere = await guess(
    { username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD },
    { 'cf-connecting-ip': '198.51.100.4' });
  assert.equal(elsewhere.status, 303, 'a different address still gets in');
});

test('a one-tap closure lasts the minutes it says, and no slip can extend it', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const close = (fields) =>
    worker.fetch(form('/admin/ordering', { open: '0', ...fields }, { cookie }), env, ctx());
  const read = async () =>
    (await (await worker.fetch(get('/api/status'), env, ctx())).json()).ordering;

  await close({ minutes: '60' });
  let now = await read();
  assert.equal(now.open, false);
  assert.equal(now.namedEnd, true, 'a chosen length is a named end');
  const hour = Date.parse(now.resumesAt) - Date.now();
  assert.ok(hour > 55 * 60000 && hour < 65 * 60000, `about an hour, got ${hour}ms`);

  await close({ minutes: '30' });
  const half = Date.parse((await read()).resumesAt) - Date.now();
  assert.ok(half > 25 * 60000 && half < 35 * 60000, 'and thirty minutes is thirty');

  /* A fat finger on a number field must not be able to shut the restaurant
     until Christmas. Anything past a week is clamped to a week. */
  await close({ minutes: '999999999' });
  const capped = Date.parse((await read()).resumesAt) - Date.now();
  assert.ok(capped <= 7 * 24 * 60 * 60000 + 60000, 'never more than a week');

  // Nonsense falls back to the default, which is the end of today.
  for (const minutes of ['', 'soon', '-90', 'NaN']) {
    await close({ minutes });
    const fallback = Date.parse((await read()).resumesAt) - Date.now();
    assert.ok(fallback > 0 && fallback <= 24 * 60 * 60000,
      `"${minutes}" falls back to today, got ${fallback}ms`);
  }
});

test('the dashboard says what the hours say, not only what the switch says', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);

  // Every day closed: the switch is on, but the shop is not open.
  const shut = { lunch_enabled: '1' };
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) shut[`${day}_closed`] = '1';
  await worker.fetch(form('/admin/hours', shut, { cookie }), env, ctx());

  const page = await (await worker.fetch(get('/admin', { cookie }), env, ctx())).text();
  assert.ok(page.includes('Taking orders'), 'the switch is on');
  assert.ok(page.includes('Closed today'), 'and the hours say otherwise, in the same card');
});

test('the kitchen page shows the name, the phone number and the address', async (t) => {
  /* The complaint that produced the orders table: "how will I know the customer
     details for deliveries if I cannot see his phone number even to call him".
     These four fields exist on this server for exactly one reason, and this is
     the only page allowed to show them. */
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { reference } = await (await worker.fetch(post('/api/orders/announce', {
    items: { koshari: 2 }, type: 'delivery', postcode: '68766',
    time: 'Heute 19:30', name: 'Sherif Esmat', phone: '+49 176 79906621',
    address: 'Hauptstrasse 12', notes: 'Bitte 2x klingeln'
  }), env, c)).json();

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();

  assert.ok(html.includes(reference), 'the code the guest will quote');
  assert.ok(html.includes('Sherif Esmat'), 'the name');
  assert.ok(html.includes('+49 176 79906621'), 'the number as typed');
  assert.ok(html.includes('tel:+4917679906621'), 'and dialable in one tap');
  assert.ok(html.includes('Hauptstrasse 12'), 'the address');
  assert.ok(html.includes('Bitte 2x klingeln'), 'and the note');
  assert.ok(html.includes('PAY ON ARRIVAL'), 'marked as still to be paid');
});

test('order details are behind the login like everything else', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  await worker.fetch(post('/api/orders/announce', {
    items: { koshari: 1 }, type: 'pickup', name: 'Sherif Esmat',
    phone: '+49 176 79906621'
  }), env, c);

  /* No session gets the login form itself, not a redirect — a redirect would
     leak which page was being asked for. What matters here is that the refusal
     carries nothing: the form is the whole response. */
  const res = await worker.fetch(get('/admin/orders'), env, c);
  const html = await res.text();
  assert.match(html, /name="password"/, 'the login form, not the orders');
  assert.equal(html.includes('Sherif Esmat'), false, 'and no name leaks with it');
  assert.equal(html.includes('79906621'), false, 'nor a telephone number');
});

test('a payment that was started and never settled is on the page, not only in the database', async (t) => {
  /* The call this exists for. On 26 August 2026 a guest reached the PayPal
     window for a 26,10 € delivery, never approved it, and rang the next day to
     ask whether she had paid. The row was in D1 the whole time, at `created` —
     and on no screen, because the orphan list, the payments_settled view and
     the settlement report all filter on `captured_at IS NOT NULL`. Answering
     her took SQL against production. */
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' })
  });
  t.after(() => paypal.restore());

  // Created, and then nothing: no approval, no capture, no webhook.
  const payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();

  assert.ok(html.includes('Started, never finished'), 'the section is there');
  assert.ok(html.includes(payment.reference), 'and the code she will quote on the telephone');
  assert.ok(html.includes('NEVER APPROVED'), 'said as the state it actually stopped in');
  assert.ok(html.includes('Nothing was charged'), 'and answering the only question she asked');
  assert.ok(html.includes('26,10'), 'for the amount she was looking at');
  assert.ok(html.includes('2× Koshari'), 'with the basket, which is how you recognise her order');

  /* It must not have become an order. Nobody is owed this food, and a payment
     that never completed appearing in the queue would put it on the hob. */
  assert.ok(html.includes('No orders through the website yet today.'),
    'the queue is still empty');
});

test('a payment that settled is not reported as unfinished', async (t) => {
  /* The complement, asserted rather than assumed: the section is defined as
     "no captured_at", so money that arrived must fall out of it entirely. */
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  let payment;
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': () => orderResponse({
      id: 'PP-ORDER-1', status: 'COMPLETED', captureId: 'CAP-1',
      captureStatus: 'COMPLETED', amount: TOTAL,
      paymentId: payment.id, reference: payment.reference
    })
  });
  t.after(() => paypal.restore());

  payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();
  await worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();

  assert.equal(html.includes('Started, never finished'), false,
    'captured money is trade, not an unfinished payment');
  assert.equal(html.includes('NEVER APPROVED'), false);
});

test('an order whose payment never completed is not shown to the kitchen as paid', async (t) => {
  /* PAID ONLINE is the one label on this page that may never be wrong: it is
     what tells the counter to hand food over without taking money. The order
     row records how the guest MEANT to pay; only the payment records what the
     money did, and the join answering that had been on the query, unread,
     since the page was written. */
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' })
  });
  t.after(() => paypal.restore());

  const payment = await (await worker.fetch(post('/api/payments', BASKET), env, c)).json();
  // The guest sends the order anyway, naming the payment that never completed.
  await worker.fetch(post('/api/orders/announce', {
    items: { koshari: 2 }, type: 'pickup', name: 'Sherif Esmat',
    phone: '+49 176 79906621', paymentId: payment.id
  }), env, c);

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();

  assert.ok(html.includes('Sherif Esmat'), 'the order is in the queue, because it is real');
  assert.ok(html.includes('PAYMENT NOT COMPLETED'), 'but the money is not claimed to be in');
  assert.equal(html.includes('PAID ONLINE'), false, 'and it is never called paid');

  // Listed once as a payment too, and not reported as a guest who vanished.
  assert.ok(html.includes('Started, never finished'));
  assert.equal(html.includes('The guest never sent the order either'), false,
    'she did send it — only the payment is unfinished');
});

test('the alert channel can be tested from the admin, and says why it failed', async (t) => {
  /* The bug this exists for: a real paid order arrived, the alert was sent,
     Telegram refused it, and the only trace was a console line nobody reads —
     so the restaurant learned of the failure from the customer. A channel that
     can fail invisibly is worse than none, because it is trusted. */
  const env = workerEnv(MENU, {
    ...CREDS, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242'
  });
  const c = ctx();
  const paypal = fakePayPal({
    '/botbot-token/sendMessage': () =>
      ({ status: 401, body: { ok: false, description: 'Unauthorized' } })
  });
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const res = await worker.fetch(
    new Request('https://kairo1980.de/admin/test-alert', { method: 'POST', headers: { cookie } }),
    env, c);

  assert.equal(res.status, 303);
  const to = res.headers.get('location') || '';
  assert.match(to, /alert=fail/, 'a refusal is reported as one');
  assert.match(decodeURIComponent(to), /Unauthorized/, "in Telegram's own words");

  // And the reason reaches the page, rather than a shrug.
  const html = await (await worker.fetch(get('/admin' + to.slice(to.indexOf('?')), { cookie }), env, c)).text();
  assert.ok(html.includes('Unauthorized'), 'printed where it will be read');
  assert.ok(html.includes('bot token is wrong'), 'with what to do about it');
});

test('a working alert channel reports success', async (t) => {
  const env = workerEnv(MENU, {
    ...CREDS, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242'
  });
  const c = ctx();
  const paypal = fakePayPal({ '/botbot-token/sendMessage': () => ({ ok: true }) });
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const res = await worker.fetch(
    new Request('https://kairo1980.de/admin/test-alert', { method: 'POST', headers: { cookie } }),
    env, c);
  assert.match(res.headers.get('location') || '', /alert=ok/);
});

test('an unconfigured alert channel says so instead of pretending', async (t) => {
  const env = workerEnv(MENU, CREDS);          // no TELEGRAM_* at all
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const res = await worker.fetch(
    new Request('https://kairo1980.de/admin/test-alert', { method: 'POST', headers: { cookie } }),
    env, c);
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /not set/);
});

/* --- what the month says was taken ---------------------------------------
   These figures go in the books, so the thing worth asserting is not that a
   page renders but that money which never arrived is not counted as revenue. */

async function orderRow(env, { ref, total, pay = 'onsite', type = 'delivery',
                               paymentId = null, day = null }) {
  await env.DB.prepare(
    `INSERT INTO orders (id, reference, payment_id, order_type, business, pay_method,
       postcode, lines, subtotal, discount, fee, total, requested_time, customer_name,
       created_at)
     VALUES (?1,?2,?3,?4,0,?5,'68766','[{"qty":1,"name":"Hummus"}]',?6,0,0,?6,'now','Gast',
             COALESCE(?7, datetime('now')))`
  ).bind(crypto.randomUUID(), ref, paymentId, type, pay, total, day).run();
}

test('the month counts cash and card together, and nothing that did not arrive', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const month = today.slice(0, 7);

  // Two cash orders: counted at their own total.
  await orderRow(env, { ref: 'CASH-1', total: 1000 });
  await orderRow(env, { ref: 'CASH-2', total: 2000, type: 'pickup' });

  // A settled online order, refunded in part: counted net.
  const captured = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO payments (id, reference, provider, status, amount, currency, subtotal,
       order_type, lines, refunded_amount, created_at, updated_at, captured_at)
     VALUES (?1,'PAID-1','paypal','captured',5000,'EUR',5000,'delivery','[]',500,
             datetime('now'), datetime('now'), datetime('now'))`
  ).bind(captured).run();
  await orderRow(env, { ref: 'PAID-1', total: 5000, pay: 'online', paymentId: captured });

  // An abandoned checkout: an order row exists, the money never arrived.
  const abandoned = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO payments (id, reference, provider, status, amount, currency, subtotal,
       order_type, lines, created_at, updated_at)
     VALUES (?1,'DEAD-1','paypal','created',9900,'EUR',9900,'delivery','[]',
             datetime('now'), datetime('now'))`
  ).bind(abandoned).run();
  await orderRow(env, { ref: 'DEAD-1', total: 9900, pay: 'online', paymentId: abandoned });

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(
    get(`/admin/sales?month=${month}`, { cookie }), env, c)).text();

  // 10,00 + 20,00 cash + (50,00 - 5,00) online = 75,00. The 99,00 never came.
  assert.ok(html.includes('75,00 €'), 'cash and settled card, net of refunds');
  assert.equal(html.includes('174,00'), false, 'the abandoned basket is not revenue');
  assert.match(html, /not counted/, 'and it is said out loud rather than hidden');
  assert.ok(html.includes('99,00 €'), 'with the value that is being left out');
});

test('a month with nothing in it says so instead of showing a zero table', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const html = await (await worker.fetch(
    get('/admin/sales?month=2019-03', { cookie }), env, c)).text();
  assert.match(html, /No orders through the website in March 2019/);
});

test('a nonsense month falls back to this one rather than erroring', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  for (const bad of ['2026-13', 'yesterday', "' OR 1=1 --", '']) {
    const res = await worker.fetch(
      get('/admin/sales?month=' + encodeURIComponent(bad), { cookie }), env, c);
    assert.equal(res.status, 200, `"${bad}" must not break the page`);
  }
});

test('sales and orders are behind the login like everything else', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const html = await (await worker.fetch(get('/admin/sales'), env, c)).text();
  assert.match(html, /name="password"/, 'the login form, not the takings');
  assert.equal(html.includes('Taken this month'), false);
});

/* --- a dish the kitchen has run out of ------------------------------------
   The only refusal on this site. Everything else warns and lets the order
   through because the guest may be right; here the ingredient is not in the
   building and taking the money means ringing them back to say so. The browser
   dims it, and the browser is not to be trusted with the answer. */

const markSoldOut = (env, ids) => env.DB.prepare(
  `INSERT INTO settings (key, value, updated_at) VALUES ('soldout', ?1, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
).bind(JSON.stringify(Object.fromEntries(ids.map((id) => [id, new Date().toISOString()])))).run();

test('a sold-out dish cannot be paid for, however the request is dressed up', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  await markSoldOut(env, ['koshari']);

  const res = await worker.fetch(post('/api/payments', BASKET), env, c);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'sold_out');

  // Not merely refused — no payment may exist for it at all.
  const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM payments').first();
  assert.equal(rows.n, 0, 'nothing was created for a dish we cannot cook');
});

test('a sold-out dish poisons the whole basket rather than being dropped quietly', async (t) => {
  /* Silently pricing the rest would charge the guest for a different order
     than the one they placed, and they would find out at the door. */
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  await markSoldOut(env, ['hummus']);
  const res = await worker.fetch(post('/api/payments', {
    ...BASKET, items: { koshari: 1, hummus: 1 }
  }), env, c);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'sold_out');
});

test('a cash order for a sold-out dish is refused too', async (t) => {
  // The announce route prices with the same function, so it inherits the rule.
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  await markSoldOut(env, ['koshari']);
  const res = await worker.fetch(post('/api/orders/announce', {
    items: { koshari: 2 }, type: 'pickup', name: 'Gast', phone: '+49 176 1'
  }), env, c);
  assert.equal(res.status, 400);
});

test('putting a dish back makes it orderable again', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const paypal = fakePayPal({ '/v2/checkout/orders': () => orderResponse({}) });
  t.after(() => paypal.restore());

  await markSoldOut(env, ['koshari']);
  assert.equal((await worker.fetch(post('/api/payments', BASKET), env, c)).status, 400);

  await markSoldOut(env, []);
  const { forgetCache } = await import('../../worker/settings.js');
  forgetCache(env);
  assert.equal((await worker.fetch(post('/api/payments', BASKET), env, c)).status, 201);
});

test('the sold-out list reaches the page a crawler reads', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  await markSoldOut(env, ['hummus']);
  const { forgetCache } = await import('../../worker/settings.js');
  forgetCache(env);

  const html = await (await worker.fetch(get('/'), env, c)).text();
  assert.match(html, /data-item="hummus" data-soldout="1"/,
    'marked in the markup, not left to the script');
  assert.match(html, /"soldOut"/, 'and handed to the browser without a fetch');
});

test('marking a dish sold out is behind the login', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const res = await worker.fetch(new Request('https://kairo1980.de/admin/dishes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'soldout=koshari'
  }), env, c);
  const html = await res.text();
  assert.match(html, /name="password"/, 'no session, no menu changes');

  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='soldout'").first();
  assert.equal(row, null, 'and nothing was written');
});

test('an extension changes what can be ordered, never the published hours', async (t) => {
  /* The whole point of it being separate from the hours: openingHoursSpecification
     is what Google caches for the place card, and a Saturday that ran late is
     not a new Saturday. */
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  const { cookie } = await signIn(env);
  const res = await worker.fetch(form('/admin/extend', { minutes: '90' }, { cookie }), env, c);
  assert.equal(res.status, 303);

  const { forgetCache } = await import('../../worker/settings.js');
  forgetCache(env);

  const html = await (await worker.fetch(get('/'), env, c)).text();

  // The browser is told, so the badge and the basket agree.
  assert.match(html, /"extension"/, 'handed to the page without a fetch');
  assert.match(html, /"until"/);

  // The structured data is untouched: still the stub's fixed Wednesday window.
  const schema = JSON.parse(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]);
  for (const spec of schema.openingHoursSpecification) {
    assert.equal(spec.closes, '23:00', 'an extension never becomes an opening hour');
  }
});

test('an extension can be taken back before it lapses', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());
  const { forgetCache } = await import('../../worker/settings.js');

  const { cookie } = await signIn(env);
  await worker.fetch(form('/admin/extend', { minutes: '60' }, { cookie }), env, c);
  forgetCache(env);
  assert.ok((await (await worker.fetch(get('/api/status'), env, c)).json()).ordering);

  await worker.fetch(form('/admin/extend', { clear: '1' }, { cookie }), env, c);
  forgetCache(env);
  const html = await (await worker.fetch(get('/'), env, c)).text();
  assert.match(html, /"extension":null/, 'back to the fixed hours at once');
});

test('extending is behind the login', async (t) => {
  const env = workerEnv(MENU, CREDS);
  const c = ctx();
  const paypal = fakePayPal({});
  t.after(() => paypal.restore());

  await worker.fetch(form('/admin/extend', { minutes: '120' }), env, c);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='extension'").first();
  assert.equal(row, null, 'no session, no change to the hours');
});
