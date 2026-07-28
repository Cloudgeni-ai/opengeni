-- deployment-mode: rolling
-- Durable GPT-Live connection rotation and compact transcript/update/ACK ledger.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "session_realtime_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "realtime_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "connection_epoch" integer NOT NULL,
  "state" text DEFAULT 'negotiating' NOT NULL,
  "sdp_answer" text,
  "failure_code" text,
  "negotiated_at" timestamptz,
  "closed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "session_realtime_connections_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_connections_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_connections_realtime_fk"
    FOREIGN KEY ("realtime_id")
    REFERENCES "session_realtime_modes" ("id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_connections_epoch_check"
    CHECK ("connection_epoch" >= 1),
  CONSTRAINT "session_realtime_connections_state_check"
    CHECK ("state" IN ('negotiating', 'active', 'failed', 'closed')),
  CONSTRAINT "session_realtime_connections_sdp_check"
    CHECK ("sdp_answer" IS NULL OR octet_length("sdp_answer") BETWEEN 1 AND 1048576),
  CONSTRAINT "session_realtime_connections_failure_check"
    CHECK ("failure_code" IS NULL OR octet_length("failure_code") BETWEEN 1 AND 128),
  CONSTRAINT "session_realtime_connections_terminal_check"
    CHECK (
      ("state" = 'negotiating' AND "sdp_answer" IS NULL AND "failure_code" IS NULL AND "negotiated_at" IS NULL AND "closed_at" IS NULL)
      OR
      ("state" = 'active' AND "sdp_answer" IS NOT NULL AND "failure_code" IS NULL AND "negotiated_at" IS NOT NULL AND "closed_at" IS NULL)
      OR
      ("state" = 'failed' AND "sdp_answer" IS NULL AND "failure_code" IS NOT NULL AND "closed_at" IS NOT NULL)
      OR
      ("state" = 'closed' AND "closed_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "session_realtime_connections_operation_uq"
  ON "session_realtime_connections" ("realtime_id", "operation_id");
CREATE UNIQUE INDEX "session_realtime_connections_epoch_uq"
  ON "session_realtime_connections" ("realtime_id", "connection_epoch");
CREATE UNIQUE INDEX "session_realtime_connections_one_open_uq"
  ON "session_realtime_connections" ("realtime_id")
  WHERE "state" IN ('negotiating', 'active');

CREATE TABLE "session_realtime_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "realtime_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "connection_epoch" integer NOT NULL,
  "sequence" integer NOT NULL,
  "direction" text NOT NULL,
  "kind" text NOT NULL,
  "role" text,
  "provider_event_id" text,
  "delegation_item_id" text,
  "source_update_id" uuid,
  "history_item_id" uuid,
  "text" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "client_acked_at" timestamptz,
  "provider_acked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "session_realtime_entries_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_entries_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_entries_realtime_fk"
    FOREIGN KEY ("realtime_id")
    REFERENCES "session_realtime_modes" ("id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_entries_source_update_fk"
    FOREIGN KEY ("source_update_id")
    REFERENCES "session_system_updates" ("id") ON DELETE SET NULL,
  CONSTRAINT "session_realtime_entries_history_item_fk"
    FOREIGN KEY ("history_item_id")
    REFERENCES "session_history_items" ("id") ON DELETE SET NULL,
  CONSTRAINT "session_realtime_entries_epoch_check"
    CHECK ("connection_epoch" >= 1),
  CONSTRAINT "session_realtime_entries_sequence_check"
    CHECK ("sequence" >= 1),
  CONSTRAINT "session_realtime_entries_direction_check"
    CHECK ("direction" IN ('provider_in', 'provider_out')),
  CONSTRAINT "session_realtime_entries_kind_check"
    CHECK ("kind" IN (
      'user_transcript',
      'assistant_transcript',
      'delegation_call',
      'delegation_result',
      'interruption',
      'session_update',
      'error'
    )),
  CONSTRAINT "session_realtime_entries_role_check"
    CHECK ("role" IS NULL OR "role" IN ('user', 'assistant')),
  CONSTRAINT "session_realtime_entries_provider_event_check"
    CHECK ("provider_event_id" IS NULL OR octet_length("provider_event_id") BETWEEN 1 AND 1024),
  CONSTRAINT "session_realtime_entries_delegation_item_check"
    CHECK ("delegation_item_id" IS NULL OR octet_length("delegation_item_id") BETWEEN 1 AND 1024),
  CONSTRAINT "session_realtime_entries_text_check"
    CHECK ("text" IS NULL OR octet_length("text") <= 131072),
  CONSTRAINT "session_realtime_entries_payload_check"
    CHECK (octet_length("payload"::text) <= 131072),
  CONSTRAINT "session_realtime_entries_transcript_check"
    CHECK (
      ("kind" = 'user_transcript' AND "role" = 'user' AND "text" IS NOT NULL)
      OR
      ("kind" = 'assistant_transcript' AND "role" = 'assistant' AND "text" IS NOT NULL)
      OR
      ("kind" NOT IN ('user_transcript', 'assistant_transcript') AND "role" IS NULL)
    )
);

CREATE UNIQUE INDEX "session_realtime_entries_operation_uq"
  ON "session_realtime_entries" ("realtime_id", "operation_id");
CREATE UNIQUE INDEX "session_realtime_entries_sequence_uq"
  ON "session_realtime_entries" ("realtime_id", "sequence");
CREATE UNIQUE INDEX "session_realtime_entries_source_update_uq"
  ON "session_realtime_entries" ("realtime_id", "source_update_id")
  WHERE "source_update_id" IS NOT NULL;
CREATE INDEX "session_realtime_entries_outbound_pending_idx"
  ON "session_realtime_entries" ("realtime_id", "sequence")
  WHERE "direction" = 'provider_out'
    AND ("client_acked_at" IS NULL OR "provider_acked_at" IS NULL);

ALTER TABLE "session_realtime_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_realtime_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_realtime_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_realtime_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "session_realtime_connections"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "session_realtime_entries"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_realtime_connections, %I.session_realtime_entries TO opengeni_app',
      target_schema,
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;