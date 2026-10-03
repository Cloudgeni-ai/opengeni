-- deployment-mode: rolling
-- Make the named Member role a superset of Viewer plus the remaining
-- read-or-own collaborator capabilities. The post-0516 Member preset lacked
-- three Viewer permissions: artifacts:read (open Sites and agent-made
-- documents, spreadsheets and presentations), stream:view (watch a session's
-- live desktop), and rigs:use (pick a Sandbox Environment). It also gains
-- stream:acknowledge (record the caller's own consent, without which
-- stream:view cannot open a desktop). Every member may also create and
-- publish artifacts (artifacts:publish); publish, rollback and archive act on
-- any artifact in the workspace and stay reversible through restore and the
-- retained version history. Admin-class powers stay Admin-only, and so do
-- Connected Machines (enrollments:*), which the console keeps admin-managed.
-- Install the new named preset and a DB-boundary guard before the
-- independently committed backfill. Old writers may overlap the rollout; only
-- the exact pre-0516 or post-0516 named Member set is normalized, regardless
-- of JSONB array order. Custom sets are untouched, and so are external
-- (`external_user:`) memberships: an organization service key stores them as
-- role 'member' with a caller-chosen set that must never be widened here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $member_collaborator_permissions$
BEGIN
  -- 0555 replaces the body of 0516's writer guard in place (below), so the
  -- guard must still be installed exactly where 0516 put it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'workspace_memberships'::regclass
      AND tgname = 'normalize_legacy_member_connection_read_0516'
      AND tgfoid = 'opengeni_private.normalize_legacy_member_connection_read_0516()'::regprocedure
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'member writer guard changed before 0555';
  END IF;
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
      "rigs:use", "artifacts:read", "artifacts:publish"
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

-- One writer guard for every older named Member set. Replacing the body of
-- 0516's trigger function, rather than dropping and recreating the trigger,
-- takes no lock on workspace_memberships, which every authorization reads.
-- The new body is visible to every statement that starts after this commit,
-- and the 0556 concurrent index build waits out any transaction still running
-- the old one before the 0557 backfill begins. The function keeps its name,
-- owner and EXECUTE ACL; the attributes restate 0516's exactly.
CREATE OR REPLACE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE
  pre_0516 jsonb := opengeni_private.workspace_member_legacy_permissions_0516();
  pre_0555 jsonb := opengeni_private.workspace_member_legacy_permissions_0555();
BEGIN
  IF NEW.role = 'member'
    AND NEW.subject_id NOT LIKE 'external_user:%'
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
      "rigs:use", "artifacts:read", "artifacts:publish"
    ]'::jsonb;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
