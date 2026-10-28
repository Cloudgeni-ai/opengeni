import type { Permission } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** The typed `details.code` of every refusal for a missing permission. */
export const MISSING_PERMISSION_DETAIL_CODE = "missing_permission";

/**
 * What each permission lets its holder do, completing "You don't have
 * permission to …". People and API callers read a plain sentence; the exact
 * permission travels as `details.permission` for programs and telemetry.
 */
const PERMISSION_ACTIONS: Readonly<Record<Permission, string>> = {
  "account:read": "view this organization",
  "account:admin": "manage this organization",
  "members:manage": "manage members",
  "workspace:create": "create workspaces",
  "billing:read": "view billing",
  "billing:manage": "manage billing",
  "workspace:read": "open this workspace",
  "workspace:admin": "change this workspace's settings",
  "sessions:create": "start chats",
  "sessions:read": "view chats",
  "sessions:control": "control chats",
  "stream:view": "watch live screens",
  "stream:control": "control live screens",
  "stream:acknowledge": "respond to live screen requests",
  "files:upload": "upload files",
  "files:read": "open files",
  "files:write": "change files",
  "terminal:attach": "open terminals",
  "documents:manage": "manage documents",
  "documents:search": "search documents",
  "scheduled_tasks:manage": "manage schedules",
  "scheduled_tasks:run": "run schedules",
  "github:manage": "manage GitHub access",
  "github:use": "use GitHub",
  "api_keys:manage": "manage API keys",
  "usage_allowances:manage": "manage usage allowances",
  "connections:read": "view connections",
  "connections:write": "manage connections",
  "connections:personal": "connect your own accounts",
  "capabilities:manage": "manage this workspace's tools and integrations",
  "environments:manage": "change secrets",
  "environments:use": "use secrets",
  "variable-sets:list": "view secrets",
  "variable-sets:read": "view secrets",
  "variable-sets:write": "change secrets",
  "variable-sets:manage": "change secrets",
  "variable-sets:attach": "use secrets",
  "variable-sets:use": "use secrets",
  "secrets:list": "view secrets",
  "secrets:read": "read secret values",
  "secrets:write": "change secrets",
  "secrets:use": "use secrets",
  "mcp_servers:attach": "add MCP servers",
  "codemode:call": "call tools from code",
  "goals:manage": "manage goals",
  "enrollments:read": "view machines",
  "enrollments:manage": "manage machines",
  "rigs:use": "use rigs",
  "rigs:manage": "manage rigs",
  "artifacts:read": "open artifacts",
  "artifacts:publish": "publish artifacts",
};

/** The plain sentence for a missing permission. */
export function missingPermissionMessage(permission: Permission): string {
  return `You don't have permission to ${PERMISSION_ACTIONS[permission]}.`;
}

/**
 * A 403 for a missing permission. The message is a plain sentence; the
 * permission it names stays machine-readable, so the API error envelope
 * carries it as `details` and refusal telemetry classifies it without
 * parsing text.
 */
export class MissingPermissionRefusal extends HTTPException {
  readonly permission: Permission;

  constructor(permission: Permission, options: { message?: string } = {}) {
    super(403, { message: options.message ?? missingPermissionMessage(permission) });
    this.name = "MissingPermissionRefusal";
    this.permission = permission;
  }

  /** The public `ErrorEnvelope.details` for this refusal. */
  get details(): { code: typeof MISSING_PERMISSION_DETAIL_CODE; permission: Permission } {
    return { code: MISSING_PERMISSION_DETAIL_CODE, permission: this.permission };
  }
}

/** The permission a refusal names, or null for any other error. */
export function missingPermissionOf(error: unknown): Permission | null {
  return error instanceof MissingPermissionRefusal ? error.permission : null;
}
