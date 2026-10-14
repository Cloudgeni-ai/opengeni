-- deployment-mode: rolling
-- Connector mode alone does not establish built-in intent: callers could supply
-- an explicit built-in list while omitting connector selection. Only a retained
-- full reset proves that an older selection was meant to follow defaults.
-- The latest policy event must still describe the stored list. A later explicit
-- pin, connector-only edit without reset evidence, or missing history stays pinned.
-- No accepted turn, delegated token, or attempt catalog is rewritten.
-- Acquire tenancy fences before table locks. The owner-only inventory capability
-- exposes only the workspace ids; application access remains policy-bound.
SET LOCAL opengeni.session_variable_set_attachments_v1 = '1';
CREATE TEMP TABLE first_party_default_workspaces (workspace_id uuid PRIMARY KEY) ON COMMIT DROP;
DO $fences$
DECLARE
  inventory_id uuid;
  workspace_value uuid;
BEGIN
  inventory_id := opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema());
  INSERT INTO pg_temp.first_party_default_workspaces
  SELECT DISTINCT workspace_id
  FROM sessions
  WHERE NOT (tool_policy ? 'firstPartyMode')
    AND tool_policy ->> 'mode' = 'workspace_default'
    AND parent_session_id IS NULL;
  FOR workspace_value IN SELECT workspace_id FROM pg_temp.first_party_default_workspaces ORDER BY workspace_id LOOP
    PERFORM acquire_session_tenancy_fence(workspace_value);
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
  RAISE;
END
$fences$;

-- A transaction-local owner window keeps the backfill visible to the ordinary
-- non-BYPASSRLS migration owner. No runtime role gains access; failure rolls the
-- window and update back together. Only the fenced workspace inventory is used.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;

WITH proven_defaults AS (
  SELECT session.id, session.workspace_id
  FROM sessions session
  CROSS JOIN LATERAL (
    SELECT event.payload
    FROM session_events event
    WHERE event.workspace_id = session.workspace_id
      AND event.session_id = session.id
      AND event.type = 'session.tool_policy.updated'
    ORDER BY event.sequence DESC
    LIMIT 1
  ) latest
  WHERE NOT (session.tool_policy ? 'firstPartyMode')
    AND session.workspace_id IN (SELECT workspace_id FROM pg_temp.first_party_default_workspaces)
    AND session.tool_policy ->> 'mode' = 'workspace_default'
    -- A child cannot acquire future defaults beyond its retained parent ceiling.
    -- New children inherit the parent's explicit intent through normal creation.
    AND session.parent_session_id IS NULL
    AND latest.payload #>> '{after,mode}' = 'workspace_default'
    AND jsonb_typeof(latest.payload #> '{before,firstPartyMcpTools}') = 'array'
    AND jsonb_typeof(latest.payload #> '{after,firstPartyMcpTools}') = 'array'
    AND (
      latest.payload #>> '{before,mode}' <> 'workspace_default'
      OR latest.payload #> '{before,firstPartyMcpTools}'
        <> latest.payload #> '{after,firstPartyMcpTools}'
    )
    AND session.first_party_mcp_tools @> (latest.payload #> '{after,firstPartyMcpTools}')
    AND session.first_party_mcp_tools <@ (latest.payload #> '{after,firstPartyMcpTools}')
)
UPDATE sessions session
SET tool_policy = session.tool_policy || '{"firstPartyMode":"workspace_default"}'::jsonb,
    tool_policy_version = session.tool_policy_version + 1
FROM proven_defaults
WHERE session.id = proven_defaults.id
  AND session.workspace_id = proven_defaults.workspace_id;

ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
