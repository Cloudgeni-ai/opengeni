-- deployment-mode: rolling
-- tracking-36: the strategy picker is gone — rotation-enabled always behaves as
-- sticky-sharded (worker-side effectiveRotationStrategy normalizes every read).
-- Backfill stored legacy values so the column tells the truth going forward.
-- The column itself is KEPT (old-binary rollback safety): an old worker reading
-- 'sharded' runs the strategy that was already live on every real workspace.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

UPDATE "codex_rotation_settings"
SET "rotation_strategy" = 'sharded'
WHERE "rotation_strategy" IS DISTINCT FROM 'sharded';

ALTER TABLE "codex_rotation_settings" ALTER COLUMN "rotation_strategy" SET DEFAULT 'sharded';
