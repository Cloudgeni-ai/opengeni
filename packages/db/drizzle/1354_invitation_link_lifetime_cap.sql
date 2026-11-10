-- deployment-mode: rolling
-- An organization invitation, and the account setup link sent with it, last at
-- most 48 hours (CASA 1.1.2: time-limited activation and recovery links). Both
-- creation paths accepted up to 30 days, and the web client asked for 7.
--
-- New and re-dated invitations are capped at created_at + 48 hours rather than
-- refused, so an existing API caller that still asks for a longer lifetime gets
-- a working, shorter invitation; the API returns the stored expiry. A setup
-- intent must carry its invitation's exact expiry, so setup links follow the
-- invitation and need no trigger of their own. Existing invitations keep their
-- expiry: an update that does not change expires_at is never touched, so they
-- can still be accepted, revoked or have their setup link sent.
--
-- The trigger name sorts before organization_invitations_plan_seat_limit, so
-- the seat check sees the capped expiry.
-- Rolling: the previous release writes invitations through the same functions
-- and reads expires_at as stored.
CREATE OR REPLACE FUNCTION opengeni_private.cap_organization_invitation_expiry()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE latest timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN
    RETURN NEW;
  END IF;
  latest := coalesce(NEW.created_at, pg_catalog.clock_timestamp()) + interval '48 hours';
  IF NEW.expires_at > latest THEN
    NEW.expires_at := latest;
  END IF;
  RETURN NEW;
END
$body$;

REVOKE ALL ON FUNCTION opengeni_private.cap_organization_invitation_expiry() FROM PUBLIC;

CREATE TRIGGER organization_invitations_cap_expiry
  BEFORE INSERT OR UPDATE OF expires_at ON organization_membership_invitations
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.cap_organization_invitation_expiry();
