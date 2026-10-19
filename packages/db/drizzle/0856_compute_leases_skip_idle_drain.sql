-- deployment-mode: rolling
-- A compute sandbox is never drained for being idle.
--
-- Opengeni compute sleeps an idle sandbox itself and keeps its memory
-- and disk, so its lease stays warm with no holders: draining it would capture
-- and delete a sandbox that costs nothing to keep and resumes exactly. The
-- global reaper's idle transition (warm with no holders -> draining) now skips
-- compute leases, unless a rotation or an archive capture already asks for a
-- teardown. A compute lease drains when its group ends (session or workspace
-- deletion requests it) or rotates.
--
-- The previous release never creates compute leases, so it is unaffected.

DO $compute_idle_drain$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure
  );
  anchor text := 'AND counts.turns = 0';
  replacement text := 'AND counts.turns = 0'
    || E'\n            AND (lease.backend <> ''compute'''
    || ' OR lease.rotation_requested_at IS NOT NULL'
    || ' OR lease.archive_capture_id IS NOT NULL)';
BEGIN
  IF strpos(definition, 'lease.backend <> ''compute''') > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 2 THEN
    RAISE EXCEPTION '0856 compute idle drain prerequisite drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END;
$compute_idle_drain$;
