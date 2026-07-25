-- deployment-mode: maintenance
-- OPE-60: activate the durable workspace-generation, mutation-admission, and
-- retained-process protocol. Old API/control/turn workers MUST be stopped: they
-- cannot name exact direct/process authority and do not set the v2 marker.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Reject an obviously live old application before waiting on table locks. The
-- same guard runs again after the locks to close the connect/write race.
DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox recovery protocol v2 activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

-- Serialize the one-way cutover against every old lease/holder/PTY writer. The
-- migration runner wraps this file in one transaction, so a timeout or guard
-- failure leaves no partially visible protocol.
LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_lease_holders IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_pty_sessions IN ACCESS EXCLUSIVE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox recovery protocol v2 activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

-- One exact monotonic write set per lease. Generation zero is the legacy/clean
-- baseline; a verified archive is complete only when archive_generation equals
-- workspace_generation. Missing or older generations remain truthfully stale.
ALTER TABLE sandbox_leases
  ADD COLUMN IF NOT EXISTS workspace_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS archive_generation integer;

ALTER TABLE sandbox_leases
  DROP CONSTRAINT IF EXISTS sandbox_leases_workspace_generation_check,
  DROP CONSTRAINT IF EXISTS sandbox_leases_archive_generation_check;
ALTER TABLE sandbox_leases
  ADD CONSTRAINT sandbox_leases_workspace_generation_check
    CHECK (workspace_generation >= 0),
  ADD CONSTRAINT sandbox_leases_archive_generation_check
    CHECK (
      archive_generation IS NULL
      OR (archive_generation >= 0 AND archive_generation <= workspace_generation)
    );

-- Composite identities prevent a globally valid UUID from crossing tenant,
-- workspace, group, session, or lease scope through a malformed internal write.
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_leases_scoped_id_uq
  ON sandbox_leases (account_id, workspace_id, sandbox_group_id, id);
-- sandbox_leases' primary key already makes id unique; this narrower composite
-- exists solely as the referenced tenant/workspace key for holders.
CREATE UNIQUE INDEX IF NOT EXISTS sandbox_leases_account_workspace_id_uq
  ON sandbox_leases (account_id, workspace_id, id);

ALTER TABLE sandbox_lease_holders
  DROP CONSTRAINT IF EXISTS sandbox_lease_holders_kind_check;
ALTER TABLE sandbox_lease_holders
  ADD CONSTRAINT sandbox_lease_holders_kind_check
    CHECK (kind IN ('turn', 'viewer', 'direct', 'process'));

ALTER TABLE sandbox_lease_holders
  DROP CONSTRAINT IF EXISTS sandbox_lease_holders_lease_scope_fk;
ALTER TABLE sandbox_lease_holders
  ADD CONSTRAINT sandbox_lease_holders_lease_scope_fk
    FOREIGN KEY (account_id, workspace_id, lease_id)
    REFERENCES sandbox_leases (account_id, workspace_id, id)
    ON DELETE CASCADE;

CREATE TABLE sandbox_workspace_mutation_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  session_id uuid NOT NULL,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  turn_id uuid,
  attempt_id uuid,
  execution_generation integer,
  holder_kind text NOT NULL,
  holder_id text NOT NULL,
  lease_epoch integer NOT NULL,
  provider_backend text NOT NULL,
  provider_instance_id text NOT NULL,
  route_kind text NOT NULL,
  route_target_id uuid,
  route_epoch integer NOT NULL,
  workspace_generation integer NOT NULL,
  operation text NOT NULL,
  provider_outcome text,
  admitted_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,

  CONSTRAINT sandbox_workspace_mutation_admissions_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sandbox_workspace_mutation_admissions_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_workspace_mutation_admissions_workspace_turn_fk
    FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_workspace_mutation_admissions_workspace_attempt_fk
    FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES session_turn_attempts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_workspace_mutation_admissions_lease_scope_fk
    FOREIGN KEY (account_id, workspace_id, sandbox_group_id, lease_id)
    REFERENCES sandbox_leases (account_id, workspace_id, sandbox_group_id, id)
    ON DELETE CASCADE,
  CONSTRAINT sandbox_workspace_mutation_admissions_generation_check
    CHECK (
      workspace_generation > 0
      AND lease_epoch >= 0
      AND route_epoch >= 0
      AND (execution_generation IS NULL OR execution_generation > 0)
    ),
  CONSTRAINT sandbox_workspace_mutation_admissions_actor_check
    CHECK (
      (
        actor_kind = 'turn'
        AND actor_id = attempt_id
        AND turn_id IS NOT NULL
        AND attempt_id IS NOT NULL
        AND execution_generation IS NOT NULL
        AND holder_kind = 'turn'
      ) OR (
        actor_kind = 'direct'
        AND turn_id IS NULL
        AND attempt_id IS NULL
        AND execution_generation IS NULL
        AND holder_kind = 'direct'
      ) OR (
        actor_kind = 'process'
        AND turn_id IS NULL
        AND attempt_id IS NULL
        AND execution_generation IS NULL
        AND holder_kind = 'process'
      )
    ),
  CONSTRAINT sandbox_workspace_mutation_admissions_route_check
    CHECK (
      actor_kind IN ('turn', 'direct', 'process')
      AND holder_kind IN ('turn', 'direct', 'process')
      AND octet_length(holder_id) BETWEEN 1 AND 256
      AND octet_length(provider_backend) BETWEEN 1 AND 64
      AND octet_length(provider_instance_id) BETWEEN 1 AND 512
      AND route_kind IN ('home', 'active')
      AND (route_kind = 'active' OR route_target_id IS NULL)
    ),
  CONSTRAINT sandbox_workspace_mutation_admissions_operation_check
    CHECK (octet_length(operation) BETWEEN 1 AND 128),
  CONSTRAINT sandbox_workspace_mutation_admissions_outcome_check
    CHECK (provider_outcome IS NULL OR provider_outcome IN ('resolved', 'rejected', 'retained')),
  CONSTRAINT sandbox_workspace_mutation_admissions_settlement_check
    CHECK (
      (provider_outcome IS NULL AND settled_at IS NULL)
      OR (provider_outcome = 'retained' AND settled_at IS NULL)
      OR (provider_outcome IN ('resolved', 'rejected') AND settled_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX sandbox_workspace_mutation_admissions_lease_generation_uq
  ON sandbox_workspace_mutation_admissions (lease_id, workspace_generation);
CREATE UNIQUE INDEX sandbox_workspace_mutation_admissions_scoped_id_uq
  ON sandbox_workspace_mutation_admissions
    (account_id, workspace_id, session_id, lease_id, id);
CREATE INDEX sandbox_workspace_mutation_admissions_blocking_idx
  ON sandbox_workspace_mutation_admissions (lease_id, workspace_generation)
  WHERE settled_at IS NULL;
CREATE INDEX sandbox_workspace_mutation_admissions_attempt_idx
  ON sandbox_workspace_mutation_admissions (workspace_id, attempt_id);
CREATE INDEX sandbox_workspace_mutation_admissions_actor_idx
  ON sandbox_workspace_mutation_admissions (workspace_id, actor_kind, actor_id);

CREATE TABLE sandbox_retained_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  parent_admission_id uuid NOT NULL,
  holder_id text NOT NULL,
  owner_actor_kind text NOT NULL,
  owner_actor_id uuid NOT NULL,
  owner_turn_id uuid,
  owner_attempt_id uuid,
  owner_execution_generation integer,
  lease_epoch integer NOT NULL,
  provider_backend text NOT NULL,
  provider_instance_id text NOT NULL,
  route_kind text NOT NULL,
  route_target_id uuid,
  route_epoch integer NOT NULL,
  provider_session_id integer NOT NULL,
  state text NOT NULL DEFAULT 'active',
  exit_code integer,
  settlement_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,

  CONSTRAINT sandbox_retained_processes_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces (id, account_id) ON DELETE CASCADE,
  CONSTRAINT sandbox_retained_processes_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT sandbox_retained_processes_parent_admission_scope_fk
    FOREIGN KEY (account_id, workspace_id, session_id, lease_id, parent_admission_id)
    REFERENCES sandbox_workspace_mutation_admissions
      (account_id, workspace_id, session_id, lease_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT sandbox_retained_processes_identity_check
    CHECK (
      lease_epoch >= 0
      AND route_epoch >= 0
      AND provider_session_id > 0
      AND octet_length(holder_id) BETWEEN 1 AND 256
      AND octet_length(provider_backend) BETWEEN 1 AND 64
      AND octet_length(provider_instance_id) BETWEEN 1 AND 512
      AND route_kind IN ('home', 'active')
      AND (route_kind = 'active' OR route_target_id IS NULL)
    ),
  CONSTRAINT sandbox_retained_processes_owner_check
    CHECK (
      (
        owner_actor_kind = 'turn'
        AND owner_actor_id = owner_attempt_id
        AND owner_turn_id IS NOT NULL
        AND owner_attempt_id IS NOT NULL
        AND owner_execution_generation > 0
      ) OR (
        owner_actor_kind = 'direct'
        AND owner_turn_id IS NULL
        AND owner_attempt_id IS NULL
        AND owner_execution_generation IS NULL
      )
    ),
  CONSTRAINT sandbox_retained_processes_settlement_check
    CHECK (
      (state = 'active' AND settled_at IS NULL AND exit_code IS NULL)
      OR (state = 'exited' AND settled_at IS NOT NULL)
      OR (state = 'lost' AND settled_at IS NOT NULL AND exit_code IS NULL)
    ),
  CONSTRAINT sandbox_retained_processes_reason_check
    CHECK (settlement_reason IS NULL OR octet_length(settlement_reason) BETWEEN 1 AND 512)
);

CREATE UNIQUE INDEX sandbox_retained_processes_scoped_id_uq
  ON sandbox_retained_processes (account_id, workspace_id, session_id, lease_id, id);
CREATE UNIQUE INDEX sandbox_retained_processes_parent_admission_uq
  ON sandbox_retained_processes (parent_admission_id);
CREATE UNIQUE INDEX sandbox_retained_processes_holder_uq
  ON sandbox_retained_processes (lease_id, holder_id);
CREATE UNIQUE INDEX sandbox_retained_processes_live_provider_session_uq
  ON sandbox_retained_processes
    (lease_id, lease_epoch, provider_instance_id, route_epoch, provider_session_id)
  WHERE state = 'active';
CREATE INDEX sandbox_retained_processes_active_idx
  ON sandbox_retained_processes (workspace_id, session_id, started_at)
  WHERE state = 'active';

-- A retained row is the durable continuation of exactly one parent admission.
-- This deferred check observes the final state of atomic promotion/settlement:
-- active => retained parent + exact non-TTL holder; terminal => settled parent
-- + holder removed. It never treats a numeric provider session id as authority.
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
          AND admission.provider_outcome IN ('resolved', 'rejected')
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
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER sandbox_retained_processes_identity_v2
AFTER INSERT OR UPDATE ON sandbox_retained_processes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_retained_process_v2();

-- Numeric-only PTYs cannot be made authoritative retroactively. Maintenance
-- closes them before the new open-row constraint is installed; callers will
-- observe terminal metadata rather than risking stdin against a reused id.
UPDATE sandbox_pty_sessions
SET status = 'closed', closed_at = coalesce(closed_at, clock_timestamp())
WHERE status = 'open';

ALTER TABLE sandbox_pty_sessions
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS sandbox_group_id uuid,
  ADD COLUMN IF NOT EXISTS retained_process_id uuid,
  ADD COLUMN IF NOT EXISTS open_admission_id uuid,
  ADD COLUMN IF NOT EXISTS provider_backend text,
  ADD COLUMN IF NOT EXISTS provider_instance_id text,
  ADD COLUMN IF NOT EXISTS route_kind text,
  ADD COLUMN IF NOT EXISTS route_target_id uuid,
  ADD COLUMN IF NOT EXISTS route_epoch integer;

ALTER TABLE sandbox_pty_sessions
  DROP CONSTRAINT IF EXISTS sandbox_pty_sessions_open_identity_check;
ALTER TABLE sandbox_pty_sessions
  ADD CONSTRAINT sandbox_pty_sessions_open_identity_check
    CHECK (
      status <> 'open' OR (
        lease_id IS NOT NULL
        AND sandbox_group_id IS NOT NULL
        AND retained_process_id IS NOT NULL
        AND open_admission_id IS NOT NULL
        AND exec_session_id > 0
        AND lease_epoch >= 0
        AND octet_length(provider_backend) BETWEEN 1 AND 64
        AND octet_length(provider_instance_id) BETWEEN 1 AND 512
        AND route_kind IN ('home', 'active')
        AND (route_kind = 'active' OR route_target_id IS NULL)
        AND route_epoch >= 0
      )
    );

ALTER TABLE sandbox_pty_sessions
  ADD CONSTRAINT sandbox_pty_sessions_retained_process_scope_fk
    FOREIGN KEY (account_id, workspace_id, session_id, lease_id, retained_process_id)
    REFERENCES sandbox_retained_processes
      (account_id, workspace_id, session_id, lease_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX sandbox_pty_sessions_open_process_uq
  ON sandbox_pty_sessions (retained_process_id)
  WHERE status = 'open';

-- Cross-table semantics that cannot be expressed as a CHECK: an open PTY must
-- copy the exact active retained process, including its parent admission and
-- pinned provider/route identity. Closed legacy rows remain readable evidence.
CREATE OR REPLACE FUNCTION opengeni_private.validate_sandbox_pty_process_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'open' AND NOT EXISTS (
    SELECT 1
    FROM sandbox_retained_processes process
    WHERE process.id = NEW.retained_process_id
      AND process.account_id = NEW.account_id
      AND process.workspace_id = NEW.workspace_id
      AND process.session_id = NEW.session_id
      AND process.lease_id = NEW.lease_id
      AND process.sandbox_group_id = NEW.sandbox_group_id
      AND process.parent_admission_id = NEW.open_admission_id
      AND process.lease_epoch = NEW.lease_epoch
      AND process.provider_backend = NEW.provider_backend
      AND process.provider_instance_id = NEW.provider_instance_id
      AND process.route_kind = NEW.route_kind
      AND process.route_target_id IS NOT DISTINCT FROM NEW.route_target_id
      AND process.route_epoch = NEW.route_epoch
      AND process.provider_session_id = NEW.exec_session_id
      AND process.state = 'active'
  ) THEN
    RAISE EXCEPTION 'open PTY does not match its exact retained process identity'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER sandbox_pty_sessions_process_identity_v2
AFTER INSERT OR UPDATE ON sandbox_pty_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_pty_process_v2();

-- Preserve archive truth when 0108's warming owner expires. The helper strips
-- live provider/rematerialization identity and publishes pending only when the
-- archived generation exactly covers the closed workspace generation.
CREATE OR REPLACE FUNCTION opengeni_private.warming_reset_resume_state_v2(
  p_backend text,
  p_resume_backend_id text,
  p_resume_state jsonb,
  p_workspace_generation integer,
  p_archive_generation integer,
  p_reset_at timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
      OR coalesce(p_resume_state #>> '{sessionState,workspaceArchivePrev}', '') <> ''
    THEN jsonb_strip_nulls(jsonb_build_object(
      'backendId', coalesce(p_resume_state ->> 'backendId', p_resume_backend_id, p_backend),
      'sessionState', jsonb_strip_nulls(jsonb_build_object(
        'workspaceArchive', p_resume_state #> '{sessionState,workspaceArchive}',
        'workspaceArchiveMeta', p_resume_state #> '{sessionState,workspaceArchiveMeta}',
        'workspaceArchivePrev', p_resume_state #> '{sessionState,workspaceArchivePrev}',
        'workspaceArchivePrevMeta', p_resume_state #> '{sessionState,workspaceArchivePrevMeta}',
        'workspaceArchiveAt', p_resume_state #> '{sessionState,workspaceArchiveAt}'
      )),
      'opengeniRecovery', jsonb_build_object(
        'provider', jsonb_build_object(
          'status', 'not_created', 'instanceId', null, 'observedAt', to_jsonb(p_reset_at)
        ),
        'archive', coalesce(
          p_resume_state #> '{opengeniRecovery,archive}',
          jsonb_build_object(
            'status', CASE
              WHEN coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              THEN 'available' ELSE 'unverified' END,
            'current', p_resume_state #> '{sessionState,workspaceArchiveMeta}',
            'previous', p_resume_state #> '{sessionState,workspaceArchivePrevMeta}'
          )
        ),
        'restore', jsonb_strip_nulls(jsonb_build_object(
          'status', CASE
            WHEN p_archive_generation = p_workspace_generation
              AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
              AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
            THEN 'pending' ELSE 'degraded' END,
          'rematerializationId', null,
          'selectedRevision', coalesce(
            p_resume_state #>> '{opengeniRecovery,archive,current,revision}',
            p_resume_state #>> '{sessionState,workspaceArchiveMeta,revision}'
          ),
          'startedAt', null,
          'completedAt', to_jsonb(p_reset_at),
          'failureCode', CASE
            WHEN p_archive_generation = p_workspace_generation
              AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
              AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
            THEN null ELSE 'archive_generation_mismatch' END,
          'retryable', CASE
            WHEN p_archive_generation = p_workspace_generation
              AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
              AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
            THEN null ELSE to_jsonb(false) END
        )),
        'workspace', jsonb_build_object(
          'status', CASE
            WHEN p_archive_generation = p_workspace_generation
              AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
              AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
            THEN 'not_ready' ELSE 'degraded' END,
          'verifiedRevision', null, 'verifiedAt', null
        )
      )
    ))
    ELSE null
  END;
$$;

-- Replace 0108 in place. Direct holders share the bounded request TTL with
-- viewers. Process holders are deliberately absent from every TTL delete and
-- can leave only through exact retained-process settlement.
CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
  p_viewer_holder_ttl_ms bigint,
  p_turn_holder_ttl_ms bigint,
  p_idle_grace_ms bigint
)
RETURNS TABLE (workspace_id uuid, sandbox_group_id uuid, instance_id text, lease_epoch integer)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

  DELETE FROM sandbox_lease_holders holder
  WHERE holder.kind IN ('viewer', 'direct')
    AND holder.last_heartbeat_at
      < now() - make_interval(secs => p_viewer_holder_ttl_ms / 1000.0);

  IF p_turn_holder_ttl_ms > 0 THEN
    DELETE FROM sandbox_lease_holders holder
    WHERE holder.kind = 'turn'
      AND holder.last_heartbeat_at
        < now() - make_interval(secs => p_turn_holder_ttl_ms / 1000.0);
  END IF;

  UPDATE sandbox_leases lease SET
    refcount = counts.total,
    turn_holders = counts.turns,
    viewer_holders = counts.viewers,
    liveness = CASE
      WHEN lease.liveness = 'warm' AND counts.total = 0 AND counts.turns = 0
      THEN 'draining' ELSE lease.liveness END,
    expires_at = CASE
      WHEN lease.liveness = 'warm' AND counts.total = 0 AND counts.turns = 0
      THEN now() + make_interval(secs => p_idle_grace_ms / 1000.0)
      ELSE lease.expires_at END,
    updated_at = now()
  FROM (
    SELECT candidate.id,
      (SELECT count(*) FROM sandbox_lease_holders holder
        WHERE holder.lease_id = candidate.id)::int AS total,
      (SELECT count(*) FROM sandbox_lease_holders holder
        WHERE holder.lease_id = candidate.id AND holder.kind = 'turn')::int AS turns,
      (SELECT count(*) FROM sandbox_lease_holders holder
        WHERE holder.lease_id = candidate.id AND holder.kind = 'viewer')::int AS viewers
    FROM sandbox_leases candidate
  ) counts
  WHERE lease.id = counts.id;

  UPDATE sandbox_leases lease SET
    liveness = 'cold',
    instance_id = null,
    lease_epoch = lease.lease_epoch + 1,
    resume_state = opengeni_private.warming_reset_resume_state_v2(
      lease.backend, lease.resume_backend_id, lease.resume_state,
      lease.workspace_generation, lease.archive_generation, clock_timestamp()
    ),
    resume_backend_id = CASE
      WHEN coalesce(lease.resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
        OR coalesce(lease.resume_state #>> '{sessionState,workspaceArchivePrev}', '') <> ''
      THEN coalesce(lease.resume_backend_id, lease.backend)
      ELSE null END,
    data_plane_url = null,
    terminal_data_plane_url = null,
    updated_at = now()
  WHERE lease.liveness = 'warming'
    AND lease.expires_at < now()
    AND lease.instance_id IS NULL;

  UPDATE sandbox_leases lease SET
    liveness = 'draining',
    refcount = 0,
    turn_holders = 0,
    viewer_holders = 0,
    data_plane_url = null,
    terminal_data_plane_url = null,
    lease_epoch = lease.lease_epoch + 1,
    expires_at = now() - interval '1 millisecond',
    updated_at = now()
  WHERE lease.liveness = 'warming'
    AND lease.expires_at < now()
    AND lease.instance_id IS NOT NULL;

  RETURN QUERY
    SELECT lease.workspace_id, lease.sandbox_group_id,
      lease.instance_id, lease.lease_epoch
    FROM sandbox_leases lease
    WHERE lease.liveness = 'draining'
      AND lease.expires_at < now()
      AND lease.refcount = 0;
END;
$$;

-- No mixed old/new writer interval: after maintenance activation every lease,
-- holder, admission, retained-process, and PTY mutation by a non-superuser must
-- explicitly opt into v2 in its current transaction.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = session_user AND rolsuper
  ) AND current_setting('opengeni.sandbox_recovery_protocol_v2', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'sandbox recovery protocol v2 marker is required for % on %', TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sandbox_recovery_protocol_v2_lease_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_leases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();
CREATE TRIGGER sandbox_recovery_protocol_v2_holder_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_lease_holders
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();
CREATE TRIGGER sandbox_recovery_protocol_v2_admission_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_workspace_mutation_admissions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();
CREATE TRIGGER sandbox_recovery_protocol_v2_process_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_retained_processes
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();
CREATE TRIGGER sandbox_recovery_protocol_v2_pty_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_pty_sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

ALTER TABLE sandbox_workspace_mutation_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_workspace_mutation_admissions FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_retained_processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_retained_processes FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON sandbox_workspace_mutation_admissions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON sandbox_retained_processes
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.sandbox_workspace_mutation_admissions TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.sandbox_retained_processes TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.sandbox_leases, %I.sandbox_lease_holders, %I.sandbox_pty_sessions TO opengeni_app',
      data_schema, data_schema, data_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(bigint, bigint, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.validate_sandbox_pty_process_v2()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.validate_sandbox_retained_process_v2()
      TO opengeni_app;
  END IF;
END
$grants$;