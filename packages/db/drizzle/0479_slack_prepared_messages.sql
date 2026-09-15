-- deployment-mode: rolling
-- Server-owned message intents. Sending reuses this identity, never a caller-generated operation UUID.
CREATE TABLE slack_prepared_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  connection_version integer NOT NULL CHECK (connection_version > 0),
  target_kind text NOT NULL CHECK (target_kind IN ('channel', 'user')),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  thread_timestamp text,
  message_text text NOT NULL CHECK (length(message_text) BETWEEN 1 AND 40000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE slack_prepared_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_prepared_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON slack_prepared_messages
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON slack_prepared_messages AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
CREATE FUNCTION validate_slack_prepared_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id
      AND s.account_id = NEW.account_id AND s.workspace_id = NEW.workspace_id)
    OR NOT EXISTS (SELECT 1 FROM connections c WHERE c.id = NEW.connection_id
      AND c.account_id = NEW.account_id AND c.workspace_id = NEW.workspace_id
      AND c.subject_id IS NULL AND c.kind = 'app_install' AND c.provider_domain = 'slack.com')
  THEN RAISE EXCEPTION 'prepared Slack message identity mismatch' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER slack_prepared_messages_identity BEFORE INSERT ON slack_prepared_messages
  FOR EACH ROW EXECUTE FUNCTION validate_slack_prepared_message_identity();
REVOKE ALL ON FUNCTION validate_slack_prepared_message_identity() FROM PUBLIC;
CREATE INDEX slack_prepared_messages_session ON slack_prepared_messages(workspace_id, session_id);
CREATE FUNCTION prevent_slack_prepared_message_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prepared Slack messages are immutable';
END;
$$;
CREATE TRIGGER slack_prepared_messages_immutable BEFORE UPDATE ON slack_prepared_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_slack_prepared_message_update();

REVOKE ALL ON FUNCTION prevent_slack_prepared_message_update() FROM PUBLIC;
