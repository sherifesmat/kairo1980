/* The ordering switch, examined one edge at a time.
   ---------------------------------------------------------------------------
   This switch decides whether a restaurant can take money, and it is made
   almost entirely of clocks: a closure that ends by itself, a moment chosen by
   a guest, and a comparison between the two — across midnight, across a date
   boundary, and across the two nights a year when Germany's clocks move.

   Every case below is one somebody actually meets. The ones that would cost
   money are marked as such. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dayOf, timeOf, nextMidnight, nextTimeOfDay, instantOf } from '../../worker/berlin.js';
import { freshDatabase } from '../helpers/d1.js';
import { normaliseHours } from '../../worker/settings.js';
import { wantedAfterClosure } from '../../worker/index.js';

const BERLIN = 'Europe/Berlin';
const berlin = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: BERLIN });

/* --- the clock the restaurant actually stands next to --------------------- */

test('a Berlin day is Berlin\'s, not the server\'s', () => {
  // 22:30 UTC on 5 August is already the 6th in Hockenheim. A server reasoning
  // in UTC files that evening's orders under the wrong day.
  const late = Date.parse('2026-08-05T22:30:00Z');
  assert.equal(dayOf(late), '2026-08-06');
  assert.equal(timeOf(late), '00:30');
});

test('midnight tonight is tonight, in summer and in winter', () => {
  // CEST: Berlin is UTC+2, so midnight is 22:00 UTC the evening before.
  const summer = nextMidnight(Date.parse('2026-08-05T12:00:00Z'));
  assert.equal(berlin(summer), '2026-08-06 00:00:00');

  // CET: UTC+1.
  const winter = nextMidnight(Date.parse('2026-01-15T12:00:00Z'));
  assert.equal(berlin(winter), '2026-01-16 00:00:00');
});

test('midnight is still midnight on the two nights the clocks move', () => {
  /* The failure this catches is not theoretical: resolving a wall clock with
     the offset that applies BEFORE the change puts the answer an hour out, and
     an hour out at midnight is a shop that reopens on the wrong day. */

  // Clocks go forward 02:00 -> 03:00 on the last Sunday in March 2026 (29th).
  const spring = nextMidnight(Date.parse('2026-03-28T20:00:00Z'));
  assert.equal(berlin(spring), '2026-03-29 00:00:00');

  // Clocks go back 03:00 -> 02:00 on the last Sunday in October 2026 (25th).
  const autumn = nextMidnight(Date.parse('2026-10-24T20:00:00Z'));
  assert.equal(berlin(autumn), '2026-10-25 00:00:00');
});

test('"back at 20:30" means today if it is still ahead, tomorrow if it is not', () => {
  const noon = Date.parse('2026-08-05T10:00:00Z');          // 12:00 Berlin
  assert.equal(berlin(nextTimeOfDay('20:30', noon)), '2026-08-05 20:30:00');

  const lateEvening = Date.parse('2026-08-05T20:00:00Z');   // 22:00 Berlin
  assert.equal(berlin(nextTimeOfDay('20:30', lateEvening)), '2026-08-06 20:30:00',
    'a time already past today can only mean tomorrow');
});

test('a chosen date resolves to the start of that day in Hockenheim', () => {
  assert.equal(berlin(instantOf('2026-08-15')), '2026-08-15 00:00:00');
  assert.equal(berlin(instantOf('2026-08-15', '18:30')), '2026-08-15 18:30:00');
  // And in winter, where the offset differs.
  assert.equal(berlin(instantOf('2026-12-24', '15:00')), '2026-12-24 15:00:00');
});

/* --- whether a guest's chosen moment falls inside a closure ---------------
   The rule the basket and the server both apply, tested here on the server's
   copy. A closure withholds a MOMENT; an order for after we reopen is an
   ordinary order and must go through. */

const RESUMES = '2026-08-06T18:00:00.000Z';        // 20:00 Berlin on the 6th
const at = (date, time) => wantedAfterClosure(RESUMES, { date, time });

test('a moment before we reopen is inside the closure', () => {
  assert.equal(at('2026-08-06', '19:59'), false, 'a minute early is early');
  assert.equal(at('2026-08-06', '00:00'), false, 'earlier the same day');
  assert.equal(at('2026-08-05', '23:59'), false, 'the day before');
});

test('a moment at or after we reopen is an ordinary order', () => {
  assert.equal(at('2026-08-06', '20:00'), true, 'the minute itself counts');
  assert.equal(at('2026-08-06', '20:01'), true);
  assert.equal(at('2026-08-07', '00:00'), true, 'past midnight, next day');
  assert.equal(at('2026-09-01', '12:00'), true, 'weeks later');
});

test('the comparison holds across a date boundary, not just a clock one', () => {
  /* 23:59 on the 5th is BEFORE 00:00 on the 6th. Compared as clock times
     alone, 23:59 > 00:00 and a guest ordering the night before we close would
     sail through. The date has to be part of the comparison, and this is the
     test that says so. */
  const midnight = wantedAfterClosure('2026-08-06T22:00:00.000Z', // 00:00 on the 7th
    { date: '2026-08-06', time: '23:59' });
  assert.equal(midnight, false);
});

test('no moment named means "as soon as possible", which is exactly what is closed', () => {
  assert.equal(wantedAfterClosure(RESUMES, null), false);
  assert.equal(wantedAfterClosure(RESUMES, undefined), false);
  assert.equal(wantedAfterClosure(RESUMES, {}), false);
  assert.equal(wantedAfterClosure(RESUMES, 'tomorrow'), false);
});

test('a malformed moment is refused, never parsed into something plausible', () => {
  /* A hand-made request naming "9999-99-99" must not walk past a closure on
     the strength of sorting late. Every field is validated before it is
     compared. */
  for (const when of [
    { date: '9999-99-99', time: '99:99' },
    { date: '2026-8-6', time: '20:00' },
    { date: '2026-08-06', time: '8:00' },
    { date: '2026-08-06', time: '24:00' },
    { date: '2026-08-06' },
    { time: '20:00' },
    { date: 2026, time: 20 }
  ]) {
    assert.equal(wantedAfterClosure(RESUMES, when), false, JSON.stringify(when));
  }
});

test('with no closure to compare against, nothing is withheld', () => {
  assert.equal(wantedAfterClosure(null, null), true);
  assert.equal(wantedAfterClosure('', null), true);
  assert.equal(wantedAfterClosure('not a date', null), true);
});

/* --- hours: what is refused, and what is quietly accepted ----------------- */

const WEEK = (over = {}) => ({
  lunch: { enabled: true, delivery: false },
  days: {
    mon: { closed: true },
    tue: { closed: true },
    wed: { closed: false, evening: ['18:00', '23:00'] },
    thu: { closed: false, evening: ['18:00', '23:00'] },
    fri: { closed: false, evening: ['18:00', '23:00'] },
    sat: { closed: false, evening: ['18:00', '23:00'] },
    sun: { closed: false, evening: ['18:00', '23:00'] },
    ...over
  }
});

test('a complete, ordinary week is accepted as given', () => {
  const hours = normaliseHours(WEEK());
  assert.equal(hours.days.mon.closed, true);
  // One window is stored as the day's first, whichever box it was typed into.
  assert.deepEqual(hours.days.wed.lunch, ['18:00', '23:00']);
  assert.equal(hours.days.wed.evening, null);
});

test('a time that is not a time refuses the whole save', () => {
  /* THE ONE THAT COSTS MONEY. Read as "no evening window", a fat-fingered
     closing time makes that day CLOSED — in the table, in the basket, and in
     the opening hours Google publishes. A typo would shut the restaurant and
     nothing would say so. */
  for (const bad of [['18:00', '0900'], ['1800', '23:00'], ['18:00', 'abc'],
                     ['25:00', '26:00'], ['18:00', '18:00'], ['23:00', '18:00']]) {
    assert.equal(normaliseHours(WEEK({ wed: { closed: false, evening: bad } })), null,
      `refused: ${bad.join('-')}`);
  }
});

test('an empty pair is "no window", which is not the same as a bad one', () => {
  const hours = normaliseHours(WEEK({ wed: { closed: false, evening: ['', ''] } }));
  assert.notEqual(hours, null, 'leaving the boxes empty is allowed');
  assert.equal(hours.days.wed.closed, true, 'and a day with no windows is closed');
});

test('"closed all day" wins over any times left in the boxes', () => {
  const hours = normaliseHours(WEEK({
    wed: { closed: true, lunch: ['11:00', '14:30'], evening: ['18:00', '23:00'] }
  }));
  assert.equal(hours.days.wed.closed, true);
  assert.equal(hours.days.wed.evening, null, 'no window survives a closed day');
});

test('a week missing a day is not a week', () => {
  const partial = WEEK();
  delete partial.days.sun;
  assert.equal(normaliseHours(partial), null);
  assert.equal(normaliseHours({ days: {} }), null);
  assert.equal(normaliseHours(null), null);
  assert.equal(normaliseHours({}), null);
  assert.equal(normaliseHours('every day'), null);
});

test('a window that runs past midnight is refused rather than reversed', () => {
  // "18:00 – 03:00" is a real thing to want and this schema cannot express it.
  // Refusing says so; accepting it as 03:00–18:00 would publish the opposite
  // of what was meant.
  assert.equal(normaliseHours(WEEK({ wed: { closed: false, evening: ['18:00', '03:00'] } })), null);
});

test('the delivery shift can be set and cleared without touching a day', () => {
  const later = normaliseHours({ ...WEEK(), deliveryFrom: '18:00' });
  assert.equal(later.deliveryFrom, '18:00');
  // WEEK() gives each day a lone window, which normalises into the first slot.
  assert.equal(later.days.wed.lunch[0], '18:00', 'the opening is untouched');

  // Empty is a real answer — "a driver is out whenever we are open" — and is
  // the one word to change the day a midday driver exists.
  const allDay = normaliseHours({ ...WEEK(), deliveryFrom: '' });
  assert.equal(allDay.deliveryFrom, '');
});

test('a delivery time that is not a time refuses the whole save', () => {
  /* Reading a mistyped "1800" as "delivers all day" would promise a midday
     driver that does not exist — the same silent publication the window checks
     exist to prevent, so it is refused the same way. */
  assert.equal(normaliseHours({ ...WEEK(), deliveryFrom: '1800' }), null);
  assert.equal(normaliseHours({ ...WEEK(), deliveryFrom: '25:00' }), null);
});

test('two opening windows that overlap are refused', () => {
  /* Saved cleanly before this check existed, and published two overlapping
     OpeningHoursSpecification entries to the crawlers that feed the place
     cards, while the table printed two rows contradicting each other. Each
     window is valid alone, which is exactly why they have to be compared. */
  assert.equal(normaliseHours(WEEK({
    wed: { closed: false, lunch: ['11:00', '23:00'], evening: ['18:00', '23:00'] }
  })), null);

  // Touching is not overlapping: 11:00-18:00 then 18:00-23:00 is one opening
  // typed into two boxes, and stays perfectly legal.
  const touching = normaliseHours(WEEK({
    wed: { closed: false, lunch: ['11:00', '18:00'], evening: ['18:00', '23:00'] }
  }));
  assert.ok(touching, 'adjacent windows are a normal week');
});

test('a day with only a second window is stored as having one', () => {
  /* The form has two boxes because an afternoon break needs two, and filling
     only the lower pair reads naturally as "we open in the evening". It saved
     and worked, but left the same shape stored two different ways — which is
     how the Saturday and Sunday rows came to look broken next to Wednesday's. */
  const hours = normaliseHours(WEEK({
    sat: { closed: false, lunch: null, evening: ['18:00', '23:00'] }
  }));
  assert.deepEqual(hours.days.sat.lunch, ['18:00', '23:00'], 'promoted to the first window');
  assert.equal(hours.days.sat.evening, null, 'and nothing left dangling');
  assert.equal(hours.days.sat.closed, false, 'the day is still open');
});

test('a genuine afternoon break still keeps both windows', () => {
  const hours = normaliseHours(WEEK({
    wed: { closed: false, lunch: ['11:00', '14:30'], evening: ['18:00', '23:00'] }
  }));
  assert.deepEqual(hours.days.wed.lunch, ['11:00', '14:30']);
  assert.deepEqual(hours.days.wed.evening, ['18:00', '23:00']);
});

/* --- staying open later than the hours say --------------------------------
   The opposite of the closure and deliberately the same shape. The thing worth
   holding down is that it can never become a published opening hour: the table
   and the JSON-LD say what happens every week, Google caches that for the place
   card, and a Saturday that ran late is not a new Saturday. */

test('an extension that has already passed is the same as none', async () => {
  const { extendHours, readSettings } = await import('../../worker/settings.js');
  const db = freshDatabase();
  const env = { DB: db };

  // Nothing set at all.
  assert.equal((await readSettings(env)).extension, null);

  // A time already gone is refused rather than stored as expired.
  assert.equal(await extendHours(env, Date.now() - 60000), null);
});

test('an extension is capped, so a slip cannot leave the shop open for a week', async () => {
  const { extendHours } = await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  const far = Date.now() + 30 * 24 * 3600 * 1000;     // a month
  const got = await extendHours(env, far);
  const hours = (Date.parse(got.until) - Date.now()) / 3600000;
  assert.ok(hours <= 8.01, `capped to 8 hours, got ${hours.toFixed(1)}`);
});

test('an extension is readable, and clearing it puts the hours back', async () => {
  const { extendHours, clearExtension, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  await extendHours(env, Date.now() + 45 * 60000);
  forgetCache(env);
  const on = await readSettings(env);
  assert.ok(on.extension, 'the extension is in effect');
  assert.ok(Date.parse(on.extension.until) > Date.now());
  assert.ok(Date.parse(on.extension.from) <= Date.now(), 'and knows when it started');

  await clearExtension(env);
  forgetCache(env);
  assert.equal((await readSettings(env)).extension, null);
});


/* --- a driver out at a different time today --------------------------------
   `hours.deliveryFrom` is the standing shift. This moves it for today only, in
   either direction, and must lapse by itself for the same reason the closure
   must: a delivery time changed on a Saturday afternoon is a delivery time
   still wrong on Wednesday. It is never published as an opening hour. */

test('today\'s delivery shift moves in both directions and lapses at midnight', async () => {
  const { setDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  // Earlier: somebody is in the building at two and free to drive.
  const early = await setDeliveryShift(env, '14:00');
  assert.equal(early.from, '14:00');

  // Later: nobody is free until nine. The same switch, a different time — not
  // a second feature, which is the whole point of storing a time.
  const late = await setDeliveryShift(env, '21:00');
  assert.equal(late.from, '21:00');

  forgetCache(env);
  const live = await readSettings(env);
  assert.equal(live.deliveryShift.from, '21:00');

  // It ends tonight without anybody coming back to release it.
  const until = Date.parse(live.deliveryShift.until);
  assert.ok(until > Date.now(), 'still in force now');
  assert.ok(until - Date.now() <= 24 * 3600 * 1000, 'and gone within the day');
  assert.equal(
    new Date(until).toLocaleTimeString('sv-SE', { timeZone: BERLIN }),
    '00:00:00',
    'the end is midnight in Hockenheim, not on the server'
  );
});

test('an empty shift is a real answer, and a mistyped one changes nothing', async () => {
  const { setDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  // '' means a driver is out for the whole opening today — the same meaning it
  // carries in hours.deliveryFrom, and the "all day today" button at /admin.
  const all = await setDeliveryShift(env, '');
  assert.equal(all.from, '');
  forgetCache(env);
  assert.equal((await readSettings(env)).deliveryShift.from, '');

  /* A time that is not a time is REFUSED, never read as "". Reading "1800" as
     "delivers all day" would put a driver on the road at eleven — the same
     silent publication the hours themselves refuse. */
  assert.equal(await setDeliveryShift(env, '1800'), null);
  assert.equal(await setDeliveryShift(env, '25:00'), null);

  // And the refusal left the earlier answer standing rather than clearing it.
  forgetCache(env);
  assert.equal((await readSettings(env)).deliveryShift.from, '');
});

test('"no driver today" is a third answer, and is never read as "all day"', async () => {
  const { setDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  /* The distinction that costs money if it is lost: null means nobody is
     driving, '' means somebody is driving all day. Both are falsy, so any
     reader that tests truthiness turns "no driver" into "a driver from the
     moment we open" and promises a car that does not exist. */
  const none = await setDeliveryShift(env, null);
  assert.equal(none.from, null);

  forgetCache(env);
  const live = await readSettings(env);
  assert.equal(live.deliveryShift.from, null,
    'it must survive the database as null, not come back as ""');
  assert.notEqual(live.deliveryShift.from, '',
    'no driver is not the same fact as a driver all day');

  // And the opposite answer still stores as the opposite answer.
  await setDeliveryShift(env, '');
  forgetCache(env);
  assert.equal((await readSettings(env)).deliveryShift.from, '');
});

test('a delivery shift that has already elapsed is the same as none', async () => {
  const { setDeliveryShift, clearDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  assert.equal((await readSettings(env)).deliveryShift, null);

  // An end already gone is refused rather than stored as expired.
  assert.equal(await setDeliveryShift(env, '14:00', Date.now() - 60000), null);

  await setDeliveryShift(env, '14:00');
  await clearDeliveryShift(env);
  forgetCache(env);
  assert.equal((await readSettings(env)).deliveryShift, null,
    'clearing puts the standing delivery time back');
});

test('a page cached before tonight\'s state was set does not survive it', async () => {
  const { setDeliveryShift, extendHours, clearDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const { liveETag } = await import('../../worker/page-render.js');
  const env = { DB: freshDatabase() };

  /* Both of these are STATED in the markup, so a copy cached before either was
     set says the wrong thing — and `must-revalidate` revalidates its way
     straight back to it unless the tag moves. This is the failure that kept
     the note under the hours from ever appearing. */
  const tag = async () => {
    forgetCache(env);
    return liveETag('"asset-1"', await readSettings(env));
  };

  const plain = await tag();

  await setDeliveryShift(env, '14:00');
  const shifted = await tag();

  /* And it stays ONE entity tag. `If-None-Match` is a comma-separated list, so
     the header is split on commas before anything is compared — a comma inside
     the tag is torn in half by that split and can never match itself. Every
     request then answers 200 with a full body and nothing says so. */
  assert.ok(!shifted.includes(','), `an ETag may not contain a comma: ${shifted}`);
  assert.notEqual(shifted, plain, 'a moved driver makes every cached copy stale');

  await extendHours(env, Date.now() + 45 * 60000);
  assert.notEqual(await tag(), shifted, 'and so does staying open later');

  // Nothing changed, so nothing is stale: an unchanged page still answers 304.
  assert.equal(await tag(), await tag());

  await clearDeliveryShift(env);
  const back = await tag();
  assert.notEqual(back, shifted, 'and putting it back is a change too');
});

test('today\'s driver never becomes a published opening hour', async () => {
  const { setDeliveryShift, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const { withLiveData } = await import('../../worker/page-render.js');
  const env = { DB: freshDatabase() };

  await setDeliveryShift(env, '14:00');
  forgetCache(env);
  const settings = await readSettings(env);

  const page = withLiveData(
    '<html><head></head><body>' +
    '<script id="restaurantSchema" type="application/ld+json">{"@type":"Restaurant"}</script>' +
    '<!--hours:start--><!--hours:end--></body></html>',
    settings
  );

  // The browser is told, so the basket and the note under the hours can act.
  assert.match(page, /"deliveryShift":\{"from":"14:00"/);

  /* But nothing Google reads moved. openingHoursSpecification and the hours
     table state the week; one afternoon with a driver in it is not a new week,
     and the place card caches whatever is published here. */
  const schema = JSON.parse(
    page.match(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/)[1]
  );
  for (const spec of schema.openingHoursSpecification || []) {
    assert.ok(spec.opens !== '14:00' || spec.closes !== '14:00');
  }
  assert.equal(
    JSON.stringify(settings.hours.deliveryFrom),
    JSON.stringify((await readSettings(env)).hours.deliveryFrom),
    'the standing delivery time is untouched'
  );
});


/* --- the fortnight the restaurant is away ----------------------------------
   The band that tells guests the shop is shut. It is the most expensive
   sentence this site can publish, and it is typed on a phone — so what is
   tested here is that a pair of dates which cannot be true is refused whole
   rather than repaired, that it lapses by being read against the clock, and
   that it never becomes an opening hour. */

test('a holiday is two dates, and the band is up from the moment it is saved', async () => {
  const { setHoliday, readSettings, forgetCache } = await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  assert.equal((await readSettings(env)).holiday, null, 'nothing announced');

  const saved = await setHoliday(env, '2026-09-09', '2026-09-19', '2026-08-20');
  assert.deepEqual(saved, { from: '2026-09-09', until: '2026-09-19' });

  forgetCache(env);
  const live = (await readSettings(env)).holiday;
  assert.deepEqual(live, { from: '2026-09-09', until: '2026-09-19' });
});

test('the pair that cannot be true is refused, not repaired', async () => {
  const { setHoliday, readSettings, forgetCache } = await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };
  const today = '2026-08-20';

  // Back before we left, and back on the day we left: neither is a holiday.
  assert.equal(await setHoliday(env, '2026-09-19', '2026-09-09', today), null);
  assert.equal(await setHoliday(env, '2026-09-09', '2026-09-09', today), null);

  // Not dates at all — including the one a date field yields when it is empty.
  assert.equal(await setHoliday(env, '', '2026-09-19', today), null);
  assert.equal(await setHoliday(env, '09.09.2026', '19.09.2026', today), null);

  /* Already over. The failure this guards is the expensive one: a band that
     goes up saying the shop is shut for a fortnight that ended in March. */
  assert.equal(await setHoliday(env, '2026-03-01', '2026-03-10', today), null);

  // A mistyped year is a year-long closure, so it is refused as well.
  assert.equal(await setHoliday(env, '2026-09-09', '2027-09-19', today), null);

  forgetCache(env);
  assert.equal((await readSettings(env)).holiday, null, 'and nothing was stored');
});

test('a holiday lapses on the morning we are back, with nothing to run', async () => {
  const { setHoliday, readSettings, forgetCache } = await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  /* Stored while it is still ahead, and read back on the day we return: the
     row is untouched and the answer is "no holiday". Nothing sweeps it — the
     clock is read, which is the same way the closure and the extension end. */
  const from = dayOf(Date.now() - 3 * 86400000);
  const until = dayOf(Date.now() + 2 * 86400000);
  assert.ok(await setHoliday(env, from, until));

  forgetCache(env);
  assert.ok((await readSettings(env)).holiday, 'up while it runs');

  const { normaliseHoliday } = await import('../../worker/settings.js');
  assert.equal(normaliseHoliday({ from, until }, until), null, 'gone the day we are back');
  assert.equal(normaliseHoliday({ from, until }, dayOf(Date.now() + 9 * 86400000)), null);
});

test('clearing it takes the band down, and nothing else changes', async () => {
  const { setHoliday, clearHoliday, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const env = { DB: freshDatabase() };

  const before = await readSettings(env);
  await setHoliday(env, dayOf(), dayOf(Date.now() + 5 * 86400000));
  forgetCache(env);
  assert.ok((await readSettings(env)).holiday);

  await clearHoliday(env);
  forgetCache(env);
  const after = await readSettings(env);
  assert.equal(after.holiday, null);

  /* A holiday announces; it does not close. The till and the week are the
     ordering switch's business and the hours table's, and neither may move
     because a band went up or came down. */
  assert.equal(after.ordering.open, before.ordering.open);
  assert.deepEqual(after.hours, before.hours);
});

test('the holiday reaches the browser, and never the opening hours', async () => {
  const { setHoliday, readSettings, forgetCache } = await import('../../worker/settings.js');
  const { withLiveData, liveETag } = await import('../../worker/page-render.js');
  const env = { DB: freshDatabase() };

  const until = dayOf(Date.now() + 6 * 86400000);
  await setHoliday(env, dayOf(), until);
  forgetCache(env);
  const settings = await readSettings(env);

  const markup = '<html><head></head><body>' +
    '<script id="restaurantSchema" type="application/ld+json">{"@type":"Restaurant"}</script>' +
    '<!--hours:start--><!--hours:end--></body></html>';
  const page = withLiveData(markup, settings);

  // The band reads it out of the island, synchronously, at boot.
  assert.ok(page.includes(`"holiday":${JSON.stringify(settings.holiday)}`),
    'the band reads the two dates out of the island, synchronously, at boot');

  /* And the week is untouched: openingHoursSpecification is what Google caches
     for the place card, and a fortnight away is not a change to what the
     restaurant does every week. */
  const schema = JSON.parse(
    page.match(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/)[1]
  );
  assert.ok(!JSON.stringify(schema).includes(until), 'no holiday date in the structured data');

  /* And a page cached before it was announced has to go stale, or it would
     revalidate its way back to a copy saying there is no holiday for ever. */
  const quiet = liveETag('"abc"', { ...settings, holiday: null });
  assert.notEqual(liveETag('"abc"', settings), quiet);
  assert.ok(!liveETag('"abc"', settings).includes(','), 'no comma: If-None-Match splits on it');
});


test('a holiday is published as special hours, and never as the week', async () => {
  const { setHoliday, clearHoliday, readSettings, forgetCache } =
    await import('../../worker/settings.js');
  const { withLiveData } = await import('../../worker/page-render.js');
  const env = { DB: freshDatabase() };

  const markup = '<html><head></head><body>' +
    '<script id="restaurantSchema" type="application/ld+json">{"@type":"Restaurant"}</script>' +
    '<!--hours:start--><!--hours:end--></body></html>';
  const schemaOf = (page) => JSON.parse(
    page.match(/<script id="restaurantSchema"[^>]*>([\s\S]*?)<\/script>/)[1]
  );

  await setHoliday(env, '2026-09-09', '2026-09-19', '2026-09-01');
  forgetCache(env);
  const away = schemaOf(withLiveData(markup, await readSettings(env)));

  /* One entry for the run, and `validThrough` is the LAST DAY CLOSED — the
     18th, from a stored pair that only names the 9th and the 19th. Off by one
     here and the site tells Google it is shut on the morning it reopens. */
  assert.deepEqual(away.specialOpeningHoursSpecification, [{
    '@type': 'OpeningHoursSpecification',
    opens: '00:00',
    closes: '00:00',
    validFrom: '2026-09-09',
    validThrough: '2026-09-18'
  }]);

  /* And the week is untouched: that is what the Google and Apple place cards
     cache, and a fortnight away is not a new week. */
  assert.ok(away.openingHoursSpecification.length > 0);
  for (const spec of away.openingHoursSpecification) {
    assert.ok(!spec.validFrom && !spec.validThrough, 'the week carries no dates');
  }

  /* Gone when the holiday is gone. A closure left in the markup tells every
     crawler the restaurant is shut on days it is open, and nothing on the page
     would look wrong to the person reading it. */
  await clearHoliday(env);
  forgetCache(env);
  const back = schemaOf(withLiveData(markup, await readSettings(env)));
  assert.equal(back.specialOpeningHoursSpecification, undefined);
});


/* --- the two facts, joined -------------------------------------------------
   A holiday announces and the switch closes, and for a while nothing asked
   both. The switch's default is midnight tonight — right for a closure, and
   wrong every single night of a fortnight away: it lapsed at midnight and the
   till opened at breakfast, on a morning with nobody in the building.

   These are the cases that cost the order. ------------------------------- */

test('a holiday stops the till, even with the switch left open — COSTS MONEY', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');

  const now = Date.parse('2026-09-11T09:00:00Z');       // third morning away
  const settings = {
    ordering: { open: true, reason: null, resumesAt: null },
    holiday: normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-11')
  };

  const verdict = orderingNow(settings, now);
  assert.equal(verdict.open, false, 'the shop is empty; the till must not take an order');
  assert.equal(verdict.reason, 'holiday');
  assert.equal(verdict.namedEnd, true, 'the guest is told the day we are back');
  assert.equal(berlin(Date.parse(verdict.resumesAt)), '2026-09-19 00:00:00');
});

test('a closure that lapses at midnight cannot shorten the holiday — COSTS MONEY', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');
  const holiday = normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-11');

  /* Exactly what was live on the morning this was found: somebody tapped the
     plain stop switch, which names no end, so it ran to midnight tonight —
     with eight days of the holiday still to go. */
  const tonight = Date.parse('2026-09-11T09:00:00Z');
  assert.equal(orderingNow({
    ordering: {
      open: false, reason: null, namedEnd: false,
      resumesAt: '2026-09-11T22:00:00.000Z'
    },
    holiday
  }, tonight).open, false, 'closed either way, while both are on');

  /* And tomorrow morning, after the switch has let go by itself. readSettings
     reports it as open again from that moment — which is right for a closure
     and was, on its own, a shop taking orders with nobody in the building. */
  const tomorrow = Date.parse('2026-09-12T09:00:00Z');
  const after = orderingNow({
    ordering: { open: true, reason: null, resumesAt: null },
    holiday: normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-12')
  }, tomorrow);

  assert.equal(after.open, false, 'the holiday still has a week to run');
  assert.equal(after.reason, 'holiday');
  assert.equal(berlin(Date.parse(after.resumesAt)), '2026-09-19 00:00:00');
});

test('neither may shorten the other: the later end wins', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');

  const now = Date.parse('2026-09-11T09:00:00Z');
  const holiday = normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-11');

  /* A closure set to run past the holiday — the boiler is out and the kitchen
     will not be back with the rest of us. The holiday must not release it. */
  const beyond = orderingNow({
    ordering: {
      open: false, reason: 'emergency', namedEnd: true,
      resumesAt: '2026-09-25T00:00:00.000Z'
    },
    holiday
  }, now);
  assert.equal(beyond.resumesAt, '2026-09-25T00:00:00.000Z');
  assert.equal(beyond.reason, 'emergency', 'and it keeps its own reason');

  // And the other way round: a closure ending inside the holiday defers to it.
  const inside = orderingNow({
    ordering: {
      open: false, reason: 'demand', namedEnd: true,
      resumesAt: '2026-09-14T00:00:00.000Z'
    },
    holiday
  }, now);
  assert.equal(berlin(Date.parse(inside.resumesAt)), '2026-09-19 00:00:00');
  assert.equal(inside.reason, 'holiday');
});

test('an announced holiday that has not started yet withholds nothing', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');

  /* The band goes up the moment the dates are saved, usually a fortnight
     early. Those are days the restaurant is open and selling, and stopping the
     till on them would cost more than the bug this fixes. */
  const now = Date.parse('2026-09-01T12:00:00Z');
  const verdict = orderingNow({
    ordering: { open: true, reason: null, resumesAt: null },
    holiday: normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-01')
  }, now);
  assert.equal(verdict.open, true, 'announced is not away');
});

test('the till opens by itself on the morning we are back', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');

  const back = Date.parse('2026-09-19T06:00:00Z');       // 08:00 in Hockenheim
  const held = { from: '2026-09-09', until: '2026-09-19' };

  // Already lapsed as a setting, and lapsed again as a verdict: neither needs
  // anybody to come back and release it.
  assert.equal(normaliseHoliday(held, '2026-09-19'), null);
  assert.equal(orderingNow({
    ordering: { open: true, reason: null, resumesAt: null }, holiday: held
  }, back).open, true);
});

test('a guest may still order ahead for the day we reopen', async () => {
  const { orderingNow, normaliseHoliday } = await import('../../worker/settings.js');

  const now = Date.parse('2026-09-11T09:00:00Z');
  const { resumesAt } = orderingNow({
    ordering: { open: true, reason: null, resumesAt: null },
    holiday: normaliseHoliday({ from: '2026-09-09', until: '2026-09-19' }, '2026-09-11')
  }, now);

  /* A holiday withholds a MOMENT, not the order — the same rule the closure
     applies. Someone booking the evening we are back is the most valuable
     order on the site that fortnight, and refusing it would be the second bug
     written while fixing the first. */
  assert.equal(wantedAfterClosure(resumesAt, { date: '2026-09-19', time: '18:30' }), true);
  assert.equal(wantedAfterClosure(resumesAt, { date: '2026-09-18', time: '18:30' }), false);
  assert.equal(wantedAfterClosure(resumesAt, null), false, 'and "as soon as possible" is not');
});

test('the page arrives already dimmed, before a line of script has run', async () => {
  const { setHoliday, readSettings, forgetCache } = await import('../../worker/settings.js');
  const { withLiveData } = await import('../../worker/page-render.js');
  const env = { DB: freshDatabase() };

  const markup = '<html><head></head><body>' +
    '<script id="restaurantSchema" type="application/ld+json">{"@type":"Restaurant"}</script>' +
    '<!--hours:start--><!--hours:end--></body></html>';

  assert.ok(!withLiveData(markup, await readSettings(env)).includes('data-ordering="off"'),
    'nothing announced, nothing dimmed');

  // Away from today. The switch is untouched and still says open.
  await setHoliday(env, dayOf(), dayOf(Date.now() + 5 * 86400000));
  forgetCache(env);
  const settings = await readSettings(env);
  assert.equal(settings.ordering.open, true, 'the switch itself is not moved by a band');

  const page = withLiveData(markup, settings);
  assert.ok(page.includes('data-ordering="off"'),
    'the buttons must not be live for the moment it takes order.js to notice');

  /* And the island still carries the two facts SEPARATELY. The band is drawn
     from the dates and the till from the verdict; merging them at the source
     would leave the band unable to say what it is for. */
  assert.ok(page.includes(`"holiday":${JSON.stringify(settings.holiday)}`));
  assert.ok(page.includes('"ordering":{"open":true'));
});
