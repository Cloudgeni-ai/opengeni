-- deployment-mode: rolling
-- Bounded, tenant-fenced, actionable evidence for every connection
-- authority row that has not reached one of migration 0340's terminal shapes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The inspector needs owner visibility through FORCE RLS, but it must not
-- reuse 0340's write-capable backfill capability. A target-schema-local token
-- also prevents one OpenGeni schema from authorizing another schema in the
-- same database. The token is exact to backend, transaction, organization,
-- and invocation, and the runtime role has no table privileges.
CREATE TABLE connection_authority_convergence_audit_capabilities (
  capability_id uuid PRIMARY KEY,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON TABLE connection_authority_convergence_audit_capabilities FROM PUBLIC;

CREATE FUNCTION connection_authority_convergence_audit_capability_active(
  p_account_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $capability$
  SELECT EXISTS (
    SELECT 1
    FROM connection_authority_convergence_audit_capabilities capability
    WHERE capability.capability_id::text = nullif(pg_catalog.current_setting(
        'opengeni.connection_authority_convergence_audit_token', true
      ), '')
      AND capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.account_id = p_account_id
  )
$capability$;
REVOKE ALL ON FUNCTION
  connection_authority_convergence_audit_capability_active(uuid) FROM PUBLIC;

DO $connection_authority_convergence_audit_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connections',
    'organization_memberships',
    'organization_user_resource_authorities'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY connection_authority_convergence_audit_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || '%I.connection_authority_convergence_audit_capability_active(account_id))',
      data_schema, table_name, migration_owner, data_schema
    );
  END LOOP;
END
$connection_authority_convergence_audit_policies$;

CREATE FUNCTION inspect_organization_connection_authority_convergence(
  p_account_id uuid,
  p_limit integer DEFAULT 100,
  p_after_connection_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '1min'
AS $inspection$
DECLARE
  audit_capability_id uuid := pg_catalog.gen_random_uuid();
  previous_audit_token text := pg_catalog.current_setting(
    'opengeni.connection_authority_convergence_audit_token', true
  );
  report jsonb;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'connection convergence inspection requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_account_id IS DISTINCT FROM nullif(
    pg_catalog.current_setting('opengeni.account_id', true), ''
  )::uuid THEN
    RAISE EXCEPTION 'connection convergence inspection scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'connection convergence inspection limit must be 1..100'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO connection_authority_convergence_audit_capabilities (
    capability_id, backend_pid, transaction_id, account_id
  ) VALUES (
    audit_capability_id, pg_catalog.pg_backend_pid(),
    pg_catalog.pg_current_xact_id(), p_account_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.connection_authority_convergence_audit_token',
    audit_capability_id::text,
    true
  );

  -- A cursor is an organization-scoped persisted identifier, not an arbitrary
  -- UUID that may be used as a cross-tenant ordering oracle.
  IF p_after_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM connections connection_row
    WHERE connection_row.account_id = p_account_id
      AND connection_row.id = p_after_connection_id
  ) THEN
    RAISE EXCEPTION 'connection convergence inspection cursor is invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH classified AS MATERIALIZED (
    SELECT
      connection_row.id AS connection_id,
      connection_row.subject_id,
      CASE
        -- These are migration 0340's two terminal shapes. Exact terminal rows
        -- never appear in residual evidence.
        WHEN connection_row.authority_scope = 'workspace'
          AND connection_row.subject_id IS NULL
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND connection_row.origin_workspace_id = connection_row.workspace_id
          THEN NULL
        WHEN connection_row.authority_scope = 'user'
          AND connection_row.subject_id IS NOT NULL
          AND authority.id = connection_row.authority_id
          AND authority.resource_kind = 'connection'
          AND authority.resource_id = connection_row.id
          AND authority.organization_membership_id
            = connection_row.owner_organization_membership_id
          AND authority.origin_workspace_id = connection_row.origin_workspace_id
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
          AND owner_membership.id = connection_row.owner_organization_membership_id
          AND owner_membership.subject_id = connection_row.subject_id
          AND owner_membership.status = 'active'
          AND owner_membership.revoked_at IS NULL
          THEN NULL

        -- Only the exact legacy shape is eligible for an automated 0340
        -- transition. Malformed user or legacy rows need incident repair.
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND live_membership.id IS NOT NULL
          THEN 'connection_backfill_ready'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND terminal_membership.id IS NOT NULL
          THEN 'membership_lifecycle_review_required'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND (connection_row.subject_id IS NULL
            OR connection_row.subject_id NOT LIKE 'user:%')
          THEN 'external_subject_requires_classification'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND login.id IS NULL
          THEN 'missing_login_identity'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND (
            account.external_source IS DISTINCT FROM 'better-auth:user'
            OR account.external_id IS DISTINCT FROM substring(
              connection_row.subject_id FROM 6
            )
          )
          THEN 'organization_identity_mismatch'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND owner_access.id IS NULL
          THEN 'missing_owner_workspace_membership'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          THEN 'membership_backfill_eligible'
        WHEN connection_row.authority_scope = 'user'
          THEN 'conflicting_authority_rows'
        ELSE 'legacy_shape_unrecognized'
      END AS classification
    FROM connections connection_row
    JOIN managed_accounts account ON account.id = connection_row.account_id
    LEFT JOIN organization_memberships live_membership
      ON live_membership.account_id = connection_row.account_id
     AND live_membership.subject_id = connection_row.subject_id
     AND live_membership.status = 'active'
     AND live_membership.revoked_at IS NULL
    LEFT JOIN organization_memberships owner_membership
      ON owner_membership.id = connection_row.owner_organization_membership_id
     AND owner_membership.account_id = connection_row.account_id
    LEFT JOIN LATERAL (
      SELECT membership.id
      FROM organization_memberships membership
      WHERE membership.account_id = connection_row.account_id
        AND membership.subject_id = connection_row.subject_id
        AND (
          membership.status IN ('suspended', 'revoked')
          OR membership.revoked_at IS NOT NULL
        )
      ORDER BY membership.id
      LIMIT 1
    ) terminal_membership ON true
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = connection_row.authority_id
     AND authority.account_id = connection_row.account_id
    LEFT JOIN auth_users login
      ON connection_row.subject_id LIKE 'user:%'
     AND login.id = substring(connection_row.subject_id FROM 6)
    LEFT JOIN LATERAL (
      SELECT access.id
      FROM workspace_memberships access
      JOIN workspaces workspace
        ON workspace.id = access.workspace_id
       AND workspace.account_id = access.account_id
      WHERE access.account_id = connection_row.account_id
        AND access.subject_id = connection_row.subject_id
        AND access.role = 'owner'
      ORDER BY access.id
      LIMIT 1
    ) owner_access ON true
    WHERE connection_row.account_id = p_account_id
  ), residual AS MATERIALIZED (
    SELECT
      connection_id,
      subject_id,
      classification,
      CASE classification
        WHEN 'connection_backfill_ready'
          THEN 'run_connection_backfill'
        WHEN 'membership_backfill_eligible'
          THEN 'run_membership_backfill_then_connection_backfill'
        WHEN 'membership_lifecycle_review_required'
          THEN 'review_membership_lifecycle_do_not_reactivate_automatically'
        WHEN 'external_subject_requires_classification'
          THEN 'classify_external_subject_then_migrate_via_authorized_connection_lifecycle'
        WHEN 'missing_login_identity'
          THEN 'restore_login_identity_then_recheck'
        WHEN 'organization_identity_mismatch'
          THEN 'correct_organization_identity_through_supported_account_lifecycle_then_recheck'
        WHEN 'missing_owner_workspace_membership'
          THEN 'establish_owner_workspace_membership_through_supported_membership_lifecycle_then_recheck'
        WHEN 'conflicting_authority_rows'
          THEN 'repair_conflicting_connection_authority_rows_under_incident_procedure'
        ELSE 'repair_unrecognized_connection_authority_shape_under_incident_procedure'
      END AS action
    FROM classified
    WHERE classification IS NOT NULL
  ), page_candidates AS MATERIALIZED (
    SELECT *
    FROM residual
    WHERE p_after_connection_id IS NULL
      OR connection_id > p_after_connection_id
    ORDER BY connection_id
    LIMIT p_limit + 1
  ), page AS MATERIALIZED (
    SELECT * FROM page_candidates ORDER BY connection_id LIMIT p_limit
  ), aggregate AS (
    SELECT
      (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'connectionId', page.connection_id,
          'subjectId', page.subject_id,
          'classification', page.classification,
          'action', page.action
        ) ORDER BY page.connection_id), '[]'::jsonb) FROM page) AS items,
      (SELECT count(*)::int FROM page) AS returned,
      (SELECT count(*) > p_limit FROM page_candidates) AS has_more,
      (SELECT connection_id FROM page ORDER BY connection_id DESC LIMIT 1) AS next_id,
      count(*)::int AS remaining_total,
      count(*) FILTER (WHERE classification IN (
        'connection_backfill_ready', 'membership_backfill_eligible'
      ))::int AS auto_remediable,
      count(*) FILTER (WHERE classification NOT IN (
        'connection_backfill_ready', 'membership_backfill_eligible'
      ))::int AS manual_review,
      pg_catalog.jsonb_build_object(
        'connectionBackfillReady', count(*) FILTER (
          WHERE classification = 'connection_backfill_ready'
        )::int,
        'membershipBackfillEligible', count(*) FILTER (
          WHERE classification = 'membership_backfill_eligible'
        )::int,
        'membershipLifecycleReviewRequired', count(*) FILTER (
          WHERE classification = 'membership_lifecycle_review_required'
        )::int,
        'externalSubjectRequiresClassification', count(*) FILTER (
          WHERE classification = 'external_subject_requires_classification'
        )::int,
        'missingLoginIdentity', count(*) FILTER (
          WHERE classification = 'missing_login_identity'
        )::int,
        'organizationIdentityMismatch', count(*) FILTER (
          WHERE classification = 'organization_identity_mismatch'
        )::int,
        'missingOwnerWorkspaceMembership', count(*) FILTER (
          WHERE classification = 'missing_owner_workspace_membership'
        )::int,
        'conflictingAuthorityRows', count(*) FILTER (
          WHERE classification = 'conflicting_authority_rows'
        )::int,
        'legacyShapeUnrecognized', count(*) FILTER (
          WHERE classification = 'legacy_shape_unrecognized'
        )::int
      ) AS by_classification
    FROM residual
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_account_id,
    'limit', p_limit,
    'afterConnectionId', p_after_connection_id,
    'items', aggregate.items,
    'returned', aggregate.returned,
    'hasMore', aggregate.has_more,
    'nextCursor', CASE WHEN aggregate.has_more THEN aggregate.next_id ELSE NULL END,
    'remaining', pg_catalog.jsonb_build_object(
      'total', aggregate.remaining_total,
      'autoRemediable', aggregate.auto_remediable,
      'manualReview', aggregate.manual_review,
      'byClassification', aggregate.by_classification
    )
  ) INTO report
  FROM aggregate;

  DELETE FROM connection_authority_convergence_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM pg_catalog.set_config(
    'opengeni.connection_authority_convergence_audit_token',
    coalesce(previous_audit_token, ''),
    true
  );
  RETURN report;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM connection_authority_convergence_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM pg_catalog.set_config(
    'opengeni.connection_authority_convergence_audit_token',
    coalesce(previous_audit_token, ''),
    true
  );
  RAISE;
END
$inspection$;
REVOKE ALL ON FUNCTION inspect_organization_connection_authority_convergence(
  uuid, integer, uuid
) FROM PUBLIC;

DO $connection_authority_convergence_audit_hardening$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.connection_authority_convergence_audit_capability_active(uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.inspect_organization_connection_authority_convergence(uuid,integer,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.connection_authority_convergence_audit_capability_active(uuid) TO opengeni_app',
      data_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.inspect_organization_connection_authority_convergence(uuid,integer,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$connection_authority_convergence_audit_hardening$;

COMMENT ON TABLE connection_authority_convergence_audit_capabilities IS
  'Invocation-scoped, target-local read capability for connection convergence evidence.';
COMMENT ON FUNCTION connection_authority_convergence_audit_capability_active(uuid) IS
  'True only for the exact backend, transaction, organization, and opaque convergence-audit token.';
COMMENT ON FUNCTION inspect_organization_connection_authority_convergence(
  uuid, integer, uuid
) IS
  'Bounded tenant-fenced residual connection evidence with global remaining counts and fixed remediation actions. Never writes authority.';
