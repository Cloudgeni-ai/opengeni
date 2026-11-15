-- deployment-mode: rolling
-- Workspace governance follows the attempt that runs and the request it
-- builds, not the moment a turn was accepted. A turn can wait hours before
-- its first model request (for example for subscription capacity or
-- recovery), and governance can change while an attempt runs. Until now
-- every attempt resolved the instruction policies and the organization
-- profile active at turn acceptance, so a turn accepted before a policy
-- change acted on the old rules whenever it ran. Now:
--   1. an attempt's instruction-policy snapshot holds the policies active
--      when the snapshot is taken, in the get-or-create routine and in the
--      insert validation trigger alike. A snapshot taken in the transaction
--      that accepted the turn, which can stamp the turn later than the
--      transaction began, still resolves at acceptance, as before: the
--      resolution time is the later of the two;
--   2. when the attempt already has a snapshot and the active policies now
--      differ, the routine refreshes that snapshot in place (same row, same
--      attempt, new entries, hash and time) instead of returning the stale
--      one. The worker calls it again when model-call admission finds that
--      governance changed, so the attempt continues under the current rules;
--   3. the organization-profile snapshot routine and trigger do the same;
--   4. the immutability triggers allow exactly that refresh: an UPDATE made
--      while the routine's transaction-local marker names the row's attempt,
--      keeping every identity column and moving the snapshot time forward.
--      The runtime role cannot update these tables at all, so the marker
--      grants it nothing; every other update or delete stays refused;
--   5. the per-turn Company Brain selection receipt keeps the hashes the
--      turn's first attempt recorded, and a later or refreshed snapshot that
--      differs no longer conflicts with it. The preference check is
--      unchanged: preference snapshots still resolve at acceptance.
-- The validation triggers also refuse a snapshot time after the inserting
-- transaction began, so a snapshot cannot claim a later state than it saw.
-- Rolling: same signatures, owners, grants and result shapes. The previous
-- release calls each routine once per attempt, so it gets the policies
-- current at the attempt's start and never triggers a refresh; its turns keep
-- the model-visible governance item they froze.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $governance_snapshot_current_per_attempt$
DECLARE
  data_schema text := current_schema();
  definition text;
  anchor text;
BEGIN
  -- 1, 2. Instruction-policy snapshot: resolve now, refresh in place.
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION %1$I.workspace_instruction_policy_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) RETURNS SETOF %1$I.workspace_instruction_policy_snapshots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog'
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      session_policy_role text;
      session_metadata jsonb;
      metadata_role_present boolean;
      metadata_role_candidate text;
      canonical_policy_role text;
      canonical_role_source text;
      canonical_entries jsonb;
      canonical_hash text;
      turn_accepted_at timestamptz;
      snapshot_time timestamptz := transaction_timestamp();
      resolve_at timestamptz;
      existing_id uuid;
      winner_id uuid;
    BEGIN
      context_account_id := NULLIF(
        current_setting('opengeni.account_id', true), ''
      )::uuid;
      context_workspace_id := NULLIF(
        current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR p_execution_generation < 1
      THEN
        RAISE EXCEPTION 'instruction-policy snapshot requires exact transaction-local tenant authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT session.policy_role, session.metadata, turn.created_at
        INTO session_policy_role, session_metadata, turn_accepted_at
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id
        AND session.workspace_id = workspace.id
      JOIN session_turns turn
        ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn.account_id
        AND attempt.workspace_id = turn.workspace_id
        AND attempt.session_id = turn.session_id
        AND attempt.turn_id = turn.id
      WHERE workspace.id = p_workspace_id
        AND workspace.account_id = p_account_id
        AND session.id = p_session_id
        AND session.active_turn_id = p_turn_id
        AND turn.id = p_turn_id
        AND turn.active_attempt_id = p_attempt_id
        AND turn.execution_generation = p_execution_generation
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt.id = p_attempt_id
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'instruction-policy snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;
      resolve_at := GREATEST(snapshot_time, turn_accepted_at);

      SELECT snapshot.id INTO existing_id
      FROM workspace_instruction_policy_snapshots snapshot
      WHERE snapshot.account_id = p_account_id
        AND snapshot.workspace_id = p_workspace_id
        AND snapshot.session_id = p_session_id
        AND snapshot.turn_id = p_turn_id
        AND snapshot.attempt_id = p_attempt_id
        AND snapshot.execution_generation = p_execution_generation
      FOR UPDATE;
      IF existing_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.id = existing_id
          AND (
            snapshot.created_at > transaction_timestamp()
            OR jsonb_typeof(snapshot.entries) <> 'array'
            OR jsonb_array_length(snapshot.entries) > 3
            OR snapshot.entry_hash IS DISTINCT FROM encode(
              sha256(convert_to(snapshot.entries::text, 'UTF8')),
              'hex'
            )
            OR (
              snapshot.role_source IN ('session_binding', 'metadata_fallback')
              AND snapshot.policy_role IS NULL
            )
            OR (
              snapshot.role_source IN ('none', 'invalid_metadata_fallback')
              AND snapshot.policy_role IS NOT NULL
            )
          )
      ) THEN
        RAISE EXCEPTION 'existing instruction-policy snapshot failed canonical integrity checks'
          USING ERRCODE = '23514';
      END IF;

      IF session_policy_role IS NOT NULL THEN
        canonical_policy_role := session_policy_role;
        canonical_role_source := 'session_binding';
      ELSE
        metadata_role_present := coalesce(session_metadata ? 'role', false);
        IF metadata_role_present AND jsonb_typeof(session_metadata->'role') = 'string' THEN
          metadata_role_candidate := workspace_instruction_policy_normalize_role_key(
            session_metadata->>'role'
          );
        END IF;
        IF metadata_role_candidate IS NOT NULL
          AND length(metadata_role_candidate) BETWEEN 1 AND 64
          AND metadata_role_candidate ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
          AND metadata_role_candidate !~ '--'
        THEN
          canonical_policy_role := metadata_role_candidate;
          canonical_role_source := 'metadata_fallback';
        ELSIF metadata_role_present THEN
          canonical_policy_role := NULL;
          canonical_role_source := 'invalid_metadata_fallback';
        ELSE
          canonical_policy_role := NULL;
          canonical_role_source := 'none';
        END IF;
      END IF;

      PERFORM 1
      FROM workspace_instruction_policy_activation_events event
      WHERE event.account_id = p_account_id
        AND event.workspace_id = p_workspace_id
        AND event.created_at <= resolve_at
        AND (
          (event.kind = 'charter' AND event.scope = 'global')
          OR (event.kind = 'policy' AND event.scope = 'global')
          OR (
            canonical_policy_role IS NOT NULL
            AND event.kind = 'policy'
            AND event.scope = 'role'
            AND event.role_key = canonical_policy_role
          )
        )
      ORDER BY CASE
        WHEN event.kind = 'charter' THEN 0
        WHEN event.scope = 'global' THEN 1
        ELSE 2
      END,
      event.created_at,
      event.activation_version
      FOR SHARE OF event;

      canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
        p_account_id,
        p_workspace_id,
        canonical_policy_role,
        resolve_at
      );
      canonical_hash := encode(
        sha256(convert_to(canonical_entries::text, 'UTF8')),
        'hex'
      );

      IF existing_id IS NOT NULL THEN
        -- The attempt continues under the policies active now: refresh its
        -- snapshot in place when they differ from what it holds. A snapshot
        -- already taken at or after this transaction's time is kept.
        IF EXISTS (
          SELECT 1
          FROM workspace_instruction_policy_snapshots snapshot
          WHERE snapshot.id = existing_id
            AND snapshot.created_at < snapshot_time
            AND (
              snapshot.policy_role IS DISTINCT FROM canonical_policy_role
              OR snapshot.role_source IS DISTINCT FROM canonical_role_source
              OR snapshot.entries IS DISTINCT FROM canonical_entries
              OR snapshot.entry_hash IS DISTINCT FROM canonical_hash
            )
        ) THEN
          PERFORM set_config('opengeni.governance_snapshot_refresh', p_attempt_id::text, true);
          UPDATE workspace_instruction_policy_snapshots snapshot
          SET policy_role = canonical_policy_role,
            role_source = canonical_role_source,
            entries = canonical_entries,
            entry_hash = canonical_hash,
            created_at = snapshot_time
          WHERE snapshot.id = existing_id;
          PERFORM set_config('opengeni.governance_snapshot_refresh', '', true);
        END IF;
        RETURN QUERY
        SELECT snapshot.*
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.id = existing_id;
        RETURN;
      END IF;

      INSERT INTO workspace_instruction_policy_snapshots (
        account_id,
        workspace_id,
        session_id,
        turn_id,
        attempt_id,
        execution_generation,
        policy_role,
        role_source,
        entries,
        entry_hash,
        created_at
      ) VALUES (
        p_account_id,
        p_workspace_id,
        p_session_id,
        p_turn_id,
        p_attempt_id,
        p_execution_generation,
        canonical_policy_role,
        canonical_role_source,
        canonical_entries,
        canonical_hash,
        snapshot_time
      )
      ON CONFLICT (account_id, workspace_id, attempt_id) DO NOTHING
      RETURNING id INTO winner_id;
      IF winner_id IS NULL THEN
        SELECT snapshot.id INTO winner_id
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.account_id = p_account_id
          AND snapshot.workspace_id = p_workspace_id
          AND snapshot.session_id = p_session_id
          AND snapshot.turn_id = p_turn_id
          AND snapshot.attempt_id = p_attempt_id
          AND snapshot.execution_generation = p_execution_generation
        FOR SHARE;
      END IF;
      IF winner_id IS NULL THEN
        RAISE EXCEPTION 'instruction-policy snapshot winner conflicts with exact attempt authority'
          USING ERRCODE = '40001';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.id = winner_id
          AND (
            snapshot.policy_role IS DISTINCT FROM canonical_policy_role
            OR snapshot.role_source IS DISTINCT FROM canonical_role_source
            OR snapshot.entries IS DISTINCT FROM canonical_entries
            OR snapshot.entry_hash IS DISTINCT FROM canonical_hash
            OR snapshot.created_at IS DISTINCT FROM snapshot_time
          )
      ) THEN
        RAISE EXCEPTION 'instruction-policy snapshot winner is not the canonical locked snapshot'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY
      SELECT snapshot.*
      FROM workspace_instruction_policy_snapshots snapshot
      WHERE snapshot.id = winner_id;
    END
    $body$
  $create$, data_schema);

  -- 1. Its validation trigger checks the policies at the snapshot's time.
  definition := pg_get_functiondef(format(
    '%I.workspace_instruction_policy_validate_snapshot()', data_schema)::regprocedure);
  anchor := $a$  canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
    NEW.account_id,
    NEW.workspace_id,
    canonical_policy_role,
    turn_accepted_at
  );$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'workspace_instruction_policy_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'instruction-policy snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
    NEW.account_id,
    NEW.workspace_id,
    canonical_policy_role,
    GREATEST(NEW.created_at, turn_accepted_at)
  );$r$);
  EXECUTE definition;

  -- 3. Organization-profile snapshot: resolve now, refresh in place.
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION %1$I.company_profile_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) RETURNS SETOF %1$I.company_profile_snapshots
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog'
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      accepted_at timestamptz;
      canonical_profile jsonb;
      canonical_hash text;
      snapshot_time timestamptz := transaction_timestamp();
      existing_id uuid;
      winner_id uuid;
    BEGIN
      context_account_id := NULLIF(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id := NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid;
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR p_execution_generation < 1
      THEN
        RAISE EXCEPTION 'company-profile snapshot requires exact tenant authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT turn.created_at INTO accepted_at
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id AND session.workspace_id = workspace.id
      JOIN session_turns turn
        ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn.account_id
        AND attempt.workspace_id = turn.workspace_id
        AND attempt.session_id = turn.session_id
        AND attempt.turn_id = turn.id
      WHERE workspace.id = p_workspace_id
        AND workspace.account_id = p_account_id
        AND session.id = p_session_id
        AND session.active_turn_id = p_turn_id
        AND turn.id = p_turn_id
        AND turn.active_attempt_id = p_attempt_id
        AND turn.execution_generation = p_execution_generation
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt.id = p_attempt_id
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'company-profile snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;

      SELECT snapshot.id INTO existing_id
      FROM company_profile_snapshots snapshot
      WHERE snapshot.account_id = p_account_id
        AND snapshot.workspace_id = p_workspace_id
        AND snapshot.session_id = p_session_id
        AND snapshot.turn_id = p_turn_id
        AND snapshot.attempt_id = p_attempt_id
        AND snapshot.execution_generation = p_execution_generation
      FOR UPDATE;

      canonical_profile := company_profile_canonical_snapshot_at(
        p_account_id, GREATEST(snapshot_time, accepted_at)
      );
      canonical_hash := encode(
        sha256(convert_to(coalesce(canonical_profile, 'null'::jsonb)::text, 'UTF8')),
        'hex'
      );

      IF existing_id IS NOT NULL THEN
        -- The attempt continues under the profile active now: refresh its
        -- snapshot in place when it differs. A snapshot already taken at or
        -- after this transaction's time is kept.
        IF EXISTS (
          SELECT 1 FROM company_profile_snapshots snapshot
          WHERE snapshot.id = existing_id
            AND snapshot.created_at < snapshot_time
            AND (
              snapshot.profile IS DISTINCT FROM canonical_profile
              OR snapshot.snapshot_hash IS DISTINCT FROM canonical_hash
            )
        ) THEN
          PERFORM set_config('opengeni.governance_snapshot_refresh', p_attempt_id::text, true);
          UPDATE company_profile_snapshots snapshot
          SET profile = canonical_profile,
            snapshot_hash = canonical_hash,
            created_at = snapshot_time
          WHERE snapshot.id = existing_id;
          PERFORM set_config('opengeni.governance_snapshot_refresh', '', true);
        END IF;
        RETURN QUERY SELECT snapshot.* FROM company_profile_snapshots snapshot WHERE snapshot.id = existing_id;
        RETURN;
      END IF;

      INSERT INTO company_profile_snapshots (
        account_id, workspace_id, session_id, turn_id, attempt_id,
        execution_generation, profile, snapshot_hash, created_at
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, canonical_profile, canonical_hash, snapshot_time
      )
      ON CONFLICT (account_id, workspace_id, attempt_id) DO NOTHING
      RETURNING id INTO winner_id;
      IF winner_id IS NULL THEN
        SELECT snapshot.id INTO winner_id
        FROM company_profile_snapshots snapshot
        WHERE snapshot.account_id = p_account_id
          AND snapshot.workspace_id = p_workspace_id
          AND snapshot.session_id = p_session_id
          AND snapshot.turn_id = p_turn_id
          AND snapshot.attempt_id = p_attempt_id
          AND snapshot.execution_generation = p_execution_generation
        FOR SHARE;
      END IF;
      IF winner_id IS NULL THEN
        RAISE EXCEPTION 'company-profile snapshot winner conflicts with exact attempt authority'
          USING ERRCODE = '40001';
      END IF;
      IF EXISTS (
        SELECT 1 FROM company_profile_snapshots snapshot
        WHERE snapshot.id = winner_id
          AND (
            snapshot.profile IS DISTINCT FROM canonical_profile
            OR snapshot.snapshot_hash IS DISTINCT FROM canonical_hash
            OR snapshot.created_at IS DISTINCT FROM snapshot_time
          )
      ) THEN
        RAISE EXCEPTION 'company-profile snapshot winner is not canonical'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY SELECT snapshot.* FROM company_profile_snapshots snapshot WHERE snapshot.id = winner_id;
    END
    $body$
  $create$, data_schema);

  -- 3. Its validation trigger checks the profile at the snapshot's time.
  definition := pg_get_functiondef(format(
    '%I.company_profile_validate_snapshot()', data_schema)::regprocedure);
  anchor := $a$  canonical_profile := company_profile_canonical_snapshot_at(NEW.account_id, accepted_at);$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_profile_validate_snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF NEW.created_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'company-profile snapshot time is outside its attempt'
      USING ERRCODE = '23514';
  END IF;
  canonical_profile := company_profile_canonical_snapshot_at(
    NEW.account_id, GREATEST(NEW.created_at, accepted_at)
  );$r$);
  EXECUTE definition;

  -- 4. The immutability triggers allow only the routines' in-place refresh.
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION %1$I.workspace_governance_snapshot_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
BEGIN
  -- Parent lifecycle deletion is a mutation exception. PostgreSQL's
  -- cascading constraint trigger runs only after its parent row is absent;
  -- require both that nested trigger context and one missing ownership edge so
  -- direct or unrelated-trigger deletes remain fail-closed.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM "managed_accounts" WHERE "id" = OLD."account_id")
      OR NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id")
      OR NOT EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."session_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turns" WHERE "id" = OLD."turn_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turn_attempts" WHERE "id" = OLD."attempt_id")
    )
  THEN
    RETURN OLD;
  END IF;
  -- The other: the snapshot routine refreshing its own attempt's snapshot to
  -- the governance active now. Only that routine sets the marker; identity
  -- never changes and the snapshot time only moves forward.
  IF TG_OP = 'UPDATE'
    AND current_setting('opengeni.governance_snapshot_refresh', true) = OLD."attempt_id"::text
    AND NEW."id" = OLD."id"
    AND NEW."account_id" = OLD."account_id"
    AND NEW."workspace_id" = OLD."workspace_id"
    AND NEW."session_id" = OLD."session_id"
    AND NEW."turn_id" = OLD."turn_id"
    AND NEW."attempt_id" = OLD."attempt_id"
    AND NEW."execution_generation" = OLD."execution_generation"
    AND NEW."created_at" > OLD."created_at"
    AND NEW."created_at" <= transaction_timestamp()
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'accepted-turn governance snapshots are immutable'
    USING ERRCODE = '55000';
END;
$body$
  $create$, data_schema);

  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION %1$I.company_profile_reject_snapshot_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM managed_accounts WHERE id = OLD.account_id)
      OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
      OR NOT EXISTS (SELECT 1 FROM session_turns WHERE id = OLD.turn_id)
      OR NOT EXISTS (SELECT 1 FROM session_turn_attempts WHERE id = OLD.attempt_id)
    )
  THEN
    RETURN OLD;
  END IF;
  -- The snapshot routine refreshing its own attempt's snapshot to the profile
  -- active now (see workspace_governance_snapshot_reject_mutation).
  IF TG_OP = 'UPDATE'
    AND current_setting('opengeni.governance_snapshot_refresh', true) = OLD.attempt_id::text
    AND NEW.id = OLD.id
    AND NEW.account_id = OLD.account_id
    AND NEW.workspace_id = OLD.workspace_id
    AND NEW.session_id = OLD.session_id
    AND NEW.turn_id = OLD.turn_id
    AND NEW.attempt_id = OLD.attempt_id
    AND NEW.execution_generation = OLD.execution_generation
    AND NEW.created_at > OLD.created_at
    AND NEW.created_at <= transaction_timestamp()
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'company-profile accepted-turn snapshots are immutable'
    USING ERRCODE = '55000';
END;
$body$
  $create$, data_schema);

  -- 5. A later or refreshed snapshot may differ from the receipt's first one.
  definition := pg_get_functiondef(format(
    '%I.company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer)',
    data_schema)::regprocedure);
  anchor := $a$      OR receipt_row.instruction_policy_entry_hash IS DISTINCT FROM policy_hash
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_brain_context_get_or_create_selection policy anchor drifted';
  END IF;
  definition := replace(definition, anchor, '');
  anchor := $a$      OR receipt_row.company_profile_snapshot_hash IS DISTINCT FROM profile_hash
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'company_brain_context_get_or_create_selection profile anchor drifted';
  END IF;
  definition := replace(definition, anchor, '');
  EXECUTE definition;
END
$governance_snapshot_current_per_attempt$;
