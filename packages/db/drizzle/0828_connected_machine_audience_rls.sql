-- deployment-mode: rolling
-- Preserve bounded capability ownership when audience changes run under a
-- non-BYPASSRLS schema owner. Public signatures and response shapes are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- A trigger borrows an outer write capability; only its creator may remove it.
CREATE OR REPLACE FUNCTION sync_personal_enrollment_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE capability_added boolean := false;
BEGIN
  IF NEW.authority_scope <> 'user' OR (
    NEW.generation = OLD.generation AND NEW.status = OLD.status
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  UPDATE organization_user_resource_authorities
  SET generation = NEW.generation, status = NEW.status,
    revoked_at = CASE WHEN NEW.status = 'revoked' THEN coalesce(NEW.revoked_at, clock_timestamp())
      ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE id = NEW.authority_id AND account_id = NEW.account_id
    AND organization_membership_id = NEW.owner_organization_membership_id
    AND resource_kind = 'connected_machine' AND resource_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal machine authority is missing' USING ERRCODE = '42501';
  END IF;
  UPDATE organization_user_resource_grants
  SET status = 'revoked', revoked_at = clock_timestamp(),
    generation = generation + 1, updated_at = clock_timestamp()
  WHERE authority_id = NEW.authority_id AND account_id = NEW.account_id
    AND status = 'active';
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'write';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sync_personal_enrollment_authority() FROM PUBLIC;

-- The existing inventory query is already account- and machine-bound and
-- redacts other people's private chat titles and owners. Its ordinary compute
-- capability does not satisfy the restrictive session-visibility policy.
-- Reuse the internal read-only tenancy inventory capability while collecting
-- that bounded plan. It is closed before returning, including on errors.
DO $inventory_visibility$
DECLARE
  function_id regprocedure := 'connected_machine_audience_inventory(uuid,uuid,uuid,text,text,boolean)'::regprocedure;
  original_definition text;
  updated_definition text;
  return_anchor text := E'  RETURN pg_catalog.jsonb_build_object(\n    ''enrollmentId'', enrollment_row.id,';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(function_id) INTO original_definition;
  IF strpos(original_definition, E'  notice jsonb;\nBEGIN') = 0
    OR strpos(original_definition, E'  FOR chat IN\n') = 0
    OR strpos(original_definition, return_anchor) = 0
    OR strpos(original_definition, E'END\n$function$') = 0
  THEN
    RAISE EXCEPTION 'connected machine audience inventory definition drift';
  END IF;
  updated_definition := replace(original_definition,
    E'  notice jsonb;\nBEGIN', E'  notice jsonb;\n  inventory_capability_id uuid;\nBEGIN');
  updated_definition := replace(updated_definition, E'  FOR chat IN\n',
    E'  inventory_capability_id := opengeni_private.open_session_tenancy_fence_inventory(\n'
      || E'    session_tenancy_fence_target_schema()\n  );\n  FOR chat IN\n');
  updated_definition := replace(updated_definition, return_anchor,
    E'  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_capability_id);\n'
      || E'  inventory_capability_id := NULL;\n' || return_anchor);
  updated_definition := replace(updated_definition, E'END\n$function$',
    E'EXCEPTION WHEN OTHERS THEN\n  IF inventory_capability_id IS NOT NULL THEN\n'
      || E'    PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_capability_id);\n'
      || E'  END IF;\n  RAISE;\nEND\n$function$');
  EXECUTE updated_definition;
END
$inventory_visibility$;

DO $pin$
BEGIN
  EXECUTE format('ALTER FUNCTION sync_personal_enrollment_authority() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$pin$;
