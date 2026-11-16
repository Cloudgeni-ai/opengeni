-- deployment-mode: rolling
-- Viewer-only idle drain (docs/run-lifecycle.md, "Boxes held only by
-- viewers"). A viewer holder (an open session page) keeps its box warm for as
-- long as its heartbeats arrive, however long the person has been away. The
-- web client now reports on each heartbeat how long ago the person last
-- interacted with the page; the API records that time here. The reaper drains
-- a box held only by viewers once none of them reported interaction (or was
-- attached) within the idle window and its sessions had no message or turn.
--
-- Null for every existing row and for clients that do not report it; the
-- reaper then falls back to the attach time and session activity.
--
-- Rolling: one nullable column, no default, no backfill. The previous release
-- never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE sandbox_lease_holders
  ADD COLUMN last_interaction_at timestamptz;

COMMENT ON COLUMN sandbox_lease_holders.last_interaction_at IS
  'Viewer holders only: the last real user interaction the viewer reported on a heartbeat; null when never reported.';
