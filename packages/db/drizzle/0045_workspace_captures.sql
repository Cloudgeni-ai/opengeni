-- Workbench v2 turn-end workspace capture (dossier §10.2; model: 0020 session_recordings).
--
-- One row per capture revision — a point-in-time snapshot of a session's changed
-- files, probed off the live box at TURN END (agent-turn.ts finally, between the
-- warm snapshot and release). The manifest (tree index + per-repo status/diff +
-- file index) and each after-image blob live in @opengeni/storage; this row is
-- the durable index the read routes serve from. `revision` is monotonic per
-- session (unique (session_id, revision)); `blob_keys` records the content-
-- addressed after-image keys this revision references so the keep-latest-10 GC
-- deletes only blobs no surviving revision shares. `lease_epoch` fences a write:
-- insertWorkspaceCapture only writes when a warm lease at that epoch still exists.
--
-- Behind OPENGENI_WORKSPACE_CAPTURE (default on). DDL is inert until the worker
-- writes rows; forward-only, no existing row references it. RLS + grants mirror
-- the current schema-aware boilerplate (0043).

CREATE TABLE IF NOT EXISTS "workspace_captures" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"      uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"    uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,
  "session_id"      uuid NOT NULL REFERENCES "sessions"("id")         ON DELETE CASCADE,
  -- The turn that produced this capture. ON DELETE SET NULL: a deleted turn must
  -- not cascade-kill the capture index row.
  "turn_id"         uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,

  -- Monotonic per session (unique on (session_id, revision)).
  "revision"        bigint NOT NULL,
  -- The lease epoch the capture was fenced under (paired with revision for cache
  -- invalidation client-side).
  "lease_epoch"     integer NOT NULL,
  -- 'available' on a committed capture. 'failed' reserved for a future two-phase
  -- write; the current synchronous capture only ever inserts 'available'.
  "state"           text NOT NULL DEFAULT 'available',

  -- @opengeni/storage keys. manifest = the single JSON blob (tree + repos + file
  -- refs); tree_index = the fs tree blob (kept separate so the API can inline or
  -- sign it independently). blob_keys = the content-addressed after-image keys
  -- this revision references (GC set-difference input).
  "manifest_key"    text,
  "tree_index_key"  text,
  "blob_keys"       jsonb NOT NULL DEFAULT '[]'::jsonb,

  "size_bytes"      bigint,
  "stats"           jsonb NOT NULL DEFAULT '{}'::jsonb,

  "captured_at"     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "workspace_captures_state_chk" CHECK ("state" IN ('available','failed'))
);

-- Monotonic revision per session (the assign-revision + read-latest key).
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_captures_session_revision_idx"
  ON "workspace_captures" ("session_id", "revision");
-- Latest-capture lookup and GC scan without touching the event spine.
CREATE INDEX IF NOT EXISTS "workspace_captures_latest_idx"
  ON "workspace_captures" ("workspace_id", "session_id", "revision" DESC);

-- ============== RLS + grants (schema-aware boilerplate, per 0043) =============
ALTER TABLE "workspace_captures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_captures" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_captures' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_captures";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_captures"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;
