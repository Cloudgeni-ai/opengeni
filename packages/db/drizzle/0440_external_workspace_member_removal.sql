-- deployment-mode: rolling
-- Extend the existing fenced teardown, never replace its settlement or lock
-- protocol. Service authority is limited to external members in shared workspaces.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $patch$
DECLARE
  definition text;
  anchor text;
  replacement text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.assert_workspace_membership_removal_actor(uuid,uuid,text,text)'::regprocedure);
  anchor := '  actor_can_administer boolean;';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0440 removal declaration drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, anchor || E'\n  service_permissions jsonb;\n  service_can_administer boolean := false;');
  anchor := '  SELECT actor_is_organization_administrator OR EXISTS (';
  replacement := $service$
  IF p_actor_subject LIKE 'api_key:%' THEN
    -- The API authenticates the key before supplying this subject. This is a
    -- live consistency fence, not authentication from an arbitrary UUID.
    SELECT credential.permissions INTO service_permissions
    FROM api_keys credential
    WHERE credential.account_id = p_account_id
      AND 'api_key:' || credential.id::text = p_actor_subject
      AND credential.workspace_id IS NULL
      AND credential.credential_kind = 'organization'
      AND credential.revoked_at IS NULL
      AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
    FOR SHARE;
    service_can_administer := coalesce(
      service_permissions ?| ARRAY['workspace:admin', 'members:manage'], false
    ) AND EXISTS (
      SELECT 1 FROM organization_memberships target
      WHERE target.account_id = p_account_id
        AND target.subject_id = p_target_subject
        AND target.subject_id ~ '^external_user:[0-9a-f-]{36}$'
    );
  END IF;
  SELECT actor_is_organization_administrator OR service_can_administer OR EXISTS (
$service$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0440 removal authority drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);

  definition := pg_get_functiondef('workspace_membership_removal_command(jsonb)'::regprocedure);
  anchor := '''human'', actor_subject, ''workspace.membership.remove''';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
    OR strpos(definition, 'acquire_session_tenancy_fence') = 0 THEN
    RAISE EXCEPTION '0440 removal receipt or fence drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor,
    'CASE WHEN actor_subject LIKE ''api_key:%'' THEN ''service'' ELSE ''human'' END, actor_subject, ''workspace.membership.remove''');
END
$patch$;