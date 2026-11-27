/* Persistence for payments. Every state change goes through here, and every
   state change writes an event, so `payments` can always be re-derived from
   `payment_events` if it ever has to be.

   The transitions are deliberately narrow. `settle()` moves a payment forward
   only from a status it is allowed to move from, in a single conditional
   UPDATE. That is the duplicate-capture guard: two requests racing to capture
   the same order both call it, exactly one changes a row, and the loser is
   told the payment is already captured rather than capturing it twice. */

const TERMINAL = ['captured', 'refunded', 'partially_refunded', 'cancelled'];

// Which statuses a target status may be reached from. Anything else is a
// no-op that reports the current state instead of overwriting it.
const ALLOWED_FROM = {
  approved: ['created'],
  // `pending` is PayPal holding a capture for review. It is not failure and it
  // is not money: the guest is told to expect a decision, and the webhook
  // resolves it either way.
  pending: ['created', 'approved', 'failed', 'cancelled'],
  /* Money the provider reports is recorded whatever this server said before
     it. A capture that lands after a cancel, or after a capture call whose
     answer was lost, is the guest's money and must reach the books and the
     kitchen, never be discarded as an illegal move (DP-25-01). */
  captured: ['created', 'approved', 'pending', 'failed', 'cancelled'],
  failed: ['created', 'approved', 'pending'],
  cancelled: ['created', 'approved', 'pending'],
  refunded: ['captured', 'partially_refunded'],
  partially_refunded: ['captured', 'partially_refunded']
};

const now = () => new Date().toISOString();

/* Crockford base32 without the letters that get misread down a phone line.
   Six characters is ~1 in a billion for the volume one restaurant does, and
   it has to be readable aloud when a guest rings up about an order. */
const ALPHABET = '0123456789ACDEFGHJKLMNPQRTUVWXYZ';
export function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function create(db, payment) {
  const ts = now();
  await db.prepare(
    `INSERT INTO payments (id, reference, provider, provider_order_id, status,
       amount, currency, subtotal, discount, fee, order_type, business, postcode,
       lines, created_at, updated_at, town)
     VALUES (?1,?2,?3,?4,'created',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?15)`
  ).bind(
    payment.id, payment.reference, payment.provider, payment.providerOrderId,
    payment.amount, payment.currency, payment.subtotal, payment.discount, payment.fee,
    payment.orderType, payment.business ? 1 : 0, payment.postcode || null,
    JSON.stringify(payment.lines), ts, payment.town || null
  ).run();

  await logEvent(db, {
    paymentId: payment.id,
    provider: payment.provider,
    eventKey: payment.provider + ':created:' + payment.id,
    eventType: 'payment.created',
    source: 'api',
    statusTo: 'created',
    amount: payment.amount,
    payload: { providerOrderId: payment.providerOrderId }
  });

  return get(db, payment.id);
}

export function get(db, id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?1').bind(id).first();
}

export function getByProviderOrder(db, provider, providerOrderId) {
  return db.prepare(
    'SELECT * FROM payments WHERE provider = ?1 AND provider_order_id = ?2'
  ).bind(provider, providerOrderId).first();
}

/**
 * Move a payment to `status`, but only from a status it may legally come from.
 * Returns { changed, payment }. `changed: false` means somebody got there
 * first — which is a success for the caller, not an error.
 */
export async function settle(db, id, status, fields = {}) {
  const before = await get(db, id);
  if (!before) return { changed: false, payment: null };

  // A caller may narrow where it moves from. The one widening is evidence that
  // money was taken (a capture for the wrong amount): it overrides an earlier
  // "no money" label, so the payment goes to a person instead of staying "none".
  const from = (ALLOWED_FROM[status] || []).filter((s) => !fields.from || fields.from.includes(s))
    .concat(fields.moneyTaken ? ['failed', 'cancelled'] : []);
  const ts = now();

  const set = ['status = ?2', 'updated_at = ?3'];
  const binds = [id, status, ts];
  const put = (column, value) => {
    if (value === undefined || value === null) return;
    binds.push(value);
    set.push(`${column} = ?${binds.length}`);
  };

  put('provider_order_id', fields.providerOrderId);
  put('authorization_id', fields.authorizationId);
  put('capture_id', fields.captureId);
  put('payment_source', fields.paymentSource);
  put('payer_email', fields.payerEmail);
  put('payer_id', fields.payerId);
  put('failure_code', fields.failureCode);
  put('failure_message', fields.failureMessage);
  if (fields.refundedAmount != null) put('refunded_amount', fields.refundedAmount);
  if (status === 'captured') { binds.push(ts); set.push(`captured_at = ?${binds.length}`); }

  const placeholders = from.map((_, i) => `?${binds.length + i + 1}`).join(',');
  /* `inFlight`: written only while no more captures are on their way than the
     caller's own (0, or 1 from inside an admitted capture). A decline beside
     another capture in flight is not "no money" (DP-26-01). */
  const alone = Number.isInteger(fields.inFlight) ? ` AND captures_in_flight <= ${fields.inFlight}` : '';
  const result = await db.prepare(
    `UPDATE payments SET ${set.join(', ')}
      WHERE id = ?1 AND status IN (${placeholders || "''"})${alone}`
  ).bind(...binds, ...from).run();

  const changed = (result.meta?.changes || 0) > 0;
  if (changed) {
    await logEvent(db, {
      paymentId: id,
      provider: before.provider,
      eventKey: fields.eventKey || `${before.provider}:${status}:${id}:${ts}`,
      eventType: 'payment.' + status,
      source: fields.source || 'api',
      statusFrom: before.status,
      statusTo: status,
      amount: fields.amount != null ? fields.amount : before.amount,
      payload: fields.payload
    });
  }

  return { changed, payment: await get(db, id) };
}

/** Insert an event. A duplicate event_key is the point of the table, not a
 *  failure: it returns false so a replayed webhook does no work twice. */
export async function logEvent(db, event) {
  try {
    await db.prepare(
      `INSERT INTO payment_events (payment_id, provider, event_key, event_type,
         source, status_from, status_to, amount, payload, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
    ).bind(
      event.paymentId || null, event.provider, event.eventKey, event.eventType,
      event.source, event.statusFrom || null, event.statusTo || null,
      event.amount != null ? event.amount : null,
      event.payload ? JSON.stringify(event.payload).slice(0, 20000) : null,
      now()
    ).run();
    return true;
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

/* What a payment means for the guest's money (DP-25-01). The status alone does
   not say it: `failed` and `cancelled` were once written for a lost answer or a
   closed window, which is not the provider saying nothing was taken. So "no
   money" is only a status AND a reason that establish it:

     money   captured, or pending at the provider: the money is (being) taken
     open    created or approved: it may still be taken
     none    the provider declined or voided it, or the guest abandoned one the
             provider still showed unapproved, after which nothing here will
             ever capture it (the capture route, the webhook and the sweep all
             move only created or approved payments)
     manual  anything else: a refund, an amount that did not match, a failure
             nobody classified. A person looks; the guest is told by reference.

   The reasons are kept as written, so a payment recorded before this existed
   is judged by what was actually known about it. */
/* A refusal the provider made of the instrument or the payer. Deliberately NOT
   here: ORDER_NOT_APPROVED and PAYER_ACTION_REQUIRED, which say only "not yet"
   and can be followed by an approval and a capture (DP-26-01). They leave a
   payment open. */
export const DECLINE_ISSUES = [
  'INSTRUMENT_DECLINED', 'TRANSACTION_REFUSED', 'PAYER_CANNOT_PAY',
  'PAYER_ACCOUNT_RESTRICTED', 'PAYER_ACCOUNT_LOCKED_OR_CLOSED', 'PAYEE_ACCOUNT_RESTRICTED',
  'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED', 'CARD_EXPIRED', 'COMPLIANCE_VIOLATION'
];
export const NO_CHARGE_CODES = [
  'DECLINED', 'VOIDED', 'PAYMENT.CAPTURE.DENIED', 'CHECKOUT.ORDER.VOIDED',
  'abandoned_unapproved', ...DECLINE_ISSUES
];

export function moneyState(payment) {
  if (!payment) return 'manual';
  const s = payment.status;
  if (s === 'captured' || s === 'pending') return 'money';
  if (s === 'created' || s === 'approved') return 'open';
  if ((s === 'failed' || s === 'cancelled') && NO_CHARGE_CODES.includes(payment.failure_code)) return 'none';
  return 'manual';
}

/* The same rule, as SQL over a `payments` row, for statements that must decide
   in the database (the claim insert). Kept beside the function it mirrors. */
/* COALESCE, because `NULL IN (...)` is NULL, NOT NULL is NULL too, and a NULL
   inside NOT EXISTS would let a claim through beside a payment with no reason.
   `status` is NOT NULL (0001), so with the reason made total the predicate is
   always true or false, never unknown (DP-26-01). */
export const NO_CHARGE_SQL = `(status IN ('failed','cancelled') AND COALESCE(failure_code, '') IN (${
  NO_CHARGE_CODES.map((c) => `'${c}'`).join(',')}))`;

/* Capture admission (DP-26-01). Every caller that is about to ask the provider
   to capture (the page, the approved webhook, the sweep) is admitted here
   first, by a conditional UPDATE: only a created or approved payment is
   admitted, `created` becomes `approved` in the same statement, and the count
   of captures on their way goes up. A cancel moves only `created`, so a cancel
   and an admission can never both win, whichever read what first. Not
   admitted means: do not call the provider. */
export async function admitCapture(db, id, source) {
  const ts = now();
  const fresh = await db.prepare(
    `UPDATE payments SET status = 'approved', updated_at = ?2, captures_in_flight = captures_in_flight + 1
      WHERE id = ?1 AND status = 'created'`
  ).bind(id, ts).run();
  if ((fresh.meta?.changes || 0) > 0) {
    const row = await get(db, id);
    await logEvent(db, {
      paymentId: id, provider: row.provider,
      eventKey: `${row.provider}:approved:${id}:${ts}`, eventType: 'payment.approved',
      source: source || 'api', statusFrom: 'created', statusTo: 'approved', amount: row.amount,
      payload: { capture: 'admitted' }
    });
    return true;
  }
  const again = await db.prepare(
    `UPDATE payments SET captures_in_flight = captures_in_flight + 1
      WHERE id = ?1 AND status = 'approved'`
  ).bind(id).run();
  return (again.meta?.changes || 0) > 0;
}

/** The admitted capture has returned, however it returned. */
export async function releaseCapture(db, id) {
  await db.prepare(
    'UPDATE payments SET captures_in_flight = MAX(captures_in_flight - 1, 0) WHERE id = ?1'
  ).bind(id).run();
}

export function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** What the browser is allowed to know about a payment. No provider payloads,
 *  no payer identifiers — only what the guest needs to see their own order. */
export function publicView(payment) {
  if (!payment) return null;
  return {
    id: payment.id,
    reference: payment.reference,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    orderType: payment.order_type,
    refunded: payment.refunded_amount,
    capturedAt: payment.captured_at,
    failureCode: payment.failure_code,
    // The one field the page decides by: see moneyState.
    money: moneyState(payment),
    final: isTerminal(payment.status)
  };
}
