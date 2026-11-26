// The delivery postcode, read one way by the browser, the Worker and KBOSS.
//
// tests/fixtures/postcodes_de.v1.json is a byte-for-byte copy of KBOSS's
// backend/tests/fixtures/postcodes_de.v1.json -- the shared contract (KBOSS DELIVERY_PRICING
// rounds 20-21). Update both together, with the parser VERSION.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import '../../worker/browser-globals.js';
import '../../zones.js';
import '../../postcode.js';

const P = globalThis.KAIRO_POSTCODE;
const ZONES = globalThis.KAIRO_ZONES;
const CORPUS = JSON.parse(readFileSync(new URL('../fixtures/postcodes_de.v1.json', import.meta.url), 'utf8'));

test('the corpus and the parser are the same version', () => {
  assert.equal(CORPUS.version, P.VERSION);
});

test('every corpus case reads the same status and postcode as KBOSS', () => {
  let checked = 0;
  for (const c of CORPUS.cases) {
    // The website has no separate city field; a conflict needs one, so it is KBOSS's case only.
    if (c.status === 'conflict') continue;
    const got = P.parse(c.postcode);
    assert.deepEqual([got.status, got.code], [c.status, c.code], JSON.stringify(c.postcode));
    checked++;
  }
  assert.ok(checked >= CORPUS.cases.length - 1);
});

test('two values that have no postcode are never the same postcode', () => {
  assert.equal(P.legacyCode('Schwetzingen'), null);
  assert.equal(P.legacyCode('68766 Hockenheim'), '68766');
  assert.equal(P.legacyCode('68766'), '68766');
});

test('only a listed postcode-and-town pair is a delivery', () => {
  assert.ok(P.pairFor('68723', 'Oftersheim', ZONES));
  assert.ok(P.pairFor('68723', 'Plankstadt', ZONES));
  assert.ok(P.pairFor('68723', 'Schwetzingen', ZONES));
  for (const [code, town] of [
    ['68723', 'Hockenheim'],           // a real town, not this postcode's
    ['68723', 'Schwetzingen / Plankstadt'], // our label, not a town
    ['68723', 'oftersheim'],           // no case folding: the list is chosen, not typed
    [' 68723', 'Oftersheim'],
    ['68799 Reilingen', 'Reilingen'],
    ['69118', 'Heidelberg'],           // Heidelberg, but a postcode we do not serve
    [68723, 'Oftersheim'],
    ['68723', null],
  ]) {
    assert.equal(P.pairFor(code, town, ZONES), null, JSON.stringify([code, town]));
  }
});

test('a choice id names one town of one postcode, and reads back', () => {
  assert.equal(P.choiceId('68723', 'Oftersheim'), '68723|Oftersheim');
  assert.deepEqual(P.fromChoiceId('68723|Oftersheim'), { postcode: '68723', town: 'Oftersheim' });
  assert.equal(P.fromChoiceId('6872|x'), null);
  assert.equal(P.fromChoiceId(null), null);
});

test('the list offers every town of every served postcode, once, in German order', () => {
  const groups = P.choices(ZONES);
  const pairs = groups.flatMap((g) => g.options.map((o) => o.id));
  const expected = ZONES.flatMap((z) => z[5].map((t) => P.choiceId(z[0], t)));
  assert.deepEqual([...pairs].sort(), [...expected].sort());
  assert.equal(new Set(pairs).size, pairs.length);
  const heidelberg = groups.find((g) => g.town === 'Heidelberg');
  assert.deepEqual(heidelberg.options.map((o) => o.postcode), ['69115', '69117', '69120', '69123', '69124', '69126']);
  const towns = groups.map((g) => g.town);
  assert.ok(towns.indexOf('Altlußheim') < towns.indexOf('Brühl'));
  assert.ok(towns.indexOf('Oftersheim') > towns.indexOf('Neulußheim'));
  for (const g of groups) for (const o of g.options) assert.ok(P.pairFor(o.postcode, o.town, ZONES));
});
