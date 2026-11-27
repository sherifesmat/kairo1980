/* What the provider says, not what this server last wrote (DELIVERY_PRICING
   DP-25-01).

   A page is told "no money" only when the provider established it: a decline
   it named, an order it voided, or one it still showed unapproved when the
   guest abandoned it, after which nothing here ever captures it. A lost answer,
   a 5xx, a timeout, a cancel racing a capture are NOT "no money", and money the
   provider reports later is recorded whatever label came before it.

   Every case runs the real routes against a PayPal fake that keeps its own
   state, so the provider's side (was a capture asked for? was it taken?) is
   asserted alongside the stored row. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../helpers/page-worker.js';
import { reconcileStuckPayments } from '../../worker/index.js';
import { workerEnv, fakePayPal, orderResponse, webhookEvent, webhookHeaders } from '../helpers/env.js';

const MENU = { koshari: { price: 1450, name: 'Koshari' } };
const BASKET = { items: { koshari: 2 }, type: 'pickup', business: false, method: 'paypal' };
const TOTAL = 2610;
const TELEGRAM = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '4242' };
const SEND = '/botbot-token/sendMessage';
const CREDS = { ADMIN_USER: 'sherif', ADMIN_PASSWORD: 'correct-horse-battery-staple' };

function ctx() {
  const promises = [];
  return { waitUntil: (p) => promises.push(p), settled: () => Promise.all(promises) };
}
const post = (path, body, headers = {}) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const get = (path, headers = {}) => new Request('https://kairo1980.de' + path, { headers });

/* PayPal as a little state machine: the order is CREATED, APPROVED once the
   guest approves, COMPLETED once a capture is taken. `capture` decides what a
   capture call does; it may take the money and still not answer. */
function provider(t, { capture, read } = {}) {
  const state = { status: 'CREATED', captured: false, captureCalls: 0, payment: null };
  const view = () => orderResponse({
    id: 'PP-ORDER-1', status: state.captured ? 'COMPLETED' : state.status,
    captureId: state.captured ? 'CAP-1' : null, captureStatus: state.captured ? 'COMPLETED' : null,
    amount: state.captured ? (state.amount || TOTAL) : null,
    paymentId: state.payment && state.payment.id, reference: state.payment && state.payment.reference
  });
  const take = () => { state.captured = true; return view(); };
  const paypal = fakePayPal({
    '/v2/checkout/orders': () => orderResponse({ id: 'PP-ORDER-1' }),
    '/v2/checkout/orders/PP-ORDER-1/capture': async (call) => {
      state.captureCalls += 1;
      if (capture) return capture({ state, take, view, call });
      if (state.status !== 'APPROVED') {
        return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
      }
      return take();
    },
    '/v2/checkout/orders/PP-ORDER-1': async () => (read ? read({ state, view }) : view()),
    '/v1/notifications/verify-webhook-signature': () => ({ verification_status: 'SUCCESS' }),
    [SEND]: () => ({ ok: true })
  });
  t.after(() => paypal.restore());
  const alerts = () => paypal.calls.filter((k) => k.path === SEND).map((k) => k.body && k.body.text);
  return { state, paypal, alerts };
}

async function start(env, c, state) {
  const res = await worker.fetch(post('/api/payments', BASKET), env, c);
  assert.equal(res.status, 201, await res.clone().text());
  const payment = await res.json();
  state.payment = payment;
  return payment;
}
const row = (env, id) => env.DB._raw.prepare('SELECT * FROM payments WHERE id = ?').get(id);
const capture = async (env, c, id) => {
  const res = await worker.fetch(post(`/api/payments/${id}/capture`), env, c);
  await c.settled();
  return { status: res.status, body: await res.json() };
};
const cancel = async (env, c, id) => {
  const res = await worker.fetch(post(`/api/payments/${id}/cancel`), env, c);
  return (await res.json()).payment;
};
const show = async (env, c, id) => (await (await worker.fetch(get(`/api/payments/${id}`), env, c)).json()).payment;
const HANDOVER = { items: { koshari: 2 }, type: 'pickup', business: false,
                   time: 'So schnell wie möglich', name: 'Test Gast', phone: '+49 176 1234567' };
const announce = async (env, c, body) => {
  const res = await worker.fetch(post('/api/orders/announce', body), env, c);
  await c.settled();
  return { status: res.status, body: await res.json() };
};
const orders = (env) => env.DB._raw.prepare('SELECT * FROM orders').all();
const backdate = (env, id) => env.DB._raw.prepare('UPDATE payments SET created_at = ? WHERE id = ?')
  .run(new Date(Date.now() - 20 * 60000).toISOString(), id);

/* --- a capture whose answer is lost ------------------------------------ */

test('a capture the provider took but whose answer never came back is recorded as paid', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state, alerts } = provider(t, {
    capture: ({ take }) => { take(); throw new TypeError('network connection lost'); }
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const { status, body } = await capture(env, c, payment.id);
  assert.equal(status, 200);
  assert.equal(body.payment.status, 'captured');
  assert.equal(body.payment.money, 'money');
  assert.equal(state.captureCalls, 1, 'taken once, never asked for twice');
  assert.equal(alerts().length, 1, 'and the kitchen hears of it');
});

test('a capture answered with a 5xx is not a failure: the payment stays open and the page is told it is unknown', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t, {
    capture: () => ({ status: 503, body: { name: 'SERVICE_UNAVAILABLE' } })
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const { status, body } = await capture(env, c, payment.id);
  assert.equal(status, 202);
  assert.equal(body.unconfirmed, true);
  assert.equal(body.payment.money, 'open');
  assert.notEqual(row(env, payment.id).status, 'failed');
});

test('a lost capture with an unreadable provider stays open, and the sweep finds the money later', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let reachable = false;
  const { state, alerts } = provider(t, {
    capture: ({ take }) => { take(); throw new TypeError('timeout'); },
    read: ({ view }) => {
      if (!reachable) return { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } };
      return view();
    }
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const first = await capture(env, c, payment.id);
  assert.equal(first.status, 202);
  assert.equal(first.body.payment.money, 'open');
  assert.equal(alerts().length, 0);

  reachable = true;
  backdate(env, payment.id);
  await reconcileStuckPayments(env);
  assert.equal(row(env, payment.id).status, 'captured');
  assert.equal(state.captureCalls, 1, 'the sweep read the capture; it did not take it again');
  assert.equal(alerts().length, 1);
});

test('only a decline the provider names is recorded as failed, and a failed payment is never captured again', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t, {
    capture: () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] } })
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const { status, body } = await capture(env, c, payment.id);
  assert.equal(status, 402);
  assert.equal(body.payment.status, 'failed');
  assert.equal(body.payment.money, 'none');

  await capture(env, c, payment.id);
  assert.equal(state.captureCalls, 1, 'a page asking again does not reach the provider');
  backdate(env, payment.id);
  await reconcileStuckPayments(env);
  assert.equal(state.captureCalls, 1, 'neither does the sweep');
});

test('a 422 that is not a decline (a capture still in progress) is not called failed', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t, {
    capture: () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_COMPLETION_IN_PROGRESS' }] } })
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const { status, body } = await capture(env, c, payment.id);
  assert.equal(status, 202);
  assert.equal(body.payment.money, 'open');
});

test('a capture for another amount is money for a person, never "no money"', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  state.status = 'APPROVED';
  state.amount = 100;

  const { body } = await capture(env, c, payment.id);
  assert.equal(body.payment.status, 'failed');
  assert.equal(body.payment.money, 'manual');

  // Handed over to be paid on arrival under its id: never stored as an order.
  const { status, body: answer } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  assert.equal(status, 409);
  assert.equal(answer.reason, 'payment_conflict');
  assert.equal(orders(env).length, 0);
});

/* --- a cancel is a request --------------------------------------------- */

test('a cancel the provider shows unapproved is abandoned, and nothing captures it afterwards', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);

  const answer = await cancel(env, c, payment.id);
  assert.equal(answer.status, 'cancelled');
  assert.equal(answer.money, 'none');
  assert.equal(row(env, payment.id).failure_code, 'abandoned_unapproved');

  // The guest approves after all, somewhere: the webhook does not capture...
  state.status = 'APPROVED';
  const event = webhookEvent({ id: 'WH-A', type: 'CHECKOUT.ORDER.APPROVED', paymentId: payment.id,
                               reference: payment.reference, orderId: 'PP-ORDER-1' });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();
  // ...nor a page asking to capture, nor the sweep.
  await capture(env, c, payment.id);
  backdate(env, payment.id);
  await reconcileStuckPayments(env);
  assert.equal(state.captureCalls, 0, 'no capture was ever asked of the provider');
  assert.equal(state.captured, false);
  assert.equal(row(env, payment.id).status, 'cancelled');
});

test('a cancel for an order the provider shows approved is not a cancel: it stays open', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const answer = await cancel(env, c, payment.id);
  assert.equal(answer.status, 'approved');
  assert.equal(answer.money, 'open');
});

test('a cancel the provider does not answer cancels nothing', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t, { read: () => ({ status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } }) });
  const payment = await start(env, c, state);

  const answer = await cancel(env, c, payment.id);
  assert.equal(answer.status, 'created');
  assert.equal(answer.money, 'open');
});

test('a cancel of a payment under review cancels nothing', async (t) => {
  const env = workerEnv(MENU);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'pending' WHERE id = ?").run(payment.id);

  const answer = await cancel(env, c, payment.id);
  assert.equal(answer.status, 'pending');
  assert.equal(answer.money, 'money');
});

test('a cancel arriving while the capture is on its way loses, and the money is recorded', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let during = null;
  const { state } = provider(t, {
    capture: async ({ take }) => {
      // The page's cancel lands here, between the capture's claim and its answer.
      during = await cancel(env, ctx(), state.payment.id);
      return take();
    }
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';

  const { body } = await capture(env, c, payment.id);
  assert.notEqual(during.status, 'cancelled', 'the cancel did not win');
  assert.equal(during.money, 'open');
  assert.equal(body.payment.status, 'captured');
  assert.equal(row(env, payment.id).status, 'captured');
});

test('money the provider reports after a cancel is recorded and announced, never dropped', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state, alerts } = provider(t);
  const payment = await start(env, c, state);
  await cancel(env, c, payment.id);

  const event = webhookEvent({ id: 'WH-C', paymentId: payment.id, reference: payment.reference,
                               amount: TOTAL, orderId: 'PP-ORDER-1' });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();
  assert.equal(row(env, payment.id).status, 'captured');
  assert.equal(alerts().length, 1);
});

test('a payment cancelled before DP-25-01 is asked about again, and a capture found is recorded', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'cancelled', failure_code = 'cancelled_by_customer' WHERE id = ?")
    .run(payment.id);
  assert.equal((await show(env, c, payment.id)).money, 'manual', 'a closed window was never proof');

  state.captured = true;
  const now = await show(env, c, payment.id);
  assert.equal(now.status, 'captured');
  assert.equal(now.money, 'money');
});

/* --- what is never made into a fresh order ----------------------------- */

for (const [status, code] of [['partially_refunded', null], ['refunded', null], ['failed', 'provider_error']]) {
  test(`a ${status}${code ? ' (' + code + ')' : ''} payment is a person's to resolve: no new order under its id`, async (t) => {
    const env = workerEnv(MENU, TELEGRAM);
    const c = ctx();
    const { state, alerts } = provider(t);
    const payment = await start(env, c, state);
    env.DB._raw.prepare('UPDATE payments SET status = ?, failure_code = ? WHERE id = ?').run(status, code, payment.id);

    const { status: http, body } = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
    assert.equal(http, 409);
    assert.equal(body.reason, 'payment_conflict');
    assert.equal(orders(env).length, 0);
    assert.equal(alerts().length, 1, 'the counter is told');
  });
}

test('a paid order without who to cook for is not stored: the page is asked for the details', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'captured', captured_at = ? WHERE id = ?")
    .run(new Date().toISOString(), payment.id);

  for (const missing of [{ name: '' }, { phone: '  ' }, { name: undefined }]) {
    const { status, body } = await announce(env, c, { ...HANDOVER, ...missing, paymentId: payment.id });
    assert.equal(status, 409);
    assert.equal(body.reason, 'details_needed');
  }
  assert.equal(orders(env).length, 0);
  // Given, it is stored.
  assert.equal((await announce(env, c, { ...HANDOVER, paymentId: payment.id })).body.recorded, true);
});

test('/admin never tells the counter "nothing was charged" for a payment nobody established as such', async (t) => {
  const env = workerEnv(MENU, { ...TELEGRAM, ...CREDS });
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'failed', failure_code = 'amount_mismatch' WHERE id = ?")
    .run(payment.id);

  const login = await worker.fetch(new Request('https://kairo1980.de/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: CREDS.ADMIN_USER, password: CREDS.ADMIN_PASSWORD }).toString()
  }), env, ctx());
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const html = await (await worker.fetch(get('/admin/orders', { cookie }), env, c)).text();
  const card = html.slice(html.indexOf(payment.reference) - 200, html.indexOf(payment.reference) + 900);
  assert.match(card, /CHECK BY HAND/);
  assert.doesNotMatch(card, /Nothing was charged/);
});

test('a cancel that read the order unapproved, just before the guest approved and the capture started, does not win', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let release;
  const held = new Promise((r) => { release = r; });
  let capturing = null;
  let reads = 0;
  const { state } = provider(t, {
    // The capture is on its way and does not answer until released.
    capture: async ({ take }) => { await held; return take(); },
    read: async ({ state: s, view }) => {
      reads += 1;
      if (reads > 1) return view();
      // The cancel's read sees CREATED; at that moment the guest approves and
      // the page starts the capture, which claims the payment.
      const seen = view();
      s.status = 'APPROVED';
      capturing = worker.fetch(post(`/api/payments/${s.payment.id}/capture`), env, c);
      for (let i = 0; i < 50 && row(env, s.payment.id).status !== 'approved'; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return seen;
    }
  });
  const payment = await start(env, c, state);

  const answer = await cancel(env, c, payment.id);
  assert.notEqual(answer.money, 'none', 'the page is never told nothing was taken');
  assert.notEqual(answer.status, 'cancelled');
  release();
  await capturing;
  await c.settled();
  assert.equal(row(env, payment.id).status, 'captured');
});

test('a quiet recovery for a payment that is a person\'s to resolve is a conflict, never a request for details', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'failed', failure_code = 'amount_mismatch' WHERE id = ?").run(payment.id);
  const { status, body } = await announce(env, c, {
    recovery: true, items: { koshari: 2 }, type: 'pickup', business: false, paymentId: payment.id });
  assert.equal(status, 409);
  assert.equal(body.reason, 'payment_conflict');
});

/* --- DP-26-01: every capture caller is admitted, or does not capture ------- */

/* Runs `change` once, just before the first statement that tries to move this
   payment to `approved` — the old settle and the new admission alike — so a
   cancel can be made to win in exactly the gap between a caller's read and its
   write. */
function beforeApproval(env, change) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  const wrap = (st, sql) => ({
    bind: (...args) => wrap(st.bind(...args), sql),
    first: () => st.first(),
    all: () => st.all(),
    run: async () => {
      const approving = /UPDATE payments SET/.test(sql)
        && (/status = 'approved'/.test(sql) || (st.args || []).includes('approved'));
      if (approving && !done) { done = true; change(); }
      return st.run();
    }
  });
  env.DB.prepare = (sql) => wrap(prepare(sql), sql);
  return () => { env.DB.prepare = prepare; };
}
// What the page's cancel writes when the provider still shows the order unapproved.
const cancelWins = (env, id) => () => env.DB._raw.prepare(
  "UPDATE payments SET status = 'cancelled', failure_code = 'abandoned_unapproved' WHERE id = ? AND status = 'created'"
).run(id);

test('an approved webhook that read the payment before a cancel won never captures it', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  state.status = 'APPROVED';
  const undo = beforeApproval(env, cancelWins(env, payment.id));
  const event = webhookEvent({ id: 'WH-R1', type: 'CHECKOUT.ORDER.APPROVED', paymentId: payment.id,
                               reference: payment.reference, orderId: 'PP-ORDER-1' });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();
  undo();
  assert.equal(state.captureCalls, 0, 'no capture was asked of the provider');
  assert.equal(state.captured, false);
  assert.equal(row(env, payment.id).status, 'cancelled');
  assert.equal((await show(env, c, payment.id)).money, 'none');
});

test('the sweep, with a row selected before a cancel won, never captures it', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  state.status = 'APPROVED';
  backdate(env, payment.id);
  const undo = beforeApproval(env, cancelWins(env, payment.id));
  await reconcileStuckPayments(env);
  undo();
  assert.equal(state.captureCalls, 0);
  assert.equal(row(env, payment.id).status, 'cancelled');
});

test('the other way round, an approved webhook admitted first takes the money and a cancel then cancels nothing', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let during = null;
  const { state, alerts } = provider(t, {
    capture: async ({ take }) => { during = await cancel(env, ctx(), state.payment.id); return take(); }
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';
  const event = webhookEvent({ id: 'WH-R2', type: 'CHECKOUT.ORDER.APPROVED', paymentId: payment.id,
                               reference: payment.reference, orderId: 'PP-ORDER-1' });
  await worker.fetch(post('/api/webhooks/paypal', event, webhookHeaders()), env, c);
  await c.settled();
  assert.equal(during.money, 'open', 'the cancel landed while the capture was admitted');
  assert.equal(row(env, payment.id).status, 'captured');
  assert.equal(alerts().length, 1);
});

for (const issue of ['ORDER_NOT_APPROVED', 'PAYER_ACTION_REQUIRED']) {
  test(`${issue} is "not yet", never "no money"`, async (t) => {
    const env = workerEnv(MENU);
    const c = ctx();
    const { state } = provider(t, {
      capture: () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }] } })
    });
    const payment = await start(env, c, state);
    const { status, body } = await capture(env, c, payment.id);
    assert.equal(status, 202);
    assert.equal(body.payment.money, 'open');
  });
}

test('a decline answered while another capture is on its way is not "no money"', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  let release;
  const held = new Promise((r) => { release = r; });
  const { state } = provider(t, {
    capture: async ({ take, state: s }) => {
      if (s.captureCalls === 1) { await held; return take(); }
      return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] } };
    }
  });
  const payment = await start(env, c, state);
  state.status = 'APPROVED';
  const first = worker.fetch(post(`/api/payments/${payment.id}/capture`), env, c);
  for (let i = 0; i < 50 && state.captureCalls < 1; i++) await new Promise((r) => setTimeout(r, 5));
  const second = await capture(env, c, payment.id);
  assert.notEqual(second.body.payment.money, 'none', 'the other capture may still take the money');
  assert.notEqual(second.status, 402);
  release();
  await first;
  await c.settled();
  assert.equal(row(env, payment.id).status, 'captured');
  assert.equal(row(env, payment.id).captures_in_flight, 0, 'and nothing is left counted');
});

test('a payment that turns failed with no reason at the claim write stores no order to be paid on site', async (t) => {
  const env = workerEnv(MENU, TELEGRAM);
  const c = ctx();
  const { state } = provider(t);
  const payment = await start(env, c, state);
  env.DB._raw.prepare("UPDATE payments SET status = 'failed', failure_code = 'DECLINED' WHERE id = ?").run(payment.id);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/INSERT INTO orders/.test(sql)) {
      env.DB._raw.prepare("UPDATE payments SET failure_code = NULL WHERE id = ?").run(payment.id);
    }
    return prepare(sql);
  };
  const res = await announce(env, c, { ...HANDOVER, paymentId: payment.id });
  env.DB.prepare = prepare;
  assert.equal(res.status, 409);
  assert.equal(orders(env).length, 0);
});
