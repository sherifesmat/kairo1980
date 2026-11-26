/* The Worker as a page in step with it calls it.
   ---------------------------------------------------------------------------
   Since DELIVERY_PRICING G5 / DP-22-03 a payment is started only for the total
   the page showed (`expectedTotal`, cents), and a request without one is asked
   to reload. A real page shows the server's own quote, so this wrapper does what
   the page does: before creating a payment it asks the quote route and sends that
   total. A body that already names a total is sent untouched.

   It is for the tests about everything ELSE a payment does (capture, webhooks,
   abuse, linking). The shown-total contract itself (missing, stale, malformed)
   is tested against the bare Worker in listed-delivery.test.js. */

import worker from '../../worker/index.js';

async function withShownTotal(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/api/payments') return request;
  let body;
  try { body = await request.clone().json(); } catch { return request; }
  if (!body || typeof body !== 'object' || 'expectedTotal' in body) return request;

  const quoted = await worker.fetch(new Request(new URL('/api/payments/quote', url).href, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), env, ctx);
  if (!quoted.ok) return request;
  const { total } = await quoted.json();
  if (!Number.isSafeInteger(total)) return request;
  return new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ ...body, expectedTotal: total })
  });
}

export default {
  async fetch(request, env, ctx) {
    return worker.fetch(await withShownTotal(request, env, ctx), env, ctx);
  },
  scheduled: (...args) => worker.scheduled(...args)
};
