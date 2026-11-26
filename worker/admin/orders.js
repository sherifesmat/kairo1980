/* The kitchen's view of the orders themselves.
   ---------------------------------------------------------------------------
   This page used to be a cross-check on payments and nothing more, because the
   order did not exist on this server: it said what had been paid and could not
   say who by or where to. A guest who paid and never pressed send in WhatsApp
   left a row here that was owed food and impossible to deliver.

   Orders are recorded now (worker/orders.js), so this is the queue. It is also
   the ONLY place a customer's name, telephone number and address are ever
   shown — they are never put in a notification, because the notification
   travels to Telegram, whose company is outside the EU. The details stay here,
   behind the login, on a server in the EU, and are deleted by the nightly sweep
   once the limitation period has run (docs/data-retention.md).

   The telephone number is a `tel:` link on purpose. The complaint that produced
   this page was "I cannot even call him". */

import { layout, esc, newNonce, adminHeaders } from './pages.js';
import { berlinDay } from '../berlin.js';

const money = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';
const clock = (iso) => (iso || '').slice(11, 16);

export async function page(request, env, url) {
  // Berlin, because that is the day the restaurant is working.
  const day = (url.searchParams.get('day') ||
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })).slice(0, 10);

  /* Timestamps are UTC; the working day is Berlin's. Comparing one against the
     other files a 23:00 order under tomorrow and hides it. The window is
     widened by a day either side in SQL and narrowed in JS, where the timezone
     is actually known — a day's orders is a handful of rows, and correctness
     across a DST boundary is worth more than the index. */
  /* Two tables, two timestamp formats, both UTC. `payments` is written by JS
     and carries a real ISO string with its Z; `orders` is written by SQLite's
     datetime('now'), which is "YYYY-MM-DD HH:MM:SS" with no zone at all — and
     JavaScript reads THAT as local time, which silently shifts the day. So the
     zone is added only when it is missing, rather than assumed either way. */

  const { results: rows } = await env.DB.prepare(
    `SELECT o.*, p.status AS payment_status, p.captured_at AS payment_captured_at
       FROM orders o
       LEFT JOIN payments p ON p.id = COALESCE(o.payment_id, o.claimed_payment_id)
      WHERE substr(o.created_at, 1, 10) BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
      ORDER BY o.created_at DESC`
  ).bind(day).all();

  /* Paid, but no order row: the money arrived and the browser died before it
     could say what the money was for. Rare, and the one case still missing a
     name — so it is listed loudly rather than folded in with the rest. */
  const { results: unmatched } = await env.DB.prepare(
    `SELECT p.reference, p.amount, p.order_type, p.captured_at, p.lines
       FROM payments p
      WHERE p.captured_at IS NOT NULL
        AND substr(p.captured_at, 1, 10) BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.payment_id = p.id OR o.claimed_payment_id = p.id)
      ORDER BY p.captured_at DESC`
  ).bind(day).all();

  /* Started, and never settled — the rows every other read leaves out.
     ---------------------------------------------------------------------
     The orphan list above, the `payments_settled` view and the settlement
     report all filter on `captured_at IS NOT NULL`, and for the books that is
     right: money that was not taken is not trade. For a telephone it is
     wrong. A guest who rings to ask "did my payment go through?" is asking
     about precisely the rows all three of them exclude, and until this
     existed there was no screen that could answer her — on 27 August 2026 the
     answer had to be got by running SQL against production, for a 26,10 €
     delivery left at `created` the evening before.

     So this asks the complement of the same question, in the same words: no
     `captured_at`, no money. The state it stopped in is carried through and
     printed rather than interpreted away, because "never approved" and
     "declined" are two different telephone calls. Whether the order details
     reached us is carried with it, so a guest whose basket is already listed
     above is not also reported as a stranger. */
  const { results: unsettled } = await env.DB.prepare(
    `SELECT p.reference, p.status, p.amount, p.order_type, p.postcode,
            p.failure_code, p.lines, p.created_at,
            EXISTS (SELECT 1 FROM orders o WHERE o.payment_id = p.id OR o.claimed_payment_id = p.id) AS has_order
       FROM payments p
      WHERE p.captured_at IS NULL
        AND substr(p.created_at, 1, 10) BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
      ORDER BY p.created_at DESC`
  ).bind(day).all();

  /* Handovers that did not match their payment (DELIVERY_PRICING DP-23-01/24-01).
     Nothing was stored as an order for them, and Telegram may or may not have
     delivered the alert, so they are listed here from the event log for the
     day they were detected, with the payment as it stands now and whether the
     alert reached the phone. */
  const { results: conflictRows } = await env.DB.prepare(
    `SELECT e.created_at, e.event_key, e.payload, p.reference, p.status, p.amount, p.order_type, p.lines,
            (SELECT o.reference FROM orders o WHERE o.payment_id = p.id) AS linked_reference,
            EXISTS (SELECT 1 FROM payment_events a
                     WHERE a.event_key = 'order-conflict-alerted:' || substr(e.event_key, 16)) AS alerted
       FROM payment_events e
       LEFT JOIN payments p ON p.id = e.payment_id
      WHERE e.event_type = 'order_conflict'
        AND substr(e.created_at, 1, 10) BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
      ORDER BY e.created_at DESC`
  ).bind(day).all();

  const orders = rows.filter((o) => berlinDay(o.created_at) === day);
  const conflicts = (conflictRows || []).filter((c) => berlinDay(c.created_at) === day);
  const orphans = unmatched.filter((o) => berlinDay(o.captured_at) === day);
  const unfinished = unsettled.filter((p) => berlinDay(p.created_at) === day);

  const totals = orders.reduce((a, o) => ({
    orders: a.orders + 1,
    net: a.net + o.total,
    cash: a.cash + (o.pay_method === 'onsite' ? 1 : 0)
  }), { orders: 0, net: 0, cash: 0 });

  const nonce = newNonce();
  return new Response(
    render({ day, orders, orphans, unfinished, totals, nonce, conflicts }),
    { headers: adminHeaders(nonce) }
  );
}

const CSS = `
 .nav{display:flex;align-items:center;gap:10px;margin:0 0 12px}
 .nav a{flex:none;display:block;padding:9px 14px;border:1px solid #d8cbb0;background:#fff;
        color:#1c1409;text-decoration:none;font-size:18px;line-height:1}
 .nav a.off{opacity:.35;pointer-events:none}
 .nav b{flex:1;text-align:center;font-size:15px}
 .jump{display:flex;gap:8px;margin:0 0 18px}
 .jump input{flex:1;min-width:0;padding:9px;font-size:16px;border:1px solid #d8cbb0;
             background:#fffdf9}
 .jump button{flex:none;padding:9px 14px;border:1px solid #d8cbb0;background:#faf7f2;
              cursor:pointer;font-size:13.5px}
 .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
 .card{flex:1 1 120px;background:#fff;border:1px solid #e6dcc9;padding:10px 12px}
 .card b{display:block;font-size:20px}
 .card span{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a6030}
 .order{background:#fff;border:1px solid #e6dcc9;margin:0 0 12px;padding:12px 14px}
 .order.cash{border-inline-start:4px solid #a04a00}
 .order.paid{border-inline-start:4px solid #31601f}
 .otop{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px}
 /* An order that was never taken is dimmed and struck through, not hidden: the
    kitchen has to see that it is NOT to be cooked, and the guest may ring. */
 .order.off{opacity:.6}
 .order.off .items,.order.off .amt,.order.off .who{text-decoration:line-through}
 .tag.no{background:#7a1c1c;color:#fff}
 .cancel{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
 .cancel input[name=reason]{flex:1;min-width:180px;padding:7px 9px;border:1px solid #d8cbb0;
   background:#faf7f2;font:inherit}
 .cancel button{flex:none;padding:7px 12px;border:1px solid #d8cbb0;background:#faf7f2;
   font:inherit;cursor:pointer}
 .cancel button.undo{background:#eef3ea}
 .ref{font-weight:700;font-size:16px;letter-spacing:.04em}
 .when{color:#7a6030;font-size:12.5px}
 .tag{font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;
      border:1px solid #d8cbb0;color:#5a4020}
 .tag.cash{background:#fdf0e0;border-color:#e8c9a0;color:#a04a00;font-weight:700}
 .tag.paid{background:#eef6ea;border-color:#bcd8b0;color:#31601f;font-weight:700}
 .amt{margin-inline-start:auto;font-weight:700;white-space:nowrap}
 .who{margin:8px 0;line-height:1.6;font-size:14px}
 .who a{color:#1c1409;font-weight:700}
 .who .lbl{display:inline-block;min-width:74px;color:#7a6030;font-size:12px;
           letter-spacing:.06em;text-transform:uppercase}
 .items{color:#5a4020;font-size:13.5px;border-top:1px solid #f0e8d8;padding-top:8px}
 .note-in{background:#fdf9ef;border:1px solid #e6dcc9;padding:7px 9px;margin-top:8px;
          font-size:13.5px}
 .gone{color:#7a6030;font-style:italic;font-size:13px}
 .empty{padding:18px;color:#7a6030;background:#fff;border:1px solid #e6dcc9}
 .warn{border:1px solid #e8c9a0;background:#fdf0e0;padding:10px 12px;margin-bottom:14px;
       font-size:13.5px;color:#a04a00}
 .order.unfin{border-inline-start:4px solid #7a6030}
 .tag.unfin{background:#f3efe6;border-color:#d8cbb0;color:#5a4020;font-weight:700}
 .sec{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7a6030;
      font-weight:700;margin:28px 0 6px}
 .hint{color:#7a6030;font-size:13px;line-height:1.55;margin:0 0 12px}
`;

/* What a payment that never settled stopped on, in words the person holding
   the telephone can read out. The status in the ledger is the fact; this is
   only its reading, and it lives in one table so that no two places can word
   the same state differently.

   Every line says whether money moved, because that is the only thing the
   guest on the telephone actually asked. `approved` is the one that cannot
   promise: the guest agreed, the capture never ran, and the webhook may still
   complete it — so it is described as unfinished rather than as refused. */
const STOPPED_ON = {
  created: ['NEVER APPROVED',
    'The payment window opened and the guest never approved it. Nothing was charged.'],
  approved: ['NOT YET TAKEN',
    'The guest approved it but the money was never captured. This one may still complete on its own.'],
  pending: ['PAYPAL REVIEWING',
    'PayPal is holding this for review. It is not money yet — do not treat it as paid.'],
  failed: ['FAILED',
    'The payment was refused. Nothing was charged.'],
  cancelled: ['CANCELLED',
    'The guest cancelled it. Nothing was charged.']
};

/** 'YYYY-MM-DD' + n days, in UTC so no local timezone can shift the date. */
function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

export function render({ day, orders, orphans, unfinished, totals, nonce, conflicts = [] }) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const prev = shiftDay(day, -1);
  const next = shiftDay(day, 1);
  const itemsOf = (json) => {
    try {
      return JSON.parse(json || '[]').map((l) => `${l.qty}× ${esc(l.name)}`).join(', ');
    } catch {
      return '—';
    }
  };

  const card = (o) => {
    /* An order whose browser named a payment that did not check out is stored
       as to be paid on site, but it is not an ordinary cash order: the guest
       may believe they paid. It gets its own label and is never PAID ONLINE.
       Loop WEBSITE_ORDERING, W01-05. */
    const unverified = o.payment_check === 'unverified';
    const cash = o.pay_method === 'onsite' && !unverified;
    /* `pay_method` records how the guest MEANT to pay; `captured_at` records
       what the money did. They agree almost always, and must not be confused
       on the occasions they do not: an order backed by a payment PayPal was
       still reviewing was being shown to the kitchen as PAID ONLINE, which is
       the one label on this page that may never be wrong. The join that
       answers it has been on the query since the page was written and was
       simply never read. Asked as `captured_at`, like everywhere else, so a
       refunded order still counts as money that arrived. */
    const settled = !cash && !unverified && !!o.payment_captured_at;
    const delivery = o.order_type === 'delivery';
    const purged = !!o.details_purged_at;

    /* A telephone number with spaces in it is not a dialable href. Everything
       that is not a digit or a leading + goes, and what is shown keeps the
       spacing the guest typed. */
    const dial = String(o.customer_phone || '').replace(/[^\d+]/g, '');

    const who = purged
      ? '<p class="gone">Contact details deleted (retention period elapsed).</p>'
      : `<div class="who">
          ${o.customer_name ? `<div><span class="lbl">Name</span>${esc(o.customer_name)}</div>` : ''}
          ${o.customer_company ? `<div><span class="lbl">Company</span>${esc(o.customer_company)}</div>` : ''}
          ${o.customer_phone ? `<div><span class="lbl">Phone</span><a href="tel:${esc(dial)}">${esc(o.customer_phone)}</a></div>` : ''}
          ${delivery && o.customer_address ? `<div><span class="lbl">Address</span>${esc(o.customer_address)}${o.postcode ? ', ' + esc(o.postcode) : ''}</div>` : ''}
          ${o.requested_time ? `<div><span class="lbl">Time</span>${esc(o.requested_time)}</div>` : ''}
        </div>`;

    /* An order the restaurant never took. Struck through rather than hidden: it
       still happened, the guest may ring about it, and the kitchen needs to see
       that it is NOT to be cooked rather than simply not see it. */
    const cancelled = !!o.cancelled_at;
    const mark = cancelled
      ? `<form class="cancel" method="post" action="/admin/orders/cancel">
           <input type="hidden" name="id" value="${esc(o.id)}">
           <input type="hidden" name="day" value="${esc(day)}">
           <input type="hidden" name="restore" value="1">
           <button class="undo" type="submit">Put it back</button>
         </form>`
      : `<form class="cancel" method="post" action="/admin/orders/cancel">
           <input type="hidden" name="id" value="${esc(o.id)}">
           <input type="hidden" name="day" value="${esc(day)}">
           <input name="reason" placeholder="Why? (we were closed…)" maxlength="200">
           <button type="submit">Did not take it</button>
         </form>`;

    // The anchor a correction message links to (R5-03).
    return `<div class="order ${cash ? 'cash' : settled ? 'paid' : 'unfin'}${cancelled ? ' off' : ''}" id="o-${esc(o.reference)}">
      <div class="otop">
        <span class="ref">${esc(o.reference)}</span>
        <span class="when">${clock(o.created_at)}</span>
        <span class="tag">${delivery ? 'Delivery' : 'Pickup'}</span>
        <span class="tag ${cash ? 'cash' : settled ? 'paid' : 'unfin'}">${
          cash ? 'PAY ON ARRIVAL' : settled ? 'PAID ONLINE'
            : unverified && o.payment_captured_at ? 'PAYMENT NOT VERIFIED — CHECK' : 'PAYMENT NOT COMPLETED'}</span>
        ${o.business ? '<span class="tag">Company</span>' : ''}
        ${cancelled ? '<span class="tag no">NOT TAKEN</span>' : ''}
        <span class="amt">${money(o.total)}</span>
      </div>
      ${unverified ? `<div class="warn"><b>Online-Zahlung nicht bestätigt — bitte prüfen.</b>
        The guest's browser named a payment that does not match this order (or has not taken
        the money). Treat it as unpaid until the payment is checked.</div>` : ''}
      ${who}
      <div class="items">${itemsOf(o.lines)}</div>
      ${!purged && o.notes ? `<div class="note-in"><b>Note:</b> ${esc(o.notes)}</div>` : ''}
      ${cancelled && o.cancelled_reason ? `<div class="note-in"><b>Not taken:</b> ${esc(o.cancelled_reason)}</div>` : ''}
      ${mark}
    </div>`;
  };

  const conflictCard = (c) => {
    let reference = c.reference;
    if (!reference) { try { reference = JSON.parse(c.payload || '{}').reference; } catch { reference = null; } }
    const money_ = c.amount != null ? money(c.amount) : '';
    return `<div class="order unfin">
    <div class="otop">
      <span class="ref">${esc(reference || '?')}</span>
      <span class="when">${clock(c.created_at)}</span>
      ${c.order_type ? `<span class="tag">${c.order_type === 'pickup' ? 'Pickup' : 'Delivery'}</span>` : ''}
      ${c.status ? `<span class="tag ${c.status === 'captured' ? 'paid' : 'unfin'}">${esc(String(c.status).toUpperCase())}</span>` : ''}
      <span class="amt">${money_}</span>
    </div>
    <p class="gone">${c.status
      ? 'The order handed over does not match what was paid for. Nothing was stored for it. Do not charge again.'
      : 'A repeated order matches more than one stored order. Nothing new was stored.'}
      ${c.linked_reference ? ` Linked order: <b>${esc(c.linked_reference)}</b>.` : ''}
      ${c.alerted ? ' Telegram alert sent.' : ' <b>Telegram alert NOT delivered.</b>'}</p>
    ${c.lines ? `<div class="items">${itemsOf(c.lines)}</div>` : ''}
  </div>`;
  };

  const orphanCard = (o) => `<div class="order cash">
    <div class="otop">
      <span class="ref">${esc(o.reference)}</span>
      <span class="when">${clock(o.captured_at)}</span>
      <span class="tag ${o.order_type === 'pickup' ? '' : ''}">${o.order_type === 'pickup' ? 'Pickup' : 'Delivery'}</span>
      <span class="tag paid">PAID ONLINE</span>
      <span class="amt">${money(o.amount)}</span>
    </div>
    <p class="gone">No order details reached us for this payment.</p>
    <div class="items">${itemsOf(o.lines)}</div>
  </div>`;

  /* Reference first and largest, because the guest on the telephone has one
     and nothing else. The basket is printed even though nobody is owed it: it
     is how you recognise the order they are describing. */
  const unfinishedCard = (p) => {
    const [tag, why] = STOPPED_ON[p.status] || ['UNFINISHED', 'This payment never completed.'];
    return `<div class="order unfin">
      <div class="otop">
        <span class="ref">${esc(p.reference)}</span>
        <span class="when">${clock(p.created_at)}</span>
        <span class="tag">${p.order_type === 'pickup' ? 'Pickup' : 'Delivery'}${
          p.postcode ? ' · ' + esc(p.postcode) : ''}</span>
        <span class="tag unfin">${tag}</span>
        <span class="amt">${money(p.amount)}</span>
      </div>
      <p class="gone">${why}${p.failure_code ? ` (${esc(p.failure_code)})` : ''}</p>
      <div class="items">${itemsOf(p.lines)}</div>
      ${p.has_order ? '' :
        '<p class="gone">The guest never sent the order either — this basket is all we have.</p>'}
    </div>`;
  };

  const body = `<h1>Orders</h1>
<div class="sub">every order placed through the website</div>

<div class="nav">
  <a href="/admin/orders?day=${esc(prev)}" aria-label="Previous day">&lsaquo;</a>
  <b>${esc(day)}${day === today ? ' · today' : ''}</b>
  <a class="${next > today ? 'off' : ''}" href="/admin/orders?day=${esc(next)}" aria-label="Next day">&rsaquo;</a>
</div>

<form class="jump" method="get" action="/admin/orders">
  <input type="date" name="day" value="${esc(day)}" aria-label="Jump to a day">
  <button type="submit">Go</button>
</form>

<div class="cards">
  <div class="card"><span>Orders</span><b>${totals.orders}</b></div>
  <div class="card"><span>Value</span><b>${money(totals.net)}</b></div>
  <div class="card"><span>Pay on arrival</span><b>${totals.cash}</b></div>
  <div class="card"><span>Unfinished</span><b>${unfinished.length}</b></div>
</div>

${conflicts.length ? `<div class="warn"><b>Check with the guest: an order did not match its payment.</b>
  Resolve each one in the chat. Never ask for a second payment.</div>
  ${conflicts.map(conflictCard).join('')}` : ''}

${orphans.length ? `<div class="warn"><b>Paid, but no order details.</b> The money
  arrived and the browser closed before it could say who it was for. The guest
  is owed food and will quote the reference — the basket is below.</div>
  ${orphans.map(orphanCard).join('')}` : ''}

${orders.length ? orders.map(card).join('')
  : `<div class="empty">No orders through the website yet today.</div>`}

${unfinished.length ? `<h2 class="sec">Started, never finished</h2>
<div class="hint">Payments that were begun and never settled. <b>No money arrived for
any of these</b>, so nothing here is owed food — they are listed so that a guest who
rings up can be told what happened to their payment, and so that nothing else on this
page has to be taken on trust.</div>
${unfinished.map(unfinishedCard).join('')}` : ''}

<p class="note">Orders reach this page whether or not the guest sent the WhatsApp
message. Contact details are shown here only, never in a notification, and are
deleted automatically once the limitation period has run.
<a href="/admin/sales?month=${esc(day.slice(0, 7))}">Sales for this month</a>.</p>`;

  return layout({
    title: 'Orders', nonce, body, logout: true, back: '/admin', extraCss: CSS
  });
}


/* Mark an order the restaurant never took, or put it back.
   ---------------------------------------------------------------------------
   Deliberately not a delete. The order happened; the guest may ring about it and
   money may have moved, and a deleted row answers none of that. It is marked, and
   the mark travels to the books through /api/reports/orders, so nobody has to make
   the same decision twice in two systems.

   Undoing it is the same route with no reason and `restore` set, because a
   cancellation pressed by mistake must be reversible or the safe thing to do with
   a doubtful order becomes nothing at all. */
export async function cancel(request, env, url) {
  const form = await request.formData();
  const id = String(form.get('id') || '');
  const day = String(form.get('day') || '').slice(0, 10);
  const back = `/admin/orders${day ? `?day=${encodeURIComponent(day)}` : ''}`;

  if (!id) return Response.redirect(new URL(back, url).toString(), 303);

  if (form.get('restore')) {
    await env.DB.prepare(
      'UPDATE orders SET cancelled_at = NULL, cancelled_reason = NULL WHERE id = ?1'
    ).bind(id).run();
  } else {
    // Clipped, because it is free text a person types and it travels to the books.
    const reason = String(form.get('reason') || '').trim().slice(0, 200) || null;
    await env.DB.prepare(
      "UPDATE orders SET cancelled_at = datetime('now'), cancelled_reason = ?2 WHERE id = ?1"
    ).bind(id, reason).run();
  }
  // 303 so a refresh does not repeat the action.
  return Response.redirect(new URL(back, url).toString(), 303);
}
