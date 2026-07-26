-- deployment-mode: rolling
-- Existing rows and old rolling-deploy writers receive an explicit service
-- sentinel. Host credential resolvers must reject that sentinel; it is never
-- inferred back to a session creator.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "created_by_kind" text NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS "created_by_subject_id" text NOT NULL DEFAULT 'unattributed-legacy',
  ADD COLUMN IF NOT EXISTS "created_by_context" jsonb NOT NULL DEFAULT '{"backfill":true}'::jsonb;

ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "initiator_kind" text NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS "initiator_subject_id" text NOT NULL DEFAULT 'unattributed-legacy',
  ADD COLUMN IF NOT EXISTS "initiator_context" jsonb NOT NULL DEFAULT '{"backfill":true}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sessions_created_by_kind_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_created_by_kind_check"
      CHECK ("created_by_kind" IN ('subject', 'service')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_turns_initiator_kind_check'
      AND conrelid = 'session_turns'::regclass
  ) THEN
    ALTER TABLE "session_turns"
      ADD CONSTRAINT "session_turns_initiator_kind_check"
      CHECK ("initiator_kind" IN ('subject', 'service')) NOT VALID;
  END IF;
END $$;

ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_created_by_kind_check";
ALTER TABLE "session_turns" VALIDATE CONSTRAINT "session_turns_initiator_kind_check";

CREATE OR REPLACE FUNCTION opengeni_private.prevent_session_creator_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by_kind IS DISTINCT FROM OLD.created_by_kind
    OR NEW.created_by_subject_id IS DISTINCT FROM OLD.created_by_subject_id
    OR NEW.created_by_context IS DISTINCT FROM OLD.created_by_context
  THEN
    RAISE EXCEPTION 'session creator is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.prevent_session_turn_initiator_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.initiator_kind IS DISTINCT FROM OLD.initiator_kind
    OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
    OR NEW.initiator_context IS DISTINCT FROM OLD.initiator_context
  THEN
    RAISE EXCEPTION 'session turn initiator is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'sessions_creator_immutable'
      AND tgrelid = 'sessions'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER sessions_creator_immutable
      BEFORE UPDATE OF created_by_kind, created_by_subject_id, created_by_context
      ON "sessions"
      FOR EACH ROW
      EXECUTE FUNCTION opengeni_private.prevent_session_creator_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'session_turns_initiator_immutable'
      AND tgrelid = 'session_turns'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER session_turns_initiator_immutable
      BEFORE UPDATE OF initiator_kind, initiator_subject_id, initiator_context
      ON "session_turns"
      FOR EACH ROW
      EXECUTE FUNCTION opengeni_private.prevent_session_turn_initiator_mutation();
  END IF;
END $$;
