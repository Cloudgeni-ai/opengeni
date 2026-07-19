-- deployment-mode: rolling
-- OPE-73: keep full post-effect persistence obligations in PostgreSQL. Temporal
-- heartbeat and activity-result payloads carry only bounded opaque references.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "session_turn_persistence_receipts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "trigger_event_id" uuid NOT NULL,
  "obligation_kind" text NOT NULL,
  "obligation_version" integer DEFAULT 1 NOT NULL,
  "obligation_digest" text NOT NULL,
  "obligation" jsonb NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "quarantine_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "quarantined_at" timestamp with time zone,
  CONSTRAINT "session_turn_persistence_receipts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_persistence_receipts_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_turn_persistence_receipts_kind_check"
    CHECK ("obligation_kind" IN ('pending_tool_call', 'model_call', 'context_compaction')),
  CONSTRAINT "session_turn_persistence_receipts_version_check"
    CHECK ("obligation_version" = 1),
  CONSTRAINT "session_turn_persistence_receipts_digest_check"
    CHECK ("obligation_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_turn_persistence_receipts_state_check"
    CHECK ("state" IN ('pending', 'settled', 'quarantined')),
  CONSTRAINT "session_turn_persistence_receipts_terminal_check" CHECK (
    ("state" = 'pending' AND "settled_at" IS NULL AND "quarantined_at" IS NULL AND "quarantine_reason" IS NULL)
    OR ("state" = 'settled' AND "settled_at" IS NOT NULL AND "quarantined_at" IS NULL AND "quarantine_reason" IS NULL)
    OR ("state" = 'quarantined' AND "settled_at" IS NULL AND "quarantined_at" IS NOT NULL AND "quarantine_reason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "session_turn_persistence_receipts_workspace_id_uq"
  ON "session_turn_persistence_receipts" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_turn_persistence_receipts_one_pending_attempt_uq"
  ON "session_turn_persistence_receipts" ("workspace_id", "attempt_id")
  WHERE "state" = 'pending';
CREATE INDEX "session_turn_persistence_receipts_attempt_created_idx"
  ON "session_turn_persistence_receipts" ("workspace_id", "attempt_id", "created_at");

ALTER TABLE "session_turn_persistence_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_persistence_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_turn_persistence_receipts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_turn_persistence_receipts TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;