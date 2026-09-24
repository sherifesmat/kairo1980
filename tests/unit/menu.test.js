/* The menu, read out of the real index.html.
   ---------------------------------------------------------------------------
   Everything else stubs the page. This does not: the parse in
   worker/site-data.js is a contract with the actual markup, and the only way a
   change to that markup can be caught is by reading the file that ships. A
   renamed class or a restructured category block would leave every stubbed
   test green and the live site unable to price an order. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { menu } from '../../worker/site-data.js';

const INDEX = fileURLToPath(new URL('../../index.html', import.meta.url));

// An ASSETS binding that serves the real page.
const realEnv = () => ({
  ASSETS: { fetch: async () => new Response(readFileSync(INDEX, 'utf8'), { status: 200 }) }
});

test('every dish on the published menu is priced and named', async () => {
  const dishes = await menu(realEnv());
  assert.ok(dishes.size > 20, `only ${dishes.size} dishes parsed out of index.html`);

  for (const [id, dish] of dishes) {
    assert.match(id, /^[a-z0-9-]+$/, `dish id "${id}" is not a slug`);
    assert.ok(dish.price > 0, `${id} has no price`);
    assert.ok(dish.name && dish.name !== id, `${id} has no readable name`);
    // An unresolved entity in a name reaches the WhatsApp message and the
    // Telegram alert as "Fritz&nbsp;Kola".
    assert.equal(/&[a-z]+;|&#\d+;/.test(dish.name), false,
      `${id} name still holds an HTML entity: ${dish.name}`);
  }
});

test('every dish falls under the category the menu prints it under', async () => {
  const dishes = await menu(realEnv());

  for (const [id, dish] of dishes) {
    assert.ok(dish.category, `${id} has no category — the cat-head parse has drifted`);
  }

  const cats = [...new Set([...dishes.values()].map((d) => d.category))];
  assert.ok(cats.length >= 4, `only ${cats.length} categories found: ${cats.join(', ')}`);

  // Document order, which is what /admin/dishes relies on to read like the menu.
  const order = [...dishes.values()].map((d) => d.category);
  const firstSeen = [];
  for (const c of order) if (!firstSeen.includes(c)) firstSeen.push(c);
  assert.deepEqual(firstSeen, cats, 'categories are not in menu order');
});

test('a known dish lands in the right group', async () => {
  const dishes = await menu(realEnv());
  const hummus = dishes.get('hummus');
  assert.ok(hummus, 'hummus is no longer on the menu — update this test with it');
  assert.match(hummus.category, /Vorspeisen/,
    `hummus is filed under "${hummus.category}"`);
});

