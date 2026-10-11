-- deployment-mode: maintenance
-- M4 X3: move every organization's SuperGrok subscription state onto the
-- shared subscription core in one drained, one-way, parity-checked activation
-- (design docs/design/subscription-core-2026-10-07.md, 5.3 "Data mapping",
-- "Accepted authority across the cutover", "Personal authority generations",
-- "Cutover protocol"; the SuperGrok counterpart of 0689).
-- Stop every old API, control-worker and turn-worker first and pass the
-- complete old and new runtime-login list. Never restart a binary without
-- this migration in its ledger afterward and never roll this back: recovery
-- is fix-forward only.
--
-- Provider scope: this migration reads and writes only SuperGrok legacy rows
-- (`xai_*`, the `xai_subscription` resource kind, the `xai_*` v1 columns and
-- SuperGrok video and image ledgers) and only `xai` keys in shared relations
-- (connections, settings keys, primaries, switch rows, compatibility records,
-- report rows). It never reads or writes Claude's moved data, so the Claude
-- cutover can run after it in the same maintenance window or in a later one.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Drain check. Drain processes, not logical work: queued, waiting,
-- checkpointed and scheduled work is preserved and moved below.
DO $xai_cutover_drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF to_regclass('pg_temp.xai_cutover_stage_0716') IS NULL THEN
    RAISE EXCEPTION '0716 requires the codec-aware TypeScript migration runner' USING ERRCODE = '55000';
  END IF;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0716 requires explicit application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0716 received invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r.value = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0716 requires drained application sessions' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('opengeni_private.subscription_provider_cutover_committed(text)') IS NULL
    OR to_regclass('opengeni_private.subscription_authority_compat') IS NULL
    OR to_regclass('opengeni_private.subscription_core_auto_assignments') IS NULL THEN
    RAISE EXCEPTION '0716 requires the generic precursor, provider-keyed reach and compatibility migrations'
      USING ERRCODE = '55000';
  END IF;
  IF opengeni_private.subscription_provider_cutover_committed('xai') THEN
    RAISE EXCEPTION '0716 found an existing SuperGrok cutover receipt' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_drain$;

-- Owner window: only the migration owner opens these exact relations. The
-- application role stays policy-bound throughout; transaction rollback
-- restores FORCE and trigger modes even if a later step fails.
CREATE TEMP TABLE xai_cutover_relations AS
  SELECT c.oid, c.relforcerowsecurity, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname = current_schema() AND c.relname IN (
    'xai_subscription_credentials', 'xai_rotation_settings', 'xai_credential_leases',
    'xai_session_account_pins', 'xai_capacity_waiters',
    'subscription_connections', 'subscription_connection_aliases',
    'subscription_connection_workspaces', 'subscription_connection_assignment_policies',
    'subscription_connection_people', 'subscription_connection_quota', 'subscription_settings',
    'subscription_person_preferences', 'subscription_provider_cutovers',
    'subscription_session_bindings', 'subscription_leases', 'subscription_capacity_waiters',
    'subscription_capacity_wake_outbox', 'subscription_operation_leases',
    'organization_user_resource_authorities', 'organization_memberships', 'workspaces',
    'managed_accounts', 'sessions', 'session_turns', 'session_events', 'composer_drafts',
    'scheduled_tasks', 'scheduled_task_revision_authorities', 'scheduled_task_runs',
    'session_system_updates', 'session_system_update_outbox', 'model_call_facts',
    'video_generation_operations', 'image_generation_operations'
  )) OR (n.nspname = 'opengeni_private' AND c.relname IN (
    'subscription_authority_compat', 'subscription_codex_auto_assignments'
  ));
CREATE TEMP TABLE xai_cutover_triggers AS
  SELECT t.tgrelid, t.tgname, t.tgenabled FROM pg_trigger t
  JOIN xai_cutover_relations r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal;
DO $xai_cutover_owner_window$
DECLARE item record;
BEGIN
  IF (SELECT count(*) FROM xai_cutover_relations) <> 37 THEN
    RAISE EXCEPTION '0716 could not resolve every cutover relation' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM xai_cutover_relations r JOIN pg_class c ON c.oid = r.oid
    WHERE c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '0716 requires the schema owner' USING ERRCODE = '55000';
  END IF;
  FOR item IN SELECT * FROM xai_cutover_relations ORDER BY oid LOOP
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', item.oid::regclass);
  END LOOP;
  -- The owner-only, non-dispatching backfill seam: ordinary row guards (the
  -- binding/lease eligibility guards and the deferred compatibility checks
  -- among them) are disabled only inside this transaction, so an unhealthy
  -- explicit pin and an in-flight lease can be carried over. The application
  -- role cannot alter triggers. This migration inserts no carrier row.
  FOR item IN SELECT * FROM xai_cutover_triggers WHERE tgenabled <> 'D' LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', item.tgrelid::regclass, item.tgname);
  END LOOP;
  FOR item IN SELECT * FROM xai_cutover_relations WHERE relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', item.oid::regclass);
  END LOOP;
  IF EXISTS (SELECT 1 FROM xai_cutover_relations r JOIN pg_class c ON c.oid = r.oid
    WHERE c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0716 owner window did not open' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_owner_window$;

-- A zero count is only trusted after an RLS-immune emptiness proof: VALIDATE
-- CONSTRAINT sees every row whatever the row-security posture.
CREATE FUNCTION pg_temp.xai_cutover_assert_empty(relation regclass) RETURNS void
LANGUAGE plpgsql AS $xai_cutover_assert_empty$
BEGIN
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT xai_cutover_empty_probe CHECK (false) NOT VALID', relation);
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT xai_cutover_empty_probe', relation);
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION '0716 counted zero rows in a non-empty relation' USING ERRCODE = '55000';
  END;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT xai_cutover_empty_probe', relation);
END $xai_cutover_assert_empty$;

-- Source inventory by organization and legacy source, taken under the owner
-- window before any mutation.
CREATE TEMP TABLE xai_cutover_inventory (
  account_id uuid NOT NULL,
  metric text NOT NULL,
  legacy_count bigint NOT NULL,
  PRIMARY KEY (account_id, metric)
);
INSERT INTO xai_cutover_inventory
  SELECT account_id, 'credentials_' || authority_scope, count(*)
  FROM xai_subscription_credentials GROUP BY account_id, authority_scope
  UNION ALL SELECT account_id, 'rotation_rows_' || authority_scope, count(*)
  FROM xai_rotation_settings GROUP BY account_id, authority_scope
  UNION ALL SELECT account_id, 'live_leases', count(*)
  FROM xai_credential_leases WHERE leased_until > now() GROUP BY account_id
  UNION ALL SELECT account_id, 'waiting_waiters', count(*)
  FROM xai_capacity_waiters WHERE status = 'waiting' GROUP BY account_id
  UNION ALL SELECT account_id, 'session_pin_rows', count(*)
  FROM xai_session_account_pins
  WHERE pinned_credential_id IS NOT NULL OR last_credential_id IS NOT NULL GROUP BY account_id
  UNION ALL SELECT account_id, 'live_turns', count(*)
  FROM session_turns
  WHERE status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
  GROUP BY account_id
  UNION ALL SELECT account_id, 'video_operations_open', count(*)
  FROM video_generation_operations
  WHERE funding_source = 'supergrok_subscription' AND terminal_at IS NULL GROUP BY account_id
  UNION ALL SELECT account_id, 'image_operations_open', count(*)
  FROM image_generation_operations
  WHERE provider_id = 'supergrok-subscription' AND status IN ('prepared', 'provider_started')
  GROUP BY account_id;

DO $xai_cutover_preflight$
DECLARE
  relation text;
  present boolean;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'xai_subscription_credentials', 'xai_rotation_settings', 'xai_credential_leases',
    'xai_session_account_pins', 'xai_capacity_waiters', 'session_turns', 'managed_accounts'
  ] LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', relation) INTO present;
    IF NOT present THEN
      PERFORM pg_temp.xai_cutover_assert_empty(relation::regclass);
    END IF;
  END LOOP;
  -- The core is dormant for SuperGrok before this migration: its rows must be
  -- empty, so nothing written here can collide with or hide behind earlier
  -- state. The runbook inventory lists any such rows before the window.
  IF EXISTS (SELECT 1 FROM subscription_connections WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_connection_aliases WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_session_bindings WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_leases WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_capacity_waiters WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_operation_leases WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_provider_cutovers WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM opengeni_private.subscription_authority_compat WHERE provider = 'xai')
    OR EXISTS (SELECT 1 FROM subscription_settings WHERE xai_primary_connection_id IS NOT NULL)
  THEN
    RAISE EXCEPTION '0716 refuses pre-existing core SuperGrok state' USING ERRCODE = '55000';
  END IF;
  -- Ambiguous session ownership on live work aborts activation.
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
    RAISE EXCEPTION '0716 refused ambiguous session ownership on live work (session_owner_ambiguous)'
      USING ERRCODE = '55000';
  END IF;
END $xai_cutover_preflight$;

-- The provider registry row, the cutover receipt and the cutover-provider
-- marker precede the codec stage: the stage's connection, auto-assignment
-- and alias rows reference the registry, compatibility records require the
-- receipt, and the stage's own inserts emit no `model.connected` fact. The
-- receipt's commit time is this transaction's: every carrier created before
-- it predates the receipt, and the drained window creates none.
SELECT pg_catalog.set_config('opengeni.subscription_cutover_provider', 'xai', true);
INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, primary_setting_column)
VALUES ('xai', false, 'xai_primary_connection_id');
INSERT INTO opengeni_private.subscription_provider_cutover_receipts (
  provider, migration, committed_at, seed_rotation
) VALUES ('xai', '0716_subscription_core_xai_cutover.sql', transaction_timestamp(), '{"mode":"spread"}');

-- opengeni:xai-subscription-core-cutover-v1

DO $xai_cutover_codec_receipt$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.xai_cutover_stage_0716 WHERE completed) THEN
    RAISE EXCEPTION '0716 codec stage did not complete' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_codec_receipt$;

-- Personal authority generations: every SuperGrok personal connection of one
-- owner carries that owner's single cutover generation; any owner left with
-- more than one current generation aborts.
DO $xai_cutover_generations$
BEGIN
  IF EXISTS (
    SELECT 1 FROM subscription_connections connection
    JOIN organization_user_resource_authorities authority
      ON authority.id = connection.authority_id AND authority.account_id = connection.account_id
     AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
     AND authority.generation = connection.authority_generation
     AND authority.status = 'active' AND authority.revoked_at IS NULL
    WHERE connection.provider = 'xai' AND connection.ownership = 'personal'
    GROUP BY connection.account_id, connection.owner_organization_membership_id
    HAVING count(DISTINCT connection.authority_generation) > 1
  ) OR EXISTS (
    SELECT 1 FROM pg_temp.subscription_cutover_connection_map map
    WHERE map.ownership = 'personal'
    GROUP BY map.account_id, map.owner_membership_id
    HAVING count(DISTINCT map.authority_generation) <> 1
  ) THEN
    RAISE EXCEPTION '0716 refused ambiguous personal generations (personal_generation_ambiguous)'
      USING ERRCODE = '55000';
  END IF;
END $xai_cutover_generations$;

CREATE TEMP TABLE xai_cutover_shared_map AS
  SELECT * FROM pg_temp.subscription_cutover_connection_map WHERE ownership = 'shared';

-- Settings (design 5.3 "Rotation settings" and "Source"). Every organization
-- has an organization settings row; an existing row only gains the SuperGrok
-- rotation entry and, for an organization pool rotating off, its primary.
INSERT INTO subscription_settings (
  account_id, workspace_id, xai_primary_connection_id, rotation, providers,
  cross_provider_failover, fallback_order, personal_connections_allowed,
  personal_fallback_allowed, updated_by_subject_id, updated_at
)
SELECT account.id, NULL,
  CASE WHEN rotation.rotation_enabled IS DISTINCT FROM true THEN primary_map.connection_id END,
  jsonb_build_object('xai', jsonb_build_object('mode',
    CASE WHEN rotation.id IS NULL OR rotation.rotation_enabled THEN 'spread' ELSE 'primary_first' END)),
  '{}'::jsonb, false, '{}'::jsonb, true, false, 'service:subscription-core-cutover', now()
FROM managed_accounts account
LEFT JOIN xai_rotation_settings rotation ON rotation.account_id = account.id
  AND rotation.authority_scope = 'organization'
LEFT JOIN xai_cutover_shared_map primary_map
  ON primary_map.account_id = account.id AND primary_map.legacy_id = rotation.active_credential_id
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  rotation = coalesce(subscription_settings.rotation, '{}'::jsonb) || EXCLUDED.rotation,
  xai_primary_connection_id = EXCLUDED.xai_primary_connection_id,
  version = subscription_settings.version + 1,
  updated_by_subject_id = EXCLUDED.updated_by_subject_id,
  updated_at = EXCLUDED.updated_at;

-- Legacy acceptance used a workspace's own SuperGrok accounts whenever it had
-- any, else the organization's; it never admitted organization accounts while
-- local accounts existed. A shared workspace with workspace-scope credentials
-- is frozen on `inference_source = workspace` with its local rotation; a
-- Personal workspace whose credentials became its owner's personal
-- connection gets personal fallback instead. Every other workspace keeps no
-- override (automatic admits only organization connections there).
CREATE TEMP TABLE xai_cutover_workspace_settings AS
  SELECT workspace.account_id, workspace.id AS workspace_id,
    EXISTS (SELECT 1 FROM organization_memberships owner
      WHERE owner.account_id = workspace.account_id
        AND owner.personal_workspace_id = workspace.id) AS personal,
    EXISTS (SELECT 1 FROM xai_cutover_shared_map local
      WHERE local.account_id = workspace.account_id AND local.legacy_scope = 'workspace'
        AND local.legacy_workspace_id = workspace.id) AS has_local_shared,
    EXISTS (SELECT 1 FROM pg_temp.subscription_cutover_connection_map moved
      WHERE moved.account_id = workspace.account_id AND moved.ownership = 'personal'
        AND moved.legacy_scope = 'workspace' AND moved.legacy_workspace_id = workspace.id) AS has_moved_personal,
    rotation.id AS rotation_id, rotation.rotation_enabled, rotation.fairness_cursor,
    primary_map.connection_id AS primary_connection_id
  FROM workspaces workspace
  LEFT JOIN xai_rotation_settings rotation
    ON rotation.account_id = workspace.account_id AND rotation.workspace_id = workspace.id
   AND rotation.authority_scope = 'workspace'
  LEFT JOIN xai_cutover_shared_map primary_map
    ON primary_map.account_id = workspace.account_id
   AND primary_map.legacy_id = rotation.active_credential_id
   AND primary_map.legacy_scope = 'workspace'
   AND primary_map.legacy_workspace_id = workspace.id;

INSERT INTO subscription_settings (
  account_id, workspace_id, xai_primary_connection_id, rotation, providers,
  personal_fallback_allowed, updated_by_subject_id, updated_at
)
SELECT ws.account_id, ws.workspace_id,
  CASE WHEN ws.has_local_shared AND ws.rotation_id IS NOT NULL AND NOT ws.rotation_enabled
    THEN ws.primary_connection_id END,
  CASE WHEN ws.has_local_shared THEN jsonb_build_object('xai', jsonb_build_object('mode',
    CASE WHEN ws.rotation_id IS NULL OR ws.rotation_enabled THEN 'spread' ELSE 'primary_first' END)) END,
  CASE WHEN ws.has_local_shared
    THEN '{"xai":{"inferenceSource":"workspace","useOrganizationAccounts":false}}'::jsonb END,
  CASE WHEN ws.personal AND ws.has_moved_personal AND NOT coalesce(
      'personalFallbackAllowed' = ANY(org.locked_settings) AND NOT org.personal_fallback_allowed, false)
    THEN true END,
  'service:subscription-core-cutover', now()
FROM xai_cutover_workspace_settings ws
JOIN subscription_settings org ON org.account_id = ws.account_id AND org.workspace_id IS NULL
WHERE ws.has_local_shared OR (ws.personal AND ws.has_moved_personal)
ON CONFLICT (account_id, workspace_id) DO UPDATE SET
  xai_primary_connection_id = EXCLUDED.xai_primary_connection_id,
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
FROM pg_temp.subscription_cutover_connection_map WHERE ownership = 'personal'
ON CONFLICT (account_id, organization_membership_id) DO UPDATE SET
  personal_fallback_opt_in = true,
  version = subscription_person_preferences.version + 1,
  updated_at = EXCLUDED.updated_at;

-- Per-session context for bindings and accepted authority: the latest
-- accepted turn and the pool its v1 snapshot names, and whether the session's
-- current model provider is SuperGrok.
CREATE TEMP TABLE xai_cutover_session_context AS
  SELECT session.account_id, session.workspace_id, session.id AS session_id,
    session.owner_subject_id, session.owner_organization_membership_id, session.visibility,
    session.model, latest.id AS latest_turn_id,
    coalesce(latest.xai_provider_account_authority_snapshot,
      session.initial_xai_provider_account_authority_snapshot) AS latest_v1,
    coalesce(latest.initiating_human_subject_id,
      CASE WHEN latest.initiator_kind = 'subject' THEN latest.initiator_subject_id END,
      CASE WHEN latest.id IS NULL AND session.created_by_kind = 'subject'
        THEN session.created_by_subject_id END) AS latest_human,
    latest.metadata->'turnExecutionPolicyV1'->>'providerId' = 'supergrok-subscription' AS xai_current
  FROM sessions session
  LEFT JOIN LATERAL (
    SELECT turn.* FROM session_turns turn
    WHERE turn.workspace_id = session.workspace_id AND turn.session_id = session.id
    ORDER BY turn.created_at DESC, turn.position DESC, turn.id DESC
    LIMIT 1
  ) latest ON true;
CREATE UNIQUE INDEX ON xai_cutover_session_context (workspace_id, session_id);

-- Session pins (design 5.3 "Session pins"). Among the session's SuperGrok
-- pool rows, the row of the pool its latest accepted v1 snapshot names wins
-- (the person's own pool for a `user` snapshot). A manual pin is `explicit`
-- and survives an unhealthy target (it waits); a policy pin, else the last
-- account, is `automatic`.
CREATE TEMP TABLE xai_cutover_bindings AS
  SELECT pin.account_id, pin.workspace_id, pin.session_id, pin.id AS pin_id,
    (pin.pinned_credential_id IS NOT NULL AND pin.pin_source = 'manual') AS explicit,
    map.connection_id, map.ownership, map.owner_membership_id,
    context.owner_subject_id, context.owner_organization_membership_id, context.visibility,
    context.model, context.xai_current,
    pin.authority_scope = coalesce(context.latest_v1->>'scope', 'workspace') AND (
      pin.authority_scope <> 'user' OR EXISTS (
        SELECT 1 FROM organization_memberships human
        WHERE human.account_id = pin.account_id AND human.id = pin.owner_organization_membership_id
          AND human.subject_id = context.latest_human)) AS pool_in_effect
  FROM xai_session_account_pins pin
  JOIN xai_cutover_session_context context
    ON context.workspace_id = pin.workspace_id AND context.session_id = pin.session_id
  JOIN pg_temp.subscription_cutover_connection_map map ON map.account_id = pin.account_id
   AND map.legacy_id = coalesce(pin.pinned_credential_id, pin.last_credential_id)
  WHERE pin.pinned_credential_id IS NOT NULL OR pin.last_credential_id IS NOT NULL;
ALTER TABLE xai_cutover_bindings ADD COLUMN eligible boolean;
ALTER TABLE xai_cutover_bindings ADD COLUMN existing_provider text;
UPDATE xai_cutover_bindings binding SET eligible = binding.owner_subject_id IS NOT NULL
  AND (binding.ownership = 'shared' OR (
    binding.owner_membership_id = binding.owner_organization_membership_id
    AND EXISTS (SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = binding.account_id
        AND membership.id = binding.owner_membership_id
        AND membership.subject_id = binding.owner_subject_id
        AND (binding.visibility = 'user_private'
          OR membership.personal_workspace_id = binding.workspace_id)))),
  existing_provider = (SELECT existing.provider FROM subscription_session_bindings existing
    WHERE existing.workspace_id = binding.workspace_id AND existing.session_id = binding.session_id);
ALTER TABLE xai_cutover_bindings ADD COLUMN moves boolean;
UPDATE xai_cutover_bindings SET moves = pool_in_effect AND eligible
  AND (existing_provider IS NULL OR coalesce(xai_current, false));
DO $xai_cutover_binding_unique$
BEGIN
  IF EXISTS (SELECT 1 FROM xai_cutover_bindings WHERE moves
    GROUP BY workspace_id, session_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0716 refused ambiguous session pins (pin_pool_ambiguous)' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_binding_unique$;

INSERT INTO subscription_session_bindings AS core (
  account_id, workspace_id, session_id, provider, connection_id, model_id, choice,
  only_this_model, last_model_call_at, last_switch_reason, version
)
SELECT binding.account_id, binding.workspace_id, binding.session_id, 'xai', binding.connection_id,
  left(coalesce((
    SELECT nullif(btrim(turn.metadata->'turnExecutionPolicyV1'->>'productModelId'), '')
    FROM session_turns turn
    WHERE turn.account_id = binding.account_id AND turn.workspace_id = binding.workspace_id
      AND turn.session_id = binding.session_id
      AND turn.metadata->'turnExecutionPolicyV1'->>'providerId' = 'supergrok-subscription'
    ORDER BY turn.position DESC LIMIT 1
  ), nullif(btrim(binding.model), ''), 'grok'), 512),
  CASE WHEN binding.explicit THEN 'explicit' ELSE 'automatic' END, false,
  (SELECT max(fact.occurred_at) FROM model_call_facts fact
    WHERE fact.account_id = binding.account_id AND fact.workspace_id = binding.workspace_id
      AND fact.session_id = binding.session_id),
  CASE WHEN binding.explicit THEN 'explicit_choice' END, 1
FROM xai_cutover_bindings binding WHERE binding.moves
ON CONFLICT (workspace_id, session_id) DO UPDATE SET
  provider = EXCLUDED.provider, connection_id = EXCLUDED.connection_id,
  model_id = EXCLUDED.model_id, choice = EXCLUDED.choice,
  only_this_model = EXCLUDED.only_this_model, last_model_call_at = EXCLUDED.last_model_call_at,
  last_switch_reason = EXCLUDED.last_switch_reason, version = core.version + 1;

-- Live leases keep their turn, holder, generation and expiry. A transferred
-- lease only lets the already-authorized in-flight call finish; every later
-- call re-places through the core. A live core lease on the same turn aborts.
CREATE TEMP TABLE xai_cutover_live_leases AS
SELECT lease.account_id, lease.workspace_id, turn.session_id, lease.turn_id,
  map.connection_id, lease.holder_id, lease.generation, lease.leased_until
FROM xai_credential_leases lease
JOIN session_turns turn ON turn.workspace_id = lease.workspace_id AND turn.id = lease.turn_id
JOIN pg_temp.subscription_cutover_connection_map map
  ON map.account_id = lease.account_id AND map.legacy_id = lease.credential_id
WHERE lease.leased_until > now();
DO $xai_cutover_lease_conflict$
BEGIN
  IF EXISTS (SELECT 1 FROM xai_cutover_live_leases legacy
    JOIN subscription_leases core ON core.workspace_id = legacy.workspace_id
     AND core.turn_id = legacy.turn_id) THEN
    RAISE EXCEPTION '0716 refused a turn leased on both runtimes (lease_conflict)' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_lease_conflict$;
INSERT INTO subscription_leases (
  account_id, workspace_id, session_id, turn_id, connection_id, provider, holder_id,
  generation, leased_until
)
SELECT account_id, workspace_id, session_id, turn_id, connection_id, 'xai', left(holder_id, 256),
  generation, leased_until
FROM xai_cutover_live_leases;

-- Waiters (design 5.3 "Waiters"). Only waiting rows parked on the session's
-- waiting turn at its current execution generation move; when several pool
-- waiters match, the one of the turn's v1 pool moves. The legacy UUID is
-- kept as the waiter id so a workflow history that recorded it reconciles
-- against the same id.
CREATE TEMP TABLE xai_cutover_waiters AS
SELECT waiter.*, turn.status AS turn_status, turn.execution_generation,
  coalesce(session.temporal_workflow_id, 'session-' || session.id::text) AS session_workflow_id,
  row_number() OVER (PARTITION BY waiter.workspace_id, waiter.session_id ORDER BY
    (waiter.authority_scope = coalesce(turn.xai_provider_account_authority_snapshot->>'scope', 'workspace')
      AND (waiter.authority_scope <> 'user' OR EXISTS (
        SELECT 1 FROM organization_memberships human
        WHERE human.account_id = waiter.account_id
          AND human.id = waiter.owner_organization_membership_id
          AND human.subject_id = coalesce(turn.initiating_human_subject_id,
            CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END)))) DESC,
    waiter.updated_at DESC, waiter.id) AS rank
FROM xai_capacity_waiters waiter
JOIN session_turns turn ON turn.workspace_id = waiter.workspace_id AND turn.id = waiter.blocked_turn_id
  AND turn.session_id = waiter.session_id
JOIN sessions session ON session.workspace_id = waiter.workspace_id AND session.id = waiter.session_id
WHERE waiter.status = 'waiting' AND turn.status = 'waiting_capacity'
  AND turn.execution_generation = waiter.blocked_turn_generation;
DO $xai_cutover_waiter_checks$
BEGIN
  IF EXISTS (SELECT 1 FROM xai_cutover_waiters waiter WHERE waiter.rank = 1
    AND waiter.workflow_id IS DISTINCT FROM waiter.session_workflow_id) THEN
    RAISE EXCEPTION '0716 refused a waiter of another workflow (waiter_workflow_mismatch)'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM xai_cutover_waiters waiter
    JOIN subscription_capacity_waiters core ON core.workspace_id = waiter.workspace_id
     AND core.session_id = waiter.session_id
    WHERE waiter.rank = 1) THEN
    RAISE EXCEPTION '0716 refused a session waiting on both runtimes (waiter_conflict)'
      USING ERRCODE = '55000';
  END IF;
END $xai_cutover_waiter_checks$;
INSERT INTO subscription_capacity_waiters (
  account_id, workspace_id, session_id, turn_id, waiter_id, provider, wait_reason,
  policy_hash, reset_kind, refresh_attempt, resumed_update_id, earliest_reset_at, generation,
  wake_revision, observed_wake_revision, next_check_at, blocked_turn_generation, goal_id,
  goal_version, last_wake_reason, updated_at
)
SELECT waiter.account_id, waiter.workspace_id, waiter.session_id, waiter.blocked_turn_id, waiter.id,
  'xai',
  CASE WHEN EXISTS (SELECT 1 FROM subscription_session_bindings binding
      WHERE binding.workspace_id = waiter.workspace_id AND binding.session_id = waiter.session_id
        AND binding.provider = 'xai' AND binding.choice = 'explicit')
    THEN 'pinned_account_unavailable' ELSE 'no_eligible_capacity' END,
  NULL, CASE WHEN waiter.earliest_reset_at IS NOT NULL THEN 'quota' END, 0, NULL,
  waiter.earliest_reset_at, waiter.generation, waiter.wake_revision, waiter.observed_wake_revision,
  waiter.next_check_at, waiter.blocked_turn_generation, waiter.goal_id, waiter.goal_version,
  left(waiter.last_wake_reason, 128), waiter.updated_at
FROM xai_cutover_waiters waiter
WHERE waiter.rank = 1;
-- A pending wake (a revision the workflow has not observed) is delivered
-- through the core wake outbox.
INSERT INTO subscription_capacity_wake_outbox (
  account_id, workspace_id, session_id, waiter_id, generation, wake_revision
)
SELECT core.account_id, core.workspace_id, core.session_id, core.waiter_id, core.generation,
  core.wake_revision
FROM subscription_capacity_waiters core
WHERE core.provider = 'xai' AND core.wake_revision > core.observed_wake_revision;
-- Every legacy waiting row is superseded (moved or collapsed) so no fallback
-- lookup can revive it.
CREATE TEMP TABLE xai_cutover_waiting_before AS
  SELECT id, account_id FROM xai_capacity_waiters WHERE status = 'waiting';
UPDATE xai_capacity_waiters SET status = 'superseded', updated_at = now()
WHERE status = 'waiting';

-- Media ledgers. A non-terminal SuperGrok video operation keeps funding from
-- its credential's canonical connection: the codec stage staged a reference
-- envelope (`subscription-connection`, the shape the core video path reads
-- under a `video` operation lease it takes at each step), which replaces the
-- token envelope after parity below, so no second secret copy remains. An
-- envelope whose credential cannot be resolved references no connection and
-- ends at its recovery deadline (a disposition). `connection_id` stays NULL
-- for subscription funding, as the core path writes it.
CREATE TEMP TABLE xai_cutover_videos AS
SELECT operation.id, operation.account_id, staged.connection_id, staged.reference_encrypted
FROM video_generation_operations operation
JOIN pg_temp.subscription_cutover_video_credentials staged
  ON staged.operation_id = operation.id AND staged.account_id = operation.account_id
WHERE operation.funding_source = 'supergrok_subscription' AND operation.terminal_at IS NULL;

-- Accepted authority across the cutover (design 5.3). One immutable record
-- per carrier that a later read or copy can use as its source: live work,
-- every session's execution-context, latest accepted and child-parent turns
-- (or `session_initial` when it has no turn), the turn its latest
-- compaction would continue, the causal turns of pending updates, turns a
-- composer draft still edits, and live scheduled tasks with their
-- revisions. v1 columns and existing v2 values are not modified.
CREATE TEMP TABLE xai_cutover_carriers (
  carrier_kind text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  task_authority_revision bigint,
  session_id uuid,
  v1 jsonb,
  human text,
  human_membership_id uuid,
  owner_subject_id text,
  owner_membership_id uuid,
  private boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX ON xai_cutover_carriers (carrier_kind, carrier_id, coalesce(task_authority_revision, 0));

CREATE TEMP TABLE xai_cutover_turn_ids (workspace_id uuid NOT NULL, turn_id uuid NOT NULL);
INSERT INTO xai_cutover_turn_ids
  SELECT turn.workspace_id, turn.id FROM session_turns turn
  WHERE turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
  UNION SELECT session.workspace_id, session.execution_context_turn_id FROM sessions session
  WHERE session.execution_context_turn_id IS NOT NULL
  UNION SELECT context.workspace_id, context.latest_turn_id FROM xai_cutover_session_context context
  WHERE context.latest_turn_id IS NOT NULL
  UNION SELECT child.workspace_id, child.parent_turn_id FROM sessions child
  WHERE child.parent_session_id IS NOT NULL AND child.parent_turn_id IS NOT NULL
  UNION SELECT session.workspace_id, started.turn_id FROM sessions session
  CROSS JOIN LATERAL (
    SELECT event.turn_id FROM session_events event
    WHERE event.workspace_id = session.workspace_id AND event.session_id = session.id
      AND event.type = 'turn.started' AND event.turn_id IS NOT NULL
    ORDER BY event.sequence DESC LIMIT 1
  ) started
  UNION SELECT update_row.workspace_id, (update_row.lineage->>'causalTurnId')::uuid
  FROM session_system_updates update_row
  WHERE update_row.state = 'pending'
    AND coalesce(update_row.lineage->>'causalTurnId', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION SELECT update_row.workspace_id, (update_row.lineage->>'parentTurnId')::uuid
  FROM session_system_updates update_row
  WHERE update_row.state = 'pending'
    AND coalesce(update_row.lineage->>'parentTurnId', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION SELECT draft.workspace_id, draft.source_turn_id FROM composer_drafts draft
  WHERE draft.source_turn_id IS NOT NULL;

INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, session_id, v1, human,
  owner_subject_id, owner_membership_id, private
)
SELECT 'session_turn', turn.account_id, turn.workspace_id, turn.id, turn.session_id,
  turn.xai_provider_account_authority_snapshot,
  coalesce(turn.initiating_human_subject_id,
    CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END),
  session.owner_subject_id, session.owner_organization_membership_id,
  session.visibility = 'user_private'
FROM (SELECT DISTINCT workspace_id, turn_id FROM xai_cutover_turn_ids) wanted
JOIN session_turns turn ON turn.workspace_id = wanted.workspace_id AND turn.id = wanted.turn_id
JOIN sessions session ON session.workspace_id = turn.workspace_id AND session.id = turn.session_id
WHERE session.imported_archive_import_id IS NULL;

INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, session_id, v1, human,
  owner_subject_id, owner_membership_id, private
)
SELECT 'session_initial', session.account_id, session.workspace_id, session.id, session.id,
  session.initial_xai_provider_account_authority_snapshot,
  CASE WHEN session.created_by_kind = 'subject' THEN session.created_by_subject_id END,
  session.owner_subject_id, session.owner_organization_membership_id,
  session.visibility = 'user_private'
FROM xai_cutover_session_context context
JOIN sessions session ON session.workspace_id = context.workspace_id AND session.id = context.session_id
WHERE context.latest_turn_id IS NULL AND session.imported_archive_import_id IS NULL;

-- A schedule's owner is its captured human; a schedule cannot know a future
-- session's visibility, so only a Personal-workspace schedule carries a
-- workspace-derived personal entry.
INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, v1, human, human_membership_id,
  owner_subject_id
)
SELECT 'scheduled_task', task.account_id, task.workspace_id, task.id,
  task.xai_provider_account_authority_snapshot, task.owner_subject_id,
  (SELECT membership.id FROM organization_memberships membership
    WHERE membership.account_id = task.account_id AND membership.subject_id = task.owner_subject_id
    ORDER BY membership.created_at DESC LIMIT 1),
  task.owner_subject_id
FROM scheduled_tasks task WHERE task.deleted_at IS NULL;
-- Every revision a firing can still read: the current one and those of
-- occurrences not yet settled. The authorizing membership must be the
-- revision subject's and the task owner's (the legacy causal field).
INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, task_authority_revision, v1, human,
  human_membership_id, owner_subject_id
)
SELECT 'scheduled_task_revision', revision.account_id, revision.workspace_id, revision.task_id,
  revision.task_authority_revision, task.xai_provider_account_authority_snapshot,
  CASE WHEN revision.subject_id = task.owner_subject_id AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = revision.account_id
        AND membership.id = revision.organization_membership_id
        AND membership.subject_id = revision.subject_id)
    THEN revision.subject_id END,
  revision.organization_membership_id, task.owner_subject_id
FROM scheduled_task_revision_authorities revision
JOIN scheduled_tasks task ON task.id = revision.task_id AND task.workspace_id = revision.workspace_id
WHERE task.deleted_at IS NULL AND (revision.task_authority_revision = task.authority_revision
  OR EXISTS (SELECT 1 FROM scheduled_task_runs run
    WHERE run.workspace_id = revision.workspace_id AND run.task_id = revision.task_id
      AND run.task_authority_revision = revision.task_authority_revision
      AND run.completed_at IS NULL));

-- Internal updates and outbox rows store no human: their owner is the human
-- of their causal turn, by the same per-path resolver the copy routine uses.
INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, session_id, v1, human,
  owner_subject_id, owner_membership_id, private
)
SELECT 'session_system_update', update_row.account_id, update_row.workspace_id, update_row.id,
  update_row.session_id, update_row.xai_provider_account_authority_snapshot,
  (SELECT source.causal_human
    FROM opengeni_subscription_internal.subscription_compat_carrier_sources(
      'session_system_update', update_row.workspace_id, update_row.id, NULL) source
    WHERE source.causal_human IS NOT NULL LIMIT 1),
  session.owner_subject_id, session.owner_organization_membership_id,
  session.visibility = 'user_private'
FROM session_system_updates update_row
JOIN sessions session ON session.workspace_id = update_row.workspace_id
  AND session.id = update_row.session_id
WHERE update_row.state = 'pending';
INSERT INTO xai_cutover_carriers (
  carrier_kind, account_id, workspace_id, carrier_id, session_id, v1, human,
  owner_subject_id, owner_membership_id, private
)
SELECT 'session_system_update_outbox', outbox.account_id, outbox.workspace_id, outbox.id,
  outbox.target_session_id, outbox.xai_provider_account_authority_snapshot,
  (SELECT source.causal_human
    FROM opengeni_subscription_internal.subscription_compat_carrier_sources(
      'session_system_update_outbox', outbox.workspace_id, outbox.id, NULL) source
    WHERE source.causal_human IS NOT NULL LIMIT 1),
  session.owner_subject_id, session.owner_organization_membership_id,
  session.visibility = 'user_private'
FROM session_system_update_outbox outbox
LEFT JOIN sessions session ON session.workspace_id = outbox.workspace_id
  AND session.id = outbox.target_session_id
WHERE outbox.status = 'pending';

-- The human's own membership, when the carrier did not record it.
UPDATE xai_cutover_carriers carrier SET human_membership_id = (
  SELECT membership.id FROM organization_memberships membership
  WHERE membership.account_id = carrier.account_id AND membership.subject_id = carrier.human
  ORDER BY (membership.status = 'active' AND membership.revoked_at IS NULL) DESC,
    membership.created_at DESC
  LIMIT 1)
WHERE carrier.human IS NOT NULL AND carrier.human_membership_id IS NULL;

-- The record for one carrier (design 5.3 v1 snapshot table). A v1 `user`
-- snapshot keeps the owner's personal entry only when that owner's legacy
-- `xai_subscription` authority for the credentials it named in this
-- workspace is, now, active, unrevoked and at the snapshot's generation and
-- the organization allows personal connections; the entry then lists exactly
-- those credentials' canonical connections at the owner's cutover generation
-- G. A `workspace` snapshot in a Personal workspace whose credentials became
-- its owner's personal connection keeps that owner's entry only for
-- owner-caused work. Nothing else gains personal authority.
CREATE FUNCTION pg_temp.xai_cutover_record(carrier xai_cutover_carriers)
RETURNS TABLE (personal jsonb, shared_pool text, legacy_scope text, owner_subject_id text,
  disposition text)
LANGUAGE plpgsql STABLE AS $xai_cutover_record$
DECLARE
  scope text;
  carrier_generation bigint;
  membership_ok boolean;
  personal_owner organization_memberships%ROWTYPE;
  allowed boolean;
  entry_generation bigint;
  connection_ids jsonb;
BEGIN
  IF carrier.v1 IS NULL OR NOT xai_provider_account_authority_snapshot_v1_valid(carrier.v1) THEN
    RETURN QUERY SELECT '[]'::jsonb, 'none'::text, 'missing'::text, NULL::text,
      'compat_v1_unreadable'::text;
    RETURN;
  END IF;
  scope := carrier.v1->>'scope';
  SELECT coalesce(settings.personal_connections_allowed, true) INTO allowed
  FROM subscription_settings settings
  WHERE settings.account_id = carrier.account_id AND settings.workspace_id IS NULL;
  allowed := coalesce(allowed, true);
  IF scope = 'organization' THEN
    RETURN QUERY SELECT '[]'::jsonb, 'organization'::text, 'organization'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF scope = 'workspace' THEN
    SELECT * INTO personal_owner FROM organization_memberships owner
    WHERE owner.account_id = carrier.account_id AND owner.personal_workspace_id = carrier.workspace_id;
    IF NOT FOUND OR NOT allowed OR carrier.human IS NULL
      OR personal_owner.subject_id IS DISTINCT FROM carrier.human
      OR personal_owner.status <> 'active' OR personal_owner.revoked_at IS NOT NULL
      OR carrier.human_membership_id IS DISTINCT FROM personal_owner.id
      OR carrier.owner_subject_id IS DISTINCT FROM carrier.human
      OR (carrier.owner_membership_id IS NOT NULL
        AND carrier.owner_membership_id IS DISTINCT FROM personal_owner.id)
    THEN
      RETURN QUERY SELECT '[]'::jsonb, 'workspace'::text, 'workspace'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    SELECT max(map.authority_generation), coalesce(jsonb_agg(DISTINCT map.connection_id::text), '[]'::jsonb)
    INTO entry_generation, connection_ids
    FROM pg_temp.subscription_cutover_connection_map map
    WHERE map.account_id = carrier.account_id AND map.ownership = 'personal'
      AND map.owner_membership_id = personal_owner.id AND map.authority_active
      AND map.legacy_scope = 'workspace' AND map.legacy_workspace_id = carrier.workspace_id;
    IF entry_generation IS NULL OR jsonb_array_length(connection_ids) = 0 THEN
      RETURN QUERY SELECT '[]'::jsonb, 'workspace'::text, 'workspace'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT jsonb_build_array(jsonb_build_object(
        'ownerMembershipId', personal_owner.id::text,
        'authorityGeneration', entry_generation,
        'connectionIds', (SELECT jsonb_agg(id ORDER BY id) FROM jsonb_array_elements(connection_ids) id))),
      'workspace'::text, 'workspace'::text, carrier.human, NULL::text;
    RETURN;
  END IF;
  -- `user`.
  IF carrier.human IS NULL THEN
    RETURN QUERY SELECT '[]'::jsonb, 'none'::text, 'missing'::text, NULL::text,
      'compat_user_without_human'::text;
    RETURN;
  END IF;
  carrier_generation := (carrier.v1->>'authorityGeneration')::bigint;
  SELECT membership.subject_id = carrier.human AND membership.status = 'active'
      AND membership.revoked_at IS NULL
  INTO membership_ok
  FROM organization_memberships membership
  WHERE membership.account_id = carrier.account_id AND membership.id = carrier.human_membership_id;
  SELECT max(map.authority_generation), coalesce(jsonb_agg(DISTINCT map.connection_id::text), '[]'::jsonb)
  INTO entry_generation, connection_ids
  FROM xai_subscription_credentials credential
  JOIN organization_user_resource_authorities authority
    ON authority.id = credential.organization_user_resource_authority_id
   AND authority.account_id = credential.account_id
   AND authority.organization_membership_id = credential.owner_organization_membership_id
   AND authority.resource_kind = 'xai_subscription' AND authority.resource_id = credential.id
   AND authority.generation = carrier_generation
   AND authority.status = 'active' AND authority.revoked_at IS NULL
  JOIN pg_temp.subscription_cutover_connection_map map
    ON map.account_id = credential.account_id AND map.legacy_id = credential.id
   AND map.ownership = 'personal' AND map.owner_membership_id = carrier.human_membership_id
   AND map.authority_active
  WHERE credential.account_id = carrier.account_id AND credential.authority_scope = 'user'
    AND credential.workspace_id = carrier.workspace_id
    AND credential.owner_organization_membership_id = carrier.human_membership_id
    AND credential.organization_user_resource_authority_generation = carrier_generation;
  IF NOT coalesce(membership_ok, false) OR NOT allowed OR entry_generation IS NULL
    OR jsonb_array_length(connection_ids) = 0 THEN
    RETURN QUERY SELECT '[]'::jsonb, 'none'::text, 'user'::text, carrier.human,
      CASE WHEN NOT allowed THEN 'compat_personal_connections_disallowed'
        ELSE 'compat_user_not_eligible' END;
    RETURN;
  END IF;
  RETURN QUERY SELECT jsonb_build_array(jsonb_build_object(
      'ownerMembershipId', carrier.human_membership_id::text,
      'authorityGeneration', entry_generation,
      'connectionIds', (SELECT jsonb_agg(id ORDER BY id) FROM jsonb_array_elements(connection_ids) id))),
    'none'::text, 'user'::text, carrier.human, NULL::text;
END $xai_cutover_record$;

CREATE TEMP TABLE xai_cutover_records AS
SELECT carrier.*, record.personal, record.shared_pool, record.legacy_scope,
  record.owner_subject_id AS record_owner_subject_id, record.disposition
FROM xai_cutover_carriers carrier
CROSS JOIN LATERAL pg_temp.xai_cutover_record(carrier) record;

INSERT INTO opengeni_private.subscription_authority_compat (
  account_id, workspace_id, provider, carrier_kind, session_id, turn_id, scheduled_task_id,
  task_authority_revision, system_update_id, outbox_id, personal, shared_pool, legacy_scope,
  owner_subject_id
)
SELECT record.account_id, record.workspace_id, 'xai', record.carrier_kind,
  CASE WHEN record.carrier_kind = 'session_initial' THEN record.carrier_id END,
  CASE WHEN record.carrier_kind = 'session_turn' THEN record.carrier_id END,
  CASE WHEN record.carrier_kind IN ('scheduled_task', 'scheduled_task_revision') THEN record.carrier_id END,
  record.task_authority_revision,
  CASE WHEN record.carrier_kind = 'session_system_update' THEN record.carrier_id END,
  CASE WHEN record.carrier_kind = 'session_system_update_outbox' THEN record.carrier_id END,
  record.personal, record.shared_pool, record.legacy_scope, record.record_owner_subject_id
FROM xai_cutover_records record;

-- Activation: every organization's SuperGrok switch row is enabled in the
-- same transaction as the data move, so no organization can reach a legacy
-- SuperGrok table after commit. Organizations created later are seeded
-- enabled by 0712's receipt-keyed seed; the row cannot be deleted or moved.
INSERT INTO subscription_provider_cutovers (account_id, provider, enabled, updated_by_subject_id, updated_at)
SELECT account.id, 'xai', true, 'service:subscription-core-cutover', now() FROM managed_accounts account;

-- One secret copy: the legacy ciphertext and the in-flight video envelopes
-- are retired after readability parity proved the core copy decrypts to the
-- same credential.
DO $xai_cutover_readability$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.subscription_cutover_readability
      WHERE source_digest <> target_digest)
    OR (SELECT count(*) FROM pg_temp.subscription_cutover_readability)
      <> (SELECT count(DISTINCT connection_id) FROM pg_temp.subscription_cutover_connection_map)
    OR (SELECT count(*) FROM pg_temp.subscription_cutover_connection_map)
      <> (SELECT count(*) FROM xai_subscription_credentials) THEN
    RAISE EXCEPTION '0716 parity mismatch (secret_readability)' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_readability$;
UPDATE xai_subscription_credentials SET credential_encrypted = ''
WHERE credential_encrypted <> '';
UPDATE video_generation_operations operation
SET credential_encrypted = video.reference_encrypted, updated_at = now()
FROM xai_cutover_videos video WHERE video.id = operation.id;

-- Explicit parity by organization and legacy source, with the owner queries
-- above (FORCE is still off). Any mismatch rolls the whole cutover back; the
-- report keeps only counts.
CREATE TEMP TABLE xai_cutover_parity (
  account_id uuid,
  metric text NOT NULL,
  legacy_count bigint NOT NULL,
  core_count bigint NOT NULL
);
-- Independently reconstruct each local pool's enabled model union and each
-- connection's ceiling from the legacy rows (0689's rule).
CREATE TEMP TABLE xai_cutover_expected_workspace_policies AS
WITH members AS (
  SELECT credential.account_id, map.connection_id, credential.workspace_id,
    credential.allocator_enabled, credential.allowed_model_ids
  FROM xai_subscription_credentials credential
  JOIN xai_cutover_shared_map map ON map.legacy_id = credential.id
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
CREATE TEMP TABLE xai_cutover_expected_connection_policies AS
WITH members AS (
  SELECT credential.account_id, map.connection_id,
    credential.allocator_enabled, credential.allowed_model_ids
  FROM xai_subscription_credentials credential
  JOIN pg_temp.subscription_cutover_connection_map map ON map.legacy_id = credential.id
), groups AS (
  SELECT account_id, connection_id, bool_or(allocator_enabled) AS enabled
  FROM members GROUP BY account_id, connection_id
), selected AS (
  SELECT member.* FROM members member JOIN groups USING (account_id, connection_id)
  WHERE member.allocator_enabled OR NOT groups.enabled
)
SELECT groups.*, CASE WHEN EXISTS (
    SELECT 1 FROM selected member WHERE member.account_id = groups.account_id
      AND member.connection_id = groups.connection_id AND member.allowed_model_ids IS NULL
  ) THEN NULL::text[] ELSE ARRAY(
    SELECT DISTINCT model FROM selected member CROSS JOIN LATERAL unnest(member.allowed_model_ids) model
    WHERE member.account_id = groups.account_id AND member.connection_id = groups.connection_id
    ORDER BY model
  ) END AS allowed_model_ids
FROM groups;
-- The dependent sources of later copies, by the shared resolvers: every
-- session's receiver source and compaction source, each child's parent turn,
-- each pending goal continuation's causal turn, and each live schedule's
-- current revision. Each must hold a record.
CREATE TEMP TABLE xai_cutover_dependent_sources AS
SELECT DISTINCT source.account_id, source.source_kind, source.workspace_id, source.source_id,
  source.source_revision
FROM (
  SELECT session.account_id, receiver.source_kind, session.workspace_id, receiver.source_id,
    NULL::bigint AS source_revision
  FROM sessions session
  CROSS JOIN LATERAL opengeni_subscription_internal.subscription_compat_receiver_source(
    session.workspace_id, session.id) receiver
  WHERE session.imported_archive_import_id IS NULL AND receiver.source_kind IS NOT NULL
  UNION ALL
  SELECT session.account_id, 'session_turn', session.workspace_id,
    opengeni_subscription_internal.subscription_compat_compaction_source(session.workspace_id, session.id),
    NULL::bigint
  FROM sessions session WHERE session.imported_archive_import_id IS NULL
  UNION ALL
  SELECT child.account_id, 'session_turn', child.workspace_id, child.parent_turn_id, NULL::bigint
  FROM sessions child
  WHERE child.parent_session_id IS NOT NULL AND child.parent_turn_id IS NOT NULL
    AND child.imported_archive_import_id IS NULL
    AND EXISTS (SELECT 1 FROM session_turns parent WHERE parent.workspace_id = child.workspace_id
      AND parent.session_id = child.parent_session_id AND parent.id = child.parent_turn_id)
  UNION ALL
  SELECT update_row.account_id, 'session_turn', update_row.workspace_id, causal.id, NULL::bigint
  FROM session_system_updates update_row
  JOIN session_turns causal ON causal.workspace_id = update_row.workspace_id
    AND causal.session_id = update_row.session_id
    AND causal.id::text = lower(update_row.lineage->>'causalTurnId')
  WHERE update_row.state = 'pending' AND update_row.kind = 'goal_continuation'
  UNION ALL
  SELECT task.account_id, 'scheduled_task_revision', task.workspace_id, task.id, task.authority_revision
  FROM scheduled_tasks task
  WHERE task.deleted_at IS NULL AND EXISTS (SELECT 1 FROM scheduled_task_revision_authorities revision
    WHERE revision.task_id = task.id AND revision.task_authority_revision = task.authority_revision)
) source
WHERE source.source_id IS NOT NULL;
INSERT INTO xai_cutover_parity
  -- Credentials, connections, aliases, identities.
  SELECT inventory.account_id, 'credentials', sum(inventory.legacy_count)::bigint,
    (SELECT count(*) FROM pg_temp.subscription_cutover_connection_map map
      WHERE map.account_id = inventory.account_id)
  FROM xai_cutover_inventory inventory WHERE inventory.metric LIKE 'credentials_%'
  GROUP BY inventory.account_id
  UNION ALL SELECT readable.account_id, 'secret_readability', count(*),
    count(*) FILTER (WHERE readable.source_digest = readable.target_digest)
  FROM pg_temp.subscription_cutover_readability readable GROUP BY readable.account_id
  UNION ALL SELECT map.account_id, 'connections', count(DISTINCT map.connection_id),
    (SELECT count(*) FROM subscription_connections connection
      WHERE connection.account_id = map.account_id AND connection.provider = 'xai')
  FROM pg_temp.subscription_cutover_connection_map map GROUP BY map.account_id
  UNION ALL SELECT map.account_id, 'aliases', count(*) FILTER (WHERE map.legacy_id <> map.connection_id),
    (SELECT count(*) FROM subscription_connection_aliases alias
      WHERE alias.account_id = map.account_id AND alias.provider = 'xai'
        AND EXISTS (SELECT 1 FROM pg_temp.subscription_cutover_connection_map target
          WHERE target.legacy_id = alias.alias_connection_id AND target.connection_id = alias.connection_id))
  FROM pg_temp.subscription_cutover_connection_map map GROUP BY map.account_id
  -- Each distinct (upstream account, owner) with a known identity became
  -- connections that carry that identity.
  UNION ALL SELECT credential.account_id, 'unique_upstream_identities',
    count(DISTINCT (connection.provider_account_id, connection.provider_subject_id,
      map.owner_membership_id)),
    count(DISTINCT connection.id) FILTER (
      WHERE connection.owner_organization_membership_id IS NOT DISTINCT FROM map.owner_membership_id)
  FROM xai_subscription_credentials credential
  JOIN pg_temp.subscription_cutover_connection_map map ON map.legacy_id = credential.id
  JOIN subscription_connections connection ON connection.id = map.connection_id
  WHERE connection.provider_account_id IS NOT NULL AND connection.provider_subject_id IS NOT NULL
  GROUP BY credential.account_id
  -- Local workspace rows: each keeps its exact workspace-pool policy and manager.
  UNION ALL SELECT expected.account_id, 'workspace_pool_policies', count(*),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM subscription_connection_assignment_policies policy
      WHERE policy.account_id = expected.account_id AND policy.connection_id = expected.connection_id
        AND policy.workspace_id = expected.workspace_id AND policy.inference_pool = 'workspace'
        AND policy.allocator_enabled = expected.enabled
        AND policy.allowed_model_ids IS NOT DISTINCT FROM expected.allowed_model_ids
        AND policy.managed_by_workspace_id = expected.workspace_id))
  FROM xai_cutover_expected_workspace_policies expected GROUP BY expected.account_id
  UNION ALL SELECT expected.account_id, 'connection_model_policies', count(*),
    count(*) FILTER (WHERE connection.allocator_enabled = expected.enabled
      AND connection.allowed_model_ids IS NOT DISTINCT FROM expected.allowed_model_ids)
  FROM xai_cutover_expected_connection_policies expected
  JOIN subscription_connections connection ON connection.id = expected.connection_id
    AND connection.account_id = expected.account_id
  GROUP BY expected.account_id
  -- Health: status 1:1 for the canonical row; version and refresh
  -- generation from the legacy version.
  UNION ALL SELECT credential.account_id, 'health', count(*),
    count(*) FILTER (WHERE connection.status = credential.status
      AND connection.version = greatest(credential.version, 1)
      AND connection.refresh_generation = greatest(credential.version, 1))
  FROM xai_subscription_credentials credential
  JOIN subscription_connections connection ON connection.id = credential.id
    AND connection.provider = 'xai'
  GROUP BY credential.account_id
  -- Allocator counters: summed selections and the latest selection.
  UNION ALL SELECT expected.account_id, 'allocator_counters', count(*),
    count(*) FILTER (WHERE quota.selection_count = expected.selections
      AND quota.last_selected_at IS NOT DISTINCT FROM expected.last_selected)
  FROM (
    SELECT credential.account_id, map.connection_id, sum(credential.selection_count) AS selections,
      max(credential.last_selected_at) AS last_selected
    FROM xai_subscription_credentials credential
    JOIN pg_temp.subscription_cutover_connection_map map ON map.legacy_id = credential.id
    GROUP BY credential.account_id, map.connection_id
  ) expected
  LEFT JOIN subscription_connection_quota quota ON quota.account_id = expected.account_id
    AND quota.connection_id = expected.connection_id
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
  FROM xai_subscription_credentials credential
  JOIN xai_cutover_shared_map map ON map.legacy_id = credential.id
  JOIN subscription_connections connection ON connection.id = map.connection_id
  JOIN workspaces workspace ON workspace.account_id = credential.account_id
  WHERE credential.authority_scope = 'organization'
    AND CASE WHEN EXISTS (SELECT 1 FROM organization_memberships owner
        WHERE owner.account_id = workspace.account_id AND owner.personal_workspace_id = workspace.id)
      THEN credential.allow_personal_workspaces
      ELSE credential.allowed_workspace_ids IS NULL OR workspace.id = ANY(credential.allowed_workspace_ids)
    END
  GROUP BY credential.account_id
  -- Organization reach for workspaces created later.
  UNION ALL SELECT disposition.account_id, 'organization_reach_auto_assigned', disposition.count,
    (SELECT count(*) FROM opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = disposition.account_id AND auto.provider = 'xai')
  FROM pg_temp.subscription_cutover_dispositions disposition
  WHERE disposition.disposition = 'organization_reach_auto_assigned'
  -- Personal connections: owner, resource authority and the single cutover
  -- generation per owner.
  UNION ALL SELECT map.account_id, 'personal_connections', count(DISTINCT map.connection_id),
    (SELECT count(*) FROM subscription_connections connection
      JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
       AND authority.resource_id = connection.id AND authority.resource_kind = 'subscription_connection'
       AND authority.organization_membership_id = connection.owner_organization_membership_id
       AND authority.generation = connection.authority_generation
      WHERE connection.account_id = map.account_id AND connection.provider = 'xai'
        AND connection.ownership = 'personal' AND connection.scope_kind = 'people')
  FROM pg_temp.subscription_cutover_connection_map map WHERE map.ownership = 'personal'
  GROUP BY map.account_id
  UNION ALL SELECT map.account_id, 'personal_generations', count(DISTINCT map.owner_membership_id),
    (SELECT count(*) FROM (
      SELECT connection.owner_organization_membership_id FROM subscription_connections connection
      WHERE connection.account_id = map.account_id AND connection.provider = 'xai'
        AND connection.ownership = 'personal'
      GROUP BY connection.owner_organization_membership_id
      HAVING count(DISTINCT connection.authority_generation) = 1) owners)
  FROM pg_temp.subscription_cutover_connection_map map WHERE map.ownership = 'personal'
  GROUP BY map.account_id
  -- Effective source: every shared workspace with local accounts is frozen
  -- on its workspace pool.
  UNION ALL SELECT ws.account_id, 'source_modes', count(*),
    count(*) FILTER (WHERE settings.providers->'xai'->>'inferenceSource' = 'workspace')
  FROM xai_cutover_workspace_settings ws
  LEFT JOIN subscription_settings settings ON settings.account_id = ws.account_id
   AND settings.workspace_id = ws.workspace_id
  WHERE ws.has_local_shared GROUP BY ws.account_id
  -- Rotation for the pool in effect: organization row to organization settings.
  UNION ALL SELECT rotation.account_id, 'organization_rotation', count(*),
    count(*) FILTER (WHERE (settings.rotation->'xai'->>'mode') =
        CASE WHEN rotation.rotation_enabled THEN 'spread' ELSE 'primary_first' END
      AND (rotation.rotation_enabled OR settings.xai_primary_connection_id IS NOT DISTINCT FROM (
        SELECT map.connection_id FROM xai_cutover_shared_map map
        WHERE map.legacy_id = rotation.active_credential_id)))
  FROM xai_rotation_settings rotation
  JOIN subscription_settings settings ON settings.account_id = rotation.account_id
   AND settings.workspace_id IS NULL
  WHERE rotation.authority_scope = 'organization'
  GROUP BY rotation.account_id
  -- Workspace rotation where the workspace pool is in effect.
  UNION ALL SELECT ws.account_id, 'workspace_rotation', count(*),
    count(*) FILTER (WHERE (settings.rotation->'xai'->>'mode') =
        CASE WHEN ws.rotation_enabled THEN 'spread' ELSE 'primary_first' END
      AND (ws.rotation_enabled
        OR settings.xai_primary_connection_id IS NOT DISTINCT FROM ws.primary_connection_id))
  FROM xai_cutover_workspace_settings ws
  LEFT JOIN subscription_settings settings ON settings.account_id = ws.account_id
   AND settings.workspace_id = ws.workspace_id
  WHERE ws.rotation_id IS NOT NULL AND ws.has_local_shared
  GROUP BY ws.account_id
  -- Session bindings: every pin row is a binding or a disposition; moved
  -- bindings exact.
  UNION ALL SELECT inventory.account_id, 'session_pin_rows', inventory.legacy_count,
    (SELECT count(*) FROM xai_cutover_bindings binding WHERE binding.account_id = inventory.account_id)
    + (SELECT count(*) FROM xai_session_account_pins pin
      WHERE pin.account_id = inventory.account_id
        AND (pin.pinned_credential_id IS NOT NULL OR pin.last_credential_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM pg_temp.subscription_cutover_connection_map map
          WHERE map.account_id = pin.account_id
            AND map.legacy_id = coalesce(pin.pinned_credential_id, pin.last_credential_id))
        AND EXISTS (SELECT 1 FROM sessions session WHERE session.workspace_id = pin.workspace_id
          AND session.id = pin.session_id))
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'session_pin_rows'
  UNION ALL SELECT binding.account_id, 'session_bindings', count(*) FILTER (WHERE binding.moves),
    count(*) FILTER (WHERE binding.moves AND EXISTS (
      SELECT 1 FROM subscription_session_bindings core
      WHERE core.workspace_id = binding.workspace_id AND core.session_id = binding.session_id
        AND core.provider = 'xai' AND core.connection_id = binding.connection_id
        AND core.choice = CASE WHEN binding.explicit THEN 'explicit' ELSE 'automatic' END))
  FROM xai_cutover_bindings binding GROUP BY binding.account_id
  -- Primaries: an organization or local pool rotating off keeps its
  -- alias-resolved active account as primary.
  UNION ALL SELECT rotation.account_id, 'primaries',
    count(*) FILTER (WHERE map.connection_id IS NOT NULL),
    count(*) FILTER (WHERE map.connection_id IS NOT NULL
      AND settings.xai_primary_connection_id = map.connection_id)
  FROM xai_rotation_settings rotation
  LEFT JOIN xai_cutover_shared_map map ON map.account_id = rotation.account_id
   AND map.legacy_id = rotation.active_credential_id
   AND (rotation.authority_scope = 'organization' OR (map.legacy_scope = 'workspace'
     AND map.legacy_workspace_id = rotation.workspace_id))
  LEFT JOIN subscription_settings settings ON settings.account_id = rotation.account_id
   AND settings.workspace_id IS NOT DISTINCT FROM rotation.workspace_id
  WHERE NOT rotation.rotation_enabled AND rotation.authority_scope IN ('organization', 'workspace')
  GROUP BY rotation.account_id
  -- Leases: same turn, holder, generation, expiry and canonical connection.
  UNION ALL SELECT inventory.account_id, 'live_leases', inventory.legacy_count,
    (SELECT count(*) FROM subscription_leases lease
      JOIN xai_cutover_live_leases legacy ON legacy.account_id = lease.account_id
       AND legacy.workspace_id = lease.workspace_id AND legacy.session_id = lease.session_id
       AND legacy.turn_id = lease.turn_id AND legacy.connection_id = lease.connection_id
       AND legacy.holder_id = lease.holder_id AND legacy.generation = lease.generation
       AND legacy.leased_until = lease.leased_until
      WHERE lease.account_id = inventory.account_id AND lease.provider = 'xai')
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'live_leases'
  -- Waiters: every waiting row moved or collapsed; moved ids, generations,
  -- revisions and schedules preserved; pending wakes queued.
  UNION ALL SELECT inventory.account_id, 'waiting_waiters', inventory.legacy_count,
    (SELECT count(*) FROM xai_cutover_waiting_before before
      JOIN xai_capacity_waiters legacy ON legacy.id = before.id AND legacy.status = 'superseded'
      WHERE before.account_id = inventory.account_id)
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'waiting_waiters'
  UNION ALL SELECT moved.account_id, 'waiter_ids', count(*),
    (SELECT count(*) FROM subscription_capacity_waiters core
      JOIN xai_cutover_waiters legacy ON legacy.id = core.waiter_id AND legacy.rank = 1
       AND legacy.account_id = core.account_id AND legacy.session_id = core.session_id
       AND legacy.blocked_turn_id = core.turn_id AND legacy.generation = core.generation
       AND legacy.wake_revision = core.wake_revision
       AND legacy.observed_wake_revision = core.observed_wake_revision
       AND legacy.next_check_at IS NOT DISTINCT FROM core.next_check_at
       AND legacy.earliest_reset_at IS NOT DISTINCT FROM core.earliest_reset_at
       AND legacy.blocked_turn_generation = core.blocked_turn_generation
       AND legacy.goal_id IS NOT DISTINCT FROM core.goal_id
       AND legacy.goal_version IS NOT DISTINCT FROM core.goal_version
       AND left(legacy.last_wake_reason, 128) = core.last_wake_reason
      WHERE core.account_id = moved.account_id AND core.provider = 'xai')
  FROM xai_cutover_waiters moved WHERE moved.rank = 1 GROUP BY moved.account_id
  UNION ALL SELECT core.account_id, 'pending_wakes', count(*),
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscription_capacity_wake_outbox outbox
      WHERE outbox.account_id = core.account_id AND outbox.waiter_id = core.waiter_id
        AND outbox.generation = core.generation AND outbox.wake_revision = core.wake_revision))
  FROM subscription_capacity_waiters core
  WHERE core.provider = 'xai' AND core.wake_revision > core.observed_wake_revision
  GROUP BY core.account_id
  -- Accepted authority: one record per selected carrier, per kind.
  UNION ALL SELECT carrier.account_id, 'compat:' || carrier.carrier_kind, count(*),
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM opengeni_subscription_internal.subscription_compat_record(
        'xai', carrier.carrier_kind, carrier.workspace_id, carrier.carrier_id,
        carrier.task_authority_revision) record))
  FROM xai_cutover_carriers carrier GROUP BY carrier.account_id, carrier.carrier_kind
  -- Every live turn holds a record.
  UNION ALL SELECT inventory.account_id, 'live_turn_authority', inventory.legacy_count,
    (SELECT count(*) FROM session_turns turn
      JOIN sessions session ON session.workspace_id = turn.workspace_id AND session.id = turn.session_id
      WHERE turn.account_id = inventory.account_id
        AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
        AND (session.imported_archive_import_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM opengeni_private.subscription_authority_compat record
          WHERE record.turn_id = turn.id AND record.workspace_id = turn.workspace_id
            AND record.provider = 'xai')))
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'live_turns'
  -- Every source a later copy resolves holds a record.
  UNION ALL SELECT dependent.account_id, 'compat:dependent_sources_without_record', 0,
    count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM opengeni_subscription_internal.subscription_compat_record(
        'xai', dependent.source_kind, dependent.workspace_id, dependent.source_id,
        dependent.source_revision) record))
  FROM xai_cutover_dependent_sources dependent GROUP BY dependent.account_id
  -- In-flight video operations: each one holding an envelope now holds its
  -- connection reference (no token copy); none was left behind.
  UNION ALL SELECT inventory.account_id, 'video_operations_open', inventory.legacy_count,
    (SELECT count(*) FROM xai_cutover_videos video
      JOIN video_generation_operations operation ON operation.id = video.id
      WHERE video.account_id = inventory.account_id
        AND operation.credential_encrypted = video.reference_encrypted
        AND operation.connection_id IS NULL)
      + (SELECT count(*) FROM video_generation_operations operation
        WHERE operation.account_id = inventory.account_id
          AND operation.funding_source = 'supergrok_subscription' AND operation.terminal_at IS NULL
          AND operation.credential_encrypted IS NULL)
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'video_operations_open'
  -- In-flight image operations keep their recorded identity unchanged.
  UNION ALL SELECT inventory.account_id, 'image_operations_open', inventory.legacy_count,
    (SELECT count(*) FROM image_generation_operations operation
      WHERE operation.account_id = inventory.account_id
        AND operation.provider_id = 'supergrok-subscription'
        AND operation.status IN ('prepared', 'provider_started'))
  FROM xai_cutover_inventory inventory WHERE inventory.metric = 'image_operations_open'
  -- Activation coverage.
  UNION ALL SELECT NULL, 'xai_cutover_rows', (SELECT count(*) FROM managed_accounts),
    (SELECT count(*) FROM subscription_provider_cutovers WHERE provider = 'xai' AND enabled);

INSERT INTO opengeni_private.subscription_cutover_report (
  provider, metric, account_id, legacy_count, core_count
)
SELECT 'xai', metric, account_id, legacy_count, core_count FROM xai_cutover_parity
UNION ALL
SELECT 'xai', 'disposition:' || disposition, account_id, count, count
FROM pg_temp.subscription_cutover_dispositions
UNION ALL
SELECT 'xai', 'disposition:personal_connections_disallowed', map.account_id,
  count(DISTINCT map.connection_id), count(DISTINCT map.connection_id)
FROM pg_temp.subscription_cutover_connection_map map
JOIN subscription_settings org ON org.account_id = map.account_id AND org.workspace_id IS NULL
WHERE map.ownership = 'personal' AND NOT org.personal_connections_allowed
GROUP BY map.account_id
UNION ALL
SELECT 'xai', 'disposition:' || record.disposition, record.account_id, count(*), count(*)
FROM xai_cutover_records record WHERE record.disposition IS NOT NULL
GROUP BY record.account_id, record.disposition
UNION ALL
SELECT 'xai', 'disposition:' || CASE
    WHEN NOT binding.eligible THEN 'pin_owner_ineligible'
    WHEN NOT binding.pool_in_effect THEN 'pin_pool_not_in_effect'
    ELSE 'pin_other_provider_binding_kept' END,
  binding.account_id, count(*), count(*)
FROM xai_cutover_bindings binding WHERE NOT binding.moves
GROUP BY binding.account_id, 2
UNION ALL
SELECT 'xai', 'disposition:pin_target_unmapped', pin.account_id, count(*), count(*)
FROM xai_session_account_pins pin
WHERE (pin.pinned_credential_id IS NOT NULL OR pin.last_credential_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM pg_temp.subscription_cutover_connection_map map
    WHERE map.account_id = pin.account_id
      AND map.legacy_id = coalesce(pin.pinned_credential_id, pin.last_credential_id))
GROUP BY pin.account_id
UNION ALL
SELECT 'xai', 'disposition:user_rotation_dropped', rotation.account_id, count(*), count(*)
FROM xai_rotation_settings rotation WHERE rotation.authority_scope = 'user'
GROUP BY rotation.account_id
UNION ALL
SELECT 'xai', 'disposition:personal_rotation_dropped', ws.account_id, count(*), count(*)
FROM xai_cutover_workspace_settings ws WHERE ws.rotation_id IS NOT NULL AND NOT ws.has_local_shared
GROUP BY ws.account_id
UNION ALL
SELECT 'xai', 'disposition:fairness_cursor_dropped', rotation.account_id, count(*), count(*)
FROM xai_rotation_settings rotation WHERE rotation.fairness_cursor > 0
GROUP BY rotation.account_id
UNION ALL
SELECT 'xai', 'disposition:personal_fallback_locked_off', ws.account_id, count(*), count(*)
FROM xai_cutover_workspace_settings ws
JOIN subscription_settings org ON org.account_id = ws.account_id AND org.workspace_id IS NULL
WHERE ws.personal AND ws.has_moved_personal
  AND 'personalFallbackAllowed' = ANY(org.locked_settings) AND NOT org.personal_fallback_allowed
GROUP BY ws.account_id
UNION ALL
SELECT 'xai', 'disposition:expired_leases_dropped', lease.account_id, count(*), count(*)
FROM xai_credential_leases lease
WHERE lease.leased_until <= now() GROUP BY lease.account_id
UNION ALL
SELECT 'xai', 'disposition:waiters_collapsed', before.account_id, count(*), count(*)
FROM xai_cutover_waiting_before before
WHERE NOT EXISTS (SELECT 1 FROM xai_cutover_waiters moved WHERE moved.id = before.id AND moved.rank = 1)
GROUP BY before.account_id
UNION ALL
SELECT 'xai', 'disposition:video_operation_unmapped', video.account_id, count(*), count(*)
FROM xai_cutover_videos video WHERE video.connection_id IS NULL
GROUP BY video.account_id
-- Impact before the window: carriers whose work will wait for capacity it
-- can no longer reach (accepted_authority_unavailable at the deadline).
UNION ALL
SELECT 'xai', 'compat:carriers_that_will_wait', record.account_id, count(*), count(*)
FROM xai_cutover_records record
WHERE (record.personal = '[]'::jsonb AND record.shared_pool = 'none')
  OR (record.legacy_scope = 'user' AND record.personal <> '[]'::jsonb
    AND record.carrier_kind IN ('session_initial', 'session_turn', 'session_system_update',
      'session_system_update_outbox')
    AND NOT record.private AND NOT EXISTS (SELECT 1 FROM organization_memberships owner
      WHERE owner.account_id = record.account_id AND owner.id = record.human_membership_id
        AND owner.personal_workspace_id = record.workspace_id))
  OR (record.legacy_scope = 'workspace' AND record.personal = '[]'::jsonb
    AND EXISTS (SELECT 1 FROM xai_cutover_workspace_settings ws
      WHERE ws.account_id = record.account_id AND ws.workspace_id = record.workspace_id
        AND ws.personal AND ws.has_moved_personal))
GROUP BY record.account_id;

-- Readiness count (0712's metric for this provider): owners whose active,
-- serviceable personal SuperGrok connections carry more than one current
-- authority generation. Zero by construction; recorded for the operator.
WITH owners AS (
  SELECT connection.account_id, connection.owner_organization_membership_id
  FROM subscription_connections connection
  JOIN organization_user_resource_authorities authority
    ON authority.id = connection.authority_id
    AND authority.account_id = connection.account_id
    AND authority.organization_membership_id = connection.owner_organization_membership_id
    AND authority.resource_kind = 'subscription_connection'
    AND authority.resource_id = connection.id
    AND authority.generation = connection.authority_generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL
  WHERE connection.provider = 'xai' AND connection.ownership = 'personal'
    AND connection.status = 'active'
  GROUP BY connection.account_id, connection.owner_organization_membership_id
  HAVING count(DISTINCT connection.authority_generation) > 1
)
INSERT INTO opengeni_private.subscription_cutover_report (
  provider, metric, account_id, legacy_count, core_count
)
SELECT 'xai', 'readiness:owners_with_multiple_current_personal_generations', NULL, 0,
  (SELECT count(*) FROM owners);

-- Expired legacy leases were recorded above as dropped and live ones moved:
-- none stays behind for a fallback reader to find.
DELETE FROM xai_credential_leases;

DO $xai_cutover_parity_check$
DECLARE mismatches text;
BEGIN
  SELECT string_agg(DISTINCT metric, ', ' ORDER BY metric) INTO mismatches
  FROM xai_cutover_parity WHERE legacy_count <> core_count;
  IF mismatches IS NOT NULL THEN
    RAISE EXCEPTION '0716 parity mismatch (%)', mismatches USING ERRCODE = '55000';
  END IF;
  -- Zero-row success is invalid: a source with rows must yield a non-empty
  -- target, and every counted source was counted inside the owner window.
  IF EXISTS (SELECT 1 FROM xai_cutover_inventory WHERE legacy_count > 0
      AND metric LIKE 'credentials_%')
    AND NOT EXISTS (SELECT 1 FROM subscription_connections WHERE provider = 'xai') THEN
    RAISE EXCEPTION '0716 parity mismatch (zero_row_backfill)' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_parity_check$;

-- Validate deferred foreign keys before restoring trigger modes.
SET CONSTRAINTS ALL IMMEDIATE;

DO $xai_cutover_restore$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM xai_cutover_triggers LOOP
    EXECUTE format('ALTER TABLE %s %s TRIGGER %I', item.tgrelid::regclass,
      CASE item.tgenabled WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA'
        WHEN 'D' THEN 'DISABLE' ELSE 'ENABLE' END, item.tgname);
  END LOOP;
  FOR item IN SELECT * FROM xai_cutover_relations WHERE relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', item.oid::regclass);
  END LOOP;
  IF EXISTS (SELECT 1 FROM xai_cutover_relations r JOIN pg_class c ON c.oid = r.oid
    WHERE r.relforcerowsecurity AND NOT c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0716 could not restore FORCE row security' USING ERRCODE = '55000';
  END IF;
END $xai_cutover_restore$;

-- Read-only legacy (design 5.3 "Read-only legacy"). The legacy
-- `xai_subscription` resource authorities stay for forensics, and membership
-- lifecycle keeps revoking, retaining and restoring them with every other
-- authority of a member; after the receipt no role adds one (the legacy
-- connect routines run as the owner, which FORCE row security binds too).
-- Runtime write grants on the factory tables are withdrawn by
-- provision-roles and asserted by the runtime posture contract.
DO $xai_cutover_read_only$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE POLICY xai_subscription_authority_closed
    ON %1$I.organization_user_resource_authorities AS RESTRICTIVE FOR INSERT
    WITH CHECK (resource_kind <> 'xai_subscription'
      OR NOT opengeni_private.subscription_provider_cutover_committed('xai'))
  $ddl$, data_schema);
END $xai_cutover_read_only$;
