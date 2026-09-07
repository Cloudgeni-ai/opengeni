-- deployment-mode: rolling
-- New adoption writers freeze their already-fenced launch attempt. Older
-- writers leave this tuple absent; never invent authority for legacy commands.
ALTER TABLE session_background_commands
  ADD COLUMN launch_turn_id uuid,
  ADD COLUMN launch_attempt_id uuid,
  ADD COLUMN launch_execution_generation integer,
  ADD CONSTRAINT session_background_commands_launch_identity_check CHECK (
    (launch_turn_id IS NULL AND launch_attempt_id IS NULL AND launch_execution_generation IS NULL)
    OR (launch_turn_id IS NOT NULL AND launch_attempt_id IS NOT NULL AND launch_execution_generation IS NOT NULL AND launch_execution_generation > 0)
  );

CREATE FUNCTION fence_background_command_launch_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE matches_launch boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.launch_turn_id, NEW.launch_attempt_id, NEW.launch_execution_generation,
           NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.provider,
           NEW.retained_process_id, NEW.control_workspace_id, NEW.enrollment_id,
           NEW.connection_instance_id, NEW.op_id)
       IS DISTINCT FROM
       ROW(OLD.launch_turn_id, OLD.launch_attempt_id, OLD.launch_execution_generation,
           OLD.account_id, OLD.workspace_id, OLD.session_id, OLD.provider,
           OLD.retained_process_id, OLD.control_workspace_id, OLD.enrollment_id,
           OLD.connection_instance_id, OLD.op_id) THEN
      RAISE EXCEPTION 'background command launch identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.launch_turn_id IS NOT NULL AND NEW.launch_attempt_id IS NOT NULL
     AND NEW.launch_execution_generation IS NOT NULL THEN
    -- The migrator also supports dedicated data schemas. Never resolve an
    -- unrelated public table when this trigger belongs to another schema.
    EXECUTE format(
      'SELECT EXISTS (
        SELECT 1 FROM %I.session_turn_attempts a
        JOIN %I.session_turns t ON t.id = a.turn_id AND t.workspace_id = a.workspace_id
          AND t.session_id = a.session_id AND t.account_id = a.account_id
        WHERE a.id = $1 AND a.turn_id = $2
          AND a.workspace_id = $3 AND a.session_id = $4
          AND a.account_id = $5 AND a.execution_generation = $6
      )', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
    ) INTO matches_launch USING NEW.launch_attempt_id, NEW.launch_turn_id,
      NEW.workspace_id, NEW.session_id, NEW.account_id, NEW.launch_execution_generation;
    IF NOT matches_launch THEN
      RAISE EXCEPTION 'background command launch attempt does not match session' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION fence_background_command_launch_identity() FROM PUBLIC;
CREATE TRIGGER session_background_commands_launch_identity_fence
BEFORE INSERT OR UPDATE ON session_background_commands
FOR EACH ROW EXECUTE FUNCTION fence_background_command_launch_identity();
