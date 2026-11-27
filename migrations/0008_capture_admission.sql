-- How many capture calls for a payment are on their way to the provider right
-- now (KBOSS loop DELIVERY_PRICING, DP-26-01).
--
-- Every caller that captures (the page, the approved webhook, the sweep) is
-- first ADMITTED by one conditional UPDATE that raises this count and only
-- succeeds while the payment is created or approved; it is lowered again when
-- the call returns, however it returns. Two things depend on it:
--   - a cancel moves only a payment that is still `created`, and admission moves
--     `created` to `approved` in the same statement, so the two can never both
--     win;
--   - a decline is recorded as "no money" only while it is the ONLY capture on
--     its way. With another one in flight the payment stays open, because the
--     other may still take the money.
--
-- Additive, with a default: every existing row reads 0, which is the truth for
-- a payment nobody is capturing.

ALTER TABLE payments ADD COLUMN captures_in_flight INTEGER NOT NULL DEFAULT 0;
