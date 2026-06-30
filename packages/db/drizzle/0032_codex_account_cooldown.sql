-- 0032_codex_account_cooldown.sql
-- Multi-account P3 (auto-rotation): one cooldown column on codex_subscription_credentials.
-- `exhausted_until` is PLAINTEXT metadata (a timestamp), NEVER a token or secret. It marks
-- an account as cooling-down until its usage cap resets, so the rotation engine deterministically
-- skips a just-rotated-off account until then (no immediate re-pick, no thrash). The column
-- self-clears via the now() comparison at read time — no sweeper. RLS is row-level, so the
-- existing workspace_isolation policy already covers it — NO policy change. Additive only
-- (mirrors 0031's style). Runs under the runner's advisory lock.

ALTER TABLE "codex_subscription_credentials" ADD COLUMN IF NOT EXISTS "exhausted_until" timestamptz;

-- Re-grant (verbatim from 0031:17-22) so opengeni_app keeps DML on the altered table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
