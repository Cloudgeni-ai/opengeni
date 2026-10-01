-- deployment-mode: rolling
-- SECURITY DEFINER still obeys FORCE RLS under the non-bypass migration owner.
-- Both native removal passes read organization_memberships (including the
-- external service target, Personal-workspace exclusion and teardown owner).
-- 0440 added the service check without opening the existing owner-only
-- organization_membership_lifecycle policy, so it silently saw no target.
-- They also omitted 0345's owner-only fenced-access capability, hiding private
-- sessions from preparation/teardown even while the workspace fence was held.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Open the existing FOR ALL policy before every read, including the command's
-- locking reads, and restore the caller's marker on every return and exception.
-- Scope the whole native pass, not just its actor assertion: otherwise teardown
-- would still miss the target membership and organization-user resource grants.
-- Open the existing schema/backend/xact-scoped fenced-access capability too:
-- its policies still require the workspace's held advisory fence. Close only
-- this invocation's token on each exit, preserving any outer capability.
-- Preserve the 0345/0498 fences, settlement protocol, search paths and ACLs.
-- No table posture, policy, ownership or application privilege is widened.
DO $repair$
DECLARE
  routine text;
  definition text;
  anchor text;
  return_count integer;
  expected_returns integer;
  restore_marker text := $restore$PERFORM opengeni_private.close_session_tenancy_fenced_access(removal_fenced_access_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_membership_lifecycle, ''), true
  );$restore$;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'prepare_workspace_membership_removal_settlements',
    'workspace_membership_removal_command'
  ] LOOP
    definition := pg_catalog.pg_get_functiondef(
      pg_catalog.format('%I.%I(jsonb)', current_schema(), routine)::regprocedure
    );
    expected_returns := CASE WHEN routine = 'workspace_membership_removal_command' THEN 2 ELSE 1 END;
    SELECT count(*) INTO return_count FROM regexp_matches(definition, E'\n[ \t]*RETURN ', 'g');
    IF return_count <> expected_returns THEN
      RAISE EXCEPTION '0558 removal return drift: %', routine USING ERRCODE = '55000';
    END IF;
    -- The runner records ordinary migration receipts after the SQL transaction.
    -- A crash in that gap must be recoverable without inserting scopes twice.
    IF strpos(definition, 'previous_membership_lifecycle') > 0
      OR strpos(definition, 'removal_fenced_access_id') > 0
    THEN
      IF strpos(definition, 'previous_membership_lifecycle text := pg_catalog.current_setting(''opengeni.organization_tenancy_lifecycle'', true);') = 0
        OR strpos(definition, 'removal_fenced_access_id uuid;') = 0
        OR strpos(definition, 'removal_fenced_access_id := opengeni_private.open_session_tenancy_fenced_access(session_tenancy_fence_target_schema());') = 0
        OR (length(definition) - length(replace(definition, restore_marker, ''))) / length(restore_marker) <> expected_returns + 1
      THEN
        RAISE EXCEPTION '0558 removal scope drift: %', routine USING ERRCODE = '55000';
      END IF;
      CONTINUE;
    END IF;
    anchor := E'\nDECLARE\n';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0558 removal declaration drift: %', routine USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, anchor || $declaration$
  previous_membership_lifecycle text := pg_catalog.current_setting('opengeni.organization_tenancy_lifecycle', true);
  removal_fenced_access_id uuid;
$declaration$);
    anchor := E'\nBEGIN\n';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0558 removal entry drift: %', routine USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, anchor || $open$
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  removal_fenced_access_id := opengeni_private.open_session_tenancy_fenced_access(session_tenancy_fence_target_schema());
$open$);
    definition := regexp_replace(definition, E'\n([ \t]*)RETURN ',
      E'\n\\1' || restore_marker || E'\n\\1RETURN ', 'g');
    anchor := E'\n  RAISE;\nEND';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0558 removal exception drift: %', routine USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, E'\n  ' || restore_marker || anchor);
    EXECUTE definition;
  END LOOP;
END
$repair$;