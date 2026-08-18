-- deployment-mode: rolling
-- Migration 0293: read-only organization tenancy PARITY seam (phase E).
--
-- Phase D shipped `inventory_organization_tenancy` (migration 0285): content-
-- free counts of every legacy-attribution population. Phase E needs the next
-- thing an operator can gate a cutover on - a shadow parity CHECK that proves
-- the structural tenancy invariants actually hold before any authority is
-- activated:
--
--   * organization / membership / workspace consistency;
--   * one personal workspace per active membership, and that workspace must
--     stay membership-row-free (a persisted `workspace_memberships` row there
--     is exactly how the owner-only projection would widen into delegable
--     access);
--   * stable authority uniqueness (one owning membership per user resource);
--   * provider-account collision rules (a disputed login binding must have
--     disputed its identity; an identity's active binding must be its own);
--   * session ownership provenance; and
--   * zero partial delegations (mode/session/epoch fences, live authority,
--     live owning membership, and a session fence that is never ahead of the
--     session it fences).
--
-- Plus the read-only shadow comparison between the legacy effective scope
-- (everything workspace-owned) and the proposed effective scope (the row's
-- declared authority): `user_scoped_resource_live_anchor` reports every row
-- that CLAIMS user authority without a live anchor. Such a row must resolve to
-- workspace authority or deny - never to user authority. The seam reports; it
-- never repairs, never widens, and never resolves an ambiguity.
--
-- STRICTLY READ-ONLY. The function's only writes are the claim/release of its
-- own transaction-local private capability row - never any inspected table.
-- Output is content-free: bounded row UUIDs as failure evidence, integers
-- everywhere else. No subjects, names, keys, credentials, or values.
--
-- FORCE RLS + SECURITY DEFINER note: identical posture to 0285. Every
-- inspected table is FORCE ROW LEVEL SECURITY and most of their ordinary
-- policies gate on an EXACT single workspace_id (or, for the four
-- organization-tenancy authority tables and the canonical identity tables, on
-- `USING (false)` / a lifecycle marker), which an organization-wide read can
-- never satisfy. Rather than widen any of those policies, this migration takes
-- 0254/0285's established capability-row pattern and gives the parity seam its
-- OWN transaction-scoped, migration-owner-only capability. It is deliberately
-- separate from 0285's capability so that `inventory_organization_tenancy`
-- gains no visibility it was not reviewed for. Account scoping is enforced by
-- this function's own `account_id = p_organization_id` predicates.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.organization_tenancy_parity_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  CONSTRAINT "organization_tenancy_parity_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id"
  )
);
REVOKE ALL ON TABLE opengeni_private.organization_tenancy_parity_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.organization_tenancy_parity_capability_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.organization_tenancy_parity_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.organization_tenancy_parity_capability_active() FROM PUBLIC;

DO $organization_tenancy_parity_capability_policies$
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
    'organization_memberships',
    'organization_user_resource_authorities',
    'organization_user_resource_grants',
    'connection_use_audit_facts',
    'canonical_human_identities',
    'canonical_human_identity_subjects',
    'canonical_human_login_bindings'
  ] LOOP
    -- Existence-guarded on purpose. A maintenance migration earlier in the
    -- chain (0264, which introduces connection_use_audit_facts) can legitimately
    -- be skipped or aborted, and the chain still runs forward over that partial
    -- history. Creating a policy on an absent relation would break the whole
    -- chain there; the parity seam simply cannot be executed against such a
    -- database, which is already true of every other reader of that table.
    IF to_regclass(format('%I.%I', data_schema, table_name)) IS NOT NULL THEN
      EXECUTE format(
        'CREATE POLICY organization_tenancy_parity_capability_read ON %I.%I '
          || 'FOR SELECT USING (current_user = %L AND '
          || 'opengeni_private.organization_tenancy_parity_capability_active())',
        data_schema,
        table_name,
        migration_owner
      );
    END IF;
  END LOOP;
END
$organization_tenancy_parity_capability_policies$;

CREATE OR REPLACE FUNCTION check_organization_tenancy_parity(
  p_organization_id uuid,
  p_evidence_limit integer DEFAULT 10,
  p_observation_window_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '60s'
AS $$
DECLARE
  result jsonb;
  evidence_limit integer := least(greatest(coalesce(p_evidence_limit, 10), 0), 50);
  window_days integer := least(greatest(coalesce(p_observation_window_days, 30), 1), 365);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy parity check requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy parity scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_parity_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  WITH gate_catalog(gate_id) AS (
    VALUES
      ('membership_personal_workspace_pointer'::text),
      ('membership_personal_workspace_exclusive'),
      ('membership_personal_workspace_same_organization'),
      ('personal_workspace_has_no_membership_row'),
      ('authority_resource_single_owner'),
      ('grant_delegation_fence_complete'),
      ('grant_owner_membership_active'),
      ('grant_authority_live'),
      ('grant_session_fence_not_ahead'),
      ('session_owner_provenance_paired'),
      ('session_owner_subject_matches_membership'),
      ('session_owner_membership_same_organization'),
      ('login_binding_dispute_propagated'),
      ('identity_active_binding_owned'),
      ('user_scoped_resource_live_anchor')
  ),
  -- Canonical human identities are organization-INDEPENDENT by design, so an
  -- organization-scoped parity report may only inspect the identities that
  -- actually anchor a subject of THIS organization. `user:<auth_user_id>` is
  -- the canonical subject encoding used by organization_memberships.
  scoped_identities AS (
    SELECT DISTINCT identity_subject.identity_id
    FROM canonical_human_identity_subjects identity_subject
    JOIN organization_memberships membership
      ON membership.account_id = p_organization_id
     AND membership.subject_id = 'user:' || identity_subject.auth_user_id
  ),
  violations(gate_id, evidence_id) AS (
    -- An active membership must identify a personal workspace.
    SELECT 'membership_personal_workspace_pointer'::text, membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.status = 'active'
      AND membership.personal_workspace_id IS NULL

    UNION ALL
    -- A personal workspace may identify at most one organization membership.
    SELECT 'membership_personal_workspace_exclusive', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = p_organization_id
          AND other.id <> membership.id
          AND other.personal_workspace_id = membership.personal_workspace_id
      )

    UNION ALL
    -- The personal workspace must belong to the same organization.
    SELECT 'membership_personal_workspace_same_organization', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces workspace
        WHERE workspace.id = membership.personal_workspace_id
          AND workspace.account_id = p_organization_id
      )

    UNION ALL
    -- A managed personal workspace deliberately has NO workspace_memberships
    -- row: the owner-only access projection is derived, not delegable. A
    -- persisted row there is precisely how membership CRUD and the subject-
    -- membership fallback would widen it. Evidence is the workspace id.
    SELECT DISTINCT 'personal_workspace_has_no_membership_row',
      membership.personal_workspace_id
    FROM organization_memberships membership
    JOIN workspace_memberships workspace_membership
      ON workspace_membership.account_id = p_organization_id
     AND workspace_membership.workspace_id = membership.personal_workspace_id
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL

    UNION ALL
    -- Stable authority uniqueness. The physical unique index is per
    -- (account, membership, kind, resource), so two DIFFERENT memberships can
    -- still claim the same resource - the ambiguity that must never be
    -- resolved toward either user.
    SELECT 'authority_resource_single_owner', authority.id
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_organization_id
      AND authority.status <> 'revoked'
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities rival
        WHERE rival.account_id = p_organization_id
          AND rival.status <> 'revoked'
          AND rival.resource_kind = authority.resource_kind
          AND rival.resource_id = authority.resource_id
          AND rival.organization_membership_id
            <> authority.organization_membership_id
      )

    UNION ALL
    -- Zero partial delegations: `always` carries neither fence, once/session
    -- carry both.
    SELECT 'grant_delegation_fence_complete', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    WHERE resource_grant.account_id = p_organization_id
      AND NOT (
        (resource_grant.mode = 'always'
          AND resource_grant.session_id IS NULL
          AND resource_grant.authority_epoch IS NULL)
        OR (resource_grant.mode IN ('once', 'session')
          AND resource_grant.session_id IS NOT NULL
          AND resource_grant.authority_epoch IS NOT NULL
          AND resource_grant.authority_epoch > 0)
      )

    UNION ALL
    -- A live personal delegation owned by a human whose organization
    -- membership is suspended or revoked is a fallback to user authority.
    -- Suspension revokes personal-resource grants and offboarding runs the
    -- same teardown, so the drained state is the normal one.
    SELECT 'grant_owner_membership_active', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_memberships membership
      ON membership.id = resource_grant.owner_organization_membership_id
     AND membership.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND membership.status <> 'active'

    UNION ALL
    -- An active grant over a revoked authority.
    SELECT 'grant_authority_live', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_user_resource_authorities authority
      ON authority.id = resource_grant.authority_id
     AND authority.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND authority.status = 'revoked'

    UNION ALL
    -- A session-fenced grant whose epoch is AHEAD of the session it fences
    -- would survive the epoch advance that is supposed to revoke it. Epochs
    -- are monotonic and the fence is copied from the session at issuance, so
    -- `grant.authority_epoch <= session.authority_epoch` always holds.
    SELECT 'grant_session_fence_not_ahead', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN sessions session_row
      ON session_row.id = resource_grant.session_id
     AND session_row.workspace_id = resource_grant.workspace_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.session_id IS NOT NULL
      AND resource_grant.authority_epoch > session_row.authority_epoch

    UNION ALL
    -- Session owner provenance is paired, and a user_private session always
    -- has an owner.
    SELECT 'session_owner_provenance_paired', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND (
        (session_row.owner_organization_membership_id IS NULL)
          <> (session_row.owner_subject_id IS NULL)
        OR (session_row.visibility = 'user_private'
          AND session_row.owner_organization_membership_id IS NULL)
      )

    UNION ALL
    -- The denormalized owner subject must still name the owning membership.
    SELECT 'session_owner_subject_matches_membership', session_row.id
    FROM sessions session_row
    JOIN organization_memberships membership
      ON membership.id = session_row.owner_organization_membership_id
     AND membership.account_id = session_row.account_id
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_subject_id IS DISTINCT FROM membership.subject_id

    UNION ALL
    -- The owning membership must exist in this organization.
    SELECT 'session_owner_membership_same_organization', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = session_row.owner_organization_membership_id
          AND membership.account_id = p_organization_id
      )

    UNION ALL
    -- Provider-account collision rule: the physical unique index makes a
    -- second binding for one (provider, provider_account) impossible, so the
    -- collision is recorded by DISPUTING the existing binding and BOTH
    -- identities. A disputed binding whose identity is still usable is a
    -- collision that never fenced its identity.
    SELECT 'login_binding_dispute_propagated', binding.id
    FROM canonical_human_login_bindings binding
    JOIN scoped_identities scoped ON scoped.identity_id = binding.identity_id
    JOIN canonical_human_identities identity ON identity.id = binding.identity_id
    WHERE binding.status = 'disputed'
      AND identity.status <> 'disputed'

    UNION ALL
    -- The FK on active_login_binding_id proves existence, never ownership.
    SELECT 'identity_active_binding_owned', identity.id
    FROM canonical_human_identities identity
    JOIN scoped_identities scoped ON scoped.identity_id = identity.id
    WHERE identity.active_login_binding_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM canonical_human_login_bindings binding
        WHERE binding.id = identity.active_login_binding_id
          AND binding.identity_id = identity.id
      )

    UNION ALL
    -- Shadow comparison, connections lane: legacy effective scope is
    -- workspace; the proposed effective scope is `user`. A row claiming user
    -- authority without a live authority AND a live owning membership has no
    -- reachable user resolution - it must fall back to workspace or deny.
    SELECT 'user_scoped_resource_live_anchor', connection_row.id
    FROM connections connection_row
    WHERE connection_row.account_id = p_organization_id
      AND connection_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = connection_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.account_id = p_organization_id
      AND variable_set.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = variable_set.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', rig_row.id
    FROM rigs rig_row
    WHERE rig_row.account_id = p_organization_id
      AND rig_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = rig_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', enrollment.id
    FROM enrollments enrollment
    WHERE enrollment.account_id = p_organization_id
      AND enrollment.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = enrollment.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    -- Documents carry the same claim as authority_kind='personal' WITH a
    -- non-null authority_id (a null authority_id there is the separate,
    -- deliberately bounded legacy lane reported under `lanes`).
    SELECT 'user_scoped_resource_live_anchor', document.id
    FROM documents document
    WHERE document.account_id = p_organization_id
      AND document.authority_kind = 'personal'
      AND document.authority_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = document.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )
  ),
  aggregated AS (
    SELECT
      violation.gate_id,
      count(*)::int AS violation_count,
      (pg_catalog.array_agg(
        violation.evidence_id ORDER BY violation.evidence_id
      ))[1:evidence_limit] AS evidence
    FROM violations violation
    GROUP BY violation.gate_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'evidenceLimit', evidence_limit,
    'observationWindowDays', window_days,
    'gates', (
      SELECT pg_catalog.jsonb_object_agg(
        catalog.gate_id,
        pg_catalog.jsonb_build_object(
          'violations', coalesce(aggregated.violation_count, 0),
          'evidence', pg_catalog.to_jsonb(
            coalesce(aggregated.evidence, ARRAY[]::uuid[])
          ),
          'truncated', coalesce(aggregated.violation_count, 0)
            > coalesce(pg_catalog.array_length(aggregated.evidence, 1), 0)
        )
      )
      FROM gate_catalog catalog
      LEFT JOIN aggregated ON aggregated.gate_id = catalog.gate_id
    ),
    -- Compatibility lanes. These are populations the phase-D backfill drains;
    -- they are NOT invariant violations and must never be read as such.
    'lanes', pg_catalog.jsonb_build_object(
      'connectionsLegacyUser', (
        SELECT count(*)::int FROM connections connection_row
        WHERE connection_row.account_id = p_organization_id
          AND connection_row.authority_scope = 'legacy_user'
      ),
      'workspaceWriterAdmissionsLegacyUnattributed', (
        SELECT count(*)::int FROM sandbox_workspace_mutation_admissions admission
        WHERE admission.account_id = p_organization_id
          AND admission.initiator_kind = 'legacy_unattributed'
      ),
      'workspaceWriterProcessesLegacyUnattributed', (
        SELECT count(*)::int FROM sandbox_retained_processes retained_process
        WHERE retained_process.account_id = p_organization_id
          AND retained_process.initiator_kind = 'legacy_unattributed'
      ),
      'documentsLegacyPersonalNullAuthority', (
        SELECT count(*)::int FROM documents document
        WHERE document.account_id = p_organization_id
          AND document.authority_kind = 'personal'
          AND document.authority_id IS NULL
      ),
      'codexCredentialsUnattributedConnector', (
        SELECT count(*)::int FROM codex_subscription_credentials credential
        WHERE credential.account_id = p_organization_id
          AND credential.connected_by_subject_id IS NULL
      ),
      'workspaceMemberSubjectsWithoutMembershipAnchor', (
        SELECT count(DISTINCT workspace_membership.subject_id)::int
        FROM workspace_memberships workspace_membership
        JOIN workspaces workspace ON workspace.id = workspace_membership.workspace_id
        WHERE workspace.account_id = p_organization_id
          AND workspace_membership.subject_id LIKE 'user:%'
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = workspace_membership.subject_id
          )
      ),
      -- The DRAINABLE refinement of "ownerless sessions": a session whose
      -- creating subject would be attributed by today's write fence but whose
      -- owner is still null. Total ownerlessness is deliberately NOT reported
      -- as drainable - a service/API-key session is permanently ownerless.
      'sessionsAttributableButUnattributed', (
        SELECT count(*)::int FROM sessions session_row
        WHERE session_row.account_id = p_organization_id
          AND session_row.owner_organization_membership_id IS NULL
          AND session_row.created_by_kind = 'subject'
          AND session_row.created_by_subject_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = session_row.created_by_subject_id
              AND membership.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_organization_id
              AND workspace_membership.workspace_id = session_row.workspace_id
              AND workspace_membership.subject_id = session_row.created_by_subject_id
          )
      ),
      -- Connection-use audit facts are immutable history, so the all-time
      -- count can never drain. The reachable-zero signal is "was the bounded
      -- pre-snapshot/legacy resolution lane exercised inside the observation
      -- window".
      'connectionUseLegacyResolutionsInWindow', (
        SELECT count(*)::int FROM connection_use_audit_facts audit_fact
        WHERE audit_fact.account_id = p_organization_id
          AND audit_fact.authority_scope = 'legacy_user'
          AND audit_fact.occurred_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION
  check_organization_tenancy_parity(uuid, integer, integer) FROM PUBLIC;
DO $tenancy_parity_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      check_organization_tenancy_parity(uuid, integer, integer) TO opengeni_app;
    -- The predicate is a read-only boolean over a transaction-local
    -- bookkeeping row and MUST be independently grantable: an ordinary
    -- opengeni_app-effective role touching ANY table this capability protects
    -- needs EXECUTE on every predicate function those tables' policies
    -- reference, or the unrelated read fails closed with a permission error
    -- instead of the policy simply evaluating false. Same explicit grant as
    -- 0254 and 0285 - provisionRoles' blanket schema-wide sweep is not
    -- sufficient for a database whose test/deploy path never runs that step.
    GRANT EXECUTE ON FUNCTION
      opengeni_private.organization_tenancy_parity_capability_active()
      TO opengeni_app;
  END IF;
END
$tenancy_parity_grant$;
