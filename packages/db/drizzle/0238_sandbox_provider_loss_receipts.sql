-- deployment-mode: rolling
-- Exact provider-loss repair state machine. A teardown claim is a durable
-- pre-action fence; a receipt is immutable evidence written only after the
-- provider action and an independent authoritative not_found observation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE sandbox_workspace_mutation_admissions
  DROP CONSTRAINT IF EXISTS sandbox_workspace_mutation_admissions_outcome_check,
  DROP CONSTRAINT IF EXISTS sandbox_workspace_mutation_admissions_settlement_check;

ALTER TABLE sandbox_workspace_mutation_admissions
  ADD CONSTRAINT sandbox_workspace_mutation_admissions_outcome_check
    CHECK (provider_outcome IS NULL OR provider_outcome IN ('resolved', 'rejected', 'retained', 'unknown')),
  ADD CONSTRAINT sandbox_workspace_mutation_admissions_settlement_check
    CHECK (
      (provider_outcome IS NULL AND settled_at IS NULL)
      OR (provider_outcome = 'retained' AND settled_at IS NULL)
      OR (provider_outcome IN ('resolved', 'rejected', 'unknown') AND settled_at IS NOT NULL)
    );

-- Unknown is a terminal outcome only for a provider-loss path. Retained
-- processes may therefore be marked lost against unknown, but never exited.
CREATE OR REPLACE FUNCTION opengeni_private.validate_sandbox_retained_process_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM sandbox_workspace_mutation_admissions admission
    WHERE admission.id = NEW.parent_admission_id
      AND admission.account_id = NEW.account_id
      AND admission.workspace_id = NEW.workspace_id
      AND admission.session_id = NEW.session_id
      AND admission.lease_id = NEW.lease_id
      AND admission.sandbox_group_id = NEW.sandbox_group_id
      AND admission.actor_kind = NEW.owner_actor_kind
      AND admission.actor_id = NEW.owner_actor_id
      AND admission.turn_id IS NOT DISTINCT FROM NEW.owner_turn_id
      AND admission.attempt_id IS NOT DISTINCT FROM NEW.owner_attempt_id
      AND admission.execution_generation IS NOT DISTINCT FROM NEW.owner_execution_generation
      AND admission.lease_epoch = NEW.lease_epoch
      AND admission.provider_backend = NEW.provider_backend
      AND admission.provider_instance_id = NEW.provider_instance_id
      AND admission.route_kind = NEW.route_kind
      AND admission.route_target_id IS NOT DISTINCT FROM NEW.route_target_id
      AND admission.route_epoch = NEW.route_epoch
      AND (
        (
          NEW.state = 'active'
          AND admission.provider_outcome = 'retained'
          AND admission.settled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM sandbox_lease_holders holder
            WHERE holder.lease_id = NEW.lease_id
              AND holder.account_id = NEW.account_id
              AND holder.workspace_id = NEW.workspace_id
              AND holder.kind = 'process'
              AND holder.holder_id = NEW.holder_id
              AND holder.subject_id = NEW.session_id
          )
        ) OR (
          NEW.state IN ('exited', 'lost')
          AND admission.provider_outcome IN ('resolved', 'rejected', 'unknown')
          AND admission.settled_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_lease_holders holder
            WHERE holder.lease_id = NEW.lease_id
              AND holder.kind = 'process'
              AND holder.holder_id = NEW.holder_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM sandbox_pty_sessions pty
            WHERE pty.retained_process_id = NEW.id
              AND pty.status = 'open'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'retained process does not match its parent admission and holder state'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'exited' AND EXISTS (
    SELECT 1 FROM sandbox_workspace_mutation_admissions admission
    WHERE admission.id = NEW.parent_admission_id AND admission.provider_outcome = 'unknown'
  ) THEN
    RAISE EXCEPTION 'unknown provider outcome cannot be exited'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE sandbox_provider_loss_teardown_claims (
  id uuid PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  turn_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  holder_kind text NOT NULL,
  holder_id text NOT NULL,
  lease_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  lease_epoch integer NOT NULL,
  workspace_generation integer NOT NULL,
  provider_backend text NOT NULL,
  provider_instance_id text NOT NULL,
  route_kind text NOT NULL,
  route_target_id uuid,
  route_epoch integer NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,

  CONSTRAINT sandbox_provider_loss_teardown_claims_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sandbox_provider_loss_teardown_claims_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_provider_loss_teardown_claims_admission_scope_fk
    FOREIGN KEY (account_id, workspace_id, session_id, lease_id, admission_id)
    REFERENCES sandbox_workspace_mutation_admissions
      (account_id, workspace_id, session_id, lease_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_provider_loss_teardown_claims_identity_check
    CHECK (
      actor_kind = 'turn'
      AND actor_id = attempt_id
      AND holder_kind = 'turn'
      AND operation = 'codemodeTokenRenewal'
      AND lease_epoch >= 0
      AND workspace_generation > 0
      AND route_epoch >= 0
      AND (route_kind = 'active' OR route_target_id IS NULL)
      AND octet_length(holder_id) BETWEEN 1 AND 256
      AND octet_length(provider_backend) BETWEEN 1 AND 64
      AND octet_length(provider_instance_id) BETWEEN 1 AND 512
    ),
  CONSTRAINT sandbox_provider_loss_teardown_claims_consume_check
    CHECK (consumed_at IS NULL OR consumed_at >= claimed_at)
);

CREATE UNIQUE INDEX sandbox_provider_loss_teardown_claims_scoped_id_uq
  ON sandbox_provider_loss_teardown_claims (account_id, workspace_id, id);
CREATE UNIQUE INDEX sandbox_provider_loss_teardown_claims_admission_scope_uq
  ON sandbox_provider_loss_teardown_claims (account_id, workspace_id, admission_id, id);
CREATE UNIQUE INDEX sandbox_provider_loss_teardown_claims_admission_uq
  ON sandbox_provider_loss_teardown_claims (admission_id);
CREATE INDEX sandbox_provider_loss_teardown_claims_identity_idx
  ON sandbox_provider_loss_teardown_claims (lease_id, lease_epoch, provider_instance_id, workspace_generation);

CREATE TABLE sandbox_provider_loss_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  admission_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  operation text NOT NULL,
  turn_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  holder_kind text NOT NULL,
  holder_id text NOT NULL,
  lease_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  lease_epoch integer NOT NULL,
  workspace_generation integer NOT NULL,
  provider_backend text NOT NULL,
  provider_instance_id text NOT NULL,
  route_kind text NOT NULL,
  route_target_id uuid,
  route_epoch integer NOT NULL,
  terminate_outcome text NOT NULL,
  destruction_correlation_id text NOT NULL,
  destruction_observed_at timestamptz NOT NULL,
  not_found_observed_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sandbox_provider_loss_receipts_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sandbox_provider_loss_receipts_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_provider_loss_receipts_admission_scope_fk
    FOREIGN KEY (account_id, workspace_id, session_id, lease_id, admission_id)
    REFERENCES sandbox_workspace_mutation_admissions
      (account_id, workspace_id, session_id, lease_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_provider_loss_receipts_claim_scope_fk
    FOREIGN KEY (account_id, workspace_id, admission_id, claim_id)
    REFERENCES sandbox_provider_loss_teardown_claims
      (account_id, workspace_id, admission_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_provider_loss_receipts_identity_check
    CHECK (
      actor_kind = 'turn'
      AND actor_id = attempt_id
      AND holder_kind = 'turn'
      AND operation = 'codemodeTokenRenewal'
      AND lease_epoch >= 0
      AND workspace_generation > 0
      AND route_epoch >= 0
      AND (route_kind = 'active' OR route_target_id IS NULL)
      AND terminate_outcome IN ('terminated', 'not_found')
      AND octet_length(holder_id) BETWEEN 1 AND 256
      AND octet_length(provider_backend) BETWEEN 1 AND 64
      AND octet_length(provider_instance_id) BETWEEN 1 AND 512
      AND octet_length(destruction_correlation_id) BETWEEN 1 AND 256
      AND not_found_observed_at >= destruction_observed_at
    ),
  CONSTRAINT sandbox_provider_loss_receipts_consume_check
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX sandbox_provider_loss_receipts_scoped_id_uq
  ON sandbox_provider_loss_receipts (account_id, workspace_id, id);
CREATE UNIQUE INDEX sandbox_provider_loss_receipts_admission_uq
  ON sandbox_provider_loss_receipts (admission_id);
CREATE UNIQUE INDEX sandbox_provider_loss_receipts_claim_uq
  ON sandbox_provider_loss_receipts (claim_id);
CREATE INDEX sandbox_provider_loss_receipts_identity_idx
  ON sandbox_provider_loss_receipts (lease_id, lease_epoch, provider_instance_id, workspace_generation);

ALTER TABLE sandbox_provider_loss_teardown_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_provider_loss_teardown_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_provider_loss_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_provider_loss_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON sandbox_provider_loss_teardown_claims
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON sandbox_provider_loss_receipts
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE OR REPLACE FUNCTION opengeni_private.guard_provider_loss_claim_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.id = NEW.id
     AND OLD.account_id = NEW.account_id
     AND OLD.workspace_id = NEW.workspace_id
     AND OLD.consumed_at IS NULL
     AND NEW.consumed_at IS NOT NULL
     AND NEW.consumed_at >= OLD.claimed_at
     AND (to_jsonb(NEW) - 'consumed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provider-loss teardown claims are immutable except one-way consumption'
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.guard_provider_loss_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.id = NEW.id
     AND OLD.account_id = NEW.account_id
     AND OLD.workspace_id = NEW.workspace_id
     AND OLD.consumed_at IS NULL
     AND NEW.consumed_at IS NOT NULL
     AND NEW.consumed_at >= OLD.created_at
     AND (to_jsonb(NEW) - 'consumed_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provider-loss receipts are immutable except one-way consumption'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER sandbox_provider_loss_claim_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_provider_loss_teardown_claims
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_claim_mutation();
CREATE TRIGGER sandbox_provider_loss_receipt_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_provider_loss_receipts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_receipt_mutation();

CREATE TRIGGER sandbox_recovery_protocol_v2_provider_loss_claim_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_provider_loss_teardown_claims
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();
CREATE TRIGGER sandbox_recovery_protocol_v2_provider_loss_receipt_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_provider_loss_receipts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE OR REPLACE FUNCTION opengeni_private.guard_provider_loss_claim_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sandbox_provider_loss_teardown_claims claim
    WHERE claim.consumed_at IS NULL
      AND (
        claim.lease_id = NEW.lease_id
        OR (TG_OP = 'UPDATE' AND claim.lease_id = OLD.lease_id)
      )
  ) THEN
    RAISE EXCEPTION 'provider-loss teardown claim fences new lease mutations'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_provider_loss_claim_admission_fence
BEFORE INSERT ON sandbox_workspace_mutation_admissions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_claim_fence();
CREATE TRIGGER sandbox_provider_loss_claim_holder_fence
BEFORE INSERT ON sandbox_lease_holders
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_claim_fence();
CREATE TRIGGER sandbox_provider_loss_claim_retained_process_fence
BEFORE INSERT OR UPDATE ON sandbox_retained_processes
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_claim_fence();

CREATE OR REPLACE FUNCTION opengeni_private.guard_provider_loss_lease_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  atomic_claim_id text := nullif(current_setting('opengeni.sandbox_provider_loss_claim_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM sandbox_provider_loss_teardown_claims claim
      WHERE claim.lease_id = OLD.id
        AND claim.consumed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'provider-loss teardown claim fences lease deletion'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM sandbox_provider_loss_teardown_claims claim
    WHERE claim.lease_id = OLD.id
      AND claim.consumed_at IS NULL
  ) AND (
    NEW.liveness IS DISTINCT FROM OLD.liveness
    OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
    OR NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.refcount IS DISTINCT FROM OLD.refcount
    OR NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id
    OR NEW.rotation_requested_at IS DISTINCT FROM OLD.rotation_requested_at
    OR NEW.rotation_reason IS DISTINCT FROM OLD.rotation_reason
  ) AND NOT (
    NEW.liveness = 'cold'
    AND NEW.instance_id IS NULL
    AND NEW.refcount = 0
    AND NEW.lease_epoch = OLD.lease_epoch + 1
    AND atomic_claim_id IS NOT NULL
    AND atomic_claim_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1
      FROM sandbox_provider_loss_teardown_claims claim
      WHERE claim.id = atomic_claim_id::uuid
        AND claim.lease_id = OLD.id
        AND claim.consumed_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'provider-loss teardown claim fences lease lifecycle mutation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DO $security$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_provider_loss_claim_fence() SECURITY DEFINER SET search_path = pg_catalog, %I',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_provider_loss_lease_mutation() SECURITY DEFINER SET search_path = pg_catalog, %I',
    data_schema
  );
  REVOKE EXECUTE ON FUNCTION opengeni_private.guard_provider_loss_claim_fence() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION opengeni_private.guard_provider_loss_lease_mutation() FROM PUBLIC;
END
$security$;

CREATE TRIGGER sandbox_provider_loss_lease_mutation_fence
BEFORE UPDATE OF liveness, instance_id, lease_epoch, refcount ON sandbox_leases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_lease_mutation();

CREATE TRIGGER sandbox_provider_loss_lease_delete_fence
BEFORE DELETE ON sandbox_leases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_provider_loss_lease_mutation();

DO $grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.sandbox_provider_loss_teardown_claims TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.sandbox_provider_loss_receipts TO opengeni_app',
      data_schema
    );
  END IF;
END
$grants$;
