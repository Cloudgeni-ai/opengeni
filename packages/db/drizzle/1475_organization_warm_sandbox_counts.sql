-- deployment-mode: rolling
-- Organization-wide sandbox counts for plan-tiered sandbox limits
-- (docs/deployment.md, "Viewer-only compute").
--
-- Sandbox leases are workspace-scoped (FORCE RLS on account + workspace), so
-- a limit that one organization must not escape by spreading boxes over many
-- workspaces, or one member must not exhaust for colleagues, needs a count
-- across the organization's workspaces. This definer returns three numbers
-- for the CALLER's own organization only (the account GUC must match), as
-- counts and nothing else:
--
--   viewer_only_boxes          warming/warm leases no turn holds that a viewer
--                              keeps warm
--   subject_viewer_only_boxes  the same, kept warm by p_subject's own viewer
--   running_boxes              warming/warm/draining leases of a managed
--                              provider (a Connected Machine is the user's
--                              own computer and never counts)
--
-- p_exclude_lease leaves out the lease being admitted. Like
-- list_organization_slack_bots it reads each workspace under that workspace's
-- own RLS context, then restores the caller's workspace setting, so FORCE RLS
-- still decides what it sees.
--
-- As 0937, 0978, 1060 and 1404 explain, the previous release rejects a
-- runtime EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it the runtime keeps enforcing only
-- the per-workspace viewer limit (as before).
--
-- Rolling: one read-only definer the previous release never calls.
SET LOCAL lock_timeout = '5s';

DO $organization_warm_sandbox_counts$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.organization_warm_sandbox_counts_v1(
      p_account uuid, p_subject text, p_exclude_lease uuid)
    RETURNS TABLE(viewer_only_boxes integer, subject_viewer_only_boxes integer,
      running_boxes integer)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      prior_workspace text;
      member record;
      viewer_only integer := 0;
      subject_viewer_only integer := 0;
      running integer := 0;
      part_viewer_only integer;
      part_subject integer;
      part_running integer;
    BEGIN
      IF p_account IS NULL OR p_account IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'organization sandbox count scope mismatch' USING ERRCODE = '42501';
      END IF;
      prior_workspace := pg_catalog.current_setting('opengeni.workspace_id', true);
      FOR member IN SELECT w.id FROM workspaces w WHERE w.account_id = p_account ORDER BY w.id LOOP
        PERFORM pg_catalog.set_config('opengeni.workspace_id', member.id::text, true);
        SELECT
          pg_catalog.count(*) FILTER (WHERE lease.liveness IN ('warming', 'warm')
            AND lease.turn_holders = 0
            AND EXISTS (SELECT 1 FROM sandbox_lease_holders h
              WHERE h.lease_id = lease.id AND h.kind = 'viewer'))::integer,
          pg_catalog.count(*) FILTER (WHERE p_subject IS NOT NULL
            AND lease.liveness IN ('warming', 'warm')
            AND lease.turn_holders = 0
            AND EXISTS (SELECT 1 FROM sandbox_lease_holders h
              WHERE h.lease_id = lease.id AND h.kind = 'viewer'
                AND h.viewer_subject_id = p_subject))::integer,
          pg_catalog.count(*) FILTER (WHERE lease.liveness IN ('warming', 'warm', 'draining')
            AND lease.backend <> 'selfhosted')::integer
        INTO part_viewer_only, part_subject, part_running
        FROM sandbox_leases lease
        WHERE lease.account_id = p_account AND lease.workspace_id = member.id
          AND lease.id IS DISTINCT FROM p_exclude_lease;
        viewer_only := viewer_only + part_viewer_only;
        subject_viewer_only := subject_viewer_only + part_subject;
        running := running + part_running;
      END LOOP;
      PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
      RETURN QUERY SELECT viewer_only, subject_viewer_only, running;
    END
    $body$
  $definition$, data_schema);
END
$organization_warm_sandbox_counts$;

REVOKE ALL ON FUNCTION opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid)
  FROM PUBLIC;
