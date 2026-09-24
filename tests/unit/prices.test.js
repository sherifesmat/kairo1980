/* Prices changed at /admin. The menu's figure is the default; an override
   replaces it everywhere at once — the page, the basket and the charge — and
   is inert for anything the current menu does not price. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote, priceOf } from '../../worker/pricing.js';
import { parseMenu } from '../../worker/site-data.js';
import { normalisePrices } from '../../worker/settings.js';
import { withPrices, liveETag } from '../../worker/page-render.js';
import { parseEuro } from '../../worker/admin/prices.js';

const INDEX = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

// Settings the way readSettings() finds them in D1, or a database that throws.
function envWith({ prices = {}, soldOut = {}, broken = false } = {}) {
  const rows = [];
  if (Object.keys(prices).length) rows.push({ key: 'prices', value: JSON.stringify(prices), updated_at: '2' });
  if (Object.keys(soldOut).length) rows.push({ key: 'soldout', value: JSON.stringify(soldOut), updated_at: '1' });
  return {
    ASSETS: { fetch: async () => new Response(INDEX, { status: 200 }) },
    DB: {
      prepare: () => ({
        bind() { return this; },
        all: async () => { if (broken) throw new Error('D1 down'); return { results: rows }; },
        first: async () => null
      })
    }
  };
}

const pickup = (items, opts) => quote(envWith(opts), { items, type: 'pickup' });

test('an override is what the till charges', async () => {
  const q = await pickup({ hummus: 2 }, { prices: { hummus: 1050 } });
  assert.equal(q.subtotal, 2100);
});

test('a topping override moves that topping only', async () => {
  const prices = { 'kairo-bowl:kebda': 1850 };
  assert.equal((await pickup({ 'kairo-bowl|basis=reis|topping=kebda': 1 }, { prices })).subtotal, 1850);
  assert.equal((await pickup({ 'kairo-bowl|basis=reis|topping=soguk': 1 }, { prices })).subtotal, 1750);
});

test('an extra follows its own dish: change Salata Baladi, every "+ Salata" moves', async () => {
  const q = await pickup({ 'hawawshy|beilagen-sandwich=salata-baladi': 1 }, { prices: { 'salata-baladi': 650 } });
  assert.equal(q.subtotal, 1700 + 650);
});

test('a Menü drink stays included whatever the drink now costs', async () => {
  const q = await pickup({ 'hawawshy-menue|menue-getraenk=fritz-kola-0-33-l': 1 },
    { prices: { 'fritz-kola-0-33-l': 450 } });
  assert.equal(q.subtotal, 2300);
});

test('an override for something the menu does not price is inert', () => {
  const { dishes } = parseMenu(INDEX);
  const overrides = { kebda: 999, 'kairo-bowl:reis': 300, 'kairo-bowl': 1200, 'no-such': 100 };
  assert.equal(priceOf(dishes, overrides, 'kebda'), null);             // the dish left the menu
  assert.equal(priceOf(dishes, overrides, 'kairo-bowl:reis'), null);   // a base costs nothing
  assert.equal(priceOf(dishes, overrides, 'kairo-bowl'), null);        // priced by its topping
  assert.equal(priceOf(dishes, overrides, 'hummus'), 950);
});

test('money is not guessed when the settings cannot be read', async () => {
  await assert.rejects(pickup({ hummus: 1 }, { broken: true }), (e) => e.code === 'prices_unavailable');
  // With no database bound at all no override can exist, and the menu is the truth.
  const q = await quote({ ASSETS: envWith().ASSETS }, { items: { hummus: 1 }, type: 'pickup' });
  assert.equal(q.subtotal, 950);
});

test('stored overrides are cleaned on read', () => {
  assert.deepEqual(normalisePrices({
    hummus: 1050, 'kairo-bowl:kebda': 1850,
    free: 0, tiny: 49, huge: 50001, cents: 10.5, text: '9,50', 'Bad Id': 900, 'a:b:c': 900
  }), { hummus: 1050, 'kairo-bowl:kebda': 1850 });
  assert.deepEqual(normalisePrices(['hummus']), {});
  assert.deepEqual(normalisePrices(null), {});
});

test('the page is sent with the price in effect, in the attribute and the figure', () => {
  const html = withPrices(INDEX, { hummus: 1050, 'kairo-bowl:aubergine': 1350, 'salata-baladi': 650 });
  const { dishes } = parseMenu(html);
  assert.equal(dishes.get('hummus').price, 1050);
  assert.equal(dishes.get('salata-baladi').price, 650);
  assert.equal(dishes.get('kairo-bowl').groups[1].options[0].price, 1350);
  // What a reader without JavaScript sees.
  assert.match(html, /data-item="hummus"[\s\S]*?class="mprice">10,50 €</);
  assert.match(html, /data-option="aubergine"[\s\S]*?class="mchoice-price">13,50 €</);
  // The bowl's "ab" figure follows its cheapest topping.
  assert.match(html, /data-item="kairo-bowl"[\s\S]*?class="mprice"><span[^>]*>ab<\/span> 13,50 €/);
  // Nothing else moved.
  assert.equal(parseMenu(html).dishes.get('koshary').price, 1450);
});

test('no overrides, no change to the page', () => {
  assert.equal(withPrices(INDEX, {}), INDEX);
  assert.equal(withPrices(INDEX, { kebda: 999 }), INDEX);
});

test('a price change makes every cached page stale, however quickly it follows the last', () => {
  // Same second, same updated_at — the tag must still differ, because it is
  // taken from the prices themselves.
  const base = { hoursVersion: '1', soldOutVersion: '1', ordering: { open: true }, pricesVersion: '2026-09-24 21:00:00' };
  const tag = (prices) => liveETag('"a"', { ...base, prices });
  assert.notEqual(tag({ hummus: 1050 }), tag({ hummus: 1100 }));
  assert.notEqual(tag({ hummus: 1050 }), tag({}));
  assert.notEqual(tag({ hummus: 1050 }), tag({ koshary: 1050 }));
  assert.equal(tag({ hummus: 1050, koshary: 1500 }), tag({ koshary: 1500, hummus: 1050 }));
  assert.ok(!tag({ hummus: 1050 }).includes(','));
});

test('the price page will not show or save prices it could not read', async () => {
  const { page, save, reset } = await import('../../worker/admin/prices.js');
  const env = envWith({ broken: true });
  const url = new URL('https://kairo1980.de/admin/prices');
  const shown = await page(new Request(url), env, url);
  assert.equal(shown.status, 503);
  assert.match(await shown.text(), /cannot be read/);
  const body = new FormData();
  body.set('price:hummus', '10,50');
  assert.equal((await save(new Request(url, { method: 'POST', body }), env)).status, 503);
  assert.equal((await reset(new Request(url, { method: 'POST' }), env)).status, 503);
});

test('a price is typed the way a German writes one', () => {
  assert.equal(parseEuro('9,50'), 950);
  assert.equal(parseEuro('9.5'), 950);
  assert.equal(parseEuro(' 12 '), 1200);
  assert.equal(parseEuro('17,50 €'), 1750);
  for (const bad of ['', 'abc', '9,505', '-3', '1.000,00', '9,,5', '1e3']) {
    assert.equal(parseEuro(bad), null, bad);
  }
});
