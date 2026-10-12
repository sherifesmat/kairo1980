/* The opening hours, edited by the restaurant.
   ---------------------------------------------------------------------------
   These are the real, permanent hours — not a "closed today" override. What is
   saved here is what the site publishes, what the structured data declares and
   what the basket will and will not take an order into, from the moment the
   form is submitted.

   config.js keeps the hours the site launched with. They are the defaults, the
   fallback if this server cannot be reached, and what "Reset" restores.
   The page always says which of the two is in effect, because hours that might
   be one thing or another are worse than either. */

import { layout, esc, newNonce, adminHeaders } from './pages.js';
import { readSettings, writeHours, resetHours } from '../settings.js';

const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']
];

export async function page(request, env, url) {
  const { hours, hoursAreCustom, serviceMode } = await readSettings(env);
  const nonce = newNonce();
  return new Response(
    render({ nonce, hours, hoursAreCustom, serviceMode, saved: url.searchParams.has('saved'),
             failed: url.searchParams.has('failed') }),
    { headers: adminHeaders(nonce) }
  );
}

export async function save(request, env, url) {
  const form = await request.formData();
  const current = await readSettings(env);
  if (form.get('service_mode') && form.get('service_mode') !== current.serviceMode) {
    return seeOther('/admin/hours?failed=1');
  }

  if (form.get('reset')) {
    await resetHours(env, form.get('service_mode'));
    return seeOther('/admin/hours?saved=1');
  }

  /* "Apply to every open day" is one checkbox and no JavaScript: the admin
     pages carry `default-src 'none'` and have no script at all, which is worth
     more than the convenience of doing this in the browser. Five identical
     open days is this restaurant's actual week, so typing them once is the
     common case rather than a shortcut. */
  const bulk = form.get('apply_all') === '1';
  const allLunch = pair(form.get('all_lunch_from'), form.get('all_lunch_to'));
  const allEvening = pair(form.get('all_evening_from'), form.get('all_evening_to'));

  const days = {};
  for (const [key] of DAYS) {
    const closed = form.get(`${key}_closed`) === '1';
    days[key] = {
      closed,
      lunch: bulk && !closed ? allLunch
        : pair(form.get(`${key}_lunch_from`), form.get(`${key}_lunch_to`)),
      evening: bulk && !closed ? allEvening
        : pair(form.get(`${key}_evening_from`), form.get(`${key}_evening_to`))
    };
  }

  const written = await writeHours(env, {
    days,
    deliveryFrom: String(form.get('delivery_from') || '').trim()
  }, form.get('service_mode'));

  // Refused rather than half-saved: settings.js returns null for anything that
  // is not a complete, valid week, and a partly-understood opening time is
  // worse than the old one because nobody can see that it is wrong.
  return seeOther(written ? '/admin/hours?saved=1' : '/admin/hours?failed=1');
}

function pair(from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim();
  return a && b ? [a, b] : null;
}

function seeOther(location) {
  // See Other, so a reload does not resubmit the form.
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

const CSS = `
 fieldset{border:1px solid #e6dcc9;background:#fff;padding:12px 14px;margin:0 0 10px}
 legend{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7a6030;padding:0 6px}
 .day{display:grid;grid-template-columns:1fr 1fr;gap:10px 10px;align-items:end}
 /* Two time ranges side by side stop fitting long before the phone runs out
    of width — four inputs and two dashes in one row is unusable on a 360px
    screen. */
 @media(max-width:430px){ .day{grid-template-columns:1fr} }
 .day .full{grid-column:1/-1}
 .note.full{font-size:12.5px;color:#7a6030;line-height:1.55}
 .times{display:flex;align-items:center;gap:6px}
 .times input{flex:1;min-width:0;padding:9px;font-size:16px;border:1px solid #d8cbb0;
              background:#fffdf9}
 .times span{color:#7a6030}
 label.tick{display:flex;align-items:center;gap:8px;font-size:13.5px;letter-spacing:0;
            text-transform:none;color:#1c1409;margin:0}
 label.tick input{width:20px;height:20px;flex:none}
 .cap{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#7a6030;margin:0 0 4px}
 /* Sticky, and above what it sticks over. Without the z-index a label from
    the last fieldset painted on top of the button and swallowed the tap —
    a Save button that cannot be pressed on a phone, found by
    tests/e2e/ordering-switch.spec.js and not by looking at it. */
 .save{position:sticky;bottom:0;z-index:5;background:#faf7f2;padding:12px 0 8px;
       margin-top:4px;box-shadow:0 -10px 14px -8px rgba(28,20,9,0.18)}
 button.save-btn{width:100%;padding:14px;font-size:15px;font-weight:600;border:0;
                 background:#1c1409;color:#f5e8cc;cursor:pointer}
 button.reset{width:100%;padding:11px;font-size:13.5px;border:1px solid #d8cbb0;background:none;
              color:#7a6030;cursor:pointer;margin-top:8px}
 .msg{padding:10px 12px;border:1px solid #bcd8b0;background:#eef6ea;color:#31601f;
      font-size:13.5px;margin-bottom:14px}
 .msg.bad{border-color:#e8c9a0;background:#fdf0e0;color:#a04a00}
 .src{font-size:12.5px;color:#7a6030;margin:0 0 14px}
`;

function times(prefix, label, value) {
  const [from, to] = value || ['', ''];
  return `<div>
    <p class="cap">${label}</p>
    <div class="times">
      <input type="time" step="300" name="${prefix}_from" value="${esc(from)}" aria-label="${label} from">
      <span>–</span>
      <input type="time" step="300" name="${prefix}_to" value="${esc(to)}" aria-label="${label} to">
    </div>
  </div>`;
}

function render({ nonce, hours, hoursAreCustom, serviceMode, saved, failed }) {
  const dayFields = DAYS.map(([key, label]) => {
    const day = hours.days[key] || {};
    return `<fieldset><legend>${label}</legend>
      <div class="day">
        <label class="tick full">
          <input type="checkbox" name="${key}_closed" value="1" ${day.closed ? 'checked' : ''}>
          Closed all day
        </label>
        ${times(`${key}_lunch`, 'Open', day.lunch)}
        ${times(`${key}_evening`, 'Second window', day.evening)}
      </div>
    </fieldset>`;
  }).join('');

  const body = `<h1>Opening hours — ${serviceMode === 'pickup' ? 'pickup only' : 'delivery and pickup'}</h1>
<div class="sub">The regular hours. Live immediately — on the website, in the
opening hours Google reads, and in the basket.</div>

${saved ? '<p class="msg">Saved. Live now.</p>' : ''}
${failed ? `<p class="msg bad">Not saved. Every time must be HH:MM, each closing time
  must come after its opening time, and a second window must start after the first
  one ends — the previous hours are still in force.</p>` : ''}

<p class="src">${hoursAreCustom
  ? 'Using the hours saved here.'
  : 'Using the default hours from <code>config.js</code>.'}</p>

<form method="post" action="/admin/hours">
  <input type="hidden" name="service_mode" value="${esc(serviceMode || 'delivery')}">
  <fieldset ${serviceMode === 'pickup' ? 'style="display:none"' : ''}><legend>Deliveries</legend>
    <div class="day">
      <p class="note full" style="margin:0 0 2px">Collection runs for the whole
      opening below. This is the time a driver starts — before it, the website
      offers collection only. Leave it empty to deliver from the moment you
      open.</p>
      <div>
        <p class="cap">Deliveries from</p>
        <div class="times">
          <input type="time" step="300" name="delivery_from"
                 value="${esc(hours.deliveryFrom || '')}" aria-label="Deliveries from">
        </div>
      </div>
    </div>
  </fieldset>

  <fieldset><legend>All open days at once</legend>
    <div class="day">
      <p class="note full" style="margin:0 0 2px">Fill these in and every day not
      marked “Closed all day” gets these times. Leave a pair empty to remove
      that window everywhere.</p>
      ${times('all_lunch', 'Open', null)}
      ${times('all_evening', 'Second window', null)}
      <label class="tick full">
        <input type="checkbox" name="apply_all" value="1">
        Apply these to every open day
      </label>
    </div>
  </fieldset>

  ${dayFields}

  <p class="note">A day with no times is closed. “Closed all day” overrides
  anything below it.</p>

  <div class="save">
    <button class="save-btn" type="submit">Save</button>
  </div>
</form>

${hoursAreCustom ? `<form method="post" action="/admin/hours">
  <button class="reset" name="reset" value="1" type="submit">Reset to the default hours</button>
</form>` : ''}`;

  return layout({
    title: 'Opening hours', nonce, body, logout: true, back: '/admin', extraCss: CSS
  });
}
