-- deployment-mode: rolling
-- Compatibility checkpoint, intentionally no table locks or data backfill.
-- Previous-release readers only understand free/credits/unlimited/custom.
-- Keep those stored kinds and overrides unchanged. New writers encode standard
-- as free; new readers normalize free and legacy custom defaults on every request.
-- Explicit new overrides carry __siteLimitsVersion: 2 (ignored by old parsers),
-- distinguishing intentional owner values from the old prefilled defaults.
-- Existing Sites therefore adopt the new defaults without republishing, without
-- a whole-table rewrite, and without breaking old readers or old-pod writes.
SELECT 1;
