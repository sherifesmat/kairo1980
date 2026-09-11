/* The holiday band, from both ends: two dates typed at /admin on a phone, and
   the band a guest meets on the site.

   It is the one thing on the admin dashboard that speaks to guests rather than
   to the till, and that is the whole of the risk in it:

     - a band that says "we are away" while the shop is open costs a day of
       orders, so it has to come down the morning we are back — by itself,
       because nobody is going to remember;
     - a pair of dates that do not make sense must be refused, not repaired: a
       repaired pair publishes a closure nobody typed;
     - the last day closed is derived from the day we are back, so the
       dashboard and the website cannot name different days;
     - it must stop the till on the days it covers and on NO others, because
       the band goes up weeks early and those weeks are open for business;
     - and stopping the till must not refuse the order that is still worth
       having: the one placed now for the evening we are back.

   These write a settings row shared by the whole run, which is why this file
   lives in the `switch` project and runs serially. */

import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';

test.describe.configure({ mode: 'serial' });

const ADMIN_USER = process.env.ADMIN_USER || 'devuser';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-password-not-a-real-one';

const band = (page) => page.locator('.announce-holiday');
const corporate = (page) => page.locator('.announce[data-requires="business"]');

/* Chromium reports ERR_ABORTED when a navigation is superseded by whatever the
   page was still doing, which these tests invite by pressing things and then
   navigating. Retried once rather than waited out. */
async function goAdmin(page, path = '/admin') {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  } catch {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
}

async function signIn(page) {
  await goAdmin(page);
  if (await page.locator('.switch').count()) return;

  await expect(page.locator('#p'),
    'ADMIN_USER / ADMIN_PASSWORD must be set for this run').toBeVisible();
  await page.fill('#u', ADMIN_USER);
  await page.fill('#p', ADMIN_PASSWORD);
  await page.click('button.go');
  await expect(page.locator('.switch')).toBeVisible();
}

/** Today in Hockenheim, as 'YYYY-MM-DD' — the shape the form posts and the
 *  shape the band compares. */
function berlinToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}

/** `days` from today, same shape. Midday UTC so a month boundary is ordinary
 *  arithmetic. */
function plusDays(days) {
  const d = new Date(berlinToday() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What the band should print for one date, in German — the language this run
 *  is pinned to. Computed the way a reader's browser would, so the assertion is
 *  "the right DATE arrives", not "this string was hard-coded twice". */
function dayMonth(iso) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC', day: 'numeric', month: 'long'
  }).format(new Date(iso + 'T12:00:00Z'));
}

async function announce(page, from, until) {
  await goAdmin(page);
  const box = page.locator('.holiday');
  await box.locator('#holFrom').fill(from);
  await box.locator('#holUntil').fill(until);
  await box.locator('button[name="mode"][value="set"]').click();
}

async function takeDown(page) {
  await goAdmin(page);
  const clear = page.locator('.holiday button[name="mode"][value="clear"]');
  if (await clear.count()) await clear.click();
  await expect(page.locator('.holiday.on')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await takeDown(page);

  // And the till open: one test closes it deliberately and the rest must not
  // inherit that.
  const resume = page.locator('.switch button.go2');
  if (await resume.count()) await resume.click();
  await expect(page.locator('.switch.off')).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  await signIn(page);
  await takeDown(page);
  const resume = page.locator('.switch button.go2');
  if (await resume.count()) await resume.click();
});

test('with nothing announced there is no band, and the corporate bar has the page', async ({ page }) => {
  await page.goto('/');
  await expect(band(page)).toBeHidden();
  await expect(corporate(page)).toBeVisible();
});

test('two dates at /admin put the band on the site, and the corporate bar stands down', async ({ page }) => {
  await announce(page, berlinToday(), plusDays(9));

  await page.goto('/');
  await expect(band(page)).toBeVisible();
  /* Two announcement bars stacked read as one bar with a fold in it, and a
     band inviting an office lunch we cannot cook is worse than no band. */
  await expect(corporate(page)).toBeHidden();
});

test('the last day closed is derived from the day we are back', async ({ page }) => {
  const from = berlinToday();
  const back = plusDays(10);

  await announce(page, from, back);

  /* The restaurant types two dates and the band prints three. The middle one —
     the last day the kitchen is shut — is the one nobody would notice going
     wrong, so it is derived from `until` rather than stored beside it. */
  await page.goto('/');
  const text = band(page).locator('.announce-text');
  await expect(text).toContainText(dayMonth(from));
  await expect(text).toContainText(dayMonth(plusDays(9)));
  await expect(text).toContainText(dayMonth(back));

  // And the dashboard says the same three days, from the same two.
  await goAdmin(page);
  await expect(page.locator('.holiday.on')).toContainText('back');
});

test('it speaks all three languages, and leaves no placeholder on screen', async ({ page }) => {
  await announce(page, berlinToday(), plusDays(5));

  await page.goto('/');
  const text = band(page).locator('.announce-text');

  for (const lang of ['de', 'en', 'ar']) {
    await page.evaluate((l) => {
      document.documentElement.lang = l;
      document.dispatchEvent(new CustomEvent('kairo:lang', { detail: l }));
    }, lang);

    await expect(text).toHaveAttribute(`data-${lang}`, /\S/);
    // The name is a brand, exactly as Lieferando and PayPal are, and is the
    // same string in all three languages.
    await expect(text).toContainText('KAIRO 1980');
    await expect(text).not.toContainText('{');
  }
});

test('the corporate page carries it too', async ({ page }) => {
  /* Whoever lands on /firmencatering from a search may never see the homepage,
     and a company ordering lunch for Thursday has to be told the kitchen is
     away. A page that can be found alone must be complete alone. */
  await announce(page, berlinToday(), plusDays(4));

  await page.goto('/firmencatering');
  await expect(band(page)).toBeVisible();
});

test('the days away are published as special hours, and lift with the band', async ({ page }) => {
  /* The band is for a guest reading the page; this is for the crawlers behind
     the Google and Apple place cards, which never see it. Both are written
     from the same two dates, so they cannot say different things. */
  const from = berlinToday();
  const back = plusDays(7);
  await announce(page, from, back);

  await page.goto('/');
  const schema = async () => page.evaluate(() =>
    JSON.parse(document.getElementById('restaurantSchema').textContent));

  const away = await schema();
  assert(away.specialOpeningHoursSpecification, 'special hours are emitted');
  expect(away.specialOpeningHoursSpecification).toHaveLength(1);
  expect(away.specialOpeningHoursSpecification[0]).toMatchObject({
    opens: '00:00', closes: '00:00', validFrom: from, validThrough: plusDays(6)
  });

  // The published week never learns about it: that is what the place cards
  // cache, and a fortnight away is not a new week.
  for (const spec of away.openingHoursSpecification || []) {
    expect(spec.validFrom).toBeUndefined();
  }

  await takeDown(page);
  await page.goto('/');
  expect((await schema()).specialOpeningHoursSpecification).toBeUndefined();
});

test('taking it down takes it off the site', async ({ page }) => {
  await announce(page, berlinToday(), plusDays(4));
  await page.goto('/');
  await expect(band(page)).toBeVisible();

  await takeDown(page);

  await page.goto('/');
  await expect(band(page)).toBeHidden();
  await expect(corporate(page)).toBeVisible();
});

test('a pair of dates that cannot be true announces nothing', async ({ page }) => {
  // Back before we left. Refused whole rather than repaired: a repaired pair
  // publishes a closure nobody typed.
  await announce(page, plusDays(9), plusDays(2));
  await expect(page.locator('.holiday .msg.bad')).toBeVisible();
  await expect(page.locator('.holiday.on')).toHaveCount(0);

  await page.goto('/');
  await expect(band(page)).toBeHidden();
});

test('a holiday already over is refused, so a band can never go up expired', async ({ page }) => {
  await announce(page, plusDays(-20), plusDays(-3));
  await expect(page.locator('.holiday .msg.bad')).toBeVisible();

  await page.goto('/');
  await expect(band(page)).toBeHidden();
});

test('a running holiday stops the till, with nothing else to tap', async ({ page }) => {
  await announce(page, berlinToday(), plusDays(6));

  /* The bug this replaced: the band went up, the till kept selling, and an
     order arrived on the third morning away. The two dates already say which
     days the kitchen is empty; nothing else had to be remembered. */
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ordering', 'off');
  await expect(band(page)).toBeVisible();

  // And the guest is told why and until when, not "please look again later".
  const notice = page.locator('.order-off').first();
  await expect(notice).toContainText('Betriebsferien');
  await expect(notice).toContainText('wieder für Sie da');

  /* The switch at the top of /admin is untouched — two facts, neither inferred
     from the other, so releasing one does not release the other. */
  await goAdmin(page);
  await expect(page.locator('.switch.off')).toHaveCount(0);
  await expect(page.locator('.holiday.on')).toContainText('Orders are stopped');
});

test('a holiday announced for later leaves tonight alone', async ({ page }) => {
  /* The same bug with the sign flipped, and the more expensive of the two: a
     band put up a fortnight early must not stop a fortnight of orders. */
  await announce(page, plusDays(10), plusDays(17));

  await page.goto('/');
  await expect(band(page)).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-ordering', 'off');

  await goAdmin(page);
  await expect(page.locator('.holiday.on')).toContainText('Orders carry on as normal');
});
