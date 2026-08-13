-- deployment-mode: maintenance
-- One-way semantic cutover: application-provided per-message context becomes
-- ordinary user-role model content. Renaming the legacy columns hard-fences old
-- workers, which would otherwise continue mutating the persistent instruction
-- prefix and defeat prompt caching.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Reject mixed-version writers before locking, then repeat after the locks to
-- close the connect-before-lock race. Keep API and workers stopped until the new
-- application version is active.
DO $model_context_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'model-context user-message activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$model_context_writer_drain_before_lock$;

LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session_turns" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "session_realtime_entries" IN ACCESS EXCLUSIVE MODE;

DO $model_context_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'model-context user-message activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$model_context_writer_drain_after_lock$;

-- A queued turn has not entered model history yet, so the new worker can append
-- its context correctly when it claims the turn. A live/resumable turn may have
-- already shown the context only through the removed instruction-prefix path;
-- fail rather than silently resume it with different model-visible history.
DO $model_context_live_turn_guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "session_turns"
    WHERE "turn_instructions" IS NOT NULL
      AND "status" IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
  )
  THEN
    RAISE EXCEPTION
      'model-context user-message activation requires legacy context-bearing live turns to settle or be superseded'
      USING ERRCODE = '55000';
  END IF;
END
$model_context_live_turn_guard$;

-- Completed historical turns retain their original conversation truth: their
-- context was model-visible only through the legacy exact-turn prefix and must
-- not be rewritten into later persistent history. Only queued turns cross the
-- cutover into the new same-message semantics; live/resumable turns are rejected
-- above so no attempt can straddle both representations.

ALTER TABLE "sessions"
  RENAME COLUMN "initial_turn_instructions" TO "initial_model_context";

ALTER TABLE "session_turns"
  RENAME COLUMN "turn_instructions" TO "model_context";

ALTER TABLE "session_realtime_entries"
  ADD COLUMN "model_context" text;

ALTER TABLE "session_realtime_entries"
  ADD CONSTRAINT "session_realtime_entries_model_context_check"
  CHECK (
    "model_context" IS NULL
    OR (
      "direction" = 'provider_in'
      AND "kind" IN ('delegation_call', 'user_transcript', 'assistant_transcript')
      AND "model_context" = btrim("model_context")
      AND char_length("model_context") BETWEEN 1 AND 32768
    )
  ) NOT VALID;

ALTER TABLE "session_realtime_entries"
  VALIDATE CONSTRAINT "session_realtime_entries_model_context_check";

COMMENT ON COLUMN "sessions"."initial_model_context" IS
  'Application context frozen with the winning initial user message; ordinary model-visible user-role content, omitted by standard timeline rendering.';
COMMENT ON COLUMN "session_turns"."model_context" IS
  'Application context for the exact accepted user message; copied into canonical model history at first claim.';
COMMENT ON COLUMN "session_realtime_entries"."model_context" IS
  'Application context attached to an exact provider-in delegation or finalized transcript and materialized as ordinary user-role content.';
