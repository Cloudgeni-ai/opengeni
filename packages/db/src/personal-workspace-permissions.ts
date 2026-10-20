import type { Permission } from "@opengeni/contracts";

/**
 * Runtime capabilities for the authenticated managed human's personal
 * workspace. This projection is deliberately not an administrative grant:
 * workspace administration is a wildcard over member management and API-key
 * delegation, either of which would let the owner create another principal
 * with ambient access to the private workspace.
 */
export const managedPersonalWorkspacePermissions: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  // Live viewing and handoff of the owner's own sessions (browser/computer sign-in handoff, desktop,
  // terminal, file edits). Without these the owner was refused (403) when joining their own handoff.
  "stream:view",
  "stream:control",
  "stream:acknowledge",
  "terminal:attach",
  "files:write",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "connections:read",
  "connections:write",
  "capabilities:manage",
  "variable-sets:list",
  "variable-sets:read",
  "variable-sets:write",
  "variable-sets:manage",
  "variable-sets:attach",
  "variable-sets:use",
  "secrets:list",
  "secrets:read",
  "secrets:write",
  "mcp_servers:attach",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
  "rigs:use",
  // Personal-workspace owners create and maintain their own Sandbox Environments.
  "rigs:manage",
  "artifacts:read",
  "artifacts:publish",
];
