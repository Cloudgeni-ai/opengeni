-- deployment-mode: rolling
-- The checkpoint-staleness inventory (migration 0672) checked only the
-- highest-generation captured write for a settlement after the last
-- checkpoint. A long background command the checkpoint ran around can outlive
-- a newer captured write: the newer one settles before the checkpoint, the
-- command keeps writing and settles after it, and the box was not counted
-- dirty. Any captured write on the exact box that settled after the checkpoint
-- now counts, aged from that checkpoint. The lookup is a range scan over the
-- lease's writes settled after the checkpoint (index from migration 0680), so
-- it stays bounded by recent writes rather than the lease's whole history.
-- An attached viewer or interaction (desktop/terminal tab, browser or computer
-- controller) can write without a generation admission, so it also counts,
-- aged from the later of the checkpoint and the attach.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
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
            lease.resume_state #>> '{sessionState,workspaceArchiveAt}') AS checkpoint_at,
          (SELECT pg_catalog.min(holder.created_at)
             FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id
              AND holder.kind IN ('viewer', 'interaction')) AS writer_attached_at
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
          -- open, or any captured write that settled after the checkpoint):
          -- unsaved since that checkpoint.
          CASE WHEN EXISTS (
              SELECT 1
                FROM %1$I.sandbox_workspace_mutation_admissions admission
               WHERE admission.lease_id = live.id
                 AND admission.provider_instance_id = live.instance_id
                 AND admission.workspace_generation <= live.archived_generation
                 AND admission.settled_at IS NULL
            ) OR EXISTS (
              SELECT 1
                FROM %1$I.sandbox_workspace_mutation_admissions admission
               WHERE admission.lease_id = live.id
                 AND admission.settled_at > live.checkpoint_at
                 AND admission.provider_instance_id = live.instance_id
                 AND admission.workspace_generation <= live.archived_generation
            )
            THEN coalesce(live.checkpoint_at, live.box_created_at)
          END AS spanning_write_at,
          -- A writer that bypasses admissions: unsaved since it attached, or
          -- since the checkpoint it was attached through.
          CASE WHEN live.writer_attached_at IS NOT NULL THEN greatest(
            live.writer_attached_at, coalesce(live.checkpoint_at, live.box_created_at))
          END AS untracked_write_at
        FROM live
      ),
      dirty_leases AS (
        SELECT extract(epoch FROM pg_catalog.now() - greatest(
          least(evidence.newer_write_at, evidence.spanning_write_at,
            evidence.untracked_write_at),
          evidence.box_created_at
        ))::double precision AS age_seconds
        FROM evidence
        WHERE evidence.newer_write_at IS NOT NULL
           OR evidence.spanning_write_at IS NOT NULL
           OR evidence.untracked_write_at IS NOT NULL
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
