-- deployment-mode: rolling
-- Teams conversation context: recent messages people posted in an approved
-- Teams channel or group chat, kept so the next @mention of Opengeni there can
-- see them, as a Slack thread mention already does.
--
-- With resource-specific consent (ChannelMessage.Read.Group and
-- ChatMessage.Read.Chat in the app manifest) Teams delivers every message in
-- the installed team or chat to the bot, not only the mentions. Those
-- messages never start work; the API records a bounded window of them here
-- and reads it when someone mentions Opengeni. Rows are HOME-owned by the
-- installation's workspace, capped per conversation thread by the writer and
-- pruned after seven days, and deleted when the installation is disconnected.
--
-- * conversation_id is the group chat or channel id without its
--   ";messageid=" thread suffix; thread_id is the channel thread's root post
--   id, or '' in a group chat.
-- * mentioned marks a mention Opengeni accepted: a reader walking back from
--   a mention that continues the same chat stops at the previous one.
-- * Teams edits replace text and deletions remove the row; a new member in a
--   group chat clears that chat's rows.
--
-- Only a new table, so an older binary keeps working unchanged and never
-- reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE teams_bot_context_messages (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  conversation_id text NOT NULL,
  thread_id text NOT NULL DEFAULT '',
  message_id text NOT NULL,
  actor_id uuid NOT NULL,
  actor_name text,
  text text NOT NULL,
  has_attachments boolean NOT NULL DEFAULT false,
  mentioned boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_bot_context_messages_pkey
    PRIMARY KEY (workspace_id, conversation_id, message_id),
  CONSTRAINT teams_bot_context_messages_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_context_messages_bounds_check CHECK (
    octet_length(conversation_id) BETWEEN 1 AND 512
    AND octet_length(thread_id) <= 512
    AND octet_length(message_id) BETWEEN 1 AND 512
    AND (actor_name IS NULL OR char_length(actor_name) <= 256)
    AND char_length(text) <= 4000
  )
);

CREATE INDEX teams_bot_context_messages_thread_idx
  ON teams_bot_context_messages (workspace_id, conversation_id, thread_id, occurred_at DESC);
-- A new channel post that mentions Opengeni reads the channel's root posts.
CREATE INDEX teams_bot_context_messages_root_post_idx
  ON teams_bot_context_messages (workspace_id, conversation_id, occurred_at DESC)
  WHERE thread_id = message_id;
CREATE INDEX teams_bot_context_messages_created_idx
  ON teams_bot_context_messages (workspace_id, created_at);

ALTER TABLE teams_bot_context_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_context_messages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE teams_bot_context_messages FROM PUBLIC;
CREATE POLICY workspace_isolation ON teams_bot_context_messages
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE teams_bot_context_messages IS 'Recent Teams channel and group chat messages kept as context for the next mention of Opengeni.';

DO $teams_bot_context_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_context_messages TO opengeni_app;
  END IF;
END
$teams_bot_context_grants$;
