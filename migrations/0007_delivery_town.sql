-- A delivery goes to a postcode AND a town, chosen from the list (PO-15).
-- KBOSS loop DELIVERY_PRICING, rounds 20-21 (DP-21-03 / DP-21-04).
--
-- The postcode alone does not say where an order goes: 68723 is Schwetzingen,
-- Plankstadt and Oftersheim. From this migration on, every new delivery payment
-- and order stores the town the guest chose beside the postcode, and the order
-- report hands both to KBOSS.
--
-- Additive and nullable. A payment or order from before it keeps NULL here and
-- its postcode exactly as it was typed ("68799 Reilingen"); nothing is rewritten,
-- and no town is ever inferred for it. The Worker reads such old rows by their
-- recoverable postcode only (postcode.js legacyCode) and never treats two values
-- without a postcode as the same place.

ALTER TABLE payments ADD COLUMN town TEXT;
ALTER TABLE orders ADD COLUMN town TEXT;
