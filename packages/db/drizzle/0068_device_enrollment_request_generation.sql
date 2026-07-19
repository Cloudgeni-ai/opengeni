-- deployment-mode: rolling
-- Bind each approved device authorization code to the exact enrollment
-- credential family created by that approval. Existing approved/consumed rows
-- deliberately remain NULL and therefore fail closed instead of inheriting a
-- newer generation after revocation or re-enrollment.

ALTER TABLE "device_enrollment_requests"
  ADD COLUMN IF NOT EXISTS "credential_generation" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'device_enrollment_requests'::regclass
       AND conname = 'device_enrollment_requests_credential_generation_positive'
  ) THEN
    ALTER TABLE "device_enrollment_requests"
      ADD CONSTRAINT "device_enrollment_requests_credential_generation_positive"
      CHECK ("credential_generation" IS NULL OR "credential_generation" > 0)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "device_enrollment_requests"
  VALIDATE CONSTRAINT "device_enrollment_requests_credential_generation_positive";