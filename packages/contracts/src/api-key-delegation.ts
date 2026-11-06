import type { Permission } from "./permissions";

/*
 * Who can create which API key, shared by the API (which enforces it) and the
 * apps (which explain it), so a hint can never name someone the server refuses.
 */

/** Workspace permissions a Workspace owner holds, as their membership is created. */
export const WORKSPACE_OWNER_PERMISSIONS: readonly Permission[] = [
  "workspace:read",
  "workspace:admin",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "connections:personal",
  "capabilities:manage",
  "secrets:list",
  "secrets:read",
  "secrets:write",
  "secrets:use",
  "mcp_servers:attach",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
  "artifacts:read",
  "artifacts:publish",
];

/** Workspace permissions the Workspace admin role gives. It never reads secret values. */
export const WORKSPACE_ADMIN_ROLE_PERMISSIONS: readonly Permission[] = [
  "workspace:read",
  "workspace:admin",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "stream:view",
  "stream:control",
  "stream:acknowledge",
  "terminal:attach",
  "codemode:call",
  "files:upload",
  "files:read",
  "files:write",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "secrets:list",
  "secrets:write",
  "secrets:use",
  "mcp_servers:attach",
  "goals:manage",
  "rigs:use",
  "rigs:manage",
  "enrollments:read",
  "enrollments:manage",
  "artifacts:read",
  "artifacts:publish",
];

/**
 * Organization powers that `workspace:admin` doesn't delegate to a workspace
 * key: the creator's organization grant must hold each one literally.
 */
export const WORKSPACE_KEY_ACCOUNT_LITERAL_PERMISSIONS: readonly Permission[] = [
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
];

/**
 * Workspace powers that `workspace:admin` doesn't delegate to a workspace key:
 * the creator's own workspace access must hold each one literally.
 */
export const WORKSPACE_KEY_WORKSPACE_LITERAL_PERMISSIONS: readonly Permission[] = [
  "members:manage",
  "secrets:read",
];

/**
 * Whether someone holding `workspace:admin` (not an explicit policy) may give
 * a workspace key this permission: everything except the literal powers above
 * that their own grants don't hold.
 */
export function workspaceAdminDelegates(
  workspacePermissions: readonly string[],
  accountPermissions: readonly string[],
  permission: string,
): boolean {
  if (
    WORKSPACE_KEY_ACCOUNT_LITERAL_PERMISSIONS.includes(permission as Permission) &&
    !accountPermissions.includes(permission)
  )
    return false;
  return (
    !WORKSPACE_KEY_WORKSPACE_LITERAL_PERMISSIONS.includes(permission as Permission) ||
    workspacePermissions.includes(permission)
  );
}

export type WorkspaceKeyCreator = "workspace_admin" | "workspace_owner";

/**
 * The least workspace role whose own access can create a workspace key with
 * these permissions, or null when no workspace role can (organization powers).
 */
export function workspaceKeyCreator(permissions: readonly string[]): WorkspaceKeyCreator | null {
  const roles: [WorkspaceKeyCreator, readonly Permission[]][] = [
    ["workspace_admin", WORKSPACE_ADMIN_ROLE_PERMISSIONS],
    ["workspace_owner", WORKSPACE_OWNER_PERMISSIONS],
  ];
  for (const [creator, held] of roles) {
    if (permissions.every((permission) => workspaceAdminDelegates(held, [], permission)))
      return creator;
  }
  return null;
}

/** What a workspace key can do that a Workspace admin can't give it, in words. */
const OWNER_ONLY_WORDS: Partial<Record<string, string>> = {
  "secrets:read": "reads secret values",
  "members:manage": "manages people",
};

/**
 * Who can create a workspace key with these permissions, as one sentence:
 * "A workspace admin can create it." or "Only a workspace owner can create a
 * key that reads secret values." Null when no workspace role can.
 */
export function workspaceKeyCreatorSentence(permissions: readonly string[]): string | null {
  const creator = workspaceKeyCreator(permissions);
  if (creator === "workspace_admin") return "A workspace admin can create it.";
  if (creator !== "workspace_owner") return null;
  const words = permissions
    .filter(
      (permission) => !workspaceAdminDelegates(WORKSPACE_ADMIN_ROLE_PERMISSIONS, [], permission),
    )
    .map((permission) => OWNER_ONLY_WORDS[permission])
    .filter((each): each is string => Boolean(each));
  return words.length > 0
    ? `Only a workspace owner can create a key that ${[...new Set(words)].join(" or ")}.`
    : "Only a workspace owner can create it.";
}

/**
 * The API's refusal when `workspace:admin` can't delegate some literal powers
 * to a workspace key: the missing permissions, then who can create it.
 */
export function workspaceKeyLiteralRefusal(
  missing: readonly string[],
  requested: readonly string[],
): string {
  const creator = workspaceKeyCreatorSentence(requested);
  return `cannot delegate missing literal permissions: ${missing.join(", ")}${creator ? `. ${creator}` : ""}`;
}

/**
 * Why an organization admin who isn't the owner can't create an organization
 * key: keys holding people, key or billing administration are the owner's.
 */
export const OWNER_LEVEL_API_KEY_CREATOR_SENTENCE =
  "Only the organization owner can create a key that manages people, keys or billing.";

/** The server's refusal when an organization admin changes an owner-level key or service account. */
export const OWNER_LEVEL_API_KEY_MESSAGE =
  "Only the organization owner can manage keys and service accounts that manage people, keys or billing.";
