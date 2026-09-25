/* The emergency switch, from both ends: thrown at /admin on a phone, met by a
   guest on the site.

   These exist because the integration tests prove the Worker answers
   correctly, and that is not the same thing as the guest being stopped. Every
   failure below has a real shape:

     - the notice renders in German but not in Arabic, because a string was
       added to one dictionary and not the other three;
     - the buttons dim but a determined tap still adds to the basket;
     - the basket built before the switch was thrown sends anyway;
     - the hours saved at /admin never reach the page a crawler reads;
     - and the one that costs money: ordering resumes and something,
       somewhere, is still holding the closed state. */

import { test, expect } from '@playwright/test';
import { addItem, openBasket, choosePickup, chooseDelivery, fillContact, captureWhatsApp } from './helpers.js';

/* One switch, one database, one restaurant. Two of these running at once would
   be two tests writing the same row — which reads as flakiness and is not. */
test.describe.configure({ mode: 'serial' });

const ADMIN_USER = process.env.ADMIN_USER || 'devuser';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-password-not-a-real-one';

/** Sign in to /admin, or notice we already are.
 *
 *  The "already signed in" branch matters: this runs from afterEach too, where
 *  the session from the test body is still live and there is no form to fill.
 *  An earlier version called test.skip() here — which throws when a hook calls
 *  it, failing the test that had just passed and aborting the serial chain
 *  behind it. A helper used in a hook must not decide to skip. */
/* Chromium reports ERR_ABORTED when a navigation is superseded by whatever the
   page was still doing — a real hazard here, because these tests navigate away
   immediately after pressing things. Retried once rather than papered over with
   a wait: the second attempt starts from a settled page. */
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

async function setOrdering(page,
  { closed, reason = '', untilDate = '', untilTime = '', minutes = null } = {}) {
  await goAdmin(page);

  if (!closed) {
    /* Scoped to the switch for the same reason the closure below is: the
       dashboard carries the "stay open later" and "today's driver" controls
       too, and they reuse these button classes. Unscoped, `button.go2` can
       match two elements, and a strict-mode locator does not fail on that --
       it WAITS for the page to resolve to one, which never happens. That is
       silent until it eats a whole test budget and surfaces as the previous
       test failing in its afterEach, taking the rest of a serial file with it. */
    const box = page.locator('.switch');
    const resume = box.locator('button.go2');
    if (await resume.count()) await resume.click();
    await expect(page.locator('.switch.off')).toHaveCount(0);
    return;
  }

  /* Scoped to the switch. The dashboard now also carries the "stay open later"
     controls, which use the same disclosure and the same button classes — an
     unscoped `details summary` matches both and the closure silently drives the
     wrong form. */
  const box = page.locator('.switch');

  if (await box.locator('button.go2').count()) await box.locator('button.go2').click();
  await box.locator(`input[name="reason"][value="${reason}"]`).check();

  if (untilDate || untilTime) {
    // The date fields live behind a disclosure: the common closure is one tap
    // and should not be buried under a form nobody usually needs.
    await box.locator('details summary').click();
    if (untilDate) await page.fill('#untilDate', untilDate);
    if (untilTime) await page.fill('#untilTime', untilTime);
    await box.locator('button.stop.wide').click();
  } else if (minutes != null) {
    await box.locator(`button.stop[value="${minutes}"]`).click();
  } else {
    await box.locator('button.stop[name="minutes"][value=""]').click();   // rest of today
  }

  await expect(page.locator('.switch.off')).toBeVisible();
}

/* Whatever a test does — including crashing — the shop is left taking orders.
   A run that died half way through once left the shop closed in the local
   database, and every later test failed trying to add an item to a basket. A
   suite that can do that is a suite nobody will dare run twice, so the state
   is put back both before and after. */
test.beforeEach(async ({ page }) => {
  await signIn(page);
  await setOrdering(page, { closed: false });

  /* And an empty basket. These tests run serially against one browser profile,
     so the basket and the remembered form survive from one to the next — which
     is exactly the behaviour the site is built for and exactly wrong for a
     test that then asserts a count. Isolation is the test's job, not the
     site's. */
  await page.goto('/');
  await page.evaluate(() => {
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* fine */ }
  });
});

/* Hooks share the TEST's 30s budget, so teardown here buys nothing and can
   cost everything. It used to sign in and drive the switch back through the
   UI — two page loads — and the test above is the one that can least afford
   them: it forces a click on the disabled send button, and the `/admin` that
   follows has been measured taking 31 SECONDS to come back, against a
   `wrangler dev` every worker in the run shares. Nothing was broken; the hook
   simply ran out of clock, which Playwright reports as the test failing and
   which takes the rest of a serial file with it.

   So no page loads at all. `page.request` carries the context's own session
   cookie, the tests having signed in already, and both rows go back the way
   the driver already did — as the plain POSTs the forms themselves submit.

   Both are given an explicit 5s, because `page.request` otherwise inherits a
   30s default — the whole test budget — and a dev server that has gone quiet
   would spend it here and fail a test that had already passed. A put-back that
   does not happen is worth a beforeEach doing it again; a put-back that can
   hang is worth nothing at all. Teardown is not the thing under test. */
test.afterEach(async ({ page }) => {
  // The switch, and then the settings row beside it: a test that leaves
  // either one set changes the next.
  const putBack = { timeout: 5000 };
  await page.request.post('/admin/ordering', { form: { open: '1' }, ...putBack })
    .catch(() => {});
  await page.request.post('/admin/delivery-shift', { form: { mode: 'clear' }, ...putBack })
    .catch(() => {});
});

test('a paused shop still shows its menu, and says why in all three languages',
  async ({ page }) => {
    await signIn(page);
    await setOrdering(page, { closed: true, reason: 'demand' });

    await page.goto('/');
    // The menu is the point: someone who cannot order tonight may still be
    // deciding where to eat tomorrow.
    await expect(page.locator('.mitem[data-item]').first()).toBeVisible();
    await expect(page.locator('.mprice').first()).toBeVisible();

    const note = page.locator('#speisekarte .order-off');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Bestellungen');
    // The phone number is the way out, and it must be in the sentence.
    await expect(note).toContainText('+49 176 79906621');

    /* The failure this catches: a string added to the German dictionary and
       forgotten in the other two, which shows up as an empty notice or a
       German sentence on the Arabic page. */
    for (const [lang, expected] of [['en', /orders/i], ['ar', /طلبات/]]) {
      await page.locator(`[data-lang="${lang}"]`).first().click();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(note).toHaveText(expected);
      await expect(note).not.toHaveText(/Bestellungen/);
    }
  });

test('a paused shop still lets a guest build a basket, and refuses only "now"',
  async ({ page }) => {
    const whatsapp = await captureWhatsApp(page);
    await signIn(page);
    await setOrdering(page, { closed: true, reason: 'emergency' });

    /* Filling a basket is never withheld. The guest may be putting together an
       order for tomorrow, and blocking the basket would lose it — which is the
       same mistake as refusing an out-of-area postcode instead of flagging it. */
    await page.goto('/');
    await addItem(page, 'hummus', 2);
    await expect(page.locator('#cartFabCount')).toHaveText('2');

    await openBasket(page);
    await choosePickup(page);
    await fillContact(page, { name: 'Test Gast', phone: '+49 176 1234567' });

    // "As soon as possible" is what the closure takes away.
    const send = page.locator('#cartSend');
    await expect(send).toBeDisabled();
    const note = page.locator('#cartOrderOff');
    await expect(note).toBeVisible();
    // And the note names the way out rather than just closing the door.
    await expect(note).toContainText(/Wunschtermin/);

    // Forced past the disabled attribute, the way a script or a stuck tap would.
    await send.evaluate((el) => { el.disabled = false; el.click(); });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__waUrl)).toBeNull();
    await expect(page.locator('.cart-sent')).toHaveCount(0);
  });

test('an order scheduled past the closure goes through untouched', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await signIn(page);

  // Closed until a named time this evening, so "later today" is a real choice.
  await setOrdering(page, { closed: true, reason: 'demand', untilTime: '23:30' });

  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await choosePickup(page);

  // Pick a moment after we reopen — tomorrow, so no clock arithmetic can make
  // this test fail at some hours of the day and pass at others.
  const tomorrow = await page.evaluate(() => {
    const d = new Date(Date.now() + 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  await page.locator('[data-when="scheduled"]').click();
  await page.fill('#fDate', tomorrow);
  await page.fill('#fTime', '19:00');

  const send = page.locator('#cartSend');
  await expect(send).toBeEnabled();
  await expect(page.locator('#cartOrderOff')).toBeHidden();

  await fillContact(page, { name: 'Test Gast', phone: '+49 176 1234567' });
  await send.click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(message).toContain('2× Hummus');
  await expect(page.locator('.cart-sent')).toBeVisible();
});

test('moving the chosen time back into the closure withholds the button again',
  async ({ page }) => {
    await signIn(page);
    await setOrdering(page, { closed: true, reason: 'demand', untilTime: '23:30' });

    await page.goto('/');
    await addItem(page, 'hummus', 1);
    await openBasket(page);
    await choosePickup(page);

    const send = page.locator('#cartSend');
    const tomorrow = await page.evaluate(() => {
      const d = new Date(Date.now() + 86400000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });

    await page.locator('[data-when="scheduled"]').click();
    await page.fill('#fDate', tomorrow);
    await page.fill('#fTime', '19:00');
    await expect(send).toBeEnabled();

    // Back to "as soon as possible", which is the one moment we cannot cook in.
    await page.locator('[data-when="asap"]').click();
    await expect(send).toBeDisabled();
  });

test('taking something OFF an order is never blocked', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await setOrdering(page, { closed: true, reason: 'demand' });

  await page.goto('/');
  await expect(page.locator('#cartFabCount')).toHaveText('2');
  // Withholding "remove" would trap a guest with a basket they cannot empty.
  await page.locator('.mitem[data-item="hummus"] [data-act="dec"]').dispatchEvent('click');
  await expect(page.locator('#cartFabCount')).toHaveText('1');
});

test('the page says it is closed before a single line of script has run',
  async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // Signing in needs no JavaScript either — the admin area is plain forms.
    await page.goto('/admin');
    if (await page.locator('#p').count()) {
      await page.fill('#u', ADMIN_USER);
      await page.fill('#p', ADMIN_PASSWORD);
      await page.click('button.go');
    }
    if (await page.locator('button.go2').count()) await page.locator('button.go2').click();
    await page.locator('input[name="reason"][value="holiday"]').check();
    await page.click('button.stop');

    /* The attribute is written by the Worker into the markup. Without it the
       order buttons are live for however long order.js takes to boot — on a
       slow phone, long enough to tap. */
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-ordering', 'off');

    await page.goto('/admin');
    await page.locator('button.go2').click();
    await context.close();
  });

test('hours saved in the admin reach the markup a crawler reads', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/hours');

  await page.locator('input[name="wed_closed"]').uncheck();
  /* The day's opening is the FIRST window; the second exists only for a
     kitchen that shuts in the afternoon. Filling the second while the first
     still runs to 23:00 is now refused as an overlap, which is the point of
     that check — so this sets the one window the day actually has. */
  await page.fill('input[name="wed_lunch_from"]', '17:15');
  await page.fill('input[name="wed_lunch_to"]', '22:45');
  await page.fill('input[name="wed_evening_from"]', '');
  await page.fill('input[name="wed_evening_to"]', '');
  await page.click('button.save-btn');
  await expect(page.locator('.msg')).toContainText('Saved');

  try {
    /* Read with JavaScript switched off. Googlebot renders, eventually;
       Applebot and Bingbot largely do not, and those two feed the Apple Maps
       and Bing place cards this restaurant is actually found through. */
    const raw = await page.request.get('/');
    const html = await raw.text();
    expect(html).toContain('17:15');
    expect(html).toContain('22:45');

    const schema = html.match(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/);
    expect(schema, 'the JSON-LD block is still there to rewrite').toBeTruthy();
    const spec = JSON.parse(schema[1]).openingHoursSpecification;
    expect(spec.some((s) => s.opens === '17:15' && s.closes === '22:45')).toBe(true);

    // And the visible table, for a reader without JavaScript.
    expect(html).toMatch(/<!--hours:start-->[\s\S]*17:15[\s\S]*<!--hours:end-->/);
  } finally {
    await page.goto('/admin/hours');
    await page.locator('button.reset').click();
  }
});

/* --- a driver out at a different time today --------------------------------
   The restaurant is free to drive at two, or has nobody until nine. Either way
   they must be able to say so without editing the week — because the week is
   what Google caches for the place card, and a changed delivery time is still
   changed on Wednesday.

   Two failures are worth holding down: the sentence rendering in German and
   nowhere else, and today's driver leaking into the published hours. */

/** Move today's shift at /admin. `mode` is 'now', 'open', 'off', 'at' or 'clear'. */
async function setShift(page, mode, from = null) {
  await goAdmin(page);
  const box = page.locator('.shift');

  if (mode === 'clear') {
    const back = box.locator('button.go2');
    if (await back.count()) await back.click();
    await expect(page.locator('.shift.on')).toHaveCount(0);
    return;
  }

  // Clear first: the block shows the controls only while no shift is in force.
  if (await box.locator('button.go2').count()) await box.locator('button.go2').click();

  /* Selected by the value it submits, never by its classes. The block now has
     two `.stop.wide` buttons — "no driver today" and the disclosure's own
     submit — and a class-based locator silently drove whichever came first. */
  if (mode === 'at') {
    await box.locator('details summary').click();
    await page.fill('#shiftFrom', from);
  }
  await box.locator(`button[name="mode"][value="${mode}"]`).click();
  await expect(page.locator('.shift.on')).toBeVisible();
}

test('today\'s driver is said in three languages and published in none',
  async ({ page }) => {
    await signIn(page);

    /* The standing arrangement this test contrasts TODAY against, set here
       rather than assumed. It used to lean on config.js happening to ship
       '18:00', which made it a second copy of a business fact — and the day the
       restaurant stopped naming a driver start, because the roster was not
       dependable enough to promise one, this test failed while describing the
       site perfectly correctly. A test may assume the facts it sets itself. */
    const STANDING = '18:00';
    await page.goto('/admin/hours');
    await page.fill('input[name="delivery_from"]', STANDING);
    await page.click('button.save-btn');
    await expect(page.locator('.msg')).toContainText('Saved');

    await setShift(page, 'open');           // a driver out for the whole opening

    await page.goto('/');
    const note = page.locator('.hours-today');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Heute');

    /* The standing sentence is still the standing sentence. Two lines that
       disagree would be a bug; one stating the week and one stating today is
       the whole design. */
    await expect(page.locator('.hours-note.delivery-note')).toContainText(STANDING);

    /* A string added to one dictionary and forgotten in the other two shows up
       as an empty note or a German sentence on the Arabic page. */
    for (const [lang, expected] of [['en', /today/i], ['ar', /النهارده/]]) {
      await page.locator(`[data-lang="${lang}"]`).first().click();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(note).toHaveText(expected);
      await expect(note).not.toHaveText(/Heute/);
    }

    /* And the crawlers read the week, unchanged. This is the assertion the
       whole feature exists to keep true: the restaurant said "not today" and
       the place card heard nothing at all. */
    const html = await (await page.request.get('/')).text();
    const spec = JSON.parse(
      html.match(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/)[1]
    ).openingHoursSpecification;
    expect(spec.length, 'the week is still published').toBeGreaterThan(0);
    expect(html).toMatch(
      new RegExp('<!--hours:start-->[\\s\\S]*' + STANDING + '[\\s\\S]*<!--hours:end-->'));

    /* The week goes back to what config.js ships, the way the hours test above
       puts it back: a standing arrangement left set changes every later test. */
    await page.goto('/admin/hours');
    await page.locator('button.reset').click();
  });

test('a shift set for later today withholds delivery the basket would have offered',
  async ({ page }) => {
    await page.goto('/');

    /* A moment still ahead inside today's opening, read out of the page's own
       config rather than typed here — a time written into a test is a second
       copy of the opening hours, and it is the copy nobody updates. */
    const slot = await page.evaluate(() => {
      const hours = window.KAIRO_CONFIG.hours;
      const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const now = new Date();
      const day = hours.days[KEYS[(now.getDay() + 6) % 7]];
      if (!day || day.closed) return null;

      const pad = (n) => String(n).padStart(2, '0');
      const hhmm = (s) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
      const mins = now.getHours() * 60 + now.getMinutes();
      const shift = hours.deliveryFrom ? hhmm(hours.deliveryFrom) : 0;

      for (const w of [day.lunch, day.evening]) {
        if (!w) continue;
        /* A moment the STANDING shift already delivers at: a quarter past
           opening, never before the driver's usual start, and never in the
           past. Starting anywhere else would prove nothing — the point is a
           slot that delivers until today's shift is pushed past it. */
        /* Rounded UP to five minutes, because the admin's time field is
           step="300" and the browser refuses to submit a form holding a value
           off that grid — silently, as far as a test is concerned: the click
           lands, nothing navigates, and the assertion that follows waits for a
           page that was never asked for. This passed for a week and failed at
           17:57, which is what an unrounded "now + 15" produces. */
        const at = Math.ceil(Math.max(hhmm(w[0]) + 15, mins + 15, shift) / 5) * 5;
        // And it must leave an hour of daylight to push the shift into.
        if (at + 60 >= hhmm(w[1])) continue;
        return {
          date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
          time: `${pad(Math.floor(at / 60))}:${pad(at % 60)}`,
          later: `${pad(Math.floor((at + 60) / 60))}:${pad((at + 60) % 60)}`
        };
      }
      return null;
    });

    /* Nothing left of today to deliver in — a Monday, or after closing. There
       is no delivery to withhold, so there is nothing here to assert. The
       sibling test above runs at every hour and carries the language and
       structured-data guarantees on its own. */
    test.skip(!slot, 'no opening left today to move a driver within');

    await signIn(page);
    await setShift(page, 'clear');

    await page.goto('/');
    await addItem(page, 'hummus', 1);
    await openBasket(page);
    await page.locator('[data-when="scheduled"]').click();
    await page.fill('#fDate', slot.date);
    await page.fill('#fTime', slot.time);

    const delivery = page.locator('[data-type="delivery"]');
    await expect(delivery, 'the standing shift already delivers then').toBeEnabled();

    // Now nobody drives until an hour after that.
    await setShift(page, 'at', slot.later);

    await page.goto('/');
    await openBasket(page);
    await page.locator('[data-when="scheduled"]').click();
    await page.fill('#fDate', slot.date);
    await page.fill('#fTime', slot.time);

    /* Withheld, and the note names the time that WOULD work — today's, not the
       one printed in the hours. A note naming the standing time here would send
       the guest back to a slot we had just said we cannot drive. */
    await expect(delivery).toBeDisabled();
    await expect(page.locator('#cartTypeNote')).toContainText(slot.later);

    // And the order itself is never refused: pickup at that moment still sends.
    await expect(page.locator('#cartSend')).toBeEnabled();
  });

test('with no driver today, delivery is withheld and the order still goes',
  async ({ page }) => {
    const whatsapp = await captureWhatsApp(page);
    await signIn(page);

    /* This test is about TODAY, so today has to be a day the restaurant opens —
       and it is shut on Mondays and Tuesdays. Opened here rather than hoped
       for: with the door closed, "as soon as possible" resolves to the next
       open day, which "no driver today" correctly does not touch, so the
       delivery button stays enabled and the test fails on two days in seven
       while describing the site perfectly. It used to pass on those days by
       accident, because the standing shift happened to withhold the following
       morning too; that accident went the day the restaurant stopped naming a
       standing shift at all. */
    const DAY = new Date().toLocaleDateString('en-US',
      { weekday: 'short', timeZone: 'Europe/Berlin' }).toLowerCase();
    await page.goto('/admin/hours');
    await page.locator(`input[name="${DAY}_closed"]`).uncheck();
    await page.fill(`input[name="${DAY}_lunch_from"]`, '11:00');
    await page.fill(`input[name="${DAY}_lunch_to"]`, '23:00');
    await page.fill(`input[name="${DAY}_evening_from"]`, '');
    await page.fill(`input[name="${DAY}_evening_to"]`, '');
    await page.click('button.save-btn');
    await expect(page.locator('.msg')).toContainText('Saved');

    await setShift(page, 'off');

    await page.goto('/');

    // Said under the hours, in the reader's own language.
    const note = page.locator('.hours-today');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Abholung');
    for (const [lang, expected] of [['en', /collection only/i], ['ar', /الاستلام/]]) {
      await page.locator(`[data-lang="${lang}"]`).first().click();
      await expect(note).toHaveText(expected);
    }

    await page.goto('/?lang=de');
    await addItem(page, 'hummus', 1);
    await openBasket(page);

    /* Withheld for every moment today, whatever the clock says — this is the
       one thing the weekly settings could not express, and "no driver" must
       not decay into "a driver from the moment we open". */
    await expect(page.locator('[data-type="delivery"]')).toBeDisabled();

    /* And the note does not name a time. Naming one would send the guest to
       pick a slot that cannot be driven either — the failure that made this a
       third answer rather than a time typed after closing. */
    const why = page.locator('#cartTypeNote');
    await expect(why).toContainText('Abholung');
    await expect(why).not.toHaveText(/\d\d:\d\d/);

    /* Validation withholds an OPTION, never the order. Collection at the
       counter still sends, which is the whole point of having a switch for
       this instead of closing the shop. */
    await fillContact(page, { name: 'Test Gast', phone: '+49 176 1234567' });
    await page.locator('#cartSend').click();
    expect(await whatsapp()).toContain('wa.me');
    await expect(page.locator('.cart-sent')).toBeVisible();

    // The week goes back to what config.js ships, as everywhere else here.
    await page.goto('/admin/hours');
    await page.locator('button.reset').click();
  });

test('resuming clears every trace of the closure', async ({ page }) => {
  await signIn(page);
  await setOrdering(page, { closed: true, reason: 'holiday' });
  await setOrdering(page, { closed: false });

  await page.goto('/');
  await expect(page.locator('html')).not.toHaveAttribute('data-ordering', 'off');
  await expect(page.locator('#speisekarte .order-off')).toBeHidden();

  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await expect(page.locator('#cartSend')).toBeEnabled();
});

/* --- the order reaches the restaurant on its own -------------------------
   The failure this closes: a guest picks "pay on arrival", the order goes
   nowhere but their own WhatsApp draft, and if they never press send the
   kitchen never learns of it. That cost a real dinner. The whole loop is
   asserted here — basket in the browser, order in the restaurant's own page —
   because the two halves passing separately is exactly what was true before. */

test('a cash order reaches the kitchen page without WhatsApp being sent', async ({ page }) => {
  /* A unique guest per run. The dev database is not reset between runs, and an
     assertion of "exactly one" against a name every previous run also used is
     a test that passes once and then reports its own history as a failure. */
  const who = `E2E Barzahler ${Date.now()}`;
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');

  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, { name: who, phone: '+49 176 5550000' });
  await page.locator('#cartSend').click();

  // The handover still happens exactly as before — this must not have replaced
  // the WhatsApp route, only stopped being the only one.
  const url = await whatsapp();
  expect(url).toContain('wa.me');

  await expect(page.locator('.cart-sent')).toBeVisible();

  /* The announce is fired without being awaited, so the popup keeps its user
     gesture. That means the row may land a moment after the screen does —
     poll the kitchen page rather than assuming it is already there. */
  await signIn(page);
  await expect(async () => {
    await goAdmin(page, '/admin/orders');
    await expect(page.locator('.order', { hasText: who })).toHaveCount(1);
  }).toPass({ timeout: 10000 });

  const card = page.locator('.order', { hasText: who }).first();
  await expect(card).toContainText('+49 176 5550000');
  await expect(card).toContainText('PAY ON ARRIVAL');
  await expect(card).toContainText('Hummus');
});

test('a delivery order carries the address the driver needs', async ({ page }) => {
  const who = `E2E Lieferung ${Date.now()}`;
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');

  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await chooseDelivery(page);
  await fillContact(page, {
    name: who, phone: '+49 176 5550001',
    address: 'Teststrasse 7', postcode: '68766'
  });
  await page.locator('#cartSend').click();
  await whatsapp();

  await signIn(page);
  await expect(async () => {
    await goAdmin(page, '/admin/orders');
    await expect(page.locator('.order', { hasText: who })).toHaveCount(1);
  }).toPass({ timeout: 10000 });

  const card = page.locator('.order', { hasText: who }).first();
  await expect(card).toContainText('Teststrasse 7');
  await expect(card).toContainText('68766');
  // The number has to be dialable from the phone the restaurant reads this on.
  await expect(card.locator('a[href^="tel:"]')).toHaveAttribute('href', 'tel:+491765550001');
});

/* --- a dish the kitchen has run out of ------------------------------------
   Marked at /admin, and the guest must meet it as a fact rather than as a
   button that does not work. Cleanup is in a finally: leaving a dish sold out
   would silently break every later test that tries to order it, and — far
   worse if this ever ran against something real — leave it off the menu. */
test('a dish marked sold out cannot be ordered, and says so', async ({ page }) => {
  await signIn(page);
  await goAdmin(page, '/admin/dishes');

  const box = page.locator('input[name="soldout"][value="hummus"]');
  await expect(box, 'the dish list is read from the menu itself').toHaveCount(1);

  try {
    await box.check();
    await page.click('button.save-btn');
    await expect(page.locator('.msg')).toContainText('Saved');

    /* readSettings caches for a few seconds per isolate, and forgetCache only
       clears the one that wrote. That is deliberate — a database round trip per
       page load for a value that changes twice a month is waste — but it means
       the mark can take a moment to appear. Polled rather than slept. */
    const row = page.locator('.mitem[data-item="hummus"]');
    await expect(async () => {
      await page.goto('/?lang=de&t=' + Date.now());
      await expect(row).toHaveAttribute('data-soldout', '1');
    }).toPass({ timeout: 20000 });

    await expect(row).toContainText('Ausverkauft');
    // No control at all — a disabled "+" reads as a broken page.
    await expect(row.locator('[data-act="inc"]')).toHaveCount(0);

    // And a dish that is still available is untouched beside it.
    const ok = page.locator('.mitem[data-item="baba-ghanough"]');
    await expect(ok.locator('[data-act="inc"]')).toHaveCount(1);
  } finally {
    await goAdmin(page, '/admin/dishes');
    await page.locator('input[name="soldout"][value="hummus"]').uncheck();
    await page.click('button.save-btn');
  }

  /* Back on the menu once the cache turns over. The query string is a cache
     buster, not decoration: the page is served with an ETag and the browser is
     entitled to reuse its copy, which would test Chromium's cache rather than
     the site. */
  await expect(async () => {
    await page.goto('/?lang=de&t=' + Date.now());
    await expect(page.locator('.mitem[data-item="hummus"] [data-act="inc"]')).toHaveCount(1);
  }).toPass({ timeout: 20000 });
});

/* Running out of Kebda takes the Kebda bowl off and leaves the other three.
   The topping is switched off by its own id, says so in words on its own row
   and in the chooser, and the rest of the bowl is still an ordinary order. */
test('a topping marked sold out is off the bowl, and only that topping', async ({ page }) => {
  await signIn(page);
  await goAdmin(page, '/admin/dishes');

  const box = page.locator('input[name="soldout"][value="kairo-bowl:kebda"]');
  await expect(box, 'each topping has its own box, read from the menu').toHaveCount(1);

  try {
    await box.check();
    await page.click('button.save-btn');
    await expect(page.locator('.msg')).toContainText('Saved');

    const kebda = page.locator('.mitem[data-item="kairo-bowl"] .mchoice[data-option="kebda"]');
    await expect(async () => {
      await page.goto('/?lang=de&t=' + Date.now());
      await expect(kebda).toHaveAttribute('data-soldout', '1');
    }).toPass({ timeout: 20000 });
    await expect(kebda).toContainText('Ausverkauft');

    const bowl = page.locator('.mitem[data-item="kairo-bowl"]');
    await bowl.scrollIntoViewIfNeeded();
    await bowl.locator('[data-act="choose"]').click();
    const dialog = page.locator('.chooser');
    await expect(dialog.locator('.chooser-opt.is-soldout')).toContainText('Kebda');
    await expect(dialog.locator('input[value="kebda"]')).toHaveCount(0);
    await expect(dialog.locator('input[value="haehnchen"]')).toHaveCount(1);

    /* A Kebda bowl put in the basket BEFORE the kitchen ran out is dropped at
       the next load, by name, and the chicken bowl beside it stays. */
    await page.evaluate(() => localStorage.setItem('kairo.cart.v2', JSON.stringify({
      savedAt: Date.now(),
      items: {
        'kairo-bowl|basis=reis|topping=kebda': 1,
        'kairo-bowl|basis=reis|topping=haehnchen': 1
      }
    })));
    await page.goto('/?lang=de&t=' + Date.now());
    await page.locator('#cartFab').click();
    await expect(page.locator('.cart-line')).toHaveCount(1);
    await expect(page.locator('.cart-line')).toContainText('Hähnchen');
    await expect(page.locator('#cartSoldOutNote')).toContainText('KAIRO Bowl (Ägyptischer Reis, Kebda)');
    await expect(page.locator('#cartSoldOutNote')).toContainText('ausverkauft');
  } finally {
    await goAdmin(page, '/admin/dishes');
    await page.locator('input[name="soldout"][value="kairo-bowl:kebda"]').uncheck();
    await page.click('button.save-btn');
  }
});

/* --- a price changed at /admin ----------------------------------------------
   One figure, everywhere at once: the menu row, the basket, the message the
   restaurant reads. A typo refuses the whole save. Reset in a finally, for
   the same reason the sold-out tests clean up. */
test('a price changed at /admin is the price on the menu, in the basket and in the chat', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await signIn(page);
  await goAdmin(page, '/admin/prices');

  const hummus = page.locator('input[name="price:hummus"]');
  await expect(hummus, 'the list is read from the menu').toHaveValue('9,50');
  // The bowl in two parts: each base has a price, each topping adds to it.
  await expect(page.locator('input[name="price:kairo-bowl:reis"]')).toHaveValue('9,00');
  await expect(page.locator('input[name="price:kairo-bowl:kebda"]')).toHaveValue('8,50');

  try {
    // A price that is not a price saves nothing at all.
    await hummus.fill('95,0,0');
    await page.locator('input[name="price:koshary"]').fill('15,00');
    await page.click('button.save-btn');
    await expect(page.locator('.err')).toContainText('Nothing was saved');
    await goAdmin(page, '/admin/prices');
    await expect(page.locator('input[name="price:koshary"]')).toHaveValue('14,50');

    await page.locator('input[name="price:hummus"]').fill('10,50');
    await page.click('button.save-btn');
    await expect(page.locator('.msg')).toContainText('Saved');
    await expect(page.locator('li.price.changed')).toContainText('Menu price: 9,50 €');

    const row = page.locator('.mitem[data-item="hummus"]');
    await expect(async () => {
      await page.goto('/?lang=de&t=' + Date.now());
      await expect(row).toHaveAttribute('data-price', '10.50');
    }).toPass({ timeout: 20000 });
    await expect(row.locator('.mprice')).toHaveText('10,50 €');

    await addItem(page, 'hummus', 2);
    await openBasket(page);
    await expect(page.locator('.cart-line-price')).toContainText('21,00');
    await choosePickup(page);
    await fillContact(page, {});
    await page.locator('#cartSend').click();
    const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
    expect(message).toContain('2× Hummus — 21,00');
  } finally {
    await goAdmin(page, '/admin/prices');
    const all = page.locator('form.reset-all button');
    if (await all.count()) await all.click();
  }

  await goAdmin(page, '/admin/prices');
  await expect(page.locator('input[name="price:hummus"]')).toHaveValue('9,50');
  await expect(page.locator('form.reset-all')).toHaveCount(0);
});
