-- deployment-mode: rolling
-- Read-only "is there anything to do?" checks for the deployment-wide
-- maintenance dispatchers. A worker evaluates one of these on every cadence
-- tick and starts the dispatcher workflow only when it returns true, so an idle
-- deployment no longer creates a workflow execution per tick.
--
-- Each check is a necessary condition of its dispatcher's own claim predicate
-- (a superset: it may say yes when the claim then finds nothing, never no when
-- the claim would find something). Checks take no row locks, write nothing,
-- and are answered from the same partial indexes the claims use. Each runs
-- with exactly the owner, grants and search path of the claim it previews, so
-- it sees precisely the rows that claim would see and grants no new authority.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE
  target_schema text := current_schema();
  probe record;
  role_name text;
  claim_owner text;
BEGIN
  -- Committed session-workflow wake revisions due for delivery: the unlocked
  -- preview of claim_session_workflow_wakes.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.session_workflow_wakes_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.session_workflow_wake_outbox o
        WHERE o.wake_revision > o.delivered_revision AND o.next_attempt_at <= now()
      )
    $body$;
  $definition$, target_schema);

  -- Undelivered automatic-title fanout rows: the candidate set of
  -- claim_automatic_session_title_fanout_v1.
  CREATE OR REPLACE FUNCTION opengeni_private.automatic_session_title_fanout_due_v1()
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $body$
    SELECT EXISTS (
      SELECT 1 FROM opengeni_private.automatic_session_title_fanout_outbox_v1 pending
      WHERE pending.delivered_at IS NULL
    )
  $body$;

  -- Knowledge index jobs the claim could lease for this embedding model. The
  -- dispatcher policy flag is the same one knowledge_index_claim sets.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.knowledge_index_due_v1(
      p_model text, p_dimensions integer)
    RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE previous text := current_setting('opengeni.knowledge_index_dispatcher', true);
      due boolean;
    BEGIN
      IF p_model IS NULL OR p_dimensions IS NULL OR length(p_model) NOT BETWEEN 1 AND 512
        OR p_dimensions NOT BETWEEN 1 AND 4096 THEN
        RAISE EXCEPTION 'Invalid Knowledge indexing probe' USING ERRCODE = '22023';
      END IF;
      PERFORM set_config('opengeni.knowledge_index_dispatcher', '1', true);
      SELECT EXISTS (
        SELECT 1 FROM %1$I.knowledge_index_jobs j
        WHERE j.state <> 'obsolete' AND j.next_attempt_at <= clock_timestamp()
          AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
          AND (j.state <> 'ready' OR j.model IS DISTINCT FROM p_model
            OR j.dimensions IS DISTINCT FROM p_dimensions)
      ) INTO due;
      PERFORM set_config('opengeni.knowledge_index_dispatcher', coalesce(previous, ''), true);
      RETURN due;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.knowledge_index_dispatcher', coalesce(previous, ''), true);
      RAISE;
    END $body$;
  $definition$, target_schema);

  -- Maintained site-auth connections that are due and not inside a live claim.
  -- Every claimable branch of claim_site_auth_maintenance requires either no
  -- operation or a claim older than the timeout, so this is its superset.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.site_auth_maintenance_due_v1(
      p_claim_timeout_ms bigint)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.site_auth_connections c
        WHERE c.status = 'active'
          AND c.health_policy->>'mode' = 'maintained'
          AND c.next_check_at <= clock_timestamp()
          AND (
            c.maintenance_operation_id IS NULL
            OR c.maintenance_claimed_at <= clock_timestamp() - (
              greatest(coalesce(p_claim_timeout_ms, 0), 0)::double precision
                * interval '1 millisecond')
          )
      )
    $body$;
  $definition$, target_schema);

  FOR probe IN
    SELECT * FROM (VALUES
      ('opengeni_private.session_workflow_wakes_due_v1()',
        'opengeni_private.claim_session_workflow_wakes(integer)'),
      ('opengeni_private.automatic_session_title_fanout_due_v1()',
        'opengeni_private.claim_automatic_session_title_fanout_v1(integer)'),
      ('opengeni_private.knowledge_index_due_v1(text,integer)',
        format('%I.knowledge_index_claim(text,integer,integer)', target_schema)),
      ('opengeni_private.site_auth_maintenance_due_v1(bigint)',
        'opengeni_private.claim_site_auth_maintenance(bigint,integer)')
    ) AS probes(signature, claim)
  LOOP
    -- Same owner as the claim it previews: the same RLS visibility and no new
    -- data-owner capability.
    SELECT pg_get_userbyid(proowner) INTO STRICT claim_owner FROM pg_proc
      WHERE oid = probe.claim::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', probe.signature, claim_owner);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', probe.signature);
    -- Preserve each claim's runtime grant set, including custom role names.
    FOR role_name IN SELECT rolname FROM pg_roles
      WHERE rolname <> current_user AND has_function_privilege(oid, probe.claim, 'EXECUTE')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', probe.signature, role_name);
    END LOOP;
  END LOOP;
END $install$;
