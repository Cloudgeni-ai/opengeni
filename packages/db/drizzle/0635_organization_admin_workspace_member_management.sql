-- deployment-mode: rolling
-- An active organization owner or administrator may manage the members of any
-- shared workspace in their organization from that workspace's own Members
-- surface, exactly as through the organization control plane, whether or not
-- they hold an operational workspace_memberships row there. Ordinary members
-- still need their own row with members:manage or workspace:admin; Personal
-- workspaces stay owner-only (that refusal runs first and is unchanged); a
-- non-`user:` actor (API key, service, configured subject) never matches.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $patch$
DECLARE
  definition text;
  anchor text := E'  IF NOT EXISTS (\n'
    || E'    SELECT 1\n'
    || E'    FROM organization_memberships organization_membership\n'
    || E'    JOIN workspace_memberships workspace_membership\n';
  replacement text := E'  IF NOT EXISTS (\n'
    || E'    SELECT 1 FROM organization_memberships organization_administrator\n'
    || E'    WHERE organization_administrator.account_id = p_account_id\n'
    || E'      AND organization_administrator.subject_id = p_actor_subject_id\n'
    || E'      AND organization_administrator.subject_id LIKE ''user:%''\n'
    || E'      AND organization_administrator.status = ''active''\n'
    || E'      AND organization_administrator.role IN (''owner'', ''admin'')\n'
    || E'  ) AND NOT EXISTS (\n'
    || E'    SELECT 1\n'
    || E'    FROM organization_memberships organization_membership\n'
    || E'    JOIN workspace_memberships workspace_membership\n';
  target regprocedure;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'assert_workspace_member_management_candidate(uuid,uuid,text,text)'::regprocedure,
    'list_workspace_member_management_candidates(uuid,uuid,text)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(target);
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0635 workspace member management authority drift in %', target
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END LOOP;
END
$patch$;
