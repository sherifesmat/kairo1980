/* A date on Berlin's calendar, `days` after the Berlin date of the instant `at`
   (DELIVERY_PRICING DP-26-03).

   The restaurant's closures and opening hours are Berlin's. A test that picks
   "tomorrow" from the browser's or the machine's own clock picks a different
   day for an hour or two around midnight whenever that clock is not Berlin's,
   and a mandatory gate test did exactly that: it failed every night between
   23:30 and 01:00 Berlin on a UTC machine. No dependencies, so the arithmetic
   can be checked on its own (tests/unit/berlin-dates.test.js). */

export function berlinDay(at) {
  return new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

export function berlinDate(at, days) {
  const [y, m, d] = berlinDay(at).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/* The last Berlin day a closure "until HH:MM today" can reach from `at`: today
   if that time is still ahead, otherwise tomorrow (it rolls over). */
export function closureEndDay(at, untilTime) {
  const hm = new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Europe/Berlin', hour12: false }).slice(0, 5);
  return hm < untilTime ? berlinDate(at, 0) : berlinDate(at, 1);
}
