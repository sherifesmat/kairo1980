/* End-to-end, against the real Worker.
   `wrangler dev` serves the actual site and the actual API, so these tests
   exercise the same code that gets deployed — not a dev server standing in
   for it. Mobile first: most people order dinner from a phone. */

import { defineConfig, devices } from '@playwright/test';

const PORT = 8788;

/* Specs that write settings shared by the whole run — the ordering switch, the
   hours and the holiday band are all one row in one database. See the `switch`
   project below for why they are kept out of everything else. */
const SHARED_STATE = /(ordering-switch|holiday-band)\.spec\.js/;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: true,

  /* Capped deliberately. Every worker drives the SAME `wrangler dev` process and
     the SAME SQLite-backed D1, so parallelism past a point stops testing the
     site and starts testing contention: tests began failing one at a time, a
     different one each run, every one of them passing alone. A suite that cries
     wolf is a suite people stop reading. CI gets a smaller number still,
     because a shared runner has less to give than a desktop. */
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The site picks its language from the browser and its prices from the
    // locale. Pinning both means a test asserts "17,10 €" because that is what
    // a guest in Hockenheim sees — not because of whatever the CI box is set to.
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  },

  projects: [
    // A phone is the primary target, so it runs first and its failures are
    // the ones read first.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: SHARED_STATE },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: SHARED_STATE },

    /* The ordering switch and the opening hours are one row in one database
       shared by every test in the run. A test that closes the shop closes it
       for whatever else is mid-flight — which is not a flaky test, it is two
       tests writing the same value.

       So they run alone: last, one at a time, after every other project has
       finished. `dependencies` is what keeps them from overlapping the suites
       that assume the shop is open, and the file itself is serial so they do
       not overlap each other. */
    {
      name: 'switch',
      testMatch: SHARED_STATE,
      fullyParallel: false,
      dependencies: ['mobile', 'desktop'],
      use: { ...devices['Pixel 7'] }
    },

    // iPhone matters — it is most of the traffic a restaurant sees — but
    // Playwright's WebKit build hangs on clicks on Windows hosts, which is a
    // problem with the browser build and not with the site. So it runs on
    // Linux (that is, in CI) and is skipped on a Windows desktop, where it
    // would only ever produce false failures.
    ...(process.platform === 'win32'
      ? []
      : [{ name: 'mobile-safari', use: { ...devices['iPhone 14'] }, testIgnore: SHARED_STATE }])
  ],

  webServer: {
    // --persist-to matters: assets.directory is the repo root, so wrangler's
    // default .wrangler state lands inside the directory it is watching and
    // the dev server reloads in a loop until the runtime gives up.
    command: `npx wrangler dev --port ${PORT} --local --persist-to ../.kairo1980-dev-state`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
});
