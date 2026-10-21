-- deployment-mode: rolling
-- Display metadata has its own durable owner, not the source conversation lease.
SET LOCAL lock_timeout = '5s';

CREATE TABLE session_title_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  source_execution_generation bigint NOT NULL CHECK (source_execution_generation > 0),
  provider text NOT NULL,
  connection_id uuid,
  request_encrypted text,
  response_encrypted text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'dispatching', 'responded', 'completed', 'failed', 'unknown')),
  holder_id text,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  leased_until timestamptz,
  request_operation_id uuid,
  workflow_retry_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_title_operations_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT session_title_operations_session_fk
    FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT session_title_operations_turn_fk
    FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT session_title_operations_attempt_fk
    FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT session_title_operations_lease_chk CHECK (
    (holder_id IS NULL) = (leased_until IS NULL)
    AND (holder_id IS NULL OR octet_length(holder_id) BETWEEN 1 AND 256)
  ),
  CONSTRAINT session_title_operations_payload_chk CHECK (
    state NOT IN ('pending', 'dispatching', 'responded') OR request_encrypted IS NOT NULL
  )
);
-- Only one active naming operation. A later accepted turn may retry a failed
-- title, but recovery of an uncertain operation never resends that operation.
CREATE UNIQUE INDEX session_title_operations_session_uq
  ON session_title_operations(workspace_id, session_id)
  WHERE state IN ('pending', 'dispatching', 'responded');
CREATE UNIQUE INDEX session_title_operations_source_uq
  ON session_title_operations(workspace_id, source_turn_id);
CREATE INDEX session_title_operations_recovery_idx ON session_title_operations(workflow_retry_at, id)
  WHERE state IN ('pending', 'dispatching', 'responded');
ALTER TABLE session_title_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_title_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON session_title_operations
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON session_title_operations AS RESTRICTIVE
  FOR ALL USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

DO $guard$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.guard_session_title_operation()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'pending' OR NEW.generation <> 0 OR NEW.holder_id IS NOT NULL
          OR NEW.request_operation_id IS NOT NULL OR NEW.response_encrypted IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM session_turns turn
            JOIN sessions session ON session.account_id = turn.account_id
              AND session.workspace_id = turn.workspace_id AND session.id = turn.session_id
            JOIN session_turn_attempts attempt ON attempt.account_id = turn.account_id
              AND attempt.workspace_id = turn.workspace_id AND attempt.turn_id = turn.id
              AND attempt.session_id = session.id AND attempt.id = turn.active_attempt_id
            WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
              AND turn.session_id = NEW.session_id AND turn.id = NEW.source_turn_id
              AND turn.status = 'running' AND session.status = 'running'
              AND session.active_turn_id = turn.id AND attempt.state IN ('claimed', 'running')
              AND attempt.id = NEW.source_attempt_id
              AND attempt.execution_generation = NEW.source_execution_generation
              AND turn.execution_generation = NEW.source_execution_generation
          ) THEN
          RAISE EXCEPTION 'session title requires the live source attempt' USING ERRCODE = '42501';
        END IF;
        IF NEW.connection_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM subscription_leases lease
          WHERE lease.account_id = NEW.account_id AND lease.workspace_id = NEW.workspace_id
            AND lease.session_id = NEW.session_id AND lease.turn_id = NEW.source_turn_id
            AND lease.provider = NEW.provider AND lease.connection_id = NEW.connection_id
            AND lease.leased_until > clock_timestamp()
        ) THEN
          RAISE EXCEPTION 'session title requires the selected live subscription lease' USING ERRCODE = '42501';
        END IF;
      ELSE
        IF ROW(NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.source_turn_id,
          NEW.source_attempt_id, NEW.source_execution_generation, NEW.provider, NEW.connection_id)
          IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.workspace_id, OLD.session_id,
          OLD.source_turn_id, OLD.source_attempt_id, OLD.source_execution_generation,
          OLD.provider, OLD.connection_id)
          OR (NEW.request_encrypted IS DISTINCT FROM OLD.request_encrypted
            AND NOT (NEW.request_encrypted IS NULL AND NEW.state IN ('completed', 'failed', 'unknown')))
          OR (OLD.request_operation_id IS NOT NULL AND NEW.request_operation_id IS DISTINCT FROM OLD.request_operation_id
            AND NOT (OLD.state = 'dispatching' AND NEW.state = 'dispatching'
              AND OLD.holder_id = NEW.holder_id AND OLD.generation = NEW.generation
              AND OLD.leased_until > clock_timestamp()
              AND EXISTS (SELECT 1 FROM subscription_operation_leases request
                WHERE request.account_id = OLD.account_id AND request.workspace_id = OLD.workspace_id
                  AND request.operation_id = OLD.request_operation_id
                  AND request.request_outcome = 'refused')))
          OR (OLD.state IN ('completed', 'failed', 'unknown') AND NEW IS DISTINCT FROM OLD)
        THEN
          RAISE EXCEPTION 'session title admission is immutable' USING ERRCODE = '55000';
        END IF;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$guard$;
REVOKE ALL ON FUNCTION opengeni_private.guard_session_title_operation() FROM PUBLIC;
CREATE TRIGGER session_title_operation_admission
  BEFORE INSERT OR UPDATE ON session_title_operations
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_session_title_operation();

ALTER TABLE subscription_operation_leases
  DROP CONSTRAINT subscription_operation_leases_kind_chk,
  ADD CONSTRAINT subscription_operation_leases_kind_chk CHECK (
    operation_kind IN ('image', 'video', 'realtime', 'transcription', 'model',
      'credential_request', 'apps', 'completion', 'session_title')
    AND (operation_kind NOT IN ('apps', 'completion') OR provider = 'codex')
    AND (operation_kind <> 'session_title' OR turn_id IS NOT NULL)
  ) NOT VALID;
ALTER TABLE subscription_operation_leases VALIDATE CONSTRAINT subscription_operation_leases_kind_chk;

-- Keep the canonical credential seam, including its live visibility, personal
-- grant, disconnection and cutover checks. Only the source-turn liveness test
-- differs for a separately admitted title job. No secret-bearing new function.
DO $title_authority$
DECLARE
  definition text;
  old_branch text := E'        IF turn_bound THEN\n          SELECT session.owner_subject_id INTO session_owner';
  new_branch text := $branch$        IF turn_bound AND operation_lease.operation_kind = 'session_title' THEN
          SELECT session.owner_subject_id INTO session_owner
          FROM session_title_operations title
          JOIN sessions session ON session.account_id = title.account_id
            AND session.workspace_id = title.workspace_id AND session.id = title.session_id
          WHERE title.account_id = p_account_id AND title.workspace_id = p_workspace_id
            AND title.id = operation_lease.operation_id
            AND title.session_id = operation_lease.session_id
            AND title.source_turn_id = operation_lease.turn_id
            AND title.source_attempt_id = operation_lease.attempt_id
            AND title.provider = p_provider AND title.connection_id = p_connection_id
            AND title.holder_id = operation_lease.holder_id
            AND title.generation = operation_lease.generation
            AND title.leased_until > clock_timestamp()
            AND title.state IN ('pending', 'dispatching')
            AND session.content_archive_state IS NULL;
          IF NOT FOUND THEN RETURN; END IF;
        ELSIF turn_bound THEN
          SELECT session.owner_subject_id INTO session_owner$branch$;
BEGIN
  definition := pg_get_functiondef('opengeni_subscription_internal.subscription_core_connection_target(text,uuid,uuid,uuid,uuid,uuid,text,bigint)'::regprocedure);
  IF position(old_branch IN definition) = 0 THEN
    RAISE EXCEPTION 'session title credential seam does not match the reviewed source';
  END IF;
  EXECUTE replace(definition, old_branch, new_branch);
END
$title_authority$;

-- The reference trigger also enforces the live-turn predicate when a lease is
-- acquired or reclaimed. Request rows use the one id reserved atomically in
-- the title ledger, while the owner lease uses the title id itself.
DO $title_lease$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.guard_subscription_operation_lease_reference()'::regprocedure);
  anchor := $old$IF turn_status IS DISTINCT FROM 'running'
            OR turn_attempt IS DISTINCT FROM NEW.attempt_id
            OR turn_generation IS DISTINCT FROM NEW.generation
            OR NOT EXISTS (
              SELECT 1 FROM subscription_leases chat
              WHERE chat.account_id = NEW.account_id AND chat.workspace_id = NEW.workspace_id
                AND chat.session_id = NEW.session_id AND chat.turn_id = NEW.turn_id
                AND chat.provider = NEW.provider AND chat.connection_id = NEW.connection_id
                AND chat.leased_until > pg_catalog.clock_timestamp()
            )$old$;
  replacement := $new$IF (CASE WHEN NEW.operation_kind = 'session_title' THEN NOT EXISTS (
              SELECT 1 FROM session_title_operations title
              JOIN sessions session ON session.account_id = title.account_id
                AND session.workspace_id = title.workspace_id AND session.id = title.session_id
              WHERE title.account_id = NEW.account_id AND title.workspace_id = NEW.workspace_id
                AND ((NEW.request_id IS NULL AND title.id = NEW.operation_id)
                  OR (NEW.request_id IS NOT NULL AND title.request_operation_id = NEW.operation_id))
                AND title.session_id = NEW.session_id AND title.source_turn_id = NEW.turn_id
                AND title.source_attempt_id = NEW.attempt_id
                AND title.provider = NEW.provider AND title.connection_id = NEW.connection_id
                AND title.holder_id = NEW.holder_id AND title.generation = NEW.generation
                AND title.leased_until > clock_timestamp()
                AND title.state IN ('pending', 'dispatching') AND session.content_archive_state IS NULL
            ) ELSE (turn_status IS DISTINCT FROM 'running'
            OR turn_attempt IS DISTINCT FROM NEW.attempt_id
            OR turn_generation IS DISTINCT FROM NEW.generation
            OR NOT EXISTS (
              SELECT 1 FROM subscription_leases chat
              WHERE chat.account_id = NEW.account_id AND chat.workspace_id = NEW.workspace_id
                AND chat.session_id = NEW.session_id AND chat.turn_id = NEW.turn_id
                AND chat.provider = NEW.provider AND chat.connection_id = NEW.connection_id
                AND chat.leased_until > pg_catalog.clock_timestamp()
            )) END)$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'session title lease seam does not match the reviewed source';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$title_lease$;

-- Content-free workflow repair. This does not claim the provider job or admit
-- another request; it only retries the same deterministic workflow start.
DO $recovery$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.claim_session_title_workflows(p_limit integer)
    RETURNS TABLE(operation_id uuid, account_id uuid, workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid title recovery batch'; END IF;
      RETURN QUERY WITH candidates AS (
        SELECT title.id FROM session_title_operations title
        WHERE title.state IN ('pending', 'dispatching', 'responded')
          AND title.workflow_retry_at <= clock_timestamp()
        ORDER BY title.workflow_retry_at, title.id
        FOR UPDATE SKIP LOCKED LIMIT p_limit
      ), claimed AS (
        UPDATE session_title_operations title SET workflow_retry_at = clock_timestamp() + interval '2 minutes'
        FROM candidates WHERE title.id = candidates.id
        RETURNING title.id, title.account_id, title.workspace_id
      ) SELECT claimed.id, claimed.account_id, claimed.workspace_id FROM claimed;
    END
    $body$
  $ddl$, data_schema);
END
$recovery$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_title_workflows(integer) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON session_title_operations TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_title_workflows(integer) TO opengeni_app;
  END IF;
END
$grants$;
