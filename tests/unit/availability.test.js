import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMenu, effectiveSoldOut } from '../../worker/site-data.js';
import { quote } from '../../worker/pricing.js';
import { withLiveData } from '../../worker/page-render.js';
import { readSettings } from '../../worker/settings.js';
import { render } from '../../worker/admin/dishes.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const { dishes } = parseMenu(html);
const since = '2026-10-13T12:00:00.000Z';
const envWith = (marked) => ({
  ASSETS: { fetch: async () => new Response(html) },
  DB: { prepare: () => ({
    all: async () => ({ results: [
      { key: 'soldout', value: JSON.stringify(marked), updated_at: since }
    ] })
  }) }
});
const price = (marked, key) => quote(envWith(marked), { type: 'pickup', items: { [key]: 1 } });

test('either liver switch disables the sandwich, Menü and Bowl topping, leaving chicken available', async () => {
  for (const source of ['kebda-eskandarany', 'kairo-bowl:kebda']) {
    const marked = { [source]: since };
    const off = effectiveSoldOut(dishes, marked);
    for (const id of ['kebda-eskandarany', 'kebda-eskandarany-menue', 'kairo-bowl:kebda']) {
      assert.equal(off[id], since, id);
    }
    assert.equal(off['kairo-bowl'], undefined);
    assert.equal(off['kairo-bowl:haehnchen'], undefined);
    for (const key of [
      'kebda-eskandarany',
      'kebda-eskandarany-menue|menue-getraenk=fritz-kola-0-33-l',
      'kairo-bowl|basis=reis|topping=kebda'
    ]) {
      await assert.rejects(price(marked, key), (err) => err.code === 'sold_out');
    }
    assert.ok((await price(marked, 'kairo-bowl|basis=reis|topping=haehnchen')).total > 0);
    assert.deepEqual(marked, { [source]: since }, 'derivation must not store dependent switches');
  }
});

test('Soguk uses the same shared availability in both directions', () => {
  for (const source of ['soguk-baladi', 'kairo-bowl:soguk']) {
    const off = effectiveSoldOut(dishes, { [source]: since });
    for (const id of ['soguk-baladi', 'soguk-baladi-menue', 'kairo-bowl:soguk']) assert.equal(off[id], since);
    assert.equal(off['kebda-eskandarany'], undefined);
  }
});

test('the appetizer sampler requires every appetizer, without disabling the other appetizers', async () => {
  for (const source of ['hummus', 'baba-ghanough', 'eingelegte-auberginen']) {
    const off = effectiveSoldOut(dishes, { [source]: since });
    assert.equal(off['etwas-von-allem'], since);
    assert.equal(off['salata-baladi'], undefined);
    await assert.rejects(price({ [source]: since }, 'etwas-von-allem'), (err) => err.code === 'sold_out');
  }
});

test('restoring an ingredient restores its dependents but keeps independent switches off', async () => {
  const off = effectiveSoldOut(dishes, { 'kebda-eskandarany-menue': since });
  assert.equal(off['kebda-eskandarany-menue'], since);
  assert.equal(off['kebda-eskandarany'], undefined);
  assert.equal(off['kairo-bowl:kebda'], undefined);
  assert.deepEqual(effectiveSoldOut(dishes, {}), {});
  assert.ok((await price({}, 'etwas-von-allem')).total > 0);
});

test('derived availability is in the HTML and live data, while admin checkboxes keep only manual marks', async () => {
  const marked = { 'kairo-bowl:kebda': since, 'baba-ghanough': since };
  const settings = await readSettings(envWith(marked));
  const page = withLiveData(html, settings);
  for (const id of ['kebda-eskandarany', 'kebda-eskandarany-menue', 'etwas-von-allem']) {
    assert.ok(page.includes('data-item="' + id + '" data-soldout="1"'), id);
  }
  const live = JSON.parse(page.match(/id="kairoLive">([^<]+)/)[1]);
  assert.equal(live.soldOut['etwas-von-allem'], since);
  const admin = render({
    nonce: 'test', soldOut: marked, unavailable: live.soldOut,
    groups: [{ name: 'Test', dishes: [
      { id: 'baba-ghanough', name: 'Baba Ghanough' },
      { id: 'etwas-von-allem', name: 'Etwas von allem' }
    ] }]
  });
  assert.match(admin, /value="baba-ghanough" checked/);
  assert.doesNotMatch(admin, /value="etwas-von-allem" checked/);
  assert.match(admin, /Automatisch ausverkauft/);
});
