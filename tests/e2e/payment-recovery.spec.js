/* Coming back to a payment after a reload (DELIVERY_PRICING DP-23-02).

   The order a payment was made for is frozen with its figures at the pay step
   and kept on this device beside the payment id. After a reload it is told,
   and handed over, from that record, never from the menu, the basket or the
   service mode as they are by then; and the record is kept until the server has
   the order (or has flagged it for a person).

   The provider and the server's answers are stubbed in the browser; what the
   Worker does with them is covered by the integration suites. */

import { test, expect } from '@playwright/test';
import { addItem, captureWhatsApp } from './helpers.js';

const RECORD_KEY = 'kairo.payment.v1';

/* A paid delivery to Reilingen, at prices that are not today's, including a dish
   no longer on the menu, frozen as the pay step froze it: 53.00 - 5.30 + 1.00. */
const PAID_ORDER = {
  items: { 'alte-speise': 1, hummus: 2 }, type: 'delivery', business: false,
  postcode: '68799', town: 'Reilingen', time: 'Heute, 19:30', when: null,
  lines: [{ id: 'alte-speise', name: 'Alte Speise', qty: 1, amount: 3400 },
          { id: 'hummus', name: 'Hummus', qty: 2, amount: 1900 }],
  subtotal: 5300, discount: 530, fee: 100, total: 4870
};

async function remembering(page, { record, status = 'captured', amount = 4870, announce = 200, body } = {}) {
  const whatsapp = await captureWhatsApp(page);
  const announced = [];
  await page.route('**/api/payments/config', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ online: true, methods: ['paypal'] }) }));
  await page.route('**/api/payments/PAY-REMEMBERED', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ payment: { id: 'PAY-REMEMBERED', reference: 'K-PAID1', status, amount } }) }));
  await page.route('**/api/orders/announce', (route) => {
    announced.push(route.request().postDataJSON());
    if (announce === 'network') return route.abort();
    return route.fulfill({ status: announce, contentType: 'application/json',
      body: JSON.stringify(body || { recorded: true, reference: 'K-PAID1' }) });
  });
  await page.goto('/');
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [RECORD_KEY, { id: 'PAY-REMEMBERED', reference: 'K-PAID1', amount: 4870, at: Date.now(), ...record }]);
  return { whatsapp, announced, stored: () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), RECORD_KEY) };
}

const text = async (whatsapp) => decodeURIComponent((await whatsapp()).split('?text=')[1]);

test('@gate a paid delivery is told as it was paid for: its dishes, its prices, its fee, its town', async ({ page }) => {
  const { whatsapp, announced, stored } = await remembering(page, { record: { order: PAID_ORDER } });
  // The guest has started another basket since; it is theirs and stays.
  await addItem(page, 'koshary', 1);
  await page.reload();

  await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
  expect(announced[0]).toMatchObject({ items: PAID_ORDER.items, type: 'delivery', postcode: '68799',
                                       town: 'Reilingen', paymentId: 'PAY-REMEMBERED' });
  const message = await text(whatsapp);
  for (const part of ['1× Alte Speise — 34,00', '2× Hummus — 19,00', '53,00', '5,30', '1,00', '48,70',
                      '68799 Reilingen', 'K-PAID1']) {
    expect(message).toContain(part);
  }
  expect(message).not.toContain('Koshary');
  expect(message).not.toContain('außerhalb');
  await expect(page.locator('#cartFabCount')).toHaveText('1', { timeout: 10000 });
  await expect.poll(stored).toBeNull();   // recorded: forgotten
});

test('a payment whose remembered order does not add up to it is not handed over from the page', async ({ page }) => {
  const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER }, amount: 4770 });
  await page.reload();
  await page.waitForTimeout(1500);
  expect(announced.length).toBe(0);
  await expect(page.locator('.cart-sent')).toHaveCount(0);
  expect(await stored()).not.toBeNull();
});

test('a payment remembered by an older page, without its order, is never handed over as the basket now', async ({ page }) => {
  const { announced } = await remembering(page, { record: {} });
  await addItem(page, 'koshary', 1);
  await page.reload();
  await page.waitForTimeout(1500);
  expect(announced.length).toBe(0);
  await expect(page.locator('.cart-sent')).toHaveCount(0);
});

test('a payment that may still settle is kept and not handed over yet', async ({ page }) => {
  const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER }, status: 'approved' });
  await page.reload();
  await page.waitForTimeout(1500);
  expect(announced.length).toBe(0);
  expect((await stored()).id).toBe('PAY-REMEMBERED');
});

for (const [answer, note, kept] of [
  [202, 'Noch nicht im System bestätigt', true],
  ['network', 'Noch nicht im System bestätigt', true],
  [503, 'Noch nicht im System bestätigt', true],
  [409, 'nicht noch einmal bezahlen', false]
]) {
  test(`a handover answered ${answer} says so, and the payment is ${kept ? 'kept for a retry' : 'left to a person'}`, async ({ page }) => {
    const body = answer === 409 ? { recorded: false, reason: 'payment_conflict', reference: 'K-PAID1' } : { recorded: false };
    const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER }, announce: answer, body });
    await page.reload();
    await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
    await expect(page.locator('.cart-sent-check')).toContainText(note);
    if (kept) {
      await expect.poll(async () => (await stored() || {}).handedOver).toBe(true);
      // The next visit hands it over again, quietly: no second confirmation screen.
      await page.unroute('**/api/orders/announce');
      await page.route('**/api/orders/announce', (route) => {
        announced.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: '{"recorded":true,"reference":"K-PAID1"}' });
      });
      await page.reload();
      await expect.poll(() => announced.length, { timeout: 15000 }).toBe(2);
      await expect(page.locator('.cart-sent')).toHaveCount(0);
      await expect.poll(stored).toBeNull();
    } else {
      await expect.poll(stored).toBeNull();
    }
  });
}

test('a payment the server says is not settled yet is kept, and the guest is told not to pay again', async ({ page }) => {
  const { stored } = await remembering(page, { record: { order: PAID_ORDER }, announce: 409,
    body: { recorded: false, reason: 'payment_unsettled', reference: 'K-PAID1' } });
  await page.reload();
  await expect(page.locator('.cart-sent-check')).toContainText('noch nicht bestätigt');
  expect((await stored()).id).toBe('PAY-REMEMBERED');
});
