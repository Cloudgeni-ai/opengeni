-- deployment-mode: rolling
-- A third answer to "what may agents do in your inbox": full access. Any agent
-- working for the person may see every open item (questions, approvals, paused
-- goals, replies and notes) and snooze, unsnooze or dismiss it. Agents still
-- never answer or approve for the person. The check only widens, so existing
-- rows stay valid; agents on older releases treat the new value like the
-- narrowest one.
SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.inbox_settings
  DROP CONSTRAINT inbox_settings_tidy_policy_check;
ALTER TABLE opengeni_private.inbox_settings
  ADD CONSTRAINT inbox_settings_tidy_policy_check
  CHECK (tidy_policy IN ('own_sessions', 'any_agent', 'full_access')) NOT VALID;
ALTER TABLE opengeni_private.inbox_settings
  VALIDATE CONSTRAINT inbox_settings_tidy_policy_check;
