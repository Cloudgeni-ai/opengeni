-- deployment-mode: rolling
-- Make the named Member role a full teammate. Members can already create
-- sessions and publish artifacts; this gives them the rest of the everyday
-- collaboration surface that only Admins had:
--   stream:control, terminal:attach  take over a session's live desktop,
--                                    browser handoff and terminal
--   codemode:call                    call workspace tools from code
--   files:write                      edit, move and create files in a
--                                    session's live filesystem
--   connections:write                connect their own accounts (Gmail,
--                                    Slack, GitHub, Drive, Codex/Claude
--                                    subscriptions) and shared credentials
--   mcp_servers:attach               attach session MCP servers
--   rigs:manage                      create and edit Sandbox Environments
--                                    (versioned; the workspace default
--                                    stays an admin setting)
--   enrollments:read                 see and pick Connected Machines
-- Settings-class powers stay Admin-only: workspace:admin, members:manage,
-- api_keys:manage, github:manage (the workspace GitHub App),
-- variable-sets:manage, enrollments:manage, capabilities:manage (integration
-- install and workspace tool policy) and secrets:read. Routes that a newly
-- granted permission would otherwise open to workspace-wide configuration
-- (workspace model-provider keys, Slack bot install, the default Sandbox
-- Environment) check those settings powers explicitly.
-- Like 0555: guard all three presets, restate the preset function, replace
-- the 0516 writer guard's body in place (no lock on the hot table) so old
-- writers of any earlier named Member set are lifted, then backfill exact
-- named rows through a partial index (0865/0866). Custom sets and external
-- (`external_user:`) memberships are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $member_teammate_permissions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'workspace_memberships'::regclass
      AND tgname = 'normalize_legacy_member_connection_read_0516'
      AND tgfoid = 'opengeni_private.normalize_legacy_member_connection_read_0516()'::regprocedure
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'member writer guard changed before 0864';
  END IF;
  IF opengeni_private.workspace_member_role_permissions('viewer') IS DISTINCT FROM '[
    "workspace:read", "sessions:read", "stream:view", "files:read",
    "documents:search", "variable-sets:list", "connections:read",
    "rigs:use", "artifacts:read"
  ]'::jsonb THEN
    RAISE EXCEPTION 'viewer permission preset changed before 0864';
  END IF;
  IF opengeni_private.workspace_member_role_permissions('member') IS DISTINCT FROM '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "stream:view", "stream:acknowledge", "files:upload", "files:read",
    "documents:manage", "documents:search", "scheduled_tasks:manage",
    "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
    "variable-sets:read", "variable-sets:write", "variable-sets:attach",
    "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
    "rigs:use", "artifacts:read", "artifacts:publish"
  ]'::jsonb THEN
    RAISE EXCEPTION 'member permission preset changed before 0864';
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
    RAISE EXCEPTION 'admin permission preset changed before 0864';
  END IF;
END
$member_teammate_permissions$;

-- CREATE OR REPLACE keeps the owner, signature, and EXECUTE ACL. The
-- attributes restate 0350's exactly: IMMUTABLE, invoker rights, pinned path.
-- Member lists its permissions in Admin order.
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
      "stream:view", "stream:control", "stream:acknowledge", "terminal:attach",
      "codemode:call", "files:upload", "files:read", "files:write",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "connections:write",
      "variable-sets:list", "variable-sets:read", "variable-sets:write",
      "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write",
      "mcp_servers:attach", "goals:manage", "rigs:use", "rigs:manage",
      "enrollments:read", "artifacts:read", "artifacts:publish"
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

-- Freeze the 0555 named set, independently of future preset changes.
CREATE FUNCTION opengeni_private.workspace_member_legacy_permissions_0864()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT '[
    "workspace:read", "sessions:create", "sessions:read", "sessions:control",
    "stream:view", "stream:acknowledge", "files:upload", "files:read",
    "documents:manage", "documents:search", "scheduled_tasks:manage",
    "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list",
    "variable-sets:read", "variable-sets:write", "variable-sets:attach",
    "variable-sets:use", "secrets:list", "secrets:write", "goals:manage",
    "rigs:use", "artifacts:read", "artifacts:publish"
  ]'::jsonb
$body$;
REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0864() FROM PUBLIC;

-- One writer guard for every older named Member set (pre-0516, post-0516 and
-- 0555). The attributes restate 0516's exactly.
CREATE OR REPLACE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE
  pre_0516 jsonb := opengeni_private.workspace_member_legacy_permissions_0516();
  pre_0555 jsonb := opengeni_private.workspace_member_legacy_permissions_0555();
  pre_0864 jsonb := opengeni_private.workspace_member_legacy_permissions_0864();
BEGIN
  IF NEW.role = 'member'
    AND NEW.subject_id NOT LIKE 'external_user:%'
    AND (
      (NEW.permissions @> pre_0516 AND pre_0516 @> NEW.permissions)
      OR (NEW.permissions @> pre_0555 AND pre_0555 @> NEW.permissions)
      OR (NEW.permissions @> pre_0864 AND pre_0864 @> NEW.permissions)
    )
  THEN
    NEW.permissions := '[
      "workspace:read", "sessions:create", "sessions:read", "sessions:control",
      "stream:view", "stream:control", "stream:acknowledge", "terminal:attach",
      "codemode:call", "files:upload", "files:read", "files:write",
      "documents:manage", "documents:search", "scheduled_tasks:manage",
      "scheduled_tasks:run", "github:use", "connections:read", "connections:write",
      "variable-sets:list", "variable-sets:read", "variable-sets:write",
      "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write",
      "mcp_servers:attach", "goals:manage", "rigs:use", "rigs:manage",
      "enrollments:read", "artifacts:read", "artifacts:publish"
    ]'::jsonb;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$body$;
