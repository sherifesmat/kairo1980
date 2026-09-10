/* The band for an event next door.

   Something enormous happens beside this restaurant a few days a year — the
   Glücksgefühle festival puts roughly a quarter of a million people about two
   kilometres away — and for those days the homepage says so.

   What is asserted here is the part that is easy to get wrong and expensive to
   discover: that the band ENDS. A promotion for a festival that finished last
   weekend is worse than no promotion, and the site has no scheduled job and
   nobody whose task it is to take it down — it expires by being read against
   the clock, exactly as the closure and the extension do.

   So none of these tests depend on today being a festival day. They move the
   WINDOW around today, which is the mechanism, and they would still be
   meaningful in 2030 with the event switched off. */

import { test, expect } from '@playwright/test';

const band = (page) => page.locator('.announce-event');
const corporate = (page) => page.locator('.announce[data-requires="business"]');

/** Today, as the restaurant's own calendar sees it. 'en-CA' is 'YYYY-MM-DD',
 *  which is the shape config.js writes and the shape order.js compares. */
async function berlinToday(page) {
  return page.evaluate(() => new Intl.DateTimeFormat('en-CA',
    { timeZone: 'Europe/Berlin' }).format(new Date()));
}

/** Move the event window, then repaint through the path the language switch
 *  already uses — `applyConfig()` runs on `kairo:lang`, so this is a real
 *  repaint and not a private hook opened up for a test. */
async function setWindow(page, from, until) {
  await page.evaluate(([f, u]) => {
    window.KAIRO_CONFIG.event = { enabled: true, from: f, until: u, ringDistanceKm: 2 };
    /* A holiday outranks a festival, and the restaurant may well have one
       announced the day this runs — it arrives from /admin in the live island
       and is put on the config at boot. These tests are about the festival
       band, so it is cleared for them; the ranking itself is under test in
       holiday-band.spec.js. */
    window.KAIRO_CONFIG.holiday = null;
    document.dispatchEvent(new CustomEvent('kairo:lang',
      { detail: document.documentElement.lang }));
  }, [from, until]);
}

/** The day after `iso`, as 'YYYY-MM-DD'. */
function nextDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test('inside its dates the band is shown, and the corporate bar stands down', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);

  await setWindow(page, today, nextDay(today));
  await expect(band(page)).toBeVisible();

  /* Two announcement bars stacked read as one bar with a fold in it. While the
     festival runs it is the more urgent of the two; the office-lunch offer is
     still in the nav and still has its own page. */
  await expect(corporate(page)).toBeHidden();
});

test('the day after it ends, the band is gone and the corporate bar returns', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);

  /* `until` is EXCLUSIVE, so a window ending TODAY is already over. This is the
     boundary the whole design rests on: get it wrong by one day and the band
     outlives the festival, which is the exact failure it exists to avoid. */
  await setWindow(page, '2000-01-01', today);
  await expect(band(page)).toBeHidden();
  await expect(corporate(page)).toBeVisible();
});

test('before it starts the band is not shown either', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);

  await setWindow(page, nextDay(today), nextDay(nextDay(today)));
  await expect(band(page)).toBeHidden();
});

test('switched off in config, nothing appears whatever the date', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);

  await page.evaluate((t) => {
    window.KAIRO_CONFIG.event = { enabled: false, from: t, until: '2099-01-01', ringDistanceKm: 2 };
    window.KAIRO_CONFIG.holiday = null;
    document.dispatchEvent(new CustomEvent('kairo:lang',
      { detail: document.documentElement.lang }));
  }, today);

  await expect(band(page)).toBeHidden();
  await expect(corporate(page)).toBeVisible();
});

test('the distance is printed from config, not typed into the copy', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);
  await setWindow(page, today, nextDay(today));

  /* The point of the placeholder: change the number in one file and all three
     languages change with it. A figure typed into the copy would pass a test
     that asserted the figure — so this asserts that a CHANGED figure arrives. */
  await page.evaluate(() => {
    window.KAIRO_CONFIG.event.ringDistanceKm = 7;
    document.dispatchEvent(new CustomEvent('kairo:lang',
      { detail: document.documentElement.lang }));
  });
  await expect(band(page).locator('.announce-text')).toContainText('7 km');
});

test('it speaks all three languages, and the brand name is never translated', async ({ page }) => {
  await page.goto('/');
  const today = await berlinToday(page);
  await setWindow(page, today, nextDay(today));

  const text = band(page).locator('.announce-text');

  for (const lang of ['de', 'en', 'ar']) {
    await page.evaluate((l) => {
      document.documentElement.lang = l;
      document.dispatchEvent(new CustomEvent('kairo:lang', { detail: l }));
    }, lang);

    // Every visible string switches...
    await expect(text).toHaveAttribute(`data-${lang}`, /\S/);
    // ...except the event's own name, which is a brand exactly as Lieferando
    // and PayPal are, and is therefore the same string in all three.
    await expect(text).toContainText('Glücksgefühle');
  }
});
