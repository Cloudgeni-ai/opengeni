-- deployment-mode: rolling
-- The seat-limit trigger refused writes that take no new seat, so an
-- organization over its limit (after a downgrade, or when the plan catalog
-- lowers a limit) could lock people out:
--   * Sign-in binds a pending email invitation to the verified person by
--     setting target_subject_id. The trigger re-counted that already reserved
--     invitation, and over the limit raised P0S01. The binder has no handler,
--     so the whole access lookup failed and the invitee lost access to every
--     organization (the same failure as the 19 October 2026 incident, which
--     0870 fixed only at exactly the limit). Admin user setup binds too.
--   * BEFORE INSERT fires for INSERT ... ON CONFLICT DO NOTHING. The
--     membership-anchor insert in ensure_managed_human_personal_workspace was
--     counted as a new seat even when it only conflicts with the person's
--     existing row.
--
-- A pending invitation that already holds a seat keeps holding the same seat
-- when it is bound or renewed, and an insert for a person who already has a
-- membership row in the organization adds nobody (the unique index makes it a
-- no-op or an error). Neither is counted. Everything else is unchanged: new
-- invitations, new members and reactivations still need a free seat, existing
-- people stay, and the refusal is the same P0S01. Its DETAIL also names the
-- organization's plan key, so the API can name the one plan that adds the seat.
-- Only the trigger body is replaced; its owner, grants and triggers stay.
-- Rolling: the previous release reads no new shape and only sees fewer refusals.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_organization_plan_seats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE seat_limit integer; plan_key_value text; seats integer; reserved boolean := false;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_account text := current_setting('opengeni.account_id', true);
BEGIN
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    IF NEW.subject_id NOT LIKE 'user:%' OR NEW.status NOT IN ('active','provisioning') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.subject_id = NEW.subject_id
      AND OLD.status IN ('active','provisioning') THEN RETURN NEW; END IF;
  ELSE
    IF NEW.status <> 'pending' OR NEW.expires_at <= clock_timestamp() THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.status = 'pending'
      AND OLD.expires_at > clock_timestamp() AND OLD.target_subject_id IS NOT DISTINCT FROM NEW.target_subject_id THEN RETURN NEW; END IF;
  END IF;
  -- The existing membership lifecycle already owns this lock. Reuse its exact
  -- key/order; do not add an account row FOR UPDATE or a second membership lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || NEW.account_id::text, 0));
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  SELECT (opengeni_private.subscription_plan_definition(plan_key)->>'seatLimit')::integer, plan_key
    INTO seat_limit, plan_key_value FROM organization_plans WHERE account_id = NEW.account_id;
  IF seat_limit IS NULL THEN
    PERFORM set_config('opengeni.account_id', coalesce(previous_account,''), true);
    RETURN NEW;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    -- An insert for someone who already has a row here (ON CONFLICT DO NOTHING)
    -- adds nobody.
    IF TG_OP = 'INSERT' THEN
      SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE account_id = NEW.account_id
        AND subject_id = NEW.subject_id) INTO reserved;
    END IF;
    -- Acceptance converts an already-counted reservation, even after a downgrade.
    IF NOT reserved THEN
      SELECT EXISTS (SELECT 1 FROM organization_membership_invitations WHERE account_id = NEW.account_id
        AND target_subject_id = NEW.subject_id AND status = 'pending' AND expires_at > clock_timestamp()) INTO reserved;
    END IF;
  ELSE
    SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE account_id = NEW.account_id
      AND subject_id = NEW.target_subject_id AND subject_id LIKE 'user:%' AND status IN ('active','provisioning')) INTO reserved;
    -- Binding (or otherwise re-targeting) a pending invitation that already
    -- holds a seat keeps that same seat, even over the limit. It held one unless
    -- its previous target was already a member.
    IF NOT reserved AND TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.status = 'pending'
      AND OLD.expires_at > clock_timestamp() THEN
      SELECT OLD.target_subject_id IS NULL OR NOT EXISTS (SELECT 1 FROM organization_memberships
        WHERE account_id = NEW.account_id AND subject_id = OLD.target_subject_id
          AND subject_id LIKE 'user:%' AND status IN ('active','provisioning')) INTO reserved;
    END IF;
  END IF;
  IF NOT reserved THEN
    seats := organization_plan_seats_used(NEW.account_id);
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  PERFORM set_config('opengeni.account_id', coalesce(previous_account,''), true);
  IF NOT reserved AND seats >= seat_limit THEN
    RAISE EXCEPTION 'Organization seat limit reached; upgrade your plan to add people'
      USING ERRCODE = 'P0S01', DETAIL = jsonb_build_object('seatLimit',seat_limit,'seatsUsed',seats,'planKey',plan_key_value,'action','upgrade')::text;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  PERFORM set_config('opengeni.account_id', coalesce(previous_account,''), true);
  RAISE;
END $body$;

DO $posture$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.enforce_organization_plan_seats() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema());
END $posture$;
