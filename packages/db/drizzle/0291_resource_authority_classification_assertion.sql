-- deployment-mode: rolling
-- Migration 0291: explicit resource-classification assertion and receipt seam
-- for Variable Sets, Rigs, and Connected Machines (organization-tenancy phase D, slices 4-5).
--
-- WHAT PHASE D ASKS FOR, AND WHAT THE SCHEMA ALREADY GUARANTEES
-- ------------------------------------------------------------
-- `docs/organization-tenancy.md` phase D requires that every existing resource
-- be classified explicitly as workspace-owned unless there is reviewed,
-- deterministic evidence for user ownership, and that the run "record backfill
-- receipts and unresolved rows without widening access".
--
-- For these three families the classification is ALREADY terminal for every
-- row, and no data rewrite is possible without inventing a signal phase D
-- forbids:
--
--   * `authority_scope` is `text NOT NULL DEFAULT 'workspace'` on all three
--     tables (0230 for variable sets and rigs, 0262 for enrollments), so every
--     pre-existing row carries an explicit workspace classification already.
--   * Each `*_authority_shape_check` REQUIRES `authority_id IS NULL` and
--     `owner_organization_membership_id IS NULL` for organization/workspace
--     scope, and all three were `VALIDATE`d at creation. PostgreSQL has
--     therefore already proven the shape of every row.
--   * A legacy unmigrated row and a deliberately workspace-scoped row are
--     consequently BYTE-IDENTICAL. There is no discriminator, and 0262's own
--     header records the reviewed decision: "Existing rows remain
--     workspace-owned."
--   * `origin_workspace_id` does not rescue that: it is provenance, not
--     classification. No shape check constrains it for these three families
--     (unlike `connections`, whose 0256 workspace branch requires
--     `origin_workspace_id = workspace_id`), every read of it is gated behind
--     `authority_scope = 'user'` (0241/0252/0253), and the user lane is always
--     populated by the lifecycle functions. Its polarity is also inconsistent
--     across the three families, so it carries no usable signal either way.
--
-- Migration 0256 is the one sibling family with a genuine discriminator -
-- `connections.subject_id` plus an active `organization_memberships` row - so
-- it could deterministically mint user authority. None of these three tables
-- has a `subject_id`, and phase D explicitly forbids substituting `created_by`,
-- connection attribution, a default workspace, a resource name, or current
-- access. This migration therefore rewrites NOTHING and asserts instead.
--
-- WHY THIS IS A SECURITY DEFINER SEAM AND NOT A MIGRATION-TIME `UPDATE`
-- --------------------------------------------------------------------
-- All three tables are FORCE ROW LEVEL SECURITY and their ordinary policy is
-- `workspace_rls_visible(account_id, workspace_id)`, which is false whenever
-- the `opengeni.workspace_id` GUC is unset - as it is during migration. FORCE
-- RLS applies to the table owner, and OpenGeni's documented deployment posture
-- (docs/deployment.md) is a NON-superuser migration principal without
-- BYPASSRLS. A bare `UPDATE ... WHERE ...` in a migration body therefore
-- matches zero rows and reports success on such a deployment; it only appears
-- to work in the test harness, which migrates as a superuser for whom FORCE
-- RLS never engages. Any classification work for these families has to run
-- behind a capability-claiming definer seam, which is exactly why 0254, 0262,
-- and 0285 are all shaped this way.
--
-- WHAT THIS SEAM ADDS OVER 0285's INVENTORY
-- -----------------------------------------
-- 0285 counts rows by `authority_scope`. It cannot say whether a row that
-- CLAIMS user ownership actually holds it, because no constraint ties a
-- resource's `authority_id` to an authority row of the matching
-- `resource_kind`/`resource_id`, nor to a live authority or a live
-- organization membership. Those are the only genuinely unenforced parts of
-- the classification, and they are what this seam proves per row. Anything it
-- cannot prove is recorded as an unresolved obligation through migration
-- 0286's ledger - never guessed, never rewritten.
--
-- The seam is read-only over every resource table: its sole writes are its own
-- transaction-scoped capability row and, when a run key is supplied, the 0286
-- ledger. Receipt recording is guarded by `to_regprocedure` so this migration
-- is order-independent with respect to the ledger migration and reports
-- `ledgerAvailable` honestly rather than failing or silently skipping.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Freeze the active data schema into the SECURITY DEFINER routines below.
-- Standalone installs resolve to public; embedded installs resolve to their
-- dedicated schema. pg_temp remains explicitly last.
SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.format('%I, pg_catalog, pg_temp', pg_catalog.current_schema()),
  true
);

-- A transaction-scoped, migration-owner-only capability. Deliberately NOT a
-- reuse of 0285's inventory capability: that policy pins the literal
-- `current_user` observed while 0285 ran, so reusing it would silently fail on
-- any deployment whose migration principal changed between the two migrations,
-- and it carries no policy for `organization_user_resource_authorities`, which
-- this seam must join.
CREATE TABLE opengeni_private.resource_classification_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  CONSTRAINT "resource_classification_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id"
  )
);
REVOKE ALL ON TABLE opengeni_private.resource_classification_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.resource_classification_capability_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.resource_classification_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.resource_classification_capability_active() FROM PUBLIC;

DO $resource_classification_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_variable_sets',
    'rigs',
    'enrollments',
    'organization_user_resource_authorities',
    'organization_memberships'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY resource_classification_capability_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.resource_classification_capability_active())',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;
END
$resource_classification_capability_policies$;

-- Asserts the explicit authority classification of every Variable Set, Rig,
-- and Connected Machine in one organization.
--
-- `p_run_key` is the durability switch. Omitted (NULL) the call is a pure
-- read. Supplied, the same verdicts are additionally recorded through the 0286
-- ledger as one receipt per family plus one append-only unresolved row per
-- resource that could not be proven - which is also why the run key must be
-- fresh per run: the ledger refuses to re-open a settled receipt.
CREATE OR REPLACE FUNCTION verify_organization_resource_classification(
  p_organization_id uuid,
  p_run_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $$
DECLARE
  -- family label (0286 vocabulary), resource table, authority resource_kind
  families constant text[][] := ARRAY[
    ARRAY['variable_sets', 'workspace_variable_sets', 'variable_set'],
    ARRAY['rigs', 'rigs', 'rig'],
    ARRAY['machines', 'enrollments', 'connected_machine']
  ];
  family text[];
  claimed_rows integer := 0;
  claimed boolean := false;
  ledger_available boolean;
  classification_sql text;
  family_result jsonb;
  families_result jsonb := '{}'::jsonb;
  receipt_id uuid;
  unresolved_row record;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'resource classification requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'resource classification scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_key IS NOT NULL AND length(btrim(p_run_key)) = 0 THEN
    RAISE EXCEPTION 'resource classification run key must not be blank'
      USING ERRCODE = '22023';
  END IF;

  -- The ledger lives in its own migration. Probe rather than assume, so this
  -- seam neither hard-fails nor silently drops the obligation when the two
  -- land in either order.
  ledger_available := p_run_key IS NOT NULL
    AND to_regprocedure('open_tenancy_backfill_receipt(uuid, text, text)') IS NOT NULL
    AND to_regprocedure('record_tenancy_backfill_unresolved(uuid, uuid, text)') IS NOT NULL
    AND to_regprocedure(
      'complete_tenancy_backfill_receipt(uuid, bigint, bigint, text)'
    ) IS NOT NULL;

  INSERT INTO opengeni_private.resource_classification_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;
  -- Only release what this call claimed, so a nested or enclosing holder of
  -- the same transaction-scoped capability is never revoked underneath.
  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  claimed := claimed_rows > 0;

  FOREACH family SLICE 1 IN ARRAY families LOOP
    -- One verdict per row. The first two branches are the phase D terminal
    -- states; every other branch is an explicit refusal to classify, carrying
    -- a fixed 0286 reason code and never a proposed owner.
    classification_sql := format($classification$
      SELECT resource.id AS resource_id,
        CASE
          WHEN resource.authority_scope = 'workspace'
            AND resource.authority_id IS NULL
            AND resource.owner_organization_membership_id IS NULL
            THEN 'workspace_owned'
          -- Organization scope is a deliberate lifecycle choice (0254/0262),
          -- never a legacy default, so it is reported separately rather than
          -- folded into the workspace population it is not part of.
          WHEN resource.authority_scope = 'organization'
            AND resource.authority_id IS NULL
            AND resource.owner_organization_membership_id IS NULL
            THEN 'organization_owned'
          WHEN resource.authority_scope <> 'user'
            OR resource.authority_id IS NULL
            OR resource.owner_organization_membership_id IS NULL
            THEN 'legacy_shape_unrecognized'
          WHEN authority.id IS NULL
            OR authority.resource_kind <> %2$L
            OR authority.resource_id <> resource.id
            OR authority.organization_membership_id
               <> resource.owner_organization_membership_id
            THEN 'conflicting_authority_rows'
          WHEN membership.id IS NULL
            OR membership.status <> 'active'
            OR membership.revoked_at IS NOT NULL
            THEN 'missing_organization_membership'
          WHEN authority.status <> 'active' OR authority.revoked_at IS NOT NULL
            THEN 'ambiguous_candidate_authority'
          WHEN resource.origin_workspace_id IS NULL
            THEN 'no_deterministic_evidence'
          ELSE 'user_owned'
        END AS verdict
      FROM %1$I resource
      LEFT JOIN organization_user_resource_authorities authority
        ON authority.id = resource.authority_id
       AND authority.account_id = resource.account_id
      LEFT JOIN organization_memberships membership
        ON membership.id = resource.owner_organization_membership_id
       AND membership.account_id = resource.account_id
      WHERE resource.account_id = $1
    $classification$, family[2], family[3]);

    EXECUTE format($summary$
      WITH classified AS (%1$s)
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'workspaceOwned', count(*) FILTER (WHERE verdict = 'workspace_owned')::int,
        'organizationOwned', count(*) FILTER (
          WHERE verdict = 'organization_owned'
        )::int,
        'userOwned', count(*) FILTER (WHERE verdict = 'user_owned')::int,
        'unresolved', count(*) FILTER (
          WHERE verdict NOT IN ('workspace_owned', 'organization_owned', 'user_owned')
        )::int,
        'unresolvedRows', coalesce((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'resourceId', bounded.resource_id, 'reasonCode', bounded.verdict
            ) ORDER BY bounded.resource_id
          )
          FROM (
            SELECT resource_id, verdict FROM classified
            WHERE verdict NOT IN (
              'workspace_owned', 'organization_owned', 'user_owned'
            )
            ORDER BY resource_id LIMIT 1000
          ) bounded
        ), '[]'::jsonb),
        'unresolvedTruncated', count(*) FILTER (
          WHERE verdict NOT IN ('workspace_owned', 'organization_owned', 'user_owned')
        ) > 1000
      )
      FROM classified
    $summary$, classification_sql)
    USING p_organization_id
    INTO family_result;

    IF ledger_available THEN
      EXECUTE 'SELECT open_tenancy_backfill_receipt($1, $2, $3)'
        USING p_organization_id, family[1], p_run_key
        INTO receipt_id;
      FOR unresolved_row IN EXECUTE format(
        'SELECT resource_id, verdict FROM (%1$s) classified '
          || 'WHERE verdict NOT IN '
          || '(''workspace_owned'', ''organization_owned'', ''user_owned'') '
          || 'ORDER BY resource_id',
        classification_sql
      ) USING p_organization_id LOOP
        EXECUTE 'SELECT record_tenancy_backfill_unresolved($1, $2, $3)'
          USING receipt_id, unresolved_row.resource_id, unresolved_row.verdict;
      END LOOP;
      -- `classified_count` is the population this run PROVED already carries a
      -- terminal non-user classification; `skipped_count` is the reviewed
      -- user-owned population the backfill must not touch. Neither reflects a
      -- rewrite: this run changes no resource row.
      EXECUTE 'SELECT complete_tenancy_backfill_receipt($1, $2, $3, $4)'
        USING receipt_id,
          (family_result ->> 'workspaceOwned')::bigint
            + (family_result ->> 'organizationOwned')::bigint,
          (family_result ->> 'userOwned')::bigint,
          'completed';
      family_result := family_result
        || pg_catalog.jsonb_build_object('receiptId', receipt_id);
    END IF;

    families_result := families_result
      || pg_catalog.jsonb_build_object(family[1], family_result);
  END LOOP;

  IF claimed THEN
    DELETE FROM opengeni_private.resource_classification_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'runKey', p_run_key,
    'ledgerAvailable', ledger_available,
    'rewroteResourceRows', false,
    'families', families_result
  );
EXCEPTION WHEN OTHERS THEN
  IF claimed THEN
    DELETE FROM opengeni_private.resource_classification_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION
  verify_organization_resource_classification(uuid, text) FROM PUBLIC;

DO $resource_classification_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      verify_organization_resource_classification(uuid, text) TO opengeni_app;
    -- The predicate must be independently EXECUTE-granted (0254's and 0285's
    -- exact lesson): an ordinary opengeni_app read of ANY table this
    -- capability protects evaluates every PERMISSIVE policy on it, so without
    -- this grant an unrelated read of `rigs`, `enrollments`, or
    -- `workspace_variable_sets` fails closed with a permission error instead
    -- of the policy branch simply evaluating false.
    GRANT EXECUTE ON FUNCTION
      opengeni_private.resource_classification_capability_active() TO opengeni_app;
  END IF;
END
$resource_classification_grants$;

COMMENT ON FUNCTION verify_organization_resource_classification(uuid, text) IS
  'Organization-tenancy phase D assertion seam for Variable Sets, Rigs, and Connected Machines. Read-only over every resource table: it proves each row already carries an explicit terminal authority classification and records what it cannot prove through the 0286 ledger. It never rewrites a resource row and never infers user ownership.';
