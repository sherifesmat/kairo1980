/* One version for the scripts that price and pay (DELIVERY_PRICING DP-22-03).
   order.js is cached for five minutes; the pages revalidate every load. Without
   a version in the URL a fresh page could run with an old order.js, or a fresh
   order.js with an old pay.js: two halves of one checkout speaking two
   protocols. So every entry page loads the checkout scripts at one version,
   order.js loads pay.js at the same one, and this test keeps them together. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFileSync(ROOT + name, 'utf8');
const CHECKOUT = ['zones.js', 'postcode.js', 'config.js', 'order.js'];

function versionsIn(html, name) {
  const found = [...html.matchAll(/<script src="([a-z-]+\.js)(?:\?v=([A-Za-z0-9.-]+))?"/g)];
  return found.filter((m) => CHECKOUT.includes(m[1])).map((m) => [m[1], m[2] || null, name]);
}

test('every checkout script is loaded at one version, on every page that sells', () => {
  const tags = ['index.html', 'firmencatering.html'].flatMap((page) => versionsIn(read(page), page));
  for (const page of ['index.html', 'firmencatering.html']) {
    assert.deepEqual(tags.filter((t) => t[2] === page).map((t) => t[0]).sort(), [...CHECKOUT].sort(), page);
  }
  const versions = new Set(tags.map((t) => t[1]));
  assert.equal(versions.has(null), false, 'no checkout script without a version: ' + JSON.stringify(tags));
  assert.equal(versions.size, 1, 'one version: ' + [...versions].join(', '));

  const payLoad = /script\.src = 'pay\.js\?v=([A-Za-z0-9.-]+)'/.exec(read('order.js'));
  assert.ok(payLoad, 'order.js loads pay.js with a version');
  assert.equal(payLoad[1], [...versions][0], 'pay.js is loaded at the pages\' version');
});
