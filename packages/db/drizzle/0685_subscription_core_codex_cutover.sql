-- deployment-mode: maintenance
-- M3 PR 3: move every organization's Codex subscription state onto the shared
-- subscription core in one drained, one-way, parity-checked activation
-- (design docs/design/subscription-core-2026-10-07.md, 5.1.1 steps 1-8).
-- Stop every old API, control-worker and turn-worker first and pass the
-- complete old and new runtime-login list. Never restart a pre-0680 binary
-- afterward and never roll this back: recovery is fix-forward only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Step 1: drain check. Drain processes, not logical work: queued, waiting,
-- checkpointed and scheduled work is preserved and moved below.
DO $codex_cutover_drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF to_regclass('pg_temp.codex_cutover_stage_0672') IS NULL THEN
    RAISE EXCEPTION '0685 requires the codec-aware TypeScript migration runner' USING ERRCODE = '55000';
  END IF;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0685 requires explicit application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0685 received invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r.value = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0685 requires drained application sessions' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_drain$;

-- Bounded, content-free cutover evidence: per organization and metric, the
-- legacy and core counts the parity check compared, plus non-parity
-- dispositions. No credential, identity, label or subject is recorded.
CREATE TABLE opengeni_private.subscription_codex_cutover_report (
  account_id uuid,
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 96),
  legacy_count bigint NOT NULL CHECK (legacy_count >= 0),
  core_count bigint NOT NULL CHECK (core_count >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE opengeni_private.subscription_codex_cutover_report FROM PUBLIC;

-- A legacy organization account reached every shared workspace (no
-- allowlist) and/or every Personal workspace (allow_personal_workspaces),
-- including ones created later. Where `organization` scope cannot express that
-- exactly (it admits both), the connection is `workspaces` scope over today's
-- workspaces and this owner-only row keeps the reach: a workspace created later
-- is assigned with the organization source's own policy (fail closed: without
-- a row nothing is added). Runtime roles never read or write it.
CREATE TABLE opengeni_private.subscription_codex_auto_assignments (
  account_id uuid NOT NULL,
  connection_id uuid PRIMARY KEY,
  shared_workspaces boolean NOT NULL,
  personal_workspaces boolean NOT NULL,
  allocator_enabled boolean NOT NULL,
  allowed_model_ids text[],
  FOREIGN KEY (account_id, connection_id)
    REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  CHECK (shared_workspaces OR personal_workspaces)
);
CREATE INDEX subscription_codex_auto_assignments_account_idx
  ON opengeni_private.subscription_codex_auto_assignments(account_id);
REVOKE ALL ON TABLE opengeni_private.subscription_codex_auto_assignments FROM PUBLIC;

-- Step 2 window: only the migration owner opens these exact relations. The
-- application role stays policy-bound throughout; transaction rollback
-- restores FORCE and trigger modes even if a later step fails.
CREATE TEMP TABLE codex_cutover_relations_0672 AS
  SELECT c.oid, c.relforcerowsecurity, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname IN (
    'codex_subscription_credentials', 'codex_rotation_settings',
    'organization_codex_rotation_settings', 'workspace_codex_subscription_preferences',
    'codex_apps_settings', 'codex_capacity_waiters', 'codex_credential_leases',
    'codex_reset_redemption_attempts',
    'subscription_connections', 'subscription_connection_aliases',
    'subscription_connection_workspaces', 'subscription_connection_assignment_policies',
    'subscription_connection_people', 'subscription_connection_quota', 'subscription_settings',
    'subscription_person_preferences', 'subscription_provider_cutovers',
    'subscription_session_bindings', 'subscription_leases', 'subscription_capacity_waiters',
    'subscription_capacity_wake_outbox', 'subscription_apps_designations',
    'subscription_turn_failures', 'subscription_operation_leases',
    'organization_user_resource_authorities', 'organization_memberships', 'workspaces',
    'managed_accounts', 'sessions', 'session_turns', 'scheduled_tasks',
    'scheduled_task_revision_authorities', 'session_system_updates',
    'session_system_update_outbox', 'model_call_facts'
  );
CREATE TEMP TABLE codex_cutover_triggers_0672 AS
  SELECT t.tgrelid, t.tgname, t.tgenabled FROM pg_trigger t
  JOIN codex_cutover_relations_0672 r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal;
DO $codex_cutover_owner_window$
DECLARE item record;
BEGIN
  IF (SELECT count(*) FROM codex_cutover_relations_0672) <> 35 THEN
    RAISE EXCEPTION '0685 could not resolve every cutover relation' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM codex_cutover_relations_0672 r JOIN pg_class c ON c.oid = r.oid
    WHERE c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '0685 requires the schema owner' USING ERRCODE = '55000';
  END IF;
  FOR item IN SELECT * FROM codex_cutover_relations_0672 ORDER BY oid LOOP
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', item.oid::regclass);
  END LOOP;
  -- The owner-only, non-dispatching backfill seam: ordinary row guards (the
  -- binding/lease eligibility guards among them) are disabled only inside this
  -- transaction, so an unhealthy explicit pin and an in-flight lease can be
  -- carried over. The application role cannot alter triggers.
  FOR item IN SELECT * FROM codex_cutover_triggers_0672 WHERE tgenabled <> 'D' LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', item.tgrelid::regclass, item.tgname);
  END LOOP;
END $codex_cutover_owner_window$;
ALTER TABLE "codex_subscription_credentials" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "codex_rotation_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_codex_rotation_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_codex_subscription_preferences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "codex_apps_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "codex_capacity_waiters" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "codex_credential_leases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "codex_reset_redemption_attempts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connection_aliases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connection_workspaces" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connection_assignment_policies" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connection_people" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_connection_quota" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_person_preferences" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_provider_cutovers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_session_bindings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_leases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_capacity_waiters" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_capacity_wake_outbox" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_apps_designations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_turn_failures" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "subscription_operation_leases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_accounts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_turns" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_revision_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "model_call_facts" NO FORCE ROW LEVEL SECURITY;
DO $codex_cutover_owner_window_open$
BEGIN
  IF EXISTS (SELECT 1 FROM codex_cutover_relations_0672 r JOIN pg_class c ON c.oid = r.oid
    WHERE c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0685 owner window did not open' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_owner_window_open$;

-- A zero count is only trusted after an RLS-immune emptiness proof: VALIDATE
-- CONSTRAINT sees every row whatever the row-security posture.
CREATE FUNCTION pg_temp.codex_cutover_assert_empty(relation regclass) RETURNS void
LANGUAGE plpgsql AS $codex_cutover_assert_empty$
BEGIN
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT codex_cutover_empty_probe CHECK (false) NOT VALID', relation);
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT codex_cutover_empty_probe', relation);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '0685 counted zero rows in a non-empty relation' USING ERRCODE = '55000';
  END;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT codex_cutover_empty_probe', relation);
END $codex_cutover_assert_empty$;

-- Source inventory by organization and legacy source (step 1/7), taken under
-- the owner window before any mutation.
CREATE TEMP TABLE codex_cutover_inventory (
  account_id uuid NOT NULL,
  metric text NOT NULL,
  legacy_count bigint NOT NULL,
  PRIMARY KEY (account_id, metric)
);
INSERT INTO codex_cutover_inventory
  SELECT account_id, 'credentials_' || authority_scope, count(*)
  FROM codex_subscription_credentials GROUP BY account_id, authority_scope
  UNION ALL SELECT account_id, 'workspace_rotation_rows', count(*)
  FROM codex_rotation_settings GROUP BY account_id
  UNION ALL SELECT account_id, 'organization_rotation_rows', count(*)
  FROM organization_codex_rotation_settings GROUP BY account_id
  UNION ALL SELECT account_id, 'source_preferences', count(*)
  FROM workspace_codex_subscription_preferences GROUP BY account_id
  UNION ALL SELECT account_id, 'apps_designations', count(*)
  FROM codex_apps_settings WHERE credential_id IS NOT NULL GROUP BY account_id
  UNION ALL SELECT account_id, 'live_leases', count(*)
  FROM codex_credential_leases WHERE leased_until > now() GROUP BY account_id
  UNION ALL SELECT account_id, 'waiting_waiters', count(*)
  FROM codex_capacity_waiters WHERE status = 'waiting' GROUP BY account_id
  UNION ALL SELECT account_id, 'session_manual_pins', count(*)
  FROM sessions WHERE codex_pinned_credential_id IS NOT NULL AND codex_pin_source = 'manual'
  GROUP BY account_id
  UNION ALL SELECT account_id, 'session_pointers', count(*)
  FROM sessions WHERE codex_pinned_credential_id IS NOT NULL OR codex_last_credential_id IS NOT NULL
  GROUP BY account_id
  UNION ALL SELECT account_id, 'live_turns', count(*)
  FROM session_turns
  WHERE status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
  GROUP BY account_id
  -- The single-use reset-credit ledger of every legacy credential, and the
  -- attempts still open (processing, or provider_started with an ambiguous
  -- provider outcome) whose recovery must stay reachable.
  UNION ALL SELECT attempt.account_id, 'reset_redemption_attempts', count(*)
  FROM codex_reset_redemption_attempts attempt
  WHERE EXISTS (SELECT 1 FROM codex_subscription_credentials credential
    WHERE credential.account_id = attempt.account_id AND credential.id = attempt.credential_id)
  GROUP BY attempt.account_id
  UNION ALL SELECT attempt.account_id, 'reset_redemption_open', count(*)
  FROM codex_reset_redemption_attempts attempt
  WHERE attempt.status <> 'completed'
    AND EXISTS (SELECT 1 FROM codex_subscription_credentials credential
      WHERE credential.account_id = attempt.account_id AND credential.id = attempt.credential_id)
  GROUP BY attempt.account_id;

DO $codex_cutover_preflight$
DECLARE
  relation text;
  present boolean;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'codex_subscription_credentials', 'codex_rotation_settings',
    'organization_codex_rotation_settings', 'workspace_codex_subscription_preferences',
    'codex_apps_settings', 'codex_capacity_waiters', 'codex_credential_leases', 'session_turns',
    'managed_accounts', 'codex_reset_redemption_attempts'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', relation) INTO present;
    IF NOT present THEN
      PERFORM pg_temp.codex_cutover_assert_empty(relation::regclass);
    END IF;
  END LOOP;
  -- The core is dormant before this migration: its Codex rows must be empty,
  -- so nothing written here can collide with or hide behind earlier state.
  IF EXISTS (SELECT 1 FROM subscription_connections WHERE provider = 'codex')
    OR EXISTS (SELECT 1 FROM subscription_session_bindings WHERE provider = 'codex')
    OR EXISTS (SELECT 1 FROM subscription_leases WHERE provider = 'codex')
    OR EXISTS (SELECT 1 FROM subscription_capacity_waiters WHERE provider = 'codex')
    OR EXISTS (SELECT 1 FROM subscription_operation_leases WHERE provider = 'codex')
  THEN
    RAISE EXCEPTION '0685 refuses pre-existing core Codex state' USING ERRCODE = '55000';
  END IF;
  -- Ambiguous session ownership on live work aborts activation (step 6).
  IF EXISTS (
    SELECT 1 FROM sessions session
    WHERE EXISTS (SELECT 1 FROM session_turns turn
        WHERE turn.account_id = session.account_id AND turn.workspace_id = session.workspace_id
          AND turn.session_id = session.id
          AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'))
      AND ((session.owner_subject_id IS NULL) <> (session.owner_organization_membership_id IS NULL)
        OR (session.owner_organization_membership_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = session.account_id
            AND membership.id = session.owner_organization_membership_id
            AND membership.subject_id = session.owner_subject_id)))
  ) THEN
    RAISE EXCEPTION '0685 refused ambiguous session ownership on live work (session_owner_ambiguous)'
      USING ERRCODE = '55000';
  END IF;
END $codex_cutover_preflight$;

-- opengeni:codex-subscription-core-cutover-v1

DO $codex_cutover_codec_receipt$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.codex_cutover_stage_0672 WHERE completed) THEN
    RAISE EXCEPTION '0685 codec stage did not complete' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_codec_receipt$;

-- Step 4: settings from the effective legacy Codex source (design 5.2).
-- Every organization receives an organization settings row so its effective
-- settings resolve; an existing row only gains the Codex rotation entry.
CREATE TEMP TABLE codex_cutover_shared_map AS
  SELECT * FROM pg_temp.codex_cutover_connection_map WHERE ownership = 'shared';

INSERT INTO subscription_settings (
  account_id, workspace_id, codex_primary_connection_id, rotation, providers,
  cross_provider_failover, fallback_order, personal_connections_allowed,
  personal_fallback_allowed, updated_by_subject_id, updated_at
)
SELECT account.id, NULL,
  CASE WHEN rotation.rotation_enabled IS DISTINCT FROM true THEN primary_map.connection_id END,
  jsonb_build_object('codex', jsonb_build_object('mode',
    CASE WHEN rotation.id IS NULL OR rotation.rotation_enabled THEN 'spread' ELSE 'primary_first' END)),
  '{}'::jsonb, false, '{}'::jsonb, true, false, 'service:subscription-core-cutover', now()
FROM managed_accounts account
LEFT JOIN organization_codex_rotation_settings rotation ON rotation.account_id = account.id
LEFT JOIN codex_cutover_shared_map primary_map
  ON primary_map.account_id = account.id AND primary_map.legacy_id = rotation.active_credential_id
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  rotation = coalesce(subscription_settings.rotation, '{}'::jsonb) || EXCLUDED.rotation,
  codex_primary_connection_id = EXCLUDED.codex_primary_connection_id,
  version = subscription_settings.version + 1,
  updated_by_subject_id = EXCLUDED.updated_by_subject_id,
  updated_at = EXCLUDED.updated_at;

CREATE TEMP TABLE codex_cutover_workspace_settings AS
  SELECT workspace.account_id, workspace.id AS workspace_id,
    coalesce(preference.mode, 'automatic') AS mode,
    EXISTS (SELECT 1 FROM organization_memberships owner
      WHERE owner.account_id = workspace.account_id
        AND owner.personal_workspace_id = workspace.id) AS personal,
    EXISTS (SELECT 1 FROM codex_cutover_shared_map local
      WHERE local.account_id = workspace.account_id AND local.legacy_scope = 'workspace'
        AND local.legacy_workspace_id = workspace.id) AS has_local_shared,
    EXISTS (SELECT 1 FROM pg_temp.codex_cutover_connection_map moved
      WHERE moved.account_id = workspace.account_id AND moved.ownership = 'personal'
        AND moved.legacy_workspace_id = workspace.id) AS has_moved_personal,
    rotation.id AS rotation_id, rotation.rotation_enabled,
    primary_map.connection_id AS primary_connection_id
  FROM workspaces workspace
  LEFT JOIN workspace_codex_subscription_preferences preference
    ON preference.account_id = workspace.account_id AND preference.workspace_id = workspace.id
  LEFT JOIN codex_rotation_settings rotation
    ON rotation.account_id = workspace.account_id AND rotation.workspace_id = workspace.id
  LEFT JOIN codex_cutover_shared_map primary_map
    ON primary_map.account_id = workspace.account_id
   AND primary_map.legacy_id = rotation.active_credential_id
   AND primary_map.legacy_scope = 'workspace'
   AND primary_map.legacy_workspace_id = workspace.id;

-- Workspace overrides: the provider source for explicit modes, the local
-- rotation only where the workspace pool is in effect (explicit workspace, or
-- automatic with local accounts, where a local primary keeps taking new work),
-- and personal fallback for a Personal workspace whose accounts became its
-- owner's personal connections. Personal-pool rotation rows have no
-- equivalent and are dropped (recorded below).
INSERT INTO subscription_settings (
  account_id, workspace_id, codex_primary_connection_id, rotation, providers,
  personal_fallback_allowed, updated_by_subject_id, updated_at
)
SELECT ws.account_id, ws.workspace_id,
  CASE WHEN local_rotation AND ws.rotation_id IS NOT NULL AND NOT ws.rotation_enabled
    THEN ws.primary_connection_id END,
  CASE WHEN local_rotation THEN jsonb_build_object('codex', jsonb_build_object('mode',
    CASE WHEN ws.rotation_id IS NULL OR ws.rotation_enabled THEN 'spread' ELSE 'primary_first' END)) END,
  CASE ws.mode
    WHEN 'workspace' THEN '{"codex":{"inferenceSource":"workspace","useOrganizationAccounts":false}}'::jsonb
    WHEN 'organization' THEN '{"codex":{"inferenceSource":"organization","useOrganizationAccounts":true}}'::jsonb
    WHEN 'disabled' THEN '{"codex":{"enabled":false}}'::jsonb
  END,
  CASE WHEN ws.personal AND ws.has_moved_personal AND NOT coalesce(
      'personalFallbackAllowed' = ANY(org.locked_settings) AND NOT org.personal_fallback_allowed, false)
    THEN true END,
  'service:subscription-core-cutover', now()
FROM (
  SELECT settings.*,
    (settings.has_local_shared AND settings.mode IN ('automatic', 'workspace')) AS local_rotation
  FROM codex_cutover_workspace_settings settings
) ws
JOIN subscription_settings org ON org.account_id = ws.account_id AND org.workspace_id IS NULL
WHERE ws.mode <> 'automatic' OR ws.local_rotation OR (ws.personal AND ws.has_moved_personal)
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  codex_primary_connection_id = EXCLUDED.codex_primary_connection_id,
  rotation = CASE WHEN EXCLUDED.rotation IS NULL THEN subscription_settings.rotation
    ELSE coalesce(subscription_settings.rotation, '{}'::jsonb) || EXCLUDED.rotation END,
  providers = CASE WHEN EXCLUDED.providers IS NULL THEN subscription_settings.providers
    ELSE coalesce(subscription_settings.providers, '{}'::jsonb) || EXCLUDED.providers END,
  personal_fallback_allowed = coalesce(EXCLUDED.personal_fallback_allowed,
    subscription_settings.personal_fallback_allowed),
  version = subscription_settings.version + 1,
  updated_by_subject_id = EXCLUDED.updated_by_subject_id,
  updated_at = EXCLUDED.updated_at;

-- The owner of a migrated personal connection opts in to personal fallback,
-- so a Personal-workspace account keeps serving its owner after shared
-- capacity (design 5.2, D-18).
INSERT INTO subscription_person_preferences (account_id, organization_membership_id, personal_fallback_opt_in, updated_at)
SELECT DISTINCT account_id, owner_membership_id, true, now()
FROM pg_temp.codex_cutover_connection_map WHERE ownership = 'personal'
ON CONFLICT (account_id, organization_membership_id) DO UPDATE SET
  personal_fallback_opt_in = true,
  version = subscription_person_preferences.version + 1,
  updated_at = EXCLUDED.updated_at;

-- Step 5: one chat binding per session. A manual pin is explicit (and
-- survives an unhealthy or newly ineligible target: it waits, D-24);
-- otherwise the latest effective account is automatic. Ownerless sessions get
-- no binding (no exact accepted turn), and a personal target is kept only for
-- its owner's own private or Personal-workspace session.
CREATE TEMP TABLE codex_cutover_bindings AS
  SELECT session.account_id, session.workspace_id, session.id AS session_id,
    (session.codex_pinned_credential_id IS NOT NULL AND session.codex_pin_source = 'manual') AS explicit,
    map.connection_id, map.ownership, map.owner_membership_id,
    session.owner_subject_id, session.owner_organization_membership_id, session.visibility,
    session.model
  FROM sessions session
  JOIN pg_temp.codex_cutover_connection_map map ON map.account_id = session.account_id
   AND map.legacy_id = CASE
     WHEN session.codex_pinned_credential_id IS NOT NULL AND session.codex_pin_source = 'manual'
       THEN session.codex_pinned_credential_id
     ELSE coalesce(session.codex_last_credential_id, session.codex_pinned_credential_id) END
  WHERE session.codex_pinned_credential_id IS NOT NULL OR session.codex_last_credential_id IS NOT NULL;
ALTER TABLE codex_cutover_bindings ADD COLUMN eligible boolean;
UPDATE codex_cutover_bindings binding SET eligible = binding.owner_subject_id IS NOT NULL
  AND (binding.ownership = 'shared' OR (
    binding.owner_membership_id = binding.owner_organization_membership_id
    AND EXISTS (SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = binding.account_id
        AND membership.id = binding.owner_membership_id
        AND membership.subject_id = binding.owner_subject_id
        AND (binding.visibility = 'user_private'
          OR membership.personal_workspace_id = binding.workspace_id))));

INSERT INTO subscription_session_bindings (
  account_id, workspace_id, session_id, provider, connection_id, model_id, choice,
  only_this_model, last_model_call_at, last_switch_reason, version
)
SELECT binding.account_id, binding.workspace_id, binding.session_id, 'codex', binding.connection_id,
  left(coalesce((
    SELECT nullif(btrim(turn.metadata->'turnExecutionPolicyV1'->>'productModelId'), '')
    FROM session_turns turn
    WHERE turn.account_id = binding.account_id AND turn.workspace_id = binding.workspace_id
      AND turn.session_id = binding.session_id
      AND turn.metadata->'turnExecutionPolicyV1'->>'providerId' = 'codex-subscription'
    ORDER BY turn.position DESC LIMIT 1
  ), nullif(btrim(binding.model), ''), 'codex'), 512),
  CASE WHEN binding.explicit THEN 'explicit' ELSE 'automatic' END, false,
  (SELECT max(fact.occurred_at) FROM model_call_facts fact
    WHERE fact.account_id = binding.account_id AND fact.workspace_id = binding.workspace_id
      AND fact.session_id = binding.session_id),
  CASE WHEN binding.explicit THEN 'explicit_choice' END, 1
FROM codex_cutover_bindings binding WHERE binding.eligible;

-- Step 6a: live leases keep their turn, holder, generation and expiry. A
-- transferred lease only lets the already-authorized in-flight call finish;
-- every later call re-places through the core.
CREATE TEMP TABLE codex_cutover_live_leases AS
SELECT lease.account_id, lease.workspace_id, turn.session_id, lease.turn_id,
  map.connection_id, lease.holder_id, lease.generation, lease.leased_until
FROM codex_credential_leases lease
JOIN session_turns turn ON turn.workspace_id = lease.workspace_id AND turn.id = lease.turn_id
JOIN pg_temp.codex_cutover_connection_map map
  ON map.account_id = lease.account_id AND map.legacy_id = lease.credential_id
WHERE lease.leased_until > now();
INSERT INTO subscription_leases (
  account_id, workspace_id, session_id, turn_id, connection_id, provider, holder_id,
  generation, leased_until
)
SELECT account_id, workspace_id, session_id, turn_id, connection_id, 'codex', holder_id,
  generation, leased_until
FROM codex_cutover_live_leases;
DELETE FROM codex_credential_leases lease
USING subscription_leases moved
WHERE moved.workspace_id = lease.workspace_id AND moved.turn_id = lease.turn_id
  AND moved.provider = 'codex';

-- Step 6b: the authoritative waiter per blocked session, keeping the legacy
-- waiter UUID so a workflow history that recorded it reconciles against the
-- same id, with its generation, wake revisions, schedule, reset state, retry
-- state, blocked-turn generation, goal fence and accepted-update link. The
-- legacy row is superseded so no fallback lookup can revive it.
INSERT INTO subscription_capacity_waiters (
  account_id, workspace_id, session_id, turn_id, waiter_id, provider, wait_reason,
  policy_hash, reset_kind, refresh_attempt, resumed_update_id, earliest_reset_at, generation,
  wake_revision, observed_wake_revision, next_check_at, blocked_turn_generation, goal_id,
  goal_version, last_wake_reason, updated_at
)
SELECT waiter.account_id, waiter.workspace_id, waiter.session_id, waiter.blocked_turn_id, waiter.id,
  'codex',
  CASE WHEN EXISTS (SELECT 1 FROM subscription_session_bindings binding
      WHERE binding.workspace_id = waiter.workspace_id AND binding.session_id = waiter.session_id
        AND binding.choice = 'explicit')
    THEN 'pinned_account_unavailable' ELSE 'no_eligible_capacity' END,
  waiter.policy_hash, waiter.reset_kind, waiter.refresh_attempt, waiter.resumed_update_id,
  waiter.earliest_reset_at, waiter.generation, waiter.wake_revision, waiter.observed_wake_revision,
  waiter.next_check_at, waiter.blocked_turn_generation, waiter.goal_id, waiter.goal_version,
  waiter.last_wake_reason, waiter.updated_at
FROM codex_capacity_waiters waiter
WHERE waiter.status = 'waiting';
UPDATE codex_capacity_waiters waiter SET status = 'superseded', updated_at = now()
FROM subscription_capacity_waiters moved
WHERE waiter.status = 'waiting' AND moved.account_id = waiter.account_id
  AND moved.waiter_id = waiter.id;

-- Apps designations (design 6.3): the shared connection behind the legacy
-- designation, with the legacy version. A designation of a connection that
-- became personal cannot be represented (designations are shared-only).
INSERT INTO subscription_apps_designations (
  account_id, workspace_id, connection_id, version, updated_by_subject_id, updated_at
)
SELECT apps.account_id, apps.workspace_id, map.connection_id, apps.version,
  'service:subscription-core-cutover', coalesce(apps.designated_at, apps.updated_at)
FROM codex_apps_settings apps
JOIN codex_cutover_shared_map map
  ON map.account_id = apps.account_id AND map.legacy_id = apps.credential_id
WHERE apps.credential_id IS NOT NULL;

-- Reset credits (design 6.3): the single-use redemption ledger follows the
-- canonical connection. The core claim takes its per-credit advisory lock and
-- looks up the per-credit fence and the ambiguous-outcome recovery by
-- (workspace, connection id, credit), so an attempt filed under a legacy id
-- that became an alias would be invisible to it and the same provider credit
-- could be consumed twice. Every attempt is re-keyed to its canonical id; its
-- id, upstream idempotency key, status, outcome, claim and retry state are
-- kept. Two credit-holding attempts (open, or a consumed outcome) that would
-- meet on one (workspace, connection, credit) cannot be merged safely and
-- abort the cutover. Attempts of credentials disconnected earlier keep their
-- id (no FK, history outlives disconnect) and are recorded as a disposition.
DO $codex_cutover_reset_ledger$
BEGIN
  IF EXISTS (
    SELECT 1 FROM codex_reset_redemption_attempts attempt
    JOIN pg_temp.codex_cutover_connection_map map
      ON map.account_id = attempt.account_id AND map.legacy_id = attempt.credential_id
    WHERE attempt.status <> 'completed' OR attempt.outcome IN ('reset', 'alreadyRedeemed')
    GROUP BY attempt.workspace_id, map.connection_id, attempt.credit_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0685 refused ambiguous reset-credit redemption history (reset_redemption_credit_ambiguous)'
      USING ERRCODE = '55000';
  END IF;
END $codex_cutover_reset_ledger$;
UPDATE codex_reset_redemption_attempts attempt SET credential_id = map.connection_id
FROM pg_temp.codex_cutover_connection_map map
WHERE map.account_id = attempt.account_id AND map.legacy_id = attempt.credential_id
  AND attempt.credential_id <> map.connection_id;

-- Step 6c: v2 accepted authority. Only the Codex entry is written; Claude and
-- SuperGrok v1 snapshots are untouched. A personal entry is backfilled only
-- for exact owner-caused work: the stored human is the session owner, the
-- owner membership is active, and the work runs in the owner's private
-- session or Personal workspace. A v1 `user` snapshot keeps its frozen
-- generation only when the canonical personal connection carries that same,
-- still-active generation; a Personal-workspace account that became a personal
-- connection lends its one current generation. Nothing else (non-human
-- acceptance, other members, revoked or ambiguous authority) gains personal
-- authority: it runs on currently eligible shared capacity only.
CREATE FUNCTION pg_temp.codex_cutover_authority_v2(
  p_account_id uuid, p_workspace_id uuid, p_human text, p_owner_subject text,
  p_owner_membership uuid, p_private boolean, p_v1 jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $codex_cutover_authority_v2$
DECLARE
  empty_v2 constant jsonb := '{"version":2,"personal":[]}'::jsonb;
  membership_ok boolean := false;
  personal_workspace boolean := false;
  generation bigint;
  generations bigint[];
BEGIN
  IF p_human IS NULL OR p_owner_subject IS NULL OR p_owner_membership IS NULL
    OR p_human IS DISTINCT FROM p_owner_subject THEN
    RETURN empty_v2;
  END IF;
  SELECT membership.subject_id = p_human AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND (p_private OR membership.personal_workspace_id = p_workspace_id),
    membership.personal_workspace_id IS NOT DISTINCT FROM p_workspace_id
    INTO membership_ok, personal_workspace
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_owner_membership;
  IF NOT coalesce(membership_ok, false) THEN RETURN empty_v2; END IF;
  IF p_v1->>'scope' = 'user' THEN
    generation := (p_v1->>'authorityGeneration')::bigint;
    IF NOT EXISTS (SELECT 1 FROM pg_temp.codex_cutover_connection_map map
      WHERE map.account_id = p_account_id AND map.ownership = 'personal'
        AND map.owner_membership_id = p_owner_membership AND map.authority_active
        AND map.user_generation_carried AND map.authority_generation = generation) THEN
      RETURN empty_v2;
    END IF;
  ELSE
    IF NOT coalesce(personal_workspace, false) OR NOT EXISTS (
      SELECT 1 FROM pg_temp.codex_cutover_connection_map map
      WHERE map.account_id = p_account_id AND map.ownership = 'personal'
        AND map.owner_membership_id = p_owner_membership AND map.authority_active
        AND map.legacy_scope = 'workspace' AND map.legacy_workspace_id = p_workspace_id
    ) THEN
      RETURN empty_v2;
    END IF;
    SELECT coalesce(array_agg(DISTINCT connection.authority_generation), '{}') INTO generations
    FROM subscription_connections connection
    JOIN organization_user_resource_authorities authority
      ON authority.id = connection.authority_id AND authority.account_id = connection.account_id
     AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
    WHERE connection.account_id = p_account_id AND connection.provider = 'codex'
      AND connection.ownership = 'personal'
      AND connection.owner_organization_membership_id = p_owner_membership
      AND connection.status IN ('active', 'error')
      AND authority.generation = connection.authority_generation
      AND authority.status = 'active' AND authority.revoked_at IS NULL;
    IF cardinality(generations) <> 1 THEN RETURN empty_v2; END IF;
    generation := generations[1];
  END IF;
  RETURN jsonb_build_object('version', 2, 'personal', jsonb_build_array(jsonb_build_object(
    'provider', 'codex', 'ownerMembershipId', p_owner_membership::text,
    'authorityGeneration', generation)));
END $codex_cutover_authority_v2$;

UPDATE session_turns turn SET subscription_authority = pg_temp.codex_cutover_authority_v2(
    turn.account_id, turn.workspace_id, turn.initiating_human_subject_id, session.owner_subject_id,
    session.owner_organization_membership_id, session.visibility = 'user_private',
    turn.codex_provider_account_authority_snapshot)
FROM sessions session
WHERE session.account_id = turn.account_id AND session.workspace_id = turn.workspace_id
  AND session.id = turn.session_id AND turn.subscription_authority IS NULL
  AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity');

-- The v2 slots on scheduled tasks, revision authorities, internal updates and
-- outbox rows come from the rolling Codex writers migration (M3 PR 3b), whose
-- writers fill them for work accepted after this cutover; here only the table
-- owner backfills live work accepted before it.
-- A schedule's owner is its captured human; a schedule cannot know a future
-- session's visibility, so only a Personal-workspace schedule carries personal
-- authority. Only the live task and its current authority revision change.
UPDATE scheduled_tasks task SET subscription_authority = pg_temp.codex_cutover_authority_v2(
    task.account_id, task.workspace_id, task.owner_subject_id, task.owner_subject_id,
    (SELECT membership.id FROM organization_memberships membership
      WHERE membership.account_id = task.account_id AND membership.subject_id = task.owner_subject_id
      ORDER BY membership.created_at DESC LIMIT 1),
    false, task.codex_provider_account_authority_snapshot)
WHERE task.deleted_at IS NULL AND task.subscription_authority IS NULL;
UPDATE scheduled_task_revision_authorities revision SET subscription_authority =
  pg_temp.codex_cutover_authority_v2(
    revision.account_id, revision.workspace_id, revision.subject_id, revision.subject_id,
    revision.organization_membership_id, false, task.codex_provider_account_authority_snapshot)
FROM scheduled_tasks task
WHERE task.account_id = revision.account_id AND task.id = revision.task_id
  AND task.deleted_at IS NULL AND revision.task_authority_revision = task.authority_revision
  AND revision.subscription_authority IS NULL;

-- Internal updates and outbox rows carry no stored human, so no personal
-- authority can be tied to them: pending rows freeze the empty v2 value.
UPDATE session_system_updates SET subscription_authority = '{"version":2,"personal":[]}'::jsonb
WHERE state = 'pending' AND subscription_authority IS NULL;
UPDATE session_system_update_outbox SET subscription_authority = '{"version":2,"personal":[]}'::jsonb
WHERE status = 'pending' AND subscription_authority IS NULL;

-- Activation (step 8 sequence): every organization's Codex cutover row is
-- enabled in the same transaction as the data move, so no organization can
-- reach a legacy Codex table after commit. Organizations created later are
-- seeded enabled by the trigger below; the switch can only be turned off
-- (fail-closed maintenance), never removed by the application role.
INSERT INTO subscription_provider_cutovers (account_id, provider, enabled, updated_by_subject_id, updated_at)
SELECT account.id, 'codex', true, 'service:subscription-core-cutover', now() FROM managed_accounts account
ON CONFLICT (account_id, provider) DO UPDATE SET enabled = true,
  version = subscription_provider_cutovers.version + 1,
  updated_by_subject_id = EXCLUDED.updated_by_subject_id, updated_at = EXCLUDED.updated_at;

-- One secret copy: the legacy ciphertext is retired after readability parity
-- proved the core copy decrypts to the same credential.
DO $codex_cutover_readability$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.codex_cutover_readability
      WHERE source_digest <> target_digest)
    OR (SELECT count(*) FROM pg_temp.codex_cutover_readability)
      <> (SELECT count(DISTINCT connection_id) FROM pg_temp.codex_cutover_connection_map) THEN
    RAISE EXCEPTION '0685 parity mismatch (secret_readability)' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_readability$;
UPDATE codex_subscription_credentials SET credential_encrypted = ''
WHERE credential_encrypted <> '';

-- Step 7: explicit parity by organization and legacy source, with the owner
-- queries above (FORCE is still off). Any mismatch rolls the whole cutover
-- back; the report keeps only counts.
CREATE TEMP TABLE codex_cutover_parity (
  account_id uuid,
  metric text NOT NULL,
  legacy_count bigint NOT NULL,
  core_count bigint NOT NULL
);
-- Independently reconstruct each local pool's enabled model union. A paused
-- unrestricted duplicate is not an unrestricted enabled policy. If every
-- source is paused its model union remains paused.
CREATE TEMP TABLE codex_cutover_expected_workspace_policies ON COMMIT DROP AS
WITH members AS (
  SELECT credential.account_id, map.connection_id, credential.workspace_id,
    credential.allocator_enabled, credential.allowed_model_ids
  FROM codex_subscription_credentials credential
  JOIN codex_cutover_shared_map map ON map.legacy_id = credential.id
  WHERE credential.authority_scope = 'workspace'
), groups AS (
  SELECT account_id, connection_id, workspace_id, bool_or(allocator_enabled) AS enabled
  FROM members GROUP BY account_id, connection_id, workspace_id
), selected AS (
  SELECT member.*, groups.enabled FROM members member JOIN groups
    USING (account_id, connection_id, workspace_id)
  WHERE member.allocator_enabled OR NOT groups.enabled
)
SELECT groups.*, CASE WHEN EXISTS (
    SELECT 1 FROM selected member WHERE member.connection_id = groups.connection_id
      AND member.workspace_id = groups.workspace_id AND member.allowed_model_ids IS NULL
  ) THEN NULL::text[] ELSE ARRAY(
    SELECT DISTINCT model FROM selected member CROSS JOIN LATERAL unnest(member.allowed_model_ids) model
    WHERE member.connection_id = groups.connection_id AND member.workspace_id = groups.workspace_id
    ORDER BY model
  ) END AS allowed_model_ids
FROM groups;
INSERT INTO codex_cutover_parity
  -- Credentials, connections, aliases, identities.
  SELECT inventory.account_id, 'credentials', sum(inventory.legacy_count)::bigint,
    (SELECT count(*) FROM pg_temp.codex_cutover_connection_map map
      WHERE map.account_id = inventory.account_id)
  FROM codex_cutover_inventory inventory WHERE inventory.metric LIKE 'credentials_%'
  GROUP BY inventory.account_id
  UNION ALL SELECT map.account_id, 'connections', count(DISTINCT map.connection_id),
    (SELECT count(*) FROM subscription_connections connection
      WHERE connection.account_id = map.account_id AND connection.provider = 'codex')
  FROM pg_temp.codex_cutover_connection_map map GROUP BY map.account_id
  UNION ALL SELECT map.account_id, 'aliases', count(*) FILTER (WHERE map.legacy_id <> map.connection_id),
    (SELECT count(*) FROM subscription_connection_aliases alias
      WHERE alias.account_id = map.account_id AND alias.provider = 'codex'
        AND EXISTS (SELECT 1 FROM pg_temp.codex_cutover_connection_map target
          WHERE target.legacy_id = alias.alias_connection_id AND target.connection_id = alias.connection_id))
  FROM pg_temp.codex_cutover_connection_map map GROUP BY map.account_id
  -- Each distinct (upstream account, signed-in person, owner) became exactly
  -- one connection that carries that identity; different people's logins of
  -- one ChatGPT workspace stay different connections.
  UNION ALL SELECT credential.account_id, 'unique_upstream_identities',
    count(DISTINCT (credential.chatgpt_account_id, connection.provider_subject_id,
      map.owner_membership_id)),
    count(DISTINCT connection.id) FILTER (
      WHERE connection.provider_account_id = credential.chatgpt_account_id
        AND connection.owner_organization_membership_id IS NOT DISTINCT FROM map.owner_membership_id)
  FROM codex_subscription_credentials credential
  JOIN pg_temp.codex_cutover_connection_map map ON map.legacy_id = credential.id
  JOIN subscription_connections connection ON connection.id = map.connection_id
  WHERE credential.chatgpt_account_id IS NOT NULL GROUP BY credential.account_id
  -- Local workspace rows: each keeps its exact workspace-pool policy and manager.
  UNION ALL SELECT expected.account_id, 'workspace_pool_policies', count(*),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM subscription_connection_assignment_policies policy
      WHERE policy.account_id = expected.account_id AND policy.connection_id = expected.connection_id
        AND policy.workspace_id = expected.workspace_id AND policy.inference_pool = 'workspace'
        AND policy.allocator_enabled = expected.enabled
        AND policy.allowed_model_ids IS NOT DISTINCT FROM expected.allowed_model_ids
        AND policy.managed_by_workspace_id = expected.workspace_id))
  FROM codex_cutover_expected_workspace_policies expected GROUP BY expected.account_id
  UNION ALL SELECT expected.account_id, 'extra_credit_consent', count(*),
    count(*) FILTER (WHERE connection.extra_credits_enabled = expected.enabled
      AND connection.extra_credits_version = expected.version)
  FROM (
    SELECT credential.account_id, map.connection_id, bool_and(credential.extra_credits_enabled) AS enabled,
      greatest(1, max(credential.extra_credits_version)) AS version
    FROM codex_subscription_credentials credential
    JOIN pg_temp.codex_cutover_connection_map map ON map.legacy_id = credential.id
    GROUP BY credential.account_id, map.connection_id
  ) expected JOIN subscription_connections connection ON connection.id = expected.connection_id
  GROUP BY expected.account_id
  -- Organization rows: every workspace they admit today keeps their exact
  -- policy, through organization scope or an enumerated assignment.
  UNION ALL SELECT credential.account_id, 'organization_pool_admissions', count(*),
    count(*) FILTER (WHERE (
      connection.scope_kind = 'organization'
        AND connection.allocator_enabled = credential.allocator_enabled
        AND connection.allowed_model_ids IS NOT DISTINCT FROM credential.allowed_model_ids
        AND (NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
            WHERE policy.connection_id = connection.id AND policy.workspace_id = workspace.id)
          OR EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
            WHERE policy.connection_id = connection.id AND policy.workspace_id = workspace.id
              AND policy.inference_pool = 'organization'
              AND policy.allocator_enabled = credential.allocator_enabled
              AND policy.allowed_model_ids IS NOT DISTINCT FROM credential.allowed_model_ids))
    ) OR (
      connection.scope_kind = 'workspaces'
        AND EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.connection_id = connection.id AND assignment.workspace_id = workspace.id)
        AND EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
          WHERE policy.connection_id = connection.id AND policy.workspace_id = workspace.id
            AND policy.inference_pool = 'organization'
            AND policy.allocator_enabled = credential.allocator_enabled
            AND policy.allowed_model_ids IS NOT DISTINCT FROM credential.allowed_model_ids
            AND policy.managed_by_workspace_id IS NULL)))
  FROM codex_subscription_credentials credential
  JOIN codex_cutover_shared_map map ON map.legacy_id = credential.id
  JOIN subscription_connections connection ON connection.id = map.connection_id
  JOIN workspaces workspace ON workspace.account_id = credential.account_id
  WHERE credential.authority_scope = 'organization'
    AND CASE WHEN EXISTS (SELECT 1 FROM organization_memberships owner
        WHERE owner.account_id = workspace.account_id AND owner.personal_workspace_id = workspace.id)
      THEN credential.allow_personal_workspaces
      ELSE credential.allowed_workspace_ids IS NULL OR workspace.id = ANY(credential.allowed_workspace_ids)
    END
  GROUP BY credential.account_id
  -- Personal connections: owner, resource authority and transferred generation.
  UNION ALL SELECT map.account_id, 'personal_connections', count(DISTINCT map.connection_id),
    (SELECT count(*) FROM subscription_connections connection
      JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
       AND authority.resource_id = connection.id AND authority.resource_kind = 'subscription_connection'
       AND authority.organization_membership_id = connection.owner_organization_membership_id
       AND authority.generation = connection.authority_generation
      WHERE connection.account_id = map.account_id AND connection.provider = 'codex'
        AND connection.ownership = 'personal' AND connection.scope_kind = 'people')
  FROM pg_temp.codex_cutover_connection_map map WHERE map.ownership = 'personal'
  GROUP BY map.account_id
  -- Effective source per workspace with a legacy source row.
  UNION ALL SELECT preference.account_id, 'source_modes', count(*),
    count(*) FILTER (WHERE preference.mode = CASE
      WHEN settings.providers->'codex'->>'enabled' = 'false' THEN 'disabled'
      WHEN settings.providers->'codex'->>'inferenceSource' = 'workspace' THEN 'workspace'
      WHEN settings.providers->'codex'->>'inferenceSource' = 'organization' THEN 'organization'
      ELSE 'automatic' END)
  FROM workspace_codex_subscription_preferences preference
  LEFT JOIN subscription_settings settings ON settings.account_id = preference.account_id
   AND settings.workspace_id = preference.workspace_id
  GROUP BY preference.account_id
  -- Rotation for the pool in effect: organization row to organization settings.
  UNION ALL SELECT rotation.account_id, 'organization_rotation', count(*),
    count(*) FILTER (WHERE (settings.rotation->'codex'->>'mode') =
        CASE WHEN rotation.rotation_enabled THEN 'spread' ELSE 'primary_first' END
      AND (rotation.rotation_enabled OR settings.codex_primary_connection_id IS NOT DISTINCT FROM (
        SELECT map.connection_id FROM codex_cutover_shared_map map
        WHERE map.legacy_id = rotation.active_credential_id)))
  FROM organization_codex_rotation_settings rotation
  JOIN subscription_settings settings ON settings.account_id = rotation.account_id
   AND settings.workspace_id IS NULL
  GROUP BY rotation.account_id
  -- Workspace rotation where the workspace pool is in effect.
  UNION ALL SELECT ws.account_id, 'workspace_rotation', count(*),
    count(*) FILTER (WHERE (settings.rotation->'codex'->>'mode') =
        CASE WHEN ws.rotation_enabled THEN 'spread' ELSE 'primary_first' END
      AND (ws.rotation_enabled
        OR settings.codex_primary_connection_id IS NOT DISTINCT FROM ws.primary_connection_id))
  FROM codex_cutover_workspace_settings ws
  LEFT JOIN subscription_settings settings ON settings.account_id = ws.account_id
   AND settings.workspace_id = ws.workspace_id
  WHERE ws.rotation_id IS NOT NULL AND ws.has_local_shared AND ws.mode IN ('automatic', 'workspace')
  GROUP BY ws.account_id
  -- Session bindings: every eligible pointer, explicit pins exact.
  UNION ALL SELECT inventory.account_id, 'session_pointers', inventory.legacy_count,
    (SELECT count(*) FROM codex_cutover_bindings binding
      WHERE binding.account_id = inventory.account_id)
  FROM codex_cutover_inventory inventory WHERE inventory.metric = 'session_pointers'
  UNION ALL SELECT binding.account_id, 'session_bindings', count(*) FILTER (WHERE binding.eligible),
    count(*) FILTER (WHERE binding.eligible AND EXISTS (
      SELECT 1 FROM subscription_session_bindings core
      WHERE core.workspace_id = binding.workspace_id AND core.session_id = binding.session_id
        AND core.provider = 'codex' AND core.connection_id = binding.connection_id
        AND core.choice = CASE WHEN binding.explicit THEN 'explicit' ELSE 'automatic' END))
  FROM codex_cutover_bindings binding GROUP BY binding.account_id
  -- Apps designations of shared connections.
  UNION ALL SELECT apps.account_id, 'apps_designations', count(*),
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscription_apps_designations core
      WHERE core.workspace_id = apps.workspace_id AND core.connection_id = map.connection_id
        AND core.version = apps.version))
  FROM codex_apps_settings apps
  JOIN codex_cutover_shared_map map ON map.account_id = apps.account_id
   AND map.legacy_id = apps.credential_id
  GROUP BY apps.account_id
  -- Leases: same turn, holder, generation, expiry and canonical connection.
  UNION ALL SELECT inventory.account_id, 'live_leases', inventory.legacy_count,
    (SELECT count(*) FROM subscription_leases lease
      JOIN codex_cutover_live_leases legacy ON legacy.account_id = lease.account_id
       AND legacy.workspace_id = lease.workspace_id AND legacy.session_id = lease.session_id
       AND legacy.turn_id = lease.turn_id AND legacy.connection_id = lease.connection_id
       AND legacy.holder_id = lease.holder_id AND legacy.generation = lease.generation
       AND legacy.leased_until = lease.leased_until
      WHERE lease.account_id = inventory.account_id AND lease.provider = 'codex')
  FROM codex_cutover_inventory inventory WHERE inventory.metric = 'live_leases'
  -- Waiters: ids, generations and revisions preserved.
  UNION ALL SELECT inventory.account_id, 'waiting_waiters', inventory.legacy_count,
    (SELECT count(*) FROM subscription_capacity_waiters core
      JOIN codex_capacity_waiters legacy ON legacy.id = core.waiter_id
       AND legacy.account_id = core.account_id AND legacy.session_id = core.session_id
       AND legacy.blocked_turn_id = core.turn_id AND legacy.generation = core.generation
       AND legacy.wake_revision = core.wake_revision
       AND legacy.observed_wake_revision = core.observed_wake_revision
       AND legacy.next_check_at IS NOT DISTINCT FROM core.next_check_at
       AND legacy.blocked_turn_generation IS NOT DISTINCT FROM core.blocked_turn_generation
       AND legacy.resumed_update_id IS NOT DISTINCT FROM core.resumed_update_id
      WHERE core.account_id = inventory.account_id AND core.provider = 'codex')
  FROM codex_cutover_inventory inventory WHERE inventory.metric = 'waiting_waiters'
  -- v2 coverage on every live turn.
  UNION ALL SELECT inventory.account_id, 'live_turn_authority', inventory.legacy_count,
    (SELECT count(*) FROM session_turns turn
      WHERE turn.account_id = inventory.account_id AND turn.subscription_authority IS NOT NULL
        AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'))
  FROM codex_cutover_inventory inventory WHERE inventory.metric = 'live_turns'
  -- Reset-credit ledger: every attempt and every open attempt on a canonical id.
  UNION ALL SELECT inventory.account_id, inventory.metric, inventory.legacy_count,
    (SELECT count(*) FROM codex_reset_redemption_attempts attempt
      JOIN subscription_connections connection ON connection.account_id = attempt.account_id
       AND connection.id = attempt.credential_id AND connection.provider = 'codex'
      WHERE attempt.account_id = inventory.account_id
        AND (inventory.metric = 'reset_redemption_attempts' OR attempt.status <> 'completed'))
  FROM codex_cutover_inventory inventory
  WHERE inventory.metric IN ('reset_redemption_attempts', 'reset_redemption_open')
  -- Activation coverage.
  UNION ALL SELECT NULL, 'codex_cutover_rows', (SELECT count(*) FROM managed_accounts),
    (SELECT count(*) FROM subscription_provider_cutovers
      WHERE provider = 'codex' AND enabled);

INSERT INTO opengeni_private.subscription_codex_cutover_report (account_id, metric, legacy_count, core_count)
SELECT account_id, metric, legacy_count, core_count FROM codex_cutover_parity
UNION ALL
SELECT account_id, 'disposition:' || disposition, count, count FROM pg_temp.codex_cutover_dispositions
UNION ALL
SELECT binding.account_id, 'disposition:binding_not_eligible', count(*), count(*)
FROM codex_cutover_bindings binding WHERE NOT binding.eligible GROUP BY binding.account_id
UNION ALL
SELECT apps.account_id, 'disposition:apps_designation_personal_dropped', count(*), count(*)
FROM codex_apps_settings apps
JOIN pg_temp.codex_cutover_connection_map map ON map.account_id = apps.account_id
 AND map.legacy_id = apps.credential_id AND map.ownership = 'personal'
GROUP BY apps.account_id
UNION ALL
SELECT ws.account_id, 'disposition:personal_rotation_dropped', count(*), count(*)
FROM codex_cutover_workspace_settings ws WHERE ws.personal AND ws.rotation_id IS NOT NULL
GROUP BY ws.account_id
UNION ALL
SELECT ws.account_id, 'disposition:personal_fallback_locked_off', count(*), count(*)
FROM codex_cutover_workspace_settings ws
JOIN subscription_settings org ON org.account_id = ws.account_id AND org.workspace_id IS NULL
WHERE ws.personal AND ws.has_moved_personal
  AND 'personalFallbackAllowed' = ANY(org.locked_settings) AND NOT org.personal_fallback_allowed
GROUP BY ws.account_id
UNION ALL
SELECT lease.account_id, 'disposition:expired_leases_dropped', count(*), count(*)
FROM codex_credential_leases lease
WHERE lease.leased_until <= now() GROUP BY lease.account_id
UNION ALL
SELECT attempt.account_id, 'disposition:reset_redemption_history_unmapped', count(*), count(*)
FROM codex_reset_redemption_attempts attempt
WHERE NOT EXISTS (SELECT 1 FROM pg_temp.codex_cutover_connection_map map
  WHERE map.account_id = attempt.account_id AND map.connection_id = attempt.credential_id)
GROUP BY attempt.account_id;

-- Expired legacy leases were recorded above as dropped and live ones moved:
-- none stays behind for a fallback reader to find.
DELETE FROM codex_credential_leases;

DO $codex_cutover_parity_check$
DECLARE mismatches text;
BEGIN
  SELECT string_agg(DISTINCT metric, ', ' ORDER BY metric) INTO mismatches
  FROM codex_cutover_parity WHERE legacy_count <> core_count;
  IF mismatches IS NOT NULL THEN
    RAISE EXCEPTION '0685 parity mismatch (%)', mismatches USING ERRCODE = '55000';
  END IF;
  -- Zero-row success is invalid: a source with rows must yield a non-empty
  -- target, and every counted source was counted inside the owner window.
  IF EXISTS (SELECT 1 FROM codex_cutover_inventory WHERE legacy_count > 0
      AND metric LIKE 'credentials_%')
    AND NOT EXISTS (SELECT 1 FROM subscription_connections WHERE provider = 'codex') THEN
    RAISE EXCEPTION '0685 parity mismatch (zero_row_backfill)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM session_turns
      WHERE status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
        AND subscription_authority IS NULL) THEN
    RAISE EXCEPTION '0685 parity mismatch (live_turn_authority)' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_parity_check$;

-- Validate deferred foreign keys before restoring trigger modes.
SET CONSTRAINTS ALL IMMEDIATE;

DO $codex_cutover_restore$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM codex_cutover_triggers_0672 LOOP
    EXECUTE format('ALTER TABLE %s %s TRIGGER %I', item.tgrelid::regclass,
      CASE item.tgenabled WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA'
        WHEN 'D' THEN 'DISABLE' ELSE 'ENABLE' END, item.tgname);
  END LOOP;
  FOR item IN SELECT * FROM codex_cutover_relations_0672 WHERE relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', item.oid::regclass);
  END LOOP;
  IF EXISTS (SELECT 1 FROM codex_cutover_relations_0672 r JOIN pg_class c ON c.oid = r.oid
    WHERE r.relforcerowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0685 could not restore FORCE row security' USING ERRCODE = '55000';
  END IF;
END $codex_cutover_restore$;

-- Every live turn now carries a v2 value; the 0667 check can be validated.
ALTER TABLE session_turns VALIDATE CONSTRAINT session_turns_subscription_authority_v2_chk;

-- The switch is an operator containment control, not a route back: an
-- organization administrator may still turn a Codex cutover off (fail-closed
-- maintenance) or on again, but can no longer delete the Codex row, so no
-- organization can return to the "no row" legacy disposition. Organizations
-- created later are seeded enabled by an owner trigger. The administrator
-- policy is otherwise unchanged (Claude and SuperGrok rows keep M2 behaviour).
DROP POLICY subscription_provider_cutovers_admin ON subscription_provider_cutovers;
CREATE POLICY subscription_provider_cutovers_admin ON subscription_provider_cutovers
  FOR SELECT USING (opengeni_private.subscription_organization_admin(account_id));
CREATE POLICY subscription_provider_cutovers_admin_insert ON subscription_provider_cutovers
  FOR INSERT WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
CREATE POLICY subscription_provider_cutovers_admin_update ON subscription_provider_cutovers
  FOR UPDATE USING (opengeni_private.subscription_organization_admin(account_id))
  WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
CREATE POLICY subscription_provider_cutovers_admin_delete ON subscription_provider_cutovers
  FOR DELETE USING (provider <> 'codex' AND opengeni_private.subscription_organization_admin(account_id));
DO $codex_cutover_seed_policy$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE POLICY subscription_provider_cutovers_codex_seed ON %1$I.subscription_provider_cutovers
    FOR INSERT WITH CHECK (
      provider = 'codex' AND enabled
      AND CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_provider_cutovers'::regclass))
      AND current_setting('opengeni.subscription_codex_cutover_seed', true) = account_id::text
    )
  $ddl$, data_schema);
  -- Every organization has an organization settings row (step 4), so its
  -- effective settings resolve for placement and the compatibility
  -- projections; one created later gets the same defaults with its row.
  EXECUTE format($ddl$
    CREATE POLICY subscription_settings_codex_seed ON %1$I.subscription_settings
    FOR INSERT WITH CHECK (
      workspace_id IS NULL
      AND CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_settings'::regclass))
      AND current_setting('opengeni.subscription_codex_cutover_seed', true) = account_id::text
    )
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.seed_subscription_codex_cutover()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE previous text := current_setting('opengeni.subscription_codex_cutover_seed', true);
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_cutover_seed', NEW.id::text, true);
      -- A brand-new organization has no row yet. (ON CONFLICT would need a
      -- SELECT policy for the arbiter and is deliberately not used.)
      INSERT INTO subscription_provider_cutovers (account_id, provider, enabled, updated_by_subject_id)
      VALUES (NEW.id, 'codex', true, 'service:subscription-core-cutover');
      INSERT INTO subscription_settings (
        account_id, workspace_id, rotation, providers, cross_provider_failover, fallback_order,
        personal_connections_allowed, personal_fallback_allowed, updated_by_subject_id
      ) VALUES (
        NEW.id, NULL, '{"codex":{"mode":"spread"}}'::jsonb, '{}'::jsonb, false, '{}'::jsonb,
        true, false, 'service:subscription-core-cutover'
      );
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_cutover_seed', coalesce(previous, ''), true);
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END $codex_cutover_seed_policy$;
REVOKE ALL ON FUNCTION opengeni_private.seed_subscription_codex_cutover() FROM PUBLIC;
CREATE TRIGGER managed_accounts_subscription_codex_cutover_seed
  AFTER INSERT ON managed_accounts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.seed_subscription_codex_cutover();

-- A Codex cutover row stays the Codex row of its organization: moving it to
-- another provider or organization would turn it into a deletable row and
-- bring back the "no row" legacy disposition.
CREATE FUNCTION opengeni_private.keep_subscription_codex_cutover_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $codex_cutover_identity$
BEGIN
  IF (OLD.provider = 'codex' OR NEW.provider = 'codex')
    AND (NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account_id IS DISTINCT FROM OLD.account_id)
  THEN
    RAISE EXCEPTION 'a Codex cutover row keeps its organization and provider'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $codex_cutover_identity$;
REVOKE ALL ON FUNCTION opengeni_private.keep_subscription_codex_cutover_identity() FROM PUBLIC;
CREATE TRIGGER subscription_provider_cutovers_codex_identity
  BEFORE UPDATE ON subscription_provider_cutovers
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.keep_subscription_codex_cutover_identity();

-- Auto-assignment of workspaces created after the cutover (see the table
-- above). A new workspace is first assigned as a shared workspace; when it
-- becomes someone's Personal workspace the assignment follows the Personal
-- rule instead. Owner-only writes, admitted by owner-only policies for the one
-- organization the trigger is working on.
DO $codex_auto_assign$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE POLICY subscription_connection_workspaces_codex_auto_assign
    ON %1$I.subscription_connection_workspaces FOR ALL
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_codex_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_codex_auto_assign', true) = account_id::text)
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE POLICY subscription_connection_assignment_policies_codex_auto_assign
    ON %1$I.subscription_connection_assignment_policies FOR ALL
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_codex_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_codex_auto_assign', true) = account_id::text)
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.apply_subscription_codex_auto_assignments(
      p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE previous text := current_setting('opengeni.subscription_codex_auto_assign', true);
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_codex_auto_assignments auto
          WHERE auto.account_id = p_account_id) THEN
        RETURN;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign', p_account_id::text, true);
      -- Remove what the other rule added for this workspace (only the
      -- organization pool this mechanism writes; a workspace's own local copy
      -- is never touched).
      DELETE FROM subscription_connection_assignment_policies policy
      USING opengeni_private.subscription_codex_auto_assignments auto
      WHERE auto.account_id = p_account_id AND policy.account_id = p_account_id
        AND policy.connection_id = auto.connection_id AND policy.workspace_id = p_workspace_id
        AND policy.inference_pool = 'organization'
        AND NOT (CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END);
      DELETE FROM subscription_connection_workspaces assignment
      USING opengeni_private.subscription_codex_auto_assignments auto
      WHERE auto.account_id = p_account_id AND assignment.account_id = p_account_id
        AND assignment.connection_id = auto.connection_id AND assignment.workspace_id = p_workspace_id
        AND NOT (CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END)
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
          WHERE policy.account_id = p_account_id AND policy.connection_id = auto.connection_id
            AND policy.workspace_id = p_workspace_id);
      INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
      SELECT p_account_id, auto.connection_id, p_workspace_id
      FROM opengeni_private.subscription_codex_auto_assignments auto
      WHERE auto.account_id = p_account_id
        AND CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.account_id = p_account_id AND assignment.connection_id = auto.connection_id
            AND assignment.workspace_id = p_workspace_id);
      INSERT INTO subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
        allowed_model_ids, excluded_models, managed_by_workspace_id
      )
      SELECT p_account_id, auto.connection_id, p_workspace_id, 'organization',
        auto.allocator_enabled, auto.allowed_model_ids, '{}'::text[], NULL
      FROM opengeni_private.subscription_codex_auto_assignments auto
      WHERE auto.account_id = p_account_id
        AND CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
          WHERE policy.account_id = p_account_id AND policy.connection_id = auto.connection_id
            AND policy.workspace_id = p_workspace_id AND policy.inference_pool = 'organization');
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign', coalesce(previous, ''), true);
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.auto_assign_subscription_codex_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      PERFORM opengeni_private.apply_subscription_codex_auto_assignments(NEW.account_id, NEW.id, false);
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.auto_assign_subscription_codex_personal_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NEW.personal_workspace_id IS NOT NULL AND (TG_OP = 'INSERT'
          OR NEW.personal_workspace_id IS DISTINCT FROM OLD.personal_workspace_id) THEN
        PERFORM opengeni_private.apply_subscription_codex_auto_assignments(
          NEW.account_id, NEW.personal_workspace_id, true);
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END $codex_auto_assign$;
REVOKE ALL ON FUNCTION opengeni_private.apply_subscription_codex_auto_assignments(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.auto_assign_subscription_codex_workspace() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.auto_assign_subscription_codex_personal_workspace() FROM PUBLIC;
CREATE TRIGGER workspaces_subscription_codex_auto_assign
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.auto_assign_subscription_codex_workspace();
CREATE TRIGGER organization_memberships_subscription_codex_auto_assign
  AFTER INSERT OR UPDATE OF personal_workspace_id ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.auto_assign_subscription_codex_personal_workspace();

-- Plan-change history on the core (the legacy plan_previous_type and
-- plan_changed_at columns): any writer that changes a Codex connection's plan,
-- such as a refresh whose id_token carries a new plan, records the previous
-- plan and when it changed in adapter-owned provider state.
CREATE FUNCTION opengeni_private.record_subscription_codex_plan_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $codex_plan_change$
BEGIN
  IF NEW.provider = 'codex' AND OLD.plan_type IS NOT NULL AND NEW.plan_type IS NOT NULL
    AND lower(NEW.plan_type) IS DISTINCT FROM lower(OLD.plan_type)
  THEN
    NEW.provider_state := NEW.provider_state || jsonb_build_object(
      'planPreviousType', OLD.plan_type,
      'planChangedAt', to_jsonb(clock_timestamp()),
      'planCheckedAt', to_jsonb(clock_timestamp()));
  END IF;
  RETURN NEW;
END $codex_plan_change$;
REVOKE ALL ON FUNCTION opengeni_private.record_subscription_codex_plan_change() FROM PUBLIC;
CREATE TRIGGER subscription_connections_codex_plan_change_trg
  BEFORE UPDATE OF plan_type ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.record_subscription_codex_plan_change();

-- Value-free startup interlock: exists only after the move, parity and
-- restoration committed together.
CREATE FUNCTION opengeni_private.subscription_codex_cutover_v1_active() RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_cutover_v1_active() FROM PUBLIC;
