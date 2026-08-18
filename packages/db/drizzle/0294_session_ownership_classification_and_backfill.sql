-- deployment-mode: rolling
-- Migration 0294: session ownership classification plus the one deterministic
-- backfill (OPE-204 phase D, slice 6).
--
-- THE PREMISE THIS SLICE WAS SCOPED ON WAS WRONG
-- ----------------------------------------------
-- Slice 6 was planned as "sessions are 100% owner-NULL; nothing writes session
-- ownership". That is false. Migration 0225's `guard_session_authority_write`
-- trigger DERIVES session ownership on every INSERT, and 0225's
-- `session_visibility_isolation` policies are live on `sessions` and on every
-- table that references it. A session created today through the ordinary
-- `createSession` path by a managed human who holds a `workspace_memberships`
-- row comes out with `owner_organization_membership_id` and `owner_subject_id`
-- populated. There is therefore no undifferentiated ownerless backlog to drain
-- - there is a live derivation rule, and a precisely shaped set of rows it
-- cannot reach.
--
-- THE ACTUAL POPULATION (measured against the live trigger, not assumed)
-- ---------------------------------------------------------------------
-- 0225's derivation has exactly two branches, both INSERT-only and both taken
-- only when BOTH owner columns arrive NULL:
--
--   1. `parent_session_id IS NOT NULL` - inherit the parent's owner pair
--      verbatim from the same (account, workspace). The parent branch WINS
--      even when it resolves NULL, so a child of an ownerless parent is
--      ownerless no matter who created it.
--   2. otherwise, `created_by_kind = 'subject'` - the active
--      `organization_memberships` row for `created_by_subject_id`, but ONLY
--      when that subject also holds a `workspace_memberships` row in the
--      session's workspace.
--
-- Everything else silently keeps a NULL owner pair. Enumerated:
--
--   * `created_by_kind = 'service'` - the scheduler, site-auth maintenance,
--     delegated embedding-host service initiators, and the pre-0096
--     `unattributed-legacy` default. No human is named at all.
--   * `created_by_kind = 'subject'` with a non-`user:` subject - `api_key:*`
--     and `configured:*`. Both 0219 (`p_subject_id NOT LIKE 'user:%'` rejects
--     provisioning) and 0263 (invitations, role backfill, self-membership
--     listing) are gated to `user:%`, so these subjects can NEVER acquire an
--     organization anchor. These rows are permanently unrepairable, and API
--     keys keep minting new ones, so this is a GROWING population and not a
--     drainable backlog.
--   * a `user:` subject with no active organization membership.
--   * A MANAGED HUMAN IN THEIR OWN PERSONAL WORKSPACE. Slice B provisions the
--     personal workspace as a pointer on the membership row WITHOUT a durable
--     `workspace_memberships` row (docs/organization-tenancy.md). Branch 2's
--     `EXISTS (workspace_memberships ...)` guard therefore fails, and the
--     human's own personal-workspace sessions come out ownerless. This is the
--     one population where the organization's own durable lifecycle data
--     already names exactly one subject.
--
-- WHAT IS REPAIRABLE, AND WHAT IS NOT
-- -----------------------------------
-- REPAIRABLE (this migration's backfill, and nothing else):
--
--   A. Personal-workspace convergence. `sessions.workspace_id` is exactly the
--      `personal_workspace_id` of one ACTIVE `organization_memberships` row -
--      a 1:1 lifecycle anchor enforced by 0218's unique
--      `organization_memberships_personal_workspace_idx` on
--      (account_id, personal_workspace_id) - AND the session's
--      `created_by_subject_id` is that same membership's `subject_id`. Two
--      independent durable facts converge on one subject, and the workspace
--      anchor alone already identifies the owner; `created_by` is used only as
--      a veto, never as the evidence. This is the same convergence the
--      activated 0264 runtime exception uses to derive an owner-only
--      personal-workspace grant. When the two facts DISAGREE the row is
--      recorded `ambiguous_candidate_authority` and left alone.
--   B. Parent inheritance closure. An ownerless session whose same-workspace
--      parent now HAS an owner pair. This is branch 1 of the live trigger
--      replayed against durable parent data - not a new rule - and it is what
--      makes (A) leave the tree in exactly the state 0225 would have produced
--      had the root been attributable in the first place. It is also what
--      makes the driver resumable across a crash between the root write and
--      the closure.
--
-- NOT REPAIRABLE, deliberately:
--
--   * A managed human's session in an ORDINARY SHARED workspace that predates
--     0225 (or that was created while the human lacked a workspace-membership
--     row). Branch 2 could be replayed, but its `workspace_memberships`
--     predicate is evaluated against TODAY's grants, and phase D says in as
--     many words: never infer user authority from `created_by`, connection
--     attribution, a default workspace, a resource name, or CURRENT ACCESS. A
--     workspace membership granted after the session was created, or revoked
--     and re-granted since, would silently manufacture authority. Recorded
--     `no_deterministic_evidence`.
--   * Every `service`-created session (`legacy_shape_unrecognized`) and every
--     non-`user:` subject session (`external_lane_owns_row`). No amount of
--     later lifecycle work can attribute these; they are permanently
--     ownerless by construction.
--
-- WHY A SECURITY DEFINER SEAM AND NOT A MIGRATION-TIME `UPDATE` (OPE-276)
-- ----------------------------------------------------------------------
-- `sessions` is FORCE ROW LEVEL SECURITY and its ordinary policy is
-- workspace-scoped, which is false while the `opengeni.workspace_id` GUC is
-- unset - as it is during migration. FORCE RLS applies to the table owner, and
-- OpenGeni's documented deployment posture is a NON-superuser migration
-- principal without BYPASSRLS. A bare `UPDATE sessions ... WHERE ...` in a
-- migration body therefore matches ZERO rows and reports success on such a
-- deployment; it only appears to work in a harness that migrates as superuser.
-- Both routines below consequently run behind a transaction-scoped
-- capability-claiming policy, exactly like 0254, 0262, 0285, and the sibling
-- classification seam.
--
-- WRITE FENCES THIS SEAM HONOURS
-- ------------------------------
--   * 0225 block C: any UPDATE touching the owner pair needs a matching
--     `session_visibility_write_capabilities` row plus the
--     `opengeni.session_visibility_write_capability` GUC. The backfill mints
--     one for the duration of its own write and deletes it afterwards, on both
--     the success and the exception path.
--   * 0225 block B: the owner pair must move together, and the backfill never
--     touches `visibility` or `authority_epoch`. Every candidate row is
--     necessarily `workspace_shared` (0218's `sessions_private_owner_check`
--     forbids `user_private` without an owner), and
--     `session_visibility_isolation` short-circuits on `workspace_shared`, so
--     attributing an owner changes NO read for anybody. It is classification,
--     not a grant.
--   * 0214's commit gate fires only `BEFORE INSERT OR UPDATE OF updated_at,
--     activity_revision, activity_revision_pending_xid`. The backfill writes
--     only the two owner columns, so it neither needs nor forges a session
--     activity gate, and it does not bump `updated_at` - an operator
--     classification pass is not session activity.
--   * No `session_events` row is appended. The timeline is exact human/audit
--     truth for accepted payloads; the evidence for this run is the tenancy
--     backfill ledger receipt, which is what phase D actually asks for.
--
-- Receipt recording is guarded by `to_regprocedure` so this migration is
-- order-independent with respect to the ledger migration and reports
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
-- reuse of 0285's inventory capability or the sibling classification one: each
-- of those policies pins the literal `current_user` observed while its own
-- migration ran, and neither grants the UPDATE this seam needs on `sessions`.
CREATE TABLE opengeni_private.session_ownership_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  CONSTRAINT "session_ownership_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id"
  )
);
REVOKE ALL ON TABLE opengeni_private.session_ownership_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.session_ownership_capability_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.session_ownership_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.session_ownership_capability_active() FROM PUBLIC;

DO $session_ownership_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
BEGIN
  -- `sessions` needs FOR ALL because the backfill both reads and writes it;
  -- the WITH CHECK half is the same predicate, so the capability can never
  -- move a row out of the organization it was claimed for. The membership
  -- table stays read-only here - this seam never mints or mutates authority.
  EXECUTE format(
    'CREATE POLICY session_ownership_capability_write ON %I.sessions '
      || 'FOR ALL USING (current_user = %L AND '
      || 'opengeni_private.session_ownership_capability_active()) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.session_ownership_capability_active())',
    data_schema,
    migration_owner,
    migration_owner
  );
  EXECUTE format(
    'CREATE POLICY session_ownership_capability_read ON %I.organization_memberships '
      || 'FOR SELECT USING (current_user = %L AND '
      || 'opengeni_private.session_ownership_capability_active())',
    data_schema,
    migration_owner
  );
END
$session_ownership_capability_policies$;

-- Shared preconditions for both routines. The subject check is load-bearing:
-- `session_visibility_isolation` is RESTRICTIVE and short-circuits only when
-- no `opengeni.subject_id` GUC is set. Running this seam inside an actor scope
-- would silently hide another owner's `user_private` sessions and UNDERCOUNT
-- rather than fail, so it is refused outright.
CREATE OR REPLACE FUNCTION opengeni_private.assert_session_ownership_scope(
  p_organization_id uuid,
  p_run_key text
) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path FROM CURRENT
AS $$
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'session ownership classification requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'session ownership classification scope mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF nullif(pg_catalog.current_setting('opengeni.subject_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'session ownership classification must run outside an actor subject scope'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_key IS NOT NULL AND length(btrim(p_run_key)) = 0 THEN
    RAISE EXCEPTION 'session ownership run key must not be blank'
      USING ERRCODE = '22023';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION
  opengeni_private.assert_session_ownership_scope(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.tenancy_backfill_ledger_available()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path FROM CURRENT
AS $$
  SELECT to_regprocedure('open_tenancy_backfill_receipt(uuid, text, text)') IS NOT NULL
    AND to_regprocedure('record_tenancy_backfill_unresolved(uuid, uuid, text)') IS NOT NULL
    AND to_regprocedure(
      'complete_tenancy_backfill_receipt(uuid, bigint, bigint, text)'
    ) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION
  opengeni_private.tenancy_backfill_ledger_available() FROM PUBLIC;

-- One verdict per session in one organization.
--
-- `p_run_key` is the durability switch. Omitted (NULL) the call is a pure
-- read. Supplied, the same verdicts are additionally recorded through the
-- tenancy backfill ledger as one `sessions` receipt plus one append-only
-- unresolved row per session that could not be attributed - which is also why
-- the run key must be fresh per run: the ledger refuses to re-open a settled
-- receipt.
--
-- This routine NEVER writes a session row. `rewroteSessionRows` is reported
-- literally false so a reader cannot mistake it for the backfill.
CREATE OR REPLACE FUNCTION classify_organization_session_ownership(
  p_organization_id uuid,
  p_run_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $$
DECLARE
  claimed_rows integer := 0;
  claimed boolean := false;
  ledger_available boolean;
  summary jsonb;
  receipt_id uuid;
  unresolved_row record;
  -- One verdict per session row. Re-executed for the ledger loop rather than
  -- staged in a temp table: a temp relation outlives the call inside the
  -- caller's transaction and would collide on a second call in that same
  -- transaction. $1 is the organization id.
  classification_sql constant text := $classification$
    SELECT session_row.id AS session_id,
      CASE
        -- Already attributed. The two 0225/0218 FKs prove the membership id
        -- and the (account, subject) pair each EXIST, but nothing proves they
        -- are the SAME row, that it is live, or that the pair is internally
        -- consistent. Those are the only unenforced parts of an attributed
        -- session, so they are exactly what this branch proves.
        WHEN session_row.owner_organization_membership_id IS NOT NULL
          OR session_row.owner_subject_id IS NOT NULL THEN
          CASE
            WHEN session_row.owner_organization_membership_id IS NULL
              OR session_row.owner_subject_id IS NULL
              OR owner_membership.id IS NULL
              OR owner_membership.subject_id IS DISTINCT FROM session_row.owner_subject_id
              THEN 'conflicting_authority_rows'
            WHEN owner_membership.status <> 'active'
              OR owner_membership.revoked_at IS NOT NULL
              THEN 'missing_organization_membership'
            ELSE 'owner_attributed'
          END
        -- Ownerless from here down. Parent inheritance first, mirroring the
        -- live trigger's own branch order.
        WHEN owned_parent.id IS NOT NULL THEN 'repairable_parent_inheritance'
        WHEN session_row.created_by_kind <> 'subject' THEN 'legacy_shape_unrecognized'
        WHEN session_row.created_by_subject_id NOT LIKE 'user:%'
          THEN 'external_lane_owns_row'
        WHEN personal_anchor.id IS NOT NULL
          AND personal_anchor.subject_id = session_row.created_by_subject_id
          THEN 'repairable_personal_workspace'
        -- The workspace anchor names a DIFFERENT subject than the creator.
        -- Two durable facts disagree; refusing is the only correct answer.
        WHEN personal_anchor.id IS NOT NULL THEN 'ambiguous_candidate_authority'
        WHEN creator_membership.id IS NULL THEN 'missing_organization_membership'
        -- An active managed human in an ordinary shared workspace. Replaying
        -- the trigger's second branch here would evaluate TODAY's workspace
        -- grants against a historical session; phase D forbids exactly that.
        ELSE 'no_deterministic_evidence'
      END AS verdict
    FROM sessions session_row
    LEFT JOIN organization_memberships owner_membership
      ON owner_membership.id = session_row.owner_organization_membership_id
     AND owner_membership.account_id = session_row.account_id
    LEFT JOIN sessions owned_parent
      ON owned_parent.id = session_row.parent_session_id
     AND owned_parent.account_id = session_row.account_id
     AND owned_parent.workspace_id = session_row.workspace_id
     AND owned_parent.owner_organization_membership_id IS NOT NULL
     AND owned_parent.owner_subject_id IS NOT NULL
    LEFT JOIN organization_memberships personal_anchor
      ON personal_anchor.account_id = session_row.account_id
     AND personal_anchor.personal_workspace_id = session_row.workspace_id
     AND personal_anchor.status = 'active'
     AND personal_anchor.revoked_at IS NULL
    LEFT JOIN organization_memberships creator_membership
      ON creator_membership.account_id = session_row.account_id
     AND creator_membership.subject_id = session_row.created_by_subject_id
     AND creator_membership.status = 'active'
     AND creator_membership.revoked_at IS NULL
    WHERE session_row.account_id = $1
  $classification$;
  -- The three terminal/repairable verdicts. Everything else is an explicit
  -- refusal carrying a fixed ledger reason code and never a proposed owner.
  resolved_verdicts constant text :=
    '(''owner_attributed'', ''repairable_personal_workspace'',
      ''repairable_parent_inheritance'')';
BEGIN
  PERFORM opengeni_private.assert_session_ownership_scope(p_organization_id, p_run_key);
  ledger_available := p_run_key IS NOT NULL
    AND opengeni_private.tenancy_backfill_ledger_available();

  INSERT INTO opengeni_private.session_ownership_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;
  -- Only release what this call claimed, so a nested or enclosing holder of
  -- the same transaction-scoped capability is never revoked underneath.
  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  claimed := claimed_rows > 0;

  EXECUTE format($summary$
    WITH classified AS (%1$s)
    SELECT pg_catalog.jsonb_build_object(
      'total', count(*)::int,
      'ownerAttributed', count(*) FILTER (WHERE verdict = 'owner_attributed')::int,
      'repairablePersonalWorkspace', count(*) FILTER (
        WHERE verdict = 'repairable_personal_workspace'
      )::int,
      'repairableParentInheritance', count(*) FILTER (
        WHERE verdict = 'repairable_parent_inheritance'
      )::int,
      'unresolved', count(*) FILTER (WHERE verdict NOT IN %2$s)::int,
      'unresolvedByReason', coalesce((
        SELECT pg_catalog.jsonb_object_agg(reason, reason_count)
        FROM (
          SELECT verdict AS reason, count(*)::int AS reason_count
          FROM classified
          WHERE verdict NOT IN %2$s
          GROUP BY verdict
        ) grouped
      ), '{}'::jsonb),
      'unresolvedRows', coalesce((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sessionId', bounded.session_id, 'reasonCode', bounded.verdict
          ) ORDER BY bounded.session_id
        )
        FROM (
          SELECT session_id, verdict FROM classified
          WHERE verdict NOT IN %2$s
          ORDER BY session_id LIMIT 1000
        ) bounded
      ), '[]'::jsonb),
      'unresolvedTruncated', count(*) FILTER (WHERE verdict NOT IN %2$s) > 1000
    )
    FROM classified
  $summary$, classification_sql, resolved_verdicts)
  USING p_organization_id
  INTO summary;

  IF ledger_available THEN
    EXECUTE 'SELECT open_tenancy_backfill_receipt($1, $2, $3)'
      USING p_organization_id, 'sessions', p_run_key
      INTO receipt_id;
    FOR unresolved_row IN EXECUTE format(
      'SELECT session_id, verdict FROM (%1$s) classified '
        || 'WHERE verdict NOT IN %2$s ORDER BY session_id',
      classification_sql,
      resolved_verdicts
    ) USING p_organization_id LOOP
      EXECUTE 'SELECT record_tenancy_backfill_unresolved($1, $2, $3)'
        USING receipt_id, unresolved_row.session_id, unresolved_row.verdict;
    END LOOP;
    -- `classified_count` is the population this run PROVED already carries a
    -- live, internally consistent owner; `skipped_count` is the deterministically
    -- repairable population this classification run deliberately did NOT touch.
    -- Neither reflects a rewrite: this routine changes no session row.
    EXECUTE 'SELECT complete_tenancy_backfill_receipt($1, $2, $3, $4)'
      USING receipt_id,
        (summary ->> 'ownerAttributed')::bigint,
        (summary ->> 'repairablePersonalWorkspace')::bigint
          + (summary ->> 'repairableParentInheritance')::bigint,
        'completed';
    summary := summary || pg_catalog.jsonb_build_object('receiptId', receipt_id);
  END IF;

  IF claimed THEN
    DELETE FROM opengeni_private.session_ownership_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'runKey', p_run_key,
    'ledgerAvailable', ledger_available,
    'rewroteSessionRows', false,
    'sessions', summary
  );
EXCEPTION WHEN OTHERS THEN
  IF claimed THEN
    DELETE FROM opengeni_private.session_ownership_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION
  classify_organization_session_ownership(uuid, text) FROM PUBLIC;

-- One bounded, resumable, idempotent batch of the ONLY deterministic repair.
--
-- `p_dry_run` defaults TRUE: an operator who forgets the flag gets a report,
-- not a write. `p_limit` bounds the root candidates claimed with
-- `FOR UPDATE ... SKIP LOCKED`, so concurrent drivers never contend and a
-- killed driver leaves no half-claimed state. Re-running is a no-op once a row
-- is attributed, because an attributed row no longer matches either candidate
-- predicate.
CREATE OR REPLACE FUNCTION backfill_organization_session_ownership(
  p_organization_id uuid,
  p_limit integer DEFAULT 500,
  p_dry_run boolean DEFAULT true,
  p_run_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET statement_timeout = '5min'
AS $$
DECLARE
  claimed_rows integer := 0;
  claimed boolean := false;
  ledger_available boolean;
  visibility_capability_id uuid := pg_catalog.gen_random_uuid();
  previous_visibility_capability text;
  personal_candidates integer := 0;
  inherited_candidates integer := 0;
  personal_attributed integer := 0;
  inherited_attributed integer := 0;
  inheritance_passes integer := 0;
  closure_incomplete boolean := false;
  pass_rows integer;
  receipt_id uuid;
BEGIN
  PERFORM opengeni_private.assert_session_ownership_scope(p_organization_id, p_run_key);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'session ownership backfill limit must be between 1 and 5000'
      USING ERRCODE = '22023';
  END IF;
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'session ownership backfill requires an explicit dry-run flag'
      USING ERRCODE = '22004';
  END IF;
  ledger_available := p_run_key IS NOT NULL
    AND opengeni_private.tenancy_backfill_ledger_available();

  INSERT INTO opengeni_private.session_ownership_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  claimed := claimed_rows > 0;

  IF p_dry_run THEN
    -- No locking clause on a dry run: a report must not block a live writer.
    SELECT count(*)::integer INTO personal_candidates
    FROM sessions session_row
    JOIN organization_memberships anchor
      ON anchor.account_id = session_row.account_id
     AND anchor.personal_workspace_id = session_row.workspace_id
     AND anchor.status = 'active'
     AND anchor.revoked_at IS NULL
     AND anchor.subject_id = session_row.created_by_subject_id
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NULL
      AND session_row.owner_subject_id IS NULL
      AND session_row.created_by_kind = 'subject';

    -- Only the inheritance backlog that exists RIGHT NOW. It deliberately
    -- does not model the closure a real run's root writes would create, so a
    -- dry run never over-promises.
    SELECT count(*)::integer INTO inherited_candidates
    FROM sessions session_row
    JOIN sessions parent_row
      ON parent_row.id = session_row.parent_session_id
     AND parent_row.account_id = session_row.account_id
     AND parent_row.workspace_id = session_row.workspace_id
     AND parent_row.owner_organization_membership_id IS NOT NULL
     AND parent_row.owner_subject_id IS NOT NULL
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NULL
      AND session_row.owner_subject_id IS NULL;
  ELSE
    -- 0225 block C fences every owner-pair UPDATE behind this capability.
    previous_visibility_capability := pg_catalog.current_setting(
      'opengeni.session_visibility_write_capability', true
    );
    INSERT INTO session_visibility_write_capabilities (
      backend_pid, transaction_id, capability_id
    ) VALUES (
      pg_catalog.pg_backend_pid(),
      pg_catalog.pg_current_xact_id(),
      visibility_capability_id
    );
    PERFORM pg_catalog.set_config(
      'opengeni.session_visibility_write_capability',
      visibility_capability_id::text,
      true
    );

    WITH candidates AS (
      SELECT session_row.id AS session_id,
        anchor.id AS owner_membership_id,
        anchor.subject_id AS owner_subject_id
      FROM sessions session_row
      JOIN organization_memberships anchor
        ON anchor.account_id = session_row.account_id
       AND anchor.personal_workspace_id = session_row.workspace_id
       AND anchor.status = 'active'
       AND anchor.revoked_at IS NULL
       AND anchor.subject_id = session_row.created_by_subject_id
      WHERE session_row.account_id = p_organization_id
        AND session_row.owner_organization_membership_id IS NULL
        AND session_row.owner_subject_id IS NULL
        AND session_row.created_by_kind = 'subject'
      ORDER BY session_row.id
      LIMIT p_limit
      FOR UPDATE OF session_row SKIP LOCKED
    )
    UPDATE sessions target
    SET owner_organization_membership_id = candidates.owner_membership_id,
        owner_subject_id = candidates.owner_subject_id
    FROM candidates
    WHERE target.id = candidates.session_id
      AND target.account_id = p_organization_id;
    GET DIAGNOSTICS personal_attributed = ROW_COUNT;
    personal_candidates := personal_attributed;
    inherited_candidates := 0;

    -- Parent-inheritance closure: branch 1 of the live trigger replayed
    -- against durable parent data. Bounded by tree depth and terminated by a
    -- pass that changes nothing, so it is finite even on a malformed graph.
    LOOP
      inheritance_passes := inheritance_passes + 1;
      IF inheritance_passes > 64 THEN
        -- A tree deeper than 64 (or wider than p_limit at some level) is left
        -- for the next batch rather than run unbounded; `moreLikely` says so.
        closure_incomplete := true;
        EXIT;
      END IF;
      WITH candidates AS (
        SELECT session_row.id AS session_id,
          parent_row.owner_organization_membership_id AS owner_membership_id,
          parent_row.owner_subject_id AS owner_subject_id
        FROM sessions session_row
        JOIN sessions parent_row
          ON parent_row.id = session_row.parent_session_id
         AND parent_row.account_id = session_row.account_id
         AND parent_row.workspace_id = session_row.workspace_id
         AND parent_row.owner_organization_membership_id IS NOT NULL
         AND parent_row.owner_subject_id IS NOT NULL
        WHERE session_row.account_id = p_organization_id
          AND session_row.owner_organization_membership_id IS NULL
          AND session_row.owner_subject_id IS NULL
        ORDER BY session_row.id
        LIMIT p_limit
        FOR UPDATE OF session_row SKIP LOCKED
      )
      UPDATE sessions target
      SET owner_organization_membership_id = candidates.owner_membership_id,
          owner_subject_id = candidates.owner_subject_id
      FROM candidates
      WHERE target.id = candidates.session_id
        AND target.account_id = p_organization_id;
      GET DIAGNOSTICS pass_rows = ROW_COUNT;
      inherited_attributed := inherited_attributed + pass_rows;
      IF pass_rows >= p_limit THEN
        closure_incomplete := true;
      END IF;
      EXIT WHEN pass_rows = 0;
    END LOOP;

    DELETE FROM session_visibility_write_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id()
      AND capability_id = visibility_capability_id;
    PERFORM pg_catalog.set_config(
      'opengeni.session_visibility_write_capability',
      coalesce(previous_visibility_capability, ''),
      true
    );
  END IF;

  IF ledger_available THEN
    EXECUTE 'SELECT open_tenancy_backfill_receipt($1, $2, $3)'
      USING p_organization_id, 'sessions', p_run_key
      INTO receipt_id;
    -- `classified_count` is what this batch actually attributed (0 on a dry
    -- run); `skipped_count` is what it left for the next batch or for another
    -- concurrent driver. The unresolved obligations belong to the classifier,
    -- which is the routine that can name a reason for every row.
    EXECUTE 'SELECT complete_tenancy_backfill_receipt($1, $2, $3, $4)'
      USING receipt_id,
        (personal_attributed + inherited_attributed)::bigint,
        CASE WHEN p_dry_run
          THEN (personal_candidates + inherited_candidates)::bigint
          ELSE 0::bigint
        END,
        'completed';
  END IF;

  IF claimed THEN
    DELETE FROM opengeni_private.session_ownership_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'runKey', p_run_key,
    'ledgerAvailable', ledger_available,
    'dryRun', p_dry_run,
    'limit', p_limit,
    'receiptId', receipt_id,
    'personalWorkspaceCandidates', personal_candidates,
    'parentInheritanceCandidates', inherited_candidates,
    'personalWorkspaceAttributed', personal_attributed,
    'parentInheritanceAttributed', inherited_attributed,
    'attributed', personal_attributed + inherited_attributed,
    -- The driver keeps calling while this is true. It is deliberately derived
    -- from THIS batch's own result rather than from a fresh count, so a row
    -- another driver holds cannot spin this loop forever.
    'moreLikely',
      NOT p_dry_run AND (personal_attributed >= p_limit OR closure_incomplete)
  );
EXCEPTION WHEN OTHERS THEN
  IF NOT p_dry_run THEN
    DELETE FROM session_visibility_write_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_id = visibility_capability_id;
    PERFORM pg_catalog.set_config(
      'opengeni.session_visibility_write_capability',
      coalesce(previous_visibility_capability, ''),
      true
    );
  END IF;
  IF claimed THEN
    DELETE FROM opengeni_private.session_ownership_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  END IF;
  RAISE;
END
$$;

REVOKE ALL ON FUNCTION
  backfill_organization_session_ownership(uuid, integer, boolean, text) FROM PUBLIC;

DO $session_ownership_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      classify_organization_session_ownership(uuid, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      backfill_organization_session_ownership(uuid, integer, boolean, text) TO opengeni_app;
    -- The predicate must be independently EXECUTE-granted (0254's, 0285's, and
    -- the sibling classification seam's exact lesson): an ordinary opengeni_app
    -- read of ANY table this capability protects evaluates every PERMISSIVE
    -- policy on it, so without this grant an unrelated read of `sessions` or
    -- `organization_memberships` fails closed with a permission error instead
    -- of the policy branch simply evaluating false.
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_ownership_capability_active() TO opengeni_app;
  END IF;
END
$session_ownership_grants$;

COMMENT ON FUNCTION classify_organization_session_ownership(uuid, text) IS
  'OPE-204 phase D session ownership classification. Read-only over sessions: it proves every attributed session points at one live, internally consistent organization membership and names a fixed reason for every session it refuses to attribute, recording those refusals through the tenancy backfill ledger. It never writes a session row and never infers user authority from created_by, a default workspace, or current workspace access.';
COMMENT ON FUNCTION backfill_organization_session_ownership(uuid, integer, boolean, text) IS
  'OPE-204 phase D session ownership backfill. Attributes ONLY the two deterministic populations: a session in exactly one active membership''s personal workspace whose creator subject is that same membership, and the parent-inheritance closure that migration 0225''s own trigger would have produced. Bounded, resumable (FOR UPDATE SKIP LOCKED), idempotent, dry-run by default; it never changes visibility, authority epoch, or any read.';
