-- deployment-mode: rolling
-- Explicit organization sharing of a verified bot installation. Personal OAuth
-- grants stay workspace/user-owned. Storage remains private and capability-only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.organization_slack_bot_access (
  connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  home_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  updated_by_subject_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opengeni_private.organization_slack_bot_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.organization_slack_bot_access FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON opengeni_private.organization_slack_bot_access
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());

CREATE FUNCTION opengeni_private.read_organization_slack_bot_access(p_account uuid, p_home uuid, p_connection uuid)
RETURNS TABLE(enabled boolean, generation bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS NULL OR p_home IS NULL OR p_connection IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_home IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'Slack bot sharing scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM connections c WHERE c.id = p_connection AND c.account_id = p_account
    AND c.workspace_id = p_home AND c.subject_id IS NULL AND c.kind = 'app_install'
    AND c.provider_domain = 'slack.com' AND c.metadata->>'credentialRole' = 'opengeni_slack_bot';
  IF NOT FOUND THEN RAISE EXCEPTION 'Local Slack bot unavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT coalesce(a.enabled, false), coalesce(a.generation, 0::bigint)
    FROM (SELECT 1) singleton LEFT JOIN opengeni_private.organization_slack_bot_access a
      ON a.connection_id = p_connection AND a.account_id = p_account AND a.home_workspace_id = p_home;
END $body$;

CREATE FUNCTION opengeni_private.set_organization_slack_bot_access(
  p_account uuid, p_home uuid, p_connection uuid, p_subject text, p_enabled boolean
) RETURNS TABLE(enabled boolean, generation bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_home IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_subject IS DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
    OR p_account IS NULL OR p_home IS NULL OR p_connection IS NULL OR p_subject IS NULL OR p_enabled IS NULL
  THEN RAISE EXCEPTION 'Slack bot sharing scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM opengeni_private.assert_organization_integration_policy_administrator(p_account, p_subject);
  PERFORM 1 FROM connections c WHERE c.id = p_connection AND c.account_id = p_account
    AND c.workspace_id = p_home AND c.subject_id IS NULL AND c.kind = 'app_install'
    AND c.provider_domain = 'slack.com' AND c.metadata->>'credentialRole' = 'opengeni_slack_bot'
    AND (NOT p_enabled OR (c.status = 'active' AND c.verified_install_at IS NOT NULL AND c.verified_install_version = c.version));
  IF NOT FOUND THEN RAISE EXCEPTION 'Verified Slack bot unavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY INSERT INTO opengeni_private.organization_slack_bot_access AS access
    (connection_id, account_id, home_workspace_id, enabled, generation, updated_by_subject_id)
    VALUES(p_connection, p_account, p_home, p_enabled, 1, p_subject)
    ON CONFLICT(connection_id) DO UPDATE SET enabled = excluded.enabled,
      generation = access.generation + CASE WHEN access.enabled IS DISTINCT FROM excluded.enabled THEN 1 ELSE 0 END,
      updated_by_subject_id = excluded.updated_by_subject_id, updated_at = now()
    WHERE access.account_id = p_account AND access.home_workspace_id = p_home
    RETURNING access.enabled, access.generation;
END $body$;

CREATE FUNCTION opengeni_private.list_organization_slack_bots(p_account uuid, p_target uuid)
RETURNS TABLE(connection_id uuid, home_workspace_id uuid, generation bigint, connection_version integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE access record; prior_workspace text;
BEGIN
  IF p_account IS NULL OR p_target IS NULL OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_target IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'Slack bot discovery scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM workspaces w WHERE w.id = p_target AND w.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'Slack bot target unavailable' USING ERRCODE = '42501'; END IF;
  prior_workspace := current_setting('opengeni.workspace_id', true);
  FOR access IN SELECT a.* FROM opengeni_private.organization_slack_bot_access a
    WHERE a.account_id = p_account AND a.enabled ORDER BY a.connection_id
  LOOP
    PERFORM set_config('opengeni.workspace_id', access.home_workspace_id::text, true);
    RETURN QUERY SELECT c.id, c.workspace_id, access.generation, c.version FROM connections c
      WHERE c.id = access.connection_id AND c.account_id = p_account AND c.workspace_id = access.home_workspace_id
      AND c.subject_id IS NULL AND c.kind = 'app_install' AND c.provider_domain = 'slack.com'
      AND c.metadata->>'credentialRole' = 'opengeni_slack_bot' AND c.status = 'active'
      AND c.verified_install_at IS NOT NULL AND c.verified_install_version = c.version;
  END LOOP;
  PERFORM set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
END $body$;

-- Extend the immutable intent store without rewriting historical messages.
ALTER TABLE opengeni_private.scheduled_slack_bot_messages
  ALTER COLUMN scheduled_task_id DROP NOT NULL,
  ADD COLUMN home_workspace_id uuid,
  ADD COLUMN sharing_generation bigint NOT NULL DEFAULT 0 CHECK (sharing_generation >= 0);

CREATE FUNCTION opengeni_private.prepare_organization_slack_bot_message(
  p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid,
  p_version integer, p_home uuid, p_generation bigint, p_channel text, p_thread text, p_text text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_id uuid; prior_workspace text; shared record;
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_session IS NULL OR p_connection IS NULL
    OR p_home IS NULL OR p_generation IS NULL OR p_version IS NULL OR p_channel IS NULL OR p_text IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'Slack message scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM sessions s WHERE s.id = p_session AND s.workspace_id = p_workspace AND s.account_id = p_account;
  IF NOT FOUND THEN RAISE EXCEPTION 'Slack message session unavailable' USING ERRCODE = '42501'; END IF;
  IF p_task IS NOT NULL THEN
    PERFORM 1 FROM sessions s JOIN scheduled_tasks t ON t.id = p_task AND t.workspace_id = s.workspace_id AND t.account_id = s.account_id
      WHERE s.id = p_session AND s.account_id = p_account AND s.workspace_id = p_workspace
      AND s.created_by_kind = 'service' AND s.created_by_subject_id = 'scheduler'
      AND s.created_by_context->>'scheduledTaskId' = p_task::text AND s.metadata->>'scheduledTaskId' = p_task::text
      AND s.created_by_context->>'scheduledTaskRunId' = s.metadata->>'scheduledTaskRunId'
      AND s.metadata->>'opengeniSlackBotConnectionId' = p_connection::text
      AND t.run_mode <> 'existing_session' AND t.agent_config->>'slackBotConnectionId' = p_connection::text
      AND t.agent_config->>'slackBotChannelId' = p_channel;
    IF NOT FOUND THEN RAISE EXCEPTION 'Scheduled Slack destination unavailable' USING ERRCODE = '42501'; END IF;
  ELSE
    -- Scheduled children cannot escape a person's fixed destination through
    -- the ordinary-chat form of the same tools.
    PERFORM 1 FROM sessions s JOIN sessions root ON root.id = coalesce(s.root_session_id, s.id)
      AND root.workspace_id = s.workspace_id AND root.account_id = s.account_id
      WHERE s.id = p_session AND s.workspace_id = p_workspace AND s.account_id = p_account
      AND root.created_by_kind = 'service' AND root.created_by_subject_id = 'scheduler'
      AND root.metadata ? 'scheduledTaskId';
    IF FOUND THEN RAISE EXCEPTION 'Scheduled Slack requires its fixed destination' USING ERRCODE = '42501'; END IF;
  END IF;
  IF p_home <> p_workspace THEN
    SELECT * INTO shared FROM opengeni_private.list_organization_slack_bots(p_account, p_workspace) a
      WHERE a.connection_id = p_connection AND a.home_workspace_id = p_home AND a.generation = p_generation;
    IF NOT FOUND THEN RAISE EXCEPTION 'Organization Slack access changed' USING ERRCODE = '42501'; END IF;
  ELSIF p_generation <> 0 THEN RAISE EXCEPTION 'Local Slack access generation mismatch' USING ERRCODE = '42501'; END IF;
  prior_workspace := current_setting('opengeni.workspace_id', true);
  PERFORM set_config('opengeni.workspace_id', p_home::text, true);
  PERFORM 1 FROM connections c WHERE c.id = p_connection AND c.account_id = p_account AND c.workspace_id = p_home
    AND c.version = p_version AND c.verified_install_at IS NOT NULL AND c.verified_install_version = c.version
    AND c.subject_id IS NULL AND c.kind = 'app_install' AND c.provider_domain = 'slack.com' AND c.status = 'active'
    AND c.metadata->>'credentialRole' = 'opengeni_slack_bot';
  IF NOT FOUND THEN RAISE EXCEPTION 'Slack message connection unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
  INSERT INTO opengeni_private.scheduled_slack_bot_messages(account_id, workspace_id, session_id, scheduled_task_id,
    connection_id, connection_version, home_workspace_id, sharing_generation, channel_id, thread_timestamp, message_text)
    VALUES(p_account, p_workspace, p_session, p_task, p_connection, p_version, p_home, p_generation, p_channel, p_thread, p_text)
    RETURNING id INTO v_id;
  RETURN v_id;
END $body$;

CREATE FUNCTION opengeni_private.read_organization_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_id uuid)
RETURNS TABLE(id uuid, scheduled_task_id uuid, connection_id uuid, connection_version integer,
  home_workspace_id uuid, sharing_generation bigint, channel_id text, thread_timestamp text, message_text text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_session IS NULL OR p_id IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'Slack message scope mismatch' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT m.id, m.scheduled_task_id, m.connection_id, m.connection_version,
    coalesce(m.home_workspace_id, m.workspace_id), m.sharing_generation, m.channel_id, m.thread_timestamp, m.message_text
    FROM opengeni_private.scheduled_slack_bot_messages m WHERE m.account_id = p_account AND m.workspace_id = p_workspace
    AND m.session_id = p_session AND m.id = p_id;
END $body$;

REVOKE ALL ON TABLE opengeni_private.organization_slack_bot_access FROM PUBLIC;
DO $grants$
DECLARE target_schema text := current_schema(); signature text; recipient record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'read_organization_slack_bot_access(uuid,uuid,uuid)',
    'set_organization_slack_bot_access(uuid,uuid,uuid,text,boolean)',
    'list_organization_slack_bots(uuid,uuid)',
    'prepare_organization_slack_bot_message(uuid,uuid,uuid,uuid,uuid,integer,uuid,bigint,text,text,text)',
    'read_organization_slack_bot_message(uuid,uuid,uuid,uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp', signature, target_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    FOR recipient IN SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
      WHERE n.nspname = target_schema AND c.relname = 'slack_bot_post_operations'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.%s TO %I', signature, recipient.rolname);
      EXECUTE format('REVOKE ALL ON TABLE opengeni_private.organization_slack_bot_access FROM %I', recipient.rolname);
    END LOOP;
  END LOOP;
END $grants$;
