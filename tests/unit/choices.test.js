/* Dishes with choices: the KAIRO Bowl, the Menüs, and the add-ons offered
   with them. Each test is a sentence about what the kitchen will and will not
   be asked to cook, and what it costs. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote, parseLineKey } from '../../worker/pricing.js';
import { parseMenu } from '../../worker/site-data.js';

const PAD = 'x'.repeat(900);   // trilingual copy is long; the parse must not care

const HTML = `<section id="speisekarte">
  <div class="addon-groups" hidden>
    <div data-max="1" data-addon-group="getraenk" data-de="Dazu genießen">
      <span data-ref="fritz-kola"></span><span data-ref="karkadeh"></span></div>
    <div data-addon-group="menue-getraenk" data-de="Getränk">
      <span data-ref="fritz-kola"></span><span data-ref="wasser"></span></div>
    <div data-addon-group="beilagen" data-max="2" data-de="Passt gut dazu">
      <span data-ref="salata"></span><span data-ref="tahini"></span><span data-ref="habanero"></span></div>
  </div>
  <div class="cat-head"><h3 class="cat-name t" data-de="KAIRO Bowls">KAIRO Bowls</h3></div>
  <div data-addons="getraenk beilagen" class="mitem" data-item="kairo-bowl" data-allergens="pending">
    <div class="mname t" data-de="KAIRO Bowl" data-en="${PAD}">KAIRO Bowl</div>
    <ul class="mchoices" data-group="basis" data-de="Basis">
      <li class="mchoice" data-option="reis"><span class="mchoice-name t" data-de="Ägyptischer Reis" data-ar="${PAD}">R</span></li>
      <li data-option="nudeln" class="mchoice"><span class="mchoice-name t" data-de="Nudeln">N</span></li>
    </ul>
    <ul data-de="Topping" class="mchoices" data-group="topping">
      <li class="mchoice" data-price="14.50" data-option="aubergine"><span class="mchoice-name t" data-de="Aubergine" data-en="${PAD}">A</span></li>
      <li data-option="haehnchen" class="mchoice" data-price="16.50"><span class="mchoice-name t" data-de="Hähnchen">H</span></li>
      <li class="mchoice" data-option="kebda" data-price="17.50"><span class="mchoice-name t" data-de="Kebda" data-ar="${PAD}">K</span></li>
    </ul>
  </div>
  <div class="cat-head"><h3 class="cat-name t" data-de="Straßenküche">S</h3></div>
  <div class="mitem" data-item="hawawshy" data-price="17.00" data-addons="getraenk beilagen"><div class="mname t" data-de="Hawawshy">H</div></div>
  <div class="mitem" data-item="hawawshy-menue" data-price="23.00" data-contains="hawawshy pommes" data-includes="menue-getraenk"><div class="mname t" data-de="Hawawshy Menü">HM</div></div>
  <div class="mitem" data-item="next" data-price="9.00"><div class="mname t" data-de="Next">N</div>
    <ul class="mchoices" data-group="foreign"><li class="mchoice" data-option="x" data-price="99"></li></ul></div>
  <div class="cat-head"><h3 class="cat-name t" data-de="Extras">E</h3></div>
  <div class="mitem" data-item="pommes" data-price="6.00"><div class="mname t" data-de="Steakhouse Pommes">P</div></div>
  <div class="mitem" data-item="salata" data-price="6.00"><div class="mname t" data-de="Salata Baladi">S</div></div>
  <div class="mitem" data-item="tahini" data-price="2.50"><div class="mname t" data-de="Tahini Dip">T</div></div>
  <div class="mitem" data-item="habanero" data-price="2.50"><div class="mname t" data-de="Habanero Sauce">H</div></div>
  <div class="mitem" data-item="fritz-kola" data-price="3.90"><div class="mname t" data-de="Fritz Kola">F</div></div>
  <div class="mitem" data-item="karkadeh" data-price="4.50"><div class="mname t" data-de="Karkadeh">K</div></div>
  <div class="mitem" data-item="wasser" data-price="2.50"><div class="mname t" data-de="Wasser">W</div></div>
</section>`;

// A settings row the way readSettings() finds it in D1.
function envWith(soldOut = {}) {
  const row = { key: 'soldout', value: JSON.stringify(soldOut), updated_at: '1' };
  return {
    ASSETS: { fetch: async () => new Response(HTML, { status: 200 }) },
    DB: {
      prepare: () => ({
        bind() { return this; },
        all: async () => ({ results: Object.keys(soldOut).length ? [row] : [] }),
        first: async () => null
      })
    }
  };
}

const price = async (items, soldOut) =>
  quote(envWith(soldOut), { items, type: 'pickup' });

const refused = async (items, code, soldOut) =>
  assert.rejects(price(items, soldOut), (err) => err.code === code);

test('a dish owns only the choices written inside its own row', () => {
  const { dishes } = parseMenu(HTML);
  const bowl = dishes.get('kairo-bowl');
  assert.equal(bowl.price, null);
  assert.deepEqual(bowl.groups.map((g) => g.id), ['basis', 'topping']);
  assert.deepEqual(bowl.groups[1].options.map((o) => [o.id, o.name, o.price]),
    [['aubergine', 'Aubergine', 1450], ['haehnchen', 'Hähnchen', 1650], ['kebda', 'Kebda', 1750]]);
  assert.deepEqual(bowl.addons, ['getraenk', 'beilagen']);
  assert.equal(bowl.category, 'KAIRO Bowls');
  // The dish that follows keeps its own choice and lends none to the bowl.
  assert.deepEqual(dishes.get('next').groups.map((g) => g.id), ['foreign']);
  assert.deepEqual(dishes.get('hawawshy-menue').contains, ['hawawshy', 'pommes']);
});

test('add-on groups are references to dishes, with a limit and no prices', () => {
  const { addonGroups } = parseMenu(HTML);
  assert.deepEqual(addonGroups.get('beilagen'), {
    id: 'beilagen', name: 'Passt gut dazu', max: 2, refs: ['salata', 'tahini', 'habanero'],
    // With no data-en / data-ar written, the German stands in rather than a blank.
    labels: { de: 'Passt gut dazu', en: 'Passt gut dazu', ar: 'Passt gut dazu' }
  });
});

test('the topping sets the bowl price; rice or noodles cost the same', async () => {
  const reis = await price({ 'kairo-bowl|basis=reis|topping=kebda': 1 });
  const nudeln = await price({ 'kairo-bowl|basis=nudeln|topping=kebda': 1 });
  assert.equal(reis.subtotal, 1750);
  assert.equal(nudeln.subtotal, 1750);
  assert.equal(nudeln.lines[0].name, 'KAIRO Bowl (Nudeln, Kebda)');
});

test('an add-on costs what its own row on the menu says', async () => {
  const q = await price({ 'kairo-bowl|basis=reis|topping=aubergine|getraenk=karkadeh|beilagen=salata,tahini': 2 });
  assert.equal(q.lines[0].unit, 1450 + 450 + 600 + 250);
  assert.equal(q.subtotal, 2 * (1450 + 450 + 600 + 250));
  assert.equal(q.lines[0].name, 'KAIRO Bowl (Ägyptischer Reis, Aubergine) + Karkadeh + Salata Baladi + Tahini Dip');
  assert.deepEqual(q.lines[0].choices.map((c) => [c.group, c.id, c.price]), [
    ['basis', 'reis', 0], ['topping', 'aubergine', 1450],
    ['getraenk', 'karkadeh', 450], ['beilagen', 'salata', 600], ['beilagen', 'tahini', 250]
  ]);
});

test('the drink in a Menü is part of its price, whichever drink it is', async () => {
  const kola = await price({ 'hawawshy-menue|menue-getraenk=fritz-kola': 1 });
  const wasser = await price({ 'hawawshy-menue|menue-getraenk=wasser': 1 });
  assert.equal(kola.subtotal, 2300);
  assert.equal(wasser.subtotal, 2300);
  assert.equal(kola.lines[0].name, 'Hawawshy Menü (Fritz Kola)');
});

test('a sandwich may be ordered plain, or with extras', async () => {
  assert.equal((await price({ hawawshy: 1 })).subtotal, 1700);
  assert.equal((await price({ 'hawawshy|beilagen=habanero': 1 })).subtotal, 1950);
});

test('a bowl cannot be ordered without its base and its topping', async () => {
  await refused({ 'kairo-bowl': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|topping=kebda': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|basis=reis,nudeln|topping=kebda': 1 }, 'invalid_choice');
});

test('a Menü cannot be ordered without its drink, or with two', async () => {
  await refused({ 'hawawshy-menue': 1 }, 'invalid_choice');
  await refused({ 'hawawshy-menue|menue-getraenk=fritz-kola,wasser': 1 }, 'invalid_choice');
});

test('nothing can be chosen that the menu does not offer', async () => {
  await refused({ 'kairo-bowl|basis=reis|topping=hummer': 1 }, 'invalid_choice');
  // water is a Menü drink, not an add-on of the bowl
  await refused({ 'kairo-bowl|basis=reis|topping=kebda|getraenk=wasser': 1 }, 'invalid_choice');
  // a group the dish does not offer
  await refused({ 'hawawshy|menue-getraenk=wasser': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|basis=reis|topping=kebda|foreign=x': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|basis=reis|topping=kebda|beilagen=salata,tahini,habanero': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|basis=reis|topping=kebda|beilagen=salata,salata': 1 }, 'invalid_choice');
  await refused({ 'kairo-bowl|basis=reis|topping=kebda|getraenk=': 1 }, 'unknown_item');
  await refused({ 'no-such-dish': 1 }, 'unknown_item');
});

test('a sold-out topping is refused, and the other toppings are not', async () => {
  const off = { 'kairo-bowl:kebda': '2026-09-24T18:00:00Z' };
  await refused({ 'kairo-bowl|basis=reis|topping=kebda': 1 }, 'sold_out', off);
  assert.equal((await price({ 'kairo-bowl|basis=reis|topping=haehnchen': 1 }, off)).subtotal, 1650);
});

test('a Menü is sold out when anything it is made of is', async () => {
  await refused({ 'hawawshy-menue|menue-getraenk=wasser': 1 }, 'sold_out', { hawawshy: 'x' });
  await refused({ 'hawawshy-menue|menue-getraenk=wasser': 1 }, 'sold_out', { pommes: 'x' });
  await refused({ 'hawawshy-menue|menue-getraenk=fritz-kola': 1 }, 'sold_out', { 'fritz-kola': 'x' });
  assert.equal((await price({ 'hawawshy-menue|menue-getraenk=wasser': 1 }, { 'fritz-kola': 'x' })).subtotal, 2300);
});

test('a sold-out add-on is refused with the dish it was added to', async () => {
  await refused({ 'hawawshy|beilagen=salata': 1 }, 'sold_out', { salata: 'x' });
});

test('line keys are read strictly', () => {
  assert.deepEqual(parseLineKey('hawawshy'), { dish: 'hawawshy', picks: new Map() });
  assert.equal(parseLineKey('a|b=c|b=d'), null);
  assert.equal(parseLineKey('A'), null);
  assert.equal(parseLineKey('a|b'), null);
  assert.equal(parseLineKey('x'.repeat(401)), null);
});

test('an add-on group keeps every ref, whatever wraps them', () => {
  const html = `<div class="addon-groups" hidden>
    <div data-addon-group="beilagen" data-max="3">
      <div class="wrap"><span data-ref="salata"></span></div>
      <span data-ref="tahini"></span>
    </div>
    <div data-addon-group="getraenk"><span data-ref="kola"></span></div>
  </div>
  <div class="mitem" data-item="salata" data-price="6.00"><div class="mname" data-de="S">S</div></div>`;
  const { addonGroups } = parseMenu(html);
  assert.deepEqual(addonGroups.get('beilagen').refs, ['salata', 'tahini']);
  assert.deepEqual(addonGroups.get('getraenk').refs, ['kola']);
});

test('a menu that names the same thing twice is not priced at all', () => {
  const dish = (inner) => `<div class="mitem" data-item="b"><div class="mname" data-de="B">B</div>${inner}</div>`;
  const opt = (id) => `<li data-option="${id}" data-price="9.00"></li>`;
  assert.throws(() => parseMenu(dish(`<ul data-group="t">${opt('a')}</ul><ul data-group="t">${opt('b')}</ul>`)),
    /choice "t" appears twice/);
  assert.throws(() => parseMenu(dish(`<ul data-group="t">${opt('a')}${opt('a')}</ul>`)),
    /option "a" appears twice/);
  assert.throws(() => parseMenu('<div data-addon-group="g"><span data-ref="x"></span><span data-ref="x"></span></div>'),
    /names a dish twice/);
  assert.throws(() => parseMenu('<div data-addon-group="g"></div><div data-addon-group="g"></div>'),
    /defined twice/);
});
