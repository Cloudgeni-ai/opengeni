-- deployment-mode: rolling
-- Migration 0364: keep accepted-attempt learning-policy snapshots on the
-- canonical workspace -> session -> turn -> attempt lock order.
--
-- The original snapshot function locked attempt, turn, and session rows in one
-- joined SELECT ... FOR SHARE statement. PostgreSQL may acquire row locks in
-- plan order rather than SQL join order. An attempt-id lookup therefore took a
-- turn SHARE lock before reaching the session row, while an ordinary lifecycle
-- writer already held the session and waited for the turn. The two transactions
-- formed a session/turn cycle and PostgreSQL aborted the snapshot with 40P01.
--
-- Acquire each row in the same explicit order as the session lifecycle:
-- workspaces KEY SHARE, sessions SHARE, session_turns SHARE, then
-- session_turn_attempts SHARE. A fresh statement revalidates the complete
-- authority tuple and interruption state after all locks are held, preserving
-- the accepted-attempt invariant without a planner-dependent lock order.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $snapshot_lock_order$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.workspace_learning_policy_get_or_create_snapshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS TABLE (snapshot_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      accepted_at timestamptz;
      canonical jsonb;
      existing_snapshot record;
      snapshot_revision_id uuid;
      snapshot_revision bigint;
      snapshot_policy_hash text;
      snapshot_activation_version bigint;
      snapshot_activated_at timestamptz;
      snapshot_workspace_mode text;
      snapshot_source_overrides jsonb;
    BEGIN
      IF NULLIF(current_setting('opengeni.account_id', true), '')::uuid IS DISTINCT FROM p_account_id
        OR NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid IS DISTINCT FROM p_workspace_id
      THEN
        RAISE EXCEPTION 'learning-policy snapshot requires exact workspace authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT * INTO existing_snapshot
      FROM "workspace_learning_policy_snapshots" snapshot
      WHERE snapshot."account_id" = p_account_id
        AND snapshot."workspace_id" = p_workspace_id
        AND snapshot."attempt_id" = p_attempt_id;
      IF FOUND THEN
        IF existing_snapshot."session_id" IS DISTINCT FROM p_session_id
          OR existing_snapshot."turn_id" IS DISTINCT FROM p_turn_id
          OR existing_snapshot."execution_generation" IS DISTINCT FROM p_execution_generation
        THEN
          RAISE EXCEPTION 'learning-policy snapshot attempt identity conflicted'
            USING ERRCODE = '23514';
        END IF;
        snapshot_id := existing_snapshot."id";
        RETURN NEXT;
        RETURN;
      END IF;

      PERFORM 1
      FROM "workspaces" workspace
      WHERE workspace."id" = p_workspace_id
        AND workspace."account_id" = p_account_id
      FOR KEY SHARE OF workspace;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      PERFORM 1
      FROM "sessions" session
      WHERE session."account_id" = p_account_id
        AND session."workspace_id" = p_workspace_id
        AND session."id" = p_session_id
        AND session."active_turn_id" = p_turn_id
      FOR SHARE OF session;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      SELECT turn."created_at" INTO accepted_at
      FROM "session_turns" turn
      WHERE turn."account_id" = p_account_id
        AND turn."workspace_id" = p_workspace_id
        AND turn."session_id" = p_session_id
        AND turn."id" = p_turn_id
        AND turn."execution_generation" = p_execution_generation
        AND turn."active_attempt_id" = p_attempt_id
        AND turn."status" IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
      FOR SHARE OF turn;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      PERFORM 1
      FROM "session_turn_attempts" attempt
      WHERE attempt."id" = p_attempt_id
        AND attempt."account_id" = p_account_id
        AND attempt."workspace_id" = p_workspace_id
        AND attempt."session_id" = p_session_id
        AND attempt."turn_id" = p_turn_id
        AND attempt."execution_generation" = p_execution_generation
        AND attempt."state" IN ('claimed', 'running')
      FOR SHARE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      -- A lock acquisition may wait behind Pause, Steer, replacement, or
      -- settlement. Re-evaluate the complete tuple in a fresh READ COMMITTED
      -- statement after the canonical rows are locked so a pre-wait snapshot
      -- cannot miss the change that just released the lock.
      PERFORM 1
      FROM "sessions" session
      JOIN "session_turns" turn
        ON turn."account_id" = session."account_id"
        AND turn."workspace_id" = session."workspace_id"
        AND turn."session_id" = session."id"
      JOIN "session_turn_attempts" attempt
        ON attempt."account_id" = turn."account_id"
        AND attempt."workspace_id" = turn."workspace_id"
        AND attempt."session_id" = turn."session_id"
        AND attempt."turn_id" = turn."id"
      WHERE session."account_id" = p_account_id
        AND session."workspace_id" = p_workspace_id
        AND session."id" = p_session_id
        AND session."active_turn_id" = p_turn_id
        AND turn."id" = p_turn_id
        AND turn."execution_generation" = p_execution_generation
        AND turn."active_attempt_id" = p_attempt_id
        AND turn."status" IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt."id" = p_attempt_id
        AND attempt."execution_generation" = p_execution_generation
        AND attempt."state" IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM "session_attempt_interruptions" interruption
          WHERE interruption."workspace_id" = p_workspace_id
            AND interruption."attempt_id" = p_attempt_id
            AND interruption."state" IN ('pending', 'delivered', 'acknowledged')
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      canonical := workspace_learning_policy_canonical_at(
        p_account_id,
        p_workspace_id,
        accepted_at
      );
      snapshot_revision_id := (canonical->>'revisionId')::uuid;
      snapshot_revision := (canonical->>'revision')::bigint;
      snapshot_policy_hash := canonical->>'policyHash';
      snapshot_activation_version := (canonical->>'activationVersion')::bigint;
      snapshot_activated_at := (canonical->>'activatedAt')::timestamptz;
      snapshot_workspace_mode := canonical->>'workspaceMode';
      snapshot_source_overrides := canonical->'sourceOverrides';

      INSERT INTO "workspace_learning_policy_snapshots" (
        "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
        "execution_generation", "revision_id", "revision", "policy_hash",
        "activation_version", "activated_at", "workspace_mode", "source_overrides",
        "snapshot_hash"
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, snapshot_revision_id, snapshot_revision, snapshot_policy_hash,
        snapshot_activation_version, snapshot_activated_at, snapshot_workspace_mode,
        snapshot_source_overrides,
        workspace_learning_policy_snapshot_hash(
          snapshot_revision_id,
          snapshot_revision,
          snapshot_policy_hash,
          snapshot_activation_version,
          snapshot_activated_at,
          snapshot_workspace_mode,
          snapshot_source_overrides
        )
      )
      ON CONFLICT ("account_id", "workspace_id", "attempt_id") DO NOTHING
      RETURNING "id" INTO snapshot_id;

      IF snapshot_id IS NULL THEN
        SELECT snapshot."id" INTO snapshot_id
        FROM "workspace_learning_policy_snapshots" snapshot
        WHERE snapshot."account_id" = p_account_id
          AND snapshot."workspace_id" = p_workspace_id
          AND snapshot."attempt_id" = p_attempt_id
          AND snapshot."session_id" = p_session_id
          AND snapshot."turn_id" = p_turn_id
          AND snapshot."execution_generation" = p_execution_generation;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'learning-policy snapshot concurrent identity conflicted'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
END $snapshot_lock_order$;
