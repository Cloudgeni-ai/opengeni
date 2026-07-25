-- deployment-mode: rolling
-- Finalize only from validated helper checks. PostgreSQL 14 can prove each
-- SET NOT NULL from those checks without rescanning the table while holding
-- ACCESS EXCLUSIVE; the data-read validation work is isolated in 0113.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "sessions"
  ALTER COLUMN "root_session_id" SET NOT NULL,
  ALTER COLUMN "nested_agent_depth" SET NOT NULL,
  ALTER COLUMN "effective_max_nested_agent_depth" SET NOT NULL,
  ALTER COLUMN "nested_agent_depth_policy_source" SET NOT NULL;

-- Cross-workspace lineage references are installed after the checks prove
-- their source columns are complete. They remain NOT VALID until 0115 so this
-- migration only takes the short catalog lock.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_root_session_fk"
  FOREIGN KEY ("workspace_id", "root_session_id")
  REFERENCES "sessions"("workspace_id", "id") DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_policy_session_fk"
  FOREIGN KEY ("workspace_id", "nested_agent_depth_policy_session_id")
  REFERENCES "sessions"("workspace_id", "id") DEFERRABLE INITIALLY DEFERRED NOT VALID;

CREATE OR REPLACE FUNCTION opengeni_private.session_depth_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.parent_session_id IS DISTINCT FROM OLD.parent_session_id
     OR NEW.root_session_id IS DISTINCT FROM OLD.root_session_id
     OR NEW.nested_agent_depth IS DISTINCT FROM OLD.nested_agent_depth
     OR NEW.max_nested_agent_depth_override IS DISTINCT FROM OLD.max_nested_agent_depth_override
     OR NEW.effective_max_nested_agent_depth IS DISTINCT FROM OLD.effective_max_nested_agent_depth
     OR NEW.nested_agent_depth_policy_source IS DISTINCT FROM OLD.nested_agent_depth_policy_source
     OR NEW.nested_agent_depth_policy_session_id IS DISTINCT FROM OLD.nested_agent_depth_policy_session_id THEN
    RAISE EXCEPTION 'session lineage and nested-agent policy snapshot are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DO $trigger$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS session_depth_snapshot_immutable ON %I.sessions', target_schema);
  EXECUTE format('CREATE TRIGGER session_depth_snapshot_immutable BEFORE UPDATE OF parent_session_id, root_session_id, nested_agent_depth, max_nested_agent_depth_override, effective_max_nested_agent_depth, nested_agent_depth_policy_source, nested_agent_depth_policy_session_id ON %I.sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_depth_snapshot_immutable()', target_schema);
END $trigger$;

RESET statement_timeout;
RESET lock_timeout;