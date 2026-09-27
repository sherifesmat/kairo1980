/* Extras set up at /admin/extras. No saved setup: the menu's. A saved setup:
   the whole of it, checked against the menu on the way out, and the same for
   the page and the till. What a Menü includes is never the admin's to change. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quote } from '../../worker/pricing.js';
import { parseMenu, effectiveMenu } from '../../worker/site-data.js';
import { normaliseAddons } from '../../worker/settings.js';
import { withAddons, liveETag } from '../../worker/page-render.js';

const INDEX = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

function envWith({ addons, broken = false } = {}) {
  const rows = addons ? [{ key: 'addons', value: JSON.stringify(addons), updated_at: '1' }] : [];
  return {
    ASSETS: { fetch: async () => new Response(INDEX, { status: 200 }) },
    DB: {
      prepare: () => ({
        bind() { return this; },
        all: async () => { if (broken) throw new Error('D1 down'); return { results: rows }; },
        first: async () => null,
        run: async () => ({})
      })
    }
  };
}
const pickup = (items, addons) => quote(envWith({ addons }), { items, type: 'pickup' });

// Sauces for the Hawawshy only, one of them at most.
const SAUCES = {
  groups: { saucen: { de: 'Soßen', en: 'Sauces', ar: 'صوصات', max: 1, refs: ['tomatensauce', 'habanero-sauce'] } },
  dishes: { hawawshy: ['saucen'] }
};

test('with no saved setup, the menu offers what it always did', async () => {
  const q = await pickup({ 'hawawshy|beilagen-sandwich=salata-baladi': 1 });
  assert.equal(q.subtotal, 1700 + 600);
});

test('a saved setup is the whole setup: new groups offered, the old ones gone', async () => {
  const q = await pickup({ 'hawawshy|saucen=tomatensauce': 1 }, SAUCES);
  assert.equal(q.subtotal, 1700 + 250);
  assert.equal(q.lines[0].name, 'Hawawshy + Tomatensauce');
  // The menu's own group is not offered any more…
  await assert.rejects(pickup({ 'hawawshy|beilagen-sandwich=salata-baladi': 1 }, SAUCES),
    (e) => e.code === 'invalid_choice');
  // …nor on a dish the setup gives no extras.
  await assert.rejects(pickup({ 'kebda-eskandarany|saucen=tomatensauce': 1 }, SAUCES),
    (e) => e.code === 'invalid_choice');
  await assert.rejects(pickup({ 'hawawshy|saucen=tomatensauce,habanero-sauce': 1 }, SAUCES),
    (e) => e.code === 'invalid_choice');
});

test('what a Menü includes is not the admin setup’s to change', async () => {
  const hijack = {
    groups: { 'menue-getraenk': { de: 'X', en: 'X', ar: 'X', max: 1, refs: ['tomatensauce'] } },
    dishes: { 'hawawshy-menue': ['menue-getraenk'] }
  };
  const q = await pickup({ 'hawawshy-menue|menue-getraenk=fritz-kola-0-33-l': 1 }, hijack);
  assert.equal(q.subtotal, 2300);
  await assert.rejects(pickup({ 'hawawshy-menue|menue-getraenk=tomatensauce': 1 }, hijack),
    (e) => e.code === 'invalid_choice');
});

test('nothing but a plain dish on the current menu can be an extra', () => {
  const data = parseMenu(INDEX);
  const { addonGroups } = effectiveMenu(data, normaliseAddons({
    groups: {
      g: { de: 'G', en: 'G', ar: 'G', max: 1, refs: ['kebda', 'kairo-bowl', 'hawawshy-menue', 'tahini-dip'] },
      // "pick up to 3" with one dish left is not re-read as "pick 1": dropped.
      h: { de: 'H', en: 'H', ar: 'H', max: 3, refs: ['kebda', 'kairo-bowl', 'tahini-dip'] }
    },
    dishes: {}
  }));
  // A removed dish, a dish with choices and a Menü drop out.
  assert.deepEqual(addonGroups.get('g').refs, ['tahini-dip']);
  assert.equal(addonGroups.get('g').max, 1);
  assert.equal(addonGroups.has('h'), false);
});

test('a dish is never an extra of itself', async () => {
  const self = {
    groups: { dips: { de: 'Dips', en: 'Dips', ar: 'Dips', max: 2, refs: ['tahini-dip', 'habanero-sauce'] } },
    dishes: { 'tahini-dip': ['dips'] }
  };
  await assert.rejects(pickup({ 'tahini-dip|dips=tahini-dip': 1 }, self), (e) => e.code === 'invalid_choice');
  assert.equal((await pickup({ 'tahini-dip|dips=habanero-sauce': 1 }, self)).subtotal, 500);
});

test('a stored setup is cleaned on read', () => {
  assert.equal(normaliseAddons(null), null);
  assert.deepEqual(normaliseAddons({
    groups: {
      ok: { de: ' A ', en: 'A', ar: 'أ', max: 2, refs: ['x', 'x', 'y'] },
      nolang: { de: 'A', en: '', ar: 'أ', max: 1, refs: ['x'] },
      norefs: { de: 'A', en: 'A', ar: 'أ', max: 1, refs: [] },
      badmax: { de: 'A', en: 'A', ar: 'أ', max: 0, refs: ['x'] },
      overmax: { de: 'A', en: 'A', ar: 'أ', max: 3, refs: ['x', 'y'] },
      longname: { de: 'A'.repeat(61), en: 'A', ar: 'أ', max: 1, refs: ['x'] },
      'Bad Id': { de: 'A', en: 'A', ar: 'أ', max: 1, refs: ['x'] }
    },
    dishes: { hummus: ['ok', 'nolang', 'ok'], 'Bad Id': ['ok'] }
  }), {
    groups: { ok: { de: 'A', en: 'A', ar: 'أ', max: 2, refs: ['x', 'y'] } },
    dishes: { hummus: ['ok'] }
  });
  // An empty setup is a setup — "no extras anywhere" — not "use the menu".
  assert.deepEqual(normaliseAddons({ groups: {}, dishes: {} }), { groups: {}, dishes: {} });
});

test('the page is sent offering exactly the saved setup', () => {
  const html = withAddons(INDEX, normaliseAddons(SAUCES));
  const { dishes, addonGroups } = parseMenu(html);
  assert.deepEqual([...addonGroups.keys()].sort(), ['menue-getraenk', 'saucen']);
  assert.deepEqual(addonGroups.get('saucen').labels, { de: 'Soßen', en: 'Sauces', ar: 'صوصات' });
  assert.deepEqual(dishes.get('hawawshy').addons, ['saucen']);
  assert.deepEqual(dishes.get('kairo-bowl').addons, []);
  assert.deepEqual(dishes.get('hawawshy-menue').includes, ['menue-getraenk']);
  assert.equal(withAddons(INDEX, null), INDEX);
});

test('labels are written into the page as attributes, never as markup', () => {
  const html = withAddons(INDEX, normaliseAddons({
    groups: { x: { de: '"><script>1</script>', en: 'a&b', ar: 'ع', max: 1, refs: ['tahini-dip'] } },
    dishes: { hawawshy: ['x'] }
  }));
  assert.ok(!html.includes('"><script>1</script>'));
  assert.equal(parseMenu(html).addonGroups.get('x').labels.en, 'a&b');
});

test('a change to the extras makes every cached page stale', () => {
  const base = { hoursVersion: '1', soldOutVersion: '1', ordering: { open: true }, prices: {} };
  assert.notEqual(liveETag('"a"', { ...base, addons: null }), liveETag('"a"', { ...base, addons: SAUCES }));
  assert.notEqual(liveETag('"a"', { ...base, addons: SAUCES }),
    liveETag('"a"', { ...base, addons: { ...SAUCES, dishes: { hawawshy: [] } } }));
  assert.ok(!liveETag('"a"', { ...base, addons: SAUCES }).includes(','));
});

test('the extras page will not show or save what it could not read', async () => {
  const { page, save, reset } = await import('../../worker/admin/extras.js');
  const env = envWith({ broken: true });
  const url = new URL('https://kairo1980.de/admin/extras');
  assert.equal((await page(new Request(url), env, url)).status, 503);
  assert.equal((await save(new Request(url, { method: 'POST', body: new FormData() }), env)).status, 503);
  assert.equal((await reset(new Request(url, { method: 'POST' }), env)).status, 503);
});

test('a group without a name in every language, or with no dish, saves nothing', async () => {
  const { save } = await import('../../worker/admin/extras.js');
  const url = new URL('https://kairo1980.de/admin/extras');
  const body = new FormData();
  body.set('new:de', 'Soßen');
  body.set('new:max', '1');
  body.append('new:ref', 'tomatensauce');
  const res = await save(new Request(url, { method: 'POST', body }), envWith());
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Nothing was saved[\s\S]*all three languages/);
});
