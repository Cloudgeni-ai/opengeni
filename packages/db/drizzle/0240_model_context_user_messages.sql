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
LOCK TABLE "slack_interactions" IN ACCESS EXCLUSIVE MODE;

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

-- Slack safety restrictions formerly rode the same legacy per-turn prefix. Move
-- them to durable session-level authority before that prefix is removed. Match
-- the reservation identity as well as bound routes so a create-before-bind crash
-- cannot strand an existing Slack session without its safety policy. Preserve any
-- pre-existing session persona exactly, and fail rather than truncate it.
DO $model_context_slack_session_policy$
DECLARE
  slack_policy CONSTANT text := $slack_policy$This session is an OpenGeni Slack task surface. Treat Slack message and thread context as task-local unless a separate explicit authorized user action says otherwise. Execute direct, safe, sufficiently specified requests immediately. Ask one concise clarifying question only when materially required information is missing or the requested action is risky, irreversible, or authorization-sensitive. Do not write Slack context to Documents, Knowledge, Memory, preferences, Workspace Charter, instructions, or policy unless a separate explicit authorized user action requests it. Never expose private reasoning, credentials, secrets, raw logs, or unbounded output. Keep user-visible output concise, bounded, and safe to send back to Slack.$slack_policy$;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "sessions" session_row
    WHERE EXISTS (
      SELECT 1
      FROM "slack_interactions" interaction
      WHERE interaction."session_reservation_id" = session_row."id"
    )
      AND NULLIF(btrim(session_row."instructions"), '') IS NOT NULL
      AND position(slack_policy in session_row."instructions") = 0
      AND char_length(session_row."instructions") + 2 + char_length(slack_policy) > 32768
  )
  THEN
    RAISE EXCEPTION
      'model-context activation cannot append Slack session safety instructions within the session instruction bound'
      USING ERRCODE = '22001';
  END IF;

  UPDATE "sessions" session_row
  SET "instructions" = CASE
    WHEN NULLIF(btrim(session_row."instructions"), '') IS NULL THEN slack_policy
    WHEN position(slack_policy in session_row."instructions") > 0 THEN session_row."instructions"
    ELSE session_row."instructions" || E'\n\n' || slack_policy
  END
  WHERE EXISTS (
    SELECT 1
    FROM "slack_interactions" interaction
    WHERE interaction."session_reservation_id" = session_row."id"
  );
END
$model_context_slack_session_policy$;

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
