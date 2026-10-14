-- deployment-mode: rolling
-- Past a fixed point before a finite provider deadline the deadline
-- save is mandatory. Requests that can no longer finish in time are captured
-- around and settled with the box after its exact termination, like enrolled
-- contained commands. This is the exact admission set the capture may ignore;
-- it never survives the lease epoch, provider instance or the cold commit.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sandbox_leases ADD COLUMN deadline_forced_admission_ids uuid[];

CREATE FUNCTION opengeni_private.clear_deadline_forced_admissions()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
    OR NEW.liveness = 'cold'
    OR (NEW.liveness = 'warm' AND OLD.liveness IS DISTINCT FROM 'warm') THEN
    NEW.deadline_forced_admission_ids := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.clear_deadline_forced_admissions() FROM PUBLIC;
CREATE TRIGGER sandbox_clear_deadline_forced_admissions
  BEFORE UPDATE ON sandbox_leases FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.clear_deadline_forced_admissions();
