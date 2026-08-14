-- deployment-mode: rolling
-- Bind every device-flow approval to the exact enrollment credential family it
-- authorized, and bind machine-removal receipts to the same tenant as their
-- enrollment. Both fences remain compatible with rolling old API writers.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "device_enrollment_requests"
  ADD COLUMN IF NOT EXISTS "enrollment_credential_generation" integer;

-- Generation one is unambiguous: no re-enrollment has occurred. A terminal
-- request for a later current generation cannot be reconstructed safely because
-- headless enrollment and retention may have removed intermediate evidence.
-- Deny that ambiguous legacy request so an old API binary also fails closed.
UPDATE "device_enrollment_requests" AS request
SET "enrollment_credential_generation" = 1
FROM "enrollments" AS enrollment
WHERE request."enrollment_id" = enrollment."id"
  AND request."workspace_id" = enrollment."workspace_id"
  AND request."status" IN ('approved', 'consumed')
  AND request."enrollment_credential_generation" IS NULL
  AND enrollment."credential_generation" = 1;

UPDATE "device_enrollment_requests" AS request
SET "status" = 'denied',
    "updated_at" = now()
FROM "enrollments" AS enrollment
WHERE request."enrollment_id" = enrollment."id"
  AND request."workspace_id" = enrollment."workspace_id"
  AND request."status" IN ('approved', 'consumed')
  AND request."enrollment_credential_generation" IS NULL
  AND enrollment."credential_generation" <> 1;

CREATE OR REPLACE FUNCTION opengeni_private.bind_device_enrollment_credential_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_generation integer;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.enrollment_credential_generation IS NOT NULL
    AND NEW.enrollment_credential_generation IS DISTINCT FROM OLD.enrollment_credential_generation
  THEN
    RAISE EXCEPTION 'device enrollment credential generation is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('approved', 'consumed') THEN
    IF NEW.enrollment_id IS NULL THEN
      RAISE EXCEPTION 'terminal device enrollment request requires an enrollment'
        USING ERRCODE = '23514';
    END IF;

    SELECT enrollment.credential_generation
      INTO current_generation
      FROM enrollments AS enrollment
      WHERE enrollment.id = NEW.enrollment_id
        AND enrollment.workspace_id = NEW.workspace_id;

    IF current_generation IS NULL THEN
      RAISE EXCEPTION 'device enrollment request references no enrollment in its workspace'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.enrollment_credential_generation IS NULL THEN
      NEW.enrollment_credential_generation := current_generation;
    ELSIF NEW.enrollment_credential_generation <> current_generation THEN
      RAISE EXCEPTION 'device enrollment request credential generation is stale'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS device_enrollment_requests_bind_credential_generation
  ON "device_enrollment_requests";
CREATE TRIGGER device_enrollment_requests_bind_credential_generation
  BEFORE INSERT OR UPDATE ON "device_enrollment_requests"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.bind_device_enrollment_credential_generation();

-- A credential rotation and denial of every older device request are one
-- transaction. This keeps rolling old poll handlers safe even though they do
-- not inspect enrollment_credential_generation themselves.
CREATE OR REPLACE FUNCTION opengeni_private.deny_stale_device_enrollment_requests()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.credential_generation IS DISTINCT FROM OLD.credential_generation THEN
    UPDATE device_enrollment_requests
    SET status = 'denied', updated_at = now()
    WHERE workspace_id = NEW.workspace_id
      AND enrollment_id = NEW.id
      AND status IN ('approved', 'consumed')
      AND enrollment_credential_generation IS DISTINCT FROM NEW.credential_generation;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS enrollments_deny_stale_device_requests ON "enrollments";
CREATE TRIGGER enrollments_deny_stale_device_requests
  AFTER UPDATE OF "credential_generation" ON "enrollments"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.deny_stale_device_enrollment_requests();

ALTER TABLE "machine_removal_operations"
  DROP CONSTRAINT IF EXISTS "machine_removal_operations_enrollment_id_fkey";

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'machine_removal_operations'::regclass
      AND conname = 'machine_removal_operations_enrollment_authority_fk'
  ) THEN
    ALTER TABLE "machine_removal_operations"
      ADD CONSTRAINT "machine_removal_operations_enrollment_authority_fk"
      FOREIGN KEY ("account_id", "workspace_id", "enrollment_id")
      REFERENCES "enrollments" ("account_id", "workspace_id", "id")
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END
$constraint$;

ALTER TABLE "machine_removal_operations"
  VALIDATE CONSTRAINT "machine_removal_operations_enrollment_authority_fk";

RESET statement_timeout;
RESET lock_timeout;
