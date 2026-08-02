-- deployment-mode: rolling
-- Attempt-frozen connector action policy and secret-free execution evidence.

CREATE TABLE connector_action_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id text NOT NULL,
  server_id text NOT NULL,
  tool_name text NOT NULL,
  action_name text NOT NULL,
  policy text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by_subject_id text NOT NULL,
  updated_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_action_policies_connection_id_chk
    CHECK (octet_length(btrim(connection_id)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_policies_server_id_chk
    CHECK (octet_length(btrim(server_id)) BETWEEN 1 AND 256),
  CONSTRAINT connector_action_policies_tool_name_chk
    CHECK (octet_length(btrim(tool_name)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_policies_action_name_chk
    CHECK (octet_length(btrim(action_name)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_policies_policy_chk
    CHECK (policy IN ('allow', 'ask', 'block')),
  CONSTRAINT connector_action_policies_version_chk CHECK (version > 0),
  CONSTRAINT connector_action_policies_creator_chk
    CHECK (octet_length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024),
  CONSTRAINT connector_action_policies_updater_chk
    CHECK (octet_length(btrim(updated_by_subject_id)) BETWEEN 1 AND 1024),
  CONSTRAINT connector_action_policies_scope_uq
    UNIQUE (workspace_id, connection_id, server_id, tool_name, action_name)
);

CREATE INDEX connector_action_policies_workspace_connection_idx
  ON connector_action_policies(workspace_id, connection_id, server_id);

ALTER TABLE session_turn_attempts
  ADD COLUMN connector_action_policies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT session_turn_attempts_connector_action_policies_chk
    CHECK (
      jsonb_typeof(connector_action_policies) = 'array'
      AND jsonb_array_length(connector_action_policies) <= 2048
    );

CREATE TABLE connector_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  creation_attempt_id uuid NOT NULL,
  creation_execution_generation integer NOT NULL,
  execution_attempt_id uuid,
  execution_attempt_generation integer,
  approval_id text NOT NULL,
  initiator_kind text NOT NULL,
  initiator_subject_id text NOT NULL,
  connection_id text NOT NULL,
  connection_version integer,
  server_id text NOT NULL,
  tool_name text NOT NULL,
  action_name text NOT NULL,
  -- Snapshot provenance intentionally has no FK: a policy may be changed or
  -- deleted after claim, while the attempt-frozen decision remains executable.
  policy_id uuid,
  policy_version integer,
  policy_source text NOT NULL,
  policy_decision text NOT NULL,
  action_fingerprint text NOT NULL,
  status text NOT NULL,
  decision text,
  decision_by_subject_id text,
  -- Durable provenance UUID; session-event retention must not rewrite a settled
  -- connector decision or trip the immutable-decision trigger.
  decision_event_id uuid,
  decided_at timestamptz,
  execution_started_at timestamptz,
  execution_finished_at timestamptz,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_action_requests_creation_attempt_fk
    FOREIGN KEY (account_id, workspace_id, session_id, turn_id, creation_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id)
    ON DELETE CASCADE,
  CONSTRAINT connector_action_requests_execution_attempt_fk
    FOREIGN KEY (account_id, workspace_id, session_id, turn_id, execution_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id)
    ON DELETE CASCADE,
  CONSTRAINT connector_action_requests_identity_uq
    UNIQUE (workspace_id, session_id, turn_id, approval_id),
  CONSTRAINT connector_action_requests_creation_generation_chk
    CHECK (creation_execution_generation > 0),
  CONSTRAINT connector_action_requests_execution_attempt_chk
    CHECK (
      (execution_attempt_id IS NULL AND execution_attempt_generation IS NULL)
      OR
      (execution_attempt_id IS NOT NULL AND execution_attempt_generation > 0)
    ),
  CONSTRAINT connector_action_requests_approval_id_chk
    CHECK (octet_length(btrim(approval_id)) BETWEEN 1 AND 1024),
  CONSTRAINT connector_action_requests_initiator_kind_chk
    CHECK (initiator_kind IN ('subject', 'service')),
  CONSTRAINT connector_action_requests_initiator_subject_chk
    CHECK (octet_length(btrim(initiator_subject_id)) BETWEEN 1 AND 1024),
  CONSTRAINT connector_action_requests_connection_id_chk
    CHECK (octet_length(btrim(connection_id)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_requests_connection_version_chk
    CHECK (connection_version IS NULL OR connection_version > 0),
  CONSTRAINT connector_action_requests_server_id_chk
    CHECK (octet_length(btrim(server_id)) BETWEEN 1 AND 256),
  CONSTRAINT connector_action_requests_tool_name_chk
    CHECK (octet_length(btrim(tool_name)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_requests_action_name_chk
    CHECK (octet_length(btrim(action_name)) BETWEEN 1 AND 512),
  CONSTRAINT connector_action_requests_policy_version_chk
    CHECK (policy_version IS NULL OR policy_version > 0),
  CONSTRAINT connector_action_requests_policy_source_chk
    CHECK (policy_source IN ('explicit', 'ambiguous')),
  CONSTRAINT connector_action_requests_policy_decision_chk
    CHECK (policy_decision IN ('allow', 'ask', 'block')),
  CONSTRAINT connector_action_requests_fingerprint_chk
    CHECK (action_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT connector_action_requests_status_chk
    CHECK (status IN (
      'pending', 'approved', 'rejected', 'blocked', 'executing',
      'completed', 'failed', 'uncertain'
    )),
  CONSTRAINT connector_action_requests_decision_chk
    CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  CONSTRAINT connector_action_requests_decision_consistency_chk
    CHECK (
      (decision IS NULL AND decision_by_subject_id IS NULL AND decision_event_id IS NULL AND decided_at IS NULL)
      OR
      (decision IS NOT NULL AND decision_by_subject_id IS NOT NULL AND decision_event_id IS NOT NULL AND decided_at IS NOT NULL)
    )
);

CREATE INDEX connector_action_requests_attempt_status_idx
  ON connector_action_requests(workspace_id, creation_attempt_id, status);
CREATE INDEX connector_action_requests_session_created_idx
  ON connector_action_requests(workspace_id, session_id, created_at DESC, id DESC);

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
  ) THEN
    RAISE EXCEPTION 'connector action approval decision is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_action_requests_identity_immutable
  BEFORE UPDATE ON connector_action_requests
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation();

ALTER TABLE connector_action_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_action_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_action_policies_workspace_isolation ON connector_action_policies
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE connector_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_action_requests_workspace_isolation ON connector_action_requests
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON connector_action_policies TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON connector_action_requests TO opengeni_app;
  END IF;
END $$;