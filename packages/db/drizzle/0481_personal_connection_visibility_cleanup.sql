-- deployment-mode: rolling
-- Visibility changes invalidate session-initial personal connection selections.
-- Permit that exact cleanup under the existing transaction-local lifecycle
-- capability; accepted turn authority and parent provenance remain immutable.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF NEW.parent_turn_id IS DISTINCT FROM OLD.parent_turn_id THEN
      RAISE EXCEPTION 'session parent turn authority is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.initial_personal_connection_delegations IS DISTINCT FROM OLD.initial_personal_connection_delegations THEN
      IF NEW.initial_personal_connection_delegations IS DISTINCT FROM '[]'::jsonb
        OR NEW.visibility IS NOT DISTINCT FROM OLD.visibility
        OR NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch + 1
        OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
        OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
      THEN
        RAISE EXCEPTION 'session initial personal MCP authority is immutable' USING ERRCODE = '23514';
      END IF;
      -- A caller-set GUC is insufficient: only the existing protected capability
      -- row minted by the native visibility transition permits this cleanup.
      IF NOT EXISTS (
        SELECT 1 FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_backend_pid()
          AND capability.transaction_id = pg_current_xact_id()
          AND capability.capability_id = nullif(current_setting(
            'opengeni.session_visibility_write_capability', true
          ), '')::uuid
      ) THEN
        RAISE EXCEPTION 'session personal authority cleanup requires the visibility lifecycle capability' USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF NEW.personal_connection_delegations IS DISTINCT FROM OLD.personal_connection_delegations THEN
    RAISE EXCEPTION '% personal MCP authority is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $body$;
DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.prevent_personal_connection_authority_mutation() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;