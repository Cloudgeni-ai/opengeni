-- deployment-mode: rolling
-- Migration 0283: read-only organization tenancy inventory seam.
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

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION inventory_organization_tenancy(
  p_organization_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  result jsonb;
BEGIN
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy inventory scope mismatch'
      USING ERRCODE = '42501';
  END IF;

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
        'nullAuthority', count(*) FILTER (WHERE d.authority_id IS NULL)::int
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

  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION inventory_organization_tenancy(uuid) FROM PUBLIC;
DO $tenancy_inventory_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION inventory_organization_tenancy(uuid) TO opengeni_app;
  END IF;
END
$tenancy_inventory_grant$;
