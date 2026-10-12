/**
 * Scheduled-task access drift, the owner's explicit access refresh, and the
 * in-app signal for runs that failed closed on connector access or ran without
 * an unusable pinned account.
 *
 * A separate-agent task saves its connectors and (when an agent created it,
 * migration 0428) its Opengeni tool policy. Connector accounts are never
 * saved: every run resolves the owner's current accounts, except for accounts
 * a person explicitly pinned. This module computes one plan: what the task's
 * owner would get by saving it again now, and which pinned accounts can no
 * longer be used. The refresh applies exactly that plan through the ordinary
 * owner update path, so a refresh never widens beyond what the calling person
 * could grant with an edit. See docs/scheduled-task-access.md.
 */
import {
  allowedFirstPartyMcpToolsForSession,
  resolveFirstPartyMcpToolPolicy,
  type Settings,
  type FirstPartyMcpToolPolicySettings,
} from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  SCHEDULED_TASK_ACCOUNT_PLAN_ACCOUNTS_MAX,
  SCHEDULED_TASK_ACCESS_CONNECTORS_MAX,
  SCHEDULED_TASK_ACCESS_ATTENTION_MAX,
  SCHEDULED_TASK_RUN_ACCESS_FAILURES_MAX,
  ToolAuthNeededReason,
  mergeToolRefs,
  resolveWorkspaceSessionToolDefaults,
  scheduledTaskKnowledgeSource,
  type AccessGrant,
  type ConnectionMetadata,
  type FirstPartyMcpToolName,
  type McpConnectionAccountBinding,
  type McpConnectionAccountSelection,
  type Permission,
  type RefreshScheduledTaskAccessRequest,
  type ScheduledTask,
  type ScheduledTaskAccountPlan,
  type ScheduledTaskAccessAttention,
  type ScheduledTaskAccessConnector,
  type ScheduledTaskPolicyDrift,
  type ScheduledTaskRun,
  type ScheduledTaskRunAccessFailure,
  type SessionAuthorizationPort,
  type SessionAuthorizationSurface,
  type ToolRef,
} from "@opengeni/contracts";
import { GOOGLE_DRIVE_PUBLICATION_SERVER_ID } from "@opengeni/contracts/google-drive";
import { PERSONAL_GITHUB_CONNECTION_SURFACE_ID } from "@opengeni/contracts/personal-github";
import {
  getSession,
  listActiveScheduledTasksWithPinnedAccounts,
  listScheduledTaskAccessAttentionEvents,
  listScheduledTaskHumanWaitAttention,
  listScheduledTaskCreatorPolicies,
  listScheduledTaskRunAuthNeededEvents,
  requireWorkspace,
  ScheduledTaskHeadChangedError,
  type Database,
  type ScheduledTaskCreatorPolicy,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  requirePermission,
  type AccessGrantAuthorization,
} from "../access";
import type { ObjectStorageDependency } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import {
  availableMcpAccountBindings,
  personalConnectionDelegationSourceForGrant,
  visibleMcpAccountConnections,
  type PersonalConnectionDelegationSource,
} from "./personal-connection-delegations";
import { withWorkspaceDefaultMcpTools } from "./resources";
import { requireVisibleScheduledTask } from "./scheduled-task-audience";
import {
  assertScheduledTaskMutationOwner,
  scheduledConnectionTools,
  updateScheduledTaskForApi,
  validatedScheduledTaskUpdate,
} from "./scheduled-tasks";
import { settingsWithSessionMcpServerMetadata } from "./sessions";

const ALWAYS_ATTACHED_CONNECTOR = "opengeni";

/** Special first-party surfaces keep their own account contract; a refresh passes them through. */
const PRESERVED_ACCOUNT_SURFACES: ReadonlySet<string> = new Set([
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  PERSONAL_GITHUB_CONNECTION_SURFACE_ID,
]);

export type ScheduledTaskConnectorPlan = {
  tools: ToolRef[];
  missing: ScheduledTaskAccessConnector[];
  unavailable: ScheduledTaskAccessConnector[];
};

function connector(
  id: string,
  names: ReadonlyMap<string, string>,
  fallback?: string,
): ScheduledTaskAccessConnector {
  const name = names.get(id)?.trim() || fallback?.trim() || id;
  return { id: id.slice(0, 256), name: name.slice(0, 256) };
}

function uniqueById(items: ScheduledTaskAccessConnector[]): ScheduledTaskAccessConnector[] {
  const seen = new Set<string>();
  return items
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .slice(0, SCHEDULED_TASK_ACCESS_CONNECTORS_MAX);
}

/**
 * Connectors: keep every connector the task already uses that still exists,
 * drop the ones this workspace no longer sets up, and add the workspace
 * defaults a new schedule would get, except the ones the owner chose to keep
 * off (`leaveOut`). A refresh never removes a connector the owner deliberately
 * kept, so it only narrows what no longer exists.
 */
export function planScheduledTaskConnectors(input: {
  taskTools: readonly ToolRef[];
  defaultTools: readonly ToolRef[];
  availableServerIds: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
  leaveOut?: ReadonlySet<string>;
}): ScheduledTaskConnectorPlan {
  const unavailable = input.taskTools.filter(
    (tool) => tool.id !== ALWAYS_ATTACHED_CONNECTOR && !input.availableServerIds.has(tool.id),
  );
  const unavailableIds = new Set(unavailable.map((tool) => tool.id));
  const kept = input.taskTools.filter((tool) => !unavailableIds.has(tool.id));
  const keptIds = new Set(kept.map((tool) => tool.id));
  const missing = input.defaultTools.filter(
    (tool) =>
      tool.id !== ALWAYS_ATTACHED_CONNECTOR &&
      !keptIds.has(tool.id) &&
      !input.leaveOut?.has(tool.id) &&
      input.availableServerIds.has(tool.id),
  );
  return {
    tools: mergeToolRefs([...kept], [...missing]),
    missing: uniqueById(missing.map((tool) => connector(tool.id, input.names))),
    unavailable: uniqueById(unavailable.map((tool) => connector(tool.id, input.names))),
  };
}

export type ScheduledTaskPinnedAccountPlan = {
  /** Pins that stay: their connector is still used (special surfaces always stay). */
  kept: McpConnectionAccountSelection[];
  /** Connectors with a pinned account the owner can no longer use. */
  unavailable: ScheduledTaskAccessConnector[];
  /** Connectors with a pin that the task no longer uses; saving drops the pin. */
  dropped: ScheduledTaskAccessConnector[];
};

/**
 * Person-pinned accounts against what the owner can use now. Unpinned
 * connectors need no plan: every run resolves the owner's current accounts.
 * A pin is unavailable when its connector is still used but the pinned
 * account no longer resolves for the owner; runs then go without that
 * connector, never with another account. A pin whose connector the task no
 * longer uses is dropped by the next save. Special first-party surfaces keep
 * their own account contract and are checked at admission.
 */
export function planScheduledTaskPinnedAccounts(input: {
  pins: readonly McpConnectionAccountSelection[];
  connectionServerIds: readonly string[];
  availableBindings: ReadonlyArray<{ canonicalServerId: string; connectionId: string }>;
  names: ReadonlyMap<string, string>;
}): ScheduledTaskPinnedAccountPlan {
  const used = new Set(input.connectionServerIds);
  const available = new Set(
    input.availableBindings.map((binding) =>
      JSON.stringify([binding.canonicalServerId, binding.connectionId]),
    ),
  );
  const kept: McpConnectionAccountSelection[] = [];
  const unavailable: ScheduledTaskAccessConnector[] = [];
  const dropped: ScheduledTaskAccessConnector[] = [];
  for (const pin of input.pins) {
    if (PRESERVED_ACCOUNT_SURFACES.has(pin.serverId)) {
      kept.push(pin);
      continue;
    }
    if (!used.has(pin.serverId)) {
      dropped.push(connector(pin.serverId, input.names));
      continue;
    }
    kept.push(pin);
    if (!available.has(JSON.stringify([pin.serverId, pin.connectionId])))
      unavailable.push(connector(pin.serverId, input.names));
  }
  return {
    kept,
    unavailable: uniqueById(unavailable),
    dropped: uniqueById(dropped),
  };
}

/**
 * What each connector of a scheduled run would act as if the run started
 * now. `bindings` are every account the owner can use for the task's
 * connectors right now, resolved the way a run resolves them. A connector
 * without pins follows those accounts (Default); a pinned connector uses only
 * the pinned accounts that still resolve and names the ones that do not.
 * Special first-party surfaces keep their own account contract and are not
 * listed; neither are host-supplied connectors (absent from
 * `connectionServerIds`).
 */
export function planScheduledTaskAccounts(input: {
  connectionServerIds: readonly string[];
  pins: readonly McpConnectionAccountSelection[];
  bindings: ReadonlyArray<
    Pick<
      McpConnectionAccountBinding,
      "canonicalServerId" | "connectionId" | "accountLabel" | "subjectScope"
    >
  >;
  names: ReadonlyMap<string, string>;
}): ScheduledTaskAccountPlan {
  const connectors: ScheduledTaskAccountPlan["connectors"] = [];
  for (const serverId of new Set(input.connectionServerIds)) {
    if (PRESERVED_ACCOUNT_SURFACES.has(serverId)) continue;
    if (connectors.length === SCHEDULED_TASK_ACCESS_CONNECTORS_MAX) break;
    const pinned = new Set(
      input.pins.filter((pin) => pin.serverId === serverId).map((pin) => pin.connectionId),
    );
    const usable = input.bindings.filter(
      (binding) =>
        binding.canonicalServerId === serverId &&
        (pinned.size === 0 || pinned.has(binding.connectionId)),
    );
    const resolved = new Set(usable.map((binding) => binding.connectionId));
    connectors.push({
      ...connector(serverId, input.names),
      mode: pinned.size === 0 ? "default" : "pinned",
      accounts: usable.slice(0, SCHEDULED_TASK_ACCOUNT_PLAN_ACCOUNTS_MAX).map((binding) => ({
        connectionId: binding.connectionId,
        label: binding.accountLabel,
        scope: binding.subjectScope === "subject" ? ("personal" as const) : ("shared" as const),
      })),
      unavailablePins: [...pinned]
        .filter((connectionId) => !resolved.has(connectionId))
        .slice(0, SCHEDULED_TASK_ACCOUNT_PLAN_ACCOUNTS_MAX)
        .map((connectionId) => ({ connectionId })),
    });
  }
  return { connectors };
}

export type ScheduledTaskOpenGeniToolPlan = {
  missing: FirstPartyMcpToolName[];
  policy: {
    firstPartyMcpTools: FirstPartyMcpToolName[];
    firstPartyMcpPermissions: Permission[];
  } | null;
};

function sameMembers<T>(left: readonly T[], right: readonly T[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/** Permissions each first-party tool needs; the API passes its MCP registration table. */
export type FirstPartyToolPermissionRequirements = (
  tools: readonly FirstPartyMcpToolName[],
) => readonly Permission[];

/**
 * Opengeni tools of an agent-created task (migration 0428). A human- or
 * API-created task has no frozen creator policy and already follows the
 * deployment default at each run, so there is nothing to refresh. For a frozen
 * policy the refresh adds the current default tools. Permissions stay
 * least-privilege: a frozen permission is kept only while the refreshing
 * person holds it, and the only permissions added are the ones the newly
 * added tools need, within the default worker set and that person's grant. A
 * refresh therefore never lifts a deliberately narrowed permission boundary
 * for tools the task already had, and every addition follows a tool the drift
 * report names. Default tools the owner chose to keep off (`leaveOut`) are
 * neither reported nor added. The frozen session policy (agent access, scope,
 * memory) is never touched.
 */
export function planScheduledTaskOpenGeniTools(input: {
  creatorPolicy: Pick<
    ScheduledTaskCreatorPolicy,
    "firstPartyMcpTools" | "firstPartyMcpPermissions"
  > | null;
  settings: FirstPartyMcpToolPolicySettings;
  grantPermissions: readonly Permission[];
  grantPermissionMode?: AccessGrant["permissionMode"];
  permissionsRequiredByTools: FirstPartyToolPermissionRequirements;
  leaveOut?: ReadonlySet<FirstPartyMcpToolName>;
}): ScheduledTaskOpenGeniToolPlan {
  const stored = input.creatorPolicy?.firstPartyMcpTools;
  if (!stored) return { missing: [], policy: null };
  const effective = new Set(allowedFirstPartyMcpToolsForSession(input.settings, stored));
  const missing = resolveFirstPartyMcpToolPolicy(input.settings).default.filter(
    (tool) => !effective.has(tool) && !input.leaveOut?.has(tool),
  );
  const tools = [...new Set([...stored, ...missing])];
  // A frozen null permission set runs with the default worker set (see the
  // scheduler), so that is the boundary a refresh starts from.
  const priorPermissions: readonly Permission[] = input.creatorPolicy?.firstPartyMcpPermissions ?? [
    ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  ];
  const holds = (permission: Permission) =>
    hasPermission(input.grantPermissions, permission, input.grantPermissionMode);
  const defaults: ReadonlySet<Permission> = new Set(DEFAULT_FIRST_PARTY_MCP_PERMISSIONS);
  const added = input
    .permissionsRequiredByTools(missing)
    .filter((permission) => defaults.has(permission) && holds(permission));
  const permissions = [...new Set<Permission>([...priorPermissions.filter(holds), ...added])];
  const unchanged = sameMembers(tools, stored) && sameMembers(permissions, priorPermissions);
  return {
    missing,
    policy: unchanged ? null : { firstPartyMcpTools: tools, firstPartyMcpPermissions: permissions },
  };
}

const AuthNeededFact = z.object({
  serverId: z.string().min(1),
  canonicalServerId: z.string().min(1).optional(),
  providerDomain: z.string().min(1),
  reason: ToolAuthNeededReason,
  capability: z.unknown().optional(),
  setupRequest: z.unknown().optional(),
});

/**
 * Fold one run's `tool.auth_needed` facts into one entry per connector and
 * reason. An agent's recommendation to set up a new capability or custom
 * connector is a suggestion, not a failed frozen access, and is left out.
 */
export function scheduledTaskRunAccessFailures(
  events: ReadonlyArray<{ payload: unknown; occurredAt: string }>,
  names: ReadonlyMap<string, string>,
): ScheduledTaskRunAccessFailure[] {
  const byKey = new Map<string, ScheduledTaskRunAccessFailure>();
  for (const event of events) {
    const parsed = AuthNeededFact.safeParse(event.payload);
    if (!parsed.success) continue;
    const fact = parsed.data;
    if (fact.capability !== undefined || fact.setupRequest !== undefined) continue;
    const serverId = (fact.canonicalServerId ?? fact.serverId).slice(0, 256);
    const key = `${serverId}\u0000${fact.reason}`;
    const prior = byKey.get(key);
    if (prior) {
      prior.count += 1;
      if (event.occurredAt < prior.firstOccurredAt) prior.firstOccurredAt = event.occurredAt;
      continue;
    }
    byKey.set(key, {
      serverId,
      name: connector(serverId, names, fact.providerDomain).name,
      providerDomain: fact.providerDomain.slice(0, 512),
      reason: fact.reason,
      count: 1,
      firstOccurredAt: event.occurredAt,
    });
  }
  return [...byKey.values()]
    .sort((left, right) => left.firstOccurredAt.localeCompare(right.firstOccurredAt))
    .slice(0, SCHEDULED_TASK_RUN_ACCESS_FAILURES_MAX);
}

/**
 * Whose access view this viewer may see: the owner's (only for the owner
 * itself, as an entitled authenticated subject) or, for a task without an
 * owner, the workspace's (for people who manage schedules). Null otherwise.
 */
export function scheduledTaskAccessSource(
  task: Pick<ScheduledTask, "ownerSubjectId">,
  grant: AccessGrant,
): Exclude<PersonalConnectionDelegationSource, { kind: "turn" }> | null {
  if (task.ownerSubjectId === null) {
    return hasPermission(grant.permissions, "scheduled_tasks:manage") ? { kind: "none" } : null;
  }
  const source = personalConnectionDelegationSourceForGrant(grant);
  return source.kind === "subject" && source.subjectId === task.ownerSubjectId ? source : null;
}

/**
 * A signed-in person: the canonical managed cookie session (or a verified
 * external owning user) or the exact built-in local human. Provenance stamps,
 * never grant shape; API keys, services, delegated bearers and agent attempts
 * do not qualify.
 */
export function isScheduledTaskAccessRefreshHuman(
  authorization: AccessGrantAuthorization,
  workspaceId: string,
): boolean {
  const { grant } = authorization;
  if (grant.workspaceId !== workspaceId) return false;
  if (
    authorization.canonicalLocalHumanSession &&
    authorization.contextIntegrity &&
    authorization.authenticatedSubjectId === grant.subjectId &&
    grant.principalKind === "human_session" &&
    grant.metadata?.delegated !== true &&
    !grant.serviceInitiator
  )
    return true;
  return (
    hasVerifiedOwningUserAuthorization(authorization) &&
    personalConnectionDelegationSourceForGrant(grant).kind === "subject"
  );
}

function scheduledTaskToolsFollowTask(task: Pick<ScheduledTask, "runMode" | "reusableSessionId">) {
  return (
    task.runMode === "new_session_per_run" ||
    (task.runMode === "reusable_session" && task.reusableSessionId === null)
  );
}

function hasAgentAccess(task: Pick<ScheduledTask, "action" | "agentConfig">): boolean {
  return task.action.kind === "agent_turn" && scheduledTaskKnowledgeSource(task) === null;
}

export type ScheduledTaskAccessPlan = {
  drift: Omit<ScheduledTaskPolicyDrift, "canRefresh">;
  /** What each connector would act as if a run started now (see `planScheduledTaskAccounts`). */
  accounts: ScheduledTaskAccountPlan;
  /** Connectors with a pinned account the task no longer uses (see the pin plan). */
  droppedPins: ScheduledTaskAccessConnector[];
  tools: ToolRef[];
  creatorFirstPartyPolicy: ScheduledTaskOpenGeniToolPlan["policy"];
  changed: boolean;
};

/** Request-local reads shared by every task one viewer's list decorates. */
export type ScheduledTaskAccessReadCache = {
  registries: Map<string, Promise<Settings>>;
  connections: Map<string, Promise<ConnectionMetadata[]>>;
};

export function scheduledTaskAccessReadCache(): ScheduledTaskAccessReadCache {
  return { registries: new Map(), connections: new Map() };
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  let value = cache.get(key);
  if (!value) {
    value = read();
    cache.set(key, value);
  }
  return value;
}

function runtimeRegistry(
  db: Database,
  workspaceId: string,
  settings: Settings,
  subjectId: string | null,
  cache: ScheduledTaskAccessReadCache,
): Promise<Settings> {
  return cached(cache.registries, subjectId ?? "", () =>
    settingsWithEnabledCapabilityMcpServers(
      db,
      workspaceId,
      settings,
      subjectId ? { subjectId } : {},
    ),
  );
}

function registryNames(settings: Pick<Settings, "mcpServers">): Map<string, string> {
  return new Map(settings.mcpServers.map((server) => [server.id, server.name ?? server.id]));
}

/**
 * What saving `task` again would save for its owner now, and which of its
 * pinned accounts the owner can no longer use, read-only. The connector
 * registry used to judge availability is the calling person's, the same
 * registry the owner update path validates against.
 */
export async function computeScheduledTaskAccessPlan(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  task: ScheduledTask;
  source: Exclude<PersonalConnectionDelegationSource, { kind: "turn" }>;
  creatorPolicy: ScheduledTaskCreatorPolicy | null;
  permissionsRequiredByTools: FirstPartyToolPermissionRequirements;
  cache?: ScheduledTaskAccessReadCache;
  workspaceSettings?: unknown;
  /** Defaults the refreshing person chose to keep off; narrows what the plan adds. */
  leaveOut?: RefreshScheduledTaskAccessRequest["leaveOut"];
}): Promise<ScheduledTaskAccessPlan> {
  const { db, task, settings } = input;
  const cache = input.cache ?? scheduledTaskAccessReadCache();
  const ownerSubjectId = input.source.kind === "subject" ? input.source.subjectId : null;
  const [callerRegistry, ownerRegistry, workspaceSettings] = await Promise.all([
    runtimeRegistry(db, task.workspaceId, settings, input.grant.subjectId, cache),
    runtimeRegistry(db, task.workspaceId, settings, ownerSubjectId, cache),
    input.workspaceSettings !== undefined
      ? Promise.resolve(input.workspaceSettings)
      : requireWorkspace(db, task.workspaceId).then((workspace) => workspace.settings),
  ]);
  const followsTask = scheduledTaskToolsFollowTask(task);
  const target =
    task.runMode === "existing_session" && task.targetSessionId
      ? await getSession(db, task.workspaceId, task.targetSessionId)
      : null;
  const accountRegistry = target
    ? settingsWithSessionMcpServerMetadata(ownerRegistry, target.mcpServers)
    : ownerRegistry;
  const names = new Map([...registryNames(callerRegistry), ...registryNames(accountRegistry)]);
  const connectors = followsTask
    ? planScheduledTaskConnectors({
        taskTools: task.agentConfig.tools,
        defaultTools: withWorkspaceDefaultMcpTools(
          [],
          settings,
          ownerRegistry,
          resolveWorkspaceSessionToolDefaults(workspaceSettings),
        ),
        availableServerIds: new Set(callerRegistry.mcpServers.map((server) => server.id)),
        names,
        leaveOut: new Set(input.leaveOut?.connectors ?? []),
      })
    : { tools: [...task.agentConfig.tools], missing: [], unavailable: [] };
  const connectionTools = await scheduledConnectionTools(
    db,
    task.workspaceId,
    accountRegistry,
    target,
    connectors.tools,
    ownerSubjectId ?? undefined,
  );
  const connectionToolIds = new Set(connectionTools.map((tool) => tool.id));
  const connectionServerIds = accountRegistry.mcpServers
    .filter(
      (server) =>
        connectionToolIds.has(server.id) &&
        server.connectionRef &&
        server.connectionRef.authoritySource !== "host",
    )
    .map((server) => server.id);
  const source = input.source;
  const pins = task.agentConfig.pinnedAccounts ?? [];
  const availableBindings =
    connectionServerIds.length === 0
      ? []
      : await availableMcpAccountBindings({
          db,
          accountId: task.accountId,
          workspaceId: task.workspaceId,
          settings: accountRegistry,
          tools: connectionTools,
          source,
          connections: await cached(
            cache.connections,
            source.kind === "subject" ? `subject:${source.subjectId}` : "workspace",
            () =>
              visibleMcpAccountConnections(db, {
                accountId: task.accountId,
                workspaceId: task.workspaceId,
                source,
              }),
          ),
        });
  const accounts = planScheduledTaskPinnedAccounts({
    pins,
    connectionServerIds,
    availableBindings,
    names,
  });
  const openGeni = followsTask
    ? planScheduledTaskOpenGeniTools({
        creatorPolicy: input.creatorPolicy,
        settings,
        grantPermissions: input.grant.permissions,
        grantPermissionMode: input.grant.permissionMode,
        permissionsRequiredByTools: input.permissionsRequiredByTools,
        leaveOut: new Set(input.leaveOut?.openGeniTools ?? []),
      })
    : { missing: [], policy: null };
  const toolKey = (tool: ToolRef) =>
    `${tool.kind}:${tool.id}:${tool.optional === true}:${tool.eager === true}`;
  const toolsChanged = !sameMembers(
    connectors.tools.map(toolKey),
    task.agentConfig.tools.map(toolKey),
  );
  return {
    drift: {
      missingConnectors: connectors.missing,
      unavailableConnectors: connectors.unavailable,
      missingOpenGeniTools: openGeni.missing,
      unavailableAccounts: accounts.unavailable,
    },
    accounts: planScheduledTaskAccounts({
      connectionServerIds,
      pins,
      bindings: availableBindings,
      names,
    }),
    droppedPins: accounts.dropped,
    tools: connectors.tools,
    creatorFirstPartyPolicy: openGeni.policy,
    changed: toolsChanged || accounts.dropped.length > 0 || openGeni.policy !== null,
  };
}

export function scheduledTaskPolicyDriftHasChanges(
  drift: Omit<ScheduledTaskPolicyDrift, "canRefresh">,
): boolean {
  return (
    drift.missingConnectors.length > 0 ||
    drift.unavailableConnectors.length > 0 ||
    drift.missingOpenGeniTools.length > 0 ||
    drift.unavailableAccounts.length > 0
  );
}

/**
 * Attach `policyDrift` and `accountPlan` to each task this viewer can act on.
 * A viewer who cannot act on a task receives it unchanged, so nobody else sees
 * the owner's account labels. Both are advisory: a failure to compute them
 * never fails the read, it only omits the fields.
 */
export async function withScheduledTaskPolicyDrift(input: {
  db: Database;
  settings: Settings;
  authorization: AccessGrantAuthorization;
  tasks: ScheduledTask[];
  permissionsRequiredByTools: FirstPartyToolPermissionRequirements;
  onError?: (error: unknown) => void;
}): Promise<ScheduledTask[]> {
  const { grant } = input.authorization;
  const actionable = input.tasks.filter(
    (task) => hasAgentAccess(task) && scheduledTaskAccessSource(task, grant) !== null,
  );
  if (actionable.length === 0) return input.tasks;
  const workspaceId = grant.workspaceId;
  let creatorPolicies: Map<string, ScheduledTaskCreatorPolicy>;
  let workspaceSettings: unknown;
  try {
    [creatorPolicies, workspaceSettings] = await Promise.all([
      listScheduledTaskCreatorPolicies(
        input.db,
        workspaceId,
        actionable.map((task) => task.id),
      ),
      requireWorkspace(input.db, workspaceId).then((workspace) => workspace.settings),
    ]);
  } catch (error) {
    input.onError?.(error);
    return input.tasks;
  }
  const canRefresh =
    hasPermission(grant.permissions, "scheduled_tasks:manage") &&
    isScheduledTaskAccessRefreshHuman(input.authorization, workspaceId);
  const cache = scheduledTaskAccessReadCache();
  const decorations = new Map<
    string,
    { policyDrift: ScheduledTaskPolicyDrift | null; accountPlan: ScheduledTaskAccountPlan }
  >();
  for (const task of actionable) {
    try {
      const plan = await computeScheduledTaskAccessPlan({
        db: input.db,
        settings: input.settings,
        grant,
        task,
        source: scheduledTaskAccessSource(task, grant)!,
        creatorPolicy: creatorPolicies.get(task.id) ?? null,
        permissionsRequiredByTools: input.permissionsRequiredByTools,
        cache,
        workspaceSettings,
      });
      decorations.set(task.id, {
        policyDrift: scheduledTaskPolicyDriftHasChanges(plan.drift)
          ? { ...plan.drift, canRefresh }
          : null,
        accountPlan: plan.accounts,
      });
    } catch (error) {
      input.onError?.(error);
    }
  }
  return input.tasks.map((task) => {
    const decoration = decorations.get(task.id);
    return decoration ? { ...task, ...decoration } : task;
  });
}

/**
 * The owner's explicit access refresh: re-save the task's connectors and (for
 * an agent-created task) Opengeni tool policy with the calling person's
 * current authority. Connector accounts are not part of it: unpinned
 * connectors already follow the owner's current accounts, and pins change only
 * when a person edits them (a pin whose connector is dropped goes with it).
 * It is an ordinary owner edit whose
 * content the server computes, so the owner check, Variable Set permission,
 * model policy, target validation, personal-resource re-authorization and
 * execution-digest update all run exactly as for a manual edit.
 */
export async function refreshScheduledTaskAccess(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  authorization: AccessGrantAuthorization;
  taskId: string;
  request: RefreshScheduledTaskAccessRequest;
  permissionsRequiredByTools: FirstPartyToolPermissionRequirements;
  sessionAuthorization?: SessionAuthorizationPort | null | undefined;
  authorizationSurface?: SessionAuthorizationSurface | undefined;
}): Promise<ScheduledTask> {
  const { grant } = input.authorization;
  requirePermission(grant, "scheduled_tasks:manage");
  if (!isScheduledTaskAccessRefreshHuman(input.authorization, grant.workspaceId)) {
    throw new HTTPException(403, {
      message:
        "Only a signed-in person can refresh a schedule's access. API keys, services and agents cannot.",
    });
  }
  const existing = await requireVisibleScheduledTask(input.db, grant, input.taskId);
  if (!hasAgentAccess(existing)) {
    throw new HTTPException(422, {
      message: "This schedule has no connectors or tools to refresh.",
    });
  }
  if (existing.executionDigest !== input.request.executionDigest) {
    throw new HTTPException(409, {
      message: "This schedule changed. Reload it and review the refresh again.",
    });
  }
  await assertScheduledTaskMutationOwner(input.db, grant, existing.id);
  const source = scheduledTaskAccessSource(existing, grant);
  if (!source) {
    throw new HTTPException(403, {
      message: "Only the schedule owner can refresh its access.",
    });
  }
  const creatorPolicy =
    (await listScheduledTaskCreatorPolicies(input.db, grant.workspaceId, [existing.id])).get(
      existing.id,
    ) ?? null;
  const plan = await computeScheduledTaskAccessPlan({
    db: input.db,
    settings: input.settings,
    grant,
    task: existing,
    source,
    creatorPolicy,
    permissionsRequiredByTools: input.permissionsRequiredByTools,
    leaveOut: input.request.leaveOut,
  });
  if (!plan.changed) return existing;
  const {
    pinnedAccounts: _pinnedAccounts,
    pinnedAccountsRequired: _pinnedAccountsRequired,
    ...agentConfig
  } = existing.agentConfig;
  const update = await validatedScheduledTaskUpdate({
    settings: input.settings,
    db: input.db,
    objectStorage: input.objectStorage,
    grant,
    authorization: input.authorization,
    existing,
    payload: { agentConfig: { ...agentConfig, tools: plan.tools } },
    toolsProvided: true,
    sessionAuthorization: input.sessionAuthorization,
    authorizationSurface: input.authorizationSurface,
  });
  update.expectedExecutionDigest = existing.executionDigest;
  if (plan.creatorFirstPartyPolicy) {
    if (plan.creatorFirstPartyPolicy.firstPartyMcpPermissions.length === 0) {
      throw new HTTPException(403, {
        message:
          "You hold none of the permissions this schedule's Opengeni tools need, so it cannot be refreshed with your access.",
      });
    }
    update.creatorFirstPartyPolicy = plan.creatorFirstPartyPolicy;
  }
  try {
    return await updateScheduledTaskForApi(input.db, grant, existing.id, update);
  } catch (error) {
    if (error instanceof ScheduledTaskHeadChangedError) {
      throw new HTTPException(409, {
        message: "This schedule changed. Reload it and review the refresh again.",
      });
    }
    throw error;
  }
}

async function connectorNames(
  db: Database,
  settings: Settings,
  workspaceId: string,
  subjectId: string,
): Promise<Map<string, string>> {
  try {
    return registryNames(
      await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings, { subjectId }),
    );
  } catch {
    return registryNames(settings);
  }
}

/** Attach `accessFailures` to runs of a task this viewer can act on. */
export async function withScheduledTaskRunAccessFailures<T extends ScheduledTaskRun>(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  task: ScheduledTask;
  runs: T[];
}): Promise<T[]> {
  if (
    input.runs.length === 0 ||
    !hasAgentAccess(input.task) ||
    scheduledTaskAccessSource(input.task, input.grant) === null
  ) {
    return input.runs;
  }
  const events = await listScheduledTaskRunAuthNeededEvents(
    input.db,
    input.grant.workspaceId,
    input.runs.map((run) => run.id),
  );
  const byRun = new Map<string, typeof events>();
  for (const event of events) {
    byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
  }
  const names =
    events.length > 0
      ? await connectorNames(
          input.db,
          input.settings,
          input.grant.workspaceId,
          input.grant.subjectId,
        )
      : new Map<string, string>();
  return input.runs.map((run) => ({
    ...run,
    accessFailures: scheduledTaskRunAccessFailures(byRun.get(run.id) ?? [], names),
  }));
}

const MACHINE_PRINCIPALS: ReadonlySet<string> = new Set(["api_key", "configured_key", "service"]);

/**
 * The in-app notice: schedules whose latest run failed closed on connector
 * access and that no later run has cleared. A person is told about the
 * schedules they own. A task without an owner has nobody to notify, so it is
 * listed only for an organization key, configured key or service that manages
 * schedules (the callers that create such tasks), never for every member.
 */
export function scheduledTaskAttentionScope(
  grant: AccessGrant,
): { ownerSubjectId: string | null; includeOwnerless: boolean } | null {
  const source = personalConnectionDelegationSourceForGrant(grant);
  const includeOwnerless =
    MACHINE_PRINCIPALS.has(grant.principalKind ?? "") &&
    hasPermission(grant.permissions, "scheduled_tasks:manage");
  const ownerSubjectId = source.kind === "subject" ? source.subjectId : null;
  if (ownerSubjectId === null && !includeOwnerless) return null;
  return { ownerSubjectId, includeOwnerless };
}

/**
 * Tasks among `tasks` with a person-pinned connector account that can no
 * longer be used: the pin plan's `unavailableAccounts`, exactly what the
 * drift reports, plus pins whose connector the workspace stopped setting up.
 * A fresh occurrence runs without those connectors (or is
 * skipped when the task requires its pinned accounts). Only the pin part of
 * the plan is read, which does not depend on the creator policy. Advisory: a
 * task whose plan cannot be computed is skipped.
 */
export async function scheduledTasksWithUnavailableAccounts(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  tasks: readonly ScheduledTask[];
  onError?: ((error: unknown) => void) | undefined;
}): Promise<Array<{ task: ScheduledTask; unavailableAccounts: ScheduledTaskAccessConnector[] }>> {
  const actionable = input.tasks.filter(
    (task) =>
      task.status === "active" &&
      hasAgentAccess(task) &&
      (task.agentConfig.pinnedAccounts?.length ?? 0) > 0 &&
      scheduledTaskAccessSource(task, input.grant) !== null,
  );
  if (actionable.length === 0) return [];
  let workspaceSettings: unknown;
  try {
    workspaceSettings = (await requireWorkspace(input.db, input.grant.workspaceId)).settings;
  } catch (error) {
    input.onError?.(error);
    return [];
  }
  const cache = scheduledTaskAccessReadCache();
  const blocked: Array<{
    task: ScheduledTask;
    unavailableAccounts: ScheduledTaskAccessConnector[];
  }> = [];
  for (const task of actionable) {
    try {
      const plan = await computeScheduledTaskAccessPlan({
        db: input.db,
        settings: input.settings,
        grant: input.grant,
        task,
        source: scheduledTaskAccessSource(task, input.grant)!,
        creatorPolicy: null,
        permissionsRequiredByTools: () => [],
        cache,
        workspaceSettings,
      });
      // A pin whose connector is no longer set up is also one the run goes without.
      const unavailableAccounts = uniqueById([
        ...plan.drift.unavailableAccounts,
        ...plan.droppedPins,
      ]);
      if (unavailableAccounts.length > 0) blocked.push({ task, unavailableAccounts });
    } catch (error) {
      input.onError?.(error);
    }
  }
  return blocked;
}

/**
 * The owner's in-app notice: schedules whose latest run failed closed on
 * connector access and that no later run has cleared, plus schedules with a
 * pinned account that can no longer be used (their runs go without that
 * connector), named by connector. Tasks needing both appear once.
 */
export async function listScheduledTaskAccessAttention(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  onError?: ((error: unknown) => void) | undefined;
}): Promise<ScheduledTaskAccessAttention[]> {
  const { grant } = input;
  const scope = scheduledTaskAttentionScope(grant);
  if (!scope) return [];
  const query = {
    // A caller without an entitled subject matches no owner: owners are people.
    subjectId: scope.ownerSubjectId ?? "",
    includeOwnerless: scope.includeOwnerless,
  };
  const [events, candidates, humanWaits] = await Promise.all([
    listScheduledTaskAccessAttentionEvents(input.db, grant.workspaceId, {
      ...query,
      taskLimit: SCHEDULED_TASK_ACCESS_ATTENTION_MAX,
    }),
    listActiveScheduledTasksWithPinnedAccounts(input.db, grant.workspaceId, {
      ...query,
      limit: SCHEDULED_TASK_ACCESS_ATTENTION_MAX,
    }),
    listScheduledTaskHumanWaitAttention(input.db, grant.workspaceId, {
      ...query,
      taskLimit: SCHEDULED_TASK_ACCESS_ATTENTION_MAX,
    }),
  ]);
  const blocked = await scheduledTasksWithUnavailableAccounts({
    db: input.db,
    settings: input.settings,
    grant,
    tasks: candidates,
    onError: input.onError,
  });
  if (events.length === 0 && blocked.length === 0 && humanWaits.length === 0) return [];
  const names =
    events.length > 0
      ? await connectorNames(input.db, input.settings, grant.workspaceId, grant.subjectId)
      : new Map<string, string>();
  const runs = new Map<
    string,
    {
      taskName: string;
      executionDigest: string;
      runId: string;
      firedAt: string;
      events: typeof events;
    }
  >();
  for (const event of events) {
    const task = runs.get(event.taskId) ?? {
      taskName: event.taskName,
      executionDigest: event.taskExecutionDigest,
      runId: event.runId,
      firedAt: event.firedAt,
      events: [],
    };
    task.events.push(event);
    runs.set(event.taskId, task);
  }
  const attention = new Map<string, ScheduledTaskAccessAttention>();
  for (const [taskId, task] of runs) {
    const failures = scheduledTaskRunAccessFailures(task.events, names);
    if (failures.length === 0) continue;
    attention.set(taskId, {
      taskId,
      taskName: task.taskName,
      executionDigest: task.executionDigest,
      runId: task.runId,
      firedAt: task.firedAt,
      failures,
      unavailableAccounts: [],
      awaitingHuman: null,
    });
  }
  for (const { task, unavailableAccounts } of blocked) {
    const prior = attention.get(task.id);
    attention.set(
      task.id,
      prior
        ? { ...prior, executionDigest: task.executionDigest, unavailableAccounts }
        : {
            taskId: task.id,
            taskName: task.name,
            executionDigest: task.executionDigest,
            runId: null,
            firedAt: null,
            failures: [],
            unavailableAccounts,
            awaitingHuman: null,
          },
    );
  }
  // A latest run waiting on a person needs its owner (or, for an ownerless
  // schedule, whoever manages schedules) to answer before it can finish.
  for (const wait of humanWaits) {
    const awaitingHuman = { since: wait.since, expiresAt: wait.expiresAt };
    const prior = attention.get(wait.taskId);
    attention.set(
      wait.taskId,
      prior
        ? {
            ...prior,
            ...(prior.runId === null || prior.runId === wait.runId
              ? { runId: wait.runId, firedAt: wait.firedAt }
              : {}),
            awaitingHuman,
          }
        : {
            taskId: wait.taskId,
            taskName: wait.taskName,
            executionDigest: wait.taskExecutionDigest,
            runId: wait.runId,
            firedAt: wait.firedAt,
            failures: [],
            unavailableAccounts: [],
            awaitingHuman,
          },
    );
  }
  return orderScheduledTaskAccessAttention([...attention.values()]).slice(
    0,
    SCHEDULED_TASK_ACCESS_ATTENTION_MAX,
  );
}

/**
 * Schedules with an unusable pinned account come first, then the most recent
 * failed runs. Ties keep a stable order by task id.
 */
export function orderScheduledTaskAccessAttention(
  items: readonly ScheduledTaskAccessAttention[],
): ScheduledTaskAccessAttention[] {
  return [...items].sort((left, right) => {
    const blocked =
      Number(right.unavailableAccounts.length > 0) - Number(left.unavailableAccounts.length > 0);
    if (blocked !== 0) return blocked;
    const fired = (right.firedAt ?? "").localeCompare(left.firedAt ?? "");
    return fired !== 0 ? fired : left.taskId.localeCompare(right.taskId);
  });
}
