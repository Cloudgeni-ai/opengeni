-- deployment-mode: rolling
-- Files get the same two audiences as Sites and chats: Only me (private to
-- their owner) or the whole workspace. The owner can share one finished file
-- with the workspace, or limit a file they own back to themselves. Nothing
-- else changes who can open a file, and existing private files stay private.
--
-- Rolling: the new column is nullable with a GUC default, so older binaries
-- keep inserting files unchanged (the default records the same person they
-- already scope the insert to). Older binaries never update ownership, and
-- the trigger still rejects every transition except the two owner changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The person a file belongs to. A private file's owner is one of its private
-- owners; a shared file remembers who shared or made it, so only they can
-- limit it again. NULL on a shared file means nobody (older shared files and
-- service output); NULL on a private file with one private owner means that
-- owner, which readers resolve and a share records, so no existing row is
-- rewritten.
ALTER TABLE files ADD COLUMN owner_subject_id text;
ALTER TABLE files ALTER COLUMN owner_subject_id SET DEFAULT coalesce(
  nullif(current_setting('opengeni.private_file_owner',true),''),
  nullif(current_setting('opengeni.initiating_human_subject_id',true),''));

-- NOT VALID skips a full scan under this migration's table lock. Every existing
-- row has a NULL owner, so the check already holds for all of them, and it is
-- enforced on every insert and update from here on.
ALTER TABLE files ADD CONSTRAINT files_owner_is_private_owner CHECK (
  owner_subject_id IS NULL OR private_owner_subject_ids IS NULL
  OR owner_subject_id = ANY(private_owner_subject_ids)) NOT VALID;

-- Account, workspace and owner stay immutable. Who can open a file changes
-- only for a finished file that is not a short-lived session screenshot or
-- spilled tool result, and only as one of two owner actions, decided by the
-- same private-file identity row-level security already uses:
--   share: a private owner makes it workspace-visible and stays its owner;
--   limit: the owner of a shared file makes it private to themselves.
CREATE OR REPLACE FUNCTION knowledge_file_owner_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor text := nullif(current_setting('opengeni.private_file_owner',true),'');
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'File ownership is immutable; share an explicitly authorized copy' USING ERRCODE='55000';
  END IF;
  IF NEW.private_owner_subject_ids IS NOT DISTINCT FROM OLD.private_owner_subject_ids THEN
    IF NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id THEN
      RAISE EXCEPTION 'File ownership is immutable; share an explicitly authorized copy' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF actor IS NOT NULL AND OLD.status = 'ready' AND NEW.status = 'ready'
    AND OLD.object_key !~ '^workspaces/[^/]+/files/[^/]+/(retained|tool-results)/' THEN
    IF OLD.private_owner_subject_ids IS NOT NULL AND NEW.private_owner_subject_ids IS NULL
      AND actor = ANY(OLD.private_owner_subject_ids)
      AND NEW.owner_subject_id IS NOT DISTINCT FROM coalesce(OLD.owner_subject_id, actor) THEN
      RETURN NEW;
    END IF;
    IF OLD.private_owner_subject_ids IS NULL AND NEW.private_owner_subject_ids = ARRAY[actor]
      AND OLD.owner_subject_id = actor AND NEW.owner_subject_id = actor THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Only a file''s owner can change who can open it' USING ERRCODE='55000';
END $$;

-- Lets a person who opens a link to someone else's private file learn only
-- that it is private, never its name or owner. Missing files stay not found.
-- FORCE RLS binds this definer too, so it opens the existing transaction-local
-- read capability for this one file, checks it and closes it again; only the
-- yes-or-no answer leaves the function.
CREATE FUNCTION opengeni_private.file_private_to_another(
  p_account uuid, p_workspace uuid, p_file uuid
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE probe_nonce uuid := gen_random_uuid(); found_private boolean;
BEGIN
  IF p_account IS NULL OR p_workspace IS NULL OR p_file IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'file access scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.session_file_read_capabilities
    VALUES (pg_backend_pid(), pg_current_xact_id(), probe_nonce, p_account, p_workspace, p_file);
  SELECT EXISTS (SELECT 1 FROM files f
    WHERE f.account_id = p_account AND f.workspace_id = p_workspace AND f.id = p_file
      AND f.status = 'ready' AND f.private_owner_subject_ids IS NOT NULL
      AND NOT coalesce(nullif(current_setting('opengeni.private_file_owner',true),'') = ANY(f.private_owner_subject_ids), false))
    INTO found_private;
  DELETE FROM opengeni_private.session_file_read_capabilities
    WHERE nonce = probe_nonce AND backend_pid = pg_backend_pid();
  RETURN found_private;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.file_private_to_another(uuid,uuid,uuid) FROM PUBLIC;

DO $grants$
DECLARE target_schema text := current_schema(); recipient record;
BEGIN
  -- Explicit pg_temp LAST: never search caller-controlled temporary relations
  -- ahead of the captured data schema.
  EXECUTE format('ALTER FUNCTION opengeni_private.file_private_to_another(uuid,uuid,uuid) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = target_schema AND c.relname = 'files' AND acl.privilege_type = 'INSERT'
      AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.file_private_to_another(uuid,uuid,uuid) TO %I', recipient.rolname);
  END LOOP;
END $grants$;
RESET statement_timeout;
RESET lock_timeout;
