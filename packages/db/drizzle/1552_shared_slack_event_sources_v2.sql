-- deployment-mode: rolling
-- One indexed lookup for the Slack event sources of the workspaces an
-- organization shares its Slack bot with.
--
-- 1538's list_shared_slack_event_sources_v1 is SECURITY INVOKER, so it can
-- read another workspace's source only by switching the RLS workspace setting
-- to that workspace: one probe per covered workspace on every Slack callback.
-- Its cost grew with the number of workspaces in the organization.
--
-- list_shared_slack_event_sources_v2 keeps every v1 check and returns the
-- same rows, but reads them in one statement over 1551's partial index
-- (account_id, external_key, workspace_id) WHERE kind = 'slack':
--
-- - It runs only in the home workspace's own RLS context (account and
--   workspace settings equal the arguments), as the callback does.
-- - It returns nothing unless the connection is the home workspace's active
--   Opengeni Slack bot, verified at its current version, and its organization
--   sharing (read_slack_bot_workspace_access) is enabled. A saved allowlist
--   limits the workspaces; without one every other workspace of the
--   organization is covered. The home workspace and other organizations are
--   never returned.
-- - It returns only the workspace, source id, status and status reason, never
--   names, secrets or settings.
--
-- event_sources is FORCE RLS, so the definer opens the owner inventory window
-- (organization_tenancy_inventory_capabilities, as 1406 does) for its own
-- statement only. The new shared_slack_event_source_read policy is for the
-- tables' owner alone and covers only the current organization's Slack rows
-- while that window is open; the runtime role gains no read. Opening the
-- window writes one row and takes a transaction id on each shared callback
-- (only when sharing is on): the price of a window the runtime can't forge.
--
-- As 0937, 0978, 1492 and 1503 explain, the previous release rejects a
-- runtime EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it, the runtime keeps calling v1.
--
-- Rolling: one owner-only policy and one read-only definer the previous
-- release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $shared_slack_event_sources_v2$
DECLARE
  data_schema text := current_schema();
  owner_name text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY shared_slack_event_source_read ON %1$I.event_sources FOR SELECT TO %2$I '
    'USING (kind = ''slack'' AND account_id = (SELECT opengeni_private.current_account_id()) '
    'AND (SELECT opengeni_private.organization_tenancy_inventory_capability_active()))',
    data_schema, owner_name
  );

  EXECUTE pg_catalog.format($create$
    CREATE FUNCTION opengeni_private.list_shared_slack_event_sources_v2(
      p_account uuid, p_home uuid, p_connection uuid, p_external_key text)
    RETURNS TABLE(workspace_id uuid, source_id uuid, status text, status_reason text)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      access record;
      opened boolean := false;
    BEGIN
      IF p_account IS NULL OR p_home IS NULL OR p_connection IS NULL OR p_external_key IS NULL
        OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_home IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN
        RAISE EXCEPTION 'Slack event source scope mismatch' USING ERRCODE = '42501';
      END IF;
      -- The same live bot list_organization_slack_bots shares, read in the
      -- home workspace's own RLS context.
      PERFORM 1 FROM connections c
        WHERE c.id = p_connection AND c.account_id = p_account AND c.workspace_id = p_home
          AND c.subject_id IS NULL AND c.kind = 'app_install' AND c.provider_domain = 'slack.com'
          AND c.metadata->>'credentialRole' = 'opengeni_slack_bot' AND c.status = 'active'
          AND c.verified_install_at IS NOT NULL AND c.verified_install_version = c.version;
      IF NOT FOUND THEN RETURN; END IF;
      SELECT shared.enabled, shared.workspace_ids INTO access
        FROM opengeni_private.read_slack_bot_workspace_access(p_account, p_home, p_connection) shared;
      IF access.enabled IS DISTINCT FROM true THEN RETURN; END IF;

      -- The owner inventory window, for this statement only. A window the
      -- caller already holds is left open.
      IF NOT opengeni_private.organization_tenancy_inventory_capability_active() THEN
        INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
          backend_pid, transaction_id
        ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id());
        opened := true;
      END IF;
      RETURN QUERY
        SELECT s.workspace_id, s.id, s.status, s.status_reason
        FROM event_sources s
        WHERE s.account_id = p_account
          AND s.kind = 'slack'
          AND s.external_key = p_external_key
          AND s.workspace_id <> p_home
          AND (access.workspace_ids IS NULL OR s.workspace_id = ANY(access.workspace_ids))
        ORDER BY s.workspace_id;
      IF opened THEN
        DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
      END IF;
    END
    $body$
  $create$, data_schema);
END
$shared_slack_event_sources_v2$;

REVOKE ALL ON FUNCTION opengeni_private.list_shared_slack_event_sources_v2(uuid, uuid, uuid, text) FROM PUBLIC;
