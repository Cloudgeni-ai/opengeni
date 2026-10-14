-- deployment-mode: rolling
-- A warm Modal native checkpoint may run around active background
-- commands, so its snapshot can predate their later writes. The exact claim
-- that did so is recorded here. Only the warm publication, which records the
-- archive one generation behind the workspace, may publish such a claim; a
-- draining publication, a takeover replay or a late adoption must not present
-- it as the complete final workspace. The column names the claim it applies to,
-- so a value left behind by an older writer never matches a later claim.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sandbox_leases ADD COLUMN archive_capture_concurrent_capture_id uuid;

-- A drain takeover replaces the claim but normally keeps its provider request
-- id so a replay-safe provider returns the same snapshot. For a claim that ran
-- around commands that snapshot is the warm-time image, so any replacement,
-- including one written by a pre-0649 worker that does not know the marker,
-- must request a fresh snapshot instead of adopting it as the final archive.
CREATE FUNCTION opengeni_private.refresh_concurrent_capture_takeover()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.archive_capture_concurrent_capture_id IS NOT NULL
    AND OLD.archive_capture_concurrent_capture_id = OLD.archive_capture_id
    AND NEW.archive_capture_id IS NOT NULL
    AND NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id THEN
    IF NEW.archive_capture_provider_request_id IS NOT DISTINCT FROM
        OLD.archive_capture_provider_request_id THEN
      NEW.archive_capture_provider_request_id := gen_random_uuid();
    END IF;
    IF NEW.archive_capture_concurrent_capture_id IS NOT DISTINCT FROM
        OLD.archive_capture_concurrent_capture_id THEN
      NEW.archive_capture_concurrent_capture_id := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.refresh_concurrent_capture_takeover() FROM PUBLIC;
CREATE TRIGGER sandbox_refresh_concurrent_capture_takeover
  BEFORE UPDATE OF archive_capture_id ON sandbox_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.refresh_concurrent_capture_takeover();
