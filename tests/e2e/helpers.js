import { expect } from '@playwright/test';
// The server's own reading of a payment, so the stub can never disagree with it.
import { moneyState } from '../../worker/payments/store.js';

/** Add a dish to the basket n times. */
export async function addItem(page, id, times = 1) {
  const row = page.locator(`.mitem[data-item="${id}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator('[data-act="inc"]').click();
  for (let i = 1; i < times; i++) await row.locator('[data-act="inc"]').click();
  await expect(page.locator('#cartFab')).toBeVisible();
}

export async function openBasket(page) {
  await page.locator('#cartFab').click();
  await expect(page.locator('#cartPanel')).toBeVisible();
}

/** The service mode the Worker actually rendered this page in — 'pickup' or
 *  'delivery' — read from the live island, never from config.js. /admin can
 *  switch it, and the database wins over the file. Loop WEBSITE_ORDERING, B. */
export async function serviceMode(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(document.getElementById('kairoLive').textContent).serviceMode || null;
    } catch { return null; }
  });
}

/** Skip a test that only means something while delivery is offered, with the
 *  reason said — and only after reading the effective mode, never at
 *  registration and never from cleanup. Call it after page.goto. */
export async function requireDelivery(page, testInfo) {
  testInfo.skip(await serviceMode(page) === 'pickup', 'pickup-only service: no delivery to test');
}

/* Choose pickup in the basket.
   In delivery mode the basket opens on delivery, so an address is required
   unless pickup is chosen; a test that skips this is stopped by the same
   validation a guest would meet. In pickup-only mode there is nothing to
   choose: the basket says where to collect, offers no delivery and asks for no
   address — and that is asserted here, not assumed. A missing pickup button
   while delivery IS offered is a failure, never a silent pass. */
export async function choosePickup(page) {
  if (await serviceMode(page) === 'pickup') {
    await expect(page.locator('#cartPanel [data-type="delivery"]')).toHaveCount(0);
    await expect(page.locator('#cartPanel .cart-note', { hasText: 'Rostocker Straße 20a' })).toHaveCount(1);
    await expect(page.locator('#fAddressWrap')).toBeHidden();
    return;
  }
  const button = page.locator('[data-type="pickup"]');
  await expect(button, 'delivery mode must still offer pickup').toBeVisible();
  await button.click();
  await expect(button).toHaveClass(/(^|\s)active(\s|$)/);
}

/* Delivery is not on offer at every hour: a driver's shift starts later than
   the door opens (config.js -> hours.deliveryFrom), so before that time the
   delivery button is deliberately dim. A test about fees, zones or minimums is
   not a test about the clock, and it must not pass or fail according to what
   time CI happens to start — so when delivery is withheld, this schedules the
   next moment that does deliver, exactly as the note under the dimmed button
   tells a guest to.

   The moment is read out of the page's own `KAIRO_CONFIG`, never typed here.
   A time written into a test is a second copy of the opening hours, and it is
   the copy nobody remembers to change. The browser is pinned to Europe/Berlin
   by playwright.config.js, so its local day and the restaurant's are one. */
export async function chooseDelivery(page) {
  const button = page.locator('[data-type="delivery"]');

  if (!(await button.isEnabled())) {
    const slot = await page.evaluate(() => {
      const hours = window.KAIRO_CONFIG.hours;
      const KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const from = hours.deliveryFrom || '';
      const now = new Date();

      for (let i = 0; i < 14; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const day = hours.days[KEYS[(d.getDay() + 6) % 7]];
        if (!day || day.closed) continue;

        // The opening, clipped to the delivery shift — the same arithmetic
        // deliverySlotsFor() does in order.js, and for the same reason: the
        // window that delivers is not a window anybody wrote down.
        const windows = [];
        for (const w of [day.lunch, day.evening]) {
          if (!w) continue;
          if (from && from >= w[1]) continue;
          windows.push([from && from > w[0] ? from : w[0], w[1]]);
        }

        for (const w of windows) {
          const [h, m] = w[0].split(':').map(Number);
          // A quarter of an hour past opening: comfortably inside the window,
          // so a slot cannot be missed by a minute either side.
          const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m + 15);
          if (at > now) {
            const pad = (n) => String(n).padStart(2, '0');
            return {
              date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
              time: `${pad(at.getHours())}:${pad(at.getMinutes())}`
            };
          }
        }
      }
      return null;
    });

    expect(slot, 'config.js must offer some window that delivers').not.toBeNull();
    await page.locator('[data-when="scheduled"]').click();
    await page.locator('#fDate').fill(slot.date);
    await page.locator('#fTime').fill(slot.time);
    await expect(button).toBeEnabled();
  }

  await button.click();
}

export async function fillContact(page, {
  name = 'Test Gast', phone = '+49 176 1234567', address = null, postcode = null, town = null
} = {}) {
  await page.locator('#fName').fill(name);
  await page.locator('#fPhone').fill(phone);
  if (address) await page.locator('#fAddress').fill(address);
  if (postcode) await choosePostcode(page, postcode, town);
}

/** Choose where a delivery goes, from the list (PO-15). A postcode that is not on
 *  the list is chosen as "not listed" and typed into the enquiry's own field.
 *  Without a town, a single-town postcode's one town is taken from the page's
 *  own list; a postcode with several towns must name the town. */
export async function choosePostcode(page, postcode, town = null) {
  const listed = await page.evaluate(([code, wanted]) => {
    const row = (window.KAIRO_ZONES || []).find((z) => z[0] === code);
    if (!row) return null;
    if (wanted) return row[5].includes(wanted) ? wanted : null;
    return row[5].length === 1 ? row[5][0] : 'AMBIGUOUS';
  }, [postcode, town]);
  if (listed === 'AMBIGUOUS') throw new Error(postcode + ' has several towns: name one');
  if (listed) {
    await page.locator('#fPlz').selectOption(postcode + '|' + listed);
    return;
  }
  await page.locator('#fPlz').selectOption('not-listed');
  await page.locator('#fPlzOther').fill(postcode);
}

/** Intercept the WhatsApp handover. window.open would otherwise leave the
 *  page, and the message it carries is the thing worth asserting.
 *
 *  It returns a window-like object because that is what a browser returns when
 *  it ALLOWS the popup, and the page reads a null return as "blocked" and says
 *  so on screen. Returning null here used to fabricate a blocked popup in
 *  every test that captured the handover — which is how a real bug in the page
 *  stayed hidden behind a test that failed at random. A fake must never report
 *  something the real thing would not.
 *
 *  The two tests that are ABOUT blocking install their own stub; see
 *  payment.spec.js. */
export async function captureWhatsApp(page) {
  await page.addInitScript(() => {
    window.__waUrl = null;
    window.open = (url) => {
      window.__waUrl = url;
      return { closed: false, opener: null, focus() {}, close() {} };
    };
  });
  return async () => {
    await expect.poll(() => page.evaluate(() => window.__waUrl)).toBeTruthy();
    return page.evaluate(() => window.__waUrl);
  };
}

/* --- standing in for the provider in the browser -------------------------
   The real PayPal SDK cannot run in CI without live credentials and a real
   card, so it is replaced by a script that renders a button and drives the
   same callbacks the real one does. Everything on OUR side of the boundary —
   creating the payment, capturing it, the confirmation, what the restaurant
   is told — is exercised for real against the Worker. */

/**
 * The Worker needs live PayPal credentials to create a real order, which CI
 * does not have. So the payment API is answered here instead.
 *
 * That boundary is deliberate. What the Worker does with a payment is covered
 * in tests/integration against the actual routes: pricing it, capturing it,
 * refusing a double capture, verifying a webhook, surviving a lost callback.
 * Linking a payment to an order (order-payment-link.test.js) is covered there
 * too, on payment rows whose status the test sets, NOT through a real PayPal
 * capture. Nothing in these browser tests proves linkage: the announce after a
 * stubbed payment is answered by the stub (W02-05). What only a browser can prove
 * is what these tests cover: that the guest sees the right thing at each step
 * and that the right words reach the restaurant.
 *
 * @param {'approve'|'cancel'|'error'|'decline'|'pending'} outcome
 */
export async function stubPayments(page, { methods = ['paypal'], outcome = 'approve',
  amount = 1710, reference = 'K7F3QA', status = null, created = null, createDelay = 0 } = {}) {
  const id = 'test-payment-id';
  /* A payment as the server shows it, `money` and all (DP-25-01). A status may
     carry its reason as 'status:reason'; a failed or cancelled one without a
     reason gets the one that makes it "no money", as the real routes write it. */
  const DEFAULT_REASON = { failed: 'INSTRUMENT_DECLINED', cancelled: 'abandoned_unapproved' };
  const shown = (spec, extra = {}) => {
    const [state, given] = String(spec).split(':');
    const failureCode = given !== undefined ? (given || null) : (DEFAULT_REASON[state] || null);
    return { id, reference, status: state, amount, currency: 'EUR', failureCode,
             money: moneyState({ status: state, failure_code: failureCode }), ...extra };
  };

  /* Loop WEBSITE_ORDERING, W02-05. A stubbed payment is not a payment, so the
     handover that follows it must not reach the real Worker as if it were:
     it used to, and 101 orders "paid online" by `test-payment-id` piled up in
     the local database. The announce is answered here and its request kept;
     real linkage is proven only by tests/integration/order-payment-link. */
  const stub = { announced: [] };
  await page.route('**/api/orders/announce', (route) => {
    stub.announced.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ recorded: true, reference })
    });
  });

  await page.route('**/api/payments/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        online: true, methods,
        keys: { paypal: { clientId: 'test-client' } },
        environment: 'sandbox', currency: 'EUR', onSite: {}
      })
    }));

  /* The stub never invents a price: the amount it was given must be what the
     real Worker quotes for the basket the page sent, or it answers with an
     error and the test fails on screen. W02-05. */
  await page.route('**/api/payments', async (route) => {
    // Asked of the real Worker through the route itself, with the very body the
    // page sent for payment.
    const quoteUrl = new URL('/api/payments/quote', route.request().url()).href;
    let quoted;
    try {
      quoted = await (await route.fetch({ url: quoteUrl, method: 'POST' })).json();
    } catch {
      // The test finished while this was in flight (it had already asserted
      // what it needed). Nothing is left to answer.
      return route.abort().catch(() => {});
    }
    // What the page asked for, kept so a test can read it.
    const asked = route.request().postDataJSON();
    stub.created = (stub.created || []).concat([asked]);
    // The first payment's answer can be made to land late (`createDelay`, ms).
    if (createDelay && stub.created.length === 1) await new Promise((r) => setTimeout(r, createDelay));
    if (quoted.total !== amount) {
      return route.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'stub_amount_mismatch',
          message: `stub amount ${amount} is not the Worker quote ${quoted.total}` } })
      });
    }
    /* The create answer carries the Worker's own breakdown and priced lines,
       as the real one does (DP-24-02); `created` lets a test spoil them. */
    const answer = {
      id, reference, provider: 'paypal', providerOrderId: 'PP-ORDER-1',
      amount, amountText: (amount / 100).toFixed(2), currency: 'EUR',
      breakdown: { subtotal: quoted.subtotal, discount: quoted.discount, fee: quoted.fee },
      lines: quoted.lines
    };
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(created ? created(answer) : answer)
    });
  });

  /* What the server says the payment is now, when the page asks. By default
     what the outcome left it as; `status` (a value, or a function of how many
     times it was asked) stands in for a capture or a webhook that landed while
     the page was not looking. */
  const settled = { approve: 'captured', pending: 'pending', decline: 'failed', cancel: 'cancelled' }[outcome] || 'approved';
  stub.asked = 0;
  await page.route('**/api/payments/' + id, (route) => {
    stub.asked += 1;
    const now = typeof status === 'function' ? status(stub.asked) : (status || settled);
    if (now === 'network') return route.abort();
    // Answered, but with nothing a page can settle anything on.
    if (now === 'empty') return route.fulfill({ contentType: 'application/json', body: '{}' });
    if (now === 'null') return route.fulfill({ contentType: 'application/json', body: '{"payment":null}' });
    if (now === 'other') {
      return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ payment: { ...shown('cancelled'), id: 'another-payment' } }) });
    }
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ payment: shown(now) }) });
  });

  stub.captures = 0;
  stub.cancels = 0;
  await page.route('**/api/payments/*/capture', (route) => {
    stub.captures += 1;
    // The capture's answer never arrives: a dropped connection after the money moved, or not.
    if (outcome === 'lost') return route.abort();
    if (outcome === 'lost500') {
      return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' });
    }
    if (outcome === 'decline') {
      return route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({
          payment: shown('failed:INSTRUMENT_DECLINED'),
          error: 'declined'
        })
      });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ payment: shown(outcome === 'pending' ? 'pending' : 'captured') })
    });
  });

  stub.cancelAnswer = 'cancelled';
  await page.route('**/api/payments/*/cancel', (route) => {
    stub.cancels += 1;
    if (stub.cancelAnswer === 'network') return route.abort();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ payment: shown(stub.cancelAnswer) })
    });
  });

  await page.route('**/sdk/js*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: fakeSdk(outcome)
    }));

  return stub;
}

function fakeSdk(outcome) {
  return `
    window.paypal = {
      FUNDING: { PAYPAL: 'paypal', CARD: 'card' },
      // Deliberately NOT providing getFundingSources or isFundingEligible.
      // The real SDK does not always expose them, and a stub more capable than
      // the real thing hid a bug that suppressed every button on the payment
      // step. A fake must never be more able than what it stands in for.
      // Apple Pay and Google Pay go through their own components, and both
      // report themselves ineligible here — which is the truth in a Chromium
      // test browser with no wallet and no Advanced Checkout. The page must
      // draw the two methods that DO work and silently skip the two that
      // do not.
      Applepay: () => ({ config: () => Promise.resolve({ isEligible: false }) }),
      Googlepay: () => ({ config: () => Promise.resolve({ isEligible: false }) }),
      Buttons: function (opts) {
        return {
          isEligible: () => true,
          render: async (host) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'fake-pay-button';
            button.dataset.funding = opts.fundingSource;
            button.textContent = 'Pay with ' + opts.fundingSource;
            button.addEventListener('click', async () => {
              try {
                await opts.createOrder();
                if ('${outcome}' === 'cancel') { opts.onCancel(); return; }
                if ('${outcome}' === 'error') { opts.onError(new Error('x')); return; }
                await opts.onApprove();
              } catch (err) { /* the page reports it */ }
            });
            host.appendChild(button);
          }
        };
      }
    };
  `;
}
