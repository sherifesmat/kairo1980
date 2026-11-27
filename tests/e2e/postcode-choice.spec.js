/* The delivery postcode is chosen from a list, not typed (PO-15).
   KBOSS loop DELIVERY_PRICING, round 21: G2 (the select and its states), G-Q1
   (grouped by town, postcode visible), G-Q2 (a separate "not listed" enquiry). */

import { test, expect } from '@playwright/test';
import {
  addItem, openBasket, captureWhatsApp, fillContact, chooseDelivery, choosePickup,
  requireDelivery, choosePostcode, serviceMode
} from './helpers.js';
import { signIn, setServiceMode } from './fixtures.js';

/* The deploy gate runs against the repository's own config.js, whose service
   mode is whatever the restaurant runs today (pickup since October). There the
   two @gate scenarios below would skip, and the gate rightly refuses a skip:
   the first production run of 07a93e0 stopped exactly there. So in the gate
   project, which is serial (one worker), the scenario puts the service into
   delivery itself and puts it back afterwards. In the parallel mobile/desktop
   projects nothing is switched: shared state would disturb other tests, and
   requireDelivery skips as before. */
let restoreMode = null;
test.afterEach(async ({ page }) => {
  if (restoreMode) { await setServiceMode(page, restoreMode); restoreMode = null; }
});

async function deliveryBasket(page, testInfo) {
  await page.goto('/');
  if (testInfo.project.name === 'gate' && await serviceMode(page) === 'pickup') {
    await signIn(page);
    await setServiceMode(page, 'delivery');
    restoreMode = 'pickup';
    await page.goto('/');
    expect(await serviceMode(page), 'the gate runs its delivery scenario in delivery').toBe('delivery');
  }
  await requireDelivery(page, testInfo);
  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await chooseDelivery(page);
}

test('the list offers every town of 68723, each with its postcode in sight', async ({ page }, testInfo) => {
  await deliveryBasket(page, testInfo);
  const select = page.locator('#fPlz');
  for (const town of ['Oftersheim', 'Plankstadt', 'Schwetzingen']) {
    // Led by a left-to-right mark, so the Arabic page keeps the address order.
    await expect(select.locator(`optgroup[label="${town}"] option[value="68723|${town}"]`))
      .toHaveText('\u200E68723 ' + town);
  }
  // Our own district labels are never offered as a choice.
  await expect(select.locator('option', { hasText: 'Schwetzingen / Plankstadt' })).toHaveCount(0);
  await expect(select.locator('option', { hasText: '(Neuenheim)' })).toHaveCount(0);
  // A town with several served postcodes lists each one under the town.
  await expect(select.locator('optgroup[label="Heidelberg"] option')).toHaveCount(6);
  // The first option is the placeholder, the last one the enquiry.
  await expect(select.locator('option').first()).toHaveAttribute('value', '');
  await expect(select.locator('option').last()).toHaveAttribute('value', 'not-listed');
});

test('@gate a chosen town shows its fee, and the order names the postcode and the town', async ({ page }, testInfo) => {
  const whatsapp = await captureWhatsApp(page);
  await deliveryBasket(page, testInfo);
  await fillContact(page, { address: 'Hauptstraße 1', postcode: '68723', town: 'Oftersheim' });
  await expect(page.locator('#cartZoneHint')).toContainText('Oftersheim');
  await expect(page.locator('#cartZoneHint')).toContainText('2,00');
  await expect(page.locator('#fPlzOtherWrap')).toBeHidden();
  await page.locator('#cartSend').click();
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('Hauptstraße 1, 68723 Oftersheim');
});

test('the placeholder is not a destination: the order is not sent without a choice', async ({ page }, testInfo) => {
  const whatsapp = await captureWhatsApp(page);
  await deliveryBasket(page, testInfo);
  await fillContact(page, { address: 'Hauptstraße 1' });
  await page.locator('#cartSend').click();
  await expect(page.locator('#fPlz')).toHaveClass(/is-invalid/);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__waUrl)).toBeNull();
});

test('"postcode not listed" is an enquiry: its own field, its own wording, no fee', async ({ page }, testInfo) => {
  const whatsapp = await captureWhatsApp(page);
  await deliveryBasket(page, testInfo);
  await fillContact(page, { address: 'Teststr. 1' });
  await page.locator('#fPlz').selectOption('not-listed');
  await expect(page.locator('#fPlzOtherWrap')).toBeVisible();
  await expect(page.locator('#cartZoneHint')).toHaveClass(/is-unknown/);
  await expect(page.locator('#cartSend')).toHaveText('Unverbindliche Anfrage senden');

  // Five digits, or the enquiry is not sent.
  await page.locator('#fPlzOther').fill('6911');
  await page.locator('#cartSend').click();
  await expect(page.locator('#fPlzOther')).toHaveClass(/is-invalid/);

  // The sum is the food alone, said so, and no fee is claimed or waived.
  await expect(page.locator('.cart-sum.is-total')).toContainText('Essen, ohne Lieferung');

  await page.locator('#fPlzOther').fill('69118');
  await page.locator('#cartSend').click();
  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('69118');
  expect(message).toContain('Essen, ohne Lieferung');
  expect(message).not.toMatch(/^Lieferung: /m);   // no fee line
});

for (const typed of ['69118', '68723']) {
  test(`${typed === '68723' ? '@gate ' : ''}an enquiry for ${typed} is never paid for and never recorded as an order`, async ({ page }, testInfo) => {
    const announced = [];
    const paymentsAsked = [];
    await page.route('**/api/orders/announce', (route) => {
      announced.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: '{"recorded":true}' });
    });
    await page.route('**/api/payments', (route) => { paymentsAsked.push(1); return route.abort(); });
    await captureWhatsApp(page);
    await deliveryBasket(page, testInfo);
    await fillContact(page, { address: 'Teststr. 1' });
    const online = page.locator('[data-pay="online"]');
    if (await online.count()) await online.click();
    await page.locator('#fPlz').selectOption('not-listed');
    // A postcode we serve, typed as an enquiry, stays an enquiry until chosen.
    await page.locator('#fPlzOther').fill(typed);
    await expect(page.locator('#cartSend')).toHaveText('Unverbindliche Anfrage senden');
    await page.locator('#cartSend').click();
    await expect(page.locator('.cart-sent.is-request')).toBeVisible();
    await expect(page.locator('.cart-pay-step')).toHaveCount(0);
    expect(announced.length).toBe(0);
    expect(paymentsAsked.length).toBe(0);
  });
}

test('switching to pickup and back keeps the choice, and pickup needs none', async ({ page }, testInfo) => {
  await deliveryBasket(page, testInfo);
  await choosePostcode(page, '68799');
  await choosePickup(page);
  await expect(page.locator('#fAddressWrap')).toBeHidden();
  await chooseDelivery(page);
  await expect(page.locator('#fPlz')).toHaveValue('68799|Reilingen');
});

test('the choice survives a language change', async ({ page }, testInfo) => {
  await deliveryBasket(page, testInfo);
  await choosePostcode(page, '68723', 'Plankstadt');
  // From the page, not from inside the open basket: its backdrop covers the header.
  await page.locator('#cartClose').click();
  await page.locator('[data-lang="en"]').first().click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await openBasket(page);
  await expect(page.locator('#fPlz')).toHaveValue('68723|Plankstadt');
  await expect(page.locator('#fPlz option').last()).toHaveText('Postcode not listed? Send an enquiry');
});
