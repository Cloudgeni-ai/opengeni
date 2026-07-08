import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type { AccessGrant, VariableSet } from "@opengeni/contracts";
import {
  getVariableSet,
  recordAuditEvent,
  type Database,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";

export const MAX_ENVIRONMENTS_PER_WORKSPACE = 25;
export const MAX_VARIABLES_PER_ENVIRONMENT = 100;

// Names the platform itself injects into sandboxes (sandboxEnvironmentForRun,
// collectGitIdentityEnvironment) plus loader/startup-injection vectors. These
// can never be set as variable set variables, so the run-scoped
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

export function assertAllowedVariableSetVariableName(name: string): void {
  if (reservedExactNames.has(name) || reservedPrefixes.some((prefix) => name.startsWith(prefix))) {
    throw new HTTPException(422, { message: `reserved variable set variable name: ${name}` });
  }
}

/** @deprecated use assertAllowedVariableSetVariableName */
export const assertAllowedEnvironmentVariableName = assertAllowedVariableSetVariableName;

export function requireVariableSetEncryption(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new HTTPException(503, { message: "variable sets require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY" });
  }
  return key;
}

/** @deprecated use requireVariableSetEncryption */
export const requireEnvironmentEncryption = requireVariableSetEncryption;

export async function requireVariableSetForApi(db: Database, workspaceId: string, variableSetId: string): Promise<VariableSet> {
  const variableSet = await getVariableSet(db, workspaceId, variableSetId);
  if (!variableSet) {
    throw new HTTPException(404, { message: "variableSet not found" });
  }
  return variableSet;
}

/**
 * Validates an variableSet attachment supplied in a request payload (session
 * create, scheduled task create/update, pack enable). Requires the
 * `variable-sets:use` permission unless the attachment was already authorized
 * (pack-installation-inherited attachments), and maps a missing or
 * cross-variable set to 422 because the id is payload, not the route
 * target. RLS plus the workspace_id clause make cross-workspace ids
 * indistinguishable from missing ones.
 */
export async function validateVariableSetAttachment(
  deps: { settings: Settings; db: Database },
  grant: AccessGrant,
  workspaceId: string,
  variableSetId: string,
  options: { preauthorized?: boolean } = {},
): Promise<VariableSet> {
  requireVariableSetEncryption(deps.settings);
  if (!options.preauthorized) {
    requirePermission(grant, "variable-sets:use");
  }
  const variableSet = await getVariableSet(deps.db, workspaceId, variableSetId);
  if (!variableSet) {
    throw new HTTPException(422, { message: "unknown variableSetId" });
  }
  return variableSet;
}

export async function recordVariableSetAuditEvent(db: Database, input: {
  grant: AccessGrant;
  action: "variable_set.created" | "variable_set.updated" | "variable_set.deleted" | "variable_set.variable.set" | "variable_set.variable.deleted";
  variableSetId: string;
  variableName?: string;
}): Promise<void> {
  await recordAuditEvent(db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    subjectId: input.grant.subjectId,
    action: input.action,
    targetType: "workspace_variable_set",
    targetId: input.variableSetId,
    metadata: {
      variableSetId: input.variableSetId,
      ...(input.variableName ? { name: input.variableName } : {}),
    },
  });
}
