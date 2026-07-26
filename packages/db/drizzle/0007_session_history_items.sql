-- Conversation truth as ordered, verbatim SDK input items (issue #35).
-- The model-facing memory store: unredacted, replay-ready AgentInputItem JSON.
-- session_events stays the redacted human/audit timeline; agent_run_states
-- shrinks to mid-turn approval resume.
CREATE TABLE IF NOT EXISTS "session_history_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,
  "position" integer NOT NULL,
  "item" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_history_items_position_idx"
  ON "session_history_items" ("workspace_id", "session_id", "position");
ALTER TABLE "session_history_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_history_items" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'session_history_items' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_history_items";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_history_items"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Sandbox recovery descriptor, decoupled from the RunState blob: the small
-- versioned envelope (provider handle / snapshot ref / manifest) needed to
-- reattach, restore, or rebuild the sandbox for a session's next turn.
CREATE TABLE IF NOT EXISTS "sandbox_session_envelopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "envelope" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_session_envelopes_session_idx"
  ON "sandbox_session_envelopes" ("workspace_id", "session_id");
ALTER TABLE "sandbox_session_envelopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_session_envelopes" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'sandbox_session_envelopes' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "sandbox_session_envelopes";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_session_envelopes"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
