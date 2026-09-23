-- deployment-mode: rolling
-- Repair a regressed control head without replaying historical pause/resume
-- actions. Revisions are cursors: advancing the head changes no control state.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

-- Lock the control head before the event ledger, matching control writers.
ALTER TABLE workspace_inference_controls NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_control_events NO FORCE ROW LEVEL SECURITY;

UPDATE workspace_inference_controls AS control
SET revision = frontier.revision
FROM (
  SELECT workspace_id, max(revision) AS revision
  FROM workspace_control_events
  GROUP BY workspace_id
) AS frontier
WHERE control.workspace_id = frontier.workspace_id
  AND control.revision < frontier.revision;

CREATE FUNCTION opengeni_private.prevent_workspace_control_revision_rollback()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'workspace control revision cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.prevent_workspace_control_revision_rollback() FROM PUBLIC;
CREATE TRIGGER workspace_control_revision_monotonic
BEFORE UPDATE OF revision ON workspace_inference_controls
FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_workspace_control_revision_rollback();

ALTER TABLE workspace_control_events FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_inference_controls FORCE ROW LEVEL SECURITY;
