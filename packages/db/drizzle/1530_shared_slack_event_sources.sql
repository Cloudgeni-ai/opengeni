-- deployment-mode: rolling
-- The Slack event sources of the workspaces an organization shares its Slack
-- bot with, so a verified Slack callback reaches their automations too.
--
-- An organization administrator can share the Opengeni Slack bot installed in
-- one workspace (its home) with selected or all workspaces of the organization
-- (opengeni_private.organization_slack_bot_access). Slack routes every
-- callback to the home installation, so until now only the home workspace's
-- Slack source recorded events.
--
-- list_shared_slack_event_sources_v1 runs in the home workspace's RLS
-- context, as the callback does. It returns nothing unless the home bot is
-- still the active, verified install and its sharing is enabled; then, for
-- each other workspace of the organization the live sharing covers (all, or
-- the saved allowlist), it reads that workspace's Slack source for the team
-- under that workspace's own RLS context and restores the caller's workspace
-- setting, as list_organization_slack_bots (0977) and 1475 do. One call per
-- callback, an index probe per workspace (event_sources_app_uq).
--
-- It is SECURITY INVOKER: it reads only what the runtime could read by
-- setting each workspace's context itself, and the sharing row only through
-- the existing read_slack_bot_workspace_access definer. So, unlike a new
-- definer, it is granted to the runtime here, as 1515 grants its invoker.
--
-- Rolling: one read-only routine the previous release never calls.
SET LOCAL lock_timeout = '5s';

DO $shared_slack_event_sources$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($create$
    CREATE FUNCTION opengeni_private.list_shared_slack_event_sources_v1(
      p_account uuid, p_home uuid, p_connection uuid, p_external_key text)
    RETURNS TABLE(workspace_id uuid, source_id uuid)
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      access record;
      target record;
      prior_workspace text;
    BEGIN
      IF p_account IS NULL OR p_home IS NULL OR p_connection IS NULL OR p_external_key IS NULL
        OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_home IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN
        RAISE EXCEPTION 'Slack event source scope mismatch' USING ERRCODE = '42501';
      END IF;
      -- The same live bot list_organization_slack_bots shares.
      PERFORM 1 FROM connections c
        WHERE c.id = p_connection AND c.account_id = p_account AND c.workspace_id = p_home
          AND c.subject_id IS NULL AND c.kind = 'app_install' AND c.provider_domain = 'slack.com'
          AND c.metadata->>'credentialRole' = 'opengeni_slack_bot' AND c.status = 'active'
          AND c.verified_install_at IS NOT NULL AND c.verified_install_version = c.version;
      IF NOT FOUND THEN RETURN; END IF;
      SELECT shared.enabled, shared.workspace_ids INTO access
        FROM opengeni_private.read_slack_bot_workspace_access(p_account, p_home, p_connection) shared;
      IF access.enabled IS DISTINCT FROM true THEN RETURN; END IF;
      prior_workspace := pg_catalog.current_setting('opengeni.workspace_id', true);
      FOR target IN
        SELECT w.id FROM workspaces w
        WHERE w.account_id = p_account AND w.id <> p_home
          AND (access.workspace_ids IS NULL OR w.id = ANY(access.workspace_ids))
        ORDER BY w.id
      LOOP
        PERFORM pg_catalog.set_config('opengeni.workspace_id', target.id::text, true);
        RETURN QUERY SELECT s.workspace_id, s.id FROM event_sources s
          WHERE s.workspace_id = target.id AND s.account_id = p_account
            AND s.kind = 'slack' AND s.external_key = p_external_key;
      END LOOP;
      PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
    END
    $body$
  $create$, data_schema);
  EXECUTE 'REVOKE ALL ON FUNCTION opengeni_private.list_shared_slack_event_sources_v1(uuid, uuid, uuid, text) FROM PUBLIC';
END
$shared_slack_event_sources$;

-- Every configured application role executes the invoker routine, as
-- provisioning grants every opengeni_private routine.
DO $shared_slack_event_sources_runtime_grant$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.list_shared_slack_event_sources_v1(uuid, uuid, uuid, text) TO %I',
      application_role
    );
  END LOOP;
END $shared_slack_event_sources_runtime_grant$;
