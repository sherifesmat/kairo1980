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
import { menu, menuData } from '../../worker/site-data.js';

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
    // The KAIRO Bowl is priced by its topping; everything else by its own row.
    const priced = dish.price > 0 ||
      dish.groups.some((g) => g.options.length && g.options.every((o) => o.price > 0));
    assert.ok(priced, `${id} has no price`);
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

/* Every add-on and every Menü names dishes by id. A dish renamed or removed
   from the menu would leave a reference to nothing — offered in the chooser,
   refused at the till. */
test('every reference on the published menu points at a priced dish', async () => {
  const { dishes, addonGroups } = await menuData(realEnv());
  for (const group of addonGroups.values()) {
    assert.ok(group.refs.length, `add-on group ${group.id} is empty`);
    for (const ref of group.refs) {
      assert.ok(dishes.get(ref) && dishes.get(ref).price > 0, `${group.id} names "${ref}", which is not a priced dish`);
    }
  }
  for (const [id, dish] of dishes) {
    for (const g of [...dish.addons, ...dish.includes]) {
      assert.ok(addonGroups.has(g), `${id} uses add-on group "${g}", which is not defined`);
    }
    for (const part of dish.contains) {
      assert.ok(dishes.has(part), `${id} contains "${part}", which is not on the menu`);
    }
  }
});

test('the KAIRO Bowl is one dish: a priced base, and a topping that adds to it', async () => {
  const bowl = (await menu(realEnv())).get('kairo-bowl');
  assert.ok(bowl, 'kairo-bowl is not on the menu');
  assert.equal(bowl.price, null);
  assert.deepEqual(bowl.groups.map((g) => [g.id, g.surcharge]), [['basis', false], ['topping', true]]);
  assert.deepEqual(bowl.groups[0].options.map((o) => o.id), ['reis', 'nudeln']);
  assert.ok(bowl.groups[0].options.every((o) => o.price > 0), 'each base has its own price');
  assert.deepEqual(bowl.groups[1].options.map((o) => o.id), ['aubergine', 'haehnchen', 'soguk', 'kebda']);
  assert.ok(bowl.groups[1].options.every((o) => o.price > 0), 'each topping adds something');
});

