import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { AccessGrant, WorkspaceEnvironment } from "@opengeni/contracts";
import {
  getWorkspaceEnvironment,
  recordAuditEvent,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";

export const MAX_ENVIRONMENTS_PER_WORKSPACE = 25;
export const MAX_VARIABLES_PER_ENVIRONMENT = 100;

// Names the platform itself injects into sandboxes (sandboxEnvironmentForRun,
// collectGitIdentityEnvironment) plus loader/startup-injection vectors. These
// can never be set as workspace environment variables, so the run-scoped
// GitHub auth block and git identity always win without silent collisions.
const reservedExactNames = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "IFS",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "PERL5LIB",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GIT_TERMINAL_PROMPT",
]);

const reservedPrefixes = [
  "OPENGENI_",
  "GIT_CONFIG_",
  "GIT_AUTHOR_",
  "GIT_COMMITTER_",
  "LD_",
  "DYLD_",
];

export function assertAllowedEnvironmentVariableName(name: string): void {
  if (reservedExactNames.has(name) || reservedPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new HTTPException(422, { message: `reserved environment variable name: ${name}` });
  }
}

export function requireEnvironmentEncryption(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, { message: "workspace environments require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY" });
  }
  return key;
}

export async function requireEnvironmentForApi(db: Database, workspaceId: string, environmentId: string): Promise<WorkspaceEnvironment> {
  const environment = await getWorkspaceEnvironment(db, workspaceId, environmentId);
  if (!environment) {
    throw new HTTPException(404, { message: "environment not found" });
  }
  return environment;
}

/**
 * Validates an environment attachment supplied in a request payload (session
 * create, scheduled task create/update, pack enable). Requires the
 * `environments:use` permission unless the attachment was already authorized
 * (pack-installation-inherited attachments), and maps a missing or
 * cross-workspace environment to 422 because the id is payload, not the route
 * target. RLS plus the workspace_id clause make cross-workspace ids
 * indistinguishable from missing ones.
 */
export async function validateEnvironmentAttachment(
  deps: { settings: Settings; db: Database },
  grant: AccessGrant,
  workspaceId: string,
  environmentId: string,
  options: { preauthorized?: boolean } = {},
): Promise<WorkspaceEnvironment> {
  requireEnvironmentEncryption(deps.settings);
  if (!options.preauthorized) {
    requirePermission(grant, "environments:use");
  }
  const environment = await getWorkspaceEnvironment(deps.db, workspaceId, environmentId);
  if (!environment) {
    throw new HTTPException(422, { message: "unknown environmentId" });
  }
  return environment;
}

export async function recordEnvironmentAuditEvent(db: Database, input: {
  grant: AccessGrant;
  action: "environment.created" | "environment.updated" | "environment.deleted" | "environment.variable.set" | "environment.variable.deleted";
  environmentId: string;
  variableName?: string;
}): Promise<void> {
  await recordAuditEvent(db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    subjectId: input.grant.subjectId,
    action: input.action,
    targetType: "workspace_environment",
    targetId: input.environmentId,
    metadata: {
      environmentId: input.environmentId,
      ...(input.variableName ? { name: input.variableName } : {}),
    },
  });
}
