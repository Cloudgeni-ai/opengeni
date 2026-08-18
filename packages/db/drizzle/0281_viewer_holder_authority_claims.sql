-- deployment-mode: rolling
-- Migration 0281: viewer lease holders record the authenticated viewer
-- subject and the session authority epoch observed when the viewer attached.
--
-- Stream tokens (`ogs_`) previously carried only workspace/session/viewer/
-- lease-epoch claims with a 120 s TTL: nothing bound a live stream to the
-- human (or API principal) watching it, and an authority revocation
-- (session authority epoch advance) left in-TTL tokens indistinguishable
-- from current ones. The token now carries optional `subjectId` and
-- `authorityEpoch` claims minted from live state, and the viewer holder row
-- records the same pair so revocation sweeps and audits can resolve exactly
-- who was attached under which authority.
--
-- Rolling window: two nullable columns; old images keep inserting holder
-- rows without them, and old token verifiers (TypeScript zod strips unknown
-- keys; the Rust relay's serde ignores unknown fields) accept new tokens
-- while enforcing nothing new. The claims are identities and epochs only -
-- never a secret value - and the 120 s TTL is unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "sandbox_lease_holders"
  ADD COLUMN IF NOT EXISTS "viewer_subject_id" text,
  ADD COLUMN IF NOT EXISTS "viewer_authority_epoch" integer;

DO $viewer_holder_authority_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sandbox_lease_holders_viewer_authority_check'
      AND conrelid = 'sandbox_lease_holders'::regclass
  ) THEN
    ALTER TABLE "sandbox_lease_holders"
      ADD CONSTRAINT "sandbox_lease_holders_viewer_authority_check"
      CHECK (
        ("viewer_authority_epoch" IS NULL OR "viewer_authority_epoch" > 0)
        AND ("viewer_subject_id" IS NULL
          OR length(btrim("viewer_subject_id")) BETWEEN 1 AND 512)
      ) NOT VALID;
  END IF;
END
$viewer_holder_authority_check$;
ALTER TABLE "sandbox_lease_holders"
  VALIDATE CONSTRAINT "sandbox_lease_holders_viewer_authority_check";

COMMENT ON COLUMN "sandbox_lease_holders"."viewer_subject_id" IS
  'Authenticated subject that attached this viewer holder. Identity only - '
  'never a secret value. NULL for non-viewer holders and pre-0281 rows.';
COMMENT ON COLUMN "sandbox_lease_holders"."viewer_authority_epoch" IS
  'Session authority epoch observed when the viewer attached; the stream '
  'token minted for this holder carries the same claim.';
