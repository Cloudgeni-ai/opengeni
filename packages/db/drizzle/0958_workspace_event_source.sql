-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: event_sources holds a few rows per workspace, so validating in this file is instant.
-- online-safety-exception: nonconcurrent-index: event_sources holds a few rows per workspace, so the partial index builds instantly.
-- "This workspace" event sources: things that happen in Opengeni itself,
-- meeting recordings today, as one person may see them. Each person has at
-- most one in a workspace. It has no route; its feed (0935) reads the
-- workspace's recording events as its owner. Only widens the checks: every
-- existing row already satisfies them, and older binaries never create this
-- kind.
ALTER TABLE event_sources DROP CONSTRAINT event_sources_kind_check;
ALTER TABLE event_sources ADD CONSTRAINT event_sources_kind_check
  CHECK (kind IN ('webhook', 'github', 'slack', 'gmail', 'mcp', 'workspace')) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_kind_check;

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
  AND (kind NOT IN ('webhook', 'gmail', 'mcp', 'workspace') OR owner_subject_id IS NOT NULL)
  AND (kind <> 'workspace' OR visibility = 'private')
  AND ((status = 'active') = (status_reason IS NULL))
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_shape_chk;

CREATE UNIQUE INDEX event_sources_workspace_owner_uq
  ON event_sources(workspace_id, owner_subject_id)
  WHERE kind = 'workspace';
