/* The KAIRO Bowl, the Menüs and the extras, as a guest meets them.

   The unit tests prove the Worker prices a line key correctly. These prove the
   page builds that key from what the guest ticked, shows the price the Worker
   will charge, and says what is missing in words — in all three languages. */

import { test, expect } from '@playwright/test';
import { openBasket, choosePickup, fillContact, captureWhatsApp } from './helpers.js';

async function openChooser(page, id) {
  const row = page.locator(`.mitem[data-item="${id}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator('[data-act="choose"]').click();
  const dialog = page.locator('.chooser');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a bowl is one dish on the menu, with its toppings priced in its row', async ({ page }) => {
  await page.goto('/?lang=de');
  const bowl = page.locator('.mitem[data-item="kairo-bowl"]');
  await expect(bowl.locator('.mchoice[data-option]')).toHaveCount(6);   // 2 bases, 4 toppings
  // A base has its price; a topping adds to it.
  await expect(bowl.locator('.mchoice[data-option="nudeln"] .mchoice-price')).toHaveText('9,00 €');
  await expect(bowl.locator('.mchoice[data-option="kebda"] .mchoice-price')).toHaveText('+8,50 €');
  // The old plate section is gone, and nothing on the page still points at it.
  await expect(page.locator('.mitem[data-item="kebda"]')).toHaveCount(0);
  await expect(page.locator('.mitem[data-item="haehnchenschlegel"]')).toHaveCount(0);
  await expect(page.locator('.cat-name', { hasText: 'Aus unserer Küche' })).toHaveCount(0);
});

test('the bowl asks for what is missing, by name, instead of refusing silently', async ({ page }) => {
  await page.goto('/?lang=de');
  const dialog = await openChooser(page, 'kairo-bowl');
  const add = dialog.locator('[data-act="chooser-add"]');
  await expect(add).toBeEnabled();

  await add.click();
  await expect(dialog.locator('#chooserHint')).toHaveText('Bitte wähle: Basis');
  await dialog.locator('input[value="nudeln"]').check();
  await add.click();
  await expect(dialog.locator('#chooserHint')).toHaveText('Bitte wähle: Topping');
  await expect(page.locator('#cartFab')).toBeHidden();
});

test('topping and extras set the price, and the same bowl twice is one line', async ({ page }) => {
  await page.goto('/?lang=de');
  let dialog = await openChooser(page, 'kairo-bowl');
  await dialog.locator('input[value="nudeln"]').check();
  await dialog.locator('input[value="kebda"]').check();
  await dialog.locator('input[value="hausgemachter-karkadeh-0-5-l"]').check();
  // One drink at most: the other drinks go quiet once one is ticked.
  await expect(dialog.locator('input[value="fritz-kola-0-33-l"]')).toBeDisabled();
  await expect(dialog.locator('[data-act="chooser-add"]')).toContainText('22,00');   // 17,50 + 4,50
  await dialog.locator('[data-act="chooser-add"]').click();
  await expect(dialog).toBeHidden();

  dialog = await openChooser(page, 'kairo-bowl');
  await dialog.locator('input[value="nudeln"]').check();
  await dialog.locator('input[value="kebda"]').check();
  await dialog.locator('input[value="hausgemachter-karkadeh-0-5-l"]').check();
  await dialog.locator('[data-act="chooser-add"]').click();

  await expect(page.locator('.mitem[data-item="kairo-bowl"] .qty-in')).toHaveText('2 im Warenkorb');
  await openBasket(page);
  const lines = page.locator('.cart-line');
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toContainText('KAIRO Bowl (Nudeln, Kebda) + Hausgemachter Karkadeh (0,5 l)');
  await expect(lines.first().locator('.qty-num')).toHaveText('2');
  await expect(lines.first().locator('.cart-line-price')).toContainText('44,00');
});

test('a Menü costs the same whichever drink is chosen', async ({ page }) => {
  await page.goto('/?lang=de');
  const dialog = await openChooser(page, 'hawawshy-menue');
  await expect(dialog.locator('.chooser-rule')).toContainText('im Preis enthalten');
  await dialog.locator('input[value="hausgemachter-karkadeh-0-5-l"]').check();
  await expect(dialog.locator('[data-act="chooser-add"]')).toContainText('23,00');
  await dialog.locator('input[value="mineralwasser-still-0-25-l"]').check();
  await expect(dialog.locator('[data-act="chooser-add"]')).toContainText('23,00');
});

test('the order the restaurant reads names every choice, and the Worker prices it', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');
  const dialog = await openChooser(page, 'hawawshy');
  await dialog.locator('input[value="steakhouse-pommes"]').check();
  await dialog.locator('[data-act="chooser-add"]').click();

  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  const announced = page.waitForResponse((r) => r.url().includes('/api/orders/announce'));
  await page.locator('#cartSend').click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('1× Hawawshy + Steakhouse Pommes — 23,00');
  // The server accepted the key it was sent: a 400 here would mean the page
  // and the Worker disagree about what a Hawawshy with fries is.
  // (202 is the per-address throttle, which records nothing but is not a no.)
  expect([200, 202]).toContain((await announced).status());
});

test('in Arabic the chooser reads right to left, in Arabic', async ({ page }) => {
  await page.goto('/?lang=ar');
  const dialog = await openChooser(page, 'kairo-bowl');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(dialog.locator('.chooser-title')).toContainText('طبق KAIRO');
  await expect(dialog.locator('.chooser-legend').first()).toHaveText('القاعدة');
  await expect(dialog.locator('label', { hasText: 'مكرونة' })).toHaveCount(1);
  await expect(dialog.locator('[data-act="chooser-add"]')).toContainText('ضيف للسلة');
});

test('a basket holding a dish that left the menu is cleaned, and the guest told', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('kairo.cart.v2', JSON.stringify({
      savedAt: Date.now(), items: { kebda: 2, hummus: 1 }
    }));
  });
  await page.goto('/?lang=de');
  await openBasket(page);
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('#cartSoldOutNote')).toContainText('nicht mehr auf der Karte');
});
