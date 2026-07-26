-- Audit-safe compaction summary placement.
--
-- The first cut of client-side compaction (0011) inserted the synthetic summary
-- at integer position `boundaryPosition - 1`. Because history positions are
-- always contiguous from 0, that position is ALWAYS occupied by a real prefix
-- row, and the upsert overwrote that row's item JSON — destroying one real
-- history row per compaction and violating the "supersede, never delete" audit
-- guarantee (it also stranded the summary under the prefix row's old turn_id).
--
-- Fix: store the summary at a FRACTIONAL position (boundaryPosition - 0.5) that
-- sorts immediately ahead of the kept tail and collides with nothing. That
-- requires `position` to be numeric rather than integer. Normal appends keep
-- whole-number positions; only the summary uses the half-step.
--
-- Safe in place: every existing position is a whole number, so the integer ->
-- numeric widening is loss-free and the unique index is rebuilt automatically by
-- the type change. No data is rewritten beyond the column representation.
ALTER TABLE "session_history_items"
  ALTER COLUMN "position" TYPE numeric USING "position"::numeric;
