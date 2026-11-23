-- An order names a payment only when that payment is real, settled or settling,
-- and for exactly this basket. Loop WEBSITE_ORDERING (KBOSS): W01-05 / W02-03 /
-- W02-04 / R3-01..R3-03.
--
-- Until now /api/orders/announce trusted any `paymentId` string the browser sent.
-- The order was stored as paid online and the restaurant's alert was suppressed,
-- whether or not that payment existed, had taken any money, or was for this food.
--
-- `payment_id` now holds only a VERIFIED link:
--   * the payment row exists;
--   * it is `captured` or `pending`;
--   * its server-priced lines, amounts, type, company flag and (for a delivery)
--     postcode equal the order's.
--
-- Anything else the browser claimed is kept in `claimed_payment_id`, with
-- `payment_check = 'unverified'`, so a person can resolve it by hand. Such an
-- order is never shown as paid and is always announced.
--
-- `order_identity` is the order as the guest built it: dish keys with their
-- quantities, the type, the company flag and the delivery postcode. It is how a
-- REPLAY is told from a NEW order under the same payment id.
--
-- Two partial unique indexes make duplicates impossible even under a race:
--   * one verified payment pays for one order;
--   * one claim of one payment for one identical order is stored once.
-- A different order that names the same payment id is still stored as a new,
-- flagged order.
--
-- Checked against production before writing this (23.11.2026, orders report):
-- 14 online orders, 14 distinct payments, so there is no existing duplicate.
-- The preflight must be re-run on the real `payment_id` column just before
-- deploying.

ALTER TABLE orders ADD COLUMN claimed_payment_id TEXT;
ALTER TABLE orders ADD COLUMN payment_check TEXT;     -- NULL | 'unverified'
ALTER TABLE orders ADD COLUMN order_identity TEXT;    -- NULL for orders stored before 0006

DROP INDEX IF EXISTS idx_orders_payment;
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_payment
  ON orders (payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_claim
  ON orders (claimed_payment_id, order_identity) WHERE claimed_payment_id IS NOT NULL;
