-- deployment-mode: rolling
-- Two things per-channel Slack routing needs from storage once the routed
-- workspace and the installation's workspace can actually differ.
--
-- 1. A Slack button click arrives on an inbox row that carries HOME tenancy and
--    names one action handle by id. The handle lives in the workspace that owns
--    its session, which is TARGET, and its RESTRICTIVE session-visibility policy
--    resolves the session under the handle's own scope. Without a way to learn
--    that scope from the id, every routed Status/Stop/Approve click reads under
--    HOME, finds nothing, and is refused as an invalid handle.
--
-- 2. `slack_shared_task_origins` carries TWO composite foreign keys on the SAME
--    (account_id, workspace_id) pair: one to `slack_interactions` and one to
--    `slack_task_policy_revisions`. The interaction is TARGET and the Slack task
--    policy stays HOME by explicit decision, because it governs what may be read
--    out of the Slack conversation rather than who the task belongs to. Once the
--    two differ, no value of that pair satisfies both constraints and every
--    private-handoff task in a routed workspace fails at insert.
--
-- Rolling: the probe is additive, and the shared-task-origin columns are
-- nullable with the existing rows backfilled to their own tenancy, so an old
-- image that writes neither column keeps working exactly as it does today.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- `slack_interaction_action_handles` carries a RESTRICTIVE
-- `session_visibility_isolation` policy whose helper resolves the handle's
-- session under the CURRENT scope. A permissive policy cannot open that: a
-- restrictive policy is ANDed, and weakening it would weaken session visibility
-- itself. So the tenancy is not read out of the handle table at all. A private,
-- ids-only mapping is maintained by a trigger on the handle table and lives in
-- `opengeni_private`, where the runtime role has no privileges and the definer
-- probe is the only reader.
--
-- Content-free by construction: handle id, connection id, and the tenancy pair.
-- No action kind, no target value, no subject, no session content. The caller
-- must still re-read the full handle under the returned tenancy's own RLS, which
-- is where every existing authorization check already lives.
CREATE TABLE opengeni_private.slack_action_handle_tenancy (
  "handle_id" uuid PRIMARY KEY,
  "connection_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL
);
REVOKE ALL ON TABLE opengeni_private.slack_action_handle_tenancy FROM PUBLIC;

CREATE FUNCTION opengeni_private.sync_slack_action_handle_tenancy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM opengeni_private.slack_action_handle_tenancy
    WHERE handle_id = OLD.id;
    RETURN OLD;
  END IF;
  INSERT INTO opengeni_private.slack_action_handle_tenancy (
    handle_id, connection_id, account_id, workspace_id
  ) VALUES (NEW.id, NEW.connection_id, NEW.account_id, NEW.workspace_id)
  ON CONFLICT (handle_id) DO UPDATE
    SET connection_id = EXCLUDED.connection_id,
        account_id = EXCLUDED.account_id,
        workspace_id = EXCLUDED.workspace_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.sync_slack_action_handle_tenancy() FROM PUBLIC;

DO $slack_handle_trigger$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'CREATE TRIGGER slack_action_handle_tenancy_sync
       AFTER INSERT OR UPDATE OF account_id, workspace_id, connection_id OR DELETE
       ON %I.slack_interaction_action_handles
       FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_slack_action_handle_tenancy()',
    data_schema
  );
END
$slack_handle_trigger$;

-- FORCE ROW LEVEL SECURITY binds the table owner and no tenant GUC is set during
-- a migration, so reading the existing handles needs the owner-only posture
-- window. The app role stays policy-bound throughout.
ALTER TABLE "slack_interaction_action_handles" NO FORCE ROW LEVEL SECURITY;

INSERT INTO opengeni_private.slack_action_handle_tenancy (
  handle_id, connection_id, account_id, workspace_id
)
SELECT H.id, H.connection_id, H.account_id, H.workspace_id
FROM "slack_interaction_action_handles" H
ON CONFLICT (handle_id) DO NOTHING;

ALTER TABLE "slack_interaction_action_handles" FORCE ROW LEVEL SECURITY;

DO $slack_handle_probe$
BEGIN
  EXECUTE $ddl$
    CREATE FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(
      p_connection_id uuid,
      p_handle_id uuid
    )
    RETURNS TABLE (account_id uuid, workspace_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = opengeni_private, pg_catalog
    AS $function$
      SELECT T.account_id, T.workspace_id
      FROM slack_action_handle_tenancy T
      WHERE T.handle_id = p_handle_id
        AND T.connection_id = p_connection_id
      LIMIT 1
    $function$
  $ddl$;
END
$slack_handle_probe$;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid)
  FROM PUBLIC;

-- The Slack task policy revision this origin froze is a HOME fact. Give it its
-- own tenancy pair so the row's own (account_id, workspace_id) stays free to be
-- the interaction's.
ALTER TABLE "slack_shared_task_origins"
  ADD COLUMN "policy_account_id" uuid,
  ADD COLUMN "policy_workspace_id" uuid;

-- FORCE ROW LEVEL SECURITY binds the table owner and no tenant GUC is set during
-- a migration, so a bare UPDATE here would match ZERO rows and report success.
-- Relax the owner-only posture for exactly this statement; the app role stays
-- policy-bound throughout.
ALTER TABLE "slack_shared_task_origins" NO FORCE ROW LEVEL SECURITY;

UPDATE "slack_shared_task_origins"
   SET "policy_account_id" = "account_id",
       "policy_workspace_id" = "workspace_id"
 WHERE "policy_account_id" IS NULL;

ALTER TABLE "slack_shared_task_origins" FORCE ROW LEVEL SECURITY;

ALTER TABLE "slack_shared_task_origins"
  DROP CONSTRAINT "slack_shared_task_origins_policy_fk";

ALTER TABLE "slack_shared_task_origins"
  ADD CONSTRAINT "slack_shared_task_origins_policy_home_fk"
  FOREIGN KEY ("policy_account_id", "policy_workspace_id", "policy_revision_id")
  REFERENCES "slack_task_policy_revisions"("account_id", "workspace_id", "id")
  ON DELETE RESTRICT NOT VALID;

ALTER TABLE "slack_shared_task_origins"
  VALIDATE CONSTRAINT "slack_shared_task_origins_policy_home_fk";

ALTER TABLE "slack_shared_task_origins"
  ADD CONSTRAINT "slack_shared_task_origins_policy_home_chk"
  CHECK (("policy_account_id" IS NULL) = ("policy_workspace_id" IS NULL)) NOT VALID;

ALTER TABLE "slack_shared_task_origins"
  VALIDATE CONSTRAINT "slack_shared_task_origins_policy_home_chk";

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.resolve_slack_action_handle_tenancy(uuid, uuid) TO opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.slack_action_handle_tenancy FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON COLUMN "slack_shared_task_origins"."policy_workspace_id" IS
  'Home tenancy of the frozen Slack task policy revision; null on rows written before Slack workspace routing.';

RESET statement_timeout;
RESET lock_timeout;
