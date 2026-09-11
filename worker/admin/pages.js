/* The admin area's own markup.
   ---------------------------------------------------------------------------
   Rendered by the Worker rather than served as files, because these pages must
   never exist as assets: an asset has a URL anybody can fetch, and everything
   here is behind a session. That also means they are outside _headers, so each
   response states its own policy — see `layout()`.

   Deliberately plain. This is a page opened one-handed, on a phone, usually
   while something else is going wrong. Big targets, no JavaScript at all, and
   nothing that has to load before it works. */

import { slotsFor } from '../page-render.js';

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESCAPE[c]);

/* A nonce per response, so the one <style> block can be allowed by name
   instead of opening style-src to everything inline. There is no script tag
   anywhere in here and script-src says so. */
export function newNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/[^a-zA-Z0-9]/g, '');
}

export function adminHeaders(nonce, extra = {}) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    // Never cached, never stored: a shared phone must not be able to reach
    // this page with the back button after a logout.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    ...extra
  };
}

const CSS = `
 *{box-sizing:border-box}
 body{margin:0;padding:16px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#faf7f2;color:#1c1409;-webkit-text-size-adjust:100%}
 a{color:#8a6a2a}
 .bar{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 18px}
 .bar h1{font-size:17px;margin:0}
 .bar .spacer{flex:1}
 .bar form{margin:0}
 .linkbtn{background:none;border:0;padding:0;font:inherit;color:#8a6a2a;text-decoration:underline;
          cursor:pointer}
 h1{font-size:17px;margin:0 0 2px}
 .sub{color:#7a6030;font-size:13px;margin-bottom:16px}
 .tiles{display:grid;gap:10px}
 .tile{display:block;background:#fff;border:1px solid #e6dcc9;padding:14px 16px;text-decoration:none;
       color:inherit}
 .tile b{display:block;font-size:15px;margin-bottom:2px}
 .tile span{font-size:13px;color:#7a6030}
 .note{margin-top:16px;font-size:12px;color:#7a6030;line-height:1.65}

 /* --- login --- */
 .login{max-width:340px;margin:12vh auto 0}
 .brand{font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:#7a6030;
        text-align:center;margin-bottom:4px}
 .brand b{display:block;font-size:19px;letter-spacing:.16em;color:#1c1409}
 .card{background:#fff;border:1px solid #e6dcc9;padding:20px 18px;margin-top:20px}
 label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a6030;
       margin:0 0 6px}
 input{width:100%;padding:12px;font-size:16px;border:1px solid #d8cbb0;background:#fffdf9;
       color:#1c1409;border-radius:0}
 input:focus{outline:2px solid #b8914a;outline-offset:-1px}
 .field{margin-bottom:14px}
 button.go{width:100%;padding:13px;font-size:15px;font-weight:600;border:0;background:#1c1409;
           color:#f5e8cc;cursor:pointer}
 .err{margin:0 0 14px;padding:10px 12px;background:#fdf0e0;border:1px solid #e8c9a0;
      color:#a04a00;font-size:13.5px}
`;

export function layout({ title, nonce, body, logout = false, back = null, extraCss = '' }) {
  const bar = logout
    ? `<div class="bar">
         ${back ? `<a href="${esc(back)}">&larr; Admin</a>` : '<h1>Admin</h1>'}
         <span class="spacer"></span>
         <form method="post" action="/admin/logout"><button class="linkbtn" type="submit">Sign out</button></form>
       </div>`
    : '';

  // English, not the site's German. Nobody but the restaurant ever sees these
  // pages, and an internal tool in three languages is three times the surface
  // for no reader.
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · KAIRO 1980</title>
<style nonce="${nonce}">${CSS}${extraCss}</style></head><body>
${bar}${body}
</body></html>`;
}

/* The login form.

   `autocomplete` is not decoration here: "username" and "current-password" are
   the tokens iOS Keychain and Google Password Manager look for before they
   offer to fill or to save. Without them a saved credential silently stops
   being offered, which on a phone reads as the password having been lost.

   The error never says which of the two was wrong. Telling an attacker they
   have found the username is telling them half the answer. */
export function loginPage({ nonce, error = false, unconfigured = false }) {
  const body = `<div class="login">
  <div class="brand">KAIRO 1980<b>Admin</b></div>
  <div class="card">
    ${unconfigured
      ? `<p class="err">This page is not set up yet. ADMIN_USER and ADMIN_PASSWORD
         must be set as Cloudflare secrets.</p>`
      : `${error ? '<p class="err">Wrong username or password.</p>' : ''}
    <form method="post" action="/admin/login">
      <div class="field">
        <label for="u">Username</label>
        <input id="u" name="username" type="text" autocomplete="username"
               autocapitalize="none" autocorrect="off" spellcheck="false" required>
      </div>
      <div class="field">
        <label for="p">Password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button class="go" type="submit">Sign in</button>
    </form>`}
  </div>
</div>`;

  return layout({ title: 'Sign in', nonce, body });
}

const SWITCH_CSS = `
 /* Two blocks, one appearance: staying open later and putting a driver out at
    a different time are the same kind of decision and read better as the same
    card. They keep SEPARATE class names because a page with two identical
    hooks is a page where a test — or a person reading the markup — cannot say
    which form they are looking at. */
 .extend,.shift,.holiday{background:#fff;border:1px solid #e6dcc9;padding:12px 14px;margin:0 0 14px}
 .extend.on,.shift.on,.holiday.on{border-color:#bcd8b0;background:#eef6ea}
 .extend .lead,.shift .lead,.holiday .lead{margin:0 0 6px;font-size:15px;color:#31601f}
 .extend .hint,.shift .hint,.holiday .hint{font-size:12.5px;color:#7a6030;margin:6px 0 0;line-height:1.5}
 .holiday .msg.bad{margin:0 0 8px;font-size:13.5px;color:#a03509}
 .holiday form{margin-top:10px}
 .extend .cap,.shift .cap,.holiday .cap{font-size:11px;letter-spacing:.08em;text-transform:uppercase;
              color:#7a6030;margin:0 0 8px}

 .alertbox{background:#fff;border:1px solid #e6dcc9;padding:12px 14px;margin:0 0 14px}
 .alertbox .msg{padding:9px 11px;border:1px solid #bcd8b0;background:#eef6ea;color:#31601f;
                font-size:13.5px;margin:0 0 10px}
 .alertbox .msg.bad{border-color:#e8c9a0;background:#fdf0e0;color:#a04a00}
 .alertbox .hint{font-size:12.5px;color:#7a6030;margin:8px 0 0;line-height:1.5}
 button.test{width:100%;padding:12px;font-size:14px;border:1px solid #d8cbb0;background:#faf7f2;
             color:#1c1409;cursor:pointer;font-weight:600}

 .switch{background:#fff;border:1px solid #e6dcc9;padding:16px;margin-bottom:14px}
 .switch.off{border-color:#e8c9a0;background:#fdf0e0}
 .state{display:flex;align-items:center;gap:10px}
 .dot{width:11px;height:11px;border-radius:50%;background:#4c8a35;flex:none;
      box-shadow:0 0 0 4px rgba(76,138,53,0.15)}
 .switch.off .dot{background:#c2410c;box-shadow:0 0 0 4px rgba(194,65,12,0.15)}
 .state b{font-size:17px;letter-spacing:-0.01em}
 .sched{margin:6px 0 16px;font-size:13px;color:#7a6030;padding-inline-start:21px}
 .sched.is-open{color:#3f6b2c}
 .switch p{margin:0 0 12px;font-size:13.5px;color:#7a6030;line-height:1.6}
 .switch p.lead{font-size:14.5px;color:#1c1409;margin-bottom:2px}
 .switch p.lead b{font-weight:600}
 .until{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:14px;
        color:#1c1409;margin-bottom:16px}
 .rel{font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#a04a00;
      background:rgba(194,65,12,0.09);padding:2px 8px}
 .switch form{margin:0}
 .cap{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#7a6030;margin:16px 0 7px}
 .reasons{display:grid;gap:6px}
 label.tick{display:flex;align-items:center;gap:10px;font-size:14px;letter-spacing:0;
            text-transform:none;color:#1c1409;margin:0;padding:9px 11px;background:#fffdf9;
            border:1px solid #e6dcc9;cursor:pointer}
 label.tick input{width:19px;height:19px;flex:none;margin:0;accent-color:#b8914a}
 label.tick input:checked + span{font-weight:600}

 /* One tap per common closure. Two columns on a phone, so every button is a
    comfortable target and none of them needs a clock time typed into it. */
 .quick{display:grid;grid-template-columns:1fr 1fr;gap:8px}
 button.stop{padding:14px 10px;font-size:14.5px;font-weight:600;border:0;background:#c2410c;
             color:#fff;cursor:pointer;line-height:1.2}
 button.stop:active{background:#a03509}
 button.stop.wide{width:100%;margin-top:4px}
 button.go2{padding:14px 18px;font-size:15px;font-weight:600;border:0;background:#2f6b1d;
            color:#fff;cursor:pointer;width:100%}
 button.go2:active{background:#255716}

 details{margin-top:14px;border-top:1px solid #e6dcc9;padding-top:12px}
 summary{font-size:13.5px;color:#8a6a2a;cursor:pointer;list-style:none}
 summary::-webkit-details-marker{display:none}
 summary::before{content:"+ ";font-weight:700}
 details[open] summary::before{content:"– "}
 details .row{margin-top:12px}

 .row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
 .row .grow{flex:1 1 130px}
 .row label{margin-bottom:5px}
 .row input{padding:11px;font-size:16px;border:1px solid #d8cbb0;background:#fffdf9;width:100%}
 .hint{margin:10px 0 0;font-size:12.5px;color:#7a6030;line-height:1.55}
`;


/* What the guest is told is chosen from a list, not typed. A sentence typed
   here would be one language only, and every guest-facing string on the site
   exists in German, English and Egyptian Arabic or it does not ship. The
   wording a guest actually reads lives in the T table in order.js; these are
   only the labels for choosing which of them to show. */
const REASON_CHOICES = [
  ['', 'No reason given'],
  ['demand', 'Too many orders'],
  ['emergency', 'Emergency / short-notice closure'],
  ['holiday', 'Holiday']
];
const REASON_LABEL = Object.fromEntries(REASON_CHOICES.filter(([v]) => v));

/* How long from now, in the words a person would use. "in 45 minutes" and
   "tomorrow at 11:00" both tell you what you need; "2026-08-07T09:00:00.000Z"
   does not, and an absolute time alone makes you do the subtraction. */
function inWords(ms) {
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

const CLOCK = { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' };

function whenText(ms) {
  const d = new Date(ms);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const day = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const time = d.toLocaleTimeString('en-GB', CLOCK);
  if (day === today) return `today at ${time}`;
  return `${d.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'short'
  })} at ${time}`;
}

/* What the opening hours say about right now — which is a different question
   from what the switch says, and the dashboard has to answer both. A shop can
   be "taking orders" and shut, or paused during service. Conflating the two is
   how somebody closes a till that was never open. */
function todayLine(hours) {
  const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const now = new Date();
  const berlinNow = now.toLocaleTimeString('en-GB', CLOCK);
  const key = KEYS[(new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })).getDay() + 6) % 7];

  const slots = slotsFor(hours, key);
  if (!slots.length) return { open: false, text: 'Closed today' };

  const inside = slots.find((s) => berlinNow >= s.from && berlinNow <= s.to);
  const windows = slots.map((s) => `${s.from}–${s.to}`).join(' · ');
  return {
    open: !!inside,
    text: inside ? `Open now · ${windows}` : `Closed right now · today ${windows}`
  };
}

/** "Wednesday 9 September", from 'YYYY-MM-DD'. Read at midday UTC and printed
 *  in UTC: the value is a calendar date, not a moment, and formatting it in a
 *  timezone is how it arrives on the screen as the day before. */
function dateWords(iso) {
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
    });
  } catch {
    return iso;
  }
}

/** The last day closed: the day before the day we are back. Derived here and
 *  in the band from the same one stored date, so the dashboard cannot say the
 *  18th while the website says the 17th. */
function dayBefore(iso) {
  const ms = Date.parse(iso + 'T12:00:00Z');
  return Number.isFinite(ms) ? new Date(ms - 86400000).toISOString().slice(0, 10) : iso;
}

/* The dashboard leads with the switch rather than a menu of pages, because the
   reason this page gets opened in a hurry is always the switch. */
/** "01:00", in the restaurant's own clock. */
function untilClock(iso) {
  try {
    return new Date(iso).toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '';
  }
}

export function dashboardPage({ nonce, ordering, hours, hoursAreCustom, extension, deliveryShift, holiday, away, holidayError, alert, alertError }) {
  const closed = !ordering.open;
  const resumesAt = closed ? Date.parse(ordering.resumesAt) : null;
  const today = todayLine(hours);

  /* The standing arrangement, said plainly, so the tap below is made against a
     known starting point rather than a remembered one. */
  const usual = hours.deliveryFrom
    ? `normally from <b>${esc(hours.deliveryFrom)}</b>`
    : 'normally throughout the opening hours';

  const stopped = `<p class="lead">Reason: <b>${esc(REASON_LABEL[ordering.reason] || 'none given')}</b></p>
    <p class="until">Reopens ${esc(whenText(resumesAt))}
      <span class="rel">${esc(inWords(resumesAt))}</span></p>
    <form method="post" action="/admin/ordering">
      <input type="hidden" name="open" value="1">
      <button class="go2" type="submit">Start taking orders again</button>
    </form>
    <p class="hint">It reopens on its own at that time — you do not have to come back.</p>`;

  /* One tap per common closure. Several submit buttons in one form, each
     carrying its own value: no JavaScript, and no clock time to type at the
     till while the phone is ringing. */
  const running = `<form method="post" action="/admin/ordering">
      <input type="hidden" name="open" value="0">

      <p class="cap">Why (optional — a guest sees this)</p>
      <div class="reasons">
        ${REASON_CHOICES.map(([value, label], i) => `<label class="tick">
          <input type="radio" name="reason" value="${value}" ${i === 0 ? 'checked' : ''}>
          <span>${label}</span></label>`).join('')}
      </div>

      <p class="cap">Stop taking orders…</p>
      <div class="quick">
        <button class="stop" name="minutes" value="30" type="submit">for 30 min</button>
        <button class="stop" name="minutes" value="60" type="submit">for 1 hour</button>
        <button class="stop" name="minutes" value="120" type="submit">for 2 hours</button>
        <button class="stop" name="minutes" value="" type="submit">rest of today</button>
      </div>

      <details>
        <summary>Until a specific date instead</summary>
        <div class="row">
          <div class="grow">
            <label for="untilDate">Date</label>
            <input id="untilDate" name="untilDate" type="date">
          </div>
          <div class="grow">
            <label for="untilTime">Time</label>
            <input id="untilTime" name="untilTime" type="time" step="300">
          </div>
        </div>
        <button class="stop wide" type="submit">Stop until then</button>
        <p class="hint">For a holiday. It stays closed until that moment and no longer.</p>
      </details>
    </form>`;

  const body = `<div class="switch ${closed ? 'off' : ''}">
  <div class="state"><span class="dot"></span><b>${closed
    ? 'Not taking orders'
    : 'Taking orders'}</b></div>
  <p class="sched ${today.open ? 'is-open' : ''}">${esc(today.text)}</p>
  ${closed ? stopped : running}
</div>

<!-- Staying open later tonight. Deliberately below the switch and above the
     tiles: it belongs with "what is true right now", not with the settings. -->
<div class="extend ${extension ? 'on' : ''}">
  ${extension ? `<p class="lead">Open later tonight — until
      <b>${esc(untilClock(extension.until))}</b>.</p>
    <p class="hint">The published opening hours are unchanged, and this lapses
    on its own. Nothing to come back and undo.</p>
    <form method="post" action="/admin/extend">
      <button class="go2" name="clear" value="1" type="submit">Back to the normal hours</button>
    </form>`
  : `<p class="cap">Staying open later tonight?</p>
    <form method="post" action="/admin/extend">
      <div class="quick">
        <button class="stop" name="minutes" value="30" type="submit">+30 min</button>
        <button class="stop" name="minutes" value="60" type="submit">+1 hour</button>
        <button class="stop" name="minutes" value="120" type="submit">+2 hours</button>
      </div>
      <details>
        <summary>Until a particular time</summary>
        <div class="row">
          <div class="grow">
            <label for="until">Until</label>
            <input id="until" name="until" type="time" step="300">
          </div>
        </div>
        <button class="stop wide" type="submit">Stay open until then</button>
        <p class="hint">Orders can be placed for right now until that time. The
        opening hours on the website do not change.</p>
      </details>
    </form>`}
</div>

<!-- Driving out at a different time today. The same idea as the block above,
     applied to the driver instead of the door: it moves the delivery time in
     either direction for today only, and lapses at midnight by itself. -->
<div class="shift ${deliveryShift ? 'on' : ''}">
  ${deliveryShift ? `<p class="lead">${deliveryShift.from === null
      ? '<b>Collection only today</b> — no driver out.'
      : `Delivering today ${deliveryShift.from
        ? `from <b>${esc(deliveryShift.from)}</b>`
        : '<b>throughout the opening hours</b>'}`} — ${usual}.</p>
    <p class="hint">The delivery times on the website are unchanged, and this
    lapses at midnight on its own. Nothing to come back and undo.</p>
    <form method="post" action="/admin/delivery-shift">
      <button class="go2" name="mode" value="clear" type="submit">Back to the normal delivery time</button>
    </form>`
  : `<p class="cap">Driving out at a different time today?</p>
    <p class="hint">Deliveries run ${usual}.</p>
    <form method="post" action="/admin/delivery-shift">
      <div class="quick">
        <button class="stop" name="mode" value="now" type="submit">from now</button>
        <button class="stop" name="mode" value="open" type="submit">all day today</button>
      </div>
      <!-- The commonest of the three, and the one the weekly settings cannot
           say at all, so it gets its own row and its own words rather than
           being a third chip in the line above. -->
      <button class="stop wide" name="mode" value="off" type="submit">No driver today — collection only</button>
      <details>
        <summary>From a particular time</summary>
        <div class="row">
          <div class="grow">
            <label for="shiftFrom">Deliveries from</label>
            <input id="shiftFrom" name="from" type="time" step="300"
                   value="${esc(hours.deliveryFrom || '')}">
          </div>
        </div>
        <button class="stop wide" name="mode" value="at" type="submit">Deliver from then today</button>
        <p class="hint">Earlier or later — a time before the usual one starts
        deliveries sooner, a later one holds them back. Today only; the times on
        the website do not change.</p>
      </details>
    </form>`}
</div>

<!-- Away for a few days. Not "what is true right now" like the three blocks
     above, but the same shape underneath: two dates, its own end, and no edit
     to the week — so it sits with them rather than under a tile of its own.

     It announces AND, on the days it covers, it stops the till. It did not,
     once: this card said "orders are still being taken" and offered the switch
     as a separate tap, the switch was left alone, and an order arrived on the
     third morning of a fortnight away for a shop with nobody in it. The two
     dates already say which days those are, and nothing else on this page has
     to be remembered for them to mean it.

     Nor could the switch have covered it by hand: with no end named it runs to
     midnight tonight, which is right for a closure and lapses every night of a
     holiday.

     Days BEFORE the first one are untouched, which is why the card says which
     of the two it is doing. A holiday saved a fortnight early must not stop
     tonight's orders — that would be the same bug with the sign flipped. -->
<div class="holiday ${holiday ? 'on' : ''}">
  ${holidayError ? `<p class="msg bad"><b>Not saved.</b> ${esc(holidayError)}</p>` : ''}
  ${holiday ? `<p class="lead">On the website now: closed
      <b>${esc(dateWords(holiday.from))}</b> to <b>${esc(dateWords(dayBefore(holiday.until)))}</b>,
      back <b>${esc(dateWords(holiday.until))}</b>.</p>
    <p class="hint">The band comes down on its own that morning — nothing to come
    back and undo. The opening hours on the website are unchanged.</p>
    ${away
      ? `<p class="hint"><b>Orders are stopped</b> for those days, and start again
        on the morning you are back. Nothing else to tap.</p>`
      : `<p class="hint"><b>Orders carry on as normal</b> until
        ${esc(dateWords(holiday.from))}, then stop by themselves for as long as
        the band is up. To stop them sooner, use the switch at the top of this
        page.</p>`}
    <form method="post" action="/admin/holiday">
      <button class="go2" name="mode" value="clear" type="submit">Take the holiday band down</button>
    </form>`
  : `<p class="cap">Away for a few days?</p>
    <form method="post" action="/admin/holiday">
      <div class="row">
        <div class="grow">
          <label for="holFrom">First day closed</label>
          <input id="holFrom" name="from" type="date" required>
        </div>
        <div class="grow">
          <label for="holUntil">Back on</label>
          <input id="holUntil" name="until" type="date" required>
        </div>
      </div>
      <button class="stop wide" name="mode" value="set" type="submit">Put the holiday band up</button>
      <p class="hint">A band appears on the website straight away, in all three
      languages, and disappears by itself on the morning you are back. Orders
      stop for the days you are away and start again by themselves — but they
      carry on as normal until the first one, so you can put this up weeks
      ahead. To stop orders before then, use the switch at the top of this
      page.</p>
    </form>`}
</div>

<div class="tiles">
  <a class="tile" href="/admin/hours">
    <b>Opening hours</b>
    <span>The regular hours, permanently. ${hoursAreCustom
      ? 'Currently using the hours saved here.'
      : 'Currently using the defaults from config.js.'}</span>
  </a>
  <a class="tile" href="/admin/orders">
    <b>Orders</b>
    <span>Every order placed through the website, with the name, telephone number and address.</span>
  </a>
  <a class="tile" href="/admin/sales">
    <b>Sales</b>
    <span>What was taken, month by month — cash and card together.</span>
  </a>
  <a class="tile" href="/admin/dishes">
    <b>Sold out</b>
    <span>Take a dish off the menu when the kitchen runs out of it.</span>
  </a>
</div>

<!-- The alert channel, and proof that it works.

     This block exists because it once did not work and nothing said so: a paid
     order arrived, Telegram refused the message, and the only trace was a log
     line. The restaurant found out from the customer. One tap answers it now,
     and a refusal prints Telegram's own words rather than a shrug. -->
<div class="alertbox">
  ${alert === 'ok' ? '<p class="msg good">Test message sent. If it did not arrive in Telegram, the chat id is wrong.</p>' : ''}
  ${alert === 'fail' ? `<p class="msg bad"><b>Not sent.</b> ${esc(alertError || 'unknown error')}<br>
    <span class="hint">&ldquo;Unauthorized&rdquo; means the bot token is wrong; &ldquo;chat not found&rdquo; means the chat id is,
    or the bot has never been messaged.</span></p>` : ''}
  <form method="post" action="/admin/test-alert">
    <button class="test" type="submit">Send a test alert to Telegram</button>
  </form>
  <p class="hint">Orders alert you here automatically. Tap this after changing
  anything, so a silent failure is never discovered by a customer.</p>
</div>
<p class="note">You stay signed in for 30 days. “Sign out” ends this session at once —
and on every device, if you change the password afterwards.</p>`;

  return layout({ title: 'Admin', nonce, body, logout: true, extraCss: SWITCH_CSS });
}
