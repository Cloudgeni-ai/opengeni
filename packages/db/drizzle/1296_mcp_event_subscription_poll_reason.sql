-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: mcp_event_subscriptions holds one row per subscribed MCP event stream, and every existing row has a null poll_reason, so validating this check here is instant.
-- Why an MCP event subscription polls: 'not_offered' when the event type (or
-- this deployment) offered no webhook delivery when it was last checked, or
-- 'callback_failed' when a webhook subscription was tried and failed, with
-- poll_reason_at saying since when. A subscription polling because webhook
-- was not offered moves to webhook once the type offers it; one polling after
-- a failed webhook tries again about a day later.
--
-- Rolling: two nullable columns and a check every existing row (both null)
-- satisfies. The previous release never reads or writes them; a row it moves
-- to polling has a null reason, which the new release treats as not offered.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE mcp_event_subscriptions
  ADD COLUMN poll_reason text,
  ADD COLUMN poll_reason_at timestamptz;

COMMENT ON COLUMN mcp_event_subscriptions.poll_reason IS
  'Why the subscription polls: not_offered (no webhook delivery offered when last checked) or callback_failed (a webhook subscription failed); null when it does not poll or for rows older releases moved to polling.';
COMMENT ON COLUMN mcp_event_subscriptions.poll_reason_at IS
  'Since when poll_reason holds; set exactly when poll_reason is.';

ALTER TABLE mcp_event_subscriptions
  ADD CONSTRAINT mcp_event_subscriptions_poll_reason_chk CHECK (
    (poll_reason IS NULL) = (poll_reason_at IS NULL)
    AND (poll_reason IS NULL OR poll_reason IN ('not_offered', 'callback_failed'))
  );
