-- deployment-mode: rolling
-- Two per-row write fences ran their full body on every write to the hottest
-- session tables, although almost every write cannot change their outcome.
--
-- fence_mcp_account_bindings converts NEW and OLD to jsonb on every UPDATE of
-- sessions and session turns. On UPDATE its outcome depends only on the
-- accepted bindings, their delegations and (for sessions) visibility: when
-- none of them changes it re-validates the unchanged, already accepted value
-- and returns NEW. A trigger WHEN clause now skips that call in C. INSERT keeps
-- its unconditional fence; UPDATE moves to an adjacent trigger name so the
-- alphabetical firing order among other BEFORE triggers is unchanged.
-- WHEN in a BEFORE trigger is evaluated just before the function would run,
-- so it sees NEW exactly as the function would.
--
-- require_session_tenancy_fence converted the whole row to jsonb only to read
-- workspace_id, which every fenced table has as a uuid column.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION opengeni_private.require_session_tenancy_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fence$
DECLARE
  workspace_id_value uuid;
  lock_key bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles role_value
    WHERE role_value.rolname = session_user
      AND (role_value.rolsuper OR role_value.rolbypassrls)
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    workspace_id_value := OLD.workspace_id;
  ELSE
    workspace_id_value := NEW.workspace_id;
  END IF;
  IF workspace_id_value IS NULL THEN
    RAISE EXCEPTION 'session tenancy mutation has no workspace fence target'
      USING ERRCODE = '55000';
  END IF;
  lock_key := hashtextextended('session-tenancy:' || workspace_id_value::text, 0);
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks held
    WHERE held.locktype = 'advisory'
      AND held.pid = pg_backend_pid()
      AND held.granted
      AND held.classid = (((lock_key >> 32) & 4294967295)::bigint)::oid
      AND held.objid = ((lock_key & 4294967295)::bigint)::oid
      AND held.objsubid = 1
      AND held.mode IN ('ShareLock', 'ExclusiveLock')
  ) THEN
    RAISE EXCEPTION 'session tenancy mutation requires the workspace fence'
      USING ERRCODE = '55000', DETAIL = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fence$;

REVOKE ALL ON FUNCTION opengeni_private.require_session_tenancy_fence() FROM PUBLIC;

-- Same table order as session write transactions: sessions, then turns, then
-- their update carriers.
CREATE OR REPLACE TRIGGER mcp_account_bindings_fence
BEFORE INSERT ON sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence_update
BEFORE UPDATE ON sessions
FOR EACH ROW
WHEN (
  OLD.initial_mcp_account_bindings IS DISTINCT FROM NEW.initial_mcp_account_bindings
  OR OLD.initial_personal_connection_delegations IS DISTINCT FROM NEW.initial_personal_connection_delegations
  OR OLD.visibility IS DISTINCT FROM NEW.visibility
)
EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE OR REPLACE TRIGGER mcp_account_bindings_fence
BEFORE INSERT ON session_turns
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence_update
BEFORE UPDATE ON session_turns
FOR EACH ROW
WHEN (
  OLD.mcp_account_bindings IS DISTINCT FROM NEW.mcp_account_bindings
  OR OLD.personal_connection_delegations IS DISTINCT FROM NEW.personal_connection_delegations
)
EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE OR REPLACE TRIGGER mcp_account_bindings_fence
BEFORE INSERT ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence_update
BEFORE UPDATE ON session_system_updates
FOR EACH ROW
WHEN (
  OLD.mcp_account_bindings IS DISTINCT FROM NEW.mcp_account_bindings
  OR OLD.personal_connection_delegations IS DISTINCT FROM NEW.personal_connection_delegations
)
EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE OR REPLACE TRIGGER mcp_account_bindings_fence
BEFORE INSERT ON session_system_update_outbox
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence_update
BEFORE UPDATE ON session_system_update_outbox
FOR EACH ROW
WHEN (
  OLD.mcp_account_bindings IS DISTINCT FROM NEW.mcp_account_bindings
  OR OLD.personal_connection_delegations IS DISTINCT FROM NEW.personal_connection_delegations
)
EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE OR REPLACE TRIGGER mcp_account_bindings_fence
BEFORE INSERT ON scheduled_task_runs
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
CREATE TRIGGER mcp_account_bindings_fence_update
BEFORE UPDATE ON scheduled_task_runs
FOR EACH ROW
WHEN (OLD.accepted_execution_snapshot IS DISTINCT FROM NEW.accepted_execution_snapshot)
EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();
