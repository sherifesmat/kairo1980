/* A disposable local D1 database. No customer orders, payments or live admin settings. */
import { test, expect } from '@playwright/test';
import { addItem, openBasket } from './helpers.js';

test.describe.configure({ mode: 'serial' });
async function setMode(page, mode) {
  const response = await page.request.post('/admin/service-mode', {
    headers: { Origin: 'http://127.0.0.1:8788' }, form: { mode }
  });
  expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/admin/login', {
    headers: { Origin: 'http://127.0.0.1:8788' },
    form: { username: process.env.ADMIN_USER || 'devuser', password: process.env.ADMIN_PASSWORD || 'dev-password-not-a-real-one' }
  });
  expect(login.ok()).toBeTruthy();
  await setMode(page, 'pickup');
});

test.afterEach(async ({ page }) => { await setMode(page, 'pickup'); });

for (const language of ['de', 'en', 'ar']) {
  for (const width of [390, 1280]) {
    test(`pickup guide and checkout are coherent in ${language} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?lang=' + language);
      await expect(page.locator('.pickup-guide')).toBeVisible();
      await expect(page.locator('#pickupWeek')).toContainText('11:00–21:00');
      await expect(page.locator('#pickupWeek')).not.toContainText('undefined');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await addItem(page, 'hummus');
      await openBasket(page);
      await expect(page.locator('[data-type="delivery"]')).toHaveCount(0);
      await expect(page.locator('#fAddressWrap')).toBeHidden();
      await expect(page.locator('#cartLeadNote')).toHaveCount(0);
      await page.goto('/firmencatering?lang=' + language);
      await expect(page.locator('#businessHours')).toContainText('11:00–21:00');
      await expect(page.locator('#serviceName')).not.toContainText('Rhein-Neckar');
      await expect(page.locator('#businessTiming')).not.toContainText('2');
    });
  }
}

test('switching back restores the delivery UI and hides the temporary guide', async ({ page }) => {
  await setMode(page, 'delivery');
  await page.goto('/?lang=en');
  await expect(page.locator('.pickup-guide')).toBeHidden();
  await expect(page.locator('#liefergebiet')).toBeVisible();
  await expect(page.locator('#mehrLesenContent')).toContainText('delivered straight to your door');
  await addItem(page, 'hummus');
  await openBasket(page);
  await expect(page.locator('[data-type="delivery"]')).toBeVisible();
});
