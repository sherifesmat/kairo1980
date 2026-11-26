/* Paying, from the guest's side.

   Every test here is a moment where a real customer either completes an order
   or gives up: the choice of method, the amount they are asked to confirm,
   what happens when the card is refused, and whether the restaurant is told
   the truth about it afterwards. */

import { test, expect } from '@playwright/test';
import {
  addItem, openBasket, fillContact, captureWhatsApp, stubPayments, choosePickup,
  chooseDelivery, serviceMode, choosePostcode
} from './helpers.js';

/** Basket → contact filled → "pay online" chosen → submitted. */
async function reachPaymentStep(page) {
  await page.goto('/');
  await addItem(page, 'hummus', 2);           // 19.00 − 10 % = 17.10
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  await page.locator('[data-pay="online"]').click();
  await page.locator('#cartSend').click();
  await expect(page.locator('.cart-pay-step')).toBeVisible();
}

test('nothing is loaded from PayPal unless the guest chooses to pay online', async ({ page }) => {
  const external = [];
  page.on('request', (req) => {
    const host = new URL(req.url()).host;
    if (!host.includes('127.0.0.1') && !host.includes('localhost')) external.push(req.url());
  });

  await stubPayments(page);
  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);

  expect(external, 'a guest reading the menu must reach no third party').toEqual([]);
});

test('the button says what pressing it obliges you to (§ 312j Abs. 3 BGB)', async ({ page }) => {
  // Where a consumer contract concluded electronically obliges payment, the
  // button must say so in the statute's own words. That is true of the online
  // payment flow, where money moves on this page before anyone confirms
  // anything. It is not true of the WhatsApp flow, which prepares a message
  // and nothing else — the contract forms when the restaurant answers.
  await stubPayments(page);
  await page.goto('/?lang=de');
  await addItem(page, 'hummus', 1);
  await openBasket(page);

  const button = page.locator('#cartSend');

  await page.locator('[data-pay="onsite"]').click();
  await expect(button).toHaveText('Per WhatsApp senden');

  await page.locator('[data-pay="online"]').click();
  await expect(button).toHaveText('Zahlungspflichtig bestellen');

  // An enquiry with no agreed price obliges nobody, whatever was chosen.
  // Only a delivery outside the area is an enquiry; pickup always has a price.
  if (await serviceMode(page) === 'pickup') return;
  await chooseDelivery(page);
  await choosePostcode(page, '10115');
  await expect(button).toHaveText('Unverbindliche Anfrage senden');
});

test('the guest is shown the amount before being asked to pay it', async ({ page }) => {
  await stubPayments(page);
  await reachPaymentStep(page);

  await expect(page.locator('.cart-pay-amount strong')).toContainText('17,10');
  await expect(page.locator('.cart-pay-trust')).toBeVisible();
});

test('only the methods that actually work are drawn', async ({ page }) => {
  // The server offers all four. This browser has no Apple Pay and no Google
  // Pay, so exactly two must appear — a wallet button that cannot complete is
  // a dead end at the payment step, which is where orders get abandoned.
  await stubPayments(page, { methods: ['applepay', 'googlepay', 'card', 'paypal'] });
  await reachPaymentStep(page);

  const buttons = page.locator('.fake-pay-button');
  /* Room for the same reason the SDK-abort test below gets it: this waits on
     the checkout config, the SDK, and then FOUR methods asked one at a time --
     they are drawn sequentially on purpose, so a payment screen does not
     reshuffle itself as each resolves. Alone that is a few seconds; sharing one
     `wrangler dev` with every other worker it has crossed the suite's 7s. */
  await expect(buttons).toHaveCount(2, { timeout: 20000 });
  await expect(page.locator('.pay-method-applepay')).toHaveCount(0);
  await expect(page.locator('.pay-method-googlepay')).toHaveCount(0);
  // Card first: it needs no PayPal account, so it comes before the one that does.
  await expect(buttons.first()).toHaveAttribute('data-funding', 'card');
});

test('paying successfully tells the restaurant the order is already paid', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await stubPayments(page);
  await reachPaymentStep(page);

  await page.locator('.fake-pay-button').first().click();

  await expect(page.locator('.cart-sent.is-paid')).toBeVisible();
  await expect(page.locator('.cart-pay-ref')).toContainText('K7F3QA');

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('K7F3QA');
  expect(message).toMatch(/ONLINE BEZAHLT|PAID ONLINE/);
  expect(message).toContain('17,10');
  // The basket is emptied only once the order has actually gone.
  await expect(page.locator('#cartFab')).toBeHidden();
});

test('a paid order can still be sent when the browser blocks the popup', async ({ page }) => {
  // This happened in production with real money. window.open runs from a
  // promise after the capture, so there is no user gesture left and the
  // browser blocks it — the guest paid and the order never reached the
  // kitchen, while the screen said WhatsApp had opened.
  //
  // Simulate the block: window.open returns null, exactly as Chrome does.
  await page.addInitScript(() => { window.open = () => null; });
  await stubPayments(page);
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();

  await expect(page.locator('.cart-sent.is-paid')).toBeVisible();

  // A real link, so tapping it is a gesture the browser cannot refuse.
  const send = page.locator('a.cart-send-wa');
  await expect(send).toBeVisible();
  await expect(send).toHaveAttribute('target', '_blank');
  const href = await send.getAttribute('href');
  expect(href).toContain('wa.me/');
  expect(decodeURIComponent(href)).toMatch(/ONLINE BEZAHLT|PAID ONLINE/);

  // And the guest is told the truth rather than reassured.
  await expect(page.locator('.cart-blocked')).toBeVisible();
  await expect(page.locator('.cart-must-send')).toBeVisible();
});

test('the send link is offered even when the popup was NOT blocked', async ({ page }) => {
  // A guest who closes the new tab by reflex still needs a way back.
  // A truthy return is what a browser gives when it allows the popup.
  await page.addInitScript(() => { window.open = () => ({ closed: false }); });
  await stubPayments(page);
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();

  await expect(page.locator('a.cart-send-wa')).toBeVisible();
  await expect(page.locator('.cart-must-send')).toBeVisible();
  await expect(page.locator('.cart-blocked')).toHaveCount(0);
});

test('a cancelled payment charges nothing and keeps the order alive', async ({ page }) => {
  await stubPayments(page, { outcome: 'cancel' });
  await reachPaymentStep(page);

  await page.locator('.fake-pay-button').first().click();

  await expect(page.locator('.cart-pay-step')).toContainText('abgebrochen');
  // Both ways forward are offered — this is the moment an order is lost.
  await expect(page.locator('[data-payact="retry"]')).toBeVisible();
  await expect(page.locator('[data-payact="onsite"]')).toBeVisible();
});

test('the payment is asked for the total on screen, and a changed total stops it', async ({ page }) => {
  const stub = await stubPayments(page);
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();
  // The page names the 17,10 € it showed; the Worker prices the order itself.
  await expect.poll(() => (stub.created || []).length).toBe(1);
  expect(stub.created[0].expectedTotal).toBe(1710);
});

test('@gate when the server prices another total, nothing is charged and the guest is told to look again', async ({ page }) => {
  await stubPayments(page);
  // Registered last, so it answers first: the Worker's refusal of a stale figure.
  await page.route('**/api/payments', (route) => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'total_changed', message: 'The amount has changed.' } })
  }));
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();
  const step = page.locator('.cart-pay-step');
  await expect(step).toContainText('Betrag hat sich inzwischen geändert');
  await expect(step).toContainText('nichts abgebucht');
  // The old figure is not offered again, not even to pay on arrival: reload.
  await expect(page.locator('[data-payact="reload"]')).toBeVisible();
  await expect(page.locator('[data-payact="onsite"]')).toHaveCount(0);
  await expect(page.locator('[data-payact="retry"]')).toHaveCount(0);
});

test('a page too old to name its total is asked to reload, and is charged nothing', async ({ page }) => {
  await stubPayments(page);
  await page.route('**/api/payments', (route) => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'reload_required', message: 'Please reload.' } })
  }));
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();
  await expect(page.locator('.cart-pay-step')).toContainText('nicht mehr aktuell');
  await page.locator('[data-payact="reload"]').click();
  await page.waitForLoadState('load');
  await expect(page.locator('#cartFabCount')).toHaveText('2', { timeout: 10000 });
});

// The reload-after-paying cases live in payment-recovery.spec.js (DP-23-02).

test('a paid handover the server could not match tells the guest not to pay again', async ({ page }) => {
  const stub = await stubPayments(page);
  await page.route('**/api/orders/announce', (route) => {
    stub.announced.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ recorded: false, reason: 'payment_conflict', reference: 'X' }) });
  });
  await captureWhatsApp(page);
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();
  await expect(page.locator('.cart-sent-check')).toContainText('nicht noch einmal bezahlen');
});

test('a declined card says nothing was charged, and offers to pay on arrival', async ({ page }) => {
  await stubPayments(page, { outcome: 'decline' });
  await reachPaymentStep(page);

  await page.locator('.fake-pay-button').first().click();

  const step = page.locator('.cart-pay-step');
  await expect(step).toContainText('fehlgeschlagen');
  await expect(step).toContainText('abgebucht');   // "nothing was charged"
  await expect(page.locator('[data-payact="onsite"]')).toBeVisible();
});

test('@gate after a failed payment the order can still be sent, and says pay on arrival', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  const stub = await stubPayments(page, { outcome: 'decline' });
  await reachPaymentStep(page);

  await page.locator('.fake-pay-button').first().click();
  await page.locator('[data-payact="onsite"]').click();

  await expect(page.locator('.cart-sent')).toBeVisible();
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  // It must NOT claim to be paid.
  expect(message).not.toMatch(/ONLINE BEZAHLT|PAID ONLINE/);
  expect(message).toMatch(/Bargeld|EC-|Kreditkarte/);
  expect(message).toContain('Abholung');

  // What the page told the server (the provider is stubbed, so only the
  // outbound request is asserted — W02-05): a pickup, and no claim of a
  // payment, so the Worker records and announces it as to be paid on site.
  await expect.poll(() => stub.announced.length).toBe(1);
  expect(stub.announced[0].type).toBe('pickup');
  expect(stub.announced[0].paymentId == null).toBe(true);
});

test('a payment still being checked is handed over as pending, not as paid', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await stubPayments(page, { outcome: 'pending' });
  await reachPaymentStep(page);

  await page.locator('.fake-pay-button').first().click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toMatch(/Prüfung|review|مراجعة/);
  expect(message).not.toMatch(/ONLINE BEZAHLT|PAID ONLINE/);
});

test('the guest can back out of paying before starting, without losing the order', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await stubPayments(page);
  await reachPaymentStep(page);

  await page.locator('[data-payact="onsite"]').click();

  await expect(page.locator('.cart-sent')).toBeVisible();
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('Hummus');
  expect(message).not.toMatch(/ONLINE BEZAHLT|PAID ONLINE/);
});

test('when the provider cannot be reached the guest is not stranded', async ({ page }) => {
  await stubPayments(page);
  // The SDK never loads — a train, a blocked host, an outage.
  await page.route('**/sdk/js*', (route) => route.abort());
  await reachPaymentStep(page);

  /* Longer than the suite's default on purpose. Reaching 'unavailable' costs two
     round trips to the dev server -- /api/payments/config, then the aborted SDK
     load -- and every worker in the run shares one `wrangler dev`. Alone this
     settles in well under a second; under load it has crossed 7s and failed a
     test that was right about the site. The wait is for the harness, not for a
     slowness a guest would ever see. */
  const settles = { timeout: 20000 };
  await expect(page.locator('.cart-pay-step')).toContainText('nicht verfügbar', settles);
  await expect(page.locator('[data-payact="onsite"]')).toBeVisible(settles);
});

test('online payment is never offered when the server says it is off', async ({ page }) => {
  await page.route('**/api/payments/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ online: false, methods: [] })
    }));

  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);

  await expect(page.locator('[data-pay="online"]')).toHaveCount(0);
  await expect(page.locator('#cartSend')).toBeEnabled();
});

test('a refresh after paying does not ask the guest to pay again', async ({ page }) => {
  await stubPayments(page);
  await reachPaymentStep(page);
  await page.locator('.fake-pay-button').first().click();
  await expect(page.locator('.cart-sent.is-paid')).toBeVisible();

  await page.reload();

  // The payment is finished and forgotten; the guest meets a clean site.
  await expect(page.locator('#cartFab')).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem('kairo.payment.v1'));
  expect(stored).toBeNull();
});
