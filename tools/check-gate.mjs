/* The deploy gate's verdict, read from Playwright's JSON report.
   Loop WEBSITE_ORDERING (KBOSS), F / W02-06.

   Playwright exits 0 when everything it RAN passed, which is not the same as
   the gate having held: a skipped test, a grep that matched three tests, or a
   renamed title would all pass silently. So the scenarios are named here,
   and the gate holds only if each ran exactly once and passed, nothing was
   skipped, and nothing else failed.

   Usage: node tools/check-gate.mjs gate-results.json */

import { readFileSync } from 'node:fs';

const REQUIRED = [
  /@gate a pickup Extras order is priced, sent to WhatsApp and recorded in the books/,
  /@gate after a failed payment the order can still be sent, and says pay on arrival/,
  /@gate an order scheduled past the closure goes through untouched/,
  /@gate switching back restores the delivery UI and hides the temporary guide/,
  // PO-15 (DELIVERY_PRICING round 23): choosing from the list, an enquiry that
  // is never paid for or recorded, a paid order told after a reload as it was
  // paid for, and a changed total that charges nothing.
  /@gate a chosen town shows its fee, and the order names the postcode and the town/,
  /@gate an enquiry for 68723 is never paid for and never recorded as an order/,
  /@gate a paid delivery is told as it was paid for: its dishes, its prices, its fee, its town/,
  /@gate when the server prices another total, nothing is charged and the guest is told to look again/
];

const report = JSON.parse(readFileSync(process.argv[2] || 'gate-results.json', 'utf8'));
const tests = [];
(function walk(suite) {
  for (const s of suite.suites || []) walk(s);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const last = t.results[t.results.length - 1] || {};
      tests.push({ title: spec.title, project: t.projectName, status: last.status || 'notrun' });
    }
  }
})(report);

const problems = [];
for (const re of REQUIRED) {
  const hits = tests.filter((t) => re.test(t.title));
  if (hits.length !== 1) problems.push(`${re.source}: ran ${hits.length} times, expected exactly once`);
  else if (hits[0].status !== 'passed') problems.push(`${hits[0].title}: ${hits[0].status}`);
}
for (const t of tests) {
  if (!REQUIRED.some((re) => re.test(t.title))) problems.push(`unexpected test in the gate: ${t.title}`);
  if (t.status !== 'passed') problems.push(`${t.title} [${t.project}]: ${t.status}`);
}

for (const t of tests) console.log(`${t.status.padEnd(8)} [${t.project}] ${t.title}`);
if (problems.length) {
  console.error('\nGATE FAILED:\n- ' + [...new Set(problems)].join('\n- '));
  process.exit(1);
}
console.log(`\ngate held: ${tests.length} of ${REQUIRED.length} ran, all passed, none skipped`);
