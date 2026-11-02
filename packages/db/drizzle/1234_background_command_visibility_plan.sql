-- deployment-mode: rolling
-- Permit PostgreSQL to choose a hashed visible-session subplan for backlog
-- scans while retaining indexed correlated lookups for individual commands.
-- OFFSET 0 forced a complete visibility check for every command. Removing that
-- optimizer fence changes no predicate, capability, tenant tuple, or write check.
-- Both old and new binaries use the same authorization contract.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE
  owner_name text;
  schema_oid oid;
BEGIN
  SELECT pg_get_userbyid(relowner), relnamespace INTO STRICT owner_name, schema_oid
    FROM pg_class WHERE oid = 'session_background_commands'::regclass;
  EXECUTE format($policy$
    ALTER POLICY session_visibility_isolation ON session_background_commands
    USING (
      session_tenancy_fence_owner_policy_active(current_user::text, %1$L, %2$s::oid, workspace_id, true)
      OR session_tenancy_fence_owner_policy_active(current_user::text, %1$L, %2$s::oid, workspace_id, false)
      OR session_id IS NULL
      OR EXISTS (
        SELECT 1 FROM sessions session_row
        WHERE session_row.account_id = session_background_commands.account_id
          AND session_row.workspace_id = session_background_commands.workspace_id
          AND session_row.id = session_background_commands.session_id
      )
    )
  $policy$, owner_name, schema_oid);
  -- ALTER POLICY leaves the explicit, correlated WITH CHECK unchanged.
END
$migration$;
