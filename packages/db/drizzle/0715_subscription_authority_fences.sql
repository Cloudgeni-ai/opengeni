-- deployment-mode: rolling
-- M4 PR 0b, part 2: the fences compare subscription authority (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "v1 columns after a
-- provider's cutover", "PR 0b: authority compatibility and fences" and
-- "Findings in earlier merged work", rows 2 and 3).
--
-- 1. The 0608 inbox fence compares the delivering turn's v2 value with its
--    delivery source (0713's delivery resolver: a pure goal continuation reads
--    the goal's causal turn, any other delivery the receiving context), and
--    each delivered causal update's v2 value with the turn's. After a
--    provider's receipt it also compares the provider's effective authority.
-- 2. Scheduled occurrences compare v2 with the value their firing copies, and
--    the occurrence and turn-execution fences keep v2 immutable.
-- 3. The missing Claude comparisons: the run's accepted Claude snapshot and
--    causal subject at admission, the occurrence, the occurrence update, the
--    turn-execution fence and the generated session's initial snapshot.
-- 4. `scheduled_claude_authority_changed` in
--    validate_scheduled_agent_run_live_authority (inherited by 0447, 0452,
--    0459 and the scheduled claim), and the receipt switch: after a
--    provider's receipt its v1 check is replaced by the core check on the
--    run's v2 entry or compatibility record, with the same code.
-- 5. Defects in earlier merged work: the 0608 definer routines searched
--    pg_temp first, the turn-execution trigger missed the Claude and v2
--    columns, 0598 missed the Claude membership lock policy (a personal
--    Claude connect fails under an owner without BYPASSRLS), and no policy
--    let a personal SuperGrok or Claude disconnect revoke its authority under
--    such an owner (6: the policies, and a repair of the authorities left
--    active).
--
-- Acts on deploy: the v2 comparisons (live for Codex) and the Claude
-- comparisons, the disconnect revoke and its repair. The receipt switch and
-- the effective-authority comparisons are inert until a provider's own
-- drained cutover writes a receipt with a real commit time. Every patch is an
-- anchored replacement of the live definition; each anchor must occur exactly
-- once.
SET LOCAL lock_timeout = '5s';

DO $prerequisite$
BEGIN
  IF to_regprocedure('opengeni_private.subscription_authority_compat_providers()') IS NULL
    OR to_regprocedure(
      'opengeni_subscription_internal.subscription_compat_delivery_sources(uuid,uuid,uuid,uuid,text)') IS NULL
    OR to_regprocedure(
      'opengeni_subscription_internal.subscription_compat_effective(text,text,uuid,uuid,bigint)') IS NULL
    OR to_regprocedure(
      'opengeni_subscription_internal.subscription_compat_expected(text,timestamptz,uuid,text,uuid,bigint,text)') IS NULL
  THEN
    RAISE EXCEPTION '0715 requires the 0713 accepted authority compatibility routines'
      USING ERRCODE = '55000';
  END IF;
END
$prerequisite$;

-- A copied v2 value matches its source's: the same value, or, when the source
-- froze none, none or the empty value (a writer stores the empty value once
-- the Codex cutover is enabled; a missing value never widens).
CREATE FUNCTION opengeni_subscription_internal.subscription_v2_copy_matches(
  p_value jsonb, p_expected jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $body$
  SELECT CASE WHEN p_expected IS NULL
    THEN p_value IS NULL OR p_value = '{"version":2,"personal":[]}'::jsonb
    ELSE p_value IS NOT DISTINCT FROM p_expected END
$body$;

-- Path: scheduled firing, v2 half (getScheduledTaskSubscriptionAuthority). The
-- revision's frozen value, narrowed to the empty value when it holds a
-- personal entry and the revision's authorizer is not the task owner. NULL
-- without the revision row or for a deleted task (the writer then freezes
-- none). 0713's scheduled resolver applies the same rule to records.
CREATE FUNCTION opengeni_subscription_internal.subscription_scheduled_firing_v2(
  p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint)
RETURNS jsonb
LANGUAGE sql STABLE
AS $body$
  SELECT CASE
    WHEN revision.subscription_authority IS NULL THEN NULL
    WHEN jsonb_typeof(revision.subscription_authority -> 'personal') = 'array'
      AND jsonb_array_length(revision.subscription_authority -> 'personal') > 0
      AND revision.subject_id IS DISTINCT FROM task.owner_subject_id
    THEN '{"version":2,"personal":[]}'::jsonb
    ELSE revision.subscription_authority
  END
  FROM scheduled_tasks task
  JOIN scheduled_task_revision_authorities revision ON revision.account_id = task.account_id
    AND revision.workspace_id = task.workspace_id AND revision.task_id = task.id
    AND revision.task_authority_revision = p_task_authority_revision
  WHERE task.account_id = p_account_id AND task.workspace_id = p_workspace_id
    AND task.id = p_task_id AND task.deleted_at IS NULL
$body$;

-- A personal entry ({provider, ownerMembershipId, authorityGeneration} and,
-- for a compatibility record, connectionIds) is live when one of its
-- connections is serviceable at the entry's generation: an active personal
-- connection of that provider owned by the entry's active membership, whose
-- current authority row is active at that generation (the personal helpers'
-- connection rule) and, for a record, one the record lists.
-- Its callers run as the owner, whom FORCE RLS binds: connections,
-- memberships and authorities are read through the owner-only
-- membership-lifecycle read (a marker, so a read-only caller keeps working),
-- and the caller's marker is restored before returning.
CREATE FUNCTION opengeni_subscription_internal.subscription_personal_entry_serviceable(
  p_account_id uuid, p_entry jsonb)
RETURNS boolean
LANGUAGE plpgsql
AS $body$
DECLARE
  prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  serviceable boolean;
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true);
  SELECT EXISTS (
    SELECT 1
    FROM subscription_connections connection
    JOIN organization_memberships membership ON membership.id = connection.owner_organization_membership_id
      AND membership.account_id = connection.account_id
    JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
      AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
      AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
      AND authority.generation = connection.authority_generation AND authority.status = 'active'
      AND authority.revoked_at IS NULL
    WHERE connection.account_id = p_account_id
      AND connection.provider = p_entry ->> 'provider'
      AND connection.ownership = 'personal'
      AND connection.status = 'active'
      AND connection.owner_organization_membership_id::text = p_entry ->> 'ownerMembershipId'
      AND connection.authority_generation::text = p_entry ->> 'authorityGeneration'
      AND membership.status = 'active' AND membership.revoked_at IS NULL
      AND (NOT p_entry ? 'connectionIds' OR p_entry -> 'connectionIds' ? connection.id::text))
  INTO serviceable;
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    coalesce(prior_lifecycle, ''), true);
  RETURN serviceable;
END
$body$;

-- The personal entries a scheduled run carries, one per provider whose own
-- drained cutover holds records: the firing's v2 entry, else the personal
-- entry of the revision's compatibility record as the occurrence copies it
-- (0713's scheduled resolver and copy rule). Empty while no provider has a
-- receipt with a real commit time.
CREATE FUNCTION opengeni_subscription_internal.subscription_scheduled_run_personal_entries(
  p_account_id uuid, p_workspace_id uuid, p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
AS $body$
DECLARE
  run_task uuid;
  run_revision bigint;
  provider_name text;
  receipt_time timestamptz;
  firing jsonb;
  personal_entry jsonb;
  scheduled_source record;
  expected_copy record;
  entries jsonb := '[]'::jsonb;
BEGIN
  SELECT run.task_id, run.task_authority_revision INTO run_task, run_revision
  FROM scheduled_task_runs run
  WHERE run.account_id = p_account_id AND run.workspace_id = p_workspace_id AND run.id = p_run_id;
  IF run_task IS NULL THEN RETURN entries; END IF;
  firing := opengeni_subscription_internal.subscription_scheduled_firing_v2(
    p_account_id, p_workspace_id, run_task, run_revision);
  SELECT * INTO scheduled_source
  FROM opengeni_subscription_internal.subscription_compat_scheduled_source(p_workspace_id, p_run_id);
  FOR provider_name IN
    SELECT listed.value FROM pg_catalog.unnest(opengeni_private.subscription_authority_compat_providers()) listed(value)
  LOOP
    personal_entry := NULL;
    SELECT candidate.value INTO personal_entry
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(firing -> 'personal') = 'array'
      THEN firing -> 'personal' ELSE '[]'::jsonb END) candidate(value)
    WHERE candidate.value ->> 'provider' = provider_name;
    IF personal_entry IS NULL THEN
      SELECT receipt.committed_at INTO receipt_time
      FROM opengeni_private.subscription_provider_cutover_receipts receipt
      WHERE receipt.provider = provider_name;
      SELECT * INTO expected_copy FROM opengeni_subscription_internal.subscription_compat_expected(
        provider_name, receipt_time, p_workspace_id, scheduled_source.source_kind,
        scheduled_source.source_id, scheduled_source.source_revision, scheduled_source.causal_human);
      IF expected_copy.has_record AND jsonb_array_length(expected_copy.personal) > 0 THEN
        personal_entry := (expected_copy.personal -> 0) || jsonb_build_object('provider', provider_name);
      END IF;
    END IF;
    IF personal_entry IS NOT NULL THEN
      entries := entries || jsonb_build_array(personal_entry);
    END IF;
  END LOOP;
  RETURN entries;
END
$body$;

-- 1. The 0608 inbox fence. The delivering turn copies its delivery source's
-- v2 value: for a pure goal continuation the goal's causal turn (only with
-- the same human, else none), otherwise the receiving context turn; a source
-- that froze none allows none or the empty value. A delivered causal update
-- that froze a value must carry the turn's value (an update that froze none
-- follows the context, as the planner batches it). After a provider's
-- receipt each causal update's effective authority for that provider must
-- equal the context turn's, unless it froze none and is post-receipt work
-- without a record (the same exception). Agent messages and child results
-- stay checked by human only.
DO $inbox_fence$
DECLARE definition text; anchor text; replacement text; patch text[];
BEGIN
  definition := pg_get_functiondef('opengeni_private.fence_inbox_execution_context()'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$  origin session_turns%ROWTYPE; origin_session sessions%ROWTYPE;
BEGIN
$old$, $new$  origin session_turns%ROWTYPE; origin_session sessions%ROWTYPE;
  pure_goal boolean := true; goal_turn uuid; expected_v2 jsonb; delivery_source record;
  providers text[];
BEGIN
$new$],
    ARRAY[$old$  human := coalesce(context.initiating_human_subject_id,
    CASE WHEN context.initiator_kind = 'subject' THEN context.initiator_subject_id END);
$old$, $new$  human := coalesce(context.initiating_human_subject_id,
    CASE WHEN context.initiator_kind = 'subject' THEN context.initiator_subject_id END);
  FOR delivery_source IN SELECT * FROM opengeni_subscription_internal.subscription_compat_delivery_sources(
    NEW.workspace_id, NEW.session_id, NEW.id, NEW.execution_context_turn_id, NEW.initiating_human_subject_id)
  LOOP
    IF delivery_source.path = 'pure_goal_continuation' THEN goal_turn := delivery_source.source_id;
    ELSIF delivery_source.path = 'informational_delivery' THEN pure_goal := false; END IF;
  END LOOP;
  IF pure_goal THEN
    SELECT goal_source.subscription_authority INTO expected_v2 FROM session_turns goal_source
    WHERE goal_source.workspace_id = NEW.workspace_id AND goal_source.session_id = NEW.session_id
      AND goal_source.id = goal_turn;
  ELSE
    expected_v2 := context.subscription_authority;
  END IF;
  providers := opengeni_private.subscription_authority_compat_providers();
$new$],
    ARRAY[$old$    OR NEW.claude_provider_account_authority_snapshot IS DISTINCT FROM context.claude_provider_account_authority_snapshot
$old$, $new$    OR NEW.claude_provider_account_authority_snapshot IS DISTINCT FROM context.claude_provider_account_authority_snapshot
    OR NOT opengeni_subscription_internal.subscription_v2_copy_matches(NEW.subscription_authority, expected_v2)
$new$],
    ARRAY[$old$        OR u.claude_provider_account_authority_snapshot IS DISTINCT FROM NEW.claude_provider_account_authority_snapshot
$old$, $new$        OR u.claude_provider_account_authority_snapshot IS DISTINCT FROM NEW.claude_provider_account_authority_snapshot
        OR (NOT pure_goal AND u.subscription_authority IS NOT NULL
          AND u.subscription_authority IS DISTINCT FROM NEW.subscription_authority)
        OR (NOT pure_goal AND EXISTS (
          SELECT 1 FROM pg_catalog.unnest(providers) provider(value)
          CROSS JOIN LATERAL (SELECT
            opengeni_subscription_internal.subscription_compat_effective(
              provider.value, 'session_system_update', NEW.workspace_id, u.id, NULL) AS of_update,
            opengeni_subscription_internal.subscription_compat_effective(
              provider.value, 'session_turn', NEW.workspace_id, context.id, NULL) AS of_context) effective
          WHERE NOT (u.subscription_authority IS NULL
              AND effective.of_update = '{"authority":"none"}'::jsonb)
            AND effective.of_update IS DISTINCT FROM effective.of_context))
$new$]
  ] LOOP
    anchor := patch[1];
    replacement := patch[2];
    IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
      RAISE EXCEPTION 'fence_inbox_execution_context anchor changed: %', left(anchor, 80);
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$inbox_fence$;

-- 2. Scheduled occurrences: the accepted Claude snapshot and causal subject,
-- and the v2 value the firing copies (from the accepted revision, or the
-- run's revision after a reusable-connection materialization).
DO $occurrence_fence$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('validate_scheduled_occurrence_accepted_execution()'::regprocedure);
  anchor := $old$    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
$old$;
  replacement := $new$    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
    OR NEW.claude_provider_account_authority_snapshot
      IS DISTINCT FROM coalesce(accepted -> 'claudeProviderAccountAuthoritySnapshot',
        '{"version":1,"scope":"workspace"}'::jsonb)
    OR NEW.lineage ->> 'claudeAuthoritySubjectId'
      IS DISTINCT FROM accepted ->> 'claudeAuthoritySubjectId'
    OR NOT (
      opengeni_subscription_internal.subscription_v2_copy_matches(NEW.subscription_authority,
        opengeni_subscription_internal.subscription_scheduled_firing_v2(NEW.account_id,
          NEW.workspace_id, run_row.task_id, (task_snapshot ->> 'authorityRevision')::bigint))
      OR opengeni_subscription_internal.subscription_v2_copy_matches(NEW.subscription_authority,
        opengeni_subscription_internal.subscription_scheduled_firing_v2(NEW.account_id,
          NEW.workspace_id, run_row.task_id, run_row.task_authority_revision)))
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_occurrence_accepted_execution anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$occurrence_fence$;

-- The accepted occurrence and the scheduled turn keep their Claude snapshot
-- and v2 value (the generic immutability triggers exempt the table owner for
-- v2; these fences bind every role, as they do for xAI).
DO $immutable_fences$
DECLARE definition text; routine regprocedure; anchor text; replacement text;
BEGIN
  anchor := $old$    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM OLD.xai_provider_account_authority_snapshot
$old$;
  replacement := $new$    OR NEW.xai_provider_account_authority_snapshot
      IS DISTINCT FROM OLD.xai_provider_account_authority_snapshot
    OR NEW.claude_provider_account_authority_snapshot
      IS DISTINCT FROM OLD.claude_provider_account_authority_snapshot
    OR NEW.subscription_authority IS DISTINCT FROM OLD.subscription_authority
$new$;
  FOREACH routine IN ARRAY ARRAY[
    'fence_scheduled_occurrence_update()',
    'fence_scheduled_turn_execution_update()'
  ]::regprocedure[] LOOP
    definition := pg_get_functiondef(routine);
    IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
      RAISE EXCEPTION '% anchor changed', routine;
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END LOOP;
END
$immutable_fences$;

-- 3. Admission: the accepted Claude snapshot is the task's (40001 when it
-- changed during admission), and its causal subject is the task owner for a
-- `user` snapshot and absent otherwise, never another human than a `user`
-- xAI snapshot's (42501), as the scheduled dispatcher computes them.
DO $admission_fence$
DECLARE definition text; anchor text; replacement text; patch text[];
BEGIN
  definition := pg_get_functiondef('admit_scheduled_agent_run_execution()'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$    OR NEW.accepted_execution_snapshot -> 'xaiProviderAccountAuthoritySnapshot'
      IS DISTINCT FROM task_row.xai_provider_account_authority_snapshot
$old$, $new$    OR NEW.accepted_execution_snapshot -> 'xaiProviderAccountAuthoritySnapshot'
      IS DISTINCT FROM task_row.xai_provider_account_authority_snapshot
    OR coalesce(NEW.accepted_execution_snapshot -> 'claudeProviderAccountAuthoritySnapshot',
        '{"version":1,"scope":"workspace"}'::jsonb)
      IS DISTINCT FROM task_row.claude_provider_account_authority_snapshot
$new$],
    ARRAY[$old$    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' <> 'user'
      AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId' IS NOT NULL
    )
$old$, $new$    OR (
      task_row.xai_provider_account_authority_snapshot ->> 'scope' <> 'user'
      AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId' IS NOT NULL
    )
    OR (
      task_row.claude_provider_account_authority_snapshot ->> 'scope' = 'user'
      AND (
        task_row.owner_subject_id IS NULL
        OR NEW.accepted_execution_snapshot ->> 'claudeAuthoritySubjectId'
          IS DISTINCT FROM task_row.owner_subject_id
        OR (
          task_row.xai_provider_account_authority_snapshot ->> 'scope' = 'user'
          AND NEW.accepted_execution_snapshot ->> 'xaiAuthoritySubjectId'
            IS DISTINCT FROM task_row.owner_subject_id
        )
      )
    )
    OR (
      task_row.claude_provider_account_authority_snapshot ->> 'scope' <> 'user'
      AND NEW.accepted_execution_snapshot ->> 'claudeAuthoritySubjectId' IS NOT NULL
    )
$new$]
  ] LOOP
    anchor := patch[1];
    replacement := patch[2];
    IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
      RAISE EXCEPTION 'admit_scheduled_agent_run_execution anchor changed: %', left(anchor, 80);
    END IF;
    definition := replace(definition, anchor, replacement);
  END LOOP;
  EXECUTE definition;
END
$admission_fence$;

-- The generated session's initial Claude snapshot is the accepted one.
DO $generated_session_fence$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('fence_scheduled_task_run_connection_session_identity()'::regprocedure);
  anchor := $old$        OR session_row.initial_xai_provider_account_authority_snapshot
          IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
$old$;
  replacement := $new$        OR session_row.initial_xai_provider_account_authority_snapshot
          IS DISTINCT FROM accepted -> 'xaiProviderAccountAuthoritySnapshot'
        OR session_row.initial_claude_provider_account_authority_snapshot
          IS DISTINCT FROM coalesce(accepted -> 'claudeProviderAccountAuthoritySnapshot',
            '{"version":1,"scope":"workspace"}'::jsonb)
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'fence_scheduled_task_run_connection_session_identity anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$generated_session_fence$;

-- 4. Live authority. `scheduled_claude_authority_changed` mirrors
-- `scheduled_xai_authority_changed` (the accepted `user` generation of the
-- causal membership's legacy authority, locked in the same order). Each v1
-- check applies only before its provider's receipt; afterwards every
-- personal entry the run carries (its firing's v2 entry or the revision's
-- record) must be serviceable at its generation, with the same code.
-- One block per anchor, each patching the definition the previous one left.
DO $live_authority_declarations$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  snapshot record;
BEGIN
$old$;
  replacement := $new$  snapshot record;
  receipt_providers text[] := opengeni_private.subscription_authority_compat_providers();
  core_entries jsonb := '[]'::jsonb;
  core_entry jsonb;
BEGIN
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority anchor changed: declarations';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$live_authority_declarations$;

DO $live_authority_core_entries$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  causal := accepted -> 'causalHumanAuthority';
$old$;
  replacement := $new$  causal := accepted -> 'causalHumanAuthority';
  IF cardinality(receipt_providers) > 0 THEN
    core_entries := opengeni_subscription_internal.subscription_scheduled_run_personal_entries(
      p_account_id, p_workspace_id, p_run_id);
  END IF;
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority anchor changed: core entries';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$live_authority_core_entries$;

DO $live_authority_locks$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$        AND xai_authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
    )
$old$;
  replacement := $new$        AND xai_authority.generation =
          (accepted -> 'xaiProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
      UNION
      SELECT claude_authority.id
      FROM organization_user_resource_authorities claude_authority
      WHERE accepted -> 'claudeProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
        AND causal IS NOT NULL AND causal <> 'null'::jsonb
        AND claude_authority.account_id = p_account_id
        AND claude_authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND claude_authority.resource_kind = 'claude_subscription'
        AND claude_authority.generation =
          (accepted -> 'claudeProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
      UNION
      SELECT core_authority.id
      FROM organization_user_resource_authorities core_authority
      JOIN jsonb_array_elements(core_entries) core(entry)
        ON core_authority.organization_membership_id::text = core.entry ->> 'ownerMembershipId'
      WHERE core_authority.account_id = p_account_id
        AND core_authority.resource_kind = 'subscription_connection'
        AND core_authority.generation::text = core.entry ->> 'authorityGeneration'
    )
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority anchor changed: locks';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$live_authority_locks$;

DO $live_authority_xai_switch$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  IF accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
    AND NOT EXISTS (
$old$;
  replacement := $new$  IF accepted -> 'xaiProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
    AND NOT 'xai' = ANY(receipt_providers)
    AND NOT EXISTS (
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority anchor changed: xai switch';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$live_authority_xai_switch$;

DO $live_authority_claude$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef(
    'validate_scheduled_agent_run_live_authority(uuid,uuid,uuid)'::regprocedure);
  anchor := $old$  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_xai_authority_changed'; END IF;
$old$;
  replacement := $new$  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_xai_authority_changed'; END IF;
  IF accepted -> 'claudeProviderAccountAuthoritySnapshot' ->> 'scope' = 'user'
    AND NOT 'claude' = ANY(receipt_providers)
    AND NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.account_id = p_account_id
        AND authority.organization_membership_id =
          (causal ->> 'organizationMembershipId')::uuid
        AND authority.resource_kind = 'claude_subscription'
        AND authority.generation =
          (accepted -> 'claudeProviderAccountAuthoritySnapshot'
            ->> 'authorityGeneration')::bigint
        AND authority.status = 'active'
        AND authority.revoked_at IS NULL
    )
  THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_claude_authority_changed'; END IF;
  FOR core_entry IN SELECT listed.value FROM jsonb_array_elements(core_entries) listed(value) LOOP
    IF NOT opengeni_subscription_internal.subscription_personal_entry_serviceable(p_account_id, core_entry)
    THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(sender_prior_lifecycle, ''), true); RETURN 'scheduled_' || (core_entry ->> 'provider') || '_authority_changed'; END IF;
  END LOOP;
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_agent_run_live_authority anchor changed: claude';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$live_authority_claude$;

-- Search paths: the new owner-only helpers and the three 0608 routines, which
-- are SECURITY DEFINER but kept the migration's search path (`$user`,
-- public), so pg_temp was searched first. The data schema of this
-- deployment, opengeni_private, and pg_temp last. No runtime grants: only
-- owner-run fences and functions call the helpers.
DO $fence_search_paths$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'opengeni_subscription_internal.subscription_v2_copy_matches(jsonb,jsonb)',
    'opengeni_subscription_internal.subscription_scheduled_firing_v2(uuid,uuid,uuid,bigint)',
    'opengeni_subscription_internal.subscription_personal_entry_serviceable(uuid,jsonb)',
    'opengeni_subscription_internal.subscription_scheduled_run_personal_entries(uuid,uuid,uuid)',
    'opengeni_private.fence_session_execution_context()',
    'opengeni_private.advance_session_execution_context()',
    'opengeni_private.fence_inbox_execution_context()'
  ]::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      routine, data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
END
$fence_search_paths$;

-- 5. Defect in 0598: its Claude copy of the xAI policies on
-- organization_memberships took only `xai_subscription_capability_%` and
-- missed 0442's `xai_subscription_membership_lock`. FORCE RLS requires an
-- UPDATE policy for the membership lock in create_claude_subscription_credential,
-- so under an owner without BYPASSRLS connecting a personal (`user`) Claude
-- account fails with 42501. The same policy for Claude's lifecycle
-- capability: it permits only the lock (WITH CHECK false forbids a rewrite).
-- Near the end, so the organization_memberships lock is held only until
-- commit.
CREATE POLICY claude_subscription_membership_lock ON organization_memberships
  FOR UPDATE USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class
       WHERE oid = 'organization_memberships'::regclass)
    )
    AND EXISTS (
      SELECT 1 FROM opengeni_private.claude_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle'
    )
  ) WITH CHECK (false);

-- 6. Defect in 0234/0442 and 0598: disconnecting a personal (`user`)
-- SuperGrok or Claude account deletes the credential and then revokes its
-- authority row, but no policy lets the provider's lifecycle capability
-- update organization_user_resource_authorities. Under an owner without
-- BYPASSRLS the revoke matched no row: the credential is gone, its authority
-- stays active, and a run accepted for the disconnected account keeps
-- passing the `user` generation check (`scheduled_xai_authority_changed`,
-- and from this migration `scheduled_claude_authority_changed`). Each policy
-- permits only revoking the provider's own kind, as Codex's
-- subscription_codex_owner_authority_revoke does.
CREATE POLICY xai_subscription_capability_revoke ON organization_user_resource_authorities
  FOR UPDATE USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class
       WHERE oid = 'organization_user_resource_authorities'::regclass)
    )
    AND resource_kind = 'xai_subscription'
    AND EXISTS (
      SELECT 1 FROM opengeni_private.xai_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle'
    )
  ) WITH CHECK (resource_kind = 'xai_subscription' AND status = 'revoked');
CREATE POLICY claude_subscription_capability_revoke ON organization_user_resource_authorities
  FOR UPDATE USING (
    current_user = pg_catalog.pg_get_userbyid(
      (SELECT relowner FROM pg_catalog.pg_class
       WHERE oid = 'organization_user_resource_authorities'::regclass)
    )
    AND resource_kind = 'claude_subscription'
    AND EXISTS (
      SELECT 1 FROM opengeni_private.claude_subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle'
    )
  ) WITH CHECK (resource_kind = 'claude_subscription' AND status = 'revoked');

-- The repair revokes the active authorities those disconnects left: no
-- credential holds the authority's resource id (every connect mints the
-- authority with the new credential's id). Retained authorities of
-- offboarded members are left as they are. The credential tables are read
-- in the same owner-only window: an owner bound by their policies would see
-- no credential and revoke every live authority.
ALTER TABLE organization_user_resource_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_subscription_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_subscription_credentials NO FORCE ROW LEVEL SECURITY;
UPDATE organization_user_resource_authorities authority
SET status = 'revoked', revoked_at = now(), updated_at = now()
WHERE authority.status = 'active'
  AND ((authority.resource_kind = 'xai_subscription' AND NOT EXISTS (
      SELECT 1 FROM xai_subscription_credentials credential
      WHERE credential.id = authority.resource_id))
    OR (authority.resource_kind = 'claude_subscription' AND NOT EXISTS (
      SELECT 1 FROM claude_subscription_credentials credential
      WHERE credential.id = authority.resource_id)));
DO $disconnected_authorities$
BEGIN
  IF EXISTS (
    SELECT 1 FROM organization_user_resource_authorities authority
    WHERE authority.status = 'active'
      AND ((authority.resource_kind = 'xai_subscription' AND NOT EXISTS (
          SELECT 1 FROM xai_subscription_credentials credential
          WHERE credential.id = authority.resource_id))
        OR (authority.resource_kind = 'claude_subscription' AND NOT EXISTS (
          SELECT 1 FROM claude_subscription_credentials credential
          WHERE credential.id = authority.resource_id)))
  ) THEN
    RAISE EXCEPTION '0715 left a disconnected personal subscription authority active'
      USING ERRCODE = '55000';
  END IF;
END
$disconnected_authorities$;
ALTER TABLE claude_subscription_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_subscription_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_user_resource_authorities FORCE ROW LEVEL SECURITY;

-- The turn-execution fence also fires for Claude snapshot and v2 updates.
-- Last, so the session_turns lock is held only until commit.
DO $turn_execution_trigger$
DECLARE expected text := 'CREATE TRIGGER scheduled_turn_execution_immutable BEFORE UPDATE OF model, '
  'reasoning_effort, latency_mode, tools, sandbox_backend, sandbox_os, initiating_human_subject_id, '
  'personal_connection_delegations, xai_provider_account_authority_snapshot ON %I.session_turns '
  'FOR EACH ROW EXECUTE FUNCTION %s';
  installed text;
BEGIN
  SELECT pg_get_triggerdef(trigger_value.oid) INTO installed
  FROM pg_trigger trigger_value
  WHERE trigger_value.tgrelid = 'session_turns'::regclass
    AND trigger_value.tgname = 'scheduled_turn_execution_immutable';
  IF installed IS DISTINCT FROM format(expected, current_schema(),
    'fence_scheduled_turn_execution_update()')
  THEN
    RAISE EXCEPTION 'scheduled_turn_execution_immutable changed: %', installed;
  END IF;
END
$turn_execution_trigger$;
DROP TRIGGER scheduled_turn_execution_immutable ON session_turns;
CREATE TRIGGER scheduled_turn_execution_immutable
BEFORE UPDATE OF model, reasoning_effort, latency_mode, tools, sandbox_backend, sandbox_os,
  initiating_human_subject_id, personal_connection_delegations,
  xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot,
  subscription_authority
ON session_turns
FOR EACH ROW EXECUTE FUNCTION fence_scheduled_turn_execution_update();
