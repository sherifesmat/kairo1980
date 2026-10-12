/* What an order costs. These are business rules, not arithmetic: each test
   below is a sentence somebody could say out loud about the restaurant. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, PricingError, toAmount } from '../../worker/pricing.js';
import { workerEnv } from '../helpers/env.js';

const env = workerEnv({
  hummus: { price: 950, name: 'Hummus' },
  koshari: { price: 1450, name: 'Koshari' }
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
  const q = await quote(env, { items: { koshari: 2 }, type: 'delivery', postcode: '69168' });
  assert.equal(q.subtotal, 2900);
  assert.equal(q.fee, 200);
  assert.equal(q.total, 2900 - 290 + 200);
});

test('the discount never applies to the delivery fee', async () => {
  const q = await quote(env, { items: { koshari: 2 }, type: 'delivery', postcode: '69168' });
  // A 10 % discount on 31.00 would be 3.10; on the food alone it is 2.90.
  assert.equal(q.discount, 290);
});

test('the fee is waived once the food reaches the free-delivery threshold', async () => {
  // freeDeliveryFrom is 100 € on the food subtotal, before the discount.
  const q = await quote(env, { items: { koshari: 7 }, type: 'delivery', postcode: '69168' });
  assert.equal(q.subtotal, 10150);
  assert.equal(q.fee, 0);
  assert.equal(q.freeDelivery, true);
});

test('free delivery is the same rule for a company and for a private guest', async () => {
  // One threshold, no carve-out: the same basket to the same postcode costs
  // the same to drive, whoever ordered it.
  const items = { koshari: 7 };
  const asCompany = await quote(env, { items, type: 'delivery', postcode: '69168', business: true });
  const asPrivate = await quote(env, { items, type: 'delivery', postcode: '69168', business: false });
  assert.equal(asCompany.fee, 0);
  assert.equal(asPrivate.fee, 0);
  assert.equal(asCompany.total, asPrivate.total);
});

test('below the threshold both pay the same fee, too', async () => {
  const items = { hummus: 1 };
  const asCompany = await quote(env, { items, type: 'delivery', postcode: '69168', business: true });
  const asPrivate = await quote(env, { items, type: 'delivery', postcode: '69168', business: false });
  assert.equal(asCompany.fee, 200);
  assert.equal(asPrivate.fee, 200);
});

test('a postcode we do not serve is charged no fee, and is not refused', async () => {
  const q = await quote(env, { items: { hummus: 1 }, type: 'delivery', postcode: '10115' });
  assert.equal(q.zone, null);
  assert.equal(q.fee, 0);
  assert.ok(q.total > 0);
});

test('a sub-minimum private delivery is flagged but still priced', async () => {
  // 76661 Philippsburg has a 50 € minimum.
  const q = await quote(env, { items: { hummus: 1 }, type: 'delivery', postcode: '76661' });
  assert.equal(q.belowMinimum, true);
  assert.ok(q.total > 0);
});

test('a company order is never held to the minimum', async () => {
  // The minimum pays for a driver's trip. We make that trip for an office
  // whatever the order is worth, so it is not asked of them at all.
  const q = await quote(env, {
    items: { hummus: 1 }, type: 'delivery', postcode: '76661', business: true
  });
  assert.equal(q.belowMinimum, false);
  assert.ok(q.total > 0);
});

test('pickup is never held to the minimum — there is no trip to pay for', async () => {
  const q = await quote(env, { items: { hummus: 1 }, type: 'pickup', postcode: '76661' });
  assert.equal(q.belowMinimum, false);
});

test('pickup never pays a delivery fee, whatever postcode is typed', async () => {
  const q = await quote(env, { items: { hummus: 1 }, type: 'pickup', postcode: '76661' });
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
