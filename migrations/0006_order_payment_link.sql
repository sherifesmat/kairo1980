-- An order names a payment only when the payment is real, settled or settling,
-- and for exactly this basket. Loop WEBSITE_ORDERING (KBOSS), W01-05 / W02-03 / W02-04.
--
-- Until now /api/orders/announce trusted any `paymentId` string the browser sent:
-- the order was stored as paid online and the restaurant's alert was suppressed,
-- whether or not that payment existed, had taken any money, or was for this food.
--
-- `payment_id` now holds only a VERIFIED link: the payment row exists, it is
-- `captured` or `pending`, and its server-priced lines and amounts equal the
-- order's. Anything else the browser claimed is kept in `claimed_payment_id`,
-- with `payment_check = 'unverified'`, so a person can resolve it by hand. Such an
-- order is never shown as paid and is always announced.
--
-- One payment pays for one order. The unique index makes a second row for the
-- same payment impossible even under a race; the Worker answers a replay with
-- the order already stored. Checked before writing this (23.11.2026, production
-- orders report): 14 online orders, 14 distinct payments — no existing duplicate.

ALTER TABLE orders ADD COLUMN claimed_payment_id TEXT;
ALTER TABLE orders ADD COLUMN payment_check TEXT;     -- NULL | 'unverified'

DROP INDEX IF EXISTS idx_orders_payment;
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_payment
  ON orders (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_claimed_payment ON orders (claimed_payment_id);
