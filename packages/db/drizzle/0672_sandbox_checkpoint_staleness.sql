-- deployment-mode: rolling
-- Content-free fleet signal for how long live Modal sandboxes have held
-- unsaved workspace changes. A box with writes its last checkpoint did not
-- capture can lose all of them if the provider ends it uncaptured; before this,
-- nothing showed that a box had gone a whole day without a save.
--
-- A box counts as dirty only on evidence of an uncaptured write on this exact
-- box: a workspace mutation admission newer than the archive generation, or a
-- write still open (or settled) after the last checkpoint. A generation bump
-- with no write behind it (a fresh box, a restore) does not count. The clock
-- starts at the first uncaptured write, never before the box was created, so a
-- box that stayed clean for hours is not reported as hours stale. Inventory
-- only: no rows are returned, only counts and the oldest age.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_staleness_at(value text)
    RETURNS timestamptz
    LANGUAGE plpgsql STABLE SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF value IS NULL
        OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$' THEN
        RETURN NULL;
      END IF;
      RETURN value::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END
    $body$;

    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_staleness()
    RETURNS TABLE (
      dirty bigint,
      stale_4h bigint,
      stale_12h bigint,
      max_age_seconds double precision
    )
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH live AS (
        SELECT
          lease.id,
          lease.instance_id,
          coalesce(lease.archive_generation, 0) AS archived_generation,
          coalesce(lease.provider_created_at, lease.created_at) AS box_created_at,
          opengeni_private.sandbox_checkpoint_staleness_at(
            lease.resume_state #>> '{sessionState,workspaceArchiveAt}') AS checkpoint_at
        FROM %1$I.sandbox_leases lease
        WHERE lease.backend = 'modal'
          AND lease.liveness IN ('warm', 'draining')
          AND lease.instance_id IS NOT NULL
      ),
      evidence AS MATERIALIZED (
        SELECT
          live.box_created_at,
          -- A write admitted after the captured generation: unsaved since it
          -- was admitted.
          (SELECT pg_catalog.min(admission.admitted_at)
             FROM %1$I.sandbox_workspace_mutation_admissions admission
            WHERE admission.lease_id = live.id
              AND admission.provider_instance_id = live.instance_id
              AND admission.workspace_generation > live.archived_generation
          ) AS newer_write_at,
          -- A write the checkpoint ran around (a background command still
          -- open, or one that settled after the checkpoint): unsaved since
          -- that checkpoint. Only the latest captured write is checked for a
          -- settlement after the checkpoint, so the probe stays one index
          -- lookup instead of a walk over the lease's whole history; an older
          -- command that outlived a newer one is still caught while it runs.
          CASE WHEN EXISTS (
              SELECT 1
                FROM %1$I.sandbox_workspace_mutation_admissions admission
               WHERE admission.lease_id = live.id
                 AND admission.provider_instance_id = live.instance_id
                 AND admission.workspace_generation <= live.archived_generation
                 AND admission.settled_at IS NULL
            ) OR EXISTS (
              SELECT 1
                FROM (
                  SELECT admission.settled_at, admission.provider_instance_id
                    FROM %1$I.sandbox_workspace_mutation_admissions admission
                   WHERE admission.lease_id = live.id
                     AND admission.workspace_generation <= live.archived_generation
                   ORDER BY admission.workspace_generation DESC
                   LIMIT 1
                ) latest
               WHERE latest.provider_instance_id = live.instance_id
                 AND latest.settled_at > live.checkpoint_at
            )
            THEN coalesce(live.checkpoint_at, live.box_created_at)
          END AS spanning_write_at
        FROM live
      ),
      dirty_leases AS (
        SELECT extract(epoch FROM pg_catalog.now() - greatest(
          least(evidence.newer_write_at, evidence.spanning_write_at),
          evidence.box_created_at
        ))::double precision AS age_seconds
        FROM evidence
        WHERE evidence.newer_write_at IS NOT NULL
           OR evidence.spanning_write_at IS NOT NULL
      )
      SELECT
        pg_catalog.count(*)::bigint,
        pg_catalog.count(*) FILTER (WHERE age_seconds > 4 * 3600)::bigint,
        pg_catalog.count(*) FILTER (WHERE age_seconds > 12 * 3600)::bigint,
        coalesce(pg_catalog.max(age_seconds), 0)::double precision
      FROM dirty_leases;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_staleness_at(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_staleness() FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.sandbox_checkpoint_staleness() TO opengeni_app;
  END IF;
END
$grant$;

RESET statement_timeout;
RESET lock_timeout;
