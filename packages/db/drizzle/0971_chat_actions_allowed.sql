-- deployment-mode: rolling
-- In a chat a person started, the agent may do what that person could do in
-- the app's pages and settings, each change only after they confirm it in the
-- chat. On by default, including for every existing organization; an owner or
-- admin can turn it off for the organization. Adding a column with a constant
-- default rewrites nothing, and the previous release never reads it.
--
-- What a turn's message may do, frozen when the message is accepted: who sent
-- it, whether that person can confirm changes from where they sent it (signed
-- in to the app itself, or an embed whose host opted in), and the most it may
-- do, which is the sender's own access at that moment. Rows are written once,
-- never updated; a turn without one runs no app actions. Old releases never
-- read or write this table.
--
-- Who decided an approval card, and whether they did it signed in where a
-- change may be confirmed (the app itself, or an embed the deployment opted
-- in): an app-action change counts as confirmed only then, never through a
-- key, a chat integration button or another token carrying the same identity. Both
-- columns are nullable or constant-default additions; the previous release
-- leaves them at their defaults, which confirm nothing. Like the rest of a
-- decision, they are fixed once it is recorded: the immutability trigger from
-- 0155 is replaced with the same checks plus these two columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "organization_agent_admin_access"
  ADD COLUMN "chat_actions_allowed" boolean NOT NULL DEFAULT true;

ALTER TABLE "connector_action_requests"
  ADD COLUMN "decision_by_kind" text,
  ADD COLUMN "decision_by_signed_in_person" boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
    OR NEW.creation_attempt_id IS DISTINCT FROM OLD.creation_attempt_id
    OR NEW.creation_execution_generation IS DISTINCT FROM OLD.creation_execution_generation
    OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
    OR NEW.initiator_kind IS DISTINCT FROM OLD.initiator_kind
    OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_version IS DISTINCT FROM OLD.connection_version
    OR NEW.server_id IS DISTINCT FROM OLD.server_id
    OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.action_name IS DISTINCT FROM OLD.action_name
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.policy_source IS DISTINCT FROM OLD.policy_source
    OR NEW.policy_decision IS DISTINCT FROM OLD.policy_decision
    OR NEW.action_fingerprint IS DISTINCT FROM OLD.action_fingerprint
  THEN
    RAISE EXCEPTION 'connector action request identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.execution_attempt_id IS NOT NULL AND (
    NEW.execution_attempt_id IS DISTINCT FROM OLD.execution_attempt_id
    OR NEW.execution_attempt_generation IS DISTINCT FROM OLD.execution_attempt_generation
  ) THEN
    RAISE EXCEPTION 'connector action execution attempt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.decision IS NOT NULL AND (
    NEW.decision IS DISTINCT FROM OLD.decision
    OR NEW.decision_by_subject_id IS DISTINCT FROM OLD.decision_by_subject_id
    OR NEW.decision_event_id IS DISTINCT FROM OLD.decision_event_id
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decision_by_kind IS DISTINCT FROM OLD.decision_by_kind
    OR NEW.decision_by_signed_in_person IS DISTINCT FROM OLD.decision_by_signed_in_person
  ) THEN
    RAISE EXCEPTION 'connector action approval decision is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE "session_turn_app_action_grants" (
  "turn_id" uuid PRIMARY KEY REFERENCES "session_turns"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL CHECK (char_length("subject_id") BETWEEN 1 AND 1024),
  "changes" text NOT NULL CHECK ("changes" IN ('confirm', 'none')),
  "permissions" text[] NOT NULL CHECK (cardinality("permissions") <= 512),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "session_turn_app_action_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_app_action_grants" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "session_turn_app_action_grants" FROM PUBLIC;
CREATE POLICY workspace_isolation ON "session_turn_app_action_grants"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_turn_app_action_grants TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
