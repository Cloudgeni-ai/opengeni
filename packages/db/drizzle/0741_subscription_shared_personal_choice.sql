-- deployment-mode: maintenance
-- Exact shared-session personal consent is a one-way reader protocol upgrade.
-- Drain every configured API/worker database login before applying; do not
-- restart old binaries. All readers below precede the new acceptance writer.
-- Existing v2 entries and 0716 compatibility pools are never rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION pg_temp.assert_shared_personal_choice_runtime_drain() RETURNS void
LANGUAGE plpgsql AS $drain$
DECLARE configured_roles jsonb;
BEGIN
  BEGIN
    configured_roles := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION '0741 shared personal choice requires a valid application database role list' USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '0741 shared personal choice requires an explicit application database role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(configured_roles) roles(value)
      WHERE jsonb_typeof(value) <> 'string' OR btrim(value #>> '{}') = '' OR octet_length(value #>> '{}') > 63)
    OR (SELECT count(*) FROM jsonb_array_elements_text(configured_roles))
      <> (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(configured_roles) roles(value))
  THEN RAISE EXCEPTION '0741 shared personal choice received an invalid application database role list' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name) ON roles.role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid())
  THEN RAISE EXCEPTION '0741 shared personal choice requires all configured application sessions to be stopped' USING ERRCODE = '55000'; END IF;
END
$drain$;
SELECT pg_temp.assert_shared_personal_choice_runtime_drain();
LOCK TABLE sessions, session_turns, subscription_session_bindings IN ACCESS EXCLUSIVE MODE;
SELECT pg_temp.assert_shared_personal_choice_runtime_drain();

CREATE OR REPLACE FUNCTION subscription_personal_authority_v2_valid(snapshot jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT
AS $function$
DECLARE entry jsonb; restriction jsonb; providers text[] := '{}';
  uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
    OR NOT snapshot ?& ARRAY['version', 'personal']
    OR snapshot - ARRAY['version', 'personal']::text[] <> '{}'::jsonb
    OR snapshot->'version' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(snapshot->'personal') IS DISTINCT FROM 'array'
  THEN RETURN false; END IF;
  IF jsonb_array_length(snapshot->'personal') > 3 THEN RETURN false; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(snapshot->'personal') LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT entry ?& ARRAY['provider', 'ownerMembershipId', 'authorityGeneration']
      OR entry - ARRAY['provider', 'ownerMembershipId', 'authorityGeneration', 'sharedSessionChoice']::text[] <> '{}'::jsonb
      OR jsonb_typeof(entry->'provider') IS DISTINCT FROM 'string'
      OR NOT coalesce(entry->>'provider' IN ('codex', 'claude', 'xai'), false)
      OR entry->>'provider' = ANY(providers)
      OR jsonb_typeof(entry->'ownerMembershipId') IS DISTINCT FROM 'string'
      OR NOT coalesce(entry->>'ownerMembershipId' ~ uuid_pattern, false)
      OR jsonb_typeof(entry->'authorityGeneration') IS DISTINCT FROM 'number'
      OR NOT coalesce(entry->>'authorityGeneration' ~ '^[1-9][0-9]*$', false)
    THEN RETURN false; END IF;
    IF (entry->>'authorityGeneration')::numeric > 9007199254740991 THEN RETURN false; END IF;
    providers := array_append(providers, entry->>'provider');
    IF entry ? 'sharedSessionChoice' THEN
      restriction := entry->'sharedSessionChoice';
      IF jsonb_typeof(restriction) IS DISTINCT FROM 'object'
        OR NOT restriction ?& ARRAY['sessionId', 'connectionId']
        OR restriction - ARRAY['sessionId', 'connectionId']::text[] <> '{}'::jsonb
        OR jsonb_typeof(restriction->'sessionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(restriction->'connectionId') IS DISTINCT FROM 'string'
        OR NOT coalesce(restriction->>'sessionId' ~ uuid_pattern, false)
        OR NOT coalesce(restriction->>'connectionId' ~ uuid_pattern, false)
      THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END
$function$;

-- Personal row visibility follows the capability's actual accepting human,
-- not the independently retained session owner. Shared people-scoped access
-- is unchanged. No capability may be manufactured from mere visibility.
DO $personal_visibility$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.subscription_personal_connection_visible(uuid,uuid,uuid,text,text,text)'::regprocedure);
  anchor := 'AND membership.subject_id = p_session_owner_subject_id AND membership.status = ''active''';
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'personal visibility source changed';
  END IF;
  EXECUTE replace(definition, anchor,
    'AND membership.subject_id = p_turn_human_subject_id AND membership.status = ''active'' AND membership.revoked_at IS NULL');
  definition := pg_get_functiondef('opengeni_private.subscription_connection_visible(uuid,uuid,uuid,text,text,uuid,text,text)'::regprocedure);
  anchor := 'AND p_owner_subject_id = capability.session_owner_subject_id';
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'connection visibility source changed';
  END IF;
  EXECUTE replace(definition, anchor, 'AND p_owner_subject_id = capability.turn_human_subject_id');
END
$personal_visibility$;

-- Choosing is not acceptance. Only an authenticated participant may create
-- the explicit shared personal binding for their own account. Core placement
-- may retain it only with the exact per-connection accepted-turn capability.
-- Neither path changes provider keys, versions, clocks or frozen turn JSON.
DO $binding_choice$
DECLARE definition text; previous text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.guard_subscription_connection_reference()'::regprocedure);
  previous := definition;
  definition := replace(definition, $old$        AND membership.subject_id = session.owner_subject_id
      JOIN organization_user_resource_authorities authority$old$,
      $new$        AND membership.subject_id = turn_human
      JOIN organization_user_resource_authorities authority$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal binding membership source changed'; END IF;
  previous := definition;
  definition := replace(definition, $old$        AND session.id = NEW.session_id AND session.owner_subject_id = target.owner_subject_id
        AND turn_human = session.owner_subject_id AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND (session.visibility = 'user_private' OR membership.personal_workspace_id = NEW.workspace_id)$old$,
      $new$        AND session.id = NEW.session_id AND target.owner_subject_id = turn_human
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND (
          (session.owner_subject_id = turn_human
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = NEW.workspace_id))
          OR (session.visibility = 'workspace_shared' AND NEW.choice = 'explicit'
            AND turn_human LIKE 'user:%'
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = NEW.account_id AND participant.workspace_id = NEW.workspace_id
                AND participant.subject_id = turn_human)
            AND (nullif(current_setting('opengeni.subject_id', true), '') = turn_human
              OR EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities accepted
                WHERE accepted.backend_pid = pg_catalog.pg_backend_pid()
                  AND accepted.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
                  AND accepted.capability_kind = 'personal_access'
                  AND accepted.account_id = NEW.account_id AND accepted.workspace_id = NEW.workspace_id
                  AND accepted.session_id = NEW.session_id AND accepted.turn_id IS NOT NULL
                  AND accepted.connection_id = target.id AND accepted.provider = target.provider
                  AND accepted.session_owner_subject_id = session_owner
                  AND accepted.turn_human_subject_id = turn_human)))
        )$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal binding choice source changed'; END IF;
  EXECUTE definition;
END
$binding_choice$;

-- Keep the live 0716 receipt and exact compatibility-record branches intact.
-- The new branch is admitted only by an already stored, strictly valid exact
-- restriction. Old private entries still require the session owner/human.
DO $personal_access$
DECLARE definition text; patch text[];
BEGIN
  definition := pg_get_functiondef('opengeni_private.authorize_subscription_personal_access(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$AND membership.subject_id = p_session_owner_subject_id AND membership.status = 'active'$old$,
      $new$AND membership.subject_id = p_turn_human_subject_id AND membership.status = 'active'$new$],
    ARRAY[$old$AND connection.owner_subject_id = p_session_owner_subject_id$old$,
      $new$AND connection.owner_subject_id = p_turn_human_subject_id$new$],
    ARRAY[$old$        AND p_turn_human_subject_id = p_session_owner_subject_id
        AND session.owner_organization_membership_id = connection.owner_organization_membership_id
        AND (session.visibility = 'user_private'
          OR membership.personal_workspace_id = p_workspace_id);$old$,
      $new$        AND (
          (p_turn_human_subject_id = p_session_owner_subject_id
            AND session.owner_organization_membership_id = connection.owner_organization_membership_id
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id))
          OR (p_turn_human_subject_id LIKE 'user:%'
            AND subscription_personal_authority_v2_valid(turn.subscription_authority)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(turn.subscription_authority->'personal') entry
              WHERE entry->>'provider' = p_provider
                AND entry->>'ownerMembershipId' = membership.id::text
                AND entry->>'authorityGeneration' = connection.authority_generation::text
                AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                AND entry->'sharedSessionChoice'->>'connectionId' = p_connection_id::text)
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id))
        );$new$],
    ARRAY[$old$              AND entry->>'authorityGeneration' = connection_generation::text
$old$,
      $new$              AND entry->>'authorityGeneration' = connection_generation::text
              AND (NOT entry ? 'sharedSessionChoice' OR (
                entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                AND entry->'sharedSessionChoice'->>'connectionId' = p_connection_id::text
                AND p_turn_human_subject_id LIKE 'user:%'
                AND current_setting('opengeni.shared_personal_choice_v1', true) = '1'
                AND nullif(current_setting('opengeni.subject_id', true), '') IN (
                  p_turn_human_subject_id, 'service:subscription-core')
                AND EXISTS (SELECT 1 FROM workspace_memberships participant
                  WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                    AND participant.subject_id = p_turn_human_subject_id)))
$new$]
  ] LOOP
    IF (length(definition) - length(replace(definition, patch[1], ''))) <> length(patch[1]) THEN
      RAISE EXCEPTION 'personal access source changed: %', patch[1];
    END IF;
    definition := replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$personal_access$;

DO $personal_placement$
DECLARE definition text; patch text[];
BEGIN
  definition := pg_get_functiondef('opengeni_private.authorize_subscription_personal_placement_access(uuid,uuid,uuid,uuid,text,uuid,bigint,text,text)'::regprocedure);
  FOREACH patch SLICE 1 IN ARRAY ARRAY[
    ARRAY[$old$      record_connections uuid[];$old$,
      $new$      record_connections uuid[];
      restricted_connection uuid;
      selected_entry jsonb;$new$],
    ARRAY[$old$        OR p_session_owner_subject_id IS DISTINCT FROM p_turn_human_subject_id
$old$, $new$$new$],
    ARRAY[$old$        AND membership.id = session.owner_organization_membership_id
        AND membership.subject_id = session.owner_subject_id$old$,
      $new$        AND membership.id = p_owner_membership_id
        AND membership.subject_id = p_turn_human_subject_id$new$],
    ARRAY[$old$        AND session.owner_organization_membership_id = p_owner_membership_id
$old$, $new$$new$],
    ARRAY[$old$        AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id)
$old$,
      $new$        AND (
          (session.owner_subject_id = p_turn_human_subject_id
            AND session.owner_organization_membership_id = p_owner_membership_id
            AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id))
          OR (p_turn_human_subject_id LIKE 'user:%'
            AND subscription_personal_authority_v2_valid(turn.subscription_authority)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(turn.subscription_authority->'personal') entry
              WHERE entry->>'provider' = p_provider
                AND entry->>'ownerMembershipId' = p_owner_membership_id::text
                AND entry->>'authorityGeneration' = p_authority_generation::text
                AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text)
            AND EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id))
        )
$new$],
    ARRAY[$old$        AND authority_snapshot->>'version' = '2'
$old$, $new$        AND subscription_personal_authority_v2_valid(authority_snapshot)
        AND authority_snapshot->>'version' = '2'
$new$],
    ARRAY[$old$        ) INTO allowed;
      END IF;
      IF NOT allowed$old$,
      $new$        ) INTO allowed;
        SELECT entry INTO selected_entry FROM jsonb_array_elements(authority_snapshot->'personal') entry
        WHERE entry->>'provider' = p_provider;
        IF selected_entry ? 'sharedSessionChoice' THEN
          IF selected_entry->'sharedSessionChoice'->>'sessionId' IS DISTINCT FROM p_session_id::text
            OR current_setting('opengeni.shared_personal_choice_v1', true) IS DISTINCT FROM '1'
            OR p_turn_human_subject_id NOT LIKE 'user:%'
            OR NOT EXISTS (SELECT 1 FROM workspace_memberships participant
              WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                AND participant.subject_id = p_turn_human_subject_id)
          THEN
            allowed := false;
          END IF;
          restricted_connection := (selected_entry->'sharedSessionChoice'->>'connectionId')::uuid;
          record_connections := ARRAY[restricted_connection];
        END IF;
      END IF;
      IF NOT allowed$new$],
    ARRAY[$old$            AND connection.owner_subject_id = p_session_owner_subject_id$old$,
      $new$            AND connection.owner_subject_id = p_turn_human_subject_id$new$]
  ] LOOP
    IF (length(definition) - length(replace(definition, patch[1], ''))) <> length(patch[1]) THEN
      RAISE EXCEPTION 'personal placement source changed: %', patch[1];
    END IF;
    definition := replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$personal_placement$;

-- Scheduled admission cannot turn an exact connection restriction into a
-- membership-generation wildcard. Destination session remains fenced by the
-- exact copied entry when the run reaches the placement/access readers.
DO $serviceable$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef('opengeni_subscription_internal.subscription_personal_entry_serviceable(uuid,jsonb)'::regprocedure);
  anchor := $old$      AND (NOT p_entry ? 'connectionIds' OR p_entry -> 'connectionIds' ? connection.id::text))$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'personal serviceability source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$      AND (NOT p_entry ? 'connectionIds' OR p_entry -> 'connectionIds' ? connection.id::text)
      AND (NOT p_entry ? 'sharedSessionChoice' OR (
        subscription_personal_authority_v2_valid(jsonb_build_object('version', 2, 'personal', jsonb_build_array(p_entry)))
        AND p_entry->'sharedSessionChoice'->>'connectionId' = connection.id::text)))$new$);
END
$serviceable$;

-- Keep 0726's read-only lifecycle window and its restoration before writes.
-- A restricted entry can recover only its exact resource, with live owner,
-- membership, participation and policy; legacy recovery semantics stay put.
DO $recovery$
DECLARE definition text; previous text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.recover_subscription_core_connection_health(text,uuid,uuid,uuid,uuid)'::regprocedure);
  previous := definition;
  definition := replace(definition, $old$              AND capability_human IS NOT DISTINCT FROM capability_owner
              AND connection.owner_subject_id = capability_owner$old$,
      $new$              AND connection.owner_subject_id = capability_human$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal recovery owner source changed'; END IF;
  previous := definition;
  definition := replace(definition, $old$AND membership.subject_id = capability_owner$old$,
      $new$AND membership.subject_id = capability_human$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal recovery membership source changed'; END IF;
  previous := definition;
  definition := replace(definition, $old$AND turn.initiating_human_subject_id = capability_owner$old$,
      $new$AND turn.initiating_human_subject_id = capability_human$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal recovery human source changed'; END IF;
  previous := definition;
  definition := replace(definition, $old$                  AND entry->>'authorityGeneration' = connection.authority_generation::text
$old$,
      $new$                  AND entry->>'authorityGeneration' = connection.authority_generation::text
                  AND (CASE WHEN entry ? 'sharedSessionChoice' THEN
                    capability_human LIKE 'user:%'
                    AND current_setting('opengeni.shared_personal_choice_v1', true) = '1'
                    AND subscription_personal_authority_v2_valid(turn.subscription_authority)
                    AND entry->'sharedSessionChoice'->>'sessionId' = p_session_id::text
                    AND entry->'sharedSessionChoice'->>'connectionId' = connection.id::text
                    AND coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
                      #>> '{values,personalConnectionsAllowed}')::boolean, false)
                    AND EXISTS (SELECT 1 FROM workspace_memberships participant
                      WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
                        AND participant.subject_id = capability_human)
                    AND EXISTS (SELECT 1 FROM organization_user_resource_authorities authority
                      WHERE authority.id = connection.authority_id AND authority.account_id = p_account_id
                        AND authority.organization_membership_id = connection.owner_organization_membership_id
                        AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
                        AND authority.generation = connection.authority_generation
                        AND authority.status = 'active' AND authority.revoked_at IS NULL)
                    ELSE capability_human IS NOT DISTINCT FROM capability_owner END)
$new$);
  IF definition = previous THEN RAISE EXCEPTION 'personal recovery entry source changed'; END IF;
  EXECUTE definition;
END
$recovery$;

-- Fresh authenticated human acceptance only. The original private-work
-- generation pool and creator fallback below this branch remain unchanged.
-- 0726's owner-only lifecycle marker is restored before returning or writing.
DO $acceptance$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)'::regprocedure);
  anchor := '      generations bigint[];';
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'shared personal acceptance declaration source changed';
  END IF;
  definition := replace(definition, anchor, anchor || E'\n      restricted_entry jsonb;');
  anchor := $old$      IF NOT FOUND OR owner_subject IS NULL OR owner_membership IS NULL
        OR owner_subject IS DISTINCT FROM p_accepting_subject_id
      THEN RETURN empty_v2; END IF;$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'shared personal acceptance owner source changed';
  END IF;
  replacement := $new$      IF NOT FOUND OR owner_subject IS NULL OR owner_membership IS NULL
      THEN RETURN empty_v2; END IF;

      IF private_session IS FALSE AND get_workspace_kind(p_account_id, p_workspace_id) = 'shared' THEN
        IF p_accepting_subject_id NOT LIKE 'user:%'
          OR request_subject IS DISTINCT FROM p_accepting_subject_id
          OR NOT coalesce(opengeni_private.subscription_provider_cutover_committed(p_provider), false)
          OR NOT coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
            #>> '{values,personalConnectionsAllowed}')::boolean, false)
        THEN RETURN empty_v2; END IF;

        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
        SELECT jsonb_build_object('provider', p_provider,
          'ownerMembershipId', membership.id::text,
          'authorityGeneration', connection.authority_generation,
          'sharedSessionChoice', jsonb_build_object('sessionId', p_session_id::text,
            'connectionId', connection.id::text)) INTO restricted_entry
        FROM subscription_session_bindings binding
        JOIN subscription_connections connection ON connection.account_id = binding.account_id
          AND connection.id = binding.connection_id AND connection.provider = binding.provider
        JOIN organization_memberships membership ON membership.account_id = connection.account_id
          AND membership.id = connection.owner_organization_membership_id
          AND membership.subject_id = p_accepting_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
        JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
          AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
          AND authority.generation = connection.authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
        WHERE binding.account_id = p_account_id AND binding.workspace_id = p_workspace_id
          AND binding.session_id = p_session_id AND binding.provider = p_provider AND binding.choice = 'explicit'
          AND connection.ownership = 'personal' AND connection.owner_subject_id = p_accepting_subject_id
          AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
          AND connection.status IN ('active', 'error')
          AND EXISTS (SELECT 1 FROM workspace_memberships participant
            WHERE participant.account_id = p_account_id AND participant.workspace_id = p_workspace_id
              AND participant.subject_id = p_accepting_subject_id)
          AND EXISTS (SELECT 1 FROM organization_memberships session_owner
            WHERE session_owner.account_id = p_account_id AND session_owner.id = owner_membership
              AND session_owner.subject_id = owner_subject
              AND session_owner.status = 'active' AND session_owner.revoked_at IS NULL);
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(prior_lifecycle, ''), true);
        IF restricted_entry IS NULL THEN RETURN empty_v2; END IF;
        -- An old writer must not emit an authority its readers cannot parse.
        -- This is the transaction-local runtime protocol receipt, not a
        -- workspace feature switch or permission selected by the caller.
        IF current_setting('opengeni.shared_personal_choice_v1', true) IS DISTINCT FROM '1' THEN
          RAISE EXCEPTION 'shared personal choice requires an OpenGeni 0736-compatible runtime'
            USING ERRCODE = '55000';
        END IF;
        RETURN jsonb_build_object('version', 2, 'personal', jsonb_build_array(restricted_entry));
      END IF;

      IF owner_subject IS DISTINCT FROM p_accepting_subject_id THEN RETURN empty_v2; END IF;$new$;
  EXECUTE replace(definition, anchor, replacement);
END
$acceptance$;

SELECT pg_temp.assert_shared_personal_choice_runtime_drain();
