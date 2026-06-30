import { CODEX_MODEL_ID_PREFIX } from "@opengeni/codex";
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
  getAnySessionInGroup,
  getSession,
  getSessionByCreateIdempotencyKey,
  getSessionTurn,
  requireSession,
  setTemporalWorkflowId,
  updateSessionTitle as updateSessionTitleRow,
  type Database,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { hasPermission } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type { ApiRouteDeps, SessionWorkflowClient } from "../dependencies";
import { swapActiveSandbox, type FleetContext } from "../sandbox/fleet";
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
  // The shared-sandbox group this session's box joins (addendum 05 §D). Null/
  // omitted ⇒ a singleton group (the new row's own id, today's 1:1 behavior); a
  // shared/{groupId} spawn passes the resolved group so both run in ONE box.
  sandboxGroupId?: string | null;
  // Create-time machine targeting (A-2a, RACE-FREE): the enrolled machine (a
  // sandbox id) to run this session on. When set, the active-sandbox pointer is
  // resolved+validated+seeded (epoch-fenced) INSIDE finishStartSession, AFTER the
  // session row exists but BEFORE the first turn is enqueued/the workflow woken,
  // so the FIRST turn routes to the chosen machine. An invalid/unowned/offline
  // target fails the create (422) — never a silent fall-back to the default box.
  seedTargetSandbox?: { sandboxId: string; settings: Settings } | null;
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
      sandboxGroupId: input.sandboxGroupId ?? null,
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
    sandboxGroupId: input.sandboxGroupId ?? null,
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
  seedTargetSandbox?: { sandboxId: string; settings: Settings } | null;
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
  // Create-time machine targeting (A-2a): seed the active-sandbox pointer BEFORE
  // the first turn is enqueued + the workflow woken, so the FIRST turn routes to
  // the chosen machine. Race-free: the epoch-fenced setActiveSandbox commits here,
  // before wakeSessionWorkflow below signals the worker. swapActiveSandbox does
  // the same ownership+liveness validation as the live swap; an invalid/unowned/
  // offline target FAILS the create (422) — never a silent fall-back to the box.
  if (input.seedTargetSandbox) {
    if (session.sandboxBackend === "none") {
      throw new HTTPException(422, {
        message: "cannot target a machine for a session with no sandbox (backend: none)",
      });
    }
    const ctx: FleetContext = {
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      sessionBackend: session.sandboxBackend,
      sessionGroupId: session.sandboxGroupId,
    };
    const seeded = await swapActiveSandbox(
      { db: input.db, settings: input.seedTargetSandbox.settings, bus: input.bus },
      ctx,
      input.seedTargetSandbox.sandboxId,
    );
    if (!seeded.swapped) {
      throw new HTTPException(422, {
        message: `cannot target sandbox ${input.seedTargetSandbox.sandboxId}: ${seeded.reason ?? "target is not attachable"}`,
      });
    }
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
 * checked. Centralized here so every model-carrying choke point
 * (create-session, user-message/turn-accept, queued-turn update, and
 * scheduled-task agentConfig — a scheduled task is a session the worker runs
 * later) and the MCP surfaces that share them validate identically and cannot
 * drift.
 */
export function assertConfiguredModel(settings: Settings, model: string | null | undefined): void {
  if (model === null || model === undefined) {
    return;
  }
  if (configuredAllowedModels(settings).includes(model)) {
    return;
  }
  // Codex subscription models (codex/<slug>) are injected per-workspace by the
  // worker overlay at turn time, so they are never in the deployment-global
  // allow-list. Accept them at the edge when the feature is enabled — the picker
  // only surfaces them for a connected workspace, and the worker enforces the
  // actual connection (an unconnected workspace fails the turn with a clear
  // "no Codex subscription connected" error rather than a misleading 422 here).
  if (settings.codexSubscriptionEnabled && model.startsWith(CODEX_MODEL_ID_PREFIX)) {
    return;
  }
  throw new HTTPException(422, { message: `model is not available: ${model}` });
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
  // The first-party MCP server is attached to EVERY session. It hosts the
  // session's own metadata tool (set_session_title) + goal tools, and — only
  // when the grant carries the permission — the orchestration/environment/
  // github tools. Capability is gated per-tool by permission, never by whether
  // the server is attached, so a bare chat still gets titling while the
  // dangerous tools stay off by default.
  const tools = withFirstPartyTools(defaultedTools, runtimeSettings);
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
  // Shared-sandbox placement (addendum 05 §D.2/§D.3, decision I10/OD-S1).
  //
  // The DEFAULT rule is context-dependent and resolved server-side from the
  // TRUSTED claim, never caller-supplied: when `sandbox` is omitted, a session
  // spawned FROM INSIDE a session (parentSessionId present ⇒ a worker-signed
  // sessionId claim) defaults to "shared" (join the creator's box); a top-level
  // create (no parent) defaults to "new" (a private singleton box). Explicit
  // values always win.
  //
  // null sandboxGroupId ⇒ createSession seeds the new row's own id (singleton,
  // today's 1:1 behavior). A shared/{groupId} spawn inherits the box's backend
  // (it is literally the same box; the child cannot pick its own). Cross-
  // workspace sharing is forbidden by construction: getSession/
  // getAnySessionInGroup are RLS-workspace-scoped, so a foreign parent/group
  // returns null → 404; the group uuid is NOT an access boundary, the workspace
  // filter is (stress (e)).
  const sandboxChoice = payload.sandbox ?? (parentSessionId ? "shared" : "new");
  let sandboxGroupId: string | null = null;
  let inheritedBackend: Session["sandboxBackend"] | undefined;
  if (sandboxChoice === "shared") {
    if (!parentSessionId) {
      throw new HTTPException(422, { message: "sandbox:'shared' requires a parent session (spawn from inside a session); use 'new' for a top-level create." });
    }
    const parent = await getSession(db, workspaceId, parentSessionId);
    if (!parent) {
      throw new HTTPException(404, { message: `parent session not found in workspace: ${parentSessionId}` });
    }
    sandboxGroupId = parent.sandboxGroupId;
    inheritedBackend = parent.sandboxBackend;
  } else if (typeof sandboxChoice === "object") {
    const member = await getAnySessionInGroup(db, workspaceId, sandboxChoice.groupId);
    if (!member) {
      throw new HTTPException(404, { message: `sandbox group not found in workspace: ${sandboxChoice.groupId}` });
    }
    sandboxGroupId = sandboxChoice.groupId;
    inheritedBackend = member.sandboxBackend;
  }
  // else "new": leave sandboxGroupId null → own singleton group (group ≡ id).
  await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1, model });
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
    // A shared spawn inherits the box's backend; a caller-supplied
    // sandboxBackend on a shared spawn is ignored (it is the same box).
    sandboxBackend: inheritedBackend ?? payload.sandboxBackend ?? settings.sandboxBackend,
    sandboxGroupId,
    metadata: payload.metadata,
    environment: environment ? { id: environment.id, name: environment.name } : null,
    goal: payload.goal ?? null,
    firstPartyMcpPermissions,
    parentSessionId,
    createIdempotencyKey: payload.idempotencyKey ?? null,
    // Create-time machine targeting (A-2a): when a target sandbox is named, the
    // active-sandbox pointer is seeded race-free inside createAndStartSession
    // (after the row exists, before the first turn dispatches). Validation
    // (ownership/liveness) lives in swapActiveSandbox; an invalid target 422s.
    seedTargetSandbox: payload.targetSandboxId
      ? { sandboxId: payload.targetSandboxId, settings }
      : null,
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
  // Hoisted above requireLimit so the codex-billed predicate can resolve the
  // turn's effective model (a follow-up turn inherits the session's model). A
  // pure read with no side effects.
  const existingSession = await requireSession(db, workspaceId, sessionId);
  await requireLimit(deps, {
    accountId: grant.accountId,
    workspaceId,
    action: "agent_run:create",
    quantity: 1,
    model: input.model ?? existingSession.model,
  });
  if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(db, workspaceId, requestedResources);
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

/**
 * Shared title-write path for the manual rename route AND both MCP tools
 * (set_session_title / set_other_session_title). The clobber guard lives in
 * the db `updateSessionTitle` UPDATE: an agent write is skipped when a user
 * title already pinned the session. On a real write we emit `session.title_set`
 * exactly like goal mutations emit their events; when nothing changed (agent
 * write blocked by the user lock) we emit nothing. Returns whether a write
 * happened so callers can avoid double work.
 */
export async function updateSessionTitle(
  deps: { db: Database; bus: EventBus },
  workspaceId: string,
  sessionId: string,
  title: string,
  source: "user" | "agent",
): Promise<{ updated: boolean; title: string | null }> {
  const { db, bus } = deps;
  const result = await updateSessionTitleRow(db, { workspaceId, sessionId, title, source });
  if (result.updated) {
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "session.title_set",
      payload: {
        title: result.title ?? title,
        source,
      },
    }]);
  }
  return result;
}

function withFirstPartyTools(tools: ToolRef[], runtimeSettings: { mcpServers: Array<{ id: string }> }): ToolRef[] {
  if (!runtimeSettings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}
