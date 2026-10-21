-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';

-- Constant default is metadata-only: pre-expansion rows are visible in every
-- subsequent snapshot and are replayed when legacy monitoring tokens restart.
ALTER TABLE sessions ADD COLUMN activity_xid xid8 NOT NULL DEFAULT '0'::xid8;

-- Keep this trigger-only routine in the data schema: old runtime posture checks
-- require direct runtime EXECUTE on every unknown private-schema routine.
CREATE FUNCTION stamp_session_activity_xid()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  NEW.activity_xid := pg_current_xact_id();
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION stamp_session_activity_xid() FROM PUBLIC;

-- channel_id includes foreign-key detachment, the existing filter activity
-- invariant from 0413. Raw event/cursor writes still do not touch this column.
CREATE TRIGGER sessions_stamp_activity_xid
BEFORE INSERT OR UPDATE OF updated_at, channel_id, activity_xid ON sessions
FOR EACH ROW EXECUTE FUNCTION stamp_session_activity_xid();

-- Old binaries and SQL lifecycle routines can still finalize their legacy gate.
-- New binaries do not open it, mark pending rows, or advance the shared counter.
CREATE OR REPLACE FUNCTION opengeni_private.mark_session_activity_pending()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  gate_state text := nullif(current_setting('opengeni.session_activity_gate_state', true), '');
  gate_workspace_id uuid := nullif(current_setting('opengeni.session_activity_gate_workspace_id', true), '')::uuid;
BEGIN
  IF gate_state = 'open' AND gate_workspace_id = NEW.workspace_id THEN
    NEW.activity_revision_pending_xid := pg_current_xact_id()::text::bigint;
  ELSIF gate_state = 'finalizing' THEN
    IF TG_OP <> 'UPDATE' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR OLD.activity_revision_pending_xid IS DISTINCT FROM pg_current_xact_id()::text::bigint
      OR NEW.activity_revision_pending_xid IS NOT NULL
      OR NEW.activity_revision <= OLD.activity_revision THEN
      RAISE EXCEPTION 'Invalid session activity finalization' USING ERRCODE = '55000';
    END IF;
  ELSE
    -- No deferred guard is queued and no second session-row write is needed.
    NEW.activity_revision_pending_xid := NULL;
  END IF;
  RETURN NEW;
END
$function$;
