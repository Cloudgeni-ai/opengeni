-- deployment-mode: rolling
-- Repair the migration-time backfills that silently matched zero rows
-- on every deployment whose migration principal is a NON-superuser table owner
-- without BYPASSRLS (OpenGeni's documented posture, docs/deployment.md).
--
-- `FORCE ROW LEVEL SECURITY` binds the TABLE OWNER; only a genuine SUPERUSER or
-- BYPASSRLS role escapes it. During a migration no `opengeni.account_id` /
-- `opengeni.workspace_id` GUC is set, so the GUC-gated `workspace_isolation`
-- policy is false for every row and a bare backfill touches nothing while
-- reporting success. The three statements repaired here are:
--
--   * 0256_connection_authority_delegation.sql
--       UPDATE "connections" SET "origin_workspace_id" = "workspace_id"
--       WHERE "origin_workspace_id" IS NULL;
--   * 0262_scoped_connected_machines_and_rigs.sql
--       UPDATE enrollments SET origin_workspace_id = workspace_id
--       WHERE origin_workspace_id IS NULL;
--   * 0263_organization_membership_lifecycle.sql
--       UPDATE "organization_memberships" membership SET role = 'owner'
--       FROM "managed_accounts" account WHERE ... (self-organization owner)
--
-- They are exactly the statements whose no-op neither aborts its own migration
-- nor is recomputed by any runtime path. The full classification of every
-- migration-time backfill over a FORCE-RLS table, and of the cases deliberately
-- left for their own reviewed repair, is in
-- `docs/force-rls-migration-backfills.md`.
--
-- Their own CHECK constraints do not catch the no-op, because a CHECK
-- expression that evaluates to NULL PASSES: `connections_authority_shape_check`
-- compares `origin_workspace_id = workspace_id`, which is NULL rather than
-- FALSE when the column is NULL; `enrollments_authority_shape_check` never
-- mentions the column at all; and 0263's `organization_memberships_role_check`
-- is satisfied by the `'member'` DDL default. (0256's classification loop
-- is a different case: it leaves `authority_scope = 'workspace'` on a row whose
-- `subject_id IS NOT NULL`, which makes the same CHECK FALSE, and
-- `VALIDATE CONSTRAINT` bypasses RLS - so that half aborts the migration loudly
-- instead of committing wrong data, and nothing here re-derives it. Personal
-- connection authority is never inferred from `created_by_subject_id`, the
-- connection's workspace, or current access.)
--
-- Consequences being repaired:
--   * `resolve_accepted_connection_use` compares
--     `connection_row.origin_workspace_id IS DISTINCT FROM p_workspace_id`, so a
--     NULL denies every workspace-owned connection with
--     `connection_identity_changed`. Every pre-0256 connection is unusable.
--   * `organization_membership_command` denies invite, accept/revoke, role
--     change, suspend/reactivate, offboard, and retention policy for any actor
--     whose `role NOT IN ('owner','admin')`, and "cannot demote the last owner"
--     sees zero owners. Every pre-0263 organization is locked out of its own
--     membership administration.
--   * `enrollments.origin_workspace_id` is durable Connected Machine
--     provenance and the source of `organization_user_resource_authorities`
--     rows when a machine is converted to user scope.
--
-- Scope of the repair. For `connections` and `enrollments` only rows still
-- carrying `authority_scope = 'workspace'` are touched, and only to the value
-- the shipped constraint already requires (`origin_workspace_id = workspace_id`).
-- That is the exact pre-0256 / pre-0262 population: every later scope is
-- written by the lifecycle routines, which set the column explicitly. The
-- `organization_memberships` statement re-executes 0263's own predicate
-- verbatim - an exact identity match between the self-organization's external
-- Better Auth user and the membership subject - which is the same predicate the
-- live `organization_memberships_assign_managed_self_owner` BEFORE INSERT
-- trigger already applies to every new row, so historical rows are only brought
-- into line with current behaviour.
--
-- Nothing is reclassified or widened. Authority is never inferred from
-- `created_by`, connection attribution, a default workspace, a resource name,
-- or current access. On a database whose original migrations DID succeed (a
-- superuser-migrated deployment) all three statements match zero rows and the
-- file is a no-op. Re-running converges to the same state.
--
-- Method. `NO FORCE` relaxes ONLY the owner for the duration of this file -
-- the application role stays policy-bound throughout - and the migration runner
-- executes the file as one implicit transaction, so a failure rolls back both
-- the data repair and the posture change. This is the same owner-only window
-- 0009_goal_sessions_first_party_goals_manage.sql and 0120_durable_goal_wake.sql
-- already use. The verification block below then reads the tables while the
-- window is still open, so a future regression of this class fails loudly here
-- rather than reporting success.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- 0256's BEFORE UPDATE trigger treats `origin_workspace_id` as immutable owner
-- authority and raises 23514 on any change. Disabling it is transactional DDL
-- behind the ACCESS EXCLUSIVE lock this statement takes, so no concurrent
-- writer ever observes the table without its binding trigger.
-- 0256's immutability trigger may not exist yet: several migration tests
-- pre-seed schema_migrations to replay a partial chain (0184/0190/0241/0249/
-- 0264 do this), so migrate() reaches 0296 on a database that never applied
-- 0256. Guard both the disable and the re-enable on catalog presence rather
-- than assuming the trigger is there.
DO $connections_authority_binding_off$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger trg
    JOIN pg_class rel ON rel.oid = trg.tgrelid
    WHERE rel.relname = 'connections'
      AND trg.tgname = 'connections_authority_binding'
      AND NOT trg.tgisinternal
  ) THEN
    ALTER TABLE "connections" DISABLE TRIGGER "connections_authority_binding";
  END IF;
END $connections_authority_binding_off$;
ALTER TABLE "connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "enrollments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" NO FORCE ROW LEVEL SECURITY;

-- Precondition guard. `origin_workspace_id` / `authority_scope` are added by
-- 0256 and 0262, and the self-organization role by 0263. Several migration
-- tests pre-seed schema_migrations receipts to simulate an older database
-- (0184/0190/0241/0249/0264 all do this), which makes migrate() SKIP those
-- migrations while still reaching this one - so the columns this file repairs
-- may genuinely be absent. A deployment replaying a partial chain hits the
-- same shape. Repair only what exists; a missing column means there is
-- nothing that could have silently no-opped.
DO $force_rls_backfill_noop_repair$
DECLARE
  has_connection_origin boolean;
  has_enrollment_origin boolean;
  has_membership_role boolean;
  unrepaired_connections bigint := 0;
  unrepaired_enrollments bigint := 0;
  unrepaired_memberships bigint := 0;
BEGIN
  has_connection_origin := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connections' AND column_name = 'origin_workspace_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connections' AND column_name = 'authority_scope'
  );
  has_enrollment_origin := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'enrollments' AND column_name = 'origin_workspace_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'enrollments' AND column_name = 'authority_scope'
  );
  has_membership_role := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organization_memberships' AND column_name = 'role'
  );

  IF has_connection_origin THEN
    EXECUTE $sql$
      UPDATE "connections" SET "origin_workspace_id" = "workspace_id"
      WHERE "origin_workspace_id" IS NULL AND "authority_scope" = 'workspace'
    $sql$;
    EXECUTE $sql$
      SELECT count(*) FROM connections
      WHERE origin_workspace_id IS NULL AND authority_scope = 'workspace'
    $sql$ INTO unrepaired_connections;
  END IF;

  IF has_enrollment_origin THEN
    EXECUTE $sql$
      UPDATE "enrollments" SET "origin_workspace_id" = "workspace_id"
      WHERE "origin_workspace_id" IS NULL AND "authority_scope" = 'workspace'
    $sql$;
    EXECUTE $sql$
      SELECT count(*) FROM enrollments
      WHERE origin_workspace_id IS NULL AND authority_scope = 'workspace'
    $sql$ INTO unrepaired_enrollments;
  END IF;

  IF has_membership_role THEN
    EXECUTE $sql$
      UPDATE "organization_memberships" membership SET "role" = 'owner'
      FROM "managed_accounts" account
      WHERE account.id = membership.account_id
        AND account.external_source = 'better-auth:user'
        AND membership.subject_id = 'user:' || account.external_id
        AND membership.role <> 'owner'
    $sql$;
    EXECUTE $sql$
      SELECT count(*) FROM organization_memberships membership
      JOIN managed_accounts account ON account.id = membership.account_id
      WHERE account.external_source = 'better-auth:user'
        AND membership.subject_id = 'user:' || account.external_id
        AND membership.role <> 'owner'
    $sql$ INTO unrepaired_memberships;
  END IF;

  -- The verification still runs inside the owner-only NO FORCE window, so a
  -- future regression of this class fails loudly here rather than reporting
  -- success. Skipped lanes contribute 0 because they had nothing to repair.
  IF unrepaired_connections > 0
    OR unrepaired_enrollments > 0
    OR unrepaired_memberships > 0
  THEN
    RAISE EXCEPTION
      'FORCE-RLS backfill repair did not converge: % workspace-scope connection(s), % workspace-scope enrollment(s) with a NULL origin_workspace_id, and % self-organization membership(s) still not owner',
      unrepaired_connections, unrepaired_enrollments, unrepaired_memberships
      USING ERRCODE = '55000';
  END IF;
END
$force_rls_backfill_noop_repair$;

ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "enrollments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
DO $connections_authority_binding_on$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger trg
    JOIN pg_class rel ON rel.oid = trg.tgrelid
    WHERE rel.relname = 'connections'
      AND trg.tgname = 'connections_authority_binding'
      AND NOT trg.tgisinternal
  ) THEN
    ALTER TABLE "connections" ENABLE TRIGGER "connections_authority_binding";
  END IF;
END $connections_authority_binding_on$;
