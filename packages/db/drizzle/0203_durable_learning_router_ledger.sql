-- deployment-mode: rolling
-- Immutable, input-hashed durable-learning attempts and receipts. The
-- security-definer admission function holds the exact execution-attempt and
-- initiating-human membership locks until the destination authority mutation
-- and receipt commit in the caller's surrounding transaction.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "durable_learning_attempts" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "operation" text NOT NULL,
  "target_surface" text NOT NULL,
  "input_hash" text NOT NULL,
  "canonical_input" text NOT NULL,
  "request" jsonb NOT NULL,
  "decision" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT "durable_learning_attempts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempts_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempts_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempts_execution_attempt_fk"
    FOREIGN KEY ("workspace_id", "execution_attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempts_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "durable_learning_attempts_operation_chk"
    CHECK ("operation" IN ('write', 'rollback')),
  CONSTRAINT "durable_learning_attempts_surface_chk"
    CHECK ("target_surface" IN (
      'company_profile', 'workspace_instruction_policy', 'preference_registry'
    )),
  CONSTRAINT "durable_learning_attempts_input_hash_chk"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "durable_learning_attempts_generation_chk"
    CHECK ("execution_generation" > 0),
  CONSTRAINT "durable_learning_attempts_actor_chk"
    CHECK (length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024),
  CONSTRAINT "durable_learning_attempts_input_size_chk"
    CHECK (octet_length("canonical_input") BETWEEN 2 AND 524288),
  CONSTRAINT "durable_learning_attempts_shapes_chk"
    CHECK (jsonb_typeof("request") = 'object' AND jsonb_typeof("decision") = 'object')
);

CREATE INDEX "durable_learning_attempts_execution_idx"
  ON "durable_learning_attempts" ("workspace_id", "execution_attempt_id", "created_at");

CREATE TABLE "durable_learning_attempt_receipts" (
  "attempt_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "input_hash" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT "durable_learning_attempt_receipts_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "durable_learning_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempt_receipts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "durable_learning_attempt_receipts_input_hash_chk"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "durable_learning_attempt_receipts_shape_chk"
    CHECK (jsonb_typeof("receipt") = 'object')
);

CREATE OR REPLACE FUNCTION durable_learning_reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'durable-learning attempts and receipts are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER durable_learning_attempts_immutable
  BEFORE UPDATE OR DELETE ON "durable_learning_attempts"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_reject_mutation();
CREATE TRIGGER durable_learning_attempt_receipts_immutable
  BEFORE UPDATE OR DELETE ON "durable_learning_attempt_receipts"
  FOR EACH ROW EXECUTE FUNCTION durable_learning_reject_mutation();

ALTER TABLE "durable_learning_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempt_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_learning_attempt_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "durable_learning_attempts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "durable_learning_attempt_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $begin_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.durable_learning_begin_attempt(
      p_id uuid,
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_execution_attempt_id uuid,
      p_execution_generation integer,
      p_operation text,
      p_target_surface text,
      p_canonical_input text,
      p_input_hash text,
      p_request jsonb,
      p_decision jsonb
    ) RETURNS TABLE (
      initiating_human_subject_id text,
      existing_receipt jsonb
    )
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      authority record;
      existing durable_learning_attempts%%ROWTYPE;
      stored_receipt jsonb;
      required_permission text;
      required_role text;
      decision_scope text;
    BEGIN
      IF nullif(current_setting('opengeni.account_id', true), '')::uuid
          IS DISTINCT FROM p_account_id
        OR nullif(current_setting('opengeni.workspace_id', true), '')::uuid
          IS DISTINCT FROM p_workspace_id
      THEN
        RAISE EXCEPTION 'durable-learning tenant context is not exact' USING ERRCODE = '42501';
      END IF;
      IF p_execution_generation < 1
        OR p_operation NOT IN ('write', 'rollback')
        OR p_target_surface NOT IN (
          'company_profile', 'workspace_instruction_policy', 'preference_registry'
        )
        OR p_input_hash !~ '^[0-9a-f]{64}$'
        OR octet_length(p_canonical_input) NOT BETWEEN 2 AND 524288
        OR encode(public.digest(convert_to(p_canonical_input, 'UTF8'), 'sha256'), 'hex')
          IS DISTINCT FROM p_input_hash
        OR p_canonical_input::jsonb IS DISTINCT FROM jsonb_build_object(
          'authority', jsonb_build_object(
            'accountId', p_account_id,
            'workspaceId', p_workspace_id,
            'sessionId', p_session_id,
            'turnId', p_turn_id,
            'attemptId', p_execution_attempt_id,
            'executionGeneration', p_execution_generation
          ),
          'decision', p_decision,
          'operationId', p_id,
          'request', p_request
        )
      THEN
        RAISE EXCEPTION 'durable-learning input hash or canonical input is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF p_request->>'operation' IS DISTINCT FROM p_operation
        OR p_request->>'attemptId' IS DISTINCT FROM p_id::text
        OR p_request->>'targetSurface' IS DISTINCT FROM p_target_surface
        OR p_request#>>'{confirmation,state}' IS DISTINCT FROM 'confirmed'
        OR p_decision->>'disposition' IS DISTINCT FROM 'route'
        OR p_decision->>'destination' IS DISTINCT FROM p_target_surface
        OR p_decision->>'authority' IS NULL
        OR p_decision->>'authority' NOT IN ('active', 'proposal')
      THEN
        RAISE EXCEPTION 'durable-learning request and route decision do not match'
          USING ERRCODE = '22023';
      END IF;

      SELECT
        coalesce(
          turn.initiating_human_subject_id,
          CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
        ) AS human_subject_id,
        membership.permissions,
        membership.role
      INTO authority
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id
       AND session.workspace_id = workspace.id
      JOIN session_turns turn
        ON turn.account_id = session.account_id
       AND turn.workspace_id = session.workspace_id
       AND turn.session_id = session.id
      JOIN session_turn_attempts execution_attempt
        ON execution_attempt.account_id = turn.account_id
       AND execution_attempt.workspace_id = turn.workspace_id
       AND execution_attempt.session_id = turn.session_id
       AND execution_attempt.turn_id = turn.id
      JOIN workspace_memberships membership
        ON membership.account_id = workspace.account_id
       AND membership.workspace_id = workspace.id
       AND membership.subject_id = coalesce(
         turn.initiating_human_subject_id,
         CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
       )
      WHERE workspace.account_id = p_account_id
        AND workspace.id = p_workspace_id
        AND session.id = p_session_id
        AND session.active_turn_id = p_turn_id
        AND turn.id = p_turn_id
        AND turn.active_attempt_id = p_execution_attempt_id
        AND turn.execution_generation = p_execution_generation
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND execution_attempt.id = p_execution_attempt_id
        AND execution_attempt.execution_generation = p_execution_generation
        AND execution_attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = execution_attempt.workspace_id
            AND interruption.attempt_id = execution_attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
        AND length(btrim(coalesce(
          turn.initiating_human_subject_id,
          CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
        ))) BETWEEN 1 AND 1024
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn, membership
      FOR UPDATE OF execution_attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'durable-learning requires the exact current accepted attempt and immutable initiating human'
          USING ERRCODE = '42501';
      END IF;

      decision_scope := p_decision#>>'{scope,kind}';
      IF p_target_surface = 'company_profile' THEN
        IF decision_scope IS DISTINCT FROM 'organization' THEN
          RAISE EXCEPTION 'company-profile learning requires organization scope'
            USING ERRCODE = '22023';
        END IF;
        required_role := 'owner';
      ELSIF p_target_surface = 'workspace_instruction_policy' THEN
        IF decision_scope IS DISTINCT FROM 'workspace' THEN
          RAISE EXCEPTION 'instruction-policy learning requires workspace scope'
            USING ERRCODE = '22023';
        END IF;
        required_permission := 'workspace:admin';
      ELSE
        IF decision_scope IS NULL
          OR decision_scope NOT IN ('organization', 'workspace', 'user')
          OR p_request#>>'{subject,scope}' IS DISTINCT FROM decision_scope
        THEN
          RAISE EXCEPTION 'preference learning scope is invalid' USING ERRCODE = '22023';
        END IF;
        required_permission := CASE decision_scope
          WHEN 'workspace' THEN 'workspace:admin'
          ELSE NULL
        END;
        required_role := CASE decision_scope
          WHEN 'organization' THEN 'owner'
          ELSE NULL
        END;
      END IF;
      IF required_role IS NOT NULL AND authority.role IS DISTINCT FROM required_role THEN
        RAISE EXCEPTION 'durable-learning initiating human lacks required organization authority'
          USING ERRCODE = '42501';
      END IF;
      IF required_permission IS NOT NULL
        AND NOT (authority.permissions ? required_permission)
      THEN
        RAISE EXCEPTION 'durable-learning initiating human lacks required authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT attempt.* INTO existing
      FROM durable_learning_attempts attempt
      WHERE attempt.id = p_id;
      IF FOUND THEN
        IF existing.account_id IS DISTINCT FROM p_account_id
          OR existing.workspace_id IS DISTINCT FROM p_workspace_id
          OR existing.session_id IS DISTINCT FROM p_session_id
          OR existing.turn_id IS DISTINCT FROM p_turn_id
          OR existing.execution_attempt_id IS DISTINCT FROM p_execution_attempt_id
          OR existing.execution_generation IS DISTINCT FROM p_execution_generation
          OR existing.initiating_human_subject_id IS DISTINCT FROM authority.human_subject_id
          OR existing.operation IS DISTINCT FROM p_operation
          OR existing.target_surface IS DISTINCT FROM p_target_surface
          OR existing.input_hash IS DISTINCT FROM p_input_hash
          OR existing.canonical_input IS DISTINCT FROM p_canonical_input
          OR existing.request IS DISTINCT FROM p_request
          OR existing.decision IS DISTINCT FROM p_decision
        THEN
          RAISE EXCEPTION 'durable-learning attempt id already identifies different immutable input'
            USING ERRCODE = '23505';
        END IF;
      ELSE
        INSERT INTO durable_learning_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_attempt_id,
          execution_generation, initiating_human_subject_id, operation, target_surface,
          input_hash, canonical_input, request, decision
        ) VALUES (
          p_id, p_account_id, p_workspace_id, p_session_id, p_turn_id,
          p_execution_attempt_id, p_execution_generation, authority.human_subject_id,
          p_operation, p_target_surface, p_input_hash, p_canonical_input, p_request, p_decision
        );
      END IF;
      SELECT receipt.receipt INTO stored_receipt
      FROM durable_learning_attempt_receipts receipt
      WHERE receipt.attempt_id = p_id;
      PERFORM set_config('opengeni.durable_learning_attempt_id', p_id::text, true);
      PERFORM set_config('opengeni.durable_learning_input_hash', p_input_hash, true);
      initiating_human_subject_id := authority.human_subject_id;
      existing_receipt := stored_receipt;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.durable_learning_begin_attempt(uuid,uuid,uuid,uuid,uuid,uuid,integer,text,text,text,text,jsonb,jsonb) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.durable_learning_begin_attempt(uuid,uuid,uuid,uuid,uuid,uuid,integer,text,text,text,text,jsonb,jsonb) TO opengeni_app',
      target_schema
    );
  END IF;
END $begin_function$;

DO $complete_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.durable_learning_complete_attempt(
      p_attempt_id uuid,
      p_input_hash text,
      p_result jsonb
    ) RETURNS TABLE (receipt jsonb)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      attempt durable_learning_attempts%%ROWTYPE;
      existing durable_learning_attempt_receipts%%ROWTYPE;
      canonical_receipt jsonb;
      completed_at timestamptz := transaction_timestamp();
    BEGIN
      SELECT candidate.* INTO attempt
      FROM durable_learning_attempts candidate
      WHERE candidate.id = p_attempt_id;
      IF NOT FOUND OR attempt.input_hash IS DISTINCT FROM p_input_hash THEN
        RAISE EXCEPTION 'durable-learning attempt receipt authority is unavailable'
          USING ERRCODE = '42501';
      END IF;
      IF nullif(current_setting('opengeni.account_id', true), '')::uuid
          IS DISTINCT FROM attempt.account_id
        OR nullif(current_setting('opengeni.workspace_id', true), '')::uuid
          IS DISTINCT FROM attempt.workspace_id
        OR nullif(current_setting('opengeni.durable_learning_attempt_id', true), '')::uuid
          IS DISTINCT FROM attempt.id
        OR nullif(current_setting('opengeni.durable_learning_input_hash', true), '')
          IS DISTINCT FROM attempt.input_hash
      THEN
        RAISE EXCEPTION 'durable-learning receipt completion requires the admitted transaction'
          USING ERRCODE = '42501';
      END IF;
      IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'durable-learning authority result must be an object'
          USING ERRCODE = '22023';
      END IF;
      canonical_receipt := p_result || jsonb_build_object(
        'attemptId', attempt.id,
        'inputHash', attempt.input_hash,
        'operation', attempt.operation,
        'createdAt', to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
      IF canonical_receipt->>'outcome' NOT IN ('applied', 'proposed', 'rolled_back')
        OR canonical_receipt->>'effectiveBoundary' IS DISTINCT FROM 'next_accepted_attempt'
        OR canonical_receipt#>>'{rollback,supported}' NOT IN ('true', 'false')
        OR (jsonb_typeof(canonical_receipt->'resource') IS DISTINCT FROM 'null'
          AND canonical_receipt#>>'{resource,surface}' IS DISTINCT FROM attempt.target_surface)
      THEN
        RAISE EXCEPTION 'durable-learning authority receipt is invalid' USING ERRCODE = '22023';
      END IF;
      SELECT stored.* INTO existing
      FROM durable_learning_attempt_receipts stored
      WHERE stored.attempt_id = attempt.id;
      IF FOUND THEN
        IF existing.input_hash IS DISTINCT FROM attempt.input_hash
          OR existing.receipt IS DISTINCT FROM canonical_receipt
        THEN
          RAISE EXCEPTION 'durable-learning attempt already has a different immutable receipt'
            USING ERRCODE = '23505';
        END IF;
        receipt := existing.receipt;
        RETURN NEXT;
        RETURN;
      END IF;
      INSERT INTO durable_learning_attempt_receipts (
        attempt_id, account_id, workspace_id, input_hash, receipt, created_at
      ) VALUES (
        attempt.id, attempt.account_id, attempt.workspace_id, attempt.input_hash,
        canonical_receipt, completed_at
      );
      receipt := canonical_receipt;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.durable_learning_complete_attempt(uuid,text,jsonb) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.durable_learning_complete_attempt(uuid,text,jsonb) TO opengeni_app',
      target_schema
    );
  END IF;
END $complete_function$;

REVOKE ALL ON TABLE durable_learning_attempts FROM PUBLIC;
REVOKE ALL ON TABLE durable_learning_attempt_receipts FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT ON TABLE durable_learning_attempts TO opengeni_app;
    GRANT SELECT ON TABLE durable_learning_attempt_receipts TO opengeni_app;
  END IF;
END $runtime_grants$;

RESET statement_timeout;
RESET lock_timeout;