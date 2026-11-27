-- deployment-mode: rolling
-- Six SECURITY DEFINER maintenance routines found and claimed nothing under
-- an owner without BYPASSRLS, the posture docs/deployment.md describes. They
-- read and update every tenant's rows but opened no capability, so FORCE ROW
-- LEVEL SECURITY hid every row from their owner. Production's owner bypasses
-- row security, so only such installs lost browser state cleanup, Memory
-- Slack delivery, Slack App Home refresh, Slack inbox processing and legacy
-- Modal checkpoint migration.
--
-- Each call now opens its own capability for its own transaction:
--   claim_browser_state_artifact_cleanup  'browser_artifact_cleanup' (1682)
--   claim_browser_state_upload_cleanup    'browser_upload_cleanup' (1683-1686)
--   claim_memory_slack_publication        'memory_slack_delivery' (1687-1689)
--   claim_slack_app_home_refresh          'slack_app_home' (1690)
--   claim_slack_interaction_inbox         'slack_inbox' (1691)
-- and list_legacy_modal_checkpoint_slots opens the Modal inventory read
-- capability its sibling list_live_modal_sandbox_leases already opens, which
-- sandbox_leases' modal_inventory_owner_read policy admits for the owner.
-- The new policies apply to the owner role alone and are InitPlans, evaluated
-- once per statement; an owner that bypasses row security never evaluates
-- them, so production's results and plans are unchanged. The capability row
-- is written after the argument checks and deleted before the routine
-- returns its rows; an error rolls it back with the (sub)transaction that
-- inserted it, so no exception block (and no subtransaction) is needed.
--
-- The two browser state claimers become PL/pgSQL to write and remove the
-- claim around the same query; each query is otherwise unchanged.
--
-- Rolling: the previous release calls the same signatures and gets the same
-- rows, and a capability admits only this call's own transaction. CREATE OR
-- REPLACE keeps the owner, ACL and signature. CREATE OR REPLACE FUNCTION
-- takes no table lock; each attempt still waits at most 300 ms for any lock
-- and a busy catalog is retried after a short random pause.
DO $migration$
DECLARE
  data_schema constant text := current_schema();
  attempt integer;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(p_claim_timeout_ms bigint, p_limit integer) RETURNS TABLE(claim_id uuid, artifact_id uuid, account_id uuid, workspace_id uuid, object_key text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    #variable_conflict use_column
    DECLARE capability_id uuid := gen_random_uuid();
    BEGIN
      INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
        (capability_id, pg_backend_pid(), pg_current_xact_id(), 'browser_artifact_cleanup');
      RETURN QUERY
      WITH candidates AS (
        SELECT A.id, gen_random_uuid() AS claim_id
        FROM %1$I.browser_state_artifacts A
        WHERE A.purpose = 'private_checkpoint'
          AND (
            (
              A.state = 'delete_pending'
              AND A.retained_until <= clock_timestamp()
            )
            OR (
              A.state = 'deleting'
              AND A.delete_claimed_at <= clock_timestamp() - (
                greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
              )
            )
          )
        ORDER BY coalesce(A.delete_claimed_at, A.retained_until), A.id
        LIMIT least(greatest(p_limit, 0), 1000)
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE %1$I.browser_state_artifacts A
        SET state = 'deleting',
          delete_claim_id = C.claim_id,
          delete_claimed_at = clock_timestamp()
        FROM candidates C
        WHERE A.id = C.id
        RETURNING A.*, C.claim_id
      )
      SELECT C.claim_id, C.id, C.account_id, C.workspace_id, C.object_key
      FROM claimed C;
      DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
    END $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_browser_state_upload_cleanup(p_claim_timeout_ms bigint, p_limit integer) RETURNS TABLE(claim_id uuid, upload_id uuid, account_id uuid, workspace_id uuid, object_key text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    #variable_conflict use_column
    DECLARE capability_id uuid := gen_random_uuid();
    BEGIN
      INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
        (capability_id, pg_backend_pid(), pg_current_xact_id(), 'browser_upload_cleanup');
      RETURN QUERY
      WITH due AS MATERIALIZED (
        SELECT U.id, U.workspace_id, U.operation_id
        FROM %1$I.browser_state_uploads U
        WHERE (
            U.state IN ('prepared', 'delete_pending')
            AND U.cleanup_after <= clock_timestamp()
          ) OR (
            U.state = 'deleting'
            AND U.delete_claimed_at <= clock_timestamp() - (
              greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
            )
          )
        ORDER BY coalesce(U.delete_claimed_at, U.cleanup_after), U.id
        LIMIT least(greatest(p_limit, 0), 1000)
      ), locked_operations AS MATERIALIZED (
        SELECT O.workspace_id, O.operation_id,
          O.state AS operation_state, O.kind AS operation_kind
        FROM %1$I.interaction_operations O
        WHERE EXISTS (
          SELECT 1 FROM due D
          WHERE D.workspace_id = O.workspace_id
            AND D.operation_id = O.operation_id
        )
        FOR UPDATE OF O SKIP LOCKED
      ), candidates AS (
        SELECT U.id, gen_random_uuid() AS claim_id, U.state AS upload_state,
          O.operation_state, O.operation_kind
        FROM due D
        JOIN locked_operations O
          ON O.workspace_id = D.workspace_id
         AND O.operation_id = D.operation_id
        JOIN %1$I.browser_state_uploads U ON U.id = D.id
        WHERE (
            U.state IN ('prepared', 'delete_pending')
            AND U.cleanup_after <= clock_timestamp()
          ) OR (
            U.state = 'deleting'
            AND U.delete_claimed_at <= clock_timestamp() - (
              greatest(p_claim_timeout_ms, 0)::double precision * interval '1 millisecond'
            )
          )
        ORDER BY coalesce(U.delete_claimed_at, U.cleanup_after), U.id
        FOR UPDATE OF U SKIP LOCKED
      ), claimed AS (
        UPDATE %1$I.browser_state_uploads U
        SET state = 'deleting', delete_claim_id = C.claim_id,
          delete_claimed_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM candidates C
        WHERE U.id = C.id
        RETURNING U.*, C.claim_id, C.upload_state, C.operation_state, C.operation_kind
      ), timed_out_operations AS (
        UPDATE %1$I.interaction_operations O
        SET state = CASE
            WHEN C.operation_state = 'dispatched' THEN 'outcome_unknown'
            ELSE 'failed'
          END,
          error_code = 'browser_state_upload_expired',
          error_message = CASE
            WHEN C.operation_state = 'dispatched'
              THEN 'Browser state upload outcome was not published before its authority expired'
            ELSE 'Browser state upload authority expired before dispatch'
          END,
          error_retryable = false, error_details = null,
          settled_at = clock_timestamp(), updated_at = clock_timestamp()
        FROM claimed C
        WHERE C.upload_state = 'prepared'
          AND O.workspace_id = C.workspace_id
          AND O.operation_id = C.operation_id
          AND O.state IN ('prepared', 'dispatched')
        RETURNING O.account_id, O.workspace_id, O.resource_id, O.kind,
          C.operation_state
      ), timed_out_sessions AS (
        UPDATE %1$I.browser_sessions S
        SET lifecycle = CASE
            WHEN T.operation_state = 'dispatched' THEN 'lost'
            ELSE 'active'
          END,
          failure_code = CASE
            WHEN T.operation_state = 'dispatched' THEN 'browser_state_upload_expired'
            ELSE NULL
          END,
          updated_at = clock_timestamp()
        FROM timed_out_operations T
        WHERE T.kind = 'suspend'
          AND S.workspace_id = T.workspace_id
          AND S.id = T.resource_id
          AND S.lifecycle = 'suspending'
        RETURNING S.account_id, S.workspace_id
      ), advanced_revisions AS (
        UPDATE %1$I.workspace_interaction_revisions R
        SET revision = R.revision + 1, updated_at = clock_timestamp()
        FROM (
          SELECT DISTINCT account_id, workspace_id FROM timed_out_sessions
        ) S
        WHERE R.account_id = S.account_id AND R.workspace_id = S.workspace_id
        RETURNING R.workspace_id
      )
      SELECT C.claim_id, C.id, C.account_id, C.workspace_id, C.object_key
      FROM claimed C;
      DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
    END $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_memory_slack_publication(p_holder uuid, p_lease_ms integer) RETURNS SETOF %1$I.memory_slack_publications
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    DECLARE capability_id uuid := gen_random_uuid();
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid memory Slack publication claim lease';
      END IF;
      INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
        (capability_id, pg_backend_pid(), pg_current_xact_id(), 'memory_slack_delivery');
      RETURN QUERY
      WITH candidate AS (
        SELECT P.id
        FROM %1$I.memory_slack_publications P
        WHERE (
            P.state = 'queued'
          ) OR (
            P.state = 'retry_wait'
            AND P.retry_at <= now()
          ) OR (
            P.state = 'delivering'
            AND P.claim_expires_at <= now()
          )
        ORDER BY P.retry_at NULLS FIRST, P.created_at, P.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE %1$I.memory_slack_publications P
        SET state = 'delivering',
            claim_holder_id = p_holder,
            claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
            retry_at = NULL,
            attempt_count = P.attempt_count + 1,
            updated_at = now()
        FROM candidate C
        WHERE P.id = C.id
        RETURNING P.*
      ), receipt AS (
        INSERT INTO %1$I.memory_slack_publication_receipts (
          account_id, workspace_id, publication_id, sequence, kind, state,
          attempt_number, actor_kind, actor_subject_id, operation_id
        )
        SELECT
          C.account_id, C.workspace_id, C.id,
          COALESCE((
            SELECT max(R.sequence)
            FROM %1$I.memory_slack_publication_receipts R
            WHERE R.publication_id = C.id
          ), 0) + 1,
          'delivery_claimed', 'delivering', C.attempt_count,
          'service', 'memory-slack-delivery', C.operation_id
        FROM claimed C
        RETURNING publication_id
      )
      SELECT C.*
      FROM claimed C
      JOIN receipt R ON R.publication_id = C.id;
      DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
    END
    $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_app_home_refresh(p_holder uuid, p_lease_ms integer) RETURNS SETOF %1$I.slack_app_home_refreshes
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    DECLARE capability_id uuid := gen_random_uuid();
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack App Home claim lease';
      END IF;
      INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
        (capability_id, pg_backend_pid(), pg_current_xact_id(), 'slack_app_home');
      RETURN QUERY
      WITH candidate AS (
        SELECT refresh.id
        FROM %1$I.slack_app_home_refreshes refresh
        WHERE refresh.processed_revision < refresh.desired_revision
          AND (refresh.retry_at IS NULL OR refresh.retry_at <= now())
          AND (refresh.claim_holder_id IS NULL OR refresh.claim_expires_at <= now())
        ORDER BY refresh.retry_at NULLS FIRST, refresh.updated_at, refresh.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_app_home_refreshes refresh
      SET claim_holder_id = p_holder,
          claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          retry_at = NULL,
          attempt_count = refresh.attempt_count + 1,
          updated_at = now()
      FROM candidate
      WHERE refresh.id = candidate.id
      RETURNING refresh.*;
      DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
    END
    $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_inbox(p_holder uuid, p_lease_ms integer) RETURNS SETOF %1$I.slack_interaction_inbox
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    DECLARE capability_id uuid := gen_random_uuid();
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack inbox claim lease';
      END IF;
      INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
        (capability_id, pg_backend_pid(), pg_current_xact_id(), 'slack_inbox');
      RETURN QUERY
      WITH candidate AS (
        SELECT I.id
        FROM %1$I.slack_interaction_inbox I
        WHERE (
            I.status = 'pending'
            AND (I.retry_at IS NULL OR I.retry_at <= now())
          ) OR (
            I.status = 'processing'
            AND I.claim_expires_at <= now()
          )
        ORDER BY I.retry_at NULLS FIRST, I.created_at, I.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_interaction_inbox I
      SET status = 'processing',
          claim_holder_id = p_holder,
          claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          retry_at = NULL,
          attempt_count = I.attempt_count + 1,
          updated_at = now()
      FROM candidate C
      WHERE I.id = C.id
      RETURNING I.*;
      DELETE FROM opengeni_private.maintenance_claim_capabilities claim WHERE claim.id = capability_id;
    END
    $body$;
      $create$, data_schema);

      EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(p_limit integer) RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid, lease_id uuid, lease_epoch integer, instance_id text, workspace_generation integer, slot text, archive_base64 text, descriptor jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    DECLARE opened integer;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'legacy checkpoint slot limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;
      INSERT INTO opengeni_private.modal_inventory_read_capabilities (
        backend_pid, transaction_id, data_schema
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %1$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;

      RETURN QUERY
        SELECT lease.account_id, lease.workspace_id, lease.sandbox_group_id, lease.id,
          lease.lease_epoch, lease.instance_id,
          lease.workspace_generation, candidate.slot, candidate.archive_base64,
          candidate.descriptor
        FROM %1$I.sandbox_leases lease
        CROSS JOIN LATERAL (
          VALUES
            (
              'current'::text,
              lease.resume_state #>> '{sessionState,workspaceArchive}',
              lease.resume_state #> '{sessionState,workspaceArchiveMeta}',
              lease.current_checkpoint_artifact_id
            ),
            (
              'previous'::text,
              lease.resume_state #>> '{sessionState,workspaceArchivePrev}',
              lease.resume_state #> '{sessionState,workspaceArchivePrevMeta}',
              lease.previous_checkpoint_artifact_id
            )
        ) candidate(slot, archive_base64, descriptor, artifact_id)
        WHERE candidate.artifact_id IS NULL
          AND lease.backend = 'modal'
          AND lease.liveness IN ('warming', 'warm', 'draining')
          AND lease.instance_id IS NOT NULL
          AND coalesce(candidate.archive_base64, '') <> ''
          AND candidate.descriptor ->> 'version' = '2'
          AND candidate.descriptor ->> 'provider'
            IN ('modal_snapshot_filesystem', 'modal_snapshot_directory')
        ORDER BY lease.updated_at, lease.id, candidate.slot
        LIMIT p_limit;

      -- An enclosing call that opened the capability first removes it itself.
      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %1$L;
      END IF;
    END;
    $body$;
      $create$, data_schema);
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      -- Nothing is held after the rollback to this block; wait and retry.
      IF attempt = 30 THEN RAISE; END IF;
      PERFORM pg_catalog.pg_sleep(pg_catalog.random() * least(0.05 * attempt, 0.4));
    END;
  END LOOP;
END
$migration$;
