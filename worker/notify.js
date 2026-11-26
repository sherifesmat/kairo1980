import { berlinDay } from './berlin.js';
/* Telling the restaurant that money arrived.
   ---------------------------------------------------------------------------
   The order and the money have always travelled by different paths. The money
   is taken server-side and confirmed by a signed webhook, so it cannot go
   missing. The ORDER is composed in the guest's own browser and handed to
   WhatsApp by the guest — which means a guest who pays and then closes the tab
   has bought food nobody has been told to cook. That happened, with a real
   customer, and it was only noticed because the restaurant happened to look at
   /admin.

   So this sends the order from the one place that already knows the money is
   real: the transition to `captured`. Not from the browser — the browser is
   exactly the party that may have already gone.

   WHAT IT DOES NOT DO is as important as what it does. It carries no name, no
   phone number and no address, because the server has never held any: see
   migrations/0001_payments.sql. It sends the reference, what was ordered, what
   it cost, and where it is going as a postcode. That is enough to recognise the
   order when the guest rings up, and it keeps this change clear of the privacy
   rewrite that delivering the FULL order server-side would require (a retention
   period, Meta as a processor, § 312i BGB). See docs/next-whatsapp-cloud-api.md
   — this is step 1 of that plan, running in parallel with the guest's own
   handover, and it is deliberately the cheap half.

   Telegram rather than WhatsApp for now because WhatsApp's Cloud API cannot use
   a number that is signed in to the WhatsApp Business App, and that app is the
   one the restaurant actually watches. Moving the number would take the shop
   off the app it runs on. A second number and an approved template are the
   proper answer and are days of Meta onboarding; this is minutes, and the hole
   is open tonight.

   UNCONFIGURED IS OFF, not broken. With no token the site behaves exactly as it
   did before — the same call the admin area makes, for the same reason: a lock
   nobody has set up is not an unlocked door. */

const API = 'https://api.telegram.org';

/** Is anybody listening? Both halves or neither: a token with no chat id has
 *  nowhere to send and would fail on every order. */
export function notifyConfigured(env) {
  return !!(env && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Cents -> "47,80 €", in the restaurant's own reading, not the guest's. The
 *  currency comes off the payment row rather than being assumed. */
function money(cents, currency) {
  const amount = (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
  return currency === 'EUR' || !currency ? `${amount} €` : `${amount} ${currency}`;
}

/** Berlin's clock, because that is the one the kitchen runs on. */
function berlinTime(iso) {
  try {
    return new Date(iso).toLocaleString('de-DE', {
      timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit',
      day: '2-digit', month: '2-digit'
    });
  } catch {
    return String(iso || '');
  }
}

/** The message. Plain text on purpose: no Markdown, no HTML parse mode, so a
 *  dish name containing an underscore or an asterisk cannot break the send —
 *  a notification that fails to render is a notification that did not arrive. */
export function composeOrderMessage(payment) {
  const lines = [];
  lines.push('NEUE BEZAHLTE BESTELLUNG');
  lines.push('');
  lines.push(`Referenz: ${payment.reference}`);

  const type = payment.order_type === 'pickup' ? 'Abholung' : 'Lieferung';
  lines.push(`Art:      ${type}${payment.postcode ? ` — ${payment.postcode}` : ''}`);
  lines.push(`Betrag:   ${money(payment.amount, payment.currency)}`);
  lines.push(`Bezahlt:  ${berlinTime(payment.captured_at)} (${payment.provider || 'paypal'})`);
  lines.push('');

  /* The basket, read out of the row the server priced. `lines` is JSON written
     by pricing.js; a row that cannot be parsed still sends the rest, because a
     notification missing its item list beats no notification at all. */
  let items = [];
  try {
    items = JSON.parse(payment.lines || '[]');
  } catch {
    items = [];
  }
  if (items.length) {
    for (const item of items) {
      lines.push(`${item.qty}x ${item.name}`);
    }
  } else {
    lines.push('(Positionen konnten nicht gelesen werden — siehe /admin)');
  }

  lines.push('');
  lines.push('Details (Name, Telefon, Adresse): kairo1980.de/admin/orders');
  return lines.join('\n');
}

/** The same message for an order that has NOT been paid online — the one that
 *  used to reach nobody at all unless the guest remembered to press send.
 *
 *  It carries a reference and a basket and stops there. The name, the phone
 *  number and the address are deliberately absent: Telegram FZ-LLC sits in the
 *  UAE, which has no adequacy decision, so an address in this message would be
 *  a third-country transfer of personal data to solve a problem that a link
 *  solves instead. The details are one tap away, behind the admin login, on a
 *  server in the EU. */
export function composeCashOrderMessage(order) {
  /* Three kinds of order reach this message, and the counter must never
     confuse them: cash, a payment the provider is still reviewing, and a
     payment the guest's browser named that did not check out. Only the first
     is ordinary; the other two must be looked at before food is handed over.
     Loop WEBSITE_ORDERING, W01-05 / W02-03. */
  const unverified = order.payment_check === 'unverified';
  const pending = !unverified && order.pay_method === 'online';
  const lines = [];
  lines.push(unverified
    ? 'NEUE BESTELLUNG — ONLINE-ZAHLUNG NICHT BESTÄTIGT, BITTE PRÜFEN'
    : pending
      ? 'NEUE BESTELLUNG — ONLINE-ZAHLUNG NOCH IN PRÜFUNG'
      : 'NEUE BESTELLUNG — ZAHLUNG BEI ERHALT');
  lines.push('');
  lines.push(`Referenz: ${order.reference}`);

  const type = order.order_type === 'pickup' ? 'Abholung' : 'Lieferung';
  lines.push(`Art:      ${type}${order.postcode ? ` — ${order.postcode}` : ''}`);
  lines.push(`Betrag:   ${money(order.total, order.currency)} (${
    unverified ? 'Zahlung nicht bestätigt — vor Übergabe prüfen'
      : pending ? 'Zahlung ausstehend, noch nicht eingegangen' : 'noch offen'})`);
  if (order.requested_time) lines.push(`Termin:   ${order.requested_time}`);
  lines.push('');

  let items = [];
  try {
    items = JSON.parse(order.lines || '[]');
  } catch {
    items = [];
  }
  if (items.length) {
    for (const item of items) lines.push(`${item.qty}x ${item.name}`);
  } else {
    lines.push('(Positionen konnten nicht gelesen werden — siehe /admin)');
  }

  lines.push('');
  lines.push('Details (Name, Telefon, Adresse): kairo1980.de/admin/orders');
  return lines.join('\n');
}

/** Send a cash order. Same contract as the paid one: never throws, never
 *  rejects, and by the time it runs the guest has already been handed to
 *  WhatsApp — so a failure here costs a notification, never an order. */
export async function sendCashOrderNotification(env, order) {
  if (!notifyConfigured(env) || !order) return { ok: false, error: 'not configured' };
  return post(env, composeCashOrderMessage(order));
}

/** A correction the guest made to an order already sent. Like the order
 *  itself it carries no direct identifier: no name, phone or address. It is not
 *  free of personal data, since a reference and a time can still be linked to
 *  a person. It says WHAT changed, and the new time if that was it.
 *
 *  It links to where the order actually is: the admin day it was PLACED on, in
 *  Berlin, at its own card. A correction to yesterday's order arriving today
 *  must not open today's page, where that order is not. R4-02, R5-03. */
export function correctionLink(order) {
  return `kairo1980.de/admin/orders?day=${berlinDay(order.created_at)}#o-${order.reference}`;
}

export function composeOrderCorrectionMessage(order, changed, { saved = true } = {}) {
  const lines = [];
  /* A correction that lost a race and could not be written is still news: the
     guest's WhatsApp message has it, and the counter must go and read it. */
  lines.push('KORREKTUR ZU BESTELLUNG ' + order.reference +
    (saved ? '' : ' — NICHT GESPEICHERT, BITTE WHATSAPP PRÜFEN'));
  lines.push('');
  lines.push('Geändert: ' + changed.join(', '));
  /* `order` is the row as stored. After a correction that was saved, its time
     IS the new one. After one that was not, it is the old or a competing time,
     and must not be called new (R6-03). */
  if (changed.includes('Termin') && order.requested_time) {
    lines.push((saved ? 'Neuer Termin: ' : 'Aktuell gespeichert: ') + order.requested_time);
  }
  lines.push('');
  lines.push('Aktuelle Angaben: ' + correctionLink(order));
  return lines.join('\n');
}

/** Send a correction. Never throws, like every notification here. */
export async function sendOrderCorrection(env, order, changed, options) {
  if (!notifyConfigured(env) || !order) return { ok: false, error: 'not configured' };
  return post(env, composeOrderCorrectionMessage(order, changed, options));
}

/** Send it. Never throws, never returns a rejected promise: a notification is
 *  the last thing that may be allowed to fail a payment, and by the time this
 *  runs the money is already taken. Every failure is logged and swallowed. */
/** A payment handed over with an order that is not what was paid for. Plain
 *  text, no personal data (as composeCashOrderMessage): the reference, the
 *  amount and the payment's state, and what to do about it. */
export function composePaymentConflictMessage(payment) {
  const state = payment.status === 'captured' ? 'bezahlt' : 'in Prüfung beim Anbieter';
  return [
    'ZAHLUNG PRÜFEN',
    '',
    `Referenz: ${payment.reference}`,
    `Betrag:   ${money(payment.amount, payment.currency)} (${state})`,
    '',
    'Die übergebene Bestellung passt nicht zu dem, was bezahlt wurde',
    '(Gerichte, Art oder Lieferort). Es wurde keine Bestellung angelegt.',
    'Bitte mit dem Gast klären (WhatsApp). Nicht noch einmal kassieren.'
  ].join('\n');
}

export async function sendPaymentConflict(env, payment) {
  if (!notifyConfigured(env) || !payment) return { ok: false, error: 'not configured' };
  return post(env, composePaymentConflictMessage(payment));
}

export async function sendOrderNotification(env, payment) {
  if (!notifyConfigured(env) || !payment) return { ok: false, error: 'not configured' };
  return post(env, composeOrderMessage(payment));
}

/** The one place that talks to Telegram. Never throws, never rejects.
 *
 *  Returns WHY it failed, not just that it did. An earlier version logged to
 *  console.error and returned false, which meant a wrong token produced a
 *  restaurant that heard nothing and a log nobody reads — a paid order arrived,
 *  the alert never sent, and the only symptom was silence. A notification
 *  channel that can fail invisibly is worse than none, because it is trusted.
 *
 *  @returns {Promise<{ok: boolean, error: string|null}>}
 */
async function post(env, text) {
  try {
    const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      })
    });

    if (!res.ok) {
      /* Telegram names the cause plainly — "Unauthorized" for a bad token,
         "chat not found" for a bad chat id — and that sentence is the whole
         diagnosis. It is carried back so /admin can print it instead of
         leaving somebody to guess which half is wrong. */
      let why = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.description) why = `${res.status}: ${body.description}`;
      } catch { /* keep the status */ }
      console.error('order notification refused', why);
      return { ok: false, error: why };
    }
    return { ok: true, error: null };
  } catch (err) {
    const why = (err && err.message) || 'network error';
    console.error('order notification failed', why);
    return { ok: false, error: why };
  }
}

/** Prove the channel works, on demand, from /admin. One tap, and the answer is
 *  the truth about this Worker's own credentials rather than a guess. */
export async function sendTestNotification(env) {
  if (!notifyConfigured(env)) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set' };
  }
  return post(env,
    'KAIRO 1980 — Test.\n\nDie Bestellbenachrichtigung funktioniert. ' +
    'Diese Nachricht wurde im internen Bereich ausgelöst.');
}
