-- deployment-mode: rolling
-- Migration 0289: remove the three untruthful `unclassified` counters from the
-- read-only organization tenancy inventory seam (0285).
--
-- WHAT WAS WRONG
--
-- 0285 reported an `unclassified` counter for Variable Sets, Rigs, and
-- Connected Machines defined as `authority_id IS NULL`. That predicate cannot
-- mean what its name claims. The authority SHAPE constraints REQUIRE a NULL
-- `authority_id` for every organization- and workspace-scoped row:
--
--   workspace_variable_sets_authority_shape_check (0230, widened 0254)
--   rigs_authority_shape_check                    (0230, widened 0262)
--   enrollments_authority_shape_check             (0262)
--
--     (authority_scope IN ('organization','workspace')
--        AND authority_id IS NULL AND owner_organization_membership_id IS NULL)
--  OR (authority_scope = 'user'
--        AND authority_id IS NOT NULL
--        AND owner_organization_membership_id IS NOT NULL)
--
-- So `authority_id IS NULL` is structurally identical to `total - userScoped`.
-- Every CORRECTLY classified organization/workspace row was reported as
-- "unclassified". The number could never drain to zero, so it was useless as
-- the backfill gate it was documented to be. This is the same defect class the
-- 0285 review already caught and fixed for `documents`, where the truthful
-- predicate turned out to be `authority_kind = 'personal' AND
-- authority_id IS NULL` - a genuine post-migration INVARIANT VIOLATION, because
-- a correctly classified personal document is REQUIRED to carry an authority.
-- No such violation exists for these three families: their legacy rows satisfy
-- the (VALIDATED) shape check exactly like a new workspace-scoped row does.
--
-- WHY IT IS NOT REPLACED WITH A CORRECTED PREDICATE
--
-- `authority_scope` DEFAULTS to 'workspace' (0230 for variable sets/rigs, 0262
-- for enrollments), so an unmigrated legacy row and a deliberately
-- workspace-scoped row are literally identical in that column. Nothing else
-- distinguishes them either:
--
--   * workspace_variable_sets - `origin_workspace_id` (0230, no backfill) is
--     NULL for every pre-0254 row and non-NULL for every row created by
--     create_scoped_variable_set. That is a real fact, but it means "predates
--     the scoped lifecycle", NOT "lacks an explicit authority classification".
--     Backfill phase D classifies a reviewed legacy row explicitly AS
--     workspace-owned, which writes nothing - so a reviewed row still reads
--     NULL and the counter still never drains. Different fact, wrong name.
--
--   * rigs - `origin_workspace_id` is not even a legacy marker: createRig
--     (packages/db/src/index.ts) retains a live non-scoped branch that inserts
--     through Drizzle without it, so new rows keep arriving with a NULL origin
--     today.
--
--   * enrollments - 0262 added `origin_workspace_id` and backfilled it in the
--     same statement (`UPDATE enrollments SET origin_workspace_id =
--     workspace_id WHERE origin_workspace_id IS NULL`), while the ordinary
--     createEnrollment upsert still leaves it NULL. The polarity is INVERTED:
--     NULL now marks a POST-0262 ordinary row, not a legacy one.
--
-- The population "resources without an explicit authority classification" is
-- therefore UNREPRESENTABLE in the current schema for all three families. A
-- number whose name lies is worse than no number, so the key is removed rather
-- than renamed. Nothing is lost: `byScope` already reports every authority
-- distinction the schema can truthfully make, and any non-user-scoped total is
-- derivable from it. Reintroducing an `unclassified` counter requires FIRST
-- adding a durable classification-decision fact to these tables.
--
-- The seam stays read-only, integers-only, exact-organization scoped, and
-- executable only by the application role. `schemaVersion` moves 1 -> 2
-- because the reported shape changed. CREATE OR REPLACE preserves the
-- function's owner and its existing EXECUTE grant to opengeni_app; the 0285
-- capability table, predicate, and per-table read policies are untouched.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

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
    'schemaVersion', 2,
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
    -- Variable Sets, Rigs, and Connected Machines report ONLY the authority
    -- lane breakdown. An `unclassified` counter is deliberately absent: the
    -- shape checks REQUIRE a NULL authority_id for organization/workspace
    -- rows, `authority_scope` DEFAULTS to 'workspace', and no column records
    -- that a classification decision was ever made - see this migration's
    -- header for the per-family analysis.
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

-- CREATE OR REPLACE preserves the existing ACL, so this re-grant is a no-op on
-- an already-migrated database. It is retained only so a fresh install that
-- creates opengeni_app between 0285 and 0289 still converges.
DO $tenancy_inventory_0287_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION inventory_organization_tenancy(uuid) TO opengeni_app;
  END IF;
END
$tenancy_inventory_0287_grant$;
