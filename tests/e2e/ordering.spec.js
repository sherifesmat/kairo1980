/* The journey a guest actually takes: open the site, look at the menu, build
   a basket, find out whether we deliver to them, and place the order.

   These assert business outcomes — the price shown, the fee charged, the
   warning given, what reaches the restaurant — not pixels. */

import { test, expect } from '@playwright/test';
import { addItem, openBasket, captureWhatsApp, fillContact, choosePickup, chooseDelivery } from './helpers.js';

test('the menu shows a price for every dish that can be ordered', async ({ page }) => {
  await page.goto('/');
  const items = page.locator('.mitem[data-item]');
  await expect(items.first()).toBeVisible();

  const count = await items.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    // A dish a guest can add must have a price the guest can see, and the two
    // must be the same number.
    const price = await item.getAttribute('data-price');
    const figure = (text) => Number(text.replace(/[^\d,]/g, '').replace(',', '.'));
    if (price == null) {
      // Priced by its options (the KAIRO Bowl): every option that carries a
      // price prints that same price in its own row.
      const options = item.locator('.mchoice[data-price]');
      expect(await options.count()).toBeGreaterThan(0);
      for (let j = 0; j < await options.count(); j++) {
        const option = options.nth(j);
        expect(figure(await option.locator('.mchoice-price').innerText()))
          .toBeCloseTo(Number(await option.getAttribute('data-price')), 2);
      }
      continue;
    }
    expect(Number(price)).toBeGreaterThan(0);
    expect(figure(await item.locator('.mprice').innerText())).toBeCloseTo(Number(price), 2);
  }
});

test('adding items updates the basket total, and quantities can be changed', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);

  const fab = page.locator('#cartFab');
  await expect(fab).toBeVisible();
  await expect(page.locator('#cartFabCount')).toHaveText('2');

  // 2 × 9.50 = 19.00, less the 10 % direct discount = 17.10
  await expect(page.locator('#cartFabTotal')).toContainText('17,10');

  // Taking one back off is reflected everywhere.
  await page.locator('.mitem[data-item="hummus"] [data-act="dec"]').click();
  await expect(page.locator('#cartFabCount')).toHaveText('1');
  await expect(page.locator('#cartFabTotal')).toContainText('8,55');
});

test('the basket survives a reload, so a phone call does not cost the order', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await page.reload();
  await expect(page.locator('#cartFabCount')).toHaveText('2');
});

test('a postcode we deliver to shows its fee before the guest commits', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await openBasket(page);

  await chooseDelivery(page);
  await page.locator('#fPlz').fill('69168');   // Wiesloch: 20 € minimum, 2 € fee

  const body = page.locator('#cartBody');
  await expect(body).toContainText('Wiesloch');
  await expect(body).toContainText('2,00');
});

test('a sub-minimum order is warned about but never blocked', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 1);          // 9.50, under the 20 € minimum
  await openBasket(page);
  await chooseDelivery(page);
  await page.locator('#fPlz').fill('69168');

  // Warned…
  await expect(page.locator('.cart-zone')).toHaveClass(/is-below-min/);
  // …and still orderable. The send button must never be disabled for this.
  await expect(page.locator('#cartSend')).toBeEnabled();
});

test('a postcode outside the area becomes an enquiry rather than a refusal', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await chooseDelivery(page);
  await page.locator('#fPlz').fill('10115');   // Berlin

  await expect(page.locator('.cart-zone')).toHaveClass(/is-unknown/);
  await expect(page.locator('#cartSend')).toBeEnabled();
});

test('the order that reaches the restaurant carries the items, total and contact', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, { name: 'Sherif Esmat', phone: '+49 176 79906621' });
  await page.locator('#cartSend').click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  // The dish name and nothing else. The allergen letters are a footnote for
  // the guest on the website; the kitchen already knows its own recipes, and
  // "Hummusa,h,k" in an order is noise.
  expect(message).toContain('2× Hummus —');
  expect(message).not.toMatch(/Hummus[a-k],/);
  expect(message).toContain('17,10');
  expect(message).toContain('Sherif Esmat');
  expect(message).toContain('+49 176 79906621');
  // Nothing was paid, so the chat must be told to collect on arrival.
  expect(message).toMatch(/Bargeld|EC-|Kreditkarte/);
});

test('warnings survive the trip to WhatsApp intact', async ({ page }) => {
  // The warning sign U+26A0 was the obvious marker and the wrong one: wa.me
  // redirects through api.whatsapp.com, and that redirect replaces it with
  // U+FFFD, so the kitchen read a broken character on the line that matters
  // most. A check mark and an em dash survive the same trip; this one does
  // not. Nothing above ASCII goes in a flag.
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await chooseDelivery(page);
  await fillContact(page, { address: 'Teststr. 1', postcode: '10115' });   // Berlin — outside the area
  await page.locator('#cartSend').click();

  const message = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  const flags = message.split(/\r?\n/).filter((line) => line.startsWith('*!'));
  expect(flags.length, 'an out-of-area order must be flagged').toBeGreaterThan(0);
  for (const line of flags) expect(line.slice(0, 3)).toBe('*! ');

  expect(message, 'no replacement character').not.toContain('�');
  expect(message, 'no glyph WhatsApp mangles').not.toContain('⚠');
});

test('the confirmation screen appears and the basket is emptied afterwards', async ({ page }) => {
  await captureWhatsApp(page);
  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  await page.locator('#cartSend').click();

  await expect(page.locator('.cart-sent')).toBeVisible();
  await expect(page.locator('#cartFab')).toBeHidden();
});

test('a very large order still produces a URL WhatsApp will open', async ({ page }) => {
  // A wa.me link carries the order in its query string. Past a point a browser
  // or mobile OS simply refuses to follow it — silently. The URL must stay
  // openable, and nothing may be lost: the full text goes to the clipboard.
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');

  // One of everything on the menu. Line count is what grows the URL, not
  // quantity, so this is the largest realistic order the site can produce.
  // Re-query each time: paintMenu() replaces the button after every click, so
  // a cached NodeList goes stale after the first one.
  await page.evaluate(() => {
    document.querySelectorAll('.mitem[data-item]').forEach((row) => {
      const add = row.querySelector('[data-act="inc"]');
      if (add) add.click();
    });
  });
  // Dishes with choices go through the chooser, with everything ticked: the
  // longest line a guest can build is the one that stretches the URL most.
  for (const [id, picks] of [
    ['kairo-bowl', ['nudeln', 'kebda', 'hausgemachter-karkadeh-0-5-l', 'salata-baladi', 'tahini-dip', 'habanero-sauce']],
    ['soguk-baladi-menue', ['hausgemachter-karkadeh-0-5-l']]
  ]) {
    const row = page.locator(`.mitem[data-item="${id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.locator('[data-act="choose"]').click();
    for (const value of picks) await page.locator(`.chooser input[value="${value}"]`).check();
    await page.locator('.chooser [data-act="chooser-add"]').click();
  }
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, { name: 'Grossbestellung Test', phone: '+49 176 0000000' });
  await page.locator('#cartSend').click();

  const url = await whatsapp();
  const sent = decodeURIComponent(url.split('?text=')[1]);

  // The invariant, and the only thing that matters: the link stays openable,
  // and what it carries is a complete order rather than a severed one.
  expect(url.length, 'the URL must stay openable').toBeLessThanOrEqual(3500);
  expect(sent).toContain('Gesamt');
  expect(sent).toContain('Grossbestellung Test');

  /* "Not severed" is a statement about the LAST LINE, not about the last
     character. Every line the builder can end on is either a labelled
     "Feld: Wert" or a bolded warning, so a message cut short by URL length
     shows up here as a trailing fragment that is neither.

     This used to assert the final character was a digit, a full stop or "€",
     which passed only because the run happened to fall in the closed
     afternoon and end on the pre-order warning. Open straight through, the
     order ends on "Wunschtermin: So schnell wie möglich" — a complete message
     that the old check called severed. */
  const last = sent.trimEnd().split('\n').pop();
  expect(last, 'the message must end on a whole line').toMatch(/^(\*!.+\*|[^:\n]+: .+)$/);

  // Whatever went in the URL, the full order is still copyable from the page.
  await expect(page.locator('.cart-sent')).toBeVisible();
  expect(await page.evaluate(() => !!document.querySelector('#cartFallback'))).toBe(true);
});

test('a normal order is sent in full, with prices on every line', async ({ page }) => {
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');
  await addItem(page, 'hummus', 2);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, {});
  await page.locator('#cartSend').click();

  const sent = decodeURIComponent((await whatsapp()).split('?text=')[1]);
  expect(sent).toContain('2× Hummus');
  expect(sent).toContain('19,00');            // the line price, not just the total

  // window.open is called BEFORE the confirmation is drawn, so waiting on the
  // URL alone proves nothing about the screen: "no warning yet" and "no
  // warning" look identical for as long as the render takes. Wait for the
  // screen to exist, then assert what is on it.
  await expect(page.locator('.cart-sent')).toBeVisible();
  await expect(page.locator('.cart-blocked')).toHaveCount(0);
});

test('an order cannot be sent without a name and a phone number', async ({ page }) => {
  await captureWhatsApp(page);
  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await page.locator('#cartSend').click();

  await expect(page.locator('#fName')).toHaveClass(/is-invalid/);
  await expect(page.locator('.cart-sent')).toHaveCount(0);
});

test('switching language keeps the basket and translates the chrome', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);

  // From the page, not from inside the open basket: the drawer's backdrop
  // covers the header, which is the intended behaviour for a modal.
  await page.locator('[data-lang="en"]').first().click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#cartFabCount')).toHaveText('2');

  await page.locator('[data-lang="ar"]').first().click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#cartFabCount')).toHaveText('2');
});

test('the page never scrolls sideways on a phone', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);
  await openBasket(page);

  const overflows = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflows).toBe(false);
});

/* --- the two delivery rules ------------------------------------------------
   Free delivery from the threshold, for everyone. The minimum order value
   only for a private order that has to be driven out. Both are stated in
   config.js and asserted here as a guest meets them: in the basket, and in
   the message the restaurant reads. */

test('free delivery is announced to everyone once the threshold is reached', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'etwas-von-allem', 4);  // 4 × 26.00 = 104.00, over 100 €
  await openBasket(page);
  await chooseDelivery(page);
  await page.locator('#fPlz').fill('69168');  // Wiesloch would otherwise cost 2 €

  const body = page.locator('#cartBody');
  await expect(body).toContainText('kostenfrei');
  await expect(body).toContainText('2,00');   // what was saved, named
});

test('below the threshold the basket says how much is missing', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 2);           // 19.00
  await openBasket(page);
  await chooseDelivery(page);
  await page.locator('#fPlz').fill('69168');

  // 100.00 − 19.00 = 81.00 still to go.
  await expect(page.locator('#cartBody')).toContainText('81,00');
});

test('a company order is not asked for a minimum, on screen or in the chat',
  async ({ page }) => {
    const whatsapp = await captureWhatsApp(page);
    await page.goto('/?lang=de');
    await addItem(page, 'hummus', 1);         // 9.50, far under Wiesloch's 20 €
    await openBasket(page);
    await chooseDelivery(page);
    await page.locator('#fPlz').fill('69168');

    const zone = page.locator('.cart-zone');
    await expect(zone).toContainText('Mindestbestellwert');

    // Ticking "Firmenbestellung" is what removes it — the same order, a
    // different customer.
    await page.locator('#fBusiness').check();
    await expect(zone).not.toContainText('Mindestbestellwert');
    await expect(page.locator('.cart-zone.is-below-min')).toHaveCount(0);

    await fillContact(page, { address: 'Hauptstraße 1', postcode: '69168' });
    await page.locator('#cartSend').click();
    const sent = decodeURIComponent((await whatsapp()).split('?text=')[1]);
    expect(sent).not.toContain('Mindestbestellwert');
  });

test('a collected order is never held to a delivery minimum', async ({ page }) => {
  await page.goto('/');
  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await choosePickup(page);
  await expect(page.locator('#cartBody')).not.toContainText('Mindestbestellwert');
});

/* --- the menu has to be VISIBLE, not merely present ----------------------
   A guest reported a blank menu on an Android phone, on both Brave and Chrome,
   cured only by "Desktop site". The markup was there the whole time: the
   reveal-on-scroll observer used `threshold: 0.12`, which is a fraction of THE
   ELEMENT, and #speisekarte is the entire menu — many times taller than a
   phone. A full screen of it was about 9%, so the threshold could never be
   met and the section stayed at opacity 0.

   The old mobile project missed it by luck: a Pixel 7 is tall enough that the
   ratio just cleared 12%. So these run on a deliberately small viewport, which
   is where the arithmetic actually bites, and assert what a guest can SEE. */

const SMALL = { width: 360, height: 640 };

test('the menu is visible on a small phone, not just present in the DOM', async ({ page }) => {
  await page.setViewportSize(SMALL);
  await page.goto('/?lang=de');

  const menu = page.locator('#speisekarte');
  await menu.scrollIntoViewIfNeeded();

  // opacity is what the bug actually was — `toBeVisible()` alone passes on an
  // element that is fully transparent, which is exactly how this shipped.
  await expect.poll(
    () => menu.evaluate((el) => Number(getComputedStyle(el).opacity)),
    { message: 'the menu section must not stay transparent', timeout: 7000 }
  ).toBeGreaterThan(0.9);

  const first = page.locator('.mitem[data-item]').first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/\d/);
});

test('every long section reveals itself on a small phone', async ({ page }) => {
  /* Not only the menu: #firmen, #faq and #liefergebiet are all `.fade-in` and
     all grow past a phone's height. Whatever hid one hid the others, so the
     guarantee is asserted for the set rather than the symptom. */
  await page.setViewportSize(SMALL);
  await page.goto('/?lang=de');

  for (const id of ['ueber-uns', 'speisekarte', 'firmen', 'faq', 'liefergebiet']) {
    const section = page.locator(`#${id}`);
    if (!(await section.count())) continue;
    await section.scrollIntoViewIfNeeded();
    await expect.poll(
      () => section.evaluate((el) => Number(getComputedStyle(el).opacity)),
      { message: `#${id} must not stay transparent`, timeout: 7000 }
    ).toBeGreaterThan(0.9);
  }
});

test('a basket can be built and sent on a small phone', async ({ page }) => {
  // The end of the same story: an invisible menu cannot be ordered from.
  await page.setViewportSize(SMALL);
  const whatsapp = await captureWhatsApp(page);
  await page.goto('/?lang=de');

  await addItem(page, 'hummus', 1);
  await openBasket(page);
  await choosePickup(page);
  await fillContact(page, { name: 'Kleines Display', phone: '+49 176 5559999' });
  await page.locator('#cartSend').click();

  expect(await whatsapp()).toContain('wa.me');
  await expect(page.locator('.cart-sent')).toBeVisible();
});

test('no page scrolls sideways on a small phone', async ({ page }) => {
  // Twelve navigations in one test: three widths across four pages.
  test.slow();
  /* An overflow anywhere scrolls the WHOLE document, so one cramped menu row
     made every section drift. Two were found this way: the dish row at 320px,
     and an unbreakable provider URL in the privacy policy that pushed
     /datenschutz 65px past a 360px screen. Both are the kind of fault nobody
     reports — the page still works, it just feels broken. */
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 640 });
    for (const path of ['/', '/firmencatering', '/impressum', '/datenschutz']) {
      await page.goto(path + '?lang=de');
      const over = await page.evaluate(() => {
        const d = document.documentElement;
        if (d.scrollWidth <= d.clientWidth + 1) return null;
        const worst = [...document.querySelectorAll('body *')]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter((x) => x.r.width > 0 && x.r.right > d.clientWidth + 1)
          .sort((a, b) => b.r.right - a.r.right)[0];
        return {
          scrollWidth: d.scrollWidth,
          clientWidth: d.clientWidth,
          worst: worst ? worst.el.tagName + '.' + String(worst.el.className).split(' ')[0] : '?'
        };
      });
      expect(over, `${path} at ${width}px overflows: ${JSON.stringify(over)}`).toBeNull();
    }
  }
});

test('the language switch is big enough to hit', async ({ page }) => {
  // 16x12 on the control that decides the language of the whole site.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/?lang=de');
  const boxes = await page.locator('.lang-btn').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    }));
  expect(boxes.length).toBeGreaterThan(0);
  for (const b of boxes) {
    expect(b.h, `language button only ${b.w}x${b.h}`).toBeGreaterThanOrEqual(24);
  }
});
