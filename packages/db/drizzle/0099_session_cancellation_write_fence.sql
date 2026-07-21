-- A worker from before the existing-session feature can still enqueue and
-- claim through the legacy reusable_session_id path.  Its old code does not
-- take the session row lock before every write, so the terminal cancellation
-- invariant must also be enforced by PostgreSQL.
--
-- INSERTs take the session row lock before they can create a live turn, so an
-- old enqueue either commits before cancellation (and is drained) or observes
-- cancelled and is rejected.  UPDATEs must not take that parent lock: Postgres
-- has already locked the turn row before a row-level UPDATE trigger runs, and
-- cancellation drains turns while holding the session row.  UPDATEs therefore
-- use a non-locking status read; an old claim's subsequent session promotion
-- is still atomically rejected by the terminal session trigger, rolling back
-- the whole legacy transaction when cancellation won first.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_session_cancellation_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'cancelled' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION
      'cancelled session is terminal; refusing status transition to %', NEW."status"
      USING ERRCODE = '55000';
  END IF;

  IF NEW."status" = 'cancelled' AND OLD."status" IS DISTINCT FROM 'cancelled' THEN
    -- Cancellation is terminal.  Do not leave a queued/running turn behind
    -- for a stale workflow or an old worker to claim after this transaction
    -- commits.  The turn trigger is a no-op for the terminal status.
    UPDATE "session_turns"
       SET "status" = 'cancelled',
           "finished_at" = COALESCE("finished_at", now()),
           "updated_at" = now()
     WHERE "workspace_id" = NEW."workspace_id"
       AND "session_id" = NEW."id"
       AND "status" IN ('queued', 'running', 'requires_action');
    NEW."active_turn_id" := NULL;
  ELSIF NEW."status" = 'cancelled' THEN
    NEW."active_turn_id" := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.enforce_live_turn_session_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_status text;
BEGIN
  IF NEW."status" IN ('queued', 'running', 'requires_action') THEN
    IF TG_OP = 'INSERT' THEN
      SELECT session."status"
        INTO session_status
        FROM "sessions" AS session
       WHERE session."workspace_id" = NEW."workspace_id"
         AND session."id" = NEW."session_id"
       FOR UPDATE;
    ELSE
      -- Never lock the parent from a row-level UPDATE trigger: the executor
      -- already holds the session_turns row lock, while cancellation holds
      -- the session row before draining turns.
      SELECT session."status"
        INTO session_status
        FROM "sessions" AS session
       WHERE session."workspace_id" = NEW."workspace_id"
         AND session."id" = NEW."session_id";
    END IF;
    IF session_status = 'cancelled' THEN
      RAISE EXCEPTION
        'cannot write a live turn for a cancelled session'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_cancellation_write_fence ON "sessions";
CREATE TRIGGER sessions_cancellation_write_fence
BEFORE UPDATE ON "sessions"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_session_cancellation_fence();

DROP TRIGGER IF EXISTS session_turns_live_session_fence ON "session_turns";
CREATE TRIGGER session_turns_live_session_fence
BEFORE INSERT OR UPDATE ON "session_turns"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_live_turn_session_fence();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.enforce_session_cancellation_fence() TO opengeni_app'
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.enforce_live_turn_session_fence() TO opengeni_app'
    );
  END IF;
END $$;
