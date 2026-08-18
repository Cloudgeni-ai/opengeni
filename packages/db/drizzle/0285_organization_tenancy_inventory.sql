-- deployment-mode: rolling
-- Migration 0285: read-only organization tenancy inventory seam.
--
-- The tenancy backfill/parity program needs one authoritative, content-free
-- count of every legacy-attribution population before any backfill or cutover
-- gate can be stated: sessions without a canonical owner, resources without an
-- explicit authority classification, connections per authority lane, humans
-- with workspace access but no organization-membership anchor, active
-- memberships without a personal workspace, unattributed workspace writers,
-- and the two linked-input gates (documents without common authority; Codex
-- credentials without a recorded connecting human - both owned by their own
-- issues and only COUNTED here).
--
-- The seam is strictly read-only and returns integers only: no identities, no
-- names, no keys, no values. It validates the caller's account RLS context
-- against the requested organization exactly like the other tenancy seams and
-- is executable only by the application role. Nothing here changes runtime
-- authority, RLS posture, or any write path.
--
-- FORCE RLS + SECURITY DEFINER note: every counted table is FORCE ROW LEVEL
-- SECURITY, which applies even to the function owner unless that owner has
-- BYPASSRLS - and OpenGeni's documented non-superuser migration-owner posture
-- (docs/deployment.md) means it usually does not. Most of these tables'
-- ordinary policies gate on an EXACT single workspace_id match
-- (workspace_rls_visible), which an org-wide, workspace-less read can never
-- satisfy, and connections/documents additionally gate personal rows on the
-- current subject GUC. Rather than widen those policies (which would grant
-- ordinary application queries org-wide visibility), this migration follows
-- the established capability-row pattern (0254's
-- variable_set_authority_capabilities): a transaction-scoped, migration-
-- owner-only capability that the inventory function claims immediately
-- before reading and releases immediately after, so the widened visibility
-- exists only inside this one definer call and only for the migration
-- owner. Account scoping is still enforced entirely by this function's own
-- `account_id = p_organization_id` predicates, not by the capability.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.organization_tenancy_inventory_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  CONSTRAINT "organization_tenancy_inventory_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id"
  )
);
REVOKE ALL ON TABLE opengeni_private.organization_tenancy_inventory_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.organization_tenancy_inventory_capability_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.organization_tenancy_inventory_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.organization_tenancy_inventory_capability_active() FROM PUBLIC;

DO $organization_tenancy_inventory_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sessions',
    'workspace_variable_sets',
    'rigs',
    'enrollments',
    'connections',
    'documents',
    'codex_subscription_credentials',
    'sandbox_workspace_mutation_admissions',
    'sandbox_retained_processes',
    'organization_memberships'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY organization_tenancy_inventory_capability_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.organization_tenancy_inventory_capability_active())',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;
END
$organization_tenancy_inventory_capability_policies$;

CREATE OR REPLACE FUNCTION inventory_organization_tenancy(
  p_organization_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '30s'
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy inventory requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy inventory scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'workspaces', (
      SELECT count(*)::int FROM workspaces w WHERE w.account_id = p_organization_id
    ),
    'organizationMemberships', (
      SELECT pg_catalog.jsonb_build_object(
        'byStatus', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(m.status, m.n)
           FROM (
             SELECT om.status, count(*)::int AS n
             FROM organization_memberships om
             WHERE om.account_id = p_organization_id
             GROUP BY om.status
           ) m),
          '{}'::jsonb
        ),
        'activeWithoutPersonalWorkspace', (
          SELECT count(*)::int FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.status = 'active'
            AND om.personal_workspace_id IS NULL
        )
      )
    ),
    -- Humans with persisted workspace access in this organization but no
    -- organization-membership anchor: nothing exists yet for a backfill to
    -- attach canonical ownership to (they never re-authenticated post-0219).
    'workspaceMemberSubjectsWithoutMembershipAnchor', (
      SELECT count(DISTINCT wm.subject_id)::int
      FROM workspace_memberships wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.account_id = p_organization_id
        AND wm.subject_id LIKE 'user:%'
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.subject_id = wm.subject_id
        )
    ),
    'sessions', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'ownerless', count(*) FILTER (
          WHERE s.owner_organization_membership_id IS NULL
        )::int,
        'userPrivate', count(*) FILTER (
          WHERE s.visibility = 'user_private'
        )::int,
        'advancedAuthorityEpoch', count(*) FILTER (
          WHERE s.authority_epoch > 1
        )::int
      )
      FROM sessions s WHERE s.account_id = p_organization_id
    ),
    'variableSets', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(v.authority_scope, v.n)
           FROM (
             SELECT vs.authority_scope, count(*)::int AS n
             FROM workspace_variable_sets vs
             WHERE vs.account_id = p_organization_id
             GROUP BY vs.authority_scope
           ) v),
          '{}'::jsonb
        ),
        'unclassified', (
          SELECT count(*)::int FROM workspace_variable_sets vs
          WHERE vs.account_id = p_organization_id AND vs.authority_id IS NULL
        )
      )
    ),
    'rigs', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(r.authority_scope, r.n)
           FROM (
             SELECT rr.authority_scope, count(*)::int AS n
             FROM rigs rr WHERE rr.account_id = p_organization_id
             GROUP BY rr.authority_scope
           ) r),
          '{}'::jsonb
        ),
        'unclassified', (
          SELECT count(*)::int FROM rigs rr
          WHERE rr.account_id = p_organization_id AND rr.authority_id IS NULL
        )
      )
    ),
    'machines', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(e.authority_scope, e.n)
           FROM (
             SELECT en.authority_scope, count(*)::int AS n
             FROM enrollments en WHERE en.account_id = p_organization_id
             GROUP BY en.authority_scope
           ) e),
          '{}'::jsonb
        ),
        'unclassified', (
          SELECT count(*)::int FROM enrollments en
          WHERE en.account_id = p_organization_id AND en.authority_id IS NULL
        )
      )
    ),
    'connections', (
      SELECT coalesce(
        (SELECT pg_catalog.jsonb_object_agg(c.authority_scope, c.n)
         FROM (
           SELECT cn.authority_scope, count(*)::int AS n
           FROM connections cn WHERE cn.account_id = p_organization_id
           GROUP BY cn.authority_scope
         ) c),
        '{}'::jsonb
      )
    ),
    -- Linked-input gate (documents-internal migration is owned elsewhere and
    -- never written by this program; the count is the cutover gate input).
    'documents', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        -- The gate population is a LEGACY personal Document with no common
        -- authority - organization/workspace documents are REQUIRED to have
        -- a NULL authority_id forever (documents_authority_chk, 0258) and
        -- must never be counted as unmigrated.
        'legacyPersonalNullAuthority', count(*) FILTER (
          WHERE d.authority_kind = 'personal' AND d.authority_id IS NULL
        )::int
      )
      FROM documents d WHERE d.account_id = p_organization_id
    ),
    -- Linked-input gate (ownership repair is owned elsewhere; never backfilled
    -- heuristically; the count is the cutover gate input).
    'codexCredentials', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'unattributedConnector', count(*) FILTER (
          WHERE cc.connected_by_subject_id IS NULL
        )::int
      )
      FROM codex_subscription_credentials cc
      WHERE cc.account_id = p_organization_id
    ),
    'workspaceWriters', (
      SELECT pg_catalog.jsonb_build_object(
        'admissions', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE a.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_workspace_mutation_admissions a
          WHERE a.account_id = p_organization_id
        ),
        'retainedProcesses', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE p.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_retained_processes p
          WHERE p.account_id = p_organization_id
        )
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION inventory_organization_tenancy(uuid) FROM PUBLIC;
DO $tenancy_inventory_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION inventory_organization_tenancy(uuid) TO opengeni_app;
    -- The predicate is harmless to expose (a read-only boolean over a
    -- transaction-local bookkeeping row, never data) and MUST be independently
    -- grantable here: an ordinary opengeni_app-effective role touching ANY
    -- table this capability protects (e.g. sessions, via session_reference_
    -- visible's inlined SQL body evaluating every PERMISSIVE policy) needs
    -- EXECUTE on every predicate function those policies reference, or the
    -- unrelated read fails closed with a permission error instead of the
    -- policy simply evaluating false. Matches 0254's identical explicit grant
    -- for variable_set_authority_capability_active - relying solely on
    -- provisionRoles' blanket schema-wide sweep is not sufficient for a
    -- database whose test/deploy path never runs that step.
    GRANT EXECUTE ON FUNCTION
      opengeni_private.organization_tenancy_inventory_capability_active()
      TO opengeni_app;
  END IF;
END
$tenancy_inventory_grant$;
