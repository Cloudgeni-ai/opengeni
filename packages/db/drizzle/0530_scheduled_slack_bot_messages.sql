-- deployment-mode: rolling
-- Scheduled tasks may post as the OpenGeni workspace bot, but only to the one
-- Slack channel a person chose on the task. A prepared message is an immutable,
-- server-owned intent; its id is reused as the Slack post operation id, so a
-- retried send reconciles the original delivery instead of posting twice.
-- New storage lives in opengeni_private behind two runtime capabilities, so
-- the public-schema table inventory of older binaries is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.scheduled_slack_bot_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  scheduled_task_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_version integer NOT NULL,
  channel_id text NOT NULL,
  thread_timestamp text,
  message_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_slack_bot_messages_session_fk FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scheduled_slack_bot_messages_connection_fk FOREIGN KEY (connection_id)
    REFERENCES connections(id) ON DELETE CASCADE,
  CONSTRAINT scheduled_slack_bot_messages_shape_check CHECK (
    connection_version > 0
    AND channel_id ~ '^[CG][A-Z0-9]{2,63}$'
    AND (thread_timestamp IS NULL OR thread_timestamp ~ '^[0-9]{1,20}\.[0-9]{1,12}$')
    AND length(message_text) BETWEEN 1 AND 40000
  )
);
CREATE INDEX scheduled_slack_bot_messages_session_idx
  ON opengeni_private.scheduled_slack_bot_messages(workspace_id, session_id, created_at);
ALTER TABLE opengeni_private.scheduled_slack_bot_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.scheduled_slack_bot_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON opengeni_private.scheduled_slack_bot_messages
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Runtime roles have EXECUTE only, never table DML, so a prepared message can
-- be neither rewritten nor redirected after it is saved. Both capabilities bind
-- the caller's tenant GUCs. Preparing re-proves, under the same snapshot, that
-- the session is the scheduler-created run of this exact task, that the task
-- still names this bot and channel, and that the bot connection is the active
-- version the caller authorized.
CREATE FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(
  p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid,
  p_connection_version integer, p_channel text, p_thread text, p_text text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_id uuid;
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_session IS NULL OR p_task IS NULL
    OR p_connection IS NULL OR p_connection_version IS NULL OR p_channel IS NULL OR p_text IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'scheduled Slack message scope mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM sessions s
    WHERE s.account_id = p_account AND s.workspace_id = p_workspace AND s.id = p_session
      AND s.created_by_kind = 'service' AND s.created_by_subject_id = 'scheduler'
      AND s.created_by_context->>'scheduledTaskId' = p_task::text
      AND s.metadata->>'scheduledTaskId' = p_task::text
      AND s.created_by_context->>'scheduledTaskRunId' = s.metadata->>'scheduledTaskRunId'
      AND s.metadata->>'opengeniSlackBotConnectionId' = p_connection::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled Slack message session unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scheduled_tasks t
    WHERE t.account_id = p_account AND t.workspace_id = p_workspace AND t.id = p_task
      AND t.run_mode <> 'existing_session'
      AND t.agent_config->>'slackBotConnectionId' = p_connection::text
      AND t.agent_config->>'slackBotChannelId' = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled Slack message destination unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM connections c
    WHERE c.account_id = p_account AND c.workspace_id = p_workspace AND c.id = p_connection
      AND c.version = p_connection_version AND c.verified_install_version = c.version
      AND c.subject_id IS NULL AND c.kind = 'app_install'
      AND c.provider_domain = 'slack.com' AND c.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled Slack message connection unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO opengeni_private.scheduled_slack_bot_messages(
    account_id, workspace_id, session_id, scheduled_task_id, connection_id,
    connection_version, channel_id, thread_timestamp, message_text
  ) VALUES (
    p_account, p_workspace, p_session, p_task, p_connection,
    p_connection_version, p_channel, p_thread, p_text
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $body$;

CREATE FUNCTION opengeni_private.read_scheduled_slack_bot_message(
  p_account uuid, p_workspace uuid, p_session uuid, p_id uuid
) RETURNS TABLE(
  id uuid, scheduled_task_id uuid, connection_id uuid, connection_version integer,
  channel_id text, thread_timestamp text, message_text text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_session IS NULL OR p_id IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'scheduled Slack message scope mismatch' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT m.id, m.scheduled_task_id, m.connection_id, m.connection_version,
      m.channel_id, m.thread_timestamp, m.message_text
    FROM opengeni_private.scheduled_slack_bot_messages m
    WHERE m.account_id = p_account AND m.workspace_id = p_workspace
      AND m.session_id = p_session AND m.id = p_id;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(uuid,uuid,uuid,uuid,uuid,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.read_scheduled_slack_bot_message(uuid,uuid,uuid,uuid) FROM PUBLIC;

-- Preserve existing runtime role recipients; provisionRoles owns future roles.
DO $grants$
DECLARE target_schema text := current_schema(); recipient record;
BEGIN
  -- Explicit pg_temp LAST is load-bearing: omitting it lets PostgreSQL search
  -- caller-controlled temporary relations ahead of the captured data schema.
  EXECUTE format('ALTER FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(uuid,uuid,uuid,uuid,uuid,integer,text,text,text) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.read_scheduled_slack_bot_message(uuid,uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private' AND c.relname = 'scheduled_slack_bot_messages'
      AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.scheduled_slack_bot_messages FROM %s',
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname, p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) acl LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private'
      AND p.proname IN ('prepare_scheduled_slack_bot_message', 'read_scheduled_slack_bot_message')
      AND acl.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', recipient.signature,
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = target_schema AND c.relname = 'slack_bot_post_operations'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(uuid,uuid,uuid,uuid,uuid,integer,text,text,text), opengeni_private.read_scheduled_slack_bot_message(uuid,uuid,uuid,uuid) TO %I', recipient.rolname);
  END LOOP;
END $grants$;
