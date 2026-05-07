CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "initial_message" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "model" text NOT NULL,
  "sandbox_backend" text NOT NULL,
  "temporal_workflow_id" text,
  "active_turn_id" uuid,
  "last_sequence" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "session_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "trigger_event_id" uuid NOT NULL,
  "temporal_workflow_id" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "client_event_id" text,
  "producer_id" text,
  "producer_seq" integer,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "agent_run_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,
  "state_version" integer NOT NULL,
  "serialized_run_state" text NOT NULL,
  "pending_approvals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_sequence_idx" ON "session_events" ("session_id", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_client_event_idx" ON "session_events" ("session_id", "client_event_id") WHERE "client_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_producer_idx" ON "session_events" ("session_id", "producer_id", "producer_seq") WHERE "producer_id" IS NOT NULL AND "producer_seq" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session_events_session_created_idx" ON "session_events" ("session_id", "created_at");
