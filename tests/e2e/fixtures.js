/* What a test needs from the disposable local stack, and nothing else.
   Loop WEBSITE_ORDERING (KBOSS), W01-04 / W02-02.

   Everything here acts on the LOCAL D1 that `wrangler dev --persist-to
   ../.kairo1980-dev-state` serves — never on production. The admin login and the
   report token are read from `.dev.vars`, the file wrangler itself reads, so a
   test and the server can never disagree about them. That file is gitignored;
   CI writes its own with throwaway values. */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:8788';

export function devVars() {
  let text = '';
  try { text = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8'); } catch { /* none */ }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return vars;
}

export async function signIn(page) {
  const v = devVars();
  const res = await page.request.post('/admin/login', {
    headers: { Origin: ORIGIN },
    form: { username: v.ADMIN_USER || 'devuser', password: v.ADMIN_PASSWORD || 'dev-password-not-a-real-one' }
  });
  expect(res.ok(), 'the disposable admin signs in').toBeTruthy();
}

export async function setServiceMode(page, mode) {
  const res = await page.request.post('/admin/service-mode', { headers: { Origin: ORIGIN }, form: { mode } });
  expect(res.ok()).toBeTruthy();
}

/** Empties the per-address announce counter. Every test announces from
 *  127.0.0.1, so a full run reaches the limit of ten in ten minutes and the
 *  Worker answers 202. Called ONLY from the serial persistence specs, never
 *  from a parallel one, so no other test's counting is disturbed. */
export function resetOrderRate() {
  // wrangler's own entry point through this node, so no shell splits the SQL.
  const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  execFileSync(process.execPath, [
    wrangler, 'd1', 'execute', 'kairo1980-payments', '--local',
    '--persist-to', '../.kairo1980-dev-state', '--command', 'DELETE FROM order_rate'
  ], { stdio: 'ignore', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
}

/** Today's orders as the restaurant's books read them: the same report KBOSS
 *  imports, bounded to the Berlin day. */
export async function reportedOrders(page) {
  const token = devVars().REPORT_TOKEN;
  expect(token, '.dev.vars must carry a disposable REPORT_TOKEN').toBeTruthy();
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  const res = await page.request.get(`/api/reports/orders?from=${day}&to=${day}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  expect(res.status()).toBe(200);
  return (await res.json()).orders;
}

/** The price the page itself carries for a dish, in cents. */
export async function centsOf(page, id) {
  const v = await page.locator(`.mitem[data-item="${id}"]`).first().getAttribute('data-price');
  return Math.round(Number(v) * 100);
}

export const euro = (cents) => (cents / 100).toFixed(2).replace('.', ',');

/** Watches the next announce on its way to the REAL Worker and back. It is a
 *  pass-through, not a stub: route.fetch() sends the page's own request to
 *  wrangler dev and the page receives the Worker's own answer. Reading it here
 *  avoids Playwright's unreadable bodies on a fire-and-forget request. */
export async function observeAnnounce(page, { ip = null } = {}) {
  let resolve;
  const seen = new Promise((r) => { resolve = r; });
  await page.route('**/api/orders/announce', async (route) => {
    const request = route.request().postDataJSON();
    // In production Cloudflare stamps every request with the client address;
    // wrangler dev does not stamp the browser's. A test about the per-address
    // throttle supplies it, exactly as the edge would.
    const response = await route.fetch(ip
      ? { headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }
      : undefined);
    const text = await response.text();
    resolve({ status: response.status(), request, body: JSON.parse(text) });
    await route.fulfill({ response, body: text });
  });
  return () => seen;
}
