import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../../worker/index.js';
import { CONFIG } from '../../worker/site-data.js';
import { readSettings, writeHours, writeServiceMode, closeOrdering } from '../../worker/settings.js';
import { quote } from '../../worker/pricing.js';
import { withServiceMode } from '../../worker/service-mode.js';
import { issueSession } from '../../worker/admin/auth.js';
import { workerEnv } from '../helpers/env.js';
import { freshDatabase } from '../helpers/d1.js';

const MENU = { hummus: { name: 'Hummus', price: 950 } };
const hours = { deliveryFrom: '18:00', days: Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d,
    { closed: d === 'mon', lunch: d === 'mon' ? null : ['14:00', '23:00'], evening: null }])) };
const post = (path, body) => new Request('https://kairo1980.de' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'https://kairo1980.de' },
  body: JSON.stringify(body)
});

test('a new installation starts in temporary pickup mode with the requested week', async () => {
  const s = await readSettings({ DB: freshDatabase({ serviceMode: null }) });
  assert.equal(s.serviceMode, 'pickup');
  assert.deepEqual(s.hours.days.tue.lunch, ['11:00', '21:00']);
  assert.equal(s.hours.days.mon.closed, true);
  const preview = await readSettings({});
  assert.equal(preview.hours.pickupOnly, true);
});

test('switching and editing pickup hours leaves the complete delivery setup intact', async () => {
  const env = workerEnv(MENU);
  await writeHours(env, hours);
  const before = env.DB._raw.prepare("select value from settings where key='hours'").get().value;
  const originalZones = JSON.stringify(CONFIG.delivery.zones);
  await writeServiceMode(env, 'pickup');
  assert.deepEqual((await readSettings(env)).hours.days.tue.lunch, ['11:00', '21:00']);
  await writeHours(env, { ...hours, days: { ...hours.days, tue: { closed: false, lunch: ['11:30', '20:30'], evening: null } } });
  await writeServiceMode(env, 'delivery');
  assert.deepEqual((await readSettings(env)).hours.days.tue.lunch, ['14:00', '23:00']);
  assert.equal(env.DB._raw.prepare("select value from settings where key='hours'").get().value, before);
  assert.equal(JSON.stringify(CONFIG.delivery.zones), originalZones);
  assert.equal(CONFIG.business.leadTimeHours, 2); // saved delivery policy, not applied in pickup mode
  await writeServiceMode(env, 'pickup');
  assert.deepEqual((await readSettings(env)).hours.days.tue.lunch, ['11:30', '20:30']);
});

test('a service-mode change never reopens a closed kitchen', async () => {
  const env = workerEnv(MENU);
  await closeOrdering(env, { minutes: 60 });
  await writeServiceMode(env, 'pickup');
  assert.equal((await readSettings(env)).ordering.open, false);
  await writeServiceMode(env, 'delivery');
  assert.equal((await readSettings(env)).ordering.open, false);
  assert.equal(await writeServiceMode(env, 'unexpected'), false);
});

test('the authenticated admin can change modes; an anonymous request cannot', async () => {
  const env = workerEnv(MENU, { ADMIN_USER: 'test-owner', ADMIN_PASSWORD: 'test-only-password' });
  const request = (cookie) => new Request('https://kairo1980.de/admin/service-mode', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://kairo1980.de', ...(cookie ? { Cookie: cookie } : {}) }, body: 'mode=pickup'
  });
  await worker.fetch(request(null), env, { waitUntil() {} });
  assert.equal((await readSettings(env)).serviceMode, 'delivery');
  const cookie = (await issueSession(env, new URL('https://kairo1980.de'))).split(';')[0];
  const r = await worker.fetch(request(cookie), env, { waitUntil() {} });
  assert.equal(r.status, 303);
  assert.equal((await readSettings(env)).serviceMode, 'pickup');
});

test('pickup-only refuses delivery, unknown and missing types before money or order recording', async () => {
  const env = workerEnv(MENU);
  const online = CONFIG.payment.prepayOnline;
  CONFIG.payment.prepayOnline = true;
  try {
  await writeServiceMode(env, 'pickup');
  for (const type of ['delivery', 'something-else', undefined]) {
    for (const path of ['/api/payments/quote', '/api/payments', '/api/orders/announce']) {
      const r = await worker.fetch(post(path, { items: { hummus: 1 }, method: 'paypal', type, business: true }), env, { waitUntil() {} });
      assert.equal(r.status, 400, path + ':' + type);
      assert.equal((await r.json()).error.code, 'pickup_only');
    }
  }
  assert.equal(env.DB._raw.prepare('select count(*) as n from payments').get().n, 0);
  assert.equal(env.DB._raw.prepare('select count(*) as n from orders').get().n, 0);
  const q = await quote(env, { items: { hummus: 1 }, type: 'pickup', business: true });
  assert.equal(q.fee, 0);
  assert.equal(q.belowMinimum, false);
  await writeServiceMode(env, 'delivery');
  assert.ok((await quote(env, { items: { hummus: 1 }, type: 'delivery', postcode: '69168' })).fee > 0);
  } finally { CONFIG.payment.prepayOnline = online; }
});

test('pickup copy is served to crawlers, while original delivery copy remains exactly restorable', () => {
  for (const path of ['index.html', 'firmencatering.html']) {
    const original = readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
    const pickup = withServiceMode(original, 'pickup');
    assert.match(pickup, /<body[^>]*pickup-only/);
    assert.equal(withServiceMode(original, 'delivery'), original);
    const content = pickup.match(/<meta name="description"[\s\S]*?content="([^"]*)"/)[1];
    assert.ok(!/gratis geliefert|free delivery|Lieferung im/.test(content));
    assert.match(pickup, /data-pickup-en=/);
    assert.match(original, /data-de=.*(?:Liefer|liefer)/);
  }
});
