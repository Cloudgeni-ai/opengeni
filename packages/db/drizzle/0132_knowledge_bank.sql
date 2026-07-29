-- deployment-mode: rolling
-- Knowledge bank: a versioned, agent-maintained workspace charter (purpose +
-- goals + knowledge-map narrative) plus per-workspace sweep state.
--
-- workspace_charters is append-only version history: every update (agent sweep,
-- agent MCP proposal, or human edit) inserts the next version; nothing is
-- rewritten, so provenance survives. knowledge_bank_state carries the dirty
-- marker the background sweep consumes, the human lock (a locked bank is never
-- overwritten by machine synthesis), and sweep bookkeeping.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "workspace_charters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "purpose" text NOT NULL,
  "goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "overview" text,
  "base_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "changelog" text,
  "updated_by" text NOT NULL,
  "model" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_charters_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_charters_version_check" CHECK ("version" >= 1),
  CONSTRAINT "workspace_charters_updated_by_check" CHECK (length(btrim("updated_by")) > 0)
);

CREATE UNIQUE INDEX "workspace_charters_workspace_version_uq"
  ON "workspace_charters" ("workspace_id", "version");

CREATE TABLE "knowledge_bank_state" (
  "workspace_id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "dirty_at" timestamptz,
  "last_swept_at" timestamptz,
  "last_error" text,
  "locked" boolean DEFAULT false NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_bank_state_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE
);

ALTER TABLE "workspace_charters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_charters" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_bank_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_bank_state" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_charters"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON "knowledge_bank_state"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.workspace_charters TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.knowledge_bank_state TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

-- The background sweep cannot enumerate FORCE-RLS workspaces directly, so this
-- tightly-scoped SECURITY DEFINER function is the sanctioned cross-workspace
-- claim seam (same convention as claim_expired_file_upload_cleanup in 0052).
-- It returns only routing ids; no charter content is exposed. Claiming stamps
-- dirty_at forward rather than clearing it, so a crashed sweep re-claims after
-- p_reclaim_ms; only a successful sweep clears dirty via the ordinary
-- workspace-RLS helper.
CREATE OR REPLACE FUNCTION opengeni_private.claim_dirty_knowledge_banks(
  p_reclaim_ms bigint,
  p_limit integer
)
RETURNS TABLE (
  workspace_id uuid,
  account_id uuid
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH candidates AS (
    SELECT S.workspace_id
    FROM knowledge_bank_state S
    WHERE
      S.dirty_at IS NOT NULL
      AND S.dirty_at <= clock_timestamp()
    ORDER BY S.dirty_at, S.workspace_id
    LIMIT least(greatest(p_limit, 0), 100)
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE knowledge_bank_state S
    SET
      dirty_at = clock_timestamp() + (
        greatest(p_reclaim_ms, 0)::double precision * interval '1 millisecond'
      ),
      updated_at = clock_timestamp()
    FROM candidates C
    WHERE S.workspace_id = C.workspace_id
    RETURNING S.workspace_id, S.account_id
  )
  SELECT workspace_id, account_id FROM claimed;
$$;

REVOKE ALL ON FUNCTION opengeni_private.claim_dirty_knowledge_banks(bigint, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_dirty_knowledge_banks(bigint, integer)
      TO opengeni_app;
  END IF;
END $$;

RESET statement_timeout;
RESET lock_timeout;
