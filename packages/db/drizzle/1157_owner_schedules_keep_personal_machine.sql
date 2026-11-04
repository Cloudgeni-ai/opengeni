-- deployment-mode: rolling
-- A schedule runs as its owner, so it may use its owner's personal machine
-- whoever can see it (docs/design/ownership-and-reach.md, rule 9). When a
-- machine becomes someone's Only me machine, that person's schedules on it
-- now keep running with no change, Only me or shared, in any workspace.
-- Before, their shared schedules there became Only me, or paused when they
-- could not have Only me schedules. Everyone else's schedules still pause.
--
-- Only the schedule branch of connected_machine_audience_inventory changes;
-- the preview and the change both read it. p_schedules_may_be_only_me is no
-- longer read and stays only so the signature, and the previous release's
-- calls, are unchanged.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  anchor text := $a$    IF schedule.workspace_id <> p_workspace_id THEN
      relation := 'other_workspace';
      action := 'pause';
    ELSIF p_target_scope = 'workspace' THEN
      CONTINUE;
    ELSIF schedule.owner_subject_id = owner_row.subject_id
      AND schedule.visibility = 'user_private'
    THEN
      -- The new owner's Only me schedules keep running with no change.
      CONTINUE;
    ELSIF schedule.owner_subject_id = owner_row.subject_id THEN
      relation := 'owner_shared';
      action := CASE WHEN coalesce(p_schedules_may_be_only_me, false)
        THEN 'make_only_me' ELSE 'pause' END;
    ELSE$a$;
  replacement text := $a$    IF p_target_scope = 'user'
      AND schedule.owner_subject_id = owner_row.subject_id
    THEN
      -- A schedule runs as its owner: the new owner's schedules keep running
      -- with no change, Only me or shared, in any workspace.
      CONTINUE;
    ELSIF schedule.workspace_id <> p_workspace_id THEN
      relation := 'other_workspace';
      action := 'pause';
    ELSIF p_target_scope = 'workspace' THEN
      CONTINUE;
    ELSE$a$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.%s', pg_catalog.current_schema(),
    'connected_machine_audience_inventory(uuid, uuid, uuid, text, text, boolean)')::regprocedure);
  IF strpos(definition, replacement) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1157 connected machine audience inventory drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$migration$;
