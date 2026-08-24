-- deployment-mode: rolling
-- Complete the organization-tenancy evidence chain, converge the final
-- deterministic connection compatibility population, and make activation
-- consume one fenced evidence snapshot. This migration activates no tenant.
-- Existing zero-receipt activations stay replayable; new activations require
-- six exact receipts, including connection convergence. Five was never a
-- shipped cardinality, so the constraint does not tolerate it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE tenancy_backfill_unresolved_rows
  DROP CONSTRAINT tenancy_backfill_unresolved_reason_chk,
  ADD CONSTRAINT tenancy_backfill_unresolved_reason_chk CHECK (
    reason_code IN (
      'no_deterministic_evidence', 'ambiguous_candidate_authority',
      'missing_organization_membership', 'conflicting_authority_rows',
      'external_lane_owns_row', 'legacy_shape_unrecognized',
      'missing_login_identity', 'organization_identity_mismatch',
      'missing_owner_workspace_membership', 'membership_terminal_status',
      'deterministic_repair_pending'
    )
  );

ALTER TABLE session_tenancy_activations
  ADD COLUMN backfill_receipt_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD CONSTRAINT session_tenancy_activation_backfill_receipts_check CHECK (
    cardinality(backfill_receipt_ids) IN (0, 6)
  );

-- An application-controlled GUC is not a write capability. The exact
-- backend+transaction+organization receipt allows only the reviewed upgrader
-- to cross the otherwise immutable connection-authority boundary.
CREATE TABLE opengeni_private.connection_tenancy_backfill_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  account_id uuid NOT NULL,
  CONSTRAINT connection_tenancy_backfill_capabilities_pk PRIMARY KEY (
    backend_pid, transaction_id, account_id
  )
);
REVOKE ALL ON TABLE opengeni_private.connection_tenancy_backfill_capabilities FROM PUBLIC;

CREATE FUNCTION opengeni_private.connection_tenancy_backfill_capability_active(
  p_account_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, opengeni_private
AS $capability$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.connection_tenancy_backfill_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.account_id = p_account_id
  )
$capability$;
REVOKE ALL ON FUNCTION
  opengeni_private.connection_tenancy_backfill_capability_active(uuid) FROM PUBLIC;

-- FORCE-RLS visibility exists only while the SECURITY DEFINER classifier or
-- upgrader holds its unforgeable transaction capability, and only for the
-- migration owner the reviewed seams run as (0285/0298's conjunct). Direct
-- runtime DML cannot create the capability row.
DO $connection_tenancy_backfill_capability_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_tenancy_backfill_read ON %I.organization_memberships '
      || 'FOR SELECT USING (current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id))',
    data_schema, migration_owner
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_tenancy_backfill_read ON %I.connections '
      || 'FOR SELECT USING (current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id))',
    data_schema, migration_owner
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_tenancy_backfill_update ON %I.connections '
      || 'FOR UPDATE USING (current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id)) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id))',
    data_schema, migration_owner, migration_owner
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_tenancy_backfill_read '
      || 'ON %I.organization_user_resource_authorities '
      || 'FOR SELECT USING (resource_kind = ''connection'' AND current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id))',
    data_schema, migration_owner
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_tenancy_backfill_insert '
      || 'ON %I.organization_user_resource_authorities '
      || 'FOR INSERT WITH CHECK (resource_kind = ''connection'' AND current_user = %L AND '
      || 'opengeni_private.connection_tenancy_backfill_capability_active(account_id))',
    data_schema, migration_owner
  );
END
$connection_tenancy_backfill_capability_policies$;

-- Owner-only marker policies for the connection owner-authority binding below.
--
-- `organization_memberships` and `organization_user_resource_authorities` are
-- FORCE ROW LEVEL SECURITY with ZERO runtime table privileges, so the marker is
-- unreachable as an application write vector - it is exactly the gate the
-- existing `organization_tenancy_lifecycle` policies on both tables already
-- use - and the `current_user` conjunct keeps every branch owner-only besides.
-- They are separate narrow policies rather than new markers on the shared
-- lifecycle policy so a later migration restating that policy's list cannot
-- silently drop connection binding (0305 dropped 0290's marker exactly that
-- way).
--
-- The `FOR UPDATE` policy on `organization_memberships` is not a write grant to
-- the binding: PostgreSQL evaluates the UPDATE/ALL policy USING clause for
-- `SELECT ... FOR SHARE` as well as the SELECT one, so a row-locking lookup is
-- blind without it.
DO $connection_authority_binding_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  -- Tenant-fenced in the policy itself, not only in the seam: the window can
  -- never widen into an organization-wide membership or authority read.
  marker constant text :=
    'current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''connection_authority_binding'' AND account_id = nullif('
      || 'current_setting(''opengeni.account_id'', true), '''')::uuid';
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_authority_binding_read ON %I.organization_memberships '
      || 'FOR SELECT USING (current_user = %L AND %s)',
    data_schema, migration_owner, marker
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_authority_binding_lock ON %I.organization_memberships '
      || 'FOR UPDATE USING (current_user = %L AND %s)',
    data_schema, migration_owner, marker
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY connection_authority_binding_insert '
      || 'ON %I.organization_user_resource_authorities '
      || 'FOR INSERT WITH CHECK (resource_kind = ''connection'' AND current_user = %L AND %s)',
    data_schema, migration_owner, marker
  );
END
$connection_authority_binding_policies$;

-- Migration 0290 gave its two read-only membership seams the
-- `organization_membership_backfill` marker on the shared
-- `organization_tenancy_lifecycle` policy. Migration 0305 then restated that
-- policy's marker list to add `personal_resource_grant_management` and dropped
-- 0290's entry, so `list_organization_membership_backfill_anchors` and
-- `list_organization_memberships_without_personal_workspace` have returned `[]`
-- ever since for a NON-superuser migration owner - measured, not inferred, on
-- `acquireOwnerMigratedTestDatabase`. Both are SECURITY DEFINER owned by that
-- role, so even a superuser CALLER gets the owner's RLS; only a
-- superuser-migrated database (every existing test harness) hid it.
--
-- The consequence is phase D's membership half: an already-anchored subject is
-- misread as provisionable, and the memberships that carry no personal
-- workspace - the actual backfill target population - are invisible, so the
-- walk can never converge them and its `organization_memberships` receipt
-- counts are wrong.
--
-- Restored as its own narrow read-only policy rather than as a fourth entry in
-- the shared list, so the next migration to restate that list cannot silently
-- delete it again. Both seams are plain `SELECT`s, so `FOR SELECT` is exactly
-- the command they issue.
DO $organization_membership_backfill_read_policy$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY organization_membership_backfill_read '
      || 'ON %I.organization_memberships FOR SELECT USING (current_user = %L AND '
      || 'current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''organization_membership_backfill'' AND account_id = nullif('
      || 'current_setting(''opengeni.account_id'', true), '''')::uuid)',
    data_schema, migration_owner
  );
END
$organization_membership_backfill_read_policy$;

-- The single owner-authority seam both connection-binding branches use.
-- `organization_memberships` and `organization_user_resource_authorities` are
-- FORCE ROW LEVEL SECURITY, and OpenGeni migrates and runs its SECURITY DEFINER
-- routines as a NON-superuser owner without BYPASSRLS, so the owner is
-- policy-bound too. 0256's inline `SELECT ... FOR SHARE` plus authority INSERT
-- therefore could not work on any production deployment: the mint path silently
-- degraded every personal connection to `legacy_user`, and 0340's backfill
-- verification would have raised `42501` on every deterministic candidate.
-- Opening the reviewed marker window for exactly this binding is 0263's
-- `assert_active_managed_human_organization_membership` pattern, restored on
-- every exit. The row lock is kept: it serializes the mint and the bounded
-- upgrade against a concurrent membership revocation.
--
-- Tenant-fenced, so it never becomes a cross-organization membership oracle.
-- It is a resolver, never an authorization: the trigger still owns the decision
-- that the caller IS this subject. `provision-roles` blanket-grants EXECUTE on
-- every `opengeni_private` routine to the runtime role, and the four authority
-- tables must keep ZERO direct application DML, so the seam additionally
-- refuses to do anything outside a trigger: a direct call by the application
-- role can neither read a membership nor mint an authority row.
CREATE FUNCTION opengeni_private.bind_connection_owner_authority(
  p_account_id uuid,
  p_subject_id text,
  p_connection_id uuid DEFAULT NULL,
  p_workspace_id uuid DEFAULT NULL,
  OUT membership_id uuid,
  OUT authority_id uuid
) RETURNS record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $owner_authority$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  membership_id := NULL;
  authority_id := NULL;
  IF pg_catalog.pg_trigger_depth() = 0
    OR p_account_id IS NULL OR p_subject_id IS NULL
    OR p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'connection_authority_binding', true
  );
  SELECT membership.id INTO membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_subject_id
    AND membership.status = 'active' AND membership.revoked_at IS NULL
  FOR SHARE;
  IF membership_id IS NOT NULL AND p_connection_id IS NOT NULL
    AND p_workspace_id IS NOT NULL
  THEN
    authority_id := pg_catalog.gen_random_uuid();
    INSERT INTO organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) VALUES (
      authority_id, p_account_id, membership_id, 'connection', p_connection_id,
      p_workspace_id, 1, 'active'
    );
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$owner_authority$;
REVOKE ALL ON FUNCTION
  opengeni_private.bind_connection_owner_authority(uuid, text, uuid, uuid) FROM PUBLIC;

-- Exact-scoped activation lookup used by the connection/writer triggers. The
-- account must already be the transaction tenant: this keeps the helper safe
-- under the provisioner's reviewed private-helper EXECUTE posture.
CREATE FUNCTION opengeni_private.session_tenancy_account_activated(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $activated$
  SELECT p_account_id IS NOT DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
    AND EXISTS (
      SELECT 1 FROM session_tenancy_activations activation
      WHERE activation.account_id = p_account_id AND activation.activation_version = 1
    )
$activated$;
REVOKE ALL ON FUNCTION opengeni_private.session_tenancy_account_activated(uuid) FROM PUBLIC;

-- Preserve 0256 byte-for-byte behavior before activation. Afterwards a new
-- personal connection must have a live membership and may not reopen the
-- legacy_user lane. The only immutable-authority transition is the exact
-- capability-held legacy_user -> user backfill below.
CREATE OR REPLACE FUNCTION opengeni_private.bind_connection_authority()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $binding$
DECLARE
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  membership_id uuid;
  authority_value uuid;
  identity_changed boolean;
  backfill_transition boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.origin_workspace_id := NEW.workspace_id;
    NEW.authority_generation := 1;
    IF NEW.subject_id IS NULL THEN
      NEW.authority_scope := 'workspace';
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      RETURN NEW;
    END IF;
    IF caller_subject IS DISTINCT FROM NEW.subject_id THEN
      RAISE EXCEPTION 'personal connection owner must be the authenticated subject'
        USING ERRCODE = '42501';
    END IF;
    SELECT binding.membership_id, binding.authority_id
      INTO membership_id, authority_value
    FROM opengeni_private.bind_connection_owner_authority(
      NEW.account_id, caller_subject, NEW.id, NEW.workspace_id
    ) binding;
    IF membership_id IS NULL THEN
      IF opengeni_private.session_tenancy_account_activated(NEW.account_id) THEN
        RAISE EXCEPTION 'activated organization requires connection membership authority'
          USING ERRCODE = '42501';
      END IF;
      NEW.authority_scope := 'legacy_user';
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      RETURN NEW;
    END IF;
    NEW.authority_scope := 'user';
    NEW.authority_id := authority_value;
    NEW.owner_organization_membership_id := membership_id;
    RETURN NEW;
  END IF;

  backfill_transition :=
    opengeni_private.connection_tenancy_backfill_capability_active(NEW.account_id)
    AND OLD.authority_scope = 'legacy_user'
    AND OLD.subject_id IS NOT NULL
    AND OLD.authority_id IS NULL
    AND OLD.owner_organization_membership_id IS NULL
    AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
    AND NEW.authority_scope = 'user'
    AND NEW.authority_id IS NOT NULL
    AND NEW.owner_organization_membership_id IS NOT NULL
    AND NEW.origin_workspace_id IS NOT DISTINCT FROM OLD.origin_workspace_id;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
    OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
    OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.origin_workspace_id IS DISTINCT FROM OLD.origin_workspace_id
  THEN
    IF NOT backfill_transition THEN
      RAISE EXCEPTION 'connection owner authority is immutable' USING ERRCODE = '23514';
    END IF;
    SELECT binding.membership_id INTO membership_id
    FROM opengeni_private.bind_connection_owner_authority(
      NEW.account_id, NEW.subject_id
    ) binding;
    IF membership_id IS DISTINCT FROM NEW.owner_organization_membership_id THEN
      RAISE EXCEPTION 'connection backfill membership authority is unavailable'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM organization_user_resource_authorities authority
    WHERE authority.id = NEW.authority_id
      AND authority.account_id = NEW.account_id
      AND authority.organization_membership_id = NEW.owner_organization_membership_id
      AND authority.resource_kind = 'connection' AND authority.resource_id = NEW.id
      AND authority.origin_workspace_id = NEW.origin_workspace_id
      AND authority.generation = 1
      AND authority.status = 'active' AND authority.revoked_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'connection backfill common authority is unavailable'
        USING ERRCODE = '42501';
    END IF;
    NEW.authority_generation := OLD.authority_generation + 1;
    RETURN NEW;
  END IF;

  identity_changed := NEW.provider_domain IS DISTINCT FROM OLD.provider_domain
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.status IS DISTINCT FROM OLD.status;
  IF identity_changed THEN
    NEW.authority_generation := OLD.authority_generation + 1;
  ELSIF NEW.authority_generation NOT IN (
    OLD.authority_generation, OLD.authority_generation + 1
  ) THEN
    RAISE EXCEPTION 'connection authority generation must be stable or advance once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$binding$;
REVOKE ALL ON FUNCTION opengeni_private.bind_connection_authority() FROM PUBLIC;

-- Full-population classifier. A legacy row with an exact live same-account
-- membership is a deterministic repair obligation; without one it is
-- unresolved. Origin workspace/current access are never ownership evidence.
CREATE FUNCTION classify_organization_connection_authority(
  p_account_id uuid, p_run_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $classification$
DECLARE
  summary jsonb;
  receipt_id uuid;
  unresolved_row record;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'connection authority classification requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'connection authority classification scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_key IS NOT NULL AND length(btrim(p_run_key)) = 0 THEN
    RAISE EXCEPTION 'connection authority classification run key must not be blank'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.connection_tenancy_backfill_capabilities (
    backend_pid, transaction_id, account_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_account_id)
  ON CONFLICT DO NOTHING;

  WITH classified AS (
    SELECT connection_row.id AS resource_id,
      CASE
        WHEN connection_row.authority_scope = 'workspace'
          AND connection_row.subject_id IS NULL AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND connection_row.origin_workspace_id = connection_row.workspace_id
          THEN 'workspace_owned'
        WHEN connection_row.authority_scope = 'user'
          AND connection_row.subject_id IS NOT NULL
          AND authority.id = connection_row.authority_id
          AND authority.resource_kind = 'connection'
          AND authority.resource_id = connection_row.id
          AND authority.organization_membership_id = connection_row.owner_organization_membership_id
          AND authority.origin_workspace_id = connection_row.origin_workspace_id
          AND authority.status = 'active' AND authority.revoked_at IS NULL
          AND membership.id = connection_row.owner_organization_membership_id
          AND membership.subject_id = connection_row.subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          THEN 'user_owned'
        WHEN connection_row.authority_scope = 'legacy_user'
          AND connection_row.subject_id IS NOT NULL AND connection_row.authority_id IS NULL
          AND connection_row.owner_organization_membership_id IS NULL
          AND membership.id IS NOT NULL
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          THEN 'deterministic_repair_pending'
        WHEN connection_row.authority_scope = 'legacy_user'
          THEN 'missing_organization_membership'
        WHEN connection_row.authority_scope = 'user'
          AND (membership.id IS NULL OR membership.status <> 'active'
            OR membership.revoked_at IS NOT NULL)
          THEN 'missing_organization_membership'
        WHEN connection_row.authority_scope = 'user' THEN 'conflicting_authority_rows'
        ELSE 'legacy_shape_unrecognized'
      END AS verdict
    FROM connections connection_row
    LEFT JOIN organization_memberships membership
      ON membership.account_id = connection_row.account_id
     AND membership.subject_id = connection_row.subject_id
     AND membership.status = 'active' AND membership.revoked_at IS NULL
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = connection_row.authority_id
     AND authority.account_id = connection_row.account_id
    WHERE connection_row.account_id = p_account_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'organizationId', p_account_id, 'runKey', p_run_key,
    'rewroteConnectionRows', false,
    'connections', pg_catalog.jsonb_build_object(
      'total', count(*)::int,
      'workspaceOwned', count(*) FILTER (WHERE verdict = 'workspace_owned')::int,
      'userOwned', count(*) FILTER (WHERE verdict = 'user_owned')::int,
      'deterministicRepairPending', count(*) FILTER (
        WHERE verdict = 'deterministic_repair_pending'
      )::int,
      'unresolved', count(*) FILTER (
        WHERE verdict NOT IN ('workspace_owned', 'user_owned')
      )::int
    )
  ) INTO summary FROM classified;

  IF p_run_key IS NOT NULL THEN
    SELECT open_tenancy_backfill_receipt(p_account_id, 'connections', p_run_key)
      INTO receipt_id;
    FOR unresolved_row IN
      WITH classified AS (
        SELECT connection_row.id AS resource_id,
          CASE
            WHEN connection_row.authority_scope = 'workspace'
              AND connection_row.subject_id IS NULL AND connection_row.authority_id IS NULL
              AND connection_row.owner_organization_membership_id IS NULL
              AND connection_row.origin_workspace_id = connection_row.workspace_id
              THEN 'terminal'
            WHEN connection_row.authority_scope = 'user'
              AND connection_row.subject_id IS NOT NULL
              AND authority.id = connection_row.authority_id
              AND authority.resource_kind = 'connection'
              AND authority.resource_id = connection_row.id
              AND authority.organization_membership_id
                = connection_row.owner_organization_membership_id
              AND authority.origin_workspace_id = connection_row.origin_workspace_id
              AND authority.status = 'active' AND authority.revoked_at IS NULL
              AND membership.id = connection_row.owner_organization_membership_id
              AND membership.subject_id = connection_row.subject_id
              AND membership.status = 'active' AND membership.revoked_at IS NULL
              THEN 'terminal'
            WHEN connection_row.authority_scope = 'legacy_user'
              AND membership.id IS NOT NULL
              AND membership.status = 'active' AND membership.revoked_at IS NULL
              THEN 'deterministic_repair_pending'
            WHEN connection_row.authority_scope = 'legacy_user'
              OR (connection_row.authority_scope = 'user'
                AND (membership.id IS NULL OR membership.status <> 'active'
                  OR membership.revoked_at IS NOT NULL))
              THEN 'missing_organization_membership'
            WHEN connection_row.authority_scope = 'user' THEN 'conflicting_authority_rows'
            ELSE 'legacy_shape_unrecognized'
          END AS reason_code
        FROM connections connection_row
        LEFT JOIN organization_memberships membership
          ON membership.account_id = connection_row.account_id
         AND membership.subject_id = connection_row.subject_id
         AND membership.status = 'active' AND membership.revoked_at IS NULL
        LEFT JOIN organization_user_resource_authorities authority
          ON authority.id = connection_row.authority_id
         AND authority.account_id = connection_row.account_id
        WHERE connection_row.account_id = p_account_id
      )
      SELECT resource_id, reason_code FROM classified
      WHERE reason_code <> 'terminal' ORDER BY resource_id
    LOOP
      PERFORM record_tenancy_backfill_unresolved(
        receipt_id, unresolved_row.resource_id, unresolved_row.reason_code
      );
    END LOOP;
    PERFORM complete_tenancy_backfill_receipt(
      receipt_id,
      (summary #>> '{connections,workspaceOwned}')::bigint
        + (summary #>> '{connections,userOwned}')::bigint,
      0, 'completed'
    );
    summary := summary || pg_catalog.jsonb_build_object('receiptId', receipt_id);
  END IF;

  DELETE FROM opengeni_private.connection_tenancy_backfill_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND account_id = p_account_id;
  RETURN summary;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.connection_tenancy_backfill_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND account_id = p_account_id;
  RAISE;
END
$classification$;
REVOKE ALL ON FUNCTION classify_organization_connection_authority(uuid, text) FROM PUBLIC;

-- Bounded, resumable, SKIP-LOCKED upgrader. It changes only legacy_user rows
-- whose exact subject has one live same-organization membership.
CREATE FUNCTION backfill_organization_connection_authority(
  p_account_id uuid, p_limit integer DEFAULT 500, p_dry_run boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $backfill$
DECLARE
  candidate_count integer := 0;
  upgraded_count integer := 0;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'connection authority backfill requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'connection authority backfill scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'connection authority backfill request is invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.connection_tenancy_backfill_capabilities (
    backend_pid, transaction_id, account_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_account_id)
  ON CONFLICT DO NOTHING;

  IF p_dry_run THEN
    SELECT count(*)::int INTO candidate_count FROM (
      SELECT connection_row.id
      FROM connections connection_row
      JOIN organization_memberships membership
        ON membership.account_id = connection_row.account_id
       AND membership.subject_id = connection_row.subject_id
       AND membership.status = 'active' AND membership.revoked_at IS NULL
      WHERE connection_row.account_id = p_account_id
        AND connection_row.authority_scope = 'legacy_user'
      ORDER BY connection_row.id LIMIT p_limit
    ) candidate;
  ELSE
    WITH candidates AS MATERIALIZED (
      SELECT connection_row.id, connection_row.account_id,
        connection_row.origin_workspace_id, membership.id AS membership_id
      FROM connections connection_row
      JOIN organization_memberships membership
        ON membership.account_id = connection_row.account_id
       AND membership.subject_id = connection_row.subject_id
       AND membership.status = 'active' AND membership.revoked_at IS NULL
      WHERE connection_row.account_id = p_account_id
        AND connection_row.authority_scope = 'legacy_user'
      ORDER BY connection_row.id LIMIT p_limit
      FOR UPDATE OF connection_row SKIP LOCKED
    ), authorities AS (
      INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      )
      SELECT pg_catalog.gen_random_uuid(), candidate.account_id, candidate.membership_id,
        'connection', candidate.id, candidate.origin_workspace_id, 1, 'active'
      FROM candidates candidate
      RETURNING id, resource_id, organization_membership_id
    ), upgraded AS (
      UPDATE connections connection_row SET authority_scope = 'user',
        authority_id = authority.id,
        owner_organization_membership_id = authority.organization_membership_id
      FROM authorities authority
      WHERE connection_row.id = authority.resource_id
        AND connection_row.account_id = p_account_id
        AND connection_row.authority_scope = 'legacy_user'
      RETURNING connection_row.id
    )
    SELECT (SELECT count(*)::int FROM candidates),
      (SELECT count(*)::int FROM upgraded)
    INTO candidate_count, upgraded_count;
  END IF;

  DELETE FROM opengeni_private.connection_tenancy_backfill_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND account_id = p_account_id;
  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'organizationId', p_account_id,
    'dryRun', p_dry_run, 'limit', p_limit,
    'candidates', candidate_count, 'upgraded', upgraded_count,
    'moreLikely', NOT p_dry_run AND candidate_count >= p_limit
  );
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.connection_tenancy_backfill_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND account_id = p_account_id;
  RAISE;
END
$backfill$;
REVOKE ALL ON FUNCTION backfill_organization_connection_authority(uuid, integer, boolean)
  FROM PUBLIC;

-- Once activated, surviving legacy_user rows are invisible to runtime reads.
-- This also fences an old worker that bypasses accepted-use resolution. The
-- audited inventory/parity/backfill capabilities retain recovery visibility.
--
-- Two constraints shape how this policy is created:
--
--   * `connections.authority_scope` arrives in 0256, and a partial-history
--     replay can legitimately defer that migration past this point (0249's
--     upgrade fixture does exactly that). Creating a policy over an absent
--     column aborts the whole chain there, so the creation is existence-guarded
--     exactly like 0298's parity capability policies. Such a database simply
--     cannot execute the connection lane, which is already true of every other
--     reader of that column.
--   * Every predicate a `connections` policy calls must live in
--     `opengeni_private` (`workspace_rls_visible` is the established example).
--     EXECUTE on the data-schema `session_tenancy_product_activated` is revoked
--     from PUBLIC and granted only to the runtime role, so calling it here
--     would make an unrelated SECURITY DEFINER owner of `connections` fail with
--     `42501` on an ordinary read. `opengeni_private.session_tenancy_account_activated`
--     is the byte-identical private predicate (same account-GUC fence, version 1).
DO $connection_tenancy_legacy_retirement$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
        pg_catalog.format('%I.%I', data_schema, 'connections')
      )
      AND attribute.attname = 'authority_scope'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    EXECUTE pg_catalog.format(
      'CREATE POLICY connection_tenancy_legacy_retirement ON %I.connections '
        || 'AS RESTRICTIVE FOR SELECT USING ('
        || 'authority_scope <> ''legacy_user'''
        || ' OR NOT opengeni_private.session_tenancy_account_activated(account_id)'
        || ' OR opengeni_private.connection_tenancy_backfill_capability_active(account_id)'
        || ' OR opengeni_private.organization_tenancy_inventory_capability_active()'
        || ' OR opengeni_private.organization_tenancy_parity_capability_active())',
      data_schema
    );
  END IF;
END
$connection_tenancy_legacy_retirement$;

-- Pre-0277 binaries/turns can omit attribution and land on the explicit
-- legacy default before activation. Afterwards a new legacy admission or
-- retained process is rejected instead of reopening the observation lane.
CREATE FUNCTION opengeni_private.guard_activated_tenancy_writer()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $writer_fence$
BEGIN
  IF NEW.initiator_kind = 'legacy_unattributed'
    AND opengeni_private.session_tenancy_account_activated(NEW.account_id)
  THEN
    RAISE EXCEPTION 'activated organization refuses unattributed workspace writers'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$writer_fence$;
REVOKE ALL ON FUNCTION opengeni_private.guard_activated_tenancy_writer() FROM PUBLIC;

CREATE TRIGGER sandbox_workspace_mutation_admissions_tenancy_writer_fence
  BEFORE INSERT ON sandbox_workspace_mutation_admissions
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_activated_tenancy_writer();
CREATE TRIGGER sandbox_retained_processes_tenancy_writer_fence
  BEFORE INSERT ON sandbox_retained_processes
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_activated_tenancy_writer();

-- Preserve the reviewed 0298 report and replace only its known undercount:
-- stated session authority is an ordinary workspace-membership row OR the
-- active membership's own personal_workspace_id pointer (0302).
ALTER FUNCTION check_organization_tenancy_parity(uuid, integer, integer)
  RENAME TO check_organization_tenancy_parity_pre_0340;
ALTER FUNCTION check_organization_tenancy_parity_pre_0340(uuid, integer, integer)
  SET SCHEMA opengeni_private;
REVOKE ALL ON FUNCTION
  opengeni_private.check_organization_tenancy_parity_pre_0340(uuid, integer, integer)
  FROM PUBLIC;

CREATE FUNCTION check_organization_tenancy_parity(
  p_organization_id uuid,
  p_evidence_limit integer DEFAULT 10,
  p_observation_window_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '60s'
AS $parity$
DECLARE
  result jsonb;
  attributable_count integer;
BEGIN
  result := opengeni_private.check_organization_tenancy_parity_pre_0340(
    p_organization_id, p_evidence_limit, p_observation_window_days
  );
  INSERT INTO opengeni_private.organization_tenancy_parity_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;
  SELECT count(*)::int INTO attributable_count
  FROM sessions session_row
  WHERE session_row.account_id = p_organization_id
    AND session_row.owner_organization_membership_id IS NULL
    AND session_row.created_by_kind = 'subject'
    AND session_row.created_by_subject_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = p_organization_id
        AND membership.subject_id = session_row.created_by_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND (
          membership.personal_workspace_id = session_row.workspace_id
          OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_organization_id
              AND workspace_membership.workspace_id = session_row.workspace_id
              AND workspace_membership.subject_id = session_row.created_by_subject_id
          )
        )
    );
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN pg_catalog.jsonb_set(
    result, '{lanes,sessionsAttributableButUnattributed}',
    pg_catalog.to_jsonb(attributable_count), false
  );
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$parity$;
REVOKE ALL ON FUNCTION check_organization_tenancy_parity(uuid, integer, integer)
  FROM PUBLIC;

-- Same sorted UTF-8/C-locale canonical JSON algorithm as the operator command.
CREATE FUNCTION opengeni_private.tenancy_activation_canonical_json(value jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, opengeni_private
AS $canonical_json$
DECLARE
  rendered text;
BEGIN
  CASE pg_catalog.jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT coalesce(
        '{' || pg_catalog.string_agg(
          pg_catalog.to_jsonb(entry.key)::text || ':' ||
            opengeni_private.tenancy_activation_canonical_json(entry.value),
          ',' ORDER BY entry.key COLLATE "C"
        ) || '}', '{}'
      ) INTO rendered
      FROM pg_catalog.jsonb_each(value) AS entry(key, value);
      RETURN rendered;
    WHEN 'array' THEN
      SELECT coalesce(
        '[' || pg_catalog.string_agg(
          opengeni_private.tenancy_activation_canonical_json(entry.value),
          ',' ORDER BY entry.ordinality
        ) || ']', '[]'
      ) INTO rendered
      FROM pg_catalog.jsonb_array_elements(value)
        WITH ORDINALITY AS entry(value, ordinality);
      RETURN rendered;
    ELSE
      RETURN value::text;
  END CASE;
END
$canonical_json$;
REVOKE ALL ON FUNCTION opengeni_private.tenancy_activation_canonical_json(jsonb) FROM PUBLIC;

-- The newest receipt per family is authoritative. Full-population classifiers
-- must settle; connection/resource families must carry zero unresolved rows.
CREATE OR REPLACE FUNCTION check_tenancy_backfill_activation_evidence(
  p_account_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $evidence$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  resource_report jsonb;
  session_report jsonb;
  connection_report jsonb;
  result jsonb;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'tenancy backfill activation evidence requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy backfill activation evidence scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  resource_report := verify_organization_resource_classification(p_account_id, NULL);
  session_report := classify_organization_session_ownership(p_account_id, NULL);
  connection_report := classify_organization_connection_authority(p_account_id, NULL);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'tenancy_backfill_ledger', true
  );

  WITH required(resource_family, expected_total, unresolved_must_be_zero, family_order) AS (
    VALUES
      ('organization_memberships'::text, NULL::bigint, false, 1),
      ('sessions'::text, (session_report #>> '{sessions,total}')::bigint, false, 2),
      ('variable_sets'::text,
        (resource_report #>> '{families,variable_sets,total}')::bigint, true, 3),
      ('rigs'::text, (resource_report #>> '{families,rigs,total}')::bigint, true, 4),
      ('machines'::text, (resource_report #>> '{families,machines,total}')::bigint, true, 5),
      ('connections'::text,
        (connection_report #>> '{connections,total}')::bigint, true, 6)
  ), latest_receipt AS (
    SELECT DISTINCT ON (receipt.resource_family)
      receipt.resource_family, receipt.id, receipt.run_key, receipt.status,
      receipt.classified_count, receipt.skipped_count, receipt.unresolved_count,
      receipt.started_at
    FROM tenancy_backfill_receipts receipt
    WHERE receipt.account_id = p_account_id
      AND receipt.resource_family IN (SELECT resource_family FROM required)
    ORDER BY receipt.resource_family, receipt.started_at DESC, receipt.id DESC
  ), evaluated AS (
    SELECT required.*,
      latest_receipt.id AS receipt_id, latest_receipt.run_key,
      latest_receipt.status, latest_receipt.classified_count,
      latest_receipt.skipped_count, latest_receipt.unresolved_count,
      CASE
        WHEN latest_receipt.id IS NULL THEN 'missing_receipt'
        WHEN latest_receipt.status <> 'completed' THEN 'receipt_not_completed'
        WHEN required.expected_total IS NOT NULL
          AND latest_receipt.classified_count + latest_receipt.skipped_count
            + latest_receipt.unresolved_count <> required.expected_total
          THEN 'population_mismatch'
        WHEN required.unresolved_must_be_zero AND latest_receipt.unresolved_count <> 0
          THEN 'unresolved_rows'
        ELSE NULL
      END AS blocker
    FROM required LEFT JOIN latest_receipt USING (resource_family)
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1, 'organizationId', p_account_id,
    'ready', pg_catalog.bool_and(blocker IS NULL),
    'receiptIds', coalesce(
      pg_catalog.jsonb_agg(receipt_id ORDER BY family_order)
        FILTER (WHERE receipt_id IS NOT NULL), '[]'::jsonb
    ),
    'blockers', coalesce(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'resourceFamily', resource_family, 'code', blocker
      ) ORDER BY family_order) FILTER (WHERE blocker IS NOT NULL), '[]'::jsonb
    ),
    'families', pg_catalog.jsonb_object_agg(
      resource_family, pg_catalog.jsonb_build_object(
        'receiptId', receipt_id, 'runKey', run_key, 'status', status,
        'classifiedCount', classified_count, 'skippedCount', skipped_count,
        'unresolvedCount', unresolved_count, 'expectedTotal', expected_total,
        'blocker', blocker
      ) ORDER BY family_order
    )
  ) INTO result FROM evaluated;

  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$evidence$;
REVOKE ALL ON FUNCTION check_tenancy_backfill_activation_evidence(uuid) FROM PUBLIC;

-- This deployment-wide transaction fence is the serialization boundary between
-- the first irreversible operator activation and later greenfield organization
-- provisioning. A provisioning transaction must acquire it before observing
-- session_tenancy_any_product_activation(): if it wins, it commits before the
-- boundary; if activation wins, it observes the committed boundary and can
-- create its organization-scoped receipt atomically. Keep the key and signature
-- stable for that forward lane. The function is owner-only so an application
-- session cannot hold the deployment boundary open.
CREATE FUNCTION lock_session_tenancy_activation_boundary()
RETURNS void
LANGUAGE sql VOLATILE
SET search_path FROM CURRENT
AS $boundary$
  SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy-canonical-boundary:v1', 0
  ))
$boundary$;
REVOKE ALL ON FUNCTION lock_session_tenancy_activation_boundary() FROM PUBLIC;
COMMENT ON FUNCTION lock_session_tenancy_activation_boundary() IS
  'Owner-only deployment boundary fence shared by operator activation and atomic greenfield activation.';

-- Migration 0303 gave `session_tenancy_activations` FORCE ROW LEVEL SECURITY
-- and a `FOR SELECT`-only policy, and no INSERT policy at all. Under the
-- documented production posture - a NON-superuser owner without BYPASSRLS -
-- the activation's own receipt write was therefore denied `42501` AFTER every
-- gate had already passed, which made the whole cutover unexecutable. The
-- runtime role holds only `GRANT SELECT` on this table and is not the owner, so
-- an owner-only marker policy re-opens exactly the one command
-- `activate_session_tenancy_product` issues and nothing else. INSERT is the
-- complete write set: the table is append-only, has no UPDATE or DELETE writer
-- anywhere in the tree, and activation is one-way with no rollback path.
DO $session_tenancy_activation_receipt_policy$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_tenancy_activation_receipt_insert '
      || 'ON %I.session_tenancy_activations FOR INSERT WITH CHECK ('
      || 'current_user = %L AND '
      || 'current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''session_tenancy_activation'' AND account_id = nullif('
      || 'current_setting(''opengeni.account_id'', true), '''')::uuid)',
    data_schema, migration_owner
  );
END
$session_tenancy_activation_receipt_policy$;

-- Existing receipts replay before new evidence requirements. A new activation
-- takes the organization lifecycle advisory prefix, verifies the app drain,
-- write-locks every report source, and only then takes the deployment boundary.
-- Under those locks it recomputes all reports, validates the exact parity
-- catalogs, compares canonical digests, and stores six receipt ids.
CREATE OR REPLACE FUNCTION activate_session_tenancy_product(
  p_account_id uuid,
  p_inventory_digest text,
  p_parity_digest text,
  p_activated_by text,
  p_application_roles text[]
) RETURNS TABLE (
  account_id uuid, activation_version integer,
  activated_at timestamptz, replay boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $activation$
DECLARE
  existing session_tenancy_activations%ROWTYPE;
  inserted session_tenancy_activations%ROWTYPE;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  inventory_report jsonb;
  parity_report jsonb;
  backfill_evidence jsonb;
  computed_inventory_digest text;
  computed_parity_digest text;
  evidence_receipt_ids uuid[];
  required_gate text;
  required_lane text;
  required_gates constant text[] := ARRAY[
    'membership_personal_workspace_pointer',
    'membership_personal_workspace_exclusive',
    'membership_personal_workspace_same_organization',
    'personal_workspace_has_no_membership_row',
    'authority_resource_single_owner',
    'grant_delegation_fence_complete',
    'grant_owner_membership_active',
    'grant_authority_live',
    'grant_session_fence_not_ahead',
    'session_owner_provenance_paired',
    'session_owner_subject_matches_membership',
    'session_owner_membership_same_organization',
    'login_binding_dispute_propagated',
    'identity_active_binding_owned',
    'user_scoped_resource_live_anchor'
  ];
  required_lanes constant text[] := ARRAY[
    'connectionsLegacyUser',
    'workspaceWriterAdmissionsLegacyUnattributedInWindow',
    'workspaceWriterProcessesLegacyUnattributedInWindow',
    'documentsLegacyPersonalNullAuthority',
    'codexCredentialsUnattributedConnector',
    'workspaceMemberSubjectsWithoutMembershipAnchor',
    'sessionsAttributableButUnattributed',
    'connectionUseLegacyResolutionsInWindow'
  ];
BEGIN
  IF p_account_id IS NULL
    OR p_inventory_digest !~ '^[0-9a-f]{64}$'
    OR p_parity_digest !~ '^[0-9a-f]{64}$'
    OR pg_catalog.octet_length(pg_catalog.btrim(p_activated_by)) NOT BETWEEN 1 AND 256
    OR p_application_roles IS NULL
    OR pg_catalog.cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name <> pg_catalog.btrim(role_name)
        OR pg_catalog.octet_length(role_name) NOT BETWEEN 1 AND 63
    )
    OR pg_catalog.cardinality(ARRAY(
      SELECT DISTINCT role_name FROM pg_catalog.unnest(p_application_roles) role_name
    )) <> pg_catalog.cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy activation request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  LOCK TABLE
    workspaces, workspace_memberships, organization_memberships,
    canonical_human_identities, canonical_human_identity_subjects,
    canonical_human_login_bindings, sessions, session_turns,
    session_turn_attempts, session_attempt_interruptions,
    session_system_updates, session_human_input_requests,
    session_pending_tool_calls, agent_run_states, session_goals,
    codex_capacity_waiters, xai_capacity_waiters, session_realtime_modes,
    session_realtime_connections, scheduled_tasks,
    workspace_variable_sets, rigs, enrollments, connections, documents,
    codex_subscription_credentials, sandbox_workspace_mutation_admissions,
    sandbox_retained_processes, sandbox_lease_holders,
    organization_user_resource_authorities, organization_user_resource_grants,
    connection_use_audit_facts, tenancy_backfill_receipts,
    tenancy_backfill_unresolved_rows, session_tenancy_activations
  IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  -- Lock every provisioning source before the shared deployment fence. The
  -- greenfield path writes its graph first and takes the fence last; reversing
  -- this order would deadlock RowExclusive -> boundary against boundary ->
  -- AccessExclusive during the first cutover.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  SELECT * INTO existing FROM session_tenancy_activations activation
  WHERE activation.account_id = p_account_id;
  IF FOUND THEN
    IF existing.inventory_digest <> p_inventory_digest
      OR existing.parity_digest <> p_parity_digest
    THEN
      RAISE EXCEPTION 'session tenancy activation evidence conflicts with the durable receipt'
        USING ERRCODE = '23505';
    END IF;
    account_id := existing.account_id;
    activation_version := existing.activation_version;
    activated_at := existing.activated_at;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  inventory_report := inventory_organization_tenancy(p_account_id);
  parity_report := check_organization_tenancy_parity(p_account_id, 10, 30);
  backfill_evidence := check_tenancy_backfill_activation_evidence(p_account_id);
  IF inventory_report #>> '{schemaVersion}' <> '2'
    OR inventory_report ->> 'organizationId' <> p_account_id::text
    OR parity_report #>> '{schemaVersion}' <> '1'
    OR parity_report ->> 'organizationId' <> p_account_id::text
    OR pg_catalog.jsonb_typeof(parity_report -> 'gates') <> 'object'
    OR pg_catalog.jsonb_typeof(parity_report -> 'lanes') <> 'object'
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;

  FOREACH required_gate IN ARRAY required_gates LOOP
    IF NOT (parity_report -> 'gates' ? required_gate)
      OR pg_catalog.jsonb_typeof(parity_report -> 'gates' -> required_gate -> 'violations')
        <> 'number'
      OR (parity_report #>> ARRAY['gates', required_gate, 'violations'])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation parity gate is not clean: %', required_gate
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'gates') gate
    WHERE pg_catalog.jsonb_typeof(gate.value -> 'violations') <> 'number'
      OR (gate.value ->> 'violations')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation parity has a non-zero gate'
      USING ERRCODE = '55000';
  END IF;
  FOREACH required_lane IN ARRAY required_lanes LOOP
    IF NOT (parity_report -> 'lanes' ? required_lane)
      OR pg_catalog.jsonb_typeof(parity_report -> 'lanes' -> required_lane) <> 'number'
      OR (parity_report #>> ARRAY['lanes', required_lane])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation compatibility lane is not drained: %',
        required_lane USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'lanes') lane
    WHERE pg_catalog.jsonb_typeof(lane.value) <> 'number'
      OR (lane.value #>> '{}')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation has an undrained compatibility lane'
      USING ERRCODE = '55000';
  END IF;
  IF coalesce((backfill_evidence ->> 'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'session tenancy activation requires settled backfill evidence'
      USING ERRCODE = '55000', DETAIL = (backfill_evidence -> 'blockers')::text;
  END IF;

  computed_inventory_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(inventory_report), 'UTF8'
  ), 'sha256'), 'hex');
  computed_parity_digest := pg_catalog.encode(public.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(parity_report), 'UTF8'
  ), 'sha256'), 'hex');
  IF computed_inventory_digest <> p_inventory_digest
    OR computed_parity_digest <> p_parity_digest
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence changed before the cutover lock'
      USING ERRCODE = '40001';
  END IF;

  SELECT pg_catalog.array_agg(receipt_id::uuid ORDER BY ordinal)
    INTO evidence_receipt_ids
  FROM pg_catalog.jsonb_array_elements_text(backfill_evidence -> 'receiptIds')
    WITH ORDINALITY AS evidence(receipt_id, ordinal);
  IF pg_catalog.cardinality(evidence_receipt_ids) <> 6 THEN
    RAISE EXCEPTION 'session tenancy activation backfill evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;
  -- The narrow marker window for the one append this function performs. The
  -- `RETURNING` read is covered by 0303's existing organization-isolation
  -- SELECT policy, whose account GUC this function already set above.
  BEGIN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
    );
    INSERT INTO session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) VALUES (
      p_account_id, 1, p_inventory_digest, p_parity_digest,
      pg_catalog.btrim(p_activated_by), evidence_receipt_ids
    ) RETURNING * INTO inserted;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RAISE;
  END;
  account_id := inserted.account_id;
  activation_version := inserted.activation_version;
  activated_at := inserted.activated_at;
  replay := false;
  RETURN NEXT;
END
$activation$;
REVOKE ALL ON FUNCTION
  activate_session_tenancy_product(uuid, text, text, text, text[]) FROM PUBLIC;

DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.session_tenancy_account_activated(uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.bind_connection_owner_authority(uuid,text,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.bind_connection_authority() '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.classify_organization_connection_authority(uuid,text) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.backfill_organization_connection_authority(uuid,integer,boolean) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION opengeni_private.guard_activated_tenancy_writer() '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.check_organization_tenancy_parity(uuid,integer,integer) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.check_tenancy_backfill_activation_evidence(uuid) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.lock_session_tenancy_activation_boundary() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.activate_session_tenancy_product(uuid,text,text,text,text[]) '
      || 'SET search_path = pg_catalog, %I, opengeni_private, public, pg_temp',
    data_schema, data_schema
  );

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.connection_tenancy_backfill_capability_active(uuid)
      TO opengeni_app;
    -- Referenced by the RESTRICTIVE `connections` retirement policy, so the
    -- runtime role must be able to evaluate it on every ordinary read even in
    -- the migrate-without-reprovision order.
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_tenancy_account_activated(uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.bind_connection_owner_authority(uuid, text, uuid, uuid)
      TO opengeni_app;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.classify_organization_connection_authority(uuid,text) TO opengeni_app',
      data_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.backfill_organization_connection_authority(uuid,integer,boolean) TO opengeni_app',
      data_schema
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.check_organization_tenancy_parity(uuid,integer,integer) TO opengeni_app',
      data_schema
    );
    REVOKE ALL ON FUNCTION
      opengeni_private.check_organization_tenancy_parity_pre_0340(uuid,integer,integer)
      FROM opengeni_app;
  END IF;
END
$posture$;

COMMENT ON FUNCTION classify_organization_connection_authority(uuid, text) IS
  'Full-population connection authority classifier and migration-0300 receipt writer. Deterministic legacy_user repairs remain unresolved until the bounded upgrader converges them.';
COMMENT ON FUNCTION backfill_organization_connection_authority(uuid, integer, boolean) IS
  'Bounded SKIP-LOCKED legacy_user upgrader using only the connection subject and one exact live same-organization membership; origin workspace and current access are never ownership evidence.';
