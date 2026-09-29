-- deployment-mode: rolling
-- Source-session native Slack task-file upload ledger. The existing interaction
-- owns the destination; connection_id may point to an installation HOME in a
-- different workspace. Never persist file bytes or an expiring upload URL.
-- The private relation leaves older binaries' public table inventory unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.slack_file_upload_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  subject_id text NOT NULL,
  operation_id uuid NOT NULL,
  request_digest text NOT NULL,
  phase text NOT NULL DEFAULT 'pending',
  slack_file_id text,
  claim_holder_id uuid,
  claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_file_upload_operations_session_fk FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT slack_file_upload_operations_interaction_fk FOREIGN KEY (account_id, workspace_id, interaction_id)
    REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT slack_file_upload_operations_file_fk FOREIGN KEY (account_id, workspace_id, file_id)
    REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT slack_file_upload_operations_bounds_check CHECK (
    octet_length(subject_id) BETWEEN 1 AND 1024
    AND length(btrim(subject_id)) > 0
    AND request_digest ~ '^[a-f0-9]{64}$'
    AND (slack_file_id IS NULL OR (
      octet_length(slack_file_id) BETWEEN 1 AND 128 AND length(btrim(slack_file_id)) > 0
    ))
  ),
  CONSTRAINT slack_file_upload_operations_state_check CHECK (
    phase IN ('pending', 'uploading', 'uploaded', 'completing', 'outcome_unknown', 'completed')
    AND ((phase = 'pending') = (slack_file_id IS NULL))
    AND ((claim_holder_id IS NULL) = (claim_expires_at IS NULL))
    AND (phase <> 'completed' OR claim_holder_id IS NULL)
  )
);
CREATE UNIQUE INDEX slack_file_upload_operations_workspace_operation_uq
  ON opengeni_private.slack_file_upload_operations(workspace_id, operation_id);
CREATE INDEX slack_file_upload_operations_session_idx
  ON opengeni_private.slack_file_upload_operations(workspace_id, session_id);

ALTER TABLE opengeni_private.slack_file_upload_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.slack_file_upload_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON opengeni_private.slack_file_upload_operations
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.account_id = slack_file_upload_operations.account_id
        AND s.workspace_id = slack_file_upload_operations.workspace_id
        AND s.id = slack_file_upload_operations.session_id
    )
    AND EXISTS (
      SELECT 1 FROM slack_interactions i
      WHERE i.account_id = slack_file_upload_operations.account_id
        AND i.workspace_id = slack_file_upload_operations.workspace_id
        AND i.id = slack_file_upload_operations.interaction_id
        AND i.session_id = slack_file_upload_operations.session_id
        AND i.connection_id = slack_file_upload_operations.connection_id
        AND (
          i.visibility <> 'private'
          OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL
          OR i.owning_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          OR i.owning_subject_id = nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        )
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.account_id = slack_file_upload_operations.account_id
        AND s.workspace_id = slack_file_upload_operations.workspace_id
        AND s.id = slack_file_upload_operations.session_id
    )
    AND EXISTS (
      SELECT 1 FROM slack_interactions i
      WHERE i.account_id = slack_file_upload_operations.account_id
        AND i.workspace_id = slack_file_upload_operations.workspace_id
        AND i.id = slack_file_upload_operations.interaction_id
        AND i.session_id = slack_file_upload_operations.session_id
        AND i.connection_id = slack_file_upload_operations.connection_id
        AND (
          i.visibility <> 'private'
          OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL
          OR i.owning_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          OR i.owning_subject_id = nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        )
    )
  );

-- Ordinary invoker RLS also protects raw inserts. No SECURITY DEFINER bypass,
-- arbitrary destination, cross-workspace connection lookup, or provider retry.
-- Bindings are immutable and completion is an absorbing state. Only unshared
-- allocations in uploading may be replaced; uploaded recovery retains its id.
-- Keep the invoker trigger in the data schema: old posture evaluators enumerate
-- every private function and would require EXECUTE on an unknown private guard.
CREATE FUNCTION guard_slack_file_upload_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  IF NEW.claim_expires_at > clock_timestamp() + interval '120 seconds' THEN
    RAISE EXCEPTION 'Slack file upload lease exceeds bound' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'pending' OR NEW.slack_file_id IS NOT NULL THEN
      RAISE EXCEPTION 'Slack file upload must start pending' USING ERRCODE = '23514';
    END IF;
    PERFORM 1 FROM slack_interactions i JOIN sessions s
      ON s.account_id = i.account_id AND s.workspace_id = i.workspace_id AND s.id = i.session_id
      WHERE i.account_id = NEW.account_id AND i.workspace_id = NEW.workspace_id
        AND i.id = NEW.interaction_id AND i.session_id = NEW.session_id
        AND i.connection_id = NEW.connection_id
      FOR SHARE OF i, s;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Slack file upload interaction unavailable' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM files f WHERE f.account_id = NEW.account_id
      AND f.workspace_id = NEW.workspace_id AND f.id = NEW.file_id AND f.status = 'ready'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Slack file upload source file unavailable' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.interaction_id,
      NEW.connection_id, NEW.file_id, NEW.subject_id, NEW.operation_id, NEW.request_digest, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.workspace_id, OLD.session_id, OLD.interaction_id,
        OLD.connection_id, OLD.file_id, OLD.subject_id, OLD.operation_id, OLD.request_digest, OLD.created_at)
    THEN RAISE EXCEPTION 'Slack file upload binding is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.phase = 'completed' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Slack file upload is completed' USING ERRCODE = '23514';
    END IF;
    IF NEW.phase IS DISTINCT FROM OLD.phase AND NOT (
      (OLD.phase = 'pending' AND NEW.phase = 'uploading')
      OR (OLD.phase = 'uploading' AND NEW.phase = 'uploaded')
      OR (OLD.phase = 'uploaded' AND NEW.phase = 'completing')
      OR (OLD.phase = 'completing' AND NEW.phase IN ('outcome_unknown', 'completed'))
      OR (OLD.phase = 'outcome_unknown' AND NEW.phase = 'completed')
    ) THEN RAISE EXCEPTION 'Slack file upload transition refused' USING ERRCODE = '23514'; END IF;
    IF NEW.slack_file_id IS DISTINCT FROM OLD.slack_file_id
      AND NOT (OLD.phase IN ('pending', 'uploading') AND NEW.phase = 'uploading')
    THEN RAISE EXCEPTION 'Slack file upload allocation is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.phase IS DISTINCT FROM OLD.phase OR NEW.slack_file_id IS DISTINCT FROM OLD.slack_file_id THEN
      -- Expired completing is allowed only to become uncertain, never to retry.
      IF NOT (OLD.phase = 'completing' AND NEW.phase = 'outcome_unknown')
        AND (OLD.claim_holder_id IS NULL OR OLD.claim_expires_at <= clock_timestamp())
      THEN RAISE EXCEPTION 'Slack file upload claim expired' USING ERRCODE = '23514'; END IF;
      IF NEW.phase NOT IN ('completed', 'outcome_unknown')
        AND NEW.claim_holder_id IS DISTINCT FROM OLD.claim_holder_id
      THEN RAISE EXCEPTION 'Slack file upload claim changed' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER slack_file_upload_operations_guard
  BEFORE INSERT OR UPDATE ON opengeni_private.slack_file_upload_operations
  FOR EACH ROW EXECUTE FUNCTION guard_slack_file_upload_operation();
REVOKE ALL ON TABLE opengeni_private.slack_file_upload_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_slack_file_upload_operation() FROM PUBLIC;

DO $posture$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.guard_slack_file_upload_operation() SET search_path = pg_catalog, %I, pg_temp', target_schema, target_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.slack_file_upload_operations FROM opengeni_app;
    EXECUTE format('REVOKE ALL ON FUNCTION %I.guard_slack_file_upload_operation() FROM opengeni_app', target_schema);
    GRANT SELECT, INSERT, UPDATE ON TABLE opengeni_private.slack_file_upload_operations TO opengeni_app;
  END IF;
END
$posture$;