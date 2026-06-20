-- Channel-A interactive PTY sessions — the ONLY new persistent state the
-- structured-services surface needs (P4.4; design-of-record
-- modules/08-channel-a.md §3.1).
--
-- FS list/read/write/search and Git status/diff/log/show are STATELESS point
-- queries against the live box (resume-by-id, run, drop) — they persist nothing;
-- their notifications (fs.changed/git.changed) ride the existing session_events
-- log. An interactive PTY, by contrast, is a live in-box process: we map our
-- UUID ptyId <-> the SDK's numeric exec-session id (writeStdin({ sessionId })),
-- the owning workspace/session, the lease_epoch that fences the PTY to the box
-- it was opened on, and a last_input_at heartbeat so the one global reaper can
-- kill idle PTYs (TTL) and PTYs stranded by a box re-key (epoch mismatch ->
-- terminal.pty.exited{reason:"owner_gone"}).
--
-- DDL is INERT until the API wires the PTY routes (gated behind
-- sandboxOwnershipEnabled). Forward-only, behavior-preserving: no existing row
-- references it.

CREATE TABLE IF NOT EXISTS "sandbox_pty_sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, -- == ptyId on the wire
  "account_id"      uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"    uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,
  "session_id"      uuid NOT NULL REFERENCES "sessions"("id")         ON DELETE CASCADE,
  -- The SDK numeric exec-session id used by writeStdin({ sessionId }). NULL until
  -- the open exec yields a still-running process (a fast-exiting shell has none).
  "exec_session_id" integer,
  "lease_epoch"     integer NOT NULL, -- fenced to the box that opened it
  "cols"            integer NOT NULL,
  "rows"            integer NOT NULL,
  "shell"           text NOT NULL,
  "cwd"             text NOT NULL,
  "status"          text NOT NULL DEFAULT 'open', -- 'open' | 'closed'
  -- The viewer grant/subject that opened it (free-text — access subjects are not
  -- always UUIDs, so a text column, never a uuid NOT NULL).
  "opened_by"       text NOT NULL,
  "last_input_at"   timestamptz NOT NULL DEFAULT now(),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "closed_at"       timestamptz,

  CONSTRAINT "sandbox_pty_sessions_status_chk" CHECK ("status" IN ('open','closed'))
);

-- List a session's OPEN PTYs (for reattach + reap) without scanning closed rows.
CREATE INDEX IF NOT EXISTS "sandbox_pty_sessions_session_idx"
  ON "sandbox_pty_sessions" ("workspace_id", "session_id")
  WHERE "status" = 'open';

-- ============== RLS + grants (verbatim 0017/0019/0020 boilerplate) ===========
ALTER TABLE "sandbox_pty_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_pty_sessions" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sandbox_pty_sessions' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "sandbox_pty_sessions";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_pty_sessions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sandbox_pty_sessions" TO opengeni_app;
  END IF;
END $$;
