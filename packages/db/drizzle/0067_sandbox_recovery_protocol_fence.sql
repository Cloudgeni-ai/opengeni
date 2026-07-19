-- deployment-mode: maintenance
-- OPE-60: one-way sandbox recovery protocol activation. Old API, control-worker,
-- and turn-worker pods MUST be stopped before this migration runs: their lease
-- writes do not set the protocol-v1 marker and are intentionally rejected after
-- activation. The migration takes an exclusive lease-table lock and refuses to
-- activate while any opengeni_app session is still connected, making a normal
-- pre-upgrade rolling migration fail closed instead of interrupting old pods
-- mid-roll or permitting an unsafe mixed-version restore writer.

SET lock_timeout = '5s';
SET statement_timeout = '30min';

-- Serialize protocol activation against every in-flight lease read/write. An
-- old writer already in a transaction makes this bounded lock fail; an idle old
-- pool is rejected by the pg_stat_activity preflight below. The migration file
-- is one transaction, so no trigger/function change becomes visible on failure.
LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE;

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
      'sandbox recovery protocol v1 activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

-- Every lease insert and every protected transition, including legacy rows
-- without recovery metadata, requires an explicit protocol-v1 opt-in in the
-- current transaction. Superusers remain available for maintenance and
-- emergency recovery after activation.

CREATE OR REPLACE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = session_user
      AND rolsuper
  ) AND current_setting('opengeni.sandbox_recovery_protocol_v1', true) IS DISTINCT FROM '1' THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION
        'sandbox recovery protocol v1 is required for lease creation'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.liveness IS DISTINCT FROM NEW.liveness
      OR OLD.instance_id IS DISTINCT FROM NEW.instance_id
      OR OLD.lease_epoch IS DISTINCT FROM NEW.lease_epoch
      OR OLD.resume_state IS DISTINCT FROM NEW.resume_state
      OR OLD.resume_backend_id IS DISTINCT FROM NEW.resume_backend_id
      OR OLD.data_plane_url IS DISTINCT FROM NEW.data_plane_url
      OR OLD.terminal_data_plane_url IS DISTINCT FROM NEW.terminal_data_plane_url
    THEN
      RAISE EXCEPTION
        'sandbox recovery protocol v1 is required for protected lease transitions'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sandbox_recovery_protocol_v1_insert_guard ON sandbox_leases;
CREATE TRIGGER sandbox_recovery_protocol_v1_insert_guard
BEFORE INSERT
ON sandbox_leases
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1();

DROP TRIGGER IF EXISTS sandbox_recovery_protocol_v1_guard ON sandbox_leases;
CREATE TRIGGER sandbox_recovery_protocol_v1_guard
BEFORE UPDATE OF liveness, instance_id, lease_epoch, resume_state, resume_backend_id, data_plane_url, terminal_data_plane_url
ON sandbox_leases
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1();

-- Reduce an expired pre-create warming attempt to the durable archive projection
-- only. The next elected owner can select the same verified bytes, while stale
-- provider/session identity and the old rematerialization attempt are removed.
CREATE OR REPLACE FUNCTION opengeni_private.warming_reset_resume_state(
  p_backend text,
  p_resume_backend_id text,
  p_resume_state jsonb,
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
          'status', 'not_created',
          'instanceId', null,
          'observedAt', to_jsonb(p_reset_at)
        ),
        'archive', coalesce(
          p_resume_state #> '{opengeniRecovery,archive}',
          jsonb_build_object(
            'status', CASE
              WHEN coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              THEN 'available'
              ELSE 'unverified'
            END,
            'current', p_resume_state #> '{sessionState,workspaceArchiveMeta}',
            'previous', p_resume_state #> '{sessionState,workspaceArchivePrevMeta}'
          )
        ),
        'restore', jsonb_strip_nulls(jsonb_build_object(
          'status', CASE
            WHEN coalesce(p_resume_state #>> '{opengeniRecovery,archive,status}', '') = 'available'
              OR (
                p_resume_state #> '{opengeniRecovery,archive}' IS NULL
                AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              )
            THEN 'pending'
            ELSE 'degraded'
          END,
          'rematerializationId', null,
          'selectedRevision', coalesce(
            p_resume_state #>> '{opengeniRecovery,archive,current,revision}',
            p_resume_state #>> '{sessionState,workspaceArchiveMeta,revision}'
          ),
          'startedAt', null,
          'completedAt', to_jsonb(p_reset_at),
          'failureCode', CASE
            WHEN coalesce(p_resume_state #>> '{opengeniRecovery,archive,status}', '') = 'available'
              OR (
                p_resume_state #> '{opengeniRecovery,archive}' IS NULL
                AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              )
            THEN null
            ELSE 'archive_unverified'
          END,
          'retryable', CASE
            WHEN coalesce(p_resume_state #>> '{opengeniRecovery,archive,status}', '') = 'available'
              OR (
                p_resume_state #> '{opengeniRecovery,archive}' IS NULL
                AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              )
            THEN null
            ELSE to_jsonb(false)
          END
        )),
        'workspace', jsonb_build_object(
          'status', CASE
            WHEN coalesce(p_resume_state #>> '{opengeniRecovery,archive,status}', '') = 'available'
              OR (
                p_resume_state #> '{opengeniRecovery,archive}' IS NULL
                AND coalesce(p_resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
                AND p_resume_state #> '{sessionState,workspaceArchiveMeta}' IS NOT NULL
              )
            THEN 'not_ready'
            ELSE 'degraded'
          END,
          'verifiedRevision', null,
          'verifiedAt', null
        )
      )
    ))
    ELSE null
  END;
$$;

-- Replace the existing global reaper in place. Its legacy 2-argument wrapper
-- continues delegating to this signature, but every warming reset now preserves
-- archive truth and advances the epoch before another owner can be elected.
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
  PERFORM set_config('opengeni.sandbox_recovery_protocol_v1', '1', true);

  DELETE FROM sandbox_lease_holders h
  WHERE h.kind = 'viewer'
    AND h.last_heartbeat_at < now() - make_interval(secs => p_viewer_holder_ttl_ms / 1000.0);

  IF p_turn_holder_ttl_ms > 0 THEN
    DELETE FROM sandbox_lease_holders h
    WHERE h.kind = 'turn'
      AND h.last_heartbeat_at < now() - make_interval(secs => p_turn_holder_ttl_ms / 1000.0);
  END IF;

  UPDATE sandbox_leases L SET
    refcount = c.total,
    turn_holders = c.turns,
    viewer_holders = c.viewers,
    liveness = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                    THEN 'draining' ELSE L.liveness END,
    expires_at = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                      THEN now() + make_interval(secs => p_idle_grace_ms / 1000.0)
                      ELSE L.expires_at END,
    updated_at = now()
  FROM (
    SELECT L2.id,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id)::int AS total,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'turn')::int AS turns,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'viewer')::int AS viewers
    FROM sandbox_leases L2
  ) c
  WHERE L.id = c.id;

  UPDATE sandbox_leases AS L SET
    liveness = 'cold',
    instance_id = null,
    lease_epoch = L.lease_epoch + 1,
    resume_state = opengeni_private.warming_reset_resume_state(
      L.backend,
      L.resume_backend_id,
      L.resume_state,
      clock_timestamp()
    ),
    resume_backend_id = CASE
      WHEN coalesce(L.resume_state #>> '{sessionState,workspaceArchive}', '') <> ''
        OR coalesce(L.resume_state #>> '{sessionState,workspaceArchivePrev}', '') <> ''
      THEN coalesce(L.resume_backend_id, L.backend)
      ELSE null
    END,
    data_plane_url = null,
    terminal_data_plane_url = null,
    updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NULL;

  UPDATE sandbox_leases AS L SET
    liveness = 'draining',
    refcount = 0,
    turn_holders = 0,
    viewer_holders = 0,
    data_plane_url = null,
    terminal_data_plane_url = null,
    expires_at = now() - interval '1 millisecond',
    updated_at = now()
  WHERE L.liveness = 'warming' AND L.expires_at < now() AND L.instance_id IS NOT NULL;

  RETURN QUERY
    SELECT L.workspace_id, L.sandbox_group_id, L.instance_id, L.lease_epoch
    FROM sandbox_leases L
    WHERE L.liveness = 'draining' AND L.expires_at < now() AND L.refcount = 0;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v1() TO opengeni_app;
  END IF;
END $$;