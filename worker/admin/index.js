/* The admin area: /admin and everything under it.
   ---------------------------------------------------------------------------
   One login covers every page here. The session is a signed cookie (auth.js),
   so there is no session table to keep and nothing to clean up.

   Every route follows the same shape: no valid session means the login form
   and nothing else — not a redirect that leaks where you were going, not a
   partial page. A page that is not rendered cannot leak what is on it. */

import {
  checkCredentials, configured, hasSession, issueSession, clearSession,
  tooManyFailures, recordFailure
} from './auth.js';
import { loginPage, dashboardPage, newNonce, adminHeaders } from './pages.js';
import { sendTestNotification } from '../notify.js';
import * as ordersView from './orders.js';
import * as salesView from './sales.js';
import * as dishesView from './dishes.js';
import * as hoursView from './hours.js';
import {
  readSettings, closeOrdering, openOrdering, extendHours, clearExtension,
  setDeliveryShift, clearDeliveryShift, setHoliday, clearHoliday
} from '../settings.js';
import { timeOf } from '../berlin.js';

/* Long enough to make scripted guessing tedious, short enough that a mistyped
   password does not feel like a broken page. It is not a defence against a
   distributed attack — the password's own length is that — but it costs
   nothing and it takes the cheapest attack off the table. */
const FAILED_LOGIN_DELAY_MS = 400;

export async function handle(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/admin';
  const method = request.method.toUpperCase();

  if (path === '/admin/login' && method === 'POST') return login(request, env, url);
  if (path === '/admin/logout' && method === 'POST') return logout(url);

  // Everything below is behind the session.
  const signedIn = await hasSession(env, request);
  if (!signedIn) return loginResponse(env, { next: path === '/admin' ? null : path });

  if (path === '/admin' && method === 'GET') {
    const nonce = newNonce();
    const { ordering, hours, hoursAreCustom, extension, deliveryShift, holiday } =
      await readSettings(env);
    return html(dashboardPage({
      nonce, ordering, hours, hoursAreCustom, extension, deliveryShift, holiday,
      /* Why a holiday was refused, carried in the URL rather than rendered
         into the redirect: a reload must not resend the form. The dates are
         refused as a pair and reported as a pair — the alternative is a page
         that says "the second date is wrong" about two dates that are only
         wrong together. */
      holidayError: url.searchParams.get('hol') === 'bad'
        ? 'Check the dates: you must be back after the first day closed, the '
          + 'date you are back cannot be in the past, and a holiday cannot run '
          + 'longer than 90 days.'
        : null,
      // Set by the test below, carried in the URL so a reload does not resend.
      alert: url.searchParams.get('alert'),
      alertError: url.searchParams.get('why')
    }), nonce);
  }

  /* Prove the notification channel works, on demand.

     This exists because it did NOT work and nothing said so. A paid order
     arrived, the alert was sent, Telegram refused it, and the only trace was a
     console line nobody reads — so the restaurant learned of the failure from a
     customer. A channel that can fail invisibly is worse than no channel,
     because it is trusted. One tap now answers the question, and the answer
     includes Telegram's own words when it says no. */
  if (path === '/admin/test-alert' && method === 'POST') {
    const result = await sendTestNotification(env);
    const query = result.ok ? 'alert=ok' : `alert=fail&why=${encodeURIComponent(result.error || '')}`;
    return new Response(null, {
      status: 303,
      headers: { Location: '/admin?' + query, 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/admin/ordering' && method === 'POST') return setOrdering(request, env);

  /* The holiday band: the fortnight the restaurant is away, said on the site in
     three languages. It is the one thing on this page that speaks to guests
     rather than to the till — so it never touches the ordering switch, and the
     card next to it says as much and offers the switch as a separate tap.

     A refused save changes nothing and says so. Announcing "we are closed" is
     the most expensive sentence this site can publish, so a pair of dates that
     do not make sense is not repaired into a pair that does. */
  if (path === '/admin/holiday' && method === 'POST') {
    const form = await request.formData();
    let query = '';
    if (String(form.get('mode') || '') === 'clear') {
      await clearHoliday(env);
    } else {
      const saved = await setHoliday(env,
        String(form.get('from') || ''), String(form.get('until') || ''));
      if (!saved) query = '?hol=bad';
    }
    return new Response(null, {
      status: 303, headers: { Location: '/admin' + query, 'Cache-Control': 'no-store' }
    });
  }

  /* Staying open later than the fixed hours say. The opposite of the switch
     above and deliberately the same shape: one tap, its own end, and no edit to
     the week — a closing time changed on a Saturday night is a closing time
     still wrong on Tuesday. */
  if (path === '/admin/extend' && method === 'POST') {
    const form = await request.formData();
    if (form.get('clear')) {
      await clearExtension(env);
    } else {
      const minutes = Math.min(Math.max(Number(form.get('minutes')) || 0, 0), 8 * 60);
      const until = String(form.get('until') || '').trim();
      if (minutes) {
        await extendHours(env, Date.now() + minutes * 60000);
      } else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(until)) {
        // A clock time means the next time it comes round — 01:00 typed at
        // half past midnight is tonight, not tomorrow night.
        const { nextTimeOfDay } = await import('../berlin.js');
        await extendHours(env, nextTimeOfDay(until));
      }
    }
    return new Response(null, {
      status: 303, headers: { Location: '/admin', 'Cache-Control': 'no-store' }
    });
  }
  /* A driver out at a different time today — earlier because somebody is free,
     later because nobody is yet. Same shape again: one tap, its own end at
     midnight, and no edit to the week. */
  if (path === '/admin/delivery-shift' && method === 'POST') {
    const form = await request.formData();
    const mode = String(form.get('mode') || '');

    if (mode === 'clear') {
      await clearDeliveryShift(env);
    } else if (mode === 'now') {
      // "I am here and I can drive." The restaurant's own clock, not the
      // server's — a shift is a wall-clock time in Hockenheim.
      await setDeliveryShift(env, timeOf());
    } else if (mode === 'open') {
      // A driver out for the whole of today's opening, whatever it is.
      await setDeliveryShift(env, '');
    } else if (mode === 'off') {
      /* No driver at all today — collection only. null, not '': the two are
         both falsy and mean opposite things, which is why setDeliveryShift
         and everything downstream test for null by name. */
      await setDeliveryShift(env, null);
    } else {
      // A time typed in. An unreadable one changes nothing rather than
      // clearing the shift: setDeliveryShift refuses it and says so by
      // returning null, and the page simply comes back unchanged.
      await setDeliveryShift(env, String(form.get('from') || '').trim());
    }

    return new Response(null, {
      status: 303, headers: { Location: '/admin', 'Cache-Control': 'no-store' }
    });
  }

  if (path === '/admin/hours' && method === 'GET') return hoursView.page(request, env, url);
  if (path === '/admin/hours' && method === 'POST') return hoursView.save(request, env, url);
  if (path === '/admin/orders' && method === 'GET') return ordersView.page(request, env, url);
  /* Marking an order the restaurant never took. Not a delete: it happened, the
     guest may ring about it, and money may have moved. See migration 0005. */
  if (path === '/admin/orders/cancel' && method === 'POST') {
    return ordersView.cancel(request, env, url);
  }
  if (path === '/admin/sales' && method === 'GET') return salesView.page(request, env, url);
  if (path === '/admin/dishes' && method === 'GET') return dishesView.page(request, env, url);
  if (path === '/admin/dishes' && method === 'POST') return dishesView.save(request, env);

  return new Response('Not found.', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* The emergency switch. Closing always carries an end with it — the time given,
   or the end of the day — so a shop closed on Saturday night is taking orders
   again on Sunday without anybody remembering to come back here. */
async function setOrdering(request, env) {
  const form = await request.formData();
  if (form.get('open') === '1') {
    await openOrdering(env);
  } else {
    await closeOrdering(env, {
      reason: form.get('reason'),
      minutes: form.get('minutes'),
      untilDate: form.get('untilDate'),
      untilTime: form.get('untilTime')
    });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: '/admin', 'Cache-Control': 'no-store' }
  });
}

async function login(request, env, url) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return loginResponse(env, { error: true, status: 400 });
  }

  const ip = request.headers.get('cf-connecting-ip') || '';

  /* Checked before the password is, and answered exactly as a wrong password
     is. Telling a guesser they have been locked out tells them the lockout
     exists and how long to wait; saying nothing new tells them nothing. */
  if (await tooManyFailures(env, ip)) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return loginResponse(env, { error: true, status: 401 });
  }

  const ok = await checkCredentials(env, form.get('username'), form.get('password'));
  if (!ok) {
    // Worth seeing in the log: a run of these is somebody trying.
    console.warn('admin login failed', ip || 'unknown');
    await recordFailure(env, ip);
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return loginResponse(env, { error: true, status: 401, next: safeNext(form.get('next')) });
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: safeNext(form.get('next')) || '/admin',
      'Set-Cookie': await issueSession(env, url),
      'Cache-Control': 'no-store'
    }
  });
}

function logout(url) {
  return new Response(null, {
    status: 303,
    headers: { Location: '/admin', 'Set-Cookie': clearSession(url), 'Cache-Control': 'no-store' }
  });
}

/* Where to go after signing in. Only ever a path inside the admin area: an
   open redirect is a phishing primitive, and "//evil.example" is a URL a
   browser reads as another host however much it looks like a path. */
function safeNext(value) {
  const next = String(value || '');
  if (!next.startsWith('/admin') || next.startsWith('//')) return null;
  return next;
}

function loginResponse(env, { error = false, status = 200, next = null } = {}) {
  const nonce = newNonce();
  let page = loginPage({ nonce, error, unconfigured: !configured(env) });
  if (next) {
    page = page.replace('</form>',
      `<input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}"></form>`);
  }
  return html(page, nonce, status);
}

export function html(body, nonce, status = 200) {
  return new Response(body, { status, headers: adminHeaders(nonce) });
}
