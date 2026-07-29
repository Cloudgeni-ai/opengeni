-- deployment-mode: rolling
-- Exactly-once, turn-scoped projection of completed realtime history into normal inference.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "session_realtime_context_projections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "context" text,
  "source_mode_count" integer NOT NULL,
  "source_entry_count" integer NOT NULL,
  "included_entry_count" integer NOT NULL,
  "omitted_entry_count" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "session_realtime_context_projections_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_context_projections_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_context_projections_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_realtime_context_projections_context_check"
    CHECK ("context" IS NULL OR octet_length("context") BETWEEN 1 AND 65536),
  CONSTRAINT "session_realtime_context_projections_counts_check"
    CHECK (
      "source_mode_count" >= 1
      AND "source_entry_count" >= 0
      AND "included_entry_count" >= 0
      AND "omitted_entry_count" >= 0
      AND "included_entry_count" + "omitted_entry_count" = "source_entry_count"
      AND (("source_entry_count" = 0 AND "context" IS NULL)
        OR ("source_entry_count" > 0 AND "context" IS NOT NULL))
    )
);

CREATE UNIQUE INDEX "session_realtime_context_projections_turn_uq"
  ON "session_realtime_context_projections" ("workspace_id", "session_id", "turn_id");

ALTER TABLE "session_realtime_context_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_realtime_context_projections" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "session_realtime_context_projections"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "session_realtime_modes"
  ADD COLUMN "context_projection_id" uuid,
  ADD COLUMN "context_projected_at" timestamptz,
  ADD CONSTRAINT "session_realtime_modes_context_projection_fk"
    FOREIGN KEY ("context_projection_id")
    REFERENCES "session_realtime_context_projections" ("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "session_realtime_modes_context_projection_check"
    CHECK (
      ("context_projection_id" IS NULL AND "context_projected_at" IS NULL)
      OR
      ("context_projection_id" IS NOT NULL AND "context_projected_at" IS NOT NULL AND "state" = 'ended')
    );

CREATE INDEX "session_realtime_modes_pending_context_idx"
  ON "session_realtime_modes" ("workspace_id", "session_id", "ended_at", "id")
  WHERE "state" = 'ended' AND "context_projection_id" IS NULL;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_realtime_context_projections TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;
