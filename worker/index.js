/* The Worker.
   -------------------------------------------------------------------------
   kairo1980.de is a static site and stays one: everything that is not /api/
   falls straight through to the assets, byte for byte as before. The only
   reason a server exists at all is that three things cannot be done in a
   browser without lying to the guest — deciding what an order costs, telling
   a payment provider to take the money, and being told afterwards whether it
   worked.

   The rule that shapes every route below: the browser says what it WANTS, the
   server says what it COSTS. No amount, price, discount or fee is ever read
   from the request body. */

import { quote, PricingError, toAmount } from './pricing.js';
import { CONFIG } from './site-data.js';
import * as store from './payments/store.js';
import { providerFor, providerForMethod, availableMethods, publicKeys } from './payments/providers.js';
import { ProviderError } from './payments/errors.js';
import * as admin from './admin/index.js';
import { readSettings, orderingNow } from './settings.js';
import { withLiveData, liveETag } from './page-render.js';
import { dayOf, timeOf, instantOf } from './berlin.js';
import { sendOrderNotification, sendCashOrderNotification } from './notify.js';
import { runRetention } from './retention.js';
import { recordOrder, getOrder } from './orders.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

// A basket of 200 items with long ids is still comfortably under this.
const MAX_BODY = 16 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The admin area is a real path rather than something under /api/, because
    // it is a place a person goes rather than a call a program makes. No file
    // matches it, so it would otherwise fall through to the 404 asset.
    const isAdmin = url.pathname === '/admin' || url.pathname.startsWith('/admin/');

    if (!isAdmin && !url.pathname.startsWith('/api/')) {
      const verify = await verificationFile(request, env, url);
      if (verify) return verify;
      const moved = permanentTwin(url);
      if (moved) return moved;
      return withPolicy(url, await asset(request, env, url));
    }

    try {
      if (isAdmin) return await admin.handle(request, env, url);
      return await route(request, env, ctx, url);
    } catch (err) {
      // Never let a provider's words reach the browser: they are for the log.
      console.error('api error', url.pathname, err && err.stack || err);
      if (err instanceof PricingError) return fail(400, err.code, err.message);
      if (err instanceof ProviderError) return fail(502, 'provider_unavailable', 'The payment provider could not be reached.');
      return fail(500, 'internal_error', 'Something went wrong.');
    }
  },

  /* Two jobs on two clocks.

     Reconciliation runs on EVERY tick, including the nightly one. It is one
     indexed query that usually matches nothing, it is idempotent, and it is
     the safe thing to do with a schedule that was added to wrangler.jsonc and
     never wired up here — better a harmless extra sweep than a trigger that
     silently does nothing at all.

     The retention scrub runs on its own expression and only there. A deletion
     period written in the privacy policy and not actually carried out is worse
     than none at all: it is a statement about our own conduct that is untrue,
     and it is the kind that gets checked. It is idempotent too, so a missed
     night is caught up by the next one with no special case.
     See worker/retention.js and docs/data-retention.md. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reconcileStuckPayments(env));
    if (event && event.cron === RETENTION_CRON) ctx.waitUntil(runRetention(env));
  }
};

/* The nightly scrub's own expression, as wrangler.jsonc registers it. Named
   once, here, because it is the only schedule this Worker has to tell apart
   from the others — everything else is a reconciliation tick. */
const RETENTION_CRON = '17 3 * * *';

async function route(request, env, ctx, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/status' && method === 'GET') return status(env);
  if (path === '/api/payments/config' && method === 'GET') return paymentConfig(env, url);
  if (path === '/api/payments/quote' && method === 'POST') return quoteOnly(request, env);
  if (path === '/api/payments' && method === 'POST') return createPayment(request, env, url);
  const hook = path.match(/^\/api\/webhooks\/(\w+)$/);
  if (hook && method === 'POST') return webhook(request, env, ctx, hook[1]);
  if (path === '/api/reports/settlement' && method === 'GET') return settlement(request, env, url);
  if (path === '/api/reports/orders' && method === 'GET') return ordersReport(request, env, url);

  if (path === '/api/orders/announce' && method === 'POST') return announceOrder(request, env, ctx);

  const capture = path.match(/^\/api\/payments\/([\w-]{8,64})\/capture$/);
  if (capture && method === 'POST') return capturePayment(request, env, capture[1], ctx);

  const handover = path.match(/^\/api\/payments\/([\w-]{8,64})\/handover$/);
  if (handover && method === 'POST') return markHandover(env, handover[1]);

  const cancel = path.match(/^\/api\/payments\/([\w-]{8,64})\/cancel$/);
  if (cancel && method === 'POST') return cancelPayment(env, cancel[1]);

  const show = path.match(/^\/api\/payments\/([\w-]{8,64})$/);
  if (show && method === 'GET') return showPayment(env, show[1]);

  return fail(404, 'not_found', 'No such endpoint.');
}

/* --- what is true right now ----------------------------------------------
   The two facts the restaurant can change from its phone: whether orders are
   being taken at all, and what the opening hours are. Everything the page says
   about either is built from this answer, so there is one verdict rather than
   one per section.

   Never cached. This is the endpoint whose whole purpose is to be right within
   seconds of a switch being thrown, and a CDN holding it for five minutes
   would keep a shut kitchen taking orders. The read behind it is cached in the
   isolate for a few seconds instead, which costs the database nothing and
   still answers inside the window a person would call "immediately". */

async function status(env) {
  const settings = await readSettings(env);
  return json({
    /* The resolved verdict, not the switch on its own: a page that asked this
       during a holiday was told the till was open, because the holiday was a
       second fact nobody joined to the first. */
    ordering: orderingNow(settings),
    hours: settings.hours
  });
}

/* --- what the browser is allowed to know ---------------------------------
   The client id is public by design, but it is served from here rather than
   written into config.js so that it and the secret can never disagree about
   which PayPal environment they belong to. One place is configured; the page
   asks what it got. */

/* Sandbox credentials must never reach a real guest. They cannot take money,
   so a payment button backed by them is a button that fails after the guest
   has decided to buy — the worst possible place to lose an order.

   So online payment is withheld on the live domain until PAYPAL_ENV says
   'live'. Localhost and preview deployments still get the full checkout, which
   is where sandbox belongs. This is a safeguard, not a setting: it means the
   wrong thing cannot be shipped by forgetting a flag. */
function sandboxOnProduction(env, url) {
  const live = env.PAYPAL_ENV === 'live';
  const production = url.hostname === 'kairo1980.de' || url.hostname === 'www.kairo1980.de';
  return production && !live;
}

function paymentConfig(env, url) {
  const switchedOn = !!(CONFIG.payment && CONFIG.payment.prepayOnline) &&
    !sandboxOnProduction(env, url);
  const methods = switchedOn ? availableMethods(env) : [];

  return json({
    online: methods.length > 0,
    // Which provider carries which method, so the page knows which SDK to
    // fetch — and fetches only the ones it actually needs.
    methods,
    keys: methods.length ? publicKeys(env) : {},
    environment: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    currency: 'EUR',
    onSite: (CONFIG.payment && CONFIG.payment.onSite) || {}
  });
}

/* --- pricing -------------------------------------------------------------
   The basket shows a total before anyone decides to pay. This lets the page
   confirm that total against the server, so a guest can never be shown one
   figure and charged another. */

async function quoteOnly(request, env) {
  const body = await readJson(request);
  const q = await quote(env, body);
  return json({
    subtotal: q.subtotal,
    discount: q.discount,
    discountPercent: q.discountPercent,
    fee: q.fee,
    total: q.total,
    currency: 'EUR',
    zone: q.zone ? { place: q.zone.place, fee: Math.round(q.zone.fee * 100), minimum: Math.round(q.zone.minimum * 100) } : null,
    belowMinimum: q.belowMinimum
  });
}

/* --- creating a payment -------------------------------------------------- */

async function createPayment(request, env, url) {
  if (!(CONFIG.payment && CONFIG.payment.prepayOnline)) {
    return fail(503, 'payments_off', 'Online payment is switched off.');
  }
  // Hiding the buttons is not enough: the route itself must refuse, or a
  // hand-made request could still start a payment nobody can complete.
  if (sandboxOnProduction(env, url)) {
    return fail(503, 'payments_off', 'Online payment is not available right now.');
  }

  // Read once: a request body is a stream and cannot be consumed twice.
  const body = await readJson(request);

  /* Dimming the buttons is not enough: a tab opened before the switch was
     thrown still has a live checkout in it, and taking money for an order the
     kitchen has already said it cannot cook costs a refund and a phone call.

     But a closure withholds a MOMENT, not the order — the same rule the basket
     applies. An order scheduled for after we reopen is an ordinary order, so
     the body may name the moment it is for. That is a wish, not a price: the
     worst a false one buys is a prepaid order for a time the restaurant can
     read in the message and answer. */
  const ordering = orderingNow(await readSettings(env));
  if (!ordering.open && !wantedAfterClosure(ordering.resumesAt, body.when)) {
    return fail(503, 'ordering_closed', 'The restaurant is not taking orders right now.');
  }

  // The method decides the provider. The browser names a method it was
  // offered; it never names a provider, and it never names a price.
  const provider = providerForMethod(env, body.method);
  if (!provider) return fail(503, 'payments_off', 'That payment method is not available.');

  const q = await quote(env, body);

  const id = crypto.randomUUID();
  const reference = store.newReference();

  const created = await provider.createOrder(env, {
    quote: q,
    paymentId: id,
    reference,
    currency: 'EUR',
    locale: localeFor(body.lang),
    orderType: body.type === 'pickup' ? 'pickup' : 'delivery',
    brandName: 'KAIRO 1980'
  });

  await store.create(env.DB, {
    id,
    reference,
    provider: provider.name,
    providerOrderId: created.providerOrderId,
    amount: q.total,
    currency: 'EUR',
    subtotal: q.subtotal,
    discount: q.discount,
    fee: q.fee,
    orderType: body.type === 'pickup' ? 'pickup' : 'delivery',
    business: !!body.business,
    postcode: body.postcode || null,
    lines: q.lines
  });

  return json({
    id,
    reference,
    provider: provider.name,
    providerOrderId: created.providerOrderId,
    // Stripe needs this in the browser to confirm the intent. It is scoped to
    // this one payment; the secret key never leaves the Worker.
    clientSecret: created.clientSecret || null,
    amount: q.total,
    amountText: toAmount(q.total),
    currency: 'EUR',
    // So the page can prove the figure it displayed is the figure being taken.
    breakdown: { subtotal: q.subtotal, discount: q.discount, fee: q.fee },
    belowMinimum: q.belowMinimum
  }, 201);
}

/* Does the moment the guest asked for fall after we reopen?
   `when` is a Berlin wall clock — { date: 'YYYY-MM-DD', time: 'HH:MM' } — and
   is compared as one, against the closure's end read in the same zone. No
   instant arithmetic, so nothing to get wrong on the two nights a year the
   clocks move. Absent or malformed means "as soon as possible", which during
   a closure is exactly the moment we cannot cook in. */
export function wantedAfterClosure(resumesAt, when) {
  const at = Date.parse(String(resumesAt || ''));
  if (!Number.isFinite(at)) return true;          // no closure end: not closed
  if (!when || typeof when !== 'object') return false;

  const date = String(when.date || '');
  const time = String(when.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return false;
  }

  return `${date}T${time}` >= `${dayOf(at)}T${timeOf(at)}`;
}

const LOCALES = { de: 'de-DE', en: 'en-GB', ar: 'ar-EG' };
function localeFor(lang) {
  return LOCALES[String(lang || '').slice(0, 2)] || 'de-DE';
}

/* --- capturing -----------------------------------------------------------
   Called by the browser the moment the guest approves. It is safe to call
   twice, safe to call after the webhook already did the work, and safe to
   call after a refresh: the status transition in the store decides who
   actually moves the payment, and everyone else is simply told where it got
   to. */

async function capturePayment(request, env, id, ctx) {
  const payment = await store.get(env.DB, id);
  if (!payment) return fail(404, 'unknown_payment', 'No such payment.');

  const provider = providerFor(payment.provider);
  if (!provider) return fail(500, 'unknown_provider', 'This payment cannot be processed.');

  // Already finished — by an earlier click, or by the webhook getting there
  // first. That is a success, not a conflict.
  if (store.isTerminal(payment.status)) {
    return json({ payment: store.publicView(payment), alreadyFinal: true });
  }

  let result;
  try {
    result = await provider.captureOrder(env, payment.provider_order_id, payment.id);
  } catch (err) {
    if (err instanceof ProviderError) {
      await store.settle(env.DB, id, 'failed', {
        failureCode: err.code,
        failureMessage: err.message,
        source: 'api',
        payload: err.raw
      });
      const after = await store.get(env.DB, id);
      return json({ payment: store.publicView(after), error: friendlyFailure(err.code) }, 402);
    }
    throw err;
  }

  const after = await applyCaptureResult(env, payment, result, 'api', ctx);
  return json({ payment: store.publicView(after) });
}

/* --- the order itself -----------------------------------------------------
   Called as the guest presses send, cash or card. Until this existed, an order
   paid on arrival reached this server nowhere at all: the kitchen learned of it
   only if the guest remembered to press send in WhatsApp, and one who did not
   cost a real dinner on 6 August 2026.

   THE CONTRACT IS THAT IT NEVER BLOCKS. Every failure below answers plainly and
   the browser ignores the answer; the WhatsApp handover proceeds exactly as it
   did before. A throttled caller, an unpriceable basket or a database that will
   not answer must never be able to lose an order — that is the problem this
   route was added to solve, not a new way to reproduce it. */
async function announceOrder(request, env, ctx) {
  const body = await readJson(request);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  /* The closure applies here too, and for a while it did not.
     ---------------------------------------------------------------------
     `/api/payments` has refused orders during a closure since the switch
     existed, on the reasoning written above it: dimming the buttons is not
     enough, because a tab opened before the switch was thrown still has a
     live basket in it. This route was added later, for orders paid on
     arrival, and never inherited the check — so closing the restaurant
     stopped the orders that were paid for and let through the ones that
     were not.

     It happened on 14 August 2026. The kitchen was closed for the evening,
     a guest whose page had been open since before the switch pressed send,
     and the order was recorded and announced as real. Nothing failed
     anywhere; the restaurant simply had an order it had already said it
     could not cook.

     Same rule as payments, deliberately: a closure withholds a MOMENT, not
     the order, so one the guest asks for after we reopen still goes through.

     What this cannot do is stop the WhatsApp message — that is the guest's
     own browser opening their own chat, fired before this answer arrives and
     ignoring it by design. The restaurant reads it and says no, as it would
     to a telephone call. What changes is that a closed kitchen is no longer
     told an order is real, and no longer has one in its books. */
  const ordering = orderingNow(await readSettings(env));
  if (!ordering.open && !wantedAfterClosure(ordering.resumesAt, body.when)) {
    return fail(503, 'ordering_closed', 'The restaurant is not taking orders right now.');
  }

  let stored;
  try {
    stored = await recordOrder(env, body, ip);
  } catch (err) {
    if (err instanceof PricingError) return fail(400, err.code, err.message);
    throw err;
  }
  // Throttled. Not an error the guest should ever see or act on.
  if (!stored) return json({ recorded: false }, 202);

  if (stored.alerted) {
    ctx.waitUntil((async () => {
      const order = await getOrder(env, stored.id);
      if (order) await sendCashOrderNotification(env, order);
    })());
  }

  // The reference goes back so the WhatsApp message prints the same code the
  // restaurant will read at /admin. A guest quoting a code nobody can find is
  // worse than no code at all.
  return json({ recorded: true, reference: stored.reference });
}

/* Tell the restaurant, once, that an order is real.

   Hung off `changed` and nothing else. `store.settle` moves a payment only from
   a status it may legally come from, in one conditional UPDATE, so `changed` is
   true exactly once per payment however many times this is reached — a double
   click, a provider retry and a replayed webhook all arrive here and only the
   first one notifies. That is the same fact the ledger relies on, asked the
   same way, rather than a second guard that could disagree with it.

   `ctx.waitUntil` where there is a ctx: the guest's browser must not wait for
   Telegram, and the isolate must not be torn down before the send finishes.
   Without one (reconciliation, tests) it is simply awaited. */
function announcePaid(env, ctx, payment) {
  const sending = sendOrderNotification(env, payment);   // never rejects
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(sending);
    return Promise.resolve();
  }
  return sending;
}

/** Turn a provider capture/read into a stored state. Shared by the browser
 *  path, the webhook path and the reconciliation path so all three can never
 *  interpret the same facts differently. */
async function applyCaptureResult(env, payment, result, source, ctx) {
  const common = {
    source,
    providerOrderId: result.providerOrderId,
    authorizationId: result.authorizationId,
    captureId: result.captureId,
    paymentSource: result.paymentSource,
    payerEmail: result.payerEmail,
    payerId: result.payerId,
    payload: { status: result.status, captureStatus: result.captureStatus }
  };

  /* The CAPTURE decides whether money moved. The order does not.

     A PayPal order reads COMPLETED as soon as the capture call succeeds, even
     when the capture inside it is PENDING with reason PENDING_REVIEW — PayPal
     is holding the funds for a risk review that can still end in a decline.
     Accepting either as proof told the kitchen "PAID ONLINE" for money that
     had not arrived, which is how a restaurant cooks for free.

     So PENDING is examined first and can never be overridden by the order. */
  if (result.captureStatus === 'PENDING') {
    await store.settle(env.DB, payment.id, 'pending', {
      ...common,
      failureCode: result.captureReason || 'PENDING_REVIEW'
    });
    return store.get(env.DB, payment.id);
  }

  // Order-level COMPLETED counts only when there is no capture to ask.
  if (result.captureStatus === 'COMPLETED' ||
      (!result.captureStatus && result.status === 'COMPLETED')) {
    // The one check that makes the money real: PayPal must have taken the
    // amount this server computed, not the amount anybody asked for.
    if (result.amount != null && result.amount !== payment.amount) {
      await store.settle(env.DB, payment.id, 'failed', {
        ...common,
        failureCode: 'amount_mismatch',
        failureMessage: `Captured ${result.amount} but owed ${payment.amount}`
      });
      console.error('amount mismatch', payment.id, result.amount, payment.amount);
      return store.get(env.DB, payment.id);
    }
    const settled = await store.settle(env.DB, payment.id, 'captured', common);
    const after = await store.get(env.DB, payment.id);
    if (settled.changed) await announcePaid(env, ctx, after);
    return after;
  }

  if (result.captureStatus === 'DECLINED' || result.status === 'VOIDED') {
    await store.settle(env.DB, payment.id, result.status === 'VOIDED' ? 'cancelled' : 'failed', {
      ...common,
      failureCode: result.captureStatus || result.status
    });
    return store.get(env.DB, payment.id);
  }

  if (result.status === 'APPROVED') {
    await store.settle(env.DB, payment.id, 'approved', common);
    return store.get(env.DB, payment.id);
  }

  return store.get(env.DB, payment.id);
}

/* --- reading -------------------------------------------------------------
   This is what makes a refresh, a back button or a dead tab survivable: the
   page asks the server what happened, and if the server is not sure either —
   a payment left hanging with no webhook — it asks the provider before
   answering. An unknown state is never reported as failure. */

async function showPayment(env, id) {
  let payment = await store.get(env.DB, id);
  if (!payment) return fail(404, 'unknown_payment', 'No such payment.');

  if (!store.isTerminal(payment.status) && payment.provider_order_id) {
    const provider = providerFor(payment.provider);
    if (provider) {
      try {
        const remote = await provider.getOrder(env, payment.provider_order_id);
        payment = await applyCaptureResult(env, payment, remote, 'reconcile');
      } catch (err) {
        console.error('reconcile failed', id, err && err.message);
      }
    }
  }

  return json({ payment: store.publicView(payment) });
}

/** The guest closed the PayPal window. Nothing was taken; record it so an
 *  abandoned checkout is a fact in the log rather than a payment that hangs
 *  in 'created' for ever. */
async function cancelPayment(env, id) {
  const { payment } = await store.settle(env.DB, id, 'cancelled', {
    source: 'client',
    failureCode: 'cancelled_by_customer'
  });
  if (!payment) return fail(404, 'unknown_payment', 'No such payment.');
  return json({ payment: store.publicView(payment) });
}

/* --- did the order actually reach the kitchen? -------------------------
   Payment and order travel by different roads here: the money goes through
   the provider, the order goes through the guest's own WhatsApp. A guest who
   pays and then closes the tab has done nothing wrong and is owed food, but
   nothing would have told the restaurant it existed.

   So the page reports the handover, and the report below can name every
   captured payment that never got one. No name, no phone, no address — only
   the fact that a paid order has not been sent, its reference, and what was
   in it. That is enough to recognise the order when the guest rings up, and
   nothing more than the ledger already holds. */

async function markHandover(env, id) {
  const payment = await store.get(env.DB, id);
  if (!payment) return fail(404, 'unknown_payment', 'No such payment.');

  await store.logEvent(env.DB, {
    paymentId: payment.id,
    provider: payment.provider,
    // Unique, so a guest who taps the link three times records it once.
    eventKey: `handover:${payment.id}`,
    eventType: 'order.handed_over',
    source: 'client',
    statusFrom: payment.status,
    statusTo: payment.status,
    amount: payment.amount
  });

  return json({ ok: true });
}

/* --- webhooks ------------------------------------------------------------
   The source of truth. A browser can lie, crash or never come back; this
   arrives regardless, is signed, and is verified with PayPal before a single
   byte of it is believed. */

async function webhook(request, env, ctx, providerName) {
  const provider = providerFor(providerName);
  if (!provider) return fail(404, 'not_found', 'No such endpoint.');

  const raw = await request.text();
  if (raw.length > 128 * 1024) return fail(413, 'too_large', 'Event too large.');

  const { verified, reason, event } = await provider.verifyEvent(env, request, raw);
  if (!verified) {
    console.error('webhook rejected', providerName, reason);
    // 400, not 200: an unverified event must be retried or investigated, never
    // quietly accepted.
    return fail(400, 'unverified', 'Signature not verified.');
  }

  // The unique event key is the replay guard. PayPal retries for days; every
  // retry after the first does nothing at all.
  const fresh = await store.logEvent(env.DB, {
    paymentId: null,
    provider: providerName,
    eventKey: providerName + ':' + event.id,
    eventType: event.event_type,
    source: 'webhook',
    payload: event
  });
  if (!fresh) return json({ ok: true, duplicate: true });

  ctx.waitUntil(handleEvent(env, provider, event));
  // Acknowledge immediately. Work that fails is recoverable from the log and
  // from reconciliation; a slow 200 just makes PayPal retry a good event.
  return json({ ok: true });
}

async function handleEvent(env, provider, event) {
  try {
    const meaning = provider.meaningOf(event.event_type);
    if (!meaning) return;

    const ids = provider.identifyEvent(event);
    let payment = ids.paymentId ? await store.get(env.DB, ids.paymentId) : null;
    if (!payment && ids.providerOrderId) {
      payment = await store.getByProviderOrder(env.DB, provider.name, ids.providerOrderId);
    }
    if (!payment) {
      console.error('webhook for unknown payment', event.event_type, ids.paymentId, ids.providerOrderId);
      return;
    }

    // The guest approved but the browser never came back to capture — a lost
    // callback, a closed tab, a dead phone battery. Take the money here: the
    // guest agreed to pay and is expecting to have paid.
    if (meaning === 'approved' && payment.status === 'created') {
      await store.settle(env.DB, payment.id, 'approved', { source: 'webhook', payload: { event: event.id } });
      const result = await provider.captureOrder(env, payment.provider_order_id, payment.id);
      await applyCaptureResult(env, await store.get(env.DB, payment.id), result, 'webhook');
      return;
    }

    if (meaning === 'captured') {
      if (ids.amount != null && ids.amount !== payment.amount) {
        await store.settle(env.DB, payment.id, 'failed', {
          source: 'webhook',
          failureCode: 'amount_mismatch',
          failureMessage: `Captured ${ids.amount} but owed ${payment.amount}`,
          payload: { event: event.id }
        });
        return;
      }
      const settled = await store.settle(env.DB, payment.id, 'captured', {
        source: 'webhook',
        captureId: ids.captureId,
        eventKey: `${provider.name}:captured:${event.id}`,
        payload: { event: event.id }
      });
      // Already inside the webhook's own waitUntil, so this is awaited rather
      // than handed to another one. This is the path that matters most: it
      // fires whether or not the guest's browser ever came back.
      if (settled.changed) await announcePaid(env, null, await store.get(env.DB, payment.id));
      return;
    }

    if (meaning === 'refunded') {
      const refunded = Math.min(payment.amount, (payment.refunded_amount || 0) + (ids.amount || payment.amount));
      await store.settle(env.DB, payment.id, refunded >= payment.amount ? 'refunded' : 'partially_refunded', {
        source: 'webhook',
        refundedAmount: refunded,
        eventKey: `${provider.name}:refund:${event.id}`,
        payload: { event: event.id }
      });
      return;
    }

    await store.settle(env.DB, payment.id, meaning, {
      source: 'webhook',
      failureCode: event.event_type,
      eventKey: `${provider.name}:${meaning}:${event.id}`,
      payload: { event: event.id }
    });
  } catch (err) {
    console.error('webhook handling failed', event && event.id, err && err.stack || err);
  }
}


/* --- chasing the ones nobody came back for --------------------------------
   The webhook is the backstop for a browser that dies mid-checkout, and it is
   a good one: PayPal retries a failed delivery for days. But it is still one
   channel, and everything that silences it silences it completely — a rolled
   credential that leaves PAYPAL_WEBHOOK_ID verifying against the wrong
   account, an endpoint refusing events for an hour, a subscription edited in
   the dashboard. When that happens a guest who approved a payment has agreed
   to pay, believes they have paid, and the money is never taken. Nothing else
   in this Worker would ever look again: `showPayment` asks PayPal, but only
   when somebody opens the page, and the guest whose tab died is exactly the
   guest who will not.

   So this asks. It is the third caller of `applyCaptureResult` the comment
   above it has always named, and it interprets nothing of its own — three
   paths, one reading of one set of facts.

   It is deliberately dull: it changes only what PayPal itself reports, it is
   idempotent because `store.settle` is, and it announces a recovered payment
   through the same `changed` gate the webhook uses, so a payment cannot be
   announced twice however many ticks see it. */

/* How long a payment is left alone before it is chased. The browser captures
   seconds after approval and PayPal's own webhook retries for minutes; asking
   inside that window spends a call to be told what is already on its way. */
const RECONCILE_AFTER_MINUTES = 10;

/* And how far back to look. An order the guest never approved expires at
   PayPal on its own, and past a few days a read returns 404 — without a floor
   the sweep would ask the same dead question every quarter of an hour for
   ever. */
const RECONCILE_WITHIN_DAYS = 3;

/* Never chase more than this in one tick. A backlog after an outage is caught
   up over the ticks that follow rather than in one long invocation. */
const RECONCILE_LIMIT = 20;

/** One payment, read back from the provider and settled on what it says. */
async function reconcileOne(env, payment) {
  const provider = providerFor(payment.provider);
  if (!provider) return null;

  const read = await provider.getOrder(env, payment.provider_order_id);

  /* The case this exists for: the guest approved and the capture never ran.
     Take the money they agreed to pay, exactly as the webhook would have.
     `settle` to `approved` first so the ledger records that we saw the
     approval — it is a no-op if the webhook already did. */
  if (read.status === 'APPROVED' && !read.captureStatus) {
    await store.settle(env.DB, payment.id, 'approved', {
      source: 'reconcile', payload: { read: read.status }
    });
    const captured = await provider.captureOrder(env, payment.provider_order_id, payment.id);
    return applyCaptureResult(env, await store.get(env.DB, payment.id), captured, 'reconcile', null);
  }

  return applyCaptureResult(env, payment, read, 'reconcile', null);
}

/** The scheduled entry point. Never throws, and never lets one bad payment
 *  stop the rest: a provider that 404s an expired order must not hide a
 *  different guest's captured money behind it. */
export async function reconcileStuckPayments(env) {
  const now = Date.now();
  /* Bounds computed here and bound as parameters, NOT written as
     `datetime('now', '-10 minutes')` in the SQL. `payments.created_at` is a
     JavaScript ISO string with its T and its Z; SQLite's `datetime()` returns
     'YYYY-MM-DD HH:MM:SS' with neither. Compared as text, 'T' sorts after the
     space, so every row on the same date looks newer than the cutoff and the
     sweep would quietly match nothing. Two ISO strings compare correctly. */
  const before = new Date(now - RECONCILE_AFTER_MINUTES * 60000).toISOString();
  const after = new Date(now - RECONCILE_WITHIN_DAYS * 86400000).toISOString();

  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT * FROM payments
        WHERE status IN ('created', 'approved', 'pending')
          AND provider_order_id IS NOT NULL
          AND created_at < ?1 AND created_at > ?2
        ORDER BY created_at ASC
        LIMIT ${RECONCILE_LIMIT}`
    ).bind(before, after).all());
  } catch (err) {
    console.error('reconcile: could not read the ledger', err && err.message);
    return { checked: 0, settled: 0, failed: true };
  }

  let settled = 0;
  for (const payment of rows) {
    try {
      const after_ = await reconcileOne(env, payment);
      if (after_ && after_.status !== payment.status) {
        settled += 1;
        console.log('reconcile:', payment.reference, payment.status, '->', after_.status);
      }
    } catch (err) {
      // One dead order must never cost the others their turn.
      console.error('reconcile failed for', payment.reference, err && err.message);
    }
  }

  if (settled) console.log('reconcile: settled', settled, 'of', rows.length, 'checked');
  return { checked: rows.length, settled };
}

/* --- the books -----------------------------------------------------------
   One authenticated endpoint, because the alternative is somebody retyping
   figures into a spreadsheet — which is how books stop matching reality. */

/* Who may read a report. One definition, because there are two of them now and
   a second endpoint that checks credentials its own way is a second endpoint
   that can check them slightly worse. Returns a Response when the caller must
   be turned away, and null when they may pass. */
function reportAuthFailure(request, env) {
  if (!env.REPORT_TOKEN) return fail(503, 'reports_off', 'Reporting is not configured.');
  // The scheme is required, not stripped if present. Accepting a bare token
  // is not exploitable — you still need the token — but an endpoint that
  // takes credentials in more shapes than it documents is one nobody can
  // reason about later.
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match || !timingSafeEqual(match[1], env.REPORT_TOKEN)) {
    return fail(401, 'unauthorised', 'Not authorised.');
  }
  return null;
}

async function settlement(request, env, url) {
  const denied = reportAuthFailure(request, env);
  if (denied) return denied;

  const from = (url.searchParams.get('from') || '0000-01-01').slice(0, 10);
  const to = (url.searchParams.get('to') || '9999-12-31').slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT * FROM payments_settled WHERE day BETWEEN ?1 AND ?2 ORDER BY day DESC`
  ).bind(from, to).all();

  const totals = results.reduce((sum, row) => ({
    orders: sum.orders + row.orders,
    gross: sum.gross + row.gross,
    refunded: sum.refunded + row.refunded,
    net: sum.net + row.net
  }), { orders: 0, gross: 0, refunded: 0, net: 0 });

  // Paid, but never handed to the restaurant. A guest who paid and closed the
  // tab is owed food and would otherwise be invisible. Reference and contents
  // only — enough to recognise the order when they ring up, and no more than
  // the ledger already holds.
  const { results: orphans } = await env.DB.prepare(
    `SELECT p.reference, p.amount, p.order_type, p.captured_at, p.lines
       FROM payments p
      WHERE p.captured_at IS NOT NULL
        AND substr(p.captured_at, 1, 10) BETWEEN ?1 AND ?2
        AND NOT EXISTS (
          SELECT 1 FROM payment_events e
           WHERE e.payment_id = p.id AND e.event_type = 'order.handed_over')
      ORDER BY p.captured_at DESC`
  ).bind(from, to).all();

  return json({
    from, to, currency: 'EUR', days: results, totals,
    paidButNotSent: orphans.map((o) => ({
      reference: o.reference,
      amount: o.amount,
      orderType: o.order_type,
      capturedAt: o.captured_at,
      items: JSON.parse(o.lines || '[]').map((l) => l.qty + '× ' + l.name)
    }))
  });
}

/* --- the orders report ----------------------------------------------------
   One row per order, for the bookkeeping system that keeps this restaurant's
   accounts (KBOSS). The settlement report above answers "what money arrived",
   which is a day's total; this answers "what was sold", which is the question
   the books are actually built from — dishes, zones, times, and the money each
   order carried.

   THREE THINGS ARE DELIBERATE.

   No personal data. Not the name, not the phone, not the address, not the
   note — the same rule the settlement report follows, and for the same reason:
   those details are read at /admin behind the login and travel nowhere else.
   The books do not need to know who ate; they need to know what was sold. An
   order is identified by its own id, which is meaningless outside this
   database. (`tests/integration/payment-flow.test.js` asserts this.)

   Instants, not days. `created_at` is written by SQLite's `datetime('now')`,
   which is UTC. It is reported as an explicit UTC instant so the reader can
   place it on the restaurant's own trading day rather than guessing what the
   timestamp meant; the Berlin day is given alongside it, from berlin.js, so
   the two can never be worked out differently in two places.

   The VAT position is stated rather than left out. This restaurant is a
   Kleinunternehmer under § 19 UStG: it charges no VAT, so there is no tax to
   split out of these figures. Saying so is not the same as being silent about
   it — a reader that finds no tax field cannot tell "exempt" from "we forgot",
   and would have to assume one of them. */

// A window wider than the books ever ask for in one go. Reported honestly when
// it is hit, because a report that quietly returns some of the orders is worse
// than one that refuses: the missing ones look like days with no trade.
const ORDERS_REPORT_CAP = 2000;

/** A UTC instant as SQLite writes it: 'YYYY-MM-DD HH:MM:SS'. */
function sqliteUTC(instant) {
  return new Date(instant).toISOString().slice(0, 19).replace('T', ' ');
}

/* The two timestamps in this report are not written the same way, and pretending
   they are produced a malformed instant that a reader could not parse at all.

   An order's `created_at` comes from SQLite's `datetime('now')`: 'YYYY-MM-DD
   HH:MM:SS', UTC, with nothing to say so. A payment's `captured_at` comes from
   `new Date().toISOString()`, which is already a complete instant ending in Z.
   Appending 'Z' to both turned the second into '…872ZZ' — and the books' reader,
   normalising Z to an offset, made '…872+00:00+00:00' of it and rejected the
   whole window. Four orders, none imported, over a punctuation mark.

   So: say what is missing, and only what is missing. */
function asInstant(stored) {
  if (!stored) return null;
  const text = String(stored);
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? text : text.replace(' ', 'T') + 'Z';
}

async function ordersReport(request, env, url) {
  const denied = reportAuthFailure(request, env);
  if (denied) return denied;

  // `from` and `to` are days in Hockenheim, inclusive — the same days the
  // restaurant would name. They are converted to the instants that actually
  // bound them, so an order taken at 00:30 on a summer night belongs to the
  // day the guest thinks it does rather than to the UTC date.
  const from = (url.searchParams.get('from') || '2000-01-01').slice(0, 10);
  const to = (url.searchParams.get('to') || '9999-12-30').slice(0, 10);
  const startsAt = sqliteUTC(instantOf(from, '00:00'));
  const endsAt = sqliteUTC(instantOf(to, '00:00') + 24 * 60 * 60 * 1000);

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.reference, o.order_type, o.business, o.pay_method, o.postcode,
            o.lines, o.subtotal, o.discount, o.fee, o.total, o.currency,
            o.requested_time, o.created_at, o.cancelled_at, o.cancelled_reason,
            o.customer_name, o.customer_phone, o.customer_address,
            o.customer_company, o.details_purged_at,
            p.provider, p.status AS payment_status, p.refunded_amount,
            p.captured_at, p.payment_source
       FROM orders o
       LEFT JOIN payments p ON p.id = o.payment_id
      WHERE o.created_at >= ?1 AND o.created_at < ?2
      ORDER BY o.created_at ASC
      LIMIT ?3`
  ).bind(startsAt, endsAt, ORDERS_REPORT_CAP + 1).all();

  const complete = results.length <= ORDERS_REPORT_CAP;
  const rows = complete ? results : results.slice(0, ORDERS_REPORT_CAP);

  return json({
    from,
    to,
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    // Why every figure below is a gross figure with no tax split out.
    vat: { charged: false, scheme: 'kleinunternehmer', basis: '§ 19 UStG' },
    // False means the window held more orders than were returned, so the
    // caller must ask for a narrower one rather than treat this as all of them.
    complete,
    orders: rows.map((o) => {
      const refunded = o.refunded_amount || 0;
      const placedAt = asInstant(o.created_at);
      return {
        id: o.id,
        reference: o.reference,
        placedAt,
        tradingDay: dayOf(Date.parse(placedAt)),
        orderType: o.order_type,          // delivery | pickup
        // An order the restaurant never took: switched off for the evening and one
        // arrived anyway, cancelled by telephone, a duplicate pressed twice. It is
        // reported rather than withheld, because it happened and money may have
        // moved -- and it is marked, so the books can leave it out of the takings
        // without anyone deciding it a second time over there.
        cancelled: !!o.cancelled_at,
        cancelledAt: asInstant(o.cancelled_at),
        cancelledReason: o.cancelled_reason || null,
        business: !!o.business,
        payMethod: o.pay_method,          // onsite | online
        postcode: o.postcode,
        requestedTime: o.requested_time,
        // Cents, exactly as the server priced it. `total` is what the guest
        // owes: food, less the discount that applies only to food, plus the
        // delivery fee that the discount never touches (worker/pricing.js).
        money: {
          subtotal: o.subtotal,
          discount: o.discount,
          deliveryFee: o.fee,
          total: o.total,
          refunded,
          net: o.total - refunded
        },
        lines: JSON.parse(o.lines || '[]'),
        /* Who ordered — for the restaurant's own books, and nobody else's.

           These fields were held back from this report on the same reasoning
           that keeps them out of a Telegram notification: they are a person's
           name, telephone and address, and they should not travel anywhere they
           are not needed. The books are where they ARE needed. Without them the
           restaurant's own system cannot tell that the guest who ordered here on
           Tuesday is the same regular who orders through a marketplace on
           Fridays, so the same person counts as two customers and neither shows
           what they are really worth.

           This is a different journey from the notification one, and the
           difference is what makes it defensible: the report is fetched by the
           restaurant's own system, over a token only it holds, and the data goes
           into the same books that already hold the same details from every
           other channel. Same controller, same purpose, one more source.

           `notes` is deliberately NOT sent. It is free text a guest writes, it
           is where an allergy gets mentioned, and health data under Art. 9 needs
           a reason to travel rather than an absence of one. The books do not
           need it to know who somebody is.

           A purged order sends `null` rather than blanks, so a reader can tell
           "these were deleted on the 1st" from "this guest gave no name". */
        customer:
          o.details_purged_at
            ? null
            : {
                name: o.customer_name || null,
                phone: o.customer_phone || null,
                address: o.customer_address || null,
                company: o.customer_company || null
              },
        detailsPurgedAt: asInstant(o.details_purged_at),
        // Absent for an order paid on arrival: there is no payment to describe.
        payment: o.provider
          ? {
              provider: o.provider,
              status: o.payment_status,
              source: o.payment_source,
              capturedAt: asInstant(o.captured_at)
            }
          : null
      };
    })
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --- content security policy ---------------------------------------------
   The policy lives here rather than in _headers because _headers cannot
   express it: a per-path rule does NOT override the `/*` rule, it loses to
   it, so the strict policy was being served on the ordering page too and the
   checkout SDK would have been blocked in production. Setting it on the way
   out is unambiguous.

   Only the ordering page is allowed to reach PayPal. impressum and
   datenschutz keep the untouched policy from _headers, and so does every
   script, font and image.

   script-src stays strict — no 'unsafe-inline', and the PayPal hosts are
   named rather than wildcarded. style-src gains 'unsafe-inline' because the
   SDK styles the elements it injects and a static file cannot carry a
   per-response nonce. CSS injection is a far smaller risk than script
   injection, and it is confined to this one URL. */

const CHECKOUT_CSP = [
  "default-src 'self'",
  // pay.google.com is the Google Pay sheet. Apple Pay needs no host at all:
  // Safari draws it natively, which is also why it cannot be tested in
  // Chrome or in CI.
  "script-src 'self' https://www.paypal.com https://www.paypalobjects.com https://www.sandbox.paypal.com https://pay.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://www.paypalobjects.com https://t.paypal.com https://www.gstatic.com",
  "font-src 'self'",
  "connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://api-m.paypal.com https://api-m.sandbox.paypal.com https://pay.google.com",
  "frame-src https://www.google.com https://www.paypal.com https://www.sandbox.paypal.com https://pay.google.com",
  "form-action 'self' https://www.paypal.com",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests'
].join('; ');

/* --- serving a page --------------------------------------------------------
   Every path that is not /api/ or /admin is still a static file, handed back
   byte for byte — with one exception, and it is the reason `run_worker_first`
   names these two paths. The pages that STATE the opening hours get them
   written in from the database on the way out, so that a crawler which does
   not run JavaScript still reads the hours the restaurant actually keeps.

   Conditional requests are answered here rather than by the asset server,
   because the asset is no longer the whole answer: the same file plus
   different settings is a different page. So the request goes upstream
   unconditionally, and the 304 is decided against an ETag that includes what
   the settings say. */

const LIVE_PAGES = new Set(['/', '/firmencatering']);

async function asset(request, env, url) {
  if (!LIVE_PAGES.has(url.pathname)) return env.ASSETS.fetch(request);

  const bare = new Request(request);
  bare.headers.delete('if-none-match');
  bare.headers.delete('if-modified-since');

  const response = await env.ASSETS.fetch(bare);
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  const settings = await readSettings(env);
  const etag = liveETag(response.headers.get('etag'), settings);

  if (matches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Cache-Control': response.headers.get('cache-control') || 'public, max-age=0, must-revalidate'
      }
    });
  }

  const out = new Response(withLiveData(await response.text(), settings), response);
  out.headers.set('ETag', etag);
  // The body no longer matches the file's own length or hash.
  out.headers.delete('content-length');
  out.headers.delete('last-modified');
  return out;
}

function matches(header, etag) {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const one = candidate.trim().replace(/^W\//, '');
    return one === etag.replace(/^W\//, '');
  });
}

/* The .html twin of every page, sent permanently to its real URL.

   Cloudflare's asset handling already redirects these, but with a 307 —
   temporary. A temporary redirect tells a crawler the old URL may come back, so
   it keeps it, keeps requesting it, and keeps the ranking signals split between
   two addresses. These URLs are never coming back: the pages have lived at the
   extensionless paths since launch and the sitemap has only ever listed those.

   Listed by name rather than matched by pattern. `googled7bbc73984e8deda.html`
   is Google's own site-verification file and must be served exactly where it
   is — redirecting it would un-verify the property, which is the opposite of
   the point of this function. */
const TWINS = {
  '/index.html': '/',
  '/impressum.html': '/impressum',
  '/datenschutz.html': '/datenschutz',
  '/firmencatering.html': '/firmencatering'
};

/* Google's site-verification file, served at exactly the URL Google asks for.

   The platform's .html handling was redirecting it to the extensionless path
   with a 307. It happened to keep working, because Google followed the
   redirect — but the whole point of the file is that it sits at one exact
   address, and a verification that depends on a redirect being followed is a
   verification that can lapse on somebody else's release note. Losing it means
   losing Search Console for the property, which is the only place any of this
   is measurable. */
const VERIFICATION = '/googled7bbc73984e8deda.html';

async function verificationFile(request, env, url) {
  if (url.pathname !== VERIFICATION) return null;
  // The asset itself lives at the extensionless path once the platform has
  // rewritten it; ask for that and answer here, without a redirect.
  const res = await env.ASSETS.fetch(
    new Request(new URL(VERIFICATION.replace(/\.html$/, ''), url), request));
  if (!res.ok) return null;
  return new Response(await res.text(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function permanentTwin(url) {
  const to = TWINS[url.pathname];
  if (!to) return null;
  return new Response(null, {
    status: 301,
    headers: { Location: to + url.search, 'Cache-Control': 'no-store' }
  });
}

// Only '/'. Cloudflare redirects /index.html here, so this is the single URL
// that ever serves the ordering page.
function withPolicy(url, response) {
  if (url.pathname !== '/') return response;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  const out = new Response(response.body, response);
  out.headers.set('Content-Security-Policy', CHECKOUT_CSP);
  return out;
}

/* --- plumbing ------------------------------------------------------------ */

async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new PricingError('bad_request', 'Expected JSON.');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new PricingError('too_large', 'Request too large.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw new PricingError('bad_request', 'Malformed JSON.');
  }
}

// What the guest is told when a card is refused. Never the provider's wording:
// it is written for a developer, in English, and often says more about the
// payer's bank than they would want on a restaurant's screen.
function friendlyFailure(code) {
  switch (code) {
    case 'INSTRUMENT_DECLINED':
    case 'PAYER_ACTION_REQUIRED': return 'declined';
    case 'PAYER_CANNOT_PAY': return 'declined';
    case 'ORDER_NOT_APPROVED': return 'not_approved';
    default: return 'failed';
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: JSON_HEADERS });
}
