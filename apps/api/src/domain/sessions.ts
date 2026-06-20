import { configuredAllowedModels, type Settings } from "@opengeni/config";
import {
  CreateSessionRequest,
  reasoningEffortForMetadata,
  type AccessGrant,
  type GoalSpec,
  type Permission,
  type ReasoningEffort,
  type ResourceRef,
  type Session,
  type SessionEvent,
  type SessionTurn,
  type ToolRef,
} from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  createSession,
  createSessionGoal,
  createSessionWithIdempotencyKey,
  enqueueSessionTurn,
  getSessionByCreateIdempotencyKey,
  getSessionTurn,
  requireSession,
  setTemporalWorkflowId,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type { ApiRouteDeps, SessionWorkflowClient } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { validateEnvironmentAttachment } from "./environments";
import {
  mergeResourceRefs,
  mergeToolRefs,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "./resources";

export async function createAndStartSession(input: {
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  accountId: string;
  workspaceId: string;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  clientEventId?: string;
  model: string;
  reasoningEffort: Settings["openaiReasoningEffort"];
  sandboxBackend: Settings["sandboxBackend"];
  metadata: Record<string, unknown>;
  // Names/ids only; the session.created payload never carries variable values.
  environment?: { id: string; name: string } | null;
  goal?: GoalSpec | null;
  // Validated against the creating grant before this is called.
  firstPartyMcpPermissions?: Permission[] | null;
  // The manager session spawning this worker (a worker-signed sessionId claim
  // on the creating grant); null for direct API creates and scheduled runs.
  // When set, the worker's terminal-for-now transitions wake this parent.
  parentSessionId?: string | null;
  // Workspace-scoped CREATE idempotency key. When present, a double-fire with
  // the same key (sequential retry OR concurrent race) collapses to a single
  // session: a prior winner is returned as-is and the start flow below is
  // skipped, so the dup never re-emits events / re-enqueues a turn.
  createIdempotencyKey?: string | null;
}) {
  const sessionMetadata = {
    ...input.metadata,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };
  // Fast path with a key: return a session already created under this key
  // (the sequential retry / double-submit case) without inserting again.
  if (input.createIdempotencyKey) {
    const existing = await getSessionByCreateIdempotencyKey(input.db, input.workspaceId, input.createIdempotencyKey);
    if (existing) {
      return existing;
    }
    // No prior session: insert under the key, racing concurrent creates. The
    // partial unique index lets exactly one insert win; a loser gets back the
    // winner's row with created=false and must NOT run the start flow (the
    // winner owns the events/turn/workflow), so we return it as-is.
    const { session: keyed, created } = await createSessionWithIdempotencyKey(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools,
      metadata: sessionMetadata,
      model: input.model,
      sandboxBackend: input.sandboxBackend,
      environmentId: input.environment?.id ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      parentSessionId: input.parentSessionId ?? null,
      createIdempotencyKey: input.createIdempotencyKey,
    });
    if (!created) {
      return keyed;
    }
    return await finishStartSession(input, keyed);
  }
  const session = await createSession(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.initialMessage,
    resources: input.resources,
    tools: input.tools,
    metadata: sessionMetadata,
    model: input.model,
    sandboxBackend: input.sandboxBackend,
    environmentId: input.environment?.id ?? null,
    firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
    parentSessionId: input.parentSessionId ?? null,
  });
  return await finishStartSession(input, session);
}

/**
 * The post-insert half of {@link createAndStartSession}: durable goal row,
 * the initial event batch (session.created / goal.set / user.message /
 * status.changed), turn enqueue, and the workflow wake. Split out so the
 * idempotency-key winner and the key-less create share one body, and the
 * idempotency-key loser/dup can skip it entirely.
 */
async function finishStartSession(input: {
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  initialMessage: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  clientEventId?: string;
  model: string;
  reasoningEffort: Settings["openaiReasoningEffort"];
  sandboxBackend: Settings["sandboxBackend"];
  environment?: { id: string; name: string } | null;
  goal?: GoalSpec | null;
}, session: Session): Promise<Session> {
  // The goal row is durable session state; the workflow picks it up from the
  // database once the first turn completes — no extra workflow plumbing here.
  const goal = input.goal
    ? await createSessionGoal(input.db, {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      text: input.goal.text,
      successCriteria: input.goal.successCriteria ?? null,
      maxAutoContinuations: input.goal.maxAutoContinuations ?? null,
      createdBy: "api",
    })
    : null;
  const initialPayload = {
    text: input.initialMessage,
    ...(input.resources.length ? { resources: input.resources } : {}),
    ...(input.tools.length ? { tools: input.tools } : {}),
  };
  const events = await appendAndPublishEvents(input.db, input.bus, session.workspaceId, session.id, [
    {
      type: "session.created",
      payload: {
        status: "queued",
        ...(input.environment ? { environmentId: input.environment.id, environmentName: input.environment.name } : {}),
      },
    },
    ...(goal ? [{
      type: "goal.set" as const,
      payload: {
        goalId: goal.id,
        text: goal.text,
        ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
        version: goal.version,
        actor: "api",
        replaced: false,
      },
    }] : []),
    {
      type: "user.message",
      payload: initialPayload,
      ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    },
    { type: "session.status.changed", payload: { status: "queued" } },
  ]);
  const userEvent = events.find((event) => event.type === "user.message");
  if (!userEvent) {
    throw new HTTPException(500, { message: "failed to append initial user event" });
  }
  const workflowId = workflowIdForSession(session.id);
  await setTemporalWorkflowId(input.db, session.workspaceId, session.id, workflowId);
  const turn = await enqueueSessionTurn(input.db, {
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    triggerEventId: userEvent.id,
    temporalWorkflowId: workflowId,
    source: "user",
    prompt: input.initialMessage,
    resources: input.resources,
    tools: input.tools,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    sandboxBackend: input.sandboxBackend,
    metadata: {},
  });
  await appendAndPublishEvents(input.db, input.bus, session.workspaceId, session.id, [{
    type: "turn.queued",
    turnId: turn.id,
    payload: { turnId: turn.id, triggerEventId: userEvent.id, source: turn.source },
  }]);
  await input.workflowClient.wakeSessionWorkflow({ accountId: session.accountId, workspaceId: session.workspaceId, sessionId: session.id, workflowId });
  return await requireSession(input.db, session.workspaceId, session.id);
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

/**
 * Reject an explicit model that the host does not expose. The set of usable
 * models is the union surfaced by `configuredAllowedModels` (the built-in
 * provider's allow-list plus every registry provider's ids); a `model` outside
 * it cannot be resolved to a provider at run time, so we fail the request at
 * the API edge with 422 rather than enqueuing a turn the worker can't honor.
 *
 * `model` is the explicit, caller-supplied value (null/undefined when omitted).
 * An omitted model defaults to `settings.openaiModel` downstream — which is
 * always first in `configuredAllowedModels` — so only an explicit value is
 * checked. Centralized here so the three model-carrying choke points
 * (create-session, user-message/turn-accept, queued-turn update) and the MCP
 * surfaces that share them validate identically and cannot drift.
 */
export function assertConfiguredModel(settings: Settings, model: string | null | undefined): void {
  if (model === null || model === undefined) {
    return;
  }
  if (!configuredAllowedModels(settings).includes(model)) {
    throw new HTTPException(422, { message: `model is not available: ${model}` });
  }
}

export async function requireQueuedTurnForApi(db: Database, workspaceId: string, sessionId: string, turnId: string): Promise<SessionTurn> {
  const turn = await getSessionTurn(db, workspaceId, turnId);
  if (!turn || turn.sessionId !== sessionId) {
    throw new HTTPException(404, { message: "session turn not found" });
  }
  if (turn.status !== "queued") {
    throw new HTTPException(409, { message: `turn is ${turn.status}; only queued turns can be changed` });
  }
  return turn;
}

export function reasoningEffortForSession(metadata: Record<string, unknown>, fallback: Settings["openaiReasoningEffort"]): Settings["openaiReasoningEffort"] {
  return reasoningEffortForMetadata(metadata, fallback);
}

/**
 * Appends a `user.message` to an existing session and enqueues the resulting
 * turn, merging requested resources/tools into the session and waking the
 * workflow. Shared by the public events route and the first-party MCP
 * `session_send_message` tool so the two surfaces cannot drift. Callers own
 * resource/tool validation and the per-message usage limit before calling.
 */
export async function postUserMessageTurn(input: {
  db: Database;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  text: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model?: string | null;
  reasoningEffort?: Settings["openaiReasoningEffort"] | null;
  clientEventId?: string;
}): Promise<{ accepted: SessionEvent; turn: SessionTurn }> {
  const { db, bus, workflowClient, settings, accountId, workspaceId, sessionId } = input;
  const requestedModel = input.model ?? null;
  const requestedReasoningEffort = input.reasoningEffort ?? null;
  // Reject an explicit per-message model the host does not expose; an omitted
  // model inherits the session's model downstream (always a configured id).
  assertConfiguredModel(settings, requestedModel);
  const appended = await appendSessionEventsWithLockedSessionUpdate(db, workspaceId, sessionId, (lockedSession) => {
    // Cancelled is the one terminal state: an explicit user act. A FAILED
    // session stays revivable by talking to it — conversation truth lives in
    // session_history_items, so a failed turn does not invalidate history,
    // and the manager channel of record must always answer when spoken to.
    // The new message transitions failed -> queued (clearing the stale
    // activeTurnId) and the signalWithStart below starts a fresh workflow
    // run for the completed (failed) one, exactly as for idle sessions.
    if (lockedSession.status === "cancelled") {
      throw new HTTPException(409, { message: `session is ${lockedSession.status}; cannot accept a new user message` });
    }
    const nextResources = mergeResourceRefs(lockedSession.resources, input.resources);
    const nextTools = mergeToolRefs(lockedSession.tools, input.tools);
    const shouldQueueSession = lockedSession.status === "idle" || lockedSession.status === "failed";
    return {
      events: [
        {
          type: "user.message",
          payload: {
            text: input.text,
            ...(input.resources.length ? { resources: input.resources } : {}),
            ...(input.tools.length ? { tools: input.tools } : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
          },
          ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
        },
        ...(shouldQueueSession ? [{ type: "session.status.changed" as const, payload: { status: "queued" } }] : []),
      ],
      update: {
        resources: nextResources,
        tools: nextTools,
        ...(shouldQueueSession ? { status: "queued" as const, activeTurnId: null } : {}),
      },
    };
  }).then(async (events) => {
    await bus.publish(workspaceId, sessionId, events);
    return events;
  });
  const accepted = appended[0];
  if (!accepted) {
    throw new HTTPException(500, { message: "failed to append client event" });
  }
  const workflowId = workflowIdForSession(sessionId);
  const session = await requireSession(db, workspaceId, sessionId);
  const turn = await enqueueSessionTurn(db, {
    accountId,
    workspaceId,
    sessionId,
    triggerEventId: accepted.id,
    temporalWorkflowId: workflowId,
    source: "user",
    prompt: input.text,
    resources: input.resources,
    tools: input.tools,
    model: requestedModel ?? session.model,
    reasoningEffort: requestedReasoningEffort ?? reasoningEffortForSession(session.metadata, settings.openaiReasoningEffort),
    sandboxBackend: session.sandboxBackend,
    metadata: {},
  });
  await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
    type: "turn.queued",
    turnId: turn.id,
    payload: { turnId: turn.id, triggerEventId: accepted.id, source: turn.source },
  }]);
  await workflowClient.wakeSessionWorkflow({ accountId, workspaceId, sessionId, workflowId });
  return { accepted, turn };
}

/**
 * Full create-session flow shared by `POST /sessions` and the first-party MCP
 * `session_create` tool: payload validation, resource/tool/environment
 * checks, usage limits, session start, and usage recording. `rawPayload` is
 * the unparsed request body so absent-vs-empty `tools` keeps its meaning
 * (absent applies the workspace's default capability MCP tools).
 */
export async function createSessionForRequest(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  rawPayload: unknown,
): Promise<Session> {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const payload = CreateSessionRequest.parse(rawPayload);
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
  const resources = normalizeResources(payload.resources);
  const requestedTools = validateToolRefs(payload.tools, runtimeSettings);
  const defaultedTools = hasOwnProperty(rawPayload, "tools")
    ? requestedTools
    : withDefaultEnabledCapabilityMcpTools(requestedTools, settings, runtimeSettings);
  // Goal-bearing sessions force the first-party MCP server so the goal
  // tools the continuation prompt references are reachable.
  const tools = payload.goal ? withFirstPartyGoalTools(defaultedTools, runtimeSettings) : defaultedTools;
  await validateGitHubRepositorySelection(db, workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(db, workspaceId, resources);
  // Environment attachment requires environments:use on the calling grant
  // (validateEnvironmentAttachment enforces it), preserving the invariant
  // that sandboxed agents cannot self-attach workspace secrets.
  const environment = payload.environmentId
    ? await validateEnvironmentAttachment({ settings, db }, grant, workspaceId, payload.environmentId)
    : null;
  assertConfiguredModel(settings, payload.model);
  const model = payload.model ?? settings.openaiModel;
  const reasoningEffort = payload.reasoningEffort ?? settings.openaiReasoningEffort;
  // A session's first-party MCP token can carry a non-default permission set
  // (how an operator hands a manager-style session the orchestration tools),
  // but never one out-ranking its creator: every requested permission must be
  // held by the creating grant.
  let firstPartyMcpPermissions = payload.firstPartyMcpPermissions ?? null;
  if (firstPartyMcpPermissions && firstPartyMcpPermissions.length === 0) {
    // An empty set would sign an unusable zero-permission token; the default
    // worker set is expressed by omitting the field.
    throw new HTTPException(422, { message: "firstPartyMcpPermissions must not be empty; omit it for the default worker permission set" });
  }
  for (const permission of firstPartyMcpPermissions ?? []) {
    if (!hasPermission(grant.permissions, permission)) {
      throw new HTTPException(403, { message: `cannot grant first-party MCP permission beyond the creating grant: ${permission}` });
    }
  }
  // Invariant: a goal-bearing session always carries goals:manage in its
  // effective first-party permissions. Without it the worker's delegated
  // token never sees the goal tools (goal_complete/goal_pause/...), so the
  // agent cannot stop its own goal and the continuation loop runs until an
  // operator intervenes. The auto-added permission is deliberately exempt
  // from the creating-grant check above: goal tools are scoped to the
  // spawned session itself via the worker-signed sessionId claim, so a
  // worker managing its OWN goal is not an escalation of the spawner's
  // authority.
  if (payload.goal && firstPartyMcpPermissions && !firstPartyMcpPermissions.includes("goals:manage")) {
    firstPartyMcpPermissions = [...firstPartyMcpPermissions, "goals:manage"];
  }
  // Parent linkage: a worker is linked to its manager ONLY from the
  // worker-signed sessionId claim on the creating grant — the manager
  // session's own id, signed into the delegated token by the worker and never
  // agent- or caller-controlled. A grant without that claim (a workspace API
  // key, any non-delegated grant) creates a parentless top-level session.
  //
  // We deliberately do NOT honor a caller-supplied parentSessionId: it would
  // let any sessions:create grant aim a worker at an arbitrary session's id so
  // its completion wake injects a user.message + queued turn into that session
  // without holding sessions:control on it (a cross-session write escalation).
  // The claim is the only trustworthy parent source.
  const parentSessionId = typeof grant.metadata?.["sessionId"] === "string" ? grant.metadata["sessionId"] as string : null;
  await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1 });
  const session = await createAndStartSession({
    db,
    bus,
    workflowClient,
    accountId: grant.accountId,
    workspaceId,
    initialMessage: payload.initialMessage,
    resources,
    tools,
    ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
    model,
    reasoningEffort,
    sandboxBackend: payload.sandboxBackend ?? settings.sandboxBackend,
    metadata: payload.metadata,
    environment: environment ? { id: environment.id, name: environment.name } : null,
    goal: payload.goal ?? null,
    firstPartyMcpPermissions,
    parentSessionId,
    createIdempotencyKey: payload.idempotencyKey ?? null,
  });
  await recordWorkspaceUsage(deps, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    eventType: "agent_run.created",
    quantity: 1,
    unit: "run",
    sourceResourceType: "session",
    sourceResourceId: session.id,
    idempotencyKey: `agent_run.created:${workspaceId}:${session.id}`,
  });
  return session;
}

/**
 * Full accept-user-message flow shared by the `user.message` branch of
 * `POST /sessions/:id/events` and the first-party MCP `session_send_message`
 * tool: resource/tool validation, usage limits, the locked append + turn
 * enqueue, and usage recording. `toolsProvided: false` applies the
 * workspace's default capability MCP tools, matching an absent `tools` key.
 */
export async function acceptSessionUserMessage(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  sessionId: string,
  input: {
    text: string;
    resources?: ResourceRef[];
    tools?: ToolRef[];
    toolsProvided: boolean;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    clientEventId?: string;
  },
): Promise<{ accepted: SessionEvent; turn: SessionTurn }> {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
  const requestedResources = normalizeResources(input.resources ?? []);
  const validatedTools = validateToolRefs(input.tools ?? [], runtimeSettings);
  const requestedTools = input.toolsProvided
    ? validatedTools
    : withDefaultEnabledCapabilityMcpTools(validatedTools, settings, runtimeSettings);
  await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1 });
  if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(db, workspaceId, requestedResources);
  const existingSession = await requireSession(db, workspaceId, sessionId);
  await validateGitHubRepositorySelection(db, workspaceId, [...existingSession.resources, ...requestedResources]);
  const { accepted, turn } = await postUserMessageTurn({
    db,
    bus,
    workflowClient,
    settings,
    accountId: grant.accountId,
    workspaceId,
    sessionId,
    text: input.text,
    resources: requestedResources,
    tools: requestedTools,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
  });
  await recordWorkspaceUsage(deps, {
    accountId: grant.accountId,
    workspaceId,
    subjectId: grant.subjectId,
    eventType: "agent_run.created",
    quantity: 1,
    unit: "run",
    sourceResourceType: "session_turn",
    sourceResourceId: turn.id,
    idempotencyKey: `agent_run.created:${workspaceId}:${turn.id}`,
  });
  return { accepted, turn };
}

function withFirstPartyGoalTools(tools: ToolRef[], runtimeSettings: { mcpServers: Array<{ id: string }> }): ToolRef[] {
  if (!runtimeSettings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}
