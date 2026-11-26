/* What an order costs. These are business rules, not arithmetic: each test
   below is a sentence somebody could say out loud about the restaurant. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, PricingError, toAmount } from '../../worker/pricing.js';
import { workerEnv } from '../helpers/env.js';

/** The one town of a single-town postcode, from the generated list. */
const townOf = (postcode) => {
  const row = globalThis.KAIRO_ZONES.find((z) => z[0] === postcode);
  assert.ok(row && row[5].length === 1, postcode + ' is a single-town postcode');
  return row[5][0];
};

const env = workerEnv({
  hummus: { price: 950, name: 'Hummus' },
  koshari: { price: 1450, name: 'Koshari' },
  platter: { price: 2000, name: 'Platter' },
  'cent-off': { price: 1999, name: 'Cent off' }
});

test('prices the basket from the published menu, not from the request', async () => {
  const q = await quote(env, { items: { hummus: 2 }, type: 'pickup', postcode: '' });
  assert.equal(q.subtotal, 1900);
});

test('the direct-order discount is 10 % of the food', async () => {
  const q = await quote(env, { items: { hummus: 2 }, type: 'pickup' });
  assert.equal(q.discountPercent, 10);
  assert.equal(q.discount, 190);
  assert.equal(q.total, 1710);
});

test('a delivery inside a paid zone adds that zone fee', async () => {
  // 69168 Wiesloch: minimum 20 €, fee 2 €.
  const q = await quote(env, { items: { koshari: 2 }, type: 'delivery', postcode: '69168', town: 'Wiesloch' });
  assert.equal(q.subtotal, 2900);
  assert.equal(q.fee, 200);
  assert.equal(q.total, 2900 - 290 + 200);
});

test('the discount never applies to the delivery fee', async () => {
  const q = await quote(env, { items: { koshari: 2 }, type: 'delivery', postcode: '69168', town: 'Wiesloch' });
  // A 10 % discount on 31.00 would be 3.10; on the food alone it is 2.90.
  assert.equal(q.discount, 290);
});

test('the fee is waived once the food reaches the free-delivery threshold', async () => {
  // freeDeliveryFrom is 100 € on the food subtotal, before the discount.
  const q = await quote(env, { items: { koshari: 7 }, type: 'delivery', postcode: '69168', town: 'Wiesloch' });
  assert.equal(q.subtotal, 10150);
  assert.equal(q.fee, 0);
  assert.equal(q.freeDelivery, true);
});

test('free delivery is the same rule for a company and for a private guest', async () => {
  // One threshold, no carve-out: the same basket to the same postcode costs
  // the same to drive, whoever ordered it.
  const items = { koshari: 7 };
  const asCompany = await quote(env, { items, type: 'delivery', postcode: '69168', town: 'Wiesloch', business: true });
  const asPrivate = await quote(env, { items, type: 'delivery', postcode: '69168', town: 'Wiesloch', business: false });
  assert.equal(asCompany.fee, 0);
  assert.equal(asPrivate.fee, 0);
  assert.equal(asCompany.total, asPrivate.total);
});

test('below the threshold both pay the same fee, too', async () => {
  const items = { hummus: 1 };
  const asCompany = await quote(env, { items, type: 'delivery', postcode: '69168', town: 'Wiesloch', business: true });
  const asPrivate = await quote(env, { items, type: 'delivery', postcode: '69168', town: 'Wiesloch', business: false });
  assert.equal(asCompany.fee, 200);
  assert.equal(asPrivate.fee, 200);
});

test('a postcode we do not serve is not a delivery: no zone, no fee, and not deliverable', async () => {
  // PO-15: an unlisted postcode is an enquiry in the chat. The quote still answers
  // (the basket can show the food), but it is not an order with no fee -- the
  // payment and order routes refuse it (tests/integration/listed-delivery.test.js).
  const q = await quote(env, { items: { hummus: 1 }, type: 'delivery', postcode: '10115' });
  assert.equal(q.zone, null);
  assert.equal(q.fee, 0);
  assert.equal(q.deliverable, false);
});

test('a sub-minimum private delivery is flagged but still priced', async () => {
  // 76661 Philippsburg has a 50 € minimum.
  const q = await quote(env, { items: { hummus: 1 }, type: 'delivery', postcode: '76661', town: 'Philippsburg' });
  assert.equal(q.belowMinimum, true);
  assert.ok(q.total > 0);
});

test('a company delivery is held to its zone minimum like any other', async () => {
  // Owner, 23.10.2026: the minimum pays for a driver's trip, and a trip to an
  // office costs what a trip to a home costs.
  const q = await quote(env, {
    items: { hummus: 1 }, type: 'delivery', postcode: '76661', town: 'Philippsburg', business: true
  });
  assert.equal(q.belowMinimum, true);
  assert.ok(q.total > 0);
});

test('a company pickup is never held to the minimum — there is no trip', async () => {
  const q = await quote(env, {
    items: { hummus: 1 }, type: 'pickup', postcode: '76661', town: 'Philippsburg', business: true
  });
  assert.equal(q.belowMinimum, false);
});

test('the fees raised on 23.10.2026: 0 € zones pay 1 €, 1 € zones pay 2 €, the rest unchanged', async () => {
  const items = { hummus: 1 };
  const fee = async (postcode) => (await quote(env, { items, type: 'delivery', postcode, town: townOf(postcode) })).fee;
  assert.equal(await fee('68766'), 100);   // Hockenheim, was 0
  assert.equal(await fee('68775'), 100);   // Ketsch, was 0
  assert.equal(await fee('69190'), 200);   // Walldorf, was 1
  assert.equal(await fee('69214'), 200);   // Eppelheim, was 1
  assert.equal(await fee('69168'), 200);   // Wiesloch, was 2: unchanged
  assert.equal(await fee('76661'), 300);   // Philippsburg, was 3: unchanged
});

test('the channels agreed on 26.11.2026: free from 80 €, Ladenburg 25/4, nothing above the 7,50 € Uber allows', async () => {
  /* Lieferando is the reference and Uber caps a fee at 7,50 €, so the website
     states the same figures. Each line is a number the owner set by name. */
  const at = async (items, postcode) => quote(env, { items, type: 'delivery', postcode, town: townOf(postcode) });

  // 79,99 € of food still pays the fee; 80,00 € does not.
  assert.equal((await at({ platter: 3, 'cent-off': 1 }, '69168')).fee, 200);
  const free = await at({ platter: 4 }, '69168');
  assert.equal(free.subtotal, 8000);
  assert.equal(free.fee, 0);
  assert.equal(free.freeDelivery, true);

  // Ladenburg: 4 € and a 25 € minimum, which a 20 € basket does not reach.
  const ladenburg = await at({ platter: 1 }, '68526');
  assert.equal(ladenburg.fee, 400);
  assert.equal(ladenburg.belowMinimum, true);
  assert.equal((await at({ platter: 1, hummus: 1 }, '68526')).belowMinimum, false);

  // The three far postcodes were 8 €; Uber cannot charge more than 7,50 €.
  for (const postcode of ['69117', '67346', '76646']) {
    assert.equal((await at({ platter: 3 }, postcode)).fee, 750, postcode);
  }
});

test('pickup is never held to the minimum — there is no trip to pay for', async () => {
  const q = await quote(env, { items: { hummus: 1 }, type: 'pickup', postcode: '76661', town: 'Philippsburg' });
  assert.equal(q.belowMinimum, false);
});

test('pickup never pays a delivery fee, whatever postcode is typed', async () => {
  const q = await quote(env, { items: { hummus: 1 }, type: 'pickup', postcode: '76661', town: 'Philippsburg' });
  assert.equal(q.fee, 0);
  assert.equal(q.zone, null);
});

test('an item that is not on the menu is refused outright', async () => {
  await assert.rejects(
    () => quote(env, { items: { 'free-lunch': 1 }, type: 'pickup' }),
    (err) => err instanceof PricingError && err.code === 'unknown_item'
  );
});

test('an empty basket cannot be paid for', async () => {
  await assert.rejects(
    () => quote(env, { items: {}, type: 'pickup' }),
    (err) => err.code === 'empty_cart'
  );
});

test('quantities that are not positive whole numbers are ignored', async () => {
  await assert.rejects(
    () => quote(env, { items: { hummus: -5 }, type: 'pickup' }),
    (err) => err.code === 'empty_cart'
  );
  await assert.rejects(
    () => quote(env, { items: { hummus: 'lots' }, type: 'pickup' }),
    (err) => err.code === 'empty_cart'
  );
});

test('an absurd basket is refused rather than sent to a provider', async () => {
  await assert.rejects(
    () => quote(env, { items: { hummus: 5000 }, type: 'pickup' }),
    (err) => err.code === 'too_many_items'
  );
});

test('amounts reach the provider as two-decimal strings', () => {
  assert.equal(toAmount(1710), '17.10');
  assert.equal(toAmount(0), '0.00');
  assert.equal(toAmount(100000), '1000.00');
});
