-- deployment-mode: rolling
-- A secret approval request names the chat its use came from, so, like every
-- other chat-linked row, it is visible only to someone who can see that chat.
-- The person a run acts for always sees their own chats, so their grants still
-- cover each other; a workspace member who cannot read a private chat no
-- longer reads the items, tools and destinations its approvals name. Only the
-- 0952 tables are touched, and no earlier release reads them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE POLICY session_visibility_isolation ON secret_use_approvals AS RESTRICTIVE
  FOR ALL USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
