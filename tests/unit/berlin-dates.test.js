/* The gate test "an order scheduled past the closure goes through untouched"
   closes ordering until 23:30 and schedules an order on a later day at 19:00
   (DELIVERY_PRICING DP-26-03). It used to pick that day as "tomorrow" on the
   browser's clock, and failed every night between 23:30 and 01:00 Berlin on a
   UTC machine. Checked here at exactly those instants, without waiting for the
   night: the date the gate now picks always lies after the closure ends, and
   the old choice is shown to fall inside it at the same instants. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { berlinDate, closureEndDay } from '../e2e/berlin-dates.js';

// The old fixture: tomorrow on a UTC+0 browser clock.
const oldChoice = (at) => new Date(at + 86400000).toISOString().slice(0, 10);

// Every 5 minutes through the failing window, on an ordinary night, the night
// it failed (26.11.2026), and both nights the clocks change.
const nights = ['2026-11-26', '2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25', '2026-12-31'];
const instants = [];
for (const night of nights) {
  const start = Date.parse(night + 'T20:00:00Z');   // 21:00 or 22:00 Berlin
  for (let t = start; t < start + 6 * 3600000; t += 5 * 60000) instants.push(t);
}

test('the gate schedules its order after the closure ends, at every instant of the night', () => {
  for (const at of instants) {
    const chosen = berlinDate(at, 2);
    assert.ok(chosen > closureEndDay(at, '23:30'),
      `${new Date(at).toISOString()}: ${chosen} must be after ${closureEndDay(at, '23:30')}`);
  }
});

test('the old choice fell inside the closure at the instants the gate failed', () => {
  const failed = [Date.parse('2026-11-26T22:45:00Z'), Date.parse('2026-11-26T23:54:00Z')];
  for (const at of failed) {
    assert.ok(oldChoice(at) <= closureEndDay(at, '23:30'), new Date(at).toISOString());
    assert.ok(berlinDate(at, 2) > closureEndDay(at, '23:30'));
  }
});

test('a Berlin date is Berlin\'s across midnight and both clock changes', () => {
  assert.equal(berlinDate(Date.parse('2026-11-26T23:30:00Z'), 0), '2026-11-27');   // 00:30 Berlin
  assert.equal(berlinDate(Date.parse('2026-11-26T22:30:00Z'), 0), '2026-11-26');   // 23:30 Berlin
  assert.equal(berlinDate(Date.parse('2026-03-29T00:30:00Z'), 2), '2026-03-31');
  assert.equal(berlinDate(Date.parse('2026-10-25T00:30:00Z'), 2), '2026-10-27');
  assert.equal(berlinDate(Date.parse('2026-12-31T23:30:00Z'), 1), '2027-01-02');
});
