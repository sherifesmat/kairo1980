/* A pickup order, from the menu to the restaurant's books.
   Loop WEBSITE_ORDERING (KBOSS), D / W01-04 / W02-02.

   Runs in a disposable local D1 with the service switched to pickup-only, the
   way the live site is today. Serial and in the `switch` project, because it
   writes the service mode and empties the announce counter, both of which are
   shared by every test in the run.

   Every expected amount is derived from the prices the page carries and then
   compared with the Worker's own quote; nothing is typed. At the checked-in
   prices the two baskets are 3280 / 328 / 0 / 2952 and 5680 / 568 / 0 / 5112
   cents — written here only so a reader can check the arithmetic. */

import { test, expect } from '@playwright/test';
import { addItem, openBasket, choosePickup, fillContact, captureWhatsApp } from './helpers.js';
import { signIn, setServiceMode, resetOrderRate, reportedOrders, centsOf, euro, observeAnnounce } from './fixtures.js';

// Each local database reset is a wrangler process (several seconds), paid in the hooks.
test.describe.configure({ mode: 'serial', timeout: 90000 });

const EXTRAS = [
  { id: 'mozzarella-sticks-6-stueck', qty: 1, de: 'Mozzarella Sticks (6 Stück)' },
  { id: 'zwiebelringe-8-stueck', qty: 2, de: 'Zwiebelringe (8 Stück)' },
  { id: 'cheddar-jalapenos-5-stueck', qty: 1, de: 'Cheddar Jalapeños (5 Stück)' },
  { id: 'aegyptischer-reis', qty: 1, de: 'Ägyptischer Reis' }
];

const PAY_LABEL = {
  de: { cash: 'Bargeld', giro: 'EC-/Girocard', card: 'Kreditkarte' },
  ar: { cash: 'كاش', giro: 'كارت EC/Giro', card: 'كارت ائتمان' }
};

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await setServiceMode(page, 'pickup');
  resetOrderRate();
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* fine */ } });
});

/* Leave the shared database in the mode the run found it in, or every delivery
   scenario after this file skips itself (the deploy gate's PO-15 checks did).
   DELIVERY_PRICING round 23. */
let startedIn = null;
test.beforeAll(async ({ request }) => {
  const status = await (await request.get('/api/status')).json();
  startedIn = status.serviceMode || 'delivery';
});

test.afterEach(async ({ page }) => {
  resetOrderRate();
  if (startedIn && startedIn !== 'pickup') await setServiceMode(page, startedIn);
});

/** The first open slot from tomorrow on, read from /api/status — the hours the
 *  Worker actually serves (admin-saved or the config fallback), never typed.
 *  Scheduling makes the test independent of the hour it runs at. */
const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const toClock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

/** The Berlin calendar days from tomorrow on, each with its opening windows
 *  (in minutes) as /api/status serves them. The weekday is derived from the
 *  Berlin date itself, never from the runner's clock or a named day. */
async function comingDays(page) {
  const { hours } = await (await page.request.get('/api/status')).json();
  const out = [];
  for (let i = 1; i <= 14; i++) {
    const date = new Date(Date.now() + i * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const day = hours.days[KEYS[(new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7]];
    const windows = day && !day.closed
      ? [day.lunch, day.evening].filter(Boolean).map(([a, b]) => [toMinutes(a), toMinutes(b)])
      : [];
    out.push({ date, windows });
  }
  return out;
}

async function scheduleAt(page, slot) {
  await page.locator('[data-when="scheduled"]').click();
  await page.locator('#fDate').fill(slot.date);
  await page.locator('#fTime').fill(slot.time);
  return slot;
}

async function scheduleNextOpenSlot(page) {
  const open = (await comingDays(page)).find((d) => d.windows.length);
  expect(open, '/api/status must offer an open day within two weeks').toBeTruthy();
  return scheduleAt(page, { date: open.date, time: toClock(open.windows[0][0] + 60) });
}

/** A future moment the served hours say is CLOSED (R3-05): an hour before the
 *  first opening of an open day, or after its last closing — checked against
 *  every window of that day rather than assumed. */
async function closedSlot(page) {
  for (const { date, windows } of await comingDays(page)) {
    if (!windows.length) continue;
    const candidates = [windows[0][0] - 60, Math.max(...windows.map((w) => w[1])) + 30];
    for (const t of candidates) {
      if (t < 0 || t >= 24 * 60) continue;
      if (windows.some(([a, b]) => t >= a && t < b)) continue;
      return { date, time: toClock(t) };
    }
  }
  return null;
}

async function addExtras(page) {
  for (const x of EXTRAS) await addItem(page, x.id, x.qty);
}

async function addHawawshyWithFries(page) {
  const row = page.locator('.mitem[data-item="hawawshy"]');
  await row.scrollIntoViewIfNeeded();
  await row.locator('[data-act="choose"]').click();
  const dialog = page.locator('.chooser');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[value="steakhouse-pommes"]').check();
  await dialog.locator('[data-act="chooser-add"]').click();
}

/** The Worker's quote for exactly the basket the page holds. */
async function workerQuote(page) {
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('kairo.cart.v2') || 'null'));
  expect(saved && saved.items, 'the page stored its basket').toBeTruthy();
  return (await page.request.post('/api/payments/quote', {
    data: { items: saved.items, type: 'pickup' }
  })).json();
}

async function expectedFood(page, withHawawshy) {
  let cents = 0;
  for (const x of EXTRAS) cents += (await centsOf(page, x.id)) * x.qty;
  if (withHawawshy) cents += (await centsOf(page, 'hawawshy')) + (await centsOf(page, 'steakhouse-pommes'));
  return cents;
}

test('@gate a pickup Extras order is priced, sent to WhatsApp and recorded in the books', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');
  await addExtras(page);
  await openBasket(page);
  await choosePickup(page);

  const food = await expectedFood(page, false);
  const pct = await page.evaluate(() => window.KAIRO_CONFIG.order.directDiscountPercent);
  const quote = await workerQuote(page);
  expect(quote.subtotal, 'the Worker prices the page\'s own prices').toBe(food);
  expect(quote.discount).toBe(Math.round(food * pct / 100));
  expect(quote.fee).toBe(0);
  expect(quote.total).toBe(quote.subtotal - quote.discount);
  await expect(page.locator('#cartBody')).toContainText(euro(quote.total));

  const name = `Gate Gast ${Date.now()}`;
  await fillContact(page, { name, phone: '+49 176 1234567' });
  const slot = await scheduleNextOpenSlot(page);

  const announced = await observeAnnounce(page);
  await page.locator('#cartSend').click();
  const { status, request: sentBody, body: answer } = await announced();

  // The handover: every line, the type, and how to pay at the counter.
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  for (const x of EXTRAS) {
    expect(message).toContain(`${x.qty}× ${x.de} — ${euro((await centsOf(page, x.id)) * x.qty)}`);
  }
  expect(message).toContain('Art: Abholung');
  expect(message).toContain(euro(quote.total));
  const methods = await page.evaluate(() => window.KAIRO_CONFIG.payment.onSite.pickup);
  expect(methods.length).toBeGreaterThan(0);
  for (const m of methods) expect(message).toContain(PAY_LABEL.de[m]);
  expect(message).not.toMatch(/ONLINE BEZAHLT|PAID ONLINE/);
  await expect(page.locator('.cart-sent')).toBeVisible();

  // The announce carried the moment as the Worker reads it (W01-02)…
  expect(sentBody.when).toEqual(slot);
  expect(sentBody.type).toBe('pickup');
  expect(sentBody.paymentId == null).toBe(true);

  // …and was recorded: 200, recorded, a reference — and exactly one row in the
  // same report KBOSS imports, with the Worker's figures.
  expect(status).toBe(200);
  expect(answer.recorded).toBe(true);
  expect(answer.reference).toMatch(/^[A-Z0-9]{4,}$/);
  const rows = (await reportedOrders(page)).filter((o) => o.reference === answer.reference);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  expect(row.orderType).toBe('pickup');
  expect(row.payMethod).toBe('onsite');
  expect(row.customer && row.customer.name).toBe(name);
  expect(row.money).toMatchObject({ subtotal: quote.subtotal, discount: quote.discount, deliveryFee: 0, total: quote.total });
});

test('the Extras with a Hawawshy and fries, ordered in Arabic, reads right to left and prices the same', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await addExtras(page);
  await addHawawshyWithFries(page);
  await openBasket(page);
  await choosePickup(page);

  const food = await expectedFood(page, true);
  const pct = await page.evaluate(() => window.KAIRO_CONFIG.order.directDiscountPercent);
  const quote = await workerQuote(page);
  expect(quote.subtotal, 'the Worker prices the page\'s own prices').toBe(food);
  expect(quote.discount).toBe(Math.round(food * pct / 100));
  expect(quote.fee).toBe(0);
  expect(quote.total).toBe(quote.subtotal - quote.discount);

  await fillContact(page, {});
  await scheduleNextOpenSlot(page);
  const announced = await observeAnnounce(page);
  await page.locator('#cartSend').click();
  const { status, body: answer } = await announced();

  /* Every line, in the words the Arabic page itself carries (R3-06): each
     Extra with its quantity and line price, the Hawawshy with its fries as one
     line at the two prices added, the 10 % discount and the total. */
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  const ar = (id) => page.locator(`.mitem[data-item="${id}"] .mname`).first().getAttribute('data-ar');
  for (const x of EXTRAS) {
    expect(message).toContain(`${x.qty}× ${await ar(x.id)} — ${euro((await centsOf(page, x.id)) * x.qty)}`);
  }
  const sandwich = (await centsOf(page, 'hawawshy')) + (await centsOf(page, 'steakhouse-pommes'));
  expect(message).toContain(`1× ${await ar('hawawshy')} + ${await ar('steakhouse-pommes')} — ${euro(sandwich)}`);
  expect(message).toContain(`${pct} %: −${euro(quote.discount)}`);
  expect(message).toContain(euro(quote.total));
  expect(message).toContain('النوع: استلام');
  for (const m of await page.evaluate(() => window.KAIRO_CONFIG.payment.onSite.pickup)) {
    expect(message).toContain(PAY_LABEL.ar[m]);
  }

  expect(status).toBe(200);
  expect(answer.recorded).toBe(true);
  const rows = (await reportedOrders(page)).filter((o) => o.reference === answer.reference);
  expect(rows).toHaveLength(1);
  expect(rows[0].money).toMatchObject({ subtotal: quote.subtotal, discount: quote.discount, deliveryFee: 0, total: quote.total });
});

test('when the browser blocks WhatsApp, the order is still one tap away', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto('/?lang=de');
  await addItem(page, 'zwiebelringe-8-stueck', 1);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  await scheduleNextOpenSlot(page);
  await page.locator('#cartSend').click();

  await expect(page.locator('.cart-sent .cart-blocked')).toBeVisible();
  const link = page.locator('a.cart-send-wa');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toContain('wa.me/');
  expect(decodeURIComponent(href)).toContain('Art: Abholung');
  expect(decodeURIComponent(href)).toContain('Zwiebelringe (8 Stück)');
});

test('a throttled announce records nothing, and the guest\'s order still goes', async ({ page }) => {
  // Fill this address's window, exactly as eleven quick orders would.
  let throttled = null;
  for (let i = 0; i < 12 && !throttled; i++) {
    // One client address for the flood and for the guest below.
    const res = await page.request.post('/api/orders/announce', {
      headers: { 'CF-Connecting-IP': '127.0.0.1' },
      data: { items: { 'zwiebelringe-8-stueck': 1 }, type: 'pickup', name: 'Flood', phone: '+49 1', time: 'x', when: null }
    });
    if (res.status() === 202) throttled = await res.json();
    else expect(res.status(), 'no closure in this test, so each is recorded until the limit').toBe(200);
  }
  expect(throttled, 'the limit is reached within twelve').not.toBeNull();
  expect(throttled).toEqual({ recorded: false });

  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');
  await addItem(page, 'zwiebelringe-8-stueck', 1);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  await scheduleNextOpenSlot(page);
  const announced = await observeAnnounce(page, { ip: '127.0.0.1' });
  await page.locator('#cartSend').click();
  const response = await announced();
  expect(response.status).toBe(202);
  expect(response.body).toEqual({ recorded: false });
  expect(await whatsapp()).toContain('wa.me');
  await expect(page.locator('.cart-sent')).toBeVisible();
});

/* Loop WEBSITE_ORDERING, W01-03. Ordinary opening hours are advice, not a
   lock: only a closure from /admin is a hard stop. A guest who asks for a time
   we are not open is warned, the kitchen is told to check it, and the order is
   still sent and still recorded — the restaurant answers it like a phone call. */
test('a time outside opening hours is flagged for the kitchen, not refused', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');
  await addItem(page, 'zwiebelringe-8-stueck', 1);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  // A moment the served hours say is closed: derived and checked, never typed.
  const closed = await closedSlot(page);
  test.skip(!closed, 'the served hours leave no closed moment within two weeks');
  const slot = await scheduleAt(page, closed);

  const send = page.locator('#cartSend');
  await expect(send).toBeEnabled();
  const announced = await observeAnnounce(page);
  await send.click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('*! Wunschtermin ausserhalb der Öffnungszeiten — bitte prüfen');
  const { status, request, body } = await announced();
  expect(request.when).toEqual(slot);
  expect(status).toBe(200);
  expect(body.recorded).toBe(true);
  expect((await reportedOrders(page)).filter((o) => o.reference === body.reference)).toHaveLength(1);
});
