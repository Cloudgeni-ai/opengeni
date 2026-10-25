-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: event_sources holds a few rows per workspace, so validating in this file is instant.
-- A pasted webhook (Linear, Sentry) can wait for its signing secret: those
-- apps show the secret only after they have the source's URL. Until one is
-- pasted the source is not active, so every delivery is refused. Only widens
-- the check; every existing row already satisfies it.
ALTER TABLE event_sources DROP CONSTRAINT event_sources_shape_chk;
ALTER TABLE event_sources ADD CONSTRAINT event_sources_shape_chk CHECK (
  ((kind = 'webhook') = (adapter IS NOT NULL))
  AND (
    kind <> 'webhook'
    OR secret_encrypted IS NOT NULL
    OR (adapter IN ('linear', 'sentry') AND status <> 'active')
  )
  AND ((kind = 'mcp') = (mcp_server_id IS NOT NULL))
  AND (kind NOT IN ('github', 'slack', 'gmail') OR external_key IS NOT NULL)
  AND (kind NOT IN ('webhook', 'gmail', 'mcp') OR owner_subject_id IS NOT NULL)
  AND ((status = 'active') = (status_reason IS NULL))
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_shape_chk;
