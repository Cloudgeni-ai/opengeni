-- Per-session sandbox OS + the shared-sandbox group identity.
--
-- Two forward-only, behavior-preserving column adds (P0.5; design-of-record
-- 08-implementation-plan.md P0.5 + 05-addendum-shared-sandboxes.md B.1):
--
-- (a) OS axis. sessions.sandbox_os carries the OS the session's box runs
--     (default 'linux' — today's only OS, so every existing + new row is
--     'linux' with no behavior change). session_turns.sandbox_os is a NULLable
--     per-turn override (NULL = inherit the session's OS). Both CHECK-constrained
--     to the SandboxOs enum (linux|macos|windows). The OS is also stamped into
--     the recovery-envelope JSON so re-establish needs no DB join.
--
-- (b) Shared-sandbox group. sessions.sandbox_group_id is the BOX's identity:
--     every session that founds its own box has sandbox_group_id == id (a
--     singleton group, group === session), so today's 1:1 world is a
--     behavior-preserving no-op. A session spawned shared inherits its parent's
--     sandbox_group_id so both run in ONE box. The live lease row (0017), not a
--     sandbox_groups table, materializes "this group has a box."
--
--     DELIBERATELY NOT an FK to sessions(id): the value is either this row's own
--     id or an ANCESTOR session's id in the same workspace. An FK would let a
--     founder's deletion cascade-kill a box still in use by a spawned session
--     (addendum stress b.1). Do not "tidy" this into an FK.
--
--     The value cannot SQL-default to id (id is gen_random_uuid(), unknown at
--     default-eval time) — the app generates one uuid and uses it for both id
--     and sandbox_group_id in a single insert. The column is added NULLable for
--     the backfill, populated (= id for every existing row), then SET NOT NULL.

-- (a) OS axis ---------------------------------------------------------------

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "sandbox_os" text NOT NULL DEFAULT 'linux';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sessions_sandbox_os_check'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_sandbox_os_check"
      CHECK ("sandbox_os" IN ('linux', 'macos', 'windows'));
  END IF;
END $$;

ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "sandbox_os" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_sandbox_os_check'
  ) THEN
    ALTER TABLE "session_turns"
      ADD CONSTRAINT "session_turns_sandbox_os_check"
      CHECK ("sandbox_os" IS NULL OR "sandbox_os" IN ('linux', 'macos', 'windows'));
  END IF;
END $$;

-- (b) Shared-sandbox group identity -----------------------------------------

-- 1. Add NULLable transiently for the backfill.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "sandbox_group_id" uuid;

-- 2. Backfill: every existing session is its OWN singleton group (group === id).
--    This is the behavior-preserving identity that makes the whole change a
--    no-op for today's 1:1 world.
UPDATE "sessions" SET "sandbox_group_id" = "id" WHERE "sandbox_group_id" IS NULL;

-- 3. Enforce NOT NULL (the app supplies the value on every insert from here on).
ALTER TABLE "sessions"
  ALTER COLUMN "sandbox_group_id" SET NOT NULL;

-- 4. Routing index: resolve session_id -> sandbox_group_id at every lease entry
--    point (turn resume-by-id, viewer attach) and enumerate "all sessions in a
--    group" for attribution/disclosure. Workspace-scoped (the workspace is the
--    access boundary; the group uuid is not).
CREATE INDEX IF NOT EXISTS "sessions_sandbox_group_idx"
  ON "sessions" ("workspace_id", "sandbox_group_id");

-- Re-grant on the new columns (idempotent; mirrors the boilerplate in earlier
-- migrations so a fresh opengeni_app role can read/write the added columns).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
