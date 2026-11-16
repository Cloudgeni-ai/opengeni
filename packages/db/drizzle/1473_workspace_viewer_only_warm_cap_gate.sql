-- deployment-mode: rolling
-- Per-account cap on warm boxes held only by viewers (docs/run-lifecycle.md,
-- "Boxes held only by viewers"). The reaper counts, per account across all
-- its workspaces, warm boxes whose only holders are viewers. While an account
-- is at the cap it stamps each of its workspaces that has such a box with a
-- short expiry here, and a viewer attach that would warm another viewer-only
-- box in that workspace is refused until the stamp expires. The stamp expires
-- by itself, so a stopped reaper or a lower count never leaves a workspace
-- gated.
--
-- Rolling: one nullable column, no default, no backfill. The previous release
-- never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE workspaces
  ADD COLUMN sandbox_viewer_only_cap_until timestamptz;

COMMENT ON COLUMN workspaces.sandbox_viewer_only_cap_until IS
  'Until this time, a viewer attach that would warm another box held only by viewers is refused: the account was at its viewer-only warm box cap.';
