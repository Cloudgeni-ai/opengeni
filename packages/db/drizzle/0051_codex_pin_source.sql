-- 0051_codex_pin_source.sql
-- Sharded codex rotation (AM-2): a SOURCE discriminator for the per-session codex pin.
-- `codex_pin_source` is 'manual' (the user's in-session account switcher — SACRED, no
-- policy path ever moves it) or 'policy' (the sharded strategy's deterministic home
-- assignment — MAY be re-sharded when its account caps). NULL means no pin. Plaintext
-- metadata, NEVER a token. Additive only; RLS is row-level so the existing sessions
-- workspace_isolation policy already covers the column — NO policy change. Runs under the
-- runner's advisory lock (no app traffic sees the ALTER/backfill window).

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "codex_pin_source" text;

-- Backfill: every PRE-EXISTING pin is a MANUAL pin. INVARIANT — before this migration the
-- ONLY writer of sessions.codex_pinned_credential_id was setSessionCodexPin via the manual
-- in-session account-switcher API route (no rotation/policy path wrote a pin). So a
-- currently-pinned session is, by construction, a user's manual pin and must be stamped
-- 'manual' — otherwise a NULL source would strip it of its sacredness the moment the
-- sharded strategy is enabled (a policy path could re-shard the user's chosen account).
-- Migrations run as the table owner; FORCE RLS would subject this UPDATE to the
-- workspace-scoped policy (matching zero rows, no GUCs set), so drop FORCE only for the
-- owner around the backfill (precedent 0009/0028) — the app role stays policy-bound and
-- FORCE is restored in the same implicit transaction.
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
UPDATE "sessions"
  SET "codex_pin_source" = 'manual'
  WHERE "codex_pinned_credential_id" IS NOT NULL AND "codex_pin_source" IS NULL;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;

-- Constrain to the two known sources (or NULL). IF NOT EXISTS guard so a re-run is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_codex_pin_source_check') THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_codex_pin_source_check"
      CHECK ("codex_pin_source" IS NULL OR "codex_pin_source" IN ('manual', 'policy'));
  END IF;
END $$;

-- Re-grant (schema-agnostic, matching 0049/0050) so opengeni_app keeps DML on the altered
-- table under a dedicated (non-public) schema too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;
