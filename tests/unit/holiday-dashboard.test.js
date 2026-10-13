import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPage } from '../../worker/admin/pages.js';
import { readSettings } from '../../worker/settings.js';
import { dayOf } from '../../worker/berlin.js';
import { readFileSync } from 'node:fs';

const date = (offset) => dayOf(Date.now() + offset * 86400000);
const { hours } = await readSettings({});
const render = (holiday, ordering = { open: true }) => dashboardPage({
  nonce: 'test', ordering, holiday, hours, serviceMode: 'pickup'
});

test('the admin status includes a running holiday even when the manual switch is open', () => {
  const page = render({ from: date(-1), until: date(2) });
  assert.match(page, /Not taking orders/);
  assert.match(page, /Closed for holiday/);
  assert.doesNotMatch(page, /<b>Taking orders<\/b>|Open now ·/);
  assert.doesNotMatch(page, /Start taking orders again/);
});

test('an upcoming holiday leaves the current ordering status open', () => {
  const page = render({ from: date(1), until: date(3) });
  assert.match(page, /<b>Taking orders<\/b>/);
  assert.doesNotMatch(page, /Closed for holiday/);
});

test('a manual pause remains effective after a holiday ends', () => {
  const page = render(null, { open: false, resumesAt: new Date(Date.now() + 3600000).toISOString() });
  assert.match(page, /Not taking orders/);
  assert.match(page, /Start taking orders again/);
});

test('both customer pages put the holiday before their hero or intro', () => {
  for (const name of ['index.html', 'firmencatering.html']) {
    const html = readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
    assert.match(html, /<main>\s*<div class="announce announce-holiday"/);
    assert.equal(html.match(/class="announce announce-holiday"/g).length, 1);
  }
});
