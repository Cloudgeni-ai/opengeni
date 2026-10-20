-- deployment-mode: rolling
-- The 0797 seat-limit trigger depended on the writer's account context.
-- Sign-in binds pending invitations with only the recipient's subject context:
--   * With an RLS-bypassing owner (production), the trigger saw the plan row,
--     then the caller-scoped organization_plan_seats_used() refused with 42501.
--     The recipient's membership lookup failed and locked them out everywhere.
--   * With a restricted owner, the plan row was invisible and the seat check was
--     silently skipped for any writer without the organization's context.
--
-- The trigger is the authority for its own row. It now evaluates the plan and
-- seats under NEW.account_id and restores the caller's account context on every
-- exit. Seat accounting and the public reader's scope check are unchanged.
-- Only the trigger body is replaced; its owner, grants and triggers stay. This
-- also supersedes the equivalent production incident hotfix of 19 October 2026.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_organization_plan_seats()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE seat_limit integer; seats integer; reserved boolean := false;
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
  SELECT (opengeni_private.subscription_plan_definition(plan_key)->>'seatLimit')::integer INTO seat_limit
    FROM organization_plans WHERE account_id = NEW.account_id;
  IF seat_limit IS NULL THEN
    PERFORM set_config('opengeni.account_id', coalesce(previous_account,''), true);
    RETURN NEW;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF TG_TABLE_NAME = 'organization_memberships' THEN
    SELECT EXISTS (SELECT 1 FROM organization_membership_invitations WHERE account_id = NEW.account_id
      AND target_subject_id = NEW.subject_id AND status = 'pending' AND expires_at > clock_timestamp()) INTO reserved;
  ELSE
    SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE account_id = NEW.account_id
      AND subject_id = NEW.target_subject_id AND subject_id LIKE 'user:%' AND status IN ('active','provisioning')) INTO reserved;
  END IF;
  -- Acceptance converts an already-counted reservation, even after a downgrade.
  IF NOT reserved THEN
    seats := organization_plan_seats_used(NEW.account_id);
    IF TG_TABLE_NAME = 'organization_membership_invitations' THEN
      IF TG_OP = 'UPDATE' AND OLD.account_id = NEW.account_id AND OLD.status = 'pending' AND OLD.expires_at > clock_timestamp() THEN
        seats := seats - 1;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  PERFORM set_config('opengeni.account_id', coalesce(previous_account,''), true);
  IF NOT reserved AND seats >= seat_limit THEN
    RAISE EXCEPTION 'Organization seat limit reached; upgrade your plan to add people'
      USING ERRCODE = 'P0S01', DETAIL = jsonb_build_object('seatLimit',seat_limit,'seatsUsed',seats,'action','upgrade')::text;
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
