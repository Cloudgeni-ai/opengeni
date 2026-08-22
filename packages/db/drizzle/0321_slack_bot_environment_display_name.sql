-- deployment-mode: rolling
-- Slack app and bot names are environment-scoped human-facing identity. Keep
-- the accepted set closed while allowing the managed staging principal to be
-- visibly distinct from production in a shared Slack workspace.
ALTER TABLE slack_installation_bindings
  DROP CONSTRAINT slack_installation_bindings_identity_check;

ALTER TABLE slack_installation_bindings
  ADD CONSTRAINT slack_installation_bindings_identity_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND octet_length(slack_team_name) BETWEEN 1 AND 256
    AND octet_length(bot_id) BETWEEN 1 AND 64
    AND octet_length(bot_user_id) BETWEEN 1 AND 64
    AND bot_display_name IN ('OpenGeni', 'OpenGeni Staging')
  );
