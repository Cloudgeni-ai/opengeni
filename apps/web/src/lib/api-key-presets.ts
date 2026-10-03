/*
 * Workspace API keys in product words: access presets, human permission
 * labels, the key's real status (a key past its expiry is Expired, never
 * Active) and the expiry choices of the create page.
 *
 * Workspace keys never carry organization-level scopes (account, billing,
 * creating workspaces); organization developer keys exist for that.
 */

import { apiKeyStatus as apiKeyStatusAt, type ApiKeyStatus } from "@/lib/api-key-status";
import { defaultApiKeyPermissions } from "@/lib/permissions";

export type ApiKeyPresetId =
  | "read_only"
  | "run_sessions"
  | "full_automation"
  | "all_permissions"
  | "custom";

export type { ApiKeyStatus };

interface KeyTimes {
  expiresAt: string | null;
  revokedAt: string | null;
}

/** Scopes a workspace key can't carry. */
const ORGANIZATION_SCOPES = new Set<string>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "usage_allowances:manage",
]);

/** Old names still accepted by the API; never offered, but labelled on old keys. */
const DEPRECATED_ALIASES = new Set<string>(["environments:manage", "environments:use"]);

/** Every permission a workspace key may be given, in groups people recognise. */
export const WORKSPACE_KEY_PERMISSION_GROUPS: ReadonlyArray<{
  label: string;
  permissions: readonly string[];
}> = [
  {
    label: "Sessions",
    permissions: [
      "sessions:read",
      "sessions:create",
      "sessions:control",
      "stream:view",
      "stream:control",
      "stream:acknowledge",
      "terminal:attach",
      "codemode:call",
      "mcp_servers:attach",
      "goals:manage",
    ],
  },
  {
    label: "Files and knowledge",
    permissions: [
      "files:read",
      "files:upload",
      "files:write",
      "documents:search",
      "documents:manage",
      "artifacts:read",
      "artifacts:publish",
    ],
  },
  {
    label: "Schedules",
    permissions: ["scheduled_tasks:run", "scheduled_tasks:manage"],
  },
  {
    label: "Variable sets and secrets",
    permissions: [
      "variable-sets:list",
      "variable-sets:read",
      "variable-sets:use",
      "variable-sets:attach",
      "variable-sets:write",
      "variable-sets:manage",
      "secrets:list",
      "secrets:read",
      "secrets:write",
    ],
  },
  {
    label: "Connections and code",
    permissions: [
      "connections:read",
      "connections:write",
      "capabilities:manage",
      "github:use",
      "github:manage",
    ],
  },
  {
    label: "Compute",
    permissions: ["rigs:use", "rigs:manage", "enrollments:read", "enrollments:manage"],
  },
  {
    label: "Workspace",
    permissions: ["workspace:read", "workspace:admin", "members:manage", "api_keys:manage"],
  },
];

const PERMISSION_LABELS: Record<string, string> = {
  "workspace:read": "See the workspace",
  "workspace:admin": "Administer the workspace",
  "members:manage": "Manage who has access",
  "api_keys:manage": "Manage API keys",
  "sessions:read": "Read sessions",
  "sessions:create": "Start sessions",
  "sessions:control": "Control sessions",
  "stream:view": "Watch live output",
  "stream:control": "Control live output",
  "stream:acknowledge": "Acknowledge live output",
  "terminal:attach": "Open a terminal",
  "codemode:call": "Call tools from code",
  "mcp_servers:attach": "Attach MCP servers",
  "goals:manage": "Manage goals",
  "files:read": "Read files",
  "files:upload": "Upload files",
  "files:write": "Change files",
  "documents:search": "Search knowledge",
  "documents:manage": "Manage knowledge",
  "artifacts:read": "Read artifacts",
  "artifacts:publish": "Publish artifacts",
  "scheduled_tasks:run": "Run schedules",
  "scheduled_tasks:manage": "Manage schedules",
  "variable-sets:list": "List variable sets",
  "variable-sets:read": "Read variable values",
  "variable-sets:use": "Use variable sets",
  "variable-sets:attach": "Attach variable sets",
  "variable-sets:write": "Change variable sets",
  "variable-sets:manage": "Manage variable sets",
  "environments:use": "Use variable sets",
  "environments:manage": "Manage variable sets",
  "secrets:list": "List secrets",
  "secrets:read": "Read secret values",
  "secrets:write": "Change secrets",
  "connections:read": "See connections",
  "connections:write": "Manage connections",
  "capabilities:manage": "Manage capabilities",
  "github:use": "Use GitHub",
  "github:manage": "Manage GitHub",
  "rigs:use": "Use sandbox environments",
  "rigs:manage": "Manage sandbox environments",
  "enrollments:read": "See machines",
  "enrollments:manage": "Manage machines",
  "account:read": "See the organization",
  "account:admin": "Administer the organization",
  "workspace:create": "Create workspaces",
  "billing:read": "See billing",
  "billing:manage": "Manage billing",
};

/** "Read sessions" for `sessions:read`; the raw scope when it's unknown. */
export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

/** Every permission a workspace key may carry. */
export function workspaceKeyPermissions(): string[] {
  return WORKSPACE_KEY_PERMISSION_GROUPS.flatMap((group) => [...group.permissions]);
}

/** Not an organization scope and not a deprecated alias. */
export function isWorkspaceKeyPermission(permission: string): boolean {
  return !ORGANIZATION_SCOPES.has(permission) && !DEPRECATED_ALIASES.has(permission);
}

/** Everything a member can do with automation, without administering the workspace or reading secret values. */
const FULL_AUTOMATION_EXCLUDED = new Set<string>([
  "workspace:admin",
  "members:manage",
  "api_keys:manage",
  "secrets:read",
  "variable-sets:read",
]);

export interface ApiKeyPreset {
  id: ApiKeyPresetId;
  label: string;
  /** What picking it means, one sentence. */
  description: string;
  permissions: readonly string[];
}

let cachedPresets: ApiKeyPreset[] | null = null;

/** Lazy: `defaultApiKeyPermissions` must not be read at module scope (chunk order). */
export function apiKeyPresets(): ApiKeyPreset[] {
  cachedPresets ??= [
    {
      id: "read_only",
      label: "Read only",
      description: "Read sessions, files and knowledge. Can't start or change anything.",
      permissions: [
        "workspace:read",
        "sessions:read",
        "stream:view",
        "files:read",
        "documents:search",
        "artifacts:read",
      ],
    },
    {
      id: "run_sessions",
      label: "Run sessions",
      description: "Start sessions, send messages, upload files and read the results.",
      permissions: [...defaultApiKeyPermissions],
    },
    {
      id: "full_automation",
      label: "Full workspace automation",
      description:
        "Everything automation needs, including schedules, variable sets and files. Can't manage people, keys or read secret values.",
      permissions: workspaceKeyPermissions().filter(
        (permission) => !FULL_AUTOMATION_EXCLUDED.has(permission),
      ),
    },
    {
      id: "all_permissions",
      label: "All permissions",
      description:
        "Full workspace access, including managing people and API keys and reading secret values.",
      permissions: workspaceKeyPermissions(),
    },
    {
      id: "custom",
      label: "Custom",
      description: "Pick exactly what this key can do.",
      permissions: [],
    },
  ];
  return cachedPresets;
}

export function presetById(id: ApiKeyPresetId): ApiKeyPreset {
  return apiKeyPresets().find((preset) => preset.id === id)!;
}

/** The preset whose permissions match exactly, or "custom". */
export function presetFor(permissions: readonly string[]): ApiKeyPresetId {
  const wanted = new Set(permissions);
  for (const preset of apiKeyPresets()) {
    if (preset.id === "custom") continue;
    if (
      preset.permissions.length === wanted.size &&
      preset.permissions.every((permission) => wanted.has(permission))
    ) {
      return preset.id;
    }
  }
  return "custom";
}

export function countLabel(count: number): string {
  return `${count} ${count === 1 ? "permission" : "permissions"}`;
}

/** The key's access in a few words: "Run sessions", or "Custom · 4 permissions". */
export function accessLabel(permissions: readonly string[]): string {
  const preset = presetFor(permissions);
  if (preset === "custom") return `Custom · ${countLabel(permissions.length)}`;
  return presetById(preset).label;
}

/** Revoked wins; a key past its expiry is Expired even though nobody revoked it. */
export function apiKeyStatus(key: KeyTimes, now: Date = new Date()): ApiKeyStatus {
  return apiKeyStatusAt(key, now.getTime());
}

export type ApiKeyExpiryId = "30d" | "90d" | "1y" | "never";

export const DEFAULT_API_KEY_EXPIRY: ApiKeyExpiryId = "90d";

export const API_KEY_EXPIRY_CHOICES: ReadonlyArray<{ id: ApiKeyExpiryId; label: string }> = [
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "1y", label: "1 year" },
  { id: "never", label: "Never" },
];

/** The expiry as an ISO timestamp counted from `now`, or null for Never. */
export function expiryDate(id: ApiKeyExpiryId, now: Date = new Date()): Date | null {
  if (id === "never") return null;
  const date = new Date(now.getTime());
  if (id === "1y") date.setFullYear(date.getFullYear() + 1);
  else date.setDate(date.getDate() + (id === "30d" ? 30 : 90));
  return date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "31 Mar 2027": keys show calendar days, in the viewer's time zone. */
export function keyDateLabel(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
