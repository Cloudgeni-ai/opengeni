-- deployment-mode: rolling
-- A Chrome profile is stored where its machine is enrolled. A machine shared
-- with the whole organization, or a personal machine, is usable from other
-- workspaces too, so a browser or computer session in one workspace can now
-- run on a profile stored in another. Sessions record which workspace their
-- profile row lives in. NULL means the session's own workspace: every row
-- written before this release, and what the previous release still assumes.
-- A trigger fills the column with the session's own workspace whenever the
-- previous release writes a device, so both releases share this schema and
-- existing rows need no backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE browser_sessions ADD COLUMN device_workspace_id uuid;
ALTER TABLE computer_sessions ADD COLUMN device_workspace_id uuid;

CREATE FUNCTION opengeni_private.default_interaction_device_workspace() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.device_id IS NULL THEN
    NEW.device_workspace_id := NULL;
  ELSIF NEW.device_workspace_id IS NULL THEN
    NEW.device_workspace_id := NEW.workspace_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.default_interaction_device_workspace() FROM PUBLIC;

CREATE TRIGGER browser_sessions_default_device_workspace_trg
BEFORE INSERT OR UPDATE OF device_id, device_workspace_id ON browser_sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.default_interaction_device_workspace();
CREATE TRIGGER computer_sessions_default_device_workspace_trg
BEFORE INSERT OR UPDATE OF device_id, device_workspace_id ON computer_sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.default_interaction_device_workspace();

ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_device_workspace_check
  CHECK (device_workspace_id IS NULL OR device_id IS NOT NULL) NOT VALID;
ALTER TABLE computer_sessions ADD CONSTRAINT computer_sessions_device_workspace_check
  CHECK (device_workspace_id IS NULL OR device_id IS NOT NULL) NOT VALID;

-- A session in one workspace can now run on a profile stored in another, so
-- browser sessions stop referencing the profile row, like computer sessions
-- already do. A reference across workspaces would also block deleting the
-- profile's workspace (a removed member's Personal workspace) while any
-- session elsewhere, even an ended one, had used it. Every lookup through
-- this column is fail-closed: a missing profile ends the session.
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_attached_device_fk;
