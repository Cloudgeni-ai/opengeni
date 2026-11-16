-- deployment-mode: rolling
-- Viewer-only idle drain (docs/run-lifecycle.md, "Boxes held only by
-- viewers"). When the reaper releases a box's viewers because nobody used the
-- page for the idle window, it records the time here. A later viewer attach
-- that does not report newer interaction (an unattended page or an old client
-- re-attaching on its own) is refused until a person interacts with the page
-- or a turn runs, so an unattended page cannot reset the idle clock by
-- re-attaching.
--
-- Rolling: one nullable column, no default, no backfill. The previous release
-- never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE sandbox_leases
  ADD COLUMN viewer_idle_drained_at timestamptz;

COMMENT ON COLUMN sandbox_leases.viewer_idle_drained_at IS
  'When the reaper last released this box''s viewers for the viewer idle window; a viewer attach without newer interaction is refused until the session is used again.';
