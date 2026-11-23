/* The restaurant's clock.
   ---------------------------------------------------------------------------
   Every date this server reasons about is a date in Hockenheim, not a date in
   UTC and not a date wherever the isolate happens to be running. "Tomorrow"
   means tomorrow in the shop.

   No library. The trick throughout is that `toLocaleString('sv-SE')` prints a
   wall clock in a chosen zone in a format `Date.parse` can read back, which is
   enough to recover the zone's offset at any instant — including across the
   two Sundays a year when it changes. */

const ZONE = 'Europe/Berlin';

/** How far Berlin is ahead of UTC at this instant, in milliseconds. */
function offsetAt(instant) {
  const wall = new Date(instant).toLocaleString('sv-SE', { timeZone: ZONE });
  return Date.parse(wall.replace(' ', 'T') + 'Z') - instant;
}

/** 'YYYY-MM-DD' in Berlin. */
export function dayOf(instant = Date.now()) {
  return new Date(instant).toLocaleDateString('sv-SE', { timeZone: ZONE });
}

/** 'HH:MM' in Berlin. */
export function timeOf(instant = Date.now()) {
  return new Date(instant).toLocaleTimeString('sv-SE', {
    timeZone: ZONE, hour: '2-digit', minute: '2-digit'
  });
}

/** The instant at which a Berlin wall-clock moment occurs, as epoch ms.
 *  Resolved twice because the offset that applies is the one at the ANSWER,
 *  not the one at the guess — which is the whole difficulty on a clock-change
 *  night. */
function resolve(shifted) {
  const guess = shifted - offsetAt(shifted);
  return shifted - offsetAt(guess);
}

/** A named Berlin wall-clock moment — '2026-08-17', '09:30' — as epoch ms. */
export function instantOf(dateISO, hhmm = '00:00') {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return resolve(Date.UTC(y, m - 1, d, hh, mm, 0, 0));
}

/** Midnight tonight, Berlin — i.e. the first moment of tomorrow.
 *  This is what "until the end of the day" means, and it is the default the
 *  ordering switch expires at: a shop closed by accident opens itself again. */
export function nextMidnight(instant = Date.now()) {
  const wall = new Date(instant + offsetAt(instant));
  wall.setUTCHours(24, 0, 0, 0);
  return resolve(wall.getTime());
}

/** The next occurrence of a 'HH:MM' Berlin wall clock, today if it is still
 *  ahead and tomorrow if it has passed. */
export function nextTimeOfDay(hhmm, instant = Date.now()) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const wall = new Date(instant + offsetAt(instant));
  wall.setUTCHours(h, m, 0, 0);
  let at = resolve(wall.getTime());
  if (at <= instant) {
    wall.setUTCDate(wall.getUTCDate() + 1);
    at = resolve(wall.getTime());
  }
  return at;
}

/* The Berlin day of a timestamp as D1 stores it.

   `datetime('now')` is "YYYY-MM-DD HH:MM:SS" in UTC with no zone, and
   JavaScript reads THAT as local time, which silently shifts the day. So the
   zone is added only when it is missing, rather than assumed either way. Used
   by /admin/orders to choose a day's orders, and by the correction message to
   link to that same day (R5-03), so the two can never disagree. */
export function berlinDay(stamp) {
  const text = String(stamp || '');
  const utc = /[Z+]|\d{2}:\d{2}$/.test(text.slice(10)) && /[Z+]/.test(text)
    ? text
    : text.replace(' ', 'T') + 'Z';
  const date = new Date(utc);
  return isNaN(date.getTime()) ? '' : dayOf(date.getTime());
}
