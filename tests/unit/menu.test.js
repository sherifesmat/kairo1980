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


const envFor = (html) => ({
  ASSETS: { fetch: async () => new Response(html, { status: 200 }) }
});

test('configurable choices are bounded to their owning dish and ignore attribute order', async () => {
  const html = `
    <h3 class="cat-name" data-de="Bowls">Bowls</h3>
    <div class="mitem" data-item="bowl">
      <div class="mname" data-de="Bowl">Bowl</div>
      <button data-de="Kebda" data-price="17.50" data-group="topping" data-option="kebda" data-min="1" data-max="1">Kebda</button>
      <button data-max="1" data-option="reis" data-de="Reis" data-min="1" data-group="base">Reis</button>
      <button data-group="extras" data-ref="habanero-sauce" data-max="3" data-min="0" data-de="Habanero">Habanero</button>
    </div>
    <div class="mitem" data-item="next" data-price="9.00">
      <div class="mname" data-de="Next">Next</div>
      <button data-option="foreign" data-price="99.00" data-de="Foreign">Foreign</button>
    </div>`;
  const dishes = await menu(envFor(html));
  const bowl = dishes.get('bowl');
  assert.equal(bowl.price, null);
  assert.equal(bowl.options.get('kebda').price, 1750);
  assert.equal(bowl.options.has('foreign'), false);
  assert.deepEqual(
    bowl.choices.map(({ option, ref, group, min, max }) => ({ option, ref, group, min, max })),
    [
      { option: 'kebda', ref: null, group: 'topping', min: 1, max: 1 },
      { option: 'reis', ref: null, group: 'base', min: 1, max: 1 },
      { option: null, ref: 'habanero-sauce', group: 'extras', min: 0, max: 3 }
    ]
  );
});

test('four long trilingual toppings beyond 2400 characters are all parsed', async () => {
  const pad = 'x'.repeat(900);
  const choices = ['aubergine', 'haehnchen', 'soguk', 'kebda'].map((id, i) =>
    `<button data-option="${id}" data-group="topping" data-min="1" data-max="1" data-price="${14.5 + i}"
      data-de="${id}" data-en="${pad}" data-ar="${pad}">${id}</button>`
  ).join('');
  const html = `<h3 class="cat-name" data-de="Bowls">Bowls</h3>
    <div class="mitem" data-item="kairo-bowl"><div class="mname" data-de="KAIRO Bowl">KAIRO Bowl</div>${choices}</div>`;
  assert.ok(html.length > 2400);
  const bowl = (await menu(envFor(html))).get('kairo-bowl');
  assert.deepEqual([...bowl.options.keys()], ['aubergine', 'haehnchen', 'soguk', 'kebda']);
});

test('ordinary priced dish path remains unchanged', async () => {
  const html = `<h3 class="cat-name" data-de="Extras">Extras</h3>
    <div class="mitem" data-price="6.00" data-item="steakhouse-pommes">
      <div class="mname" data-de="Steakhouse Pommes">Steakhouse Pommes</div>
    </div>`;
  const dish = (await menu(envFor(html))).get('steakhouse-pommes');
  assert.equal(dish.price, 600);
  assert.equal(dish.name, 'Steakhouse Pommes');
  assert.equal(dish.category, 'Extras');
  assert.equal(dish.options.size, 0);
  assert.deepEqual(dish.choices, []);
});
