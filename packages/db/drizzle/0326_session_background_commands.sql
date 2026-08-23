-- deployment-mode: rolling
-- Durable session-owned background commands. The command row is the
-- provider-neutral lifecycle/control authority; managed commands link one-to-one
-- to the exact retained process that still owns immutable launch authority.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE session_background_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider text NOT NULL,
  state text NOT NULL DEFAULT 'running',
  retained_process_id uuid,
  control_workspace_id uuid,
  enrollment_id uuid,
  connection_instance_id text,
  op_id text,
  command_preview text NOT NULL DEFAULT '',
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  exit_code integer,
  settlement_reason text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  reconcile_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  reconcile_claim_id uuid,
  reconcile_claimed_at timestamptz,
  reconcile_attempts integer NOT NULL DEFAULT 0,
  last_reconcile_outcome text,
  reconcile_proof_outcome text,
  reconcile_proof_exit_code integer,
  reconcile_proof_reason text,
  reconcile_proof_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT session_background_commands_workspace_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT session_background_commands_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT session_background_commands_control_workspace_fk
    FOREIGN KEY (control_workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT session_background_commands_process_fk
    FOREIGN KEY (retained_process_id)
    REFERENCES sandbox_retained_processes(id) ON DELETE RESTRICT,
  CONSTRAINT session_background_commands_provider_check CHECK (
    provider IN ('managed', 'connected_machine')
  ),
  CONSTRAINT session_background_commands_state_check CHECK (
    state IN ('running', 'stopping', 'exited', 'lost')
  ),
  CONSTRAINT session_background_commands_provider_identity_check CHECK (
    (
      provider = 'managed'
      AND retained_process_id IS NOT NULL
      AND control_workspace_id IS NULL
      AND enrollment_id IS NULL
      AND connection_instance_id IS NULL
      AND op_id IS NULL
    ) OR (
      provider = 'connected_machine'
      AND retained_process_id IS NULL
      AND control_workspace_id IS NOT NULL
      AND enrollment_id IS NOT NULL
      AND connection_instance_id IS NOT NULL
      AND octet_length(connection_instance_id) BETWEEN 1 AND 128
      AND op_id IS NOT NULL
      AND octet_length(op_id) BETWEEN 1 AND 256
    )
  ),
  CONSTRAINT session_background_commands_lifecycle_check CHECK (
    (
      state = 'running'
      AND cancel_requested_at IS NULL
      AND cancel_requested_by IS NULL
      AND exit_code IS NULL
      AND settlement_reason IS NULL
      AND settled_at IS NULL
    ) OR (
      state = 'stopping'
      AND cancel_requested_at IS NOT NULL
      AND cancel_requested_by IS NOT NULL
      AND octet_length(btrim(cancel_requested_by)) BETWEEN 1 AND 1024
      AND exit_code IS NULL
      AND settlement_reason IS NULL
      AND settled_at IS NULL
    ) OR (
      state = 'exited'
      AND settled_at IS NOT NULL
      AND octet_length(btrim(settlement_reason)) BETWEEN 1 AND 512
    ) OR (
      state = 'lost'
      AND exit_code IS NULL
      AND settled_at IS NOT NULL
      AND octet_length(btrim(settlement_reason)) BETWEEN 1 AND 512
    )
  ),
  CONSTRAINT session_background_commands_preview_check CHECK (
    octet_length(command_preview) <= 2048
  ),
  CONSTRAINT session_background_commands_reconcile_check CHECK (
    reconcile_attempts >= 0
    AND (
      (reconcile_claim_id IS NULL AND reconcile_claimed_at IS NULL)
      OR (reconcile_claim_id IS NOT NULL AND reconcile_claimed_at IS NOT NULL)
    )
    AND (
      last_reconcile_outcome IS NULL
      OR octet_length(last_reconcile_outcome) BETWEEN 1 AND 64
    )
    AND (
      (
        reconcile_proof_outcome IS NULL
        AND reconcile_proof_exit_code IS NULL
        AND reconcile_proof_reason IS NULL
        AND reconcile_proof_observed_at IS NULL
      ) OR (
        reconcile_proof_outcome = 'exited'
        AND reconcile_proof_exit_code IS NOT NULL
        AND octet_length(btrim(reconcile_proof_reason)) BETWEEN 1 AND 512
        AND reconcile_proof_observed_at IS NOT NULL
      ) OR (
        reconcile_proof_outcome = 'lost'
        AND reconcile_proof_exit_code IS NULL
        AND octet_length(btrim(reconcile_proof_reason)) BETWEEN 1 AND 512
        AND reconcile_proof_observed_at IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX session_background_commands_process_uq
  ON session_background_commands (retained_process_id)
  WHERE retained_process_id IS NOT NULL;
CREATE UNIQUE INDEX session_background_commands_connected_op_uq
  ON session_background_commands (
    control_workspace_id, enrollment_id, connection_instance_id, op_id
  ) WHERE provider = 'connected_machine';
CREATE INDEX session_background_commands_active_session_idx
  ON session_background_commands (workspace_id, session_id, state, started_at, id)
  WHERE state IN ('running', 'stopping');
CREATE INDEX session_background_commands_stopping_idx
  ON session_background_commands (reconcile_after, cancel_requested_at, id)
  WHERE state IN ('running', 'stopping');

ALTER TABLE session_background_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_background_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON session_background_commands
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON session_background_commands AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

DO $grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_background_commands TO opengeni_app',
      data_schema
    );
  END IF;
END
$grants$;

COMMENT ON TABLE session_background_commands IS
  'Provider-neutral durable lifecycle for commands explicitly transferred from a turn to its session.';
COMMENT ON COLUMN session_background_commands.retained_process_id IS
  'Managed provider link. The retained process preserves immutable launch authority and exact provider identity.';
COMMENT ON COLUMN session_background_commands.connection_instance_id IS
  'Connected Machine daemon instance admitted at launch; switching the session machine never rewrites it.';
COMMENT ON COLUMN session_background_commands.control_workspace_id IS
  'Connected Machine origin workspace used in the exact physical NATS subject; never rewritten from the session workspace.';

DO $settlement_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.settle_background_command_from_retained_process()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF OLD.state = 'active' AND NEW.state IN ('exited', 'lost') THEN
        UPDATE %1$I.session_background_commands command SET
          state = NEW.state,
          exit_code = CASE WHEN NEW.state = 'exited' THEN NEW.exit_code ELSE NULL END,
          settlement_reason = NEW.settlement_reason,
          settled_at = NEW.settled_at,
          reconcile_claim_id = NULL,
          reconcile_claimed_at = NULL,
          last_reconcile_outcome = 'settled_' || NEW.state,
          updated_at = pg_catalog.clock_timestamp()
        WHERE command.retained_process_id = NEW.id
          AND command.state IN ('running', 'stopping');
      END IF;
      RETURN NEW;
    END
    $function$;
  $create$, data_schema);
END
$settlement_function$;

CREATE TRIGGER settle_background_command_from_retained_process
AFTER UPDATE OF state, exit_code, settlement_reason, settled_at
ON sandbox_retained_processes
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.settle_background_command_from_retained_process();

REVOKE ALL ON FUNCTION opengeni_private.settle_background_command_from_retained_process()
  FROM PUBLIC;

-- Background-owned managed processes remain eligible for exact polling even
-- while their launch attempt is open/closed independently. Stopping state is
-- projected through owner_state so the reaper can issue one exact cancellation
-- before observing terminal proof.
DO $claim_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_terminal_retained_processes(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      process_id uuid,
      claim_id uuid,
      owner_state text,
      owner_attempt_outcome text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'retained-process reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'retained-process reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      RETURN QUERY
      WITH candidate_window AS MATERIALIZED (
        SELECT process.id,
          process.workspace_id,
          process.parent_admission_id,
          process.owner_actor_kind,
          process.owner_turn_id,
          process.owner_attempt_id,
          process.reconcile_after AS due_at,
          process.started_at
        FROM %1$I.sandbox_retained_processes process
        WHERE process.state = 'active'
          AND process.reconcile_after <= pg_catalog.now()
        ORDER BY process.reconcile_after, process.started_at, process.id
        FOR UPDATE OF process SKIP LOCKED
        LIMIT p_limit
      ), classified AS MATERIALIZED (
        SELECT candidate.id,
          candidate.due_at,
          candidate.started_at,
          command.state AS command_state,
          command.id IS NOT NULL OR CASE
            WHEN candidate.owner_actor_kind = 'direct' THEN direct_owner.live IS NULL
            ELSE attempt.state = 'closed'
          END AS eligible,
          CASE
            WHEN command.state = 'stopping' THEN 'background_stopping'
            WHEN command.state = 'running' THEN 'background_running'
            WHEN candidate.owner_actor_kind = 'direct' THEN 'direct'
            ELSE COALESCE(turn_row.status, 'missing')
          END AS owner_state,
          attempt.outcome AS owner_attempt_outcome
        FROM candidate_window candidate
        LEFT JOIN %1$I.session_background_commands command
          ON command.retained_process_id = candidate.id
         AND command.state IN ('running', 'stopping')
        LEFT JOIN LATERAL (
          SELECT true AS live
          FROM %1$I.sandbox_workspace_mutation_admissions admission
          JOIN %1$I.sandbox_lease_holders holder
            ON holder.lease_id = admission.lease_id
           AND holder.account_id = admission.account_id
           AND holder.workspace_id = admission.workspace_id
           AND holder.kind = 'direct'
           AND holder.holder_id = admission.holder_id
           AND holder.subject_id = admission.session_id
          WHERE candidate.owner_actor_kind = 'direct'
            AND admission.id = candidate.parent_admission_id
            AND admission.actor_kind = 'direct'
          LIMIT 1
        ) direct_owner ON true
        LEFT JOIN LATERAL (
          SELECT source_turn.status
          FROM %1$I.session_turns source_turn
          WHERE source_turn.workspace_id = candidate.workspace_id
            AND source_turn.id = candidate.owner_turn_id
          LIMIT 1
        ) turn_row ON true
        LEFT JOIN LATERAL (
          SELECT source_attempt.state, source_attempt.outcome
          FROM %1$I.session_turn_attempts source_attempt
          WHERE source_attempt.workspace_id = candidate.workspace_id
            AND source_attempt.id = candidate.owner_attempt_id
          LIMIT 1
        ) attempt ON true
      ), inspected AS (
        UPDATE %1$I.sandbox_retained_processes process SET
          reconcile_after = CASE
            WHEN classified.eligible THEN pg_catalog.now()
              + pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
            ELSE pg_catalog.now() + interval '30 seconds'
          END,
          reconcile_claim_id = CASE WHEN classified.eligible THEN p_claim_id ELSE NULL END,
          reconcile_claimed_at = CASE
            WHEN classified.eligible THEN pg_catalog.now() ELSE NULL
          END,
          reconcile_attempts = process.reconcile_attempts
            + CASE WHEN classified.eligible THEN 1 ELSE 0 END,
          last_reconcile_outcome = CASE
            WHEN classified.eligible THEN 'claimed' ELSE 'owner_active'
          END
        FROM classified
        WHERE process.id = classified.id
          AND process.state = 'active'
        RETURNING process.account_id,
          process.workspace_id,
          process.session_id,
          process.id,
          process.reconcile_claim_id,
          classified.due_at,
          classified.started_at,
          classified.eligible,
          classified.owner_state,
          classified.owner_attempt_outcome
      )
      SELECT inspected.account_id,
        inspected.workspace_id,
        inspected.session_id,
        inspected.id,
        inspected.reconcile_claim_id,
        inspected.owner_state,
        inspected.owner_attempt_outcome
      FROM inspected
      WHERE inspected.eligible
      ORDER BY inspected.due_at, inspected.started_at, inspected.id;

      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 IMMEDIATE;
      SET CONSTRAINTS %1$I.sandbox_retained_processes_identity_v2 DEFERRED;
    END;
    $function$;
  $create$, data_schema);
END
$claim_function$;

-- Connected Machine commands are reconciled directly against the immutable
-- launch locator. Claim expiry recovers a dead reaper only; it is never treated
-- as provider exit/loss evidence.
DO $connected_claim_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_connected_machine_background_commands(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      command_id uuid,
      claim_id uuid,
      command_state text,
      control_workspace_id uuid,
      enrollment_id uuid,
      connection_instance_id text,
      op_id text,
      reconcile_attempts integer,
      reconcile_proof_outcome text,
      reconcile_proof_exit_code integer,
      reconcile_proof_reason text,
      reconcile_proof_observed_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'connected-command reconciliation limit must be between 1 and 100'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms < 0 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'connected-command reconciliation claim TTL is invalid'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
      WITH candidates AS MATERIALIZED (
        SELECT command.id, command.reconcile_after, command.started_at
        FROM %1$I.session_background_commands command
        WHERE command.provider = 'connected_machine'
          AND command.state IN ('running', 'stopping')
          AND command.reconcile_after <= pg_catalog.now()
          AND (
            command.reconcile_claim_id IS NULL
            OR command.reconcile_claimed_at <= pg_catalog.now()
              - pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
          )
        ORDER BY command.reconcile_after, command.started_at, command.id
        FOR UPDATE OF command SKIP LOCKED
        LIMIT p_limit
      ), claimed AS (
        UPDATE %1$I.session_background_commands command SET
          reconcile_after = pg_catalog.now()
            + pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0),
          reconcile_claim_id = p_claim_id,
          reconcile_claimed_at = pg_catalog.now(),
          reconcile_attempts = command.reconcile_attempts + 1,
          last_reconcile_outcome = 'claimed',
          updated_at = pg_catalog.clock_timestamp()
        FROM candidates
        WHERE command.id = candidates.id
          AND command.provider = 'connected_machine'
          AND command.state IN ('running', 'stopping')
        RETURNING command.*, candidates.reconcile_after AS due_at,
          candidates.started_at AS candidate_started_at
      )
      SELECT claimed.account_id,
        claimed.workspace_id,
        claimed.session_id,
        claimed.id,
        claimed.reconcile_claim_id,
        claimed.state,
        claimed.control_workspace_id,
        claimed.enrollment_id,
        claimed.connection_instance_id,
        claimed.op_id,
        claimed.reconcile_attempts,
        claimed.reconcile_proof_outcome,
        claimed.reconcile_proof_exit_code,
        claimed.reconcile_proof_reason,
        claimed.reconcile_proof_observed_at
      FROM claimed
      ORDER BY claimed.due_at, claimed.candidate_started_at, claimed.id;
    END;
    $function$;
  $create$, data_schema);
END
$connected_claim_function$;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(
  uuid, integer, bigint
) FROM PUBLIC;

DO $connected_claim_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_connected_machine_background_commands(
      uuid, integer, bigint
    ) TO opengeni_app;
  END IF;
END
$connected_claim_grant$;