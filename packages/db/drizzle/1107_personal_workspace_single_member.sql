-- deployment-mode: rolling
-- A Personal workspace has exactly one member, its owner (docs/organization-tenancy.md).
-- Today the owner has no workspace_memberships row: their access is the
-- organization_memberships.personal_workspace_id pointer, and nothing in the
-- schema stopped a row being written there. This adds that rule, ahead of the
-- owner getting a real row in a later release.
--
-- A workspace is Personal when it carries the Personal identity:
-- external_source 'opengeni:organization-membership' and external_id
-- '<organization id>:<owner subject>'. Every path that creates one, or points
-- an organization membership at one, uses that identity.
--
-- - A row in a Personal workspace must be its owner's. Nobody else's row is
--   accepted: not another member's, and not an organization owner's or admin's.
-- - The owner's row can never hold workspace administration, member
--   management, workspace API key management or usage allowances. That means
--   no 'owner' or 'admin' role, which the database reads as administration, and
--   none of those permissions, so the row can never be used to let anyone in.
-- - A row in or out of a Personal workspace can't move to another person,
--   workspace or organization.
-- - An organization membership can't point at someone else's Personal
--   workspace (the existing foreign key keeps it in its own organization).
-- - A Personal workspace keeps its identity, and no existing workspace can take
--   one on. New workspaces get it only from Personal provisioning; the API
--   refuses the reserved source.
--
-- Rolling: the previous release never writes a row into a Personal workspace
-- (0219's provisioning refuses one, and every member writer needs
-- members:manage there, which no grant holds). It never points a membership
-- elsewhere and never changes a workspace's identity, so it is unaffected. The
-- triggers run as the writer (SECURITY INVOKER) and read only workspaces.

CREATE FUNCTION guard_personal_workspace_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  new_identity text;
  old_personal boolean := false;
  owner_prefix text := NEW.account_id::text || ':';
BEGIN
  SELECT w.external_id INTO new_identity FROM workspaces w
  WHERE w.id = NEW.workspace_id AND w.external_source = 'opengeni:organization-membership';
  IF TG_OP = 'UPDATE' THEN
    old_personal := EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = OLD.workspace_id AND w.external_source = 'opengeni:organization-membership'
    );
    IF (new_identity IS NOT NULL OR old_personal)
      AND (NEW.workspace_id, NEW.subject_id, NEW.account_id)
        IS DISTINCT FROM (OLD.workspace_id, OLD.subject_id, OLD.account_id)
    THEN
      RAISE EXCEPTION 'a Personal workspace membership cannot move to another person, workspace or organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  IF new_identity IS NOT NULL THEN
    IF new_identity IS DISTINCT FROM owner_prefix || NEW.subject_id THEN
      RAISE EXCEPTION 'a Personal workspace has exactly one member, its owner'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.role IN ('owner', 'admin')
      OR jsonb_typeof(NEW.permissions) IS DISTINCT FROM 'array'
      OR NEW.permissions ?| ARRAY['workspace:admin', 'members:manage', 'api_keys:manage', 'usage_allowances:manage']
    THEN
      RAISE EXCEPTION 'a Personal workspace owner never administers members, workspace API keys or usage allowances'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Fires after normalize_legacy_member_connection_read_0516 (BEFORE triggers run
-- in name order), so the rule sees the permissions that are actually stored.
CREATE TRIGGER personal_workspace_single_member BEFORE INSERT OR UPDATE ON workspace_memberships
FOR EACH ROW EXECUTE FUNCTION guard_personal_workspace_membership();

CREATE FUNCTION guard_personal_workspace_pointer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  -- The (personal_workspace_id, account_id) foreign key already keeps the
  -- workspace in this organization; this keeps a Personal one this person's.
  -- It checks only a pointer, person or organization that changes, so rows
  -- written before this rule are never re-judged by an unrelated update.
  IF TG_OP = 'UPDATE'
    AND (NEW.personal_workspace_id, NEW.subject_id, NEW.account_id)
      IS NOT DISTINCT FROM (OLD.personal_workspace_id, OLD.subject_id, OLD.account_id)
  THEN
    RETURN NEW;
  END IF;
  IF NEW.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = NEW.personal_workspace_id
      AND w.external_source = 'opengeni:organization-membership'
      AND (w.account_id IS DISTINCT FROM NEW.account_id
        OR w.external_id IS DISTINCT FROM NEW.account_id::text || ':' || NEW.subject_id)
  ) THEN
    RAISE EXCEPTION 'an organization membership can''t point at someone else''s Personal workspace'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_workspace_single_member
BEFORE INSERT OR UPDATE OF personal_workspace_id, subject_id, account_id ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION guard_personal_workspace_pointer();

CREATE FUNCTION guard_personal_workspace_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (OLD.external_source = 'opengeni:organization-membership'
      OR NEW.external_source = 'opengeni:organization-membership')
    AND (NEW.external_source, NEW.external_id) IS DISTINCT FROM (OLD.external_source, OLD.external_id)
  THEN
    RAISE EXCEPTION 'a Personal workspace keeps its identity, and no workspace can take one on'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER personal_workspace_identity
BEFORE UPDATE OF external_source, external_id ON workspaces
FOR EACH ROW EXECUTE FUNCTION guard_personal_workspace_identity();

DO $secure$
DECLARE
  owner_name text := pg_get_userbyid((SELECT relowner FROM pg_class
    WHERE oid = format('%I.workspace_memberships', current_schema())::regclass));
  routine text;
BEGIN
  FOREACH routine IN ARRAY ARRAY['guard_personal_workspace_membership()',
    'guard_personal_workspace_pointer()', 'guard_personal_workspace_identity()'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s OWNER TO %I', current_schema(), routine, owner_name);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog, pg_temp',
      current_schema(), routine, current_schema());
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', current_schema(), routine);
  END LOOP;
END
$secure$;
