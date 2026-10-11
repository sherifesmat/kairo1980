/* The allergens declared from the owner's product labels, 2026-10-11.
   Loop ALLERGENS_FROM_LABELS in sherifesmat/KBOSS. The printed menus send every
   customer here for allergens, so the site has to say at least what the printed
   sheet says: the cake's egg, the kind of nut, and what the cake's maker warns of. */

import { test, expect } from '@playwright/test';

const codes = (page, id) => page.locator(`.mitem[data-item="${id}"] .mname .mallergen-codes`);
const legendItem = (page, code) =>
  page.locator('#allergenLegend .legend-item', { has: page.locator('b', { hasText: new RegExp(`^${code}$`) }) });
const switchTo = (page, label) => page.evaluate((text) => {
  [...document.querySelectorAll('button, a')].find((e) => e.textContent.trim() === text).click();
}, label);

test('the chocolate cake is declared from its label: gluten, egg, milk', async ({ page }) => {
  await page.goto('/?lang=de');
  await expect(codes(page, 'schokoladentoertchen')).toHaveText('a,c,g');
  await expect(codes(page, 'schokoladentoertchen')).toHaveAttribute('aria-label', 'Allergene: Gluten, Eier, Milch');
  await expect(legendItem(page, 'c')).toHaveText('c Eier');
});

test('the nut is named: walnut on the dishes and in the legend', async ({ page }) => {
  await page.goto('/?lang=de');
  for (const id of ['om-ali', 'sakalans']) {
    await expect(codes(page, id)).toHaveText(/(^|,)h(,|$)/);
    await expect(codes(page, id)).toHaveAttribute('aria-label', /Walnüsse/);
  }
  await expect(legendItem(page, 'h')).toHaveText('h Schalenfrüchte (Walnüsse)');
  await switchTo(page, 'EN');
  await expect(legendItem(page, 'h')).toHaveText('h Tree nuts (walnuts)');
});

test('a generic nut beside the walnut is named too, and neither replaces the other', async ({ page }) => {
  // The legend once named a letter by the first key that mapped to it, so a
  // second key on the same letter could never be shown, whichever came first.
  await page.route((url) => url.pathname === '/', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(/(data-item="koshary"[^>]*?) data-allergens="[^"]*"/, '$1 data-allergens="gluten nuts"');
    await route.fulfill({ response, body });
  });
  await page.goto('/?lang=de');
  await expect(codes(page, 'koshary')).toHaveText('a,h');
  await expect(legendItem(page, 'h')).toHaveText('h Schalenfrüchte (Walnüsse), Schalenfrüchte');
});

test('the cake maker\'s trace warning is in the legend, under the clean dish name, in each language', async ({ page }) => {
  await page.goto('/?lang=de');
  const line = page.locator('#allergenLegend .legend-traces');
  await expect(line).toHaveCount(1);
  // The name is followed directly by the separator: the allergen letters painted
  // into the dish name must never leak into it ("Schokoladentörtchena,c,g").
  await expect(line).toHaveText(/^Schokoladentörtchen — /);
  await expect(line).toContainText('Sellerie');
  await expect(line).toContainText('Erdnüsse');
  await expect(line).not.toContainText('a,c,g');

  await switchTo(page, 'EN');
  await expect(line).toHaveText(/^Schokoladentörtchen — /);
  await expect(line).toContainText('celery');
  await expect(line).toContainText('peanuts');
  await expect(line).not.toContainText('Sellerie');
  await expect(line).not.toContainText('a,c,g');

  // The open-kitchen note is a different statement and stays as it was.
  await expect(page.locator('#allergenLegend .legend-note')).toContainText('open kitchen');
});
