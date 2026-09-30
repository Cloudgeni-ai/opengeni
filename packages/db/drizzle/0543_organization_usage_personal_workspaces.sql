-- deployment-mode: rolling
-- Organization usage lists each member's Personal workspace as a usage-only
-- row keyed by the owner's organization membership. Period totals already
-- counted this usage; only the breakdown was missing it. The row carries no
-- Personal workspace id, name, session or content: billing readers learn how
-- much a member's Personal workspace used, never what it was used for, and
-- gain no access to it. Zero-use Personal workspaces stay absent. The shared
-- workspace inventory, its cursor, the actor-visible session rule and every
-- policy are unchanged; the signature and ACL stay, so old API processes
-- keep working and simply ignore the new response fields.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $functions$
DECLARE data_schema text := pg_catalog.current_schema();
BEGIN
  IF pg_catalog.to_regprocedure('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'Organization usage Personal rows require the 0473 aggregate' USING ERRCODE = '55000';
  END IF;
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.organization_usage_summary(
      p_account_id uuid, p_since timestamptz, p_until timestamptz,
      p_granularity text, p_after_workspace_id uuid, p_include_period boolean
    ) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET plan_cache_mode = force_custom_plan
    AS $fn$
    DECLARE
      context_account_id uuid;
      context_subject_id text;
      context_human_id text;
      page_ids uuid[];
      next_cursor uuid;
      personal_workspace_ids uuid[] := '{}'::uuid[];
      personal_membership_ids uuid[] := '{}'::uuid[];
      previous_lifecycle text;
      response jsonb;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(current_setting('opengeni.account_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Organization usage account context is malformed' USING ERRCODE = '42501';
      END;
      context_subject_id := nullif(current_setting('opengeni.subject_id', true), '');
      context_human_id := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
      IF context_account_id IS NULL OR context_account_id IS DISTINCT FROM p_account_id
        OR nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
      THEN
        RAISE EXCEPTION 'Organization usage requires the exact account-only context' USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until)
        OR p_until < p_since OR p_until - p_since > interval '366 days'
        OR p_granularity IS NULL OR p_granularity NOT IN ('hour', 'day')
        OR (p_granularity = 'hour' AND p_until - p_since > interval '1 day')
        OR p_include_period IS NULL
      THEN
        RAISE EXCEPTION 'Organization usage window or granularity is invalid' USING ERRCODE = '22023';
      END IF;
      -- Match listSharedWorkspacesForAccount: canonical membership pointers
      -- exclude EVERY Personal workspace before lookahead/cursor selection.
      -- Names, kind guesses and caller-owned Personal exceptions are forbidden.
      SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO page_ids
      FROM (SELECT id FROM %1$I.workspaces
        WHERE account_id = context_account_id
          AND id IN (SELECT workspace_id FROM %1$I.list_organization_workspace_ids(context_account_id))
          AND (p_after_workspace_id IS NULL OR id > p_after_workspace_id)
        ORDER BY id LIMIT 51) page;
      IF cardinality(page_ids) > 50 THEN
        next_cursor := page_ids[50];
        page_ids := page_ids[1:50];
      END IF;

      -- Personal rows come only with the period view. The same canonical
      -- pointers classify them, read through the membership-lifecycle policy
      -- that list_organization_workspace_ids uses, restored before any usage
      -- fact is read.
      IF p_include_period THEN
        previous_lifecycle := current_setting('opengeni.organization_tenancy_lifecycle', true);
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
        BEGIN
          SELECT coalesce(array_agg(membership.personal_workspace_id ORDER BY membership.id), '{}'::uuid[]),
            coalesce(array_agg(membership.id ORDER BY membership.id), '{}'::uuid[])
          INTO personal_workspace_ids, personal_membership_ids
          FROM %1$I.organization_memberships membership
          JOIN %1$I.workspaces workspace
            ON workspace.id = membership.personal_workspace_id
            AND workspace.account_id = context_account_id
          WHERE membership.account_id = context_account_id
            AND membership.personal_workspace_id IS NOT NULL;
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
          RAISE;
        END;
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
      END IF;

      INSERT INTO opengeni_private.organization_usage_read_capabilities
        (backend_pid, transaction_id, account_id, subject_id, initiating_human_subject_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), context_account_id, context_subject_id, context_human_id);
      BEGIN
        WITH visible_sessions AS MATERIALIZED (
          -- Sessions retain ordinary FORCE RLS. Private actor checks occur
          -- once per session here, never once per fact in the aggregate scan.
          SELECT id, account_id, workspace_id FROM %1$I.sessions session_row
          WHERE account_id = context_account_id
            AND (p_include_period OR workspace_id = ANY(page_ids))
            AND (context_subject_id IS NULL OR visibility = 'workspace_shared'
              OR %1$I.session_private_actor_visible(account_id, workspace_id,
                owner_organization_membership_id, owner_subject_id))
        ), visible AS MATERIALIZED (
          SELECT usage_row.workspace_id, usage_row.event_type, usage_row.unit, usage_row.quantity,
            CASE WHEN p_include_period THEN to_char(date_trunc(p_granularity, usage_row.occurred_at AT TIME ZONE 'UTC'),
              CASE WHEN p_granularity = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END) END AS bucket
          FROM %1$I.usage_events usage_row
          LEFT JOIN visible_sessions session_row
            ON session_row.id = usage_row.session_id
            AND session_row.account_id = usage_row.account_id
            AND session_row.workspace_id = usage_row.workspace_id
          WHERE usage_row.account_id = context_account_id
            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until
            AND (p_include_period OR usage_row.workspace_id = ANY(page_ids))
            AND (usage_row.session_id IS NULL OR session_row.id IS NOT NULL)
        ), aggregates AS MATERIALIZED (
          SELECT workspace_id, bucket, grouping(workspace_id) AS all_workspaces,
            grouping(bucket) AS all_buckets,
            jsonb_build_object('eventType', event_type, 'unit', unit,
              'quantity', sum(quantity)::text, 'eventCount', count(*)::text) AS total
          FROM visible GROUP BY GROUPING SETS
            ((event_type, unit), (bucket, event_type, unit), (workspace_id, event_type, unit))
        ), bucket_rows AS (
          SELECT bucket, jsonb_agg(total ORDER BY total->>'eventType', total->>'unit') AS totals
          FROM aggregates WHERE all_buckets = 0 AND p_include_period GROUP BY bucket
        ), workspace_rows AS (
          SELECT workspace_id, jsonb_agg(total ORDER BY total->>'eventType', total->>'unit') AS totals
          FROM aggregates WHERE all_workspaces = 0 AND workspace_id = ANY(page_ids) GROUP BY workspace_id
        ), personal_rows AS MATERIALIZED (
          -- Only Personal workspaces with visible usage in the window. Ranked
          -- by spend, then tokens, so a bounded list keeps the largest.
          SELECT pointer.membership_id,
            jsonb_agg(aggregate_row.total ORDER BY aggregate_row.total->>'eventType', aggregate_row.total->>'unit') AS totals,
            coalesce(sum((aggregate_row.total->>'quantity')::numeric) FILTER (
              WHERE aggregate_row.total->>'eventType' = 'model.cost' AND aggregate_row.total->>'unit' = 'usd_micros'), 0) AS spend,
            coalesce(sum((aggregate_row.total->>'quantity')::numeric) FILTER (
              WHERE aggregate_row.total->>'eventType' = 'model.tokens'), 0) AS tokens
          FROM unnest(personal_workspace_ids, personal_membership_ids) AS pointer(workspace_id, membership_id)
          JOIN aggregates aggregate_row
            ON aggregate_row.all_workspaces = 0 AND aggregate_row.all_buckets = 1
            AND aggregate_row.workspace_id = pointer.workspace_id
          WHERE p_include_period
          GROUP BY pointer.membership_id
        )
        SELECT jsonb_build_object(
          'totals', CASE WHEN p_include_period THEN coalesce((SELECT jsonb_agg(total ORDER BY total->>'eventType', total->>'unit')
            FROM aggregates WHERE all_workspaces = 1 AND all_buckets = 1), '[]'::jsonb) ELSE NULL END,
          'buckets', CASE WHEN p_include_period THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'totals', totals) ORDER BY bucket)
            FROM bucket_rows), '[]'::jsonb) ELSE NULL END,
          'workspaces', coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId', w.id, 'name', w.name,
            'totals', coalesce(r.totals, '[]'::jsonb)) ORDER BY w.id)
            FROM %1$I.workspaces w LEFT JOIN workspace_rows r ON r.workspace_id = w.id
            WHERE w.account_id = context_account_id AND w.id = ANY(page_ids)), '[]'::jsonb),
          'nextWorkspaceCursor', next_cursor,
          'personalWorkspaces', CASE WHEN p_include_period THEN coalesce((
            SELECT jsonb_agg(jsonb_build_object('membershipId', ranked.membership_id, 'totals', ranked.totals)
              ORDER BY ranked.spend DESC, ranked.tokens DESC, ranked.membership_id)
            FROM (SELECT membership_id, totals, spend, tokens FROM personal_rows
              ORDER BY spend DESC, tokens DESC, membership_id LIMIT 50) ranked), '[]'::jsonb) ELSE NULL END,
          'personalWorkspaceCount', CASE WHEN p_include_period THEN (SELECT count(*) FROM personal_rows) ELSE NULL END
        ) INTO response;

        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        RETURN response;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        RAISE;
      END;
    END
    $fn$;
    REVOKE ALL ON FUNCTION opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean) FROM PUBLIC;
  $ddl$, data_schema);
END
$functions$;
