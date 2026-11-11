import type { AccessGrant, ScheduledTaskAgentConfig } from "@opengeni/contracts";
import { recordAuditEvent, type Database } from "@opengeni/db";
import { isDeepStrictEqual } from "node:util";

/** The audit action written whenever a schedule's account or connector choices change. */
export const SCHEDULED_TASK_ACCOUNT_CHOICES_AUDIT_ACTION = "scheduled_task.account_choices_changed";

type Choices = {
  pinnedAccounts: { serverId: string; connectionId: string }[];
  pinnedAccountsRequired: boolean;
  connectors: {
    followsWorkspaceDefaults: boolean;
    excludedMcpServerIds: string[];
    tools: string[];
  };
};

function choicesOf(config: ScheduledTaskAgentConfig | null): Choices {
  return {
    pinnedAccounts: [...(config?.pinnedAccounts ?? [])]
      .map(({ serverId, connectionId }) => ({ serverId, connectionId }))
      .sort((a, b) =>
        a.serverId === b.serverId
          ? a.connectionId.localeCompare(b.connectionId)
          : a.serverId.localeCompare(b.serverId),
      ),
    pinnedAccountsRequired: config?.pinnedAccountsRequired === true,
    connectors: {
      followsWorkspaceDefaults: config?.toolPolicy !== undefined,
      excludedMcpServerIds: [...(config?.toolPolicy?.excludedMcpServerIds ?? [])].sort(),
      tools: (config?.tools ?? [])
        .filter((tool) => tool.kind === "mcp")
        .map((tool) => tool.id)
        .sort(),
    },
  };
}

/**
 * What changed in a schedule's account and connector choices, as audit
 * metadata: each changed choice with its value before and after. Only the
 * choices are recorded (server and connection ids), never a credential or an
 * account label. Returns null when nothing changed; a new schedule without
 * any choice records nothing.
 */
export function scheduledTaskAccountChoiceChanges(
  before: ScheduledTaskAgentConfig | null,
  after: ScheduledTaskAgentConfig,
): Record<string, { before: unknown; after: unknown }> | null {
  const prior = choicesOf(before);
  const next = choicesOf(after);
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of ["pinnedAccounts", "pinnedAccountsRequired", "connectors"] as const) {
    if (!isDeepStrictEqual(prior[key], next[key]))
      changes[key] = { before: prior[key], after: next[key] };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Record a change to a schedule's account or connector choices in the same
 * transaction as the change, with who made it and through which kind of
 * caller (a person, an agent, an API key or a service).
 */
export async function recordScheduledTaskAccountChoiceChanges(
  tx: Database,
  input: {
    grant: AccessGrant;
    taskId: string;
    operation: "create" | "update";
    before: ScheduledTaskAgentConfig | null;
    after: ScheduledTaskAgentConfig;
  },
): Promise<void> {
  const changes = scheduledTaskAccountChoiceChanges(input.before, input.after);
  if (!changes) return;
  await recordAuditEvent(tx, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    subjectId: input.grant.subjectId,
    action: SCHEDULED_TASK_ACCOUNT_CHOICES_AUDIT_ACTION,
    targetType: "scheduled_task",
    targetId: input.taskId,
    metadata: {
      operation: input.operation,
      principalKind: input.grant.principalKind ?? null,
      changes,
    },
  });
}
