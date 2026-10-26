-- deployment-mode: rolling
-- Agent profiles, second step: an agent's home chat and the instruction
-- updates its chats propose. Older binaries never read the new column or table.
--
-- home_session_id: the one chat "go to this agent" opens (and a mention of the
-- agent messages). Display and routing metadata only; no foreign key, so a
-- deleted chat simply leaves an unresolved pointer that readers ignore.
--
-- agent_profile_proposals: an agent working in a chat that wears a saved
-- profile may propose new instructions for that profile. A proposal is never
-- applied by the agent: a person accepts it, which records an ordinary new
-- profile version. Each proposal names the chat it came from, so like every
-- other chat-linked row it is visible only to someone who can see that chat.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "agent_profiles"
  ADD COLUMN "home_session_id" uuid;

CREATE TABLE "agent_profile_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  -- The profile version the proposal was written against.
  "base_version" integer NOT NULL,
  "session_id" uuid NOT NULL,
  "proposed_by" text,
  "instructions" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  -- The profile version an accepted proposal produced.
  "accepted_version" integer,
  "decided_by" text,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_profile_proposals_base_version_chk" CHECK ("base_version" >= 1),
  CONSTRAINT "agent_profile_proposals_instructions_chk"
    CHECK (length("instructions") BETWEEN 1 AND 65536),
  CONSTRAINT "agent_profile_proposals_reason_chk" CHECK (length("reason") BETWEEN 1 AND 400),
  CONSTRAINT "agent_profile_proposals_status_chk"
    CHECK (("status" = 'pending' AND "decided_at" IS NULL AND "accepted_version" IS NULL)
      OR ("status" = 'accepted' AND "decided_at" IS NOT NULL AND "accepted_version" IS NOT NULL)
      OR ("status" = 'dismissed' AND "decided_at" IS NOT NULL AND "accepted_version" IS NULL)),
  CONSTRAINT "agent_profile_proposals_profile_fk"
    FOREIGN KEY ("workspace_id", "profile_id")
    REFERENCES "agent_profiles"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "agent_profile_proposals_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);

CREATE INDEX "agent_profile_proposals_profile_status_idx"
  ON "agent_profile_proposals" ("workspace_id", "profile_id", "status", "created_at");
CREATE INDEX "agent_profile_proposals_session_idx"
  ON "agent_profile_proposals" ("workspace_id", "session_id");

ALTER TABLE "agent_profile_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_profile_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "agent_profile_proposals"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation ON "agent_profile_proposals" AS RESTRICTIVE
  FOR ALL USING (session_reference_visible("account_id", "workspace_id", "session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "session_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.agent_profile_proposals TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
