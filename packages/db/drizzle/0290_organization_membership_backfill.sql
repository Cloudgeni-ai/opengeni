-- deployment-mode: rolling
-- Migration 0290: read-only organization-membership backfill enumeration seam.
--
-- Phase D of docs/organization-tenancy.md requires provisioning personal
-- workspaces for active memberships "through an idempotent lifecycle
-- operation". That lifecycle operation already exists - 0219's
-- ensure_managed_human_personal_workspace(uuid, text, uuid) - and 0263's
-- membership lifecycle owns invitation-driven provisioning. What is missing is
-- a way for an operator to FIND the humans that need it: the population the
-- 0285 inventory counts as workspaceMemberSubjectsWithoutMembershipAnchor
-- (humans who held workspace access before 0219 and never re-authenticated
-- afterwards, so nothing ever ran the provisioning hook for them) plus any
-- membership that carries no personal workspace.
--
-- This migration therefore adds NO tables, NO write path, and NO new authority.
-- It adds exactly two read-only SECURITY DEFINER enumerations over
-- organization_memberships, which is FORCE ROW LEVEL SECURITY with zero direct
-- application-role privileges. Every other table the backfill driver needs
-- (workspaces, workspace_memberships, managed_accounts, auth_users) is read by
-- the ordinary application role under its normal account RLS, exactly like the
-- existing managed-human provisioning hook - so this seam deliberately does not
-- need 0285's capability-row pattern, and cannot silently mis-read under a
-- non-BYPASSRLS function owner.
--
-- Visibility is granted through the established transaction-local lifecycle
-- marker rather than a widened policy, and the new marker is added to the
-- organization_memberships policy's USING clause ONLY. It is structurally
-- incapable of authorizing a write: WITH CHECK keeps exactly the three
-- pre-existing write markers.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Read-only marker. USING gains 'organization_membership_backfill'; WITH CHECK
-- deliberately does not, so the backfill enumeration can never write here.
DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_memberships";
CREATE POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle',
      'organization_membership_backfill'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle'
    ));

-- Anchor state for an explicit, bounded set of subjects. The driver already
-- knows which subjects hold workspace access (an ordinary application-role
-- read); this answers only "does an organization membership anchor exist, and
-- what does it point at". It never enumerates subjects on its own, so it
-- cannot become a cross-organization membership discovery path.
CREATE OR REPLACE FUNCTION list_organization_membership_backfill_anchors(
  p_organization_id uuid,
  p_subject_ids text[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '30s'
AS $body$
DECLARE
  result jsonb;
  subject_id_value text;
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'membership backfill requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'membership backfill scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_subject_ids IS NULL
    OR pg_catalog.array_length(p_subject_ids, 1) IS NULL
    OR pg_catalog.array_length(p_subject_ids, 1) > 500
  THEN
    RAISE EXCEPTION 'membership backfill requires 1..500 subjects'
      USING ERRCODE = '22023';
  END IF;
  FOREACH subject_id_value IN ARRAY p_subject_ids LOOP
    IF subject_id_value IS NULL
      OR subject_id_value <> pg_catalog.btrim(subject_id_value)
      OR pg_catalog.length(subject_id_value) NOT BETWEEN 1 AND 1024
      OR subject_id_value NOT LIKE 'user:%'
    THEN
      RAISE EXCEPTION 'membership backfill subject is invalid'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_backfill',
    true
  );
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'subjectId', anchor.subject_id,
    'membershipId', anchor.id,
    'status', anchor.status,
    'personalWorkspaceId', anchor.personal_workspace_id
  ) ORDER BY anchor.subject_id), '[]'::jsonb)
  INTO result
  FROM organization_memberships anchor
  WHERE anchor.account_id = p_organization_id
    AND anchor.subject_id = ANY (p_subject_ids);

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    COALESCE(previous_marker, ''),
    true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    COALESCE(previous_marker, ''),
    true
  );
  RAISE;
END
$body$;

-- Memberships that exist but carry no personal workspace. 0285 counts these as
-- organizationMemberships.activeWithoutPersonalWorkspace; this returns the
-- exact bounded, deterministically ordered subjects behind that count so the
-- driver can converge them through the same lifecycle seam.
--
-- p_after_subject_id is the resumable keyset cursor. Without it a bounded pass
-- would return the same first p_limit subjects forever, so an organization
-- whose first p_limit rows cannot be resolved from deterministic evidence
-- (they stay in this population permanently) would starve every subject behind
-- them. The cursor is strictly exclusive and the ordering is the same
-- subject_id ordering the driver merges on, so repeated passes walk the whole
-- population exactly once instead of re-reading one window.
CREATE OR REPLACE FUNCTION list_organization_memberships_without_personal_workspace(
  p_organization_id uuid,
  p_limit integer DEFAULT 25,
  p_after_subject_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '30s'
AS $body$
DECLARE
  result jsonb;
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'membership backfill requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'membership backfill scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'membership backfill limit must be 1..100'
      USING ERRCODE = '22023';
  END IF;
  IF p_after_subject_id IS NOT NULL
    AND (
      p_after_subject_id <> pg_catalog.btrim(p_after_subject_id)
      OR pg_catalog.length(p_after_subject_id) NOT BETWEEN 1 AND 1024
      OR p_after_subject_id NOT LIKE 'user:%'
    )
  THEN
    RAISE EXCEPTION 'membership backfill cursor is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_backfill',
    true
  );
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'subjectId', pending.subject_id,
    'membershipId', pending.id,
    'status', pending.status,
    'personalWorkspaceId', NULL
  ) ORDER BY pending.subject_id), '[]'::jsonb)
  INTO result
  FROM (
    SELECT candidate.id, candidate.subject_id, candidate.status
    FROM organization_memberships candidate
    WHERE candidate.account_id = p_organization_id
      AND candidate.personal_workspace_id IS NULL
      AND candidate.status IN ('active', 'provisioning')
      AND (
        p_after_subject_id IS NULL
        OR candidate.subject_id > p_after_subject_id
      )
    ORDER BY candidate.subject_id
    LIMIT p_limit
  ) pending;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    COALESCE(previous_marker, ''),
    true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    COALESCE(previous_marker, ''),
    true
  );
  RAISE;
END
$body$;

DO $membership_backfill_search_path$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_membership_backfill_anchors(uuid,text[]) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_memberships_without_personal_workspace(uuid,integer,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$membership_backfill_search_path$;

REVOKE ALL ON FUNCTION
  list_organization_membership_backfill_anchors(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  list_organization_memberships_without_personal_workspace(uuid, integer, text) FROM PUBLIC;
DO $membership_backfill_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      list_organization_membership_backfill_anchors(uuid, text[]) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      list_organization_memberships_without_personal_workspace(uuid, integer, text) TO opengeni_app;
  END IF;
END
$membership_backfill_grant$;
