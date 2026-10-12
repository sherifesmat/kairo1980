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

test('pickup regular-hours summary follows the entire saved week, including exceptions and closure', async () => {
  const { pickupWeekSummary } = await import('../../worker/service-mode.js');
  const saved = (await readSettings({ DB: freshDatabase({ serviceMode: 'pickup' }) })).hours;
  assert.equal(pickupWeekSummary(saved, 'de'), 'Dienstag–Sonntag · 11:00–21:00');
  const changed = structuredClone(saved);
  changed.days.wed = { closed: false, lunch: ['12:00', '14:00'], evening: ['18:00', '20:00'] };
  assert.equal(pickupWeekSummary(changed, 'en'), 'Tuesday · 11:00–21:00 | Wednesday · 12:00–14:00 / 18:00–20:00 | Thursday–Sunday · 11:00–21:00');
  for (const day of Object.values(changed.days)) day.closed = true;
  assert.equal(pickupWeekSummary(changed, 'en'), 'Closed');
});

test('pickup story and team-lunch heading have no delivery promise, while delivery wording is retained', async () => {
  const s = await readSettings({ DB: freshDatabase({ serviceMode: 'pickup' }) });
  const original = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const pickup = withServiceMode(original, 'pickup', s.hours);
  assert.match(pickup, /bereit zum Mitnehmen\.<\/strong>/);
  assert.match(pickup, /id="pickupWeek"[^>]*data-en="Tuesday–Sunday · 11:00–21:00"/);
  assert.equal(withServiceMode(original, 'delivery', s.hours), original);
  const company = withServiceMode(readFileSync(new URL('../../firmencatering.html', import.meta.url), 'utf8'), 'pickup', s.hours);
  assert.match(company, /Mittagessen fürs Team — zum Abholen in Hockenheim<\/h1>/);
  assert.match(company, /id="businessHours"[^>]*data-en="Tuesday–Sunday · 11:00–21:00"/);
});

test('a stale pickup reset cannot erase saved delivery hours, and reset forms identify their mode', async () => {
  const env = workerEnv(MENU, { ADMIN_USER: 'test-owner', ADMIN_PASSWORD: 'test-only-password' });
  await writeHours(env, hours, 'delivery');
  await writeHours(env, { ...hours, deliveryFrom: '', days: { ...hours.days, tue: { closed: false, lunch: ['11:00', '20:00'], evening: null } } }, 'pickup');
  await writeServiceMode(env, 'pickup');
  const cookie = (await issueSession(env, new URL('https://kairo1980.de'))).split(';')[0];
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://kairo1980.de', Cookie: cookie };
  const page = await worker.fetch(new Request('https://kairo1980.de/admin/hours', { headers }), env, { waitUntil() {} });
  const html = await page.text();
  assert.match(html, /name="service_mode" value="pickup"[\s\S]*?name="reset"/);
  assert.match(html, /<fieldset hidden disabled><legend>Deliveries/);
  const saved = env.DB._raw.prepare("select value from settings where key='hours'").get().value;
  await writeServiceMode(env, 'delivery');
  for (const body of ['service_mode=pickup&reset=1', 'reset=1']) {
    const response = await worker.fetch(new Request('https://kairo1980.de/admin/hours', { method: 'POST', headers, body }), env, { waitUntil() {} });
    assert.match(response.headers.get('Location'), /failed=1/);
    assert.equal(env.DB._raw.prepare("select value from settings where key='hours'").get().value, saved);
  }
});

test('pickup rendering closes nested spans safely and keeps dollar text and discount placeholders literal', () => {
  const source = '<span data-pickup-de="Abholen"><span>icon</span>Old label</span><p>After</p>';
  assert.equal(withServiceMode(source, 'pickup'), '<span data-pickup-de="Abholen">Abholen</span><p>After</p>');
  const meta = '<meta content="Old" data-pickup-de="$&amp; {discount} Prozent">';
  assert.match(withServiceMode(meta, 'pickup'), /content="\$&amp; 10 Prozent"/);
});

test('the company pickup timing card removes the fixed advance rule in every language, retaining delivery originals', async () => {
  const original = readFileSync(new URL('../../firmencatering.html', import.meta.url), 'utf8');
  const pickup = withServiceMode(original, 'pickup');
  const tag = pickup.match(/<p class="bcard-text t"[^>]*id="businessTiming"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(tag);
  assert.ok(!/2|leadTimeHours/.test(tag[1]));
  for (const lang of ['de', 'en', 'ar']) {
    const translated = tag[0].match(new RegExp('data-pickup-' + lang + '="([^"]*)"'));
    assert.ok(translated);
    assert.ok(!/2|leadTimeHours/.test(translated[1]));
  }
  assert.equal(withServiceMode(original, 'delivery'), original);
  assert.match(original, /Ab \{leadTimeHours\} Stunden Vorlauf/);
});

test('generated weekly translations also work on a source element without a class', () => {
  const h = { days: { tue: { closed: false, lunch: ['11:00', '21:00'] } } };
  const html = withServiceMode('<p id="pickupWeek"></p>', 'pickup', h);
  assert.match(html, /class="t"/);
  assert.match(html, /data-en="Tuesday · 11:00–21:00"/);
});
