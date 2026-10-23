/* The corporate catering page.

   It exists because a #fragment is not a URL: the offer was real, but the only
   address it had was the homepage, which is correctly optimised for something
   else. So what is asserted here is what makes it a page in its own right —
   its own address, its own legal statements, all three languages, and markup
   that says "this business also caters" without inventing anything the page
   does not state. */

import { test, expect } from '@playwright/test';

const URL = '/firmencatering';

/** The delivery shift, read from the config the page itself reads. */
async function deliveryFrom(page) {
  return page.evaluate(() => window.KAIRO_CONFIG.hours.deliveryFrom || '');
}

test('the page is served on its own URL and says what it is', async ({ page }) => {
  const response = await page.goto(URL);
  expect(response.status()).toBe(200);

  await expect(page).toHaveTitle(/Firmencatering/);
  await expect(page.locator('h1')).toContainText('Firmencatering');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href', 'https://kairo1980.de/firmencatering');

  // The two figures that decide a corporate order come from config.js, so the
  // page can never advertise a threshold the basket does not honour.
  const cfg = await page.evaluate(() => window.KAIRO_CONFIG);
  await expect(page.locator('[data-cfg="freeDeliveryFrom"]'))
    .toHaveText(String(cfg.business.freeDeliveryFrom));
  await expect(page.locator('[data-fact="direct-discount"] [data-cfg="discount"]'))
    .toHaveText(String(cfg.order.directDiscountPercent));
  // Owner, 23.10.2026: no notice is asked of a company, so none is shown.
  await expect(page.locator('body')).not.toContainText('Vorlauf');
});

test('it carries every legal statement a standalone page needs', async ({ page }) => {
  await page.goto(URL);
  const body = page.locator('body');

  // LMIV: the allergen declaration, stated before an order can be placed.
  await expect(body).toContainText('LMIV (EU) Nr. 1169/2011');
  await expect(body).toContainText('Kennzeichnungspflichtige Allergene');
  // PAngV: prices are total prices, delivery costs named separately.
  await expect(body).toContainText('Alle Preise sind Endpreise');
  // § 19 UStG: no VAT is charged, so none is shown.
  await expect(body).toContainText('§ 19 UStG');

  // The claim that would create a real tax liability under § 14c UStG if it
  // were ever written here. It must not appear in any language.
  for (const lang of ['de', 'en', 'ar']) {
    await page.goto(`${URL}?lang=${lang}`);
    await expect(page.locator('body')).not.toContainText(/inkl\.?\s*MwSt|incl\.?\s*VAT|zzgl\.?\s*MwSt/i);
    // The statute citation is not translated — it is a citation.
    await expect(page.locator('body')).toContainText('§ 19 UStG');
  }
});

test('it switches all three languages, and Arabic mirrors the page', async ({ page }) => {
  await page.goto(URL);
  const h1 = page.locator('h1');
  await expect(h1).toContainText('Rhein-Neckar');

  await page.locator('[data-lang="en"]').click();
  await expect(h1).toContainText('Corporate & office catering');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.locator('[data-lang="ar"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(h1).toContainText('راين-نيكار');

  await page.locator('[data-lang="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(h1).toContainText('Firmencatering');
});

test('the delivery towns are rendered from the zone list, not retyped', async ({ page }) => {
  await page.goto(URL);
  const list = page.locator('#areasList');
  await expect(list).toContainText('Walldorf');
  await expect(list).toContainText('69190');

  // Every postcode in the spreadsheet reaches the page, and the copy counts
  // them rather than claiming a round number.
  const zones = await page.evaluate(() => window.KAIRO_ZONES.length);
  const rows = await page.locator('#areasList .area').count();
  expect(rows).toBe(zones);
  await expect(page.locator('.areas-lead')).toContainText(String(zones));
});

test('the collection-only caveat travelled with the offer', async ({ page }) => {
  await page.goto(URL);
  const from = await deliveryFrom(page);

  const lead = page.locator('.areas-lead');
  if (!from) {
    /* A driver is out for the whole opening: the page must not carry a
       restriction that has been lifted. This is the assertion that makes
       emptying `deliveryFrom` at /admin enough on its own, with no copy to
       hunt down.

       Asserted on the CLOCK TIME the clause always carries, not on the word
       "Abholung". This paragraph is `{freeDeliveryAll} {minimumClause}
       {deliveryClause}`, and the minimum clause says "bei Abholung und bei
       Firmenbestellungen entfällt er" — a different rule, correctly still
       there. Reading the bare word made a lifted restriction indistinguishable
       from a minimum that never mentioned one, and failed the page for saying
       exactly the right thing. A time is what only the shift ever prints, and
       it is what the branch below asserts too. */
    await expect(lead).not.toHaveText(/\d{1,2}:\d{2}/);
  } else {
    // It is not: free delivery is qualified where it is promised, with the
    // sentence config writes rather than one typed into this page — and it
    // names the actual shift, so a changed time cannot leave stale copy behind.
    await expect(lead).toContainText('Abholung');
    await expect(lead).toContainText(from);
    await expect(page.locator('.business-notice')).toContainText('Abholung');
  }
});

test('no basket is built on a page that carries no menu', async ({ page }) => {
  await page.goto(URL);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('#cartFab')).toHaveCount(0);
  await expect(page.locator('#cartPanel')).toHaveCount(0);
});

test('the Service markup parses, and its provider is the existing restaurant',
  async ({ page }) => {
    await page.goto(URL);
    // Rewritten by order.js after the page renders; wait for the towns it adds.
    await expect(page.locator('#areasList .area').first()).toBeVisible();

    const data = await page.evaluate(() =>
      JSON.parse(document.getElementById('serviceSchema').textContent));

    expect(data['@type']).toBe('Service');
    expect(data.serviceType).toBeTruthy();
    expect(data.url).toBe('https://kairo1980.de/firmencatering');

    // The same business, by @id — not a second one at the same address.
    expect(data.provider['@id']).toBe('https://kairo1980.de/#restaurant');
    const home = await page.request.get('/');
    const homeSchema = JSON.parse(
      /<script id="restaurantSchema" type="application\/ld\+json">([\s\S]*?)<\/script>/
        .exec(await home.text())[1]);
    expect(homeSchema['@id']).toBe(data.provider['@id']);

    // areaServed comes from the zone list, so it can never name a town we do
    // not deliver to.
    const towns = await page.evaluate(() =>
      [...new Set(window.KAIRO_ZONES.map(
        (row) => String(row[1]).replace(/\s*\(.*\)$/, '').split(' / ')[0]))]);
    expect(data.areaServed.map((place) => place.name)).toEqual(towns);
    expect(data.areaServed.every((place) => place['@type'] === 'City')).toBe(true);

    // Only formats the page actually describes, and no price on any of them:
    // a corporate order is quoted, and the page states no figure for one.
    // textContent, not innerText: the card titles are uppercased by the
    // stylesheet, and a name is what the markup says, not what CSS draws.
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('.service-format-name')]
        .map((el) => el.textContent.replace(/\s+/g, ' ').trim()));
    expect(data.hasOfferCatalog.itemListElement.map((offer) => offer.itemOffered.name))
      .toEqual(rendered);
    for (const offer of data.hasOfferCatalog.itemListElement) {
      expect(offer.price).toBeUndefined();
      expect(offer.priceSpecification).toBeUndefined();
    }

    // Nothing is asserted that the page does not render.
    expect(data.aggregateRating).toBeUndefined();
    expect(data.name).toBe(await page.evaluate(
      () => document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim()));
  });

test('the Service node follows the language being read', async ({ page }) => {
  await page.goto(`${URL}?lang=en`);
  await expect(page.locator('#areasList .area').first()).toBeVisible();
  const data = await page.evaluate(() =>
    JSON.parse(document.getElementById('serviceSchema').textContent));
  expect(data.inLanguage).toBe('en');
  expect(data.name).toContain('Corporate');
});

test('the page is in the sitemap and linked from the homepage', async ({ page }) => {
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(await sitemap.text()).toContain('<loc>https://kairo1980.de/firmencatering</loc>');

  await page.goto('/');
  // Navigation, the announcement strip, the teaser's own button and the
  // footer. An orphan page is one nobody links to; this one is reachable from
  // wherever a reader happens to be on the homepage.
  await expect(page.locator('a[href="/firmencatering"]')).not.toHaveCount(0);
  await expect(page.locator('#firmen a[href="/firmencatering"]')).toHaveCount(1);
  await expect(page.locator('nav.nav a[href="/firmencatering"]')).toHaveCount(1);
});

test('the homepage teaser hands over instead of repeating the page', async ({ page }) => {
  await page.goto('/');
  const teaser = page.locator('#firmen');

  // What a teaser keeps: the heading, the lead, the two figures, one way on.
  await expect(teaser).toBeVisible();
  await expect(teaser.locator('[data-cfg="freeDeliveryFrom"]')).toHaveCount(1);
  await expect(teaser.locator('[data-fact="direct-discount"]')).toHaveCount(1);

  // What it must not keep: the detail that now has one authoritative address.
  await expect(teaser).not.toContainText('LMIV');
  await expect(teaser).not.toContainText('§ 19 UStG');
  await expect(teaser.locator('.bcard')).toHaveCount(0);

  // And the detail really is on the other page.
  await page.goto(URL);
  await expect(page.locator('body')).toContainText('§ 19 UStG');
  await expect(page.locator('.bcard').first()).toBeVisible();
});

test('the strict content-security policy still applies to this page', async ({ page }) => {
  const response = await page.request.get(URL);
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  // The PayPal relaxation belongs to the ordering page alone.
  expect(csp).not.toContain('paypal');
  expect(csp).not.toContain("style-src 'self' 'unsafe-inline'");
});

test('both pages state the delivery rules in the words config writes',
  async ({ page }) => {
    // The two sentences are generated from config.order.minimumOrder and
    // business.freeDeliveryFrom, so a page cannot be edited into promising
    // something the basket does not do.
    for (const path of ['/', URL]) {
      await page.goto(path);
      const areas = page.locator('#liefergebiet');
      await expect(areas).toContainText('für jede Lieferbestellung, privat wie geschäftlich');
      await expect(areas).toContainText('privat wie geschäftlich');
      // The old framing, in which free delivery was a corporate perk.
      await expect(page.locator('body')).not.toContainText('Firmen- und Büro-Bestellungen ab');
    }
  });

test('the minimum sentence disappears by itself if the rule ever changes',
  async ({ page }) => {
    // Not a hypothetical: the clause exists so nobody has to remember to
    // delete it by hand. Flip the rule in the page's own config and the
    // sentence must go, without touching a word of markup.
    await page.goto(URL);
    const shown = await page.evaluate(() => {
      window.KAIRO_CONFIG.order.minimumOrder.pickup = true;
      document.dispatchEvent(new CustomEvent('kairo:lang', { detail: 'de' }));
      return document.querySelector('.areas-lead').textContent;
    });
    expect(shown).not.toContain('für jede Lieferbestellung');
  });
