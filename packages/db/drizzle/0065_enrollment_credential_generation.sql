-- deployment-mode: rolling
-- OPE-14 enrollment credential-generation fence.
--
-- Schema-first/backward-compatible rollout: every pre-existing enrollment is
-- generation 1, matching legacy signed bearers that did not carry an explicit
-- generation claim. New binaries atomically increment this column whenever the
-- same machine identity is enrolled again and require the signed claim to match.

ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "credential_generation" integer NOT NULL DEFAULT 1;