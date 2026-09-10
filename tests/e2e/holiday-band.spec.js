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
     - and it must NOT quietly stop the till, because a switch that does two
       things is a switch nobody can undo without understanding it.

   These write a settings row shared by the whole run, which is why this file
   lives in the `switch` project and runs serially. */

import { test, expect } from '@playwright/test';

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

test('the band announces, and the till is stopped separately', async ({ page }) => {
  await announce(page, berlinToday(), plusDays(6));

  /* A band that quietly stopped orders would be the one control on this page
     nobody could undo without understanding it — so the shop is still taking
     orders, and the card says so and offers the switch as its own tap. */
  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-ordering', 'off');

  await goAdmin(page);
  await expect(page.locator('.holiday.on')).toContainText('Orders are still being taken');
  await page.locator('.holiday button.stop.wide').click();

  // One tap later the till is shut until the day we are back, and the band is
  // still up: two facts, both true, neither inferred from the other.
  await expect(page.locator('.switch.off')).toBeVisible();
  await expect(page.locator('.holiday.on')).toBeVisible();

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ordering', 'off');
  await expect(band(page)).toBeVisible();
});
