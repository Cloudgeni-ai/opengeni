-- 0034_sandbox_lease_image.sql
-- IMAGE IS SHARED STATE (B3): stamp the container image the group box runs on the lease.
-- A shared box (sandbox:{groupId} / the default SHARE placement) is ONE filesystem across
-- N sessions, so every session that attaches must run the SAME image. This column records
-- the image the live box was created with; a resume whose resolved image DIFFERS is a
-- conflict — a SOLO holder recreates the box on the new image (force cold + re-stamp),
-- N-holders are rejected at the lease layer (SandboxImageConflictError). Nullable (a
-- legacy/cold row reads NULL = "image unknown", which never conflicts) — additive only,
-- forward-only, no backfill. Mirrors 0022's re-grant boilerplate. Runs under the runner's
-- advisory lock.

ALTER TABLE "sandbox_leases" ADD COLUMN IF NOT EXISTS "image" text;

-- Re-grant on the new column (idempotent; mirrors the boilerplate in 0018/0022 so a
-- fresh opengeni_app role can read/write the added column).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
