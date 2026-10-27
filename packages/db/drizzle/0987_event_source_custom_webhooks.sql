-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: event_sources holds a few rows per workspace, so validating in this file is instant.
-- Custom webhook sources: any app's webhooks, read as the source's own
-- `webhook_format` describes (its signature scheme, where the event type and
-- ids are, whether a delivery holds a list of events). Like a Linear or
-- Sentry webhook, a custom one may wait, blocked, for the secret its app
-- shows. Only adds a column and widens the checks: every existing row already
-- satisfies them, and older binaries never create this adapter.
ALTER TABLE event_sources ADD COLUMN webhook_format jsonb;

ALTER TABLE event_sources DROP CONSTRAINT event_sources_adapter_check;
ALTER TABLE event_sources ADD CONSTRAINT event_sources_adapter_check
  CHECK (adapter IS NULL OR adapter IN ('standard', 'linear', 'sentry', 'custom')) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_adapter_check;

ALTER TABLE event_sources ADD CONSTRAINT event_sources_webhook_format_check CHECK (
  ((adapter IS NOT DISTINCT FROM 'custom') = (webhook_format IS NOT NULL))
  AND (webhook_format IS NULL OR (pg_catalog.jsonb_typeof(webhook_format) = 'object'
    AND pg_catalog.octet_length(webhook_format::text) <= 8192))
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_webhook_format_check;

ALTER TABLE event_sources DROP CONSTRAINT event_sources_shape_chk;
ALTER TABLE event_sources ADD CONSTRAINT event_sources_shape_chk CHECK (
  ((kind = 'webhook') = (adapter IS NOT NULL))
  AND (
    kind <> 'webhook'
    OR secret_encrypted IS NOT NULL
    OR (adapter IN ('linear', 'sentry', 'custom') AND status <> 'active')
  )
  AND ((kind = 'mcp') = (mcp_server_id IS NOT NULL))
  AND (kind NOT IN ('github', 'slack', 'gmail') OR external_key IS NOT NULL)
  AND (kind NOT IN ('webhook', 'gmail', 'mcp', 'workspace') OR owner_subject_id IS NOT NULL)
  AND (kind <> 'workspace' OR visibility = 'private')
  AND ((status = 'active') = (status_reason IS NULL))
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_shape_chk;
