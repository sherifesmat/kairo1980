/* What the restaurant can change without a developer.
   ---------------------------------------------------------------------------
   Everything else on this site follows one rule: a business fact lives in
   exactly one place, and that place is a file in the repository. These two
   facts are the exception, and it is worth being precise about why.

   ORDERING is not a business fact at all. It is the state of one evening —
   the kitchen is swamped, the fryer is out, the driver has not turned up. It
   was never in config.js and never should be: a fact that changes twice a
   month and must change in ten seconds cannot live behind a git push.

   HOURS are a business fact, and moving them here does move the source of
   truth out of config.js. That is a real cost, paid deliberately: opening
   hours change, the restaurant is who changes them, and asking a developer
   to deploy a new closing time is how a website ends up lying about its
   hours for a fortnight. So:

     - config.js -> hours is the DEFAULT. It is what the site launched with,
       what "reset" restores, and what the browser publishes if this server
       cannot be reached.
     - A row in `settings` OVERRIDES it, entirely, and is what the site
       publishes from the moment it is saved.

   Exactly one of the two is in effect at any moment and the admin page says
   which. What must never happen is a third copy: nothing anywhere may retype
   a closing time it could have asked for. */

import { CONFIG } from './site-data.js';
import { dayOf, nextMidnight, nextTimeOfDay, instantOf } from './berlin.js';

const ORDERING = 'ordering';
const HOURS = 'hours';
const SOLDOUT = 'soldout';
const EXTENSION = 'extension';
const SHIFT = 'shift';
const HOLIDAY = 'holiday';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* Read every setting once per request at most, and at most once every few
   seconds per isolate. The emergency switch is read on every page load, and a
   database round trip for a value that changes twice a month is waste — but
   the window has to stay short enough that "stop taking orders" means now. */
/* Keyed on the database binding rather than held in one module-level variable.
   In production that is a distinction without a difference — one isolate has
   one database — but it means a test can hand in a fresh database and get a
   fresh answer, instead of reading the previous test's settings for five
   seconds. A cache that survives its own data is not a cache, it is a bug that
   only appears under load. */
const CACHE_MS = 5000;
const cache = new WeakMap();

export function forgetCache(env) {
  if (env && env.DB) cache.delete(env.DB);
}

export async function readSettings(env) {
  /* No database bound at all — a preview deployment, or a caller that only
     wanted a price. The published defaults are a complete answer, and the
     cache is keyed on the binding, so without one there is nothing to key on:
     WeakMap.set(undefined) throws, which would turn a missing binding into a
     500 on a route that never needed the database. */
  if (!env || !env.DB) {
    return {
      ordering: normaliseOrdering(null),
      hours: defaultHours(),
      hoursAreCustom: false,
      soldOut: {},
      extension: null,
      deliveryShift: null,
      holiday: null,
      hoursVersion: '0',
      soldOutVersion: '0'
    };
  }

  const held = cache.get(env.DB);
  if (held && held.until > Date.now()) return held.value;

  let rows = [];
  try {
    const result = await env.DB.prepare('SELECT key, value, updated_at FROM settings').all();
    rows = result.results || [];
  } catch (err) {
    // A settings table that cannot be read must never take the site down: the
    // published defaults are a complete, correct answer.
    console.error('settings unreadable', err && err.message);
  }

  const raw = {};
  for (const row of rows) {
    try { raw[row.key] = JSON.parse(row.value); } catch { /* ignore a bad row */ }
  }

  const custom = normaliseHours(raw[HOURS]);
  const value = {
    ordering: normaliseOrdering(raw[ORDERING]),
    hours: custom || defaultHours(),
    /* Dishes the kitchen has run out of. A list of ids and the moment each was
       marked — the time is what stops a dish being sold out for a fortnight
       because somebody flipped it on a Saturday and went home, which is the
       same failure the ordering switch carries its own end to avoid. */
    soldOut: normaliseSoldOut(raw[SOLDOUT]),
    /* Tonight only: the shop is staying open later than the fixed hours say.
       Never written into the published opening hours — see writeExtension. */
    extension: normaliseExtension(raw[EXTENSION]),
    /* Tonight only: a driver is out at a different time from the usual shift —
       earlier because somebody is free, later because nobody is yet. Same
       reasoning as the extension, and equally never published. */
    deliveryShift: normaliseDeliveryShift(raw[SHIFT]),
    /* Weeks, not a night: the fortnight the restaurant is away. Unlike the two
       above it is announced to guests rather than merely obeyed, and unlike
       them it is set days in advance — but it is the same shape underneath,
       and it lapses the same way. */
    holiday: normaliseHoliday(raw[HOLIDAY]),
    // So the admin page can say which of the two is in effect without guessing.
    hoursAreCustom: !!custom,
    /* When the hours last changed. The pages that state opening hours in their
       markup carry this in their ETag, so a saved change makes every cached
       copy stale at once — and an unchanged one still answers 304. Without it,
       `must-revalidate` would keep revalidating its way to the same stale
       body, because the asset behind it never changed. */
    hoursVersion: (rows.find((r) => r.key === HOURS) || {}).updated_at || '0',
    // Pages state which dishes are sold out, so the ETag has to move when the
    // answer does — exactly as it does for the hours.
    soldOutVersion: (rows.find((r) => r.key === SOLDOUT) || {}).updated_at || '0'
  };

  cache.set(env.DB, { value, until: Date.now() + CACHE_MS });
  return value;
}

/* --- the emergency switch ------------------------------------------------
   Off is always temporary. Closing has an end on it from the moment it is
   thrown — by default the end of the day — and the switch returns to on by
   itself when that moment passes.

   That default is the important part. The failure this guards against is not
   a shop that stays open when it should not; it is a Tuesday lunchtime spent
   wondering why nobody is ordering, because somebody closed it on Saturday
   night and went home. Nothing has to run for it to expire: the expiry is read
   against the clock, so it happens whether or not anyone visits. */

/* Why we stopped decides what the guest is told, so the reason is a value with
   a fixed set of members rather than free text. Three reasons, because a
   sentence typed into a phone at the till would be German only — and every
   visible string on this site exists in German, English and Egyptian Arabic or
   it does not ship. Adding a fourth is a line here and three lines in the T
   table in order.js, which is the correct amount of work for a new sentence in
   three languages. */
const REASONS = ['demand', 'emergency', 'holiday'];

function normaliseOrdering(value, now = Date.now()) {
  if (!value || value.open !== false) return { open: true, reason: null, resumesAt: null };

  const resumesAt = Date.parse(String(value.resumesAt || ''));
  // A closure with no end, or with one already past, is over. Nothing has to
  // run for that to happen: it is read against the clock, not swept.
  if (!Number.isFinite(resumesAt) || resumesAt <= now) {
    return { open: true, reason: null, resumesAt: null };
  }

  return {
    open: false,
    // No reason is a valid choice, and the common one: the guest is simply
    // told we are not taking orders. A reason is added when it helps them
    // decide what to do — not to explain ourselves.
    reason: REASONS.includes(value.reason) ? value.reason : null,
    resumesAt: new Date(resumesAt).toISOString(),
    /* Whether the restaurant named the moment or let it default. A closure
       running to tonight's midnight is "back later"; one running to a date
       somebody chose is "back on Monday the 17th". The difference is not
       derivable from the timestamp — midnight tonight and a date chosen as
       tomorrow are the same instant — so it is recorded. */
    namedEnd: value.namedEnd === true
  };
}

/** Close ordering.
 *
 *  `untilDate` ('YYYY-MM-DD') and `untilTime` ('HH:MM') are both optional and
 *  compose:
 *    both      -> back at that time on that date
 *    date only -> back at the start of that date
 *    time only -> back at that time, today if it is still ahead, else tomorrow
 *    neither   -> back at midnight tonight
 *
 *  That last line is the one that matters. A closure with no end is how a shop
 *  spends a Tuesday lunchtime wondering why nobody is ordering, because
 *  somebody stopped the till on Saturday and went home. The default is not
 *  "forever"; it is "today". */
export async function closeOrdering(env, { reason, untilDate, untilTime, minutes } = {}) {
  const date = DATE.test(String(untilDate || '')) ? String(untilDate) : null;
  const time = TIME.test(String(untilTime || '')) ? String(untilTime) : null;

  /* "For the next hour" is the commonest closure there is — the kitchen is
     buried and wants to catch up — and it is the one nobody should have to
     type a clock time for at the till. Capped at a week: a slip of the finger
     on a number field must not be able to close the shop until Christmas. */
  const forMinutes = Math.min(Math.max(Number(minutes) || 0, 0), 7 * 24 * 60);

  const resumesAt = forMinutes ? Date.now() + forMinutes * 60000
    : date ? instantOf(date, time || '00:00')
      : time ? nextTimeOfDay(time)
        : nextMidnight();

  const value = {
    open: false,
    reason: REASONS.includes(reason) ? reason : null,
    resumesAt: new Date(resumesAt).toISOString(),
    namedEnd: !!(date || time || forMinutes)
  };
  await put(env, ORDERING, value);
  return normaliseOrdering(value);
}

export async function openOrdering(env) {
  const value = { open: true, reason: null, resumesAt: null };
  await put(env, ORDERING, value);
  return value;
}

/* --- the opening hours --------------------------------------------------- */

function defaultHours() {
  const h = (CONFIG && CONFIG.hours) || {};
  return {
    deliveryFrom: TIME.test(String(h.deliveryFrom || '')) ? String(h.deliveryFrom) : '',
    days: DAYS.reduce((out, key) => {
      const day = (h.days && h.days[key]) || {};
      const lunch = window2(day.lunch);
      const evening = window2(day.evening);
      out[key] = {
        closed: day.closed !== false,
        // config.js is trusted, but a bad literal there should read as "no
        // window" rather than propagate a `false` into the published hours.
        lunch: lunch || null,
        evening: evening || null
      };
      return out;
    }, {})
  };
}

/* Three answers, not two, and the difference matters more than it looks.
     null   — nothing was entered. That day simply has no such window.
     false  — something was entered and it is not a window.
     [a, b] — a window.

   Collapsing `false` into `null` is a bug with teeth: a closing time fat-
   fingered as "0900" would quietly become "no evening service", and a day with
   no windows is a day the site publishes as CLOSED. A typo would shut the
   restaurant, in the structured data Google reads, and nothing would say so.
   So an entered-but-invalid window refuses the whole save. */
function window2(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== 2) return false;

  const [from, to] = value.map((v) => String(v == null ? '' : v).trim());
  if (!from && !to) return null;                       // both boxes left empty
  if (!TIME.test(from) || !TIME.test(to)) return false;
  // A window that ends before it starts is not a window.
  if (to <= from) return false;
  return [from, to];
}

/** Anything that is not a complete, valid week is not hours. Returns null
 *  rather than a half-repaired object: a partly-understood opening time is
 *  worse than the default, because nobody can tell it is wrong by reading it. */
export function normaliseHours(value) {
  if (!value || typeof value !== 'object' || !value.days) return null;

  const days = {};
  for (const key of DAYS) {
    const day = value.days[key];
    if (!day || typeof day !== 'object') return null;

    const lunch = window2(day.lunch);
    const evening = window2(day.evening);
    // A time that was typed and is not a time refuses the save outright. See
    // window2: silently reading it as "closed" is how a typo shuts the shop.
    if (lunch === false || evening === false) return null;

    /* The two windows are also checked AGAINST EACH OTHER, not only each on its
       own. Two windows that overlap are not two windows, and the damage is not
       cosmetic: the day publishes two overlapping OpeningHoursSpecification
       entries to the crawlers that feed the Google and Apple place cards, while
       the table prints two rows that contradict each other. It reads as valid
       to every check that looks at one window at a time, which is exactly why
       it has to be caught here — a second window that starts before the first
       has ended is the same class of mistake as one that ends before it starts,
       and is refused the same way. */
    if (lunch && evening && evening[0] < lunch[1]) return null;

    const closed = day.closed === true || (!lunch && !evening);

    /* A day with only a SECOND window has one window, and is stored as one.
       The form offers two boxes because an afternoon break needs two, and it
       is easy to fill the lower pair alone — "we open in the evening" reads
       like the evening box. That saved and worked, but left the week stored
       two different ways for the same shape, which is how a later reader
       concludes the first box is broken. Canonical beats forgiving. */
    const first = lunch || evening;
    const second = lunch ? evening : null;

    days[key] = {
      closed,
      lunch: closed ? null : first,
      evening: closed ? null : second
    };
  }

  /* An empty delivery time is a real answer — "a driver is out whenever we are
     open" — so it is kept, and only a value that was typed and is not a time
     refuses the save. Reading a mistyped "1800" as "delivers all day" would
     promise a midday driver that does not exist, which is the same silent-
     publication failure window2() exists to prevent.

     ABSENT is not the same as empty, and the difference is what makes this
     change safe to deploy. A row saved before `deliveryFrom` existed carries no
     such key, and reading that as "" would silently put a driver on the road at
     11:00 the moment this ships — the restriction lifted by an upgrade, which
     is precisely the kind of quiet publication nothing here is allowed to do.
     So an absent key falls back to config.js, exactly as the hours themselves
     do, and only a form that actually submitted an empty box clears it. */
  const fallback = (CONFIG && CONFIG.hours && CONFIG.hours.deliveryFrom) || '';
  const raw = value.deliveryFrom === undefined ? fallback : value.deliveryFrom;
  const from = String(raw == null ? '' : raw).trim();
  if (from && !TIME.test(from)) return null;

  return { days, deliveryFrom: from };
}

export async function writeHours(env, value) {
  const hours = normaliseHours(value);
  if (!hours) return null;
  await put(env, HOURS, hours);
  return hours;
}

/** Back to what config.js says, by deleting the row rather than copying the
 *  defaults into it — a copy would go stale the day config.js changes. */
export async function resetHours(env) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(HOURS).run();
  forgetCache(env);
}

async function put(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, JSON.stringify(value)).run();
  forgetCache(env);
}


/* --- dishes the kitchen has run out of -------------------------------------
   Unlike a postcode or a lunchtime, this is not advisory. Everything else on
   this site warns and lets the order through, because the guest might be right
   and we might be wrong. Here we are certainly right: the ingredient is not in
   the building, and taking money for it would mean ringing the guest back to
   say so. So it is refused, in the basket AND in worker/pricing.js, which is
   the only refusal on the whole site.

   Stored as { id: markedAt }, not as a bare list, so /admin can say how long a
   dish has been off and nothing quietly stays sold out for a fortnight. */

function normaliseSoldOut(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, at] of Object.entries(value)) {
    if (typeof id !== 'string' || !id || id.length > 80) continue;
    out[id] = typeof at === 'string' ? at : new Date().toISOString();
  }
  return out;
}

/** Replace the whole set. `ids` is what is sold out now; anything absent is
 *  back on. A dish already off keeps its original timestamp, so "sold out
 *  since Saturday" does not reset itself every time the form is saved. */
export async function writeSoldOut(env, ids, existing = {}) {
  const now = new Date().toISOString();
  const value = {};
  for (const id of ids) {
    if (typeof id === 'string' && id && id.length <= 80) {
      value[id] = existing[id] || now;
    }
  }
  await put(env, SOLDOUT, value);
  return value;
}


/* --- staying open later than the hours say ---------------------------------
   The opposite of the closure switch, and the same shape: it carries its own
   end, it expires by being read against the clock, and nothing has to run for
   it to lapse. Somebody still in the restaurant at midnight taps "+1 hour"
   rather than editing the week — because a fixed closing time edited on a
   Saturday night is a fixed closing time still wrong on Tuesday.

   IT IS NEVER PUBLISHED AS AN OPENING HOUR. `openingHoursSpecification` states
   what the restaurant does every week, and Google caches it for the place
   card; a Saturday that ran late is not a new Saturday. So this changes what
   can be ORDERED right now and what the badge says, and touches neither the
   structured data nor the hours table's own rows. */

function normaliseExtension(value, now = Date.now()) {
  if (!value) return null;
  const until = Date.parse(String(value.until || ''));
  // Already elapsed is the same as never set. Read against the clock, not swept.
  if (!Number.isFinite(until) || until <= now) return null;
  const from = Date.parse(String(value.from || ''));
  return {
    from: Number.isFinite(from) ? new Date(from).toISOString() : new Date(now).toISOString(),
    until: new Date(until).toISOString()
  };
}

/** Stay open until `until` (an epoch ms or ISO). Capped at 8 hours ahead: a
 *  slip on a number field must not leave the shop advertising itself as open
 *  for a week. */
export async function extendHours(env, until) {
  const at = typeof until === 'number' ? until : Date.parse(String(until || ''));
  if (!Number.isFinite(at)) return null;
  const capped = Math.min(at, Date.now() + 8 * 3600 * 1000);
  if (capped <= Date.now()) return null;

  const value = { from: new Date().toISOString(), until: new Date(capped).toISOString() };
  await put(env, EXTENSION, value);
  return normaliseExtension(value);
}

/** Back to the fixed hours, now. */
export async function clearExtension(env) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(EXTENSION).run();
  forgetCache(env);
}


/* --- a driver out at a different time today --------------------------------
   `hours.deliveryFrom` says when a driver goes out EVERY WEEK. Some days that
   is not when one actually goes out: somebody is in the building at two and
   free to drive, or nobody is free until nine. Both are facts about one day,
   and neither is a reason to edit the week — a delivery time changed on a
   Saturday afternoon is a delivery time still wrong on Wednesday.

   So this is the same shape as the extension above and the closure above that:
   it carries its own end, it expires by being read against the clock, and
   nothing has to run for it to lapse. It moves the shift in EITHER direction,
   because "I can drive from now" and "no driver until nine" are one fact with
   two values, not two features.

   IT IS NEVER PUBLISHED AS AN OPENING HOUR. The hours table and
   `openingHoursSpecification` state the standing arrangement, and Google caches
   the latter for the place card; one afternoon's driver is not a new week. So
   this changes what can be ORDERED, and adds one sentence beneath the hours
   saying what is true today — and touches neither the table nor the schema.

   `from` has THREE answers, and the third is the one the week cannot express:

     null    — no driver at all today. Collection only, all day.
     ''      — a driver out for the whole opening.
     'HH:MM' — a driver from that time.

   `hours.deliveryFrom` has only the last two, because "we do not deliver" is
   not something a restaurant that delivers says about its week — it is
   something it says about a Tuesday when the driver is ill. Expressing it in
   the weekly field would mean typing a time after closing and hoping every
   reader draws the right conclusion, which is a rule nobody can read back.

   So null is a value here, and it is checked FOR EXPLICITLY everywhere. `''`
   and `null` are both falsy and mean opposite things — a caller that tests
   truthiness turns "no driver at all" into "a driver all day", which is the
   worst answer this switch can give. */

function normaliseDeliveryShift(value, now = Date.now()) {
  if (!value) return null;
  const until = Date.parse(String(value.until || ''));
  // Already elapsed is the same as never set. Read against the clock, not swept.
  if (!Number.isFinite(until) || until <= now) return null;

  /* null survives as null. An ABSENT key is '' — rows written before the third
     answer existed carry a time or an empty string and never a missing one, so
     nothing stored can be misread as "no driver" by this upgrade. */
  const raw = value.from === undefined ? '' : value.from;

  /* A stored time that is not a time is not repaired into ''. Reading it that
     way would put a driver on the road from opening — the same silent
     publication window2() refuses for the hours themselves. */
  const from = raw === null ? null : String(raw).trim();
  if (from && !TIME.test(from)) return null;

  return { from, until: new Date(until).toISOString() };
}

/** Set today's driver: `from` is 'HH:MM', '' for the whole opening, or null
 *  for no driver at all — collection only.
 *
 *  The end is midnight tonight and is not offered as a choice: the whole point
 *  of this switch is that it is about today and lapses without anyone
 *  remembering it. */
export async function setDeliveryShift(env, from, until) {
  const at = from === null ? null : String(from == null ? '' : from).trim();
  if (at && !TIME.test(at)) return null;

  const end = Number.isFinite(until) ? until : nextMidnight();
  if (end <= Date.now()) return null;

  const value = { from: at, until: new Date(end).toISOString() };
  await put(env, SHIFT, value);
  return normaliseDeliveryShift(value);
}

/** Back to the standing delivery time, now. */
export async function clearDeliveryShift(env) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(SHIFT).run();
  forgetCache(env);
}


/* --- the fortnight the restaurant is away ----------------------------------
   The band on the homepage that says we are on holiday, and the two dates it
   prints. It is set from /admin because it is the restaurant's own calendar:
   asking a developer to deploy a date is exactly how a site ends up announcing
   a holiday that finished a week ago.

   THIS ANNOUNCES; IT DOES NOT CLOSE. Stopping the till is the ordering switch,
   which the same page already carries and which the server reads before it
   takes a payment. Two facts, deliberately: a kitchen away for a fortnight
   still wants the band up on the day it reopens' eve, and a closure set for a
   flood has no band at all. The admin page puts them next to each other and
   says which is which, rather than tying one to the other and being wrong
   half the time.

   IT IS UP FROM THE MOMENT IT IS SAVED, and comes down on the day we are back.
   That is one rule instead of two, and it puts the choice where it belongs:
   the restaurant announces a holiday when it wants it announced, by saving it
   then. The copy reads the same before and during — "closed from the 9th to
   the 18th, back on the 19th" is as true in August as it is on the 12th.

   `until` is EXCLUSIVE and is the day we are BACK. The last day closed is
   never stored: the band derives it, so the two cannot be a day apart.

   It expires by being READ AGAINST THE CLOCK, like everything else here.
   Nothing has to run, nobody has to remember, and a band left up over a
   fortnight comes down by itself on the morning the shop reopens — which is
   the one morning a "we are away" sign costs a whole day of orders. */

/* Long enough for a summer closing, short enough that a mistyped year is
   refused rather than announced for eleven months. */
const HOLIDAY_MAX_DAYS = 90;
const DAY_MS = 86400000;

/* Exported for the tests, which have to be able to ask what this says on a
   day that is not today — the whole point of it is what it answers on the
   morning we are back. */
export function normaliseHoliday(value, today = dayOf()) {
  if (!value) return null;
  const from = String(value.from || '');
  const until = String(value.until || '');
  if (!DATE.test(from) || !DATE.test(until) || until <= from) return null;
  // Already over is the same as never set. Both are Berlin calendar dates, so
  // this is a string comparison and no timezone can move it a day.
  if (until <= today) return null;
  return { from, until };
}

/** Announce a holiday: closed from `from`, back on `until` (both
 *  'YYYY-MM-DD', `until` exclusive).
 *
 *  A date that is not a date, a pair the wrong way round, an end already past
 *  or a stay longer than three months REFUSES THE WHOLE SAVE and returns null.
 *  The alternative is a band that publishes something nobody typed — and this
 *  one tells every guest the restaurant is shut. */
export async function setHoliday(env, from, until, today = dayOf()) {
  const a = String(from || '').trim();
  const b = String(until || '').trim();
  if (!DATE.test(a) || !DATE.test(b) || b <= a || b <= today) return null;

  const span = (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS;
  if (!Number.isFinite(span) || span > HOLIDAY_MAX_DAYS) return null;

  const value = { from: a, until: b };
  await put(env, HOLIDAY, value);
  return normaliseHoliday(value, today);
}

/** Take the band down now — the holiday is off, or it is over early. */
export async function clearHoliday(env) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(HOLIDAY).run();
  forgetCache(env);
}
