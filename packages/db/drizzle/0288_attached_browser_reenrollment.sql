-- deployment-mode: rolling
-- A Chrome profile keeps one stable device id across OpenGeni Agent reinstalls.
-- Re-enrollment creates a new enrollment row, so let the live enrollment reclaim
-- that endpoint only after its previous enrollment has been revoked. Active-to-
-- active reassignment remains forbidden.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION opengeni_private.attached_browser_devices_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $guard$
DECLARE
  enrollment_transfer_allowed boolean;
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Attached browser endpoint identity cannot change'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id THEN
    SELECT
      EXISTS (
        SELECT 1
        FROM enrollments previous_enrollment
        WHERE previous_enrollment.id = OLD.enrollment_id
          AND previous_enrollment.account_id = OLD.account_id
          AND previous_enrollment.workspace_id = OLD.workspace_id
          AND previous_enrollment.status = 'revoked'
      )
      AND EXISTS (
        SELECT 1
        FROM enrollments next_enrollment
        WHERE next_enrollment.id = NEW.enrollment_id
          AND next_enrollment.account_id = NEW.account_id
          AND next_enrollment.workspace_id = NEW.workspace_id
          AND next_enrollment.status = 'active'
      )
    INTO enrollment_transfer_allowed;

    IF NOT coalesce(enrollment_transfer_allowed, false) THEN
      RAISE EXCEPTION 'Attached browser endpoint enrollment can move only from revoked to active'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.last_seen_at < OLD.last_seen_at OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Attached browser endpoint time cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.connection_generation = OLD.connection_generation
     AND NEW.inventory_revision < OLD.inventory_revision THEN
    RAISE EXCEPTION 'Attached browser inventory revision cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

