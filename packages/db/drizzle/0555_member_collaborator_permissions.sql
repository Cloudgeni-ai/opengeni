-- deployment-mode: rolling
-- Make the named Member role a superset of Viewer plus the remaining
-- read-or-own collaborator capabilities. The post-0516 Member preset lacked
-- three Viewer permissions: artifacts:read (open Sites and agent-made
-- documents, spreadsheets and presentations), stream:view (watch a session's
-- live desktop), and rigs:use (pick a Sandbox Environment). It also gains
-- stream:acknowledge (record the caller's own consent, without which
-- stream:view cannot open a desktop) and enrollments:read (see the Connected
-- Machines available to the workspace). Admin-class powers stay Admin-only.
-- Install the new named preset and a DB-boundary guard before the
-- independently committed backfill. Old writers may overlap the rollout; only
-- the exact pre-0516 or post-0516 named Member set is normalized, regardless
-- of JSONB array order. Custom and external permission sets are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $member_collaborator_permissions$
BEGIN
  -- Refuse to migrate a locally changed preset. The function below restates
  -- all three presets, so Viewer and Admin are guarded too.
  IF opengeni_private.workspace_member_role_permissions('viewer') IS DISTINCT FROM '[
    "workspace:read", "sessions:read", "stream:view", "files:read",
    "documents:search", "variable-sets:list", "connections:read",
    "rigs:use", "artifacts:read"
  ]'::jsonb THEN
    RAISE EXCEPTION 'viewer permission preset changed before 0555';
  END IF;
  IF opengeni_private.workspace_member_role_permissions('member') IS DISTINCT FROM '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb THEN
    RAISE EXCEPTION 'member permission preset changed before 0555';
  END IF;
  IF opengeni_private.workspace_member_role_permissions('admin') IS DISTINCT FROM '[
    "workspace:read", "workspace:admin", "members:manage", "sessions:create",
    "sessions:read", "sessions:control", "stream:view", "stream:control",
    "stream:acknowledge", "terminal:attach", "codemode:call", "files:upload",
    "files:read", "files:write", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:manage",
    "github:use", "api_keys:manage", "connections:read", "connections:write",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:manage", "variable-sets:attach", "variable-sets:use",
    "secrets:list", "secrets:write", "mcp_servers:attach", "goals:manage",
    "rigs:use", "rigs:manage", "enrollments:read", "enrollments:manage",
    "artifacts:read", "artifacts:publish"
  ]'::jsonb THEN
    RAISE EXCEPTION 'admin permission preset changed before 0555';
  END IF;
END
$member_collaborator_permissions$;

-- CREATE OR REPLACE keeps the owner, signature, and EXECUTE ACL. The
-- attributes restate 0350's exactly: IMMUTABLE, invoker rights, pinned path.
CREATE OR REPLACE FUNCTION opengeni_private.workspace_member_role_permissions(p_role text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT CASE p_role
    WHEN 'viewer' THEN '[
      "workspace:read", "sessions:read", "stream:view", "files:read",
      "documents:search", "variable-sets:list", "connections:read",
      "rigs:use", "artifacts:read"
    ]'::jsonb
    WHEN 'member' THEN '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:acknowledge", "files:upload", "files:read",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
      "variable-sets:read", "variable-sets:write", "variable-sets:attach",
      "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
      "rigs:use", "enrollments:read", "artifacts:read"
    ]'::jsonb
    WHEN 'admin' THEN '[
      "workspace:read", "workspace:admin", "members:manage", "sessions:create",
      "sessions:read", "sessions:control", "stream:view", "stream:control",
      "stream:acknowledge", "terminal:attach", "codemode:call", "files:upload",
      "files:read", "files:write", "documents:manage", "documents:search",
      "scheduled_tasks:manage", "scheduled_tasks:run", "github:manage",
      "github:use", "api_keys:manage", "connections:read", "connections:write",
      "variable-sets:list", "variable-sets:read", "variable-sets:write",
      "variable-sets:manage", "variable-sets:attach", "variable-sets:use",
      "secrets:list", "secrets:write", "mcp_servers:attach", "goals:manage",
      "rigs:use", "rigs:manage", "enrollments:read", "enrollments:manage",
      "artifacts:read", "artifacts:publish"
    ]'::jsonb
    ELSE NULL
  END
$body$;

-- Freeze the post-0516 named set, independently of future preset changes.
-- 0516's own frozen function still names the pre-0516 set.
CREATE FUNCTION opengeni_private.workspace_member_legacy_permissions_0555()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "files:upload", "files:read", "documents:manage", "documents:search",
    "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read",
    "variable-sets:list", "variable-sets:read", "variable-sets:write",
    "variable-sets:attach", "variable-sets:use", "secrets:list",
    "secrets:write", "goals:manage"
  ]'::jsonb
$body$;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0555() FROM PUBLIC;

-- One writer guard for every older named Member set. It replaces 0516's guard
-- (which would only lift a pre-0516 set to the now-stale post-0516 one) in
-- this same transaction, so no write observes the table without a guard.
CREATE FUNCTION opengeni_private.normalize_legacy_member_permissions_0555()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE
  pre_0516 jsonb := opengeni_private.workspace_member_legacy_permissions_0516();
  pre_0555 jsonb := opengeni_private.workspace_member_legacy_permissions_0555();
BEGIN
  IF NEW.role = 'member'
    AND (
      (NEW.permissions @> pre_0516 AND pre_0516 @> NEW.permissions)
      OR (NEW.permissions @> pre_0555 AND pre_0555 @> NEW.permissions)
    )
  THEN
    NEW.permissions := '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:acknowledge", "files:upload", "files:read",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
      "variable-sets:read", "variable-sets:write", "variable-sets:attach",
      "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
      "rigs:use", "enrollments:read", "artifacts:read"
    ]'::jsonb;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.normalize_legacy_member_permissions_0555() FROM PUBLIC;

DROP TRIGGER normalize_legacy_member_connection_read_0516 ON workspace_memberships;
DROP FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516();

CREATE TRIGGER normalize_legacy_member_permissions_0555
  BEFORE INSERT OR UPDATE ON workspace_memberships
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.normalize_legacy_member_permissions_0555();
