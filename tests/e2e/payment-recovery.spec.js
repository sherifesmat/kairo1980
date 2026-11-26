/* Coming back to a payment after a reload (DELIVERY_PRICING DP-23-02, DP-24-02).

   The order a payment was made for is kept on this device beside the payment
   id, with the server's own lines and figures and never the guest's name, phone
   or address. After a reload:
   - money never handed over: the guest is asked for their details, and the
     order is told from the record, never from the menu or the basket now;
   - money handed over whose answer was lost: asked quietly, with no contact
     fields, and forgotten only on the server's "recorded" for that reference;
   - anything the page cannot tell as an order, or a conflict, or a payment not
     yet confirmed: on screen, by reference, with "do not pay again".

   The provider and the server's answers are stubbed in the browser; what the
   Worker does with them is covered by the integration suites. */

import { test, expect } from '@playwright/test';
import { addItem, captureWhatsApp } from './helpers.js';

const RECORD_KEY = 'kairo.payment.v1';

/* A paid delivery to Reilingen, at prices that are not today's, including a dish
   no longer on the menu, as the server priced it: 53.00 - 5.30 + 1.00. */
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
const CONTACT = ['name', 'phone', 'address', 'notes', 'company'];

test('@gate a paid delivery is told as it was paid for: its dishes, its prices, its fee, its town', async ({ page }) => {
  const { whatsapp, announced, stored } = await remembering(page, { record: { order: PAID_ORDER } });
  // The guest has started another basket since; it is theirs and stays.
  await addItem(page, 'koshary', 1);
  await page.reload();

  // Nothing is sent before the guest has said who they are: the device kept no contact.
  const form = page.locator('#cartRecoverForm');
  await expect(form).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.cart-recover')).toContainText('K-PAID1');
  await expect(page.locator('.cart-recover')).toContainText('68799 Reilingen');
  expect(announced.length).toBe(0);
  await page.locator('#cartRecoverSend').click();
  expect(announced.length).toBe(0);
  await expect(page.locator('#rName')).toHaveClass(/is-invalid/);

  await page.locator('#rName').fill('Erika Gast');
  await page.locator('#rPhone').fill('+49 176 7654321');
  await page.locator('#rAddress').fill('Hauptstraße 7');
  await page.locator('#rNotes').fill('Klingel defekt');
  await page.locator('#cartRecoverSend').click();

  await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
  expect(announced[0]).toMatchObject({ items: PAID_ORDER.items, type: 'delivery', postcode: '68799',
                                       town: 'Reilingen', paymentId: 'PAY-REMEMBERED',
                                       name: 'Erika Gast', phone: '+49 176 7654321',
                                       address: 'Hauptstraße 7', notes: 'Klingel defekt' });
  expect(announced[0].recovery).toBeUndefined();
  const message = await text(whatsapp);
  for (const part of ['1× Alte Speise — 34,00', '2× Hummus — 19,00', '53,00', '5,30', '1,00', '48,70',
                      '68799 Reilingen', 'K-PAID1', 'Erika Gast']) {
    expect(message).toContain(part);
  }
  expect(message).not.toContain('Koshary');
  expect(message).not.toContain('außerhalb');
  await expect(page.locator('#cartFabCount')).toHaveText('1', { timeout: 10000 });
  await expect.poll(stored).toBeNull();   // recorded under its reference: forgotten
});

test('a paid pickup coming back asks for name and phone, never an address', async ({ page }) => {
  const pickup = { ...PAID_ORDER, type: 'pickup', postcode: null, town: null, fee: 0, total: 4770 };
  const { announced } = await remembering(page, { record: { order: pickup, amount: 4770 }, amount: 4770 });
  await page.reload();
  await expect(page.locator('#cartRecoverForm')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#rAddress')).toHaveCount(0);
  await page.locator('#rName').fill('Erika Gast');
  await page.locator('#rPhone').fill('+49 176 7654321');
  await page.locator('#cartRecoverSend').click();
  await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
  expect(announced[0]).toMatchObject({ type: 'pickup', name: 'Erika Gast', paymentId: 'PAY-REMEMBERED' });
});

for (const [name, record, amount] of [
  ['whose figures do not add up to it', { order: PAID_ORDER }, 4770],
  ['remembered by an older page, without its order', {}, 4870],
  ['whose lines are not the basket', { order: { ...PAID_ORDER, items: { hummus: 2 } } }, 4870],
  ['past its hour on this device', { order: PAID_ORDER, at: Date.now() - 2 * 3600000 }, 4870]
]) {
  test(`a payment ${name} is shown by its reference, never handed over as the basket now`, async ({ page }) => {
    const { announced, stored } = await remembering(page, { record, amount });
    await addItem(page, 'koshary', 1);
    await page.reload();
    const known = page.locator('.cart-pay-step');
    await expect(known).toContainText('Bitte nicht noch einmal bezahlen', { timeout: 15000 });
    await expect(known).toContainText('K-PAID1');
    await expect(page.locator('[data-payact="onsite"]')).toHaveCount(0);
    expect(announced.length).toBe(0);
    const kept = await stored();
    expect(kept.id).toBe('PAY-REMEMBERED');
    if (record.at) expect(kept.order).toBeUndefined();   // reference only, after the hour
    // Read and understood: only then is it let go.
    await page.locator('[data-payact="ack"]').click();
    await expect.poll(stored).toBeNull();
    await expect(page.locator('#cartFabCount')).toHaveText('1');
  });
}

test('a payment that may still settle is kept, on screen, and nothing else is offered', async ({ page }) => {
  const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER }, status: 'approved' });
  await page.reload();
  const step = page.locator('.cart-pay-step');
  await expect(step).toContainText('Zahlung noch nicht bestätigt', { timeout: 15000 });
  await expect(step).toContainText('nicht noch einmal bezahlen');
  await expect(step).toContainText('K-PAID1');
  await expect(page.locator('[data-payact="onsite"]')).toHaveCount(0);
  await expect(page.locator('[data-payact="retry"]')).toHaveCount(0);
  expect(announced.length).toBe(0);
  expect((await stored()).id).toBe('PAY-REMEMBERED');
});

for (const answer of [202, 'network', 503]) {
  test(`a lost answer retried quietly (${answer}) sends no contact, keeps the record, and the next visit finishes it`, async ({ page }) => {
    const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER, handedOver: true },
                                                         announce: answer, body: { recorded: false } });
    await page.reload();
    await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
    expect(announced[0]).toMatchObject({ recovery: true, paymentId: 'PAY-REMEMBERED', items: PAID_ORDER.items });
    for (const field of CONTACT) expect(announced[0][field]).toBeUndefined();
    await page.waitForTimeout(500);
    await expect(page.locator('.cart-sent')).toHaveCount(0);
    expect((await stored()).handedOver).toBe(true);

    await page.unroute('**/api/orders/announce');
    await page.route('**/api/orders/announce', (route) => {
      announced.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: '{"recorded":true,"reference":"K-PAID1"}' });
    });
    await page.reload();
    await expect.poll(() => announced.length, { timeout: 15000 }).toBe(2);
    await expect(page.locator('.cart-sent')).toHaveCount(0);
    await expect.poll(stored).toBeNull();
  });
}

for (const [name, body] of [
  ['an answer that does not say recorded', { recorded: false }],
  ['recorded under another reference', { recorded: true, reference: 'K-OTHER' }]
]) {
  test(`a quiet retry answered with ${name} keeps the record`, async ({ page }) => {
    const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER, handedOver: true }, body });
    await page.reload();
    await expect.poll(() => announced.length, { timeout: 15000 }).toBe(1);
    await page.waitForTimeout(500);
    expect((await stored()).id).toBe('PAY-REMEMBERED');
  });
}

test('a quiet retry that meets a conflict is put on the screen, and kept until the guest has read it', async ({ page }) => {
  const { stored } = await remembering(page, { record: { order: PAID_ORDER, handedOver: true }, announce: 409,
    body: { recorded: false, reason: 'payment_conflict', reference: 'K-PAID1' } });
  await page.reload();
  const step = page.locator('.cart-pay-step');
  await expect(step).toContainText('passt nicht zu Ihrer Zahlung', { timeout: 15000 });
  await expect(step).toContainText('K-PAID1');
  expect((await stored()).id).toBe('PAY-REMEMBERED');
  await page.locator('[data-payact="ack"]').click();
  await expect.poll(stored).toBeNull();
});

test('a quiet retry the server holds no order for asks the guest for their details', async ({ page }) => {
  const { announced } = await remembering(page, { record: { order: PAID_ORDER, handedOver: true }, announce: 409,
    body: { recorded: false, reason: 'details_needed', reference: 'K-PAID1' } });
  await page.reload();
  await expect(page.locator('#cartRecoverForm')).toBeVisible({ timeout: 15000 });
  expect(announced.length).toBe(1);
});

test('a payment the server says is not settled yet, handed over, tells the guest not to pay again', async ({ page }) => {
  const { stored } = await remembering(page, { record: { order: PAID_ORDER }, announce: 409,
    body: { recorded: false, reason: 'payment_unsettled', reference: 'K-PAID1' } });
  await page.reload();
  await expect(page.locator('#cartRecoverForm')).toBeVisible({ timeout: 15000 });
  await page.locator('#rName').fill('Erika Gast');
  await page.locator('#rPhone').fill('+49 176 7654321');
  await page.locator('#rAddress').fill('Hauptstraße 7');
  await page.locator('#cartRecoverSend').click();
  await expect(page.locator('.cart-sent-check')).toContainText('noch nicht bestätigt');
  expect((await stored()).id).toBe('PAY-REMEMBERED');
});

test('a late answer about an older payment never forgets a newer one', async ({ page }) => {
  const { stored } = await remembering(page, { record: { order: PAID_ORDER }, status: 'approved' });
  await page.reload();
  await expect(page.locator('.cart-pay-step')).toContainText('noch nicht bestätigt', { timeout: 15000 });
  await page.evaluate(() => {
    localStorage.setItem('kairo.payment.v1', JSON.stringify({ id: 'PAY-NEWER', reference: 'K-NEW1', amount: 100, at: Date.now() }));
    window.KairoPay.forget('PAY-REMEMBERED');
  });
  expect((await stored()).id).toBe('PAY-NEWER');
});

test('a no-money payment on this device is let go quietly', async ({ page }) => {
  const { announced, stored } = await remembering(page, { record: { order: PAID_ORDER }, status: 'failed' });
  await page.reload();
  await expect.poll(stored, { timeout: 15000 }).toBeNull();
  expect(announced.length).toBe(0);
  await expect(page.locator('.cart-pay-step')).toHaveCount(0);
});
