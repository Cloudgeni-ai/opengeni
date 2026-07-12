import { CODEX_MODEL_ID_PREFIX } from "@opengeni/codex";
import {
  configuredAllowedModels,
  policyProviderIdForModel,
  type Settings,
} from "@opengeni/config";
import {
  CreateSessionRequest,
  evaluateWorkspaceModelPolicy,
  reasoningEffortForMetadata,
  type AccessGrant,
  type GoalSpec,
  type Permission,
  type ReasoningEffort,
  type ResourceRef,
  type Session,
  type SessionEvent,
  type SessionMcpCredentialUpdateInput,
  type SessionMcpServerInput,
  type SessionMcpServerMetadata,
  type SessionTurn,
  type ToolRef,
} from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  createSession,
  createSessionGoal,
  createSessionWithIdempotencyKey,
  enqueueSessionTurn,
  encryptVariableSetValue,
  getAnySessionInGroup,
  getEnrollment,
  getRig,
  getWorkspaceDefaultRigId,
  listDistinctVariableSetIdsInGroup,
  listDistinctRigVersionIdsInGroup,
  getSandbox,
  getSession,
  getSessionByCreateIdempotencyKey,
  getSessionLineage,
  getSessionTurn,
  getWorkspaceModelPolicy,
  requireSession,
  setTemporalWorkflowId,
  updateSessionTitle as updateSessionTitleRow,
  type CreateSessionMcpServerInput,
  type Database,
  type UpdateSessionMcpServerCredentialsInput,
} from "@opengeni/db";
import { appendAndPublishEvents, type EventBus } from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requirePermission } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type {
  AcceptSessionUserMessageDependencies,
  ApiRouteDeps,
  SessionWorkflowClient,
} from "../dependencies";
import { swapActiveSandbox, type FleetContext } from "../sandbox/fleet";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { requireVariableSetEncryption, validateVariableSetAttachment } from "./environments";
import {
  mergeResourceRefs,
  mergeToolRefs,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "./resources";

const reservedSessionMcpServerIds = new Set(["opengeni", "files", "docs", "codex_apps"]);
const maxSessionMcpCredentialHeaders = 16;
const maxSessionMcpCredentialHeaderValueLength = 4096;
// RFC 9110 field-name token characters.
const sessionMcpCredentialHeaderName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

type ValidatedSessionMcpServers = {
  runtimeServers: Settings["mcpServers"];
  dbServers: CreateSessionMcpServerInput[];
  metadata: SessionMcpServerMetadata[];
};

function normalizedSessionMcpCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.trim(), value] as const)
    .filter(([name]) => name.length > 0);
  if (entries.length > maxSessionMcpCredentialHeaders) {
    throw new HTTPException(422, {
      message: `a session MCP server supports at most ${maxSessionMcpCredentialHeaders} credential headers`,
    });
  }
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!sessionMcpCredentialHeaderName.test(name)) {
      throw new HTTPException(422, { message: `invalid credential header name: ${name}` });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new HTTPException(422, { message: `duplicate credential header name: ${name}` });
    }
    seen.add(lower);
    if (value.length === 0 || value.length > maxSessionMcpCredentialHeaderValueLength) {
      throw new HTTPException(422, {
        message: `credential header ${name} must be 1-${maxSessionMcpCredentialHeaderValueLength} characters`,
      });
    }
    // RFC 9110 §5.5: field values are HTAB / printable characters.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(value)) {
      throw new HTTPException(422, {
        message: `credential header ${name} contains forbidden control characters`,
      });
    }
  }
  return Object.fromEntries(entries);
}

function mcpServerConfigFromInput(server: SessionMcpServerInput): Settings["mcpServers"][number] {
  return {
    id: server.id,
    ...(server.name ? { name: server.name } : {}),
    url: server.url,
    ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
    ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
    cacheToolsList: server.cacheToolsList ?? false,
    ...(server.requireApproval !== undefined ? { requireApproval: server.requireApproval } : {}),
  };
}

function mcpServerConfigFromMetadata(
  server: SessionMcpServerMetadata,
): Settings["mcpServers"][number] {
  return {
    id: server.id,
    ...(server.name ? { name: server.name } : {}),
    url: server.url,
    cacheToolsList: false,
  };
}

function settingsWithSessionMcpServerConfigs(
  settings: Settings,
  servers: Settings["mcpServers"],
): Settings {
  if (servers.length === 0) {
    return settings;
  }
  const sessionIds = new Set(servers.map((server) => server.id));
  return {
    ...settings,
    mcpServers: [...settings.mcpServers.filter((server) => !sessionIds.has(server.id)), ...servers],
  };
}

export function settingsWithSessionMcpServerMetadata(
  settings: Settings,
  servers: SessionMcpServerMetadata[],
): Settings {
  return settingsWithSessionMcpServerConfigs(settings, servers.map(mcpServerConfigFromMetadata));
}

function validateSessionMcpServersForCreate(
  settings: Settings,
  grant: AccessGrant,
  servers: SessionMcpServerInput[],
): ValidatedSessionMcpServers {
  if (servers.length === 0) {
    return { runtimeServers: [], dbServers: [], metadata: [] };
  }
  requirePermission(grant, "mcp_servers:attach");
  const encryptionKey = requireVariableSetEncryption(settings);
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const seenIds = new Set<string>();
  const runtimeServers: Settings["mcpServers"] = [];
  const dbServers: CreateSessionMcpServerInput[] = [];
  const metadata: SessionMcpServerMetadata[] = [];
  for (const server of servers) {
    if (seenIds.has(server.id)) {
      throw new HTTPException(422, { message: `duplicate session MCP server id: ${server.id}` });
    }
    seenIds.add(server.id);
    if (reservedSessionMcpServerIds.has(server.id) || existingIds.has(server.id)) {
      throw new HTTPException(422, { message: `MCP server id already exists: ${server.id}` });
    }
    const headers = normalizedSessionMcpCredentialHeaders(server.headers);
    const headersEncrypted = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        encryptVariableSetValue(encryptionKey, value),
      ]),
    );
    runtimeServers.push(mcpServerConfigFromInput(server));
    dbServers.push({
      id: server.id,
      name: server.name ?? null,
      url: server.url,
      allowedTools: server.allowedTools ?? null,
      timeoutMs: server.timeoutMs ?? null,
      cacheToolsList: server.cacheToolsList ?? false,
      requireApproval: server.requireApproval ?? null,
      headersEncrypted,
    });
    metadata.push({
      id: server.id,
      name: server.name ?? null,
      url: server.url,
      headerNames: Object.keys(headersEncrypted).sort(),
      credentialVersion: 1,
    });
  }
  return { runtimeServers, dbServers, metadata };
}

function validateSessionMcpCredentialUpdates(input: {
  settings: Settings;
  grant: AccessGrant;
  session: Session;
  updates: SessionMcpCredentialUpdateInput[];
}): UpdateSessionMcpServerCredentialsInput[] {
  if (input.updates.length === 0) {
    return [];
  }
  requirePermission(input.grant, "mcp_servers:attach");
  const encryptionKey = requireVariableSetEncryption(input.settings);
  const knownIds = new Set(input.session.mcpServers.map((server) => server.id));
  const seenIds = new Set<string>();
  const encryptedUpdates = input.updates.map((update) => {
    if (seenIds.has(update.id)) {
      throw new HTTPException(422, {
        message: `duplicate session MCP credential update id: ${update.id}`,
      });
    }
    seenIds.add(update.id);
    if (!knownIds.has(update.id)) {
      throw new HTTPException(422, { message: `unknown session MCP server id: ${update.id}` });
    }
    const headers = normalizedSessionMcpCredentialHeaders(update.headers);
    return {
      id: update.id,
      headersEncrypted: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
          name,
          encryptVariableSetValue(encryptionKey, value),
        ]),
      ),
    };
  });
  return encryptedUpdates;
}

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
  variableSet?: { id: string; name: string } | null;
  // The rig + frozen active rig version resolved at create (M3). Both null ⇒ a
  // rig-less session (byte-for-byte today's behavior). Frozen here so a later
  // rig promote never moves an existing session's version.
  rigId?: string | null;
  rigVersionId?: string | null;
  goal?: GoalSpec | null;
  // Per-session agent persona/system instructions (org-visible metadata, not a
  // secret). Persisted on the session row and composed system-level AFTER the
  // workspace agentInstructions at turn time; never emitted as a timeline event.
  // Null/omitted ⇒ the session carries none.
  instructions?: string | null;
  // Validated against the creating grant before this is called.
  firstPartyMcpPermissions?: Permission[] | null;
  // Encrypted DB rows plus matching safe metadata for create-time per-session
  // MCP servers. Metadata is the only shape emitted in events/responses.
  mcpServers?: CreateSessionMcpServerInput[];
  sessionMcpServers?: SessionMcpServerMetadata[];
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
  // The OS axis of the session's box (sessions.sandbox_os). Omitted ⇒ the
  // "linux" default; set only for a machine-targeted top-level create, where the
  // targeted machine's enrollment OS is threaded in so the row + resume path +
  // OS-labeling surfaces honestly reflect the machine.
  sandboxOs?: Session["sandboxOs"];
  // Create-time machine targeting (A-2a, RACE-FREE): the enrolled machine (a
  // sandbox id) to run this session on. When set, the active-sandbox pointer is
  // resolved+validated+seeded (epoch-fenced) INSIDE finishStartSession, AFTER the
  // session row exists but BEFORE the first turn is enqueued/the workflow woken,
  // so the FIRST turn routes to the chosen machine. An invalid/unowned/offline
  // target fails the create (422) — never a silent fall-back to the default box.
  // `workingDir` (optional) is the path/cwd base the chosen machine runs under,
  // seeded alongside the pointer through the epoch-fenced CAS.
  seedTargetSandbox?: { sandboxId: string; settings: Settings; workingDir?: string | null } | null;
}) {
  const sessionMetadata = {
    ...input.metadata,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };
  // Fast path with a key: return a session already created under this key
  // (the sequential retry / double-submit case) without inserting again.
  if (input.createIdempotencyKey) {
    const existing = await getSessionByCreateIdempotencyKey(
      input.db,
      input.workspaceId,
      input.createIdempotencyKey,
    );
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
      variableSetId: input.variableSet?.id ?? null,
      rigId: input.rigId ?? null,
      rigVersionId: input.rigVersionId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      instructions: input.instructions ?? null,
      parentSessionId: input.parentSessionId ?? null,
      createIdempotencyKey: input.createIdempotencyKey,
      sandboxGroupId: input.sandboxGroupId ?? null,
      ...(input.sandboxOs ? { sandboxOs: input.sandboxOs } : {}),
      mcpServers: input.mcpServers ?? [],
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
    variableSetId: input.variableSet?.id ?? null,
    rigId: input.rigId ?? null,
    rigVersionId: input.rigVersionId ?? null,
    firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
    instructions: input.instructions ?? null,
    parentSessionId: input.parentSessionId ?? null,
    sandboxGroupId: input.sandboxGroupId ?? null,
    ...(input.sandboxOs ? { sandboxOs: input.sandboxOs } : {}),
    mcpServers: input.mcpServers ?? [],
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
async function finishStartSession(
  input: {
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
    variableSet?: { id: string; name: string } | null;
    goal?: GoalSpec | null;
    sessionMcpServers?: SessionMcpServerMetadata[];
    seedTargetSandbox?: {
      sandboxId: string;
      settings: Settings;
      workingDir?: string | null;
    } | null;
  },
  session: Session,
): Promise<Session> {
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
  const events = await appendAndPublishEvents(
    input.db,
    input.bus,
    session.workspaceId,
    session.id,
    [
      {
        type: "session.created",
        payload: {
          status: "queued",
          ...(input.variableSet
            ? { variableSetId: input.variableSet.id, variableSetName: input.variableSet.name }
            : {}),
          ...(input.sessionMcpServers?.length ? { mcpServers: input.sessionMcpServers } : {}),
        },
      },
      ...(goal
        ? [
            {
              type: "goal.set" as const,
              payload: {
                goalId: goal.id,
                text: goal.text,
                ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
                version: goal.version,
                actor: "api",
                replaced: false,
              },
            },
          ]
        : []),
      {
        type: "user.message",
        payload: initialPayload,
        ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
      },
      { type: "session.status.changed", payload: { status: "queued" } },
    ],
  );
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
      // The working dir is committed in the SAME epoch-fenced CAS that seeds the
      // pointer, so the first turn routes to the machine AND lands in working_dir.
      input.seedTargetSandbox.workingDir ?? null,
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
  await appendAndPublishEvents(input.db, input.bus, session.workspaceId, session.id, [
    {
      type: "turn.queued",
      turnId: turn.id,
      payload: { turnId: turn.id, triggerEventId: userEvent.id, source: turn.source },
    },
  ]);
  await input.workflowClient.wakeSessionWorkflow({
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    workflowId,
  });
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

/**
 * Reject a model the WORKSPACE's model policy blocks, at the same choke points
 * as assertConfiguredModel — a 422 at the edge instead of a queued turn the
 * worker's authoritative post-resolution gate would fail. `model` is the
 * EFFECTIVE value the caller is about to persist: pass the explicit value at
 * message/turn-update/scheduled-task edges (omitted inherits an
 * already-validated stored default), but at session CREATION pass
 * `payload.model ?? settings.openaiModel` — an omitted model stamps the
 * deployment default onto the session, and under a restricted policy that
 * default may be exactly the provider the policy exists to block.
 */
export async function assertWorkspaceModelPolicyAllows(
  db: Database,
  settings: Settings,
  workspaceId: string,
  model: string | null | undefined,
): Promise<void> {
  if (model === null || model === undefined) {
    return;
  }
  const policy = await getWorkspaceModelPolicy(db, workspaceId);
  if (!policy) {
    return;
  }
  const providerId = policyProviderIdForModel(settings, model);
  const verdict = evaluateWorkspaceModelPolicy(policy, { providerId, modelId: model });
  if (!verdict.allowed) {
    throw new HTTPException(422, {
      message:
        verdict.reason === "provider"
          ? `model "${model}" is not allowed by this workspace's model policy: provider "${providerId}" is not in the allowed providers`
          : `model "${model}" is not allowed by this workspace's model policy`,
    });
  }
}

export async function requireQueuedTurnForApi(
  db: Database,
  workspaceId: string,
  sessionId: string,
  turnId: string,
): Promise<SessionTurn> {
  const turn = await getSessionTurn(db, workspaceId, turnId);
  if (!turn || turn.sessionId !== sessionId) {
    throw new HTTPException(404, { message: "session turn not found" });
  }
  if (turn.status !== "queued") {
    throw new HTTPException(409, {
      message: `turn is ${turn.status}; only queued turns can be changed`,
    });
  }
  return turn;
}

export function reasoningEffortForSession(
  metadata: Record<string, unknown>,
  fallback: Settings["openaiReasoningEffort"],
): Settings["openaiReasoningEffort"] {
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
  workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
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
  mcpCredentialUpdates?: UpdateSessionMcpServerCredentialsInput[];
  // Default append preserves the public API/MCP queue semantics. The operator
  // recovery helper opts into the locked reject policy so a preflight race
  // cannot silently append behind newly-active work.
  queuePolicy?: "append" | "reject_conflicts";
}): Promise<{ accepted: SessionEvent; turn: SessionTurn }> {
  const { db, bus, workflowClient, settings, accountId, workspaceId, sessionId } = input;
  const requestedModel = input.model ?? null;
  const requestedReasoningEffort = input.reasoningEffort ?? null;
  // Reject an explicit per-message model the host does not expose; an omitted
  // model inherits the session's model downstream (always a configured id).
  assertConfiguredModel(settings, requestedModel);
  await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, requestedModel);
  const appended = await appendSessionEventsWithLockedSessionUpdate(
    db,
    workspaceId,
    sessionId,
    async (lockedSession, lockedUpdate) => {
      // Cancelled is the one terminal state: an explicit user act. A FAILED
      // session stays revivable by talking to it — conversation truth lives in
      // session_history_items, so a failed turn does not invalidate history,
      // and the manager channel of record must always answer when spoken to.
      // The new message transitions failed -> queued (clearing the stale
      // activeTurnId) and the signalWithStart below starts a fresh workflow
      // run for the completed (failed) one, exactly as for idle sessions.
      if (lockedSession.status === "cancelled") {
        throw new HTTPException(409, {
          message: `session is ${lockedSession.status}; cannot accept a new user message`,
        });
      }
      if (input.queuePolicy === "reject_conflicts") {
        const pendingTurns = await lockedUpdate.listPendingSessionTurns();
        if (
          pendingTurns.length > 0 ||
          lockedSession.status === "queued" ||
          lockedSession.status === "running" ||
          lockedSession.status === "requires_action"
        ) {
          throw new HTTPException(409, {
            message: "session has active or queued work; explicit append policy required",
          });
        }
      }
      const mcpCredentialUpdates = input.mcpCredentialUpdates?.length
        ? await lockedUpdate.updateSessionMcpServerCredentials(input.mcpCredentialUpdates)
        : { servers: [], missingIds: [] };
      if (mcpCredentialUpdates.missingIds.length > 0) {
        throw new HTTPException(422, {
          message: `unknown session MCP server id: ${mcpCredentialUpdates.missingIds[0]}`,
        });
      }
      const nextResources = mergeResourceRefs(lockedSession.resources, input.resources);
      const nextTools = mergeToolRefs(lockedSession.tools, input.tools);
      const shouldQueueSession =
        lockedSession.status === "idle" || lockedSession.status === "failed";
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
              ...(mcpCredentialUpdates.servers.length
                ? { mcpCredentialUpdates: mcpCredentialUpdates.servers }
                : {}),
            },
            ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
          },
          ...(shouldQueueSession
            ? [{ type: "session.status.changed" as const, payload: { status: "queued" } }]
            : []),
        ],
        update: {
          resources: nextResources,
          tools: nextTools,
          ...(shouldQueueSession ? { status: "queued" as const, activeTurnId: null } : {}),
        },
      };
    },
  ).then(async (events) => {
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
    reasoningEffort:
      requestedReasoningEffort ??
      reasoningEffortForSession(session.metadata, settings.openaiReasoningEffort),
    sandboxBackend: session.sandboxBackend,
    metadata: {},
    // A human's message jumps ahead of any queued machine child-completion
    // notification turns — it must never wait behind a flood of "worker FAILED"
    // notices (the burial that spent the user's stop-spree and killed his own
    // message). Stays behind the running turn and earlier human turns.
    preemptChildNotifications: true,
  });
  await appendAndPublishEvents(db, bus, workspaceId, sessionId, [
    {
      type: "turn.queued",
      turnId: turn.id,
      payload: { turnId: turn.id, triggerEventId: accepted.id, source: turn.source },
    },
  ]);
  await workflowClient.wakeSessionWorkflow({ accountId, workspaceId, sessionId, workflowId });
  return { accepted, turn };
}

/**
 * Full create-session flow shared by `POST /sessions` and the first-party MCP
 * `session_create` tool: payload validation, resource/tool/variableSet
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
  const capabilityRuntimeSettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
  );
  const sessionMcpServers = validateSessionMcpServersForCreate(
    capabilityRuntimeSettings,
    grant,
    payload.mcpServers,
  );
  const runtimeSettings = settingsWithSessionMcpServerConfigs(
    capabilityRuntimeSettings,
    sessionMcpServers.runtimeServers,
  );
  const resources = normalizeResources(payload.resources);
  const requestedTools = validateToolRefs(payload.tools, runtimeSettings);
  const defaultedTools = hasOwnProperty(rawPayload, "tools")
    ? requestedTools
    : withDefaultEnabledCapabilityMcpTools(requestedTools, settings, capabilityRuntimeSettings);
  // The first-party MCP server is attached to EVERY session. It hosts the
  // session's own metadata tool (set_session_title) + goal tools, and — only
  // when the grant carries the permission — the orchestration/variableSet/
  // github tools. Capability is gated per-tool by permission, never by whether
  // the server is attached, so a bare chat still gets titling while the
  // dangerous tools stay off by default.
  const tools = withFirstPartyTools(defaultedTools, runtimeSettings);
  await validateGitHubRepositorySelection(db, workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(db, workspaceId, resources);
  // VariableSet attachment requires variable-sets:use on the calling grant
  // (validateVariableSetAttachment enforces it), preserving the invariant
  // that sandboxed agents cannot self-attach workspace secrets.
  const variableSet = payload.variableSetId
    ? await validateVariableSetAttachment(
        { settings, db },
        grant,
        workspaceId,
        payload.variableSetId,
      )
    : null;
  // RIG BINDING (M3). Resolve the rig this session rides — the EXPLICIT payload
  // rigId when given, else the workspace default rig (workspaces.default_rig_id)
  // — and FREEZE both the rig id and its currently-ACTIVE version onto the row.
  // The session then rides that exact version for its whole life; a later
  // promote never moves it. Rig-less (both null) when neither resolves, which is
  // byte-for-byte today's behavior (zero extra work, zero row change).
  //   - An EXPLICIT unknown/inactive rigId is a caller error → 422.
  //   - A stale workspace-default rig (deleted → FK-nulled, or somehow with no
  //     active version) degrades SILENTLY to rig-less: an operator-side default
  //     must never brick every create in the workspace.
  const requestedRigId = payload.rigId ?? (await getWorkspaceDefaultRigId(db, workspaceId));
  let frozenRigId: string | null = null;
  let frozenRigVersionId: string | null = null;
  if (requestedRigId) {
    const rig = await getRig(db, workspaceId, requestedRigId);
    if (!rig || !rig.activeVersion) {
      if (payload.rigId) {
        throw new HTTPException(422, {
          message: rig
            ? `rig ${payload.rigId} has no active version to bind`
            : `unknown rigId: ${payload.rigId}`,
        });
      }
      // else: workspace-default fallback that no longer resolves → rig-less.
    } else {
      frozenRigId = rig.id;
      frozenRigVersionId = rig.activeVersion.id;
    }
  }
  assertConfiguredModel(settings, payload.model);
  // Session creation persists the EFFECTIVE model — an omitted payload.model
  // stamps the deployment default onto the session — so the policy must vet
  // that effective value, not just explicit ones (a restricted workspace's
  // default-model session would otherwise be born blocked).
  await assertWorkspaceModelPolicyAllows(
    db,
    settings,
    workspaceId,
    payload.model ?? settings.openaiModel,
  );
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
    throw new HTTPException(422, {
      message:
        "firstPartyMcpPermissions must not be empty; omit it for the default worker permission set",
    });
  }
  for (const permission of firstPartyMcpPermissions ?? []) {
    if (!hasPermission(grant.permissions, permission)) {
      throw new HTTPException(403, {
        message: `cannot grant first-party MCP permission beyond the creating grant: ${permission}`,
      });
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
  if (
    payload.goal &&
    firstPartyMcpPermissions &&
    !firstPartyMcpPermissions.includes("goals:manage")
  ) {
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
  const parentSessionId =
    typeof grant.metadata?.["sessionId"] === "string"
      ? (grant.metadata["sessionId"] as string)
      : null;
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
  // ENV-AWARE GROUPING: under the CURRENT mechanics the workspace VariableSet is
  // creation-time box state — the box's manifest env is fixed when it is cold-
  // created, and the SDK's provided-session guard rejects any manifest-env delta
  // at attach. A session carrying a DIFFERENT VariableSet than the box it joins
  // is therefore a genuine shared-state conflict TODAY: its first turn on a warm
  // box dies with "Live sandbox sessions cannot change manifest variableSet
  // variables" (proven live, sessions 5aee77e9 + 63d18823). Until the VariableSet
  // is evicted from the manifest (per-exec, like the git token), grouping must be
  // env-aware: the INHERITED default falls back to an own box on mismatch (a
  // credentialed worker spawned from a credential-less manager just works), and
  // an EXPLICIT shared/{groupId} request with a mismatched VariableSet fails
  // fast at create (422) instead of poisoning the session's first turn.
  // The env conflict is a BOX property, so a boxless group is exempt: a
  // backend:"none" session runs in-process with no sandbox, no manifest, and no
  // provided-session attach — no shared box state exists to conflict, and
  // env-differing spawns from such parents shared safely before the env-aware
  // check. They keep sharing (and keep inheriting "none").
  const requestedVariableSetId = payload.variableSetId ?? null;
  const variableSetMatchesGroup = (memberVariableSetId: string | null): boolean =>
    memberVariableSetId === requestedVariableSetId;
  // RIG-AWARE GROUPING (M3), the exact sibling of the env-aware gate above: the
  // box's rig-baked setup/tooling is fixed at cold-create, so a session joining a
  // shared box must ride the SAME frozen rig_version_id. A mismatch is a genuine
  // shared-state conflict (the box was set up for a different rig) — the INHERITED
  // default falls back to an own box, an EXPLICIT shared/{groupId} request 422s at
  // create rather than poisoning the first turn on the lease's rig-conflict guard.
  // null on either side = compatible (a rig-less session shares with a rig-less
  // box exactly as today); the boxless backend:'none' exemption is shared with the
  // env gate (no box state to conflict).
  const rigVersionMatchesGroup = (memberRigVersionId: string | null): boolean =>
    memberRigVersionId === frozenRigVersionId;
  if (sandboxChoice === "shared") {
    if (!parentSessionId) {
      throw new HTTPException(422, {
        message:
          "sandbox:'shared' requires a parent session (spawn from inside a session); use 'new' for a top-level create.",
      });
    }
    const parent = await getSession(db, workspaceId, parentSessionId);
    if (!parent) {
      throw new HTTPException(404, {
        message: `parent session not found in workspace: ${parentSessionId}`,
      });
    }
    const parentBoxed = parent.sandboxBackend !== "none";
    const variableSetMismatch =
      parentBoxed && !variableSetMatchesGroup(parent.variableSetId ?? null);
    let rigMismatch = parentBoxed && !rigVersionMatchesGroup(parent.rigVersionId ?? null);
    if (parentBoxed && !rigMismatch) {
      const memberRigVersionIds = await listDistinctRigVersionIdsInGroup(
        db,
        workspaceId,
        parent.sandboxGroupId,
      );
      rigMismatch = !memberRigVersionIds.every((memberRigVersionId) =>
        rigVersionMatchesGroup(memberRigVersionId),
      );
    }
    if (variableSetMismatch || rigMismatch) {
      if (payload.sandbox === "shared") {
        // The caller explicitly asked to share while carrying a different
        // VariableSet / rig — surface the conflict at create time, not turn time.
        // VariableSet is checked first so its (pre-rig) message is unchanged for
        // the env-only mismatch the existing gate already covered.
        throw new HTTPException(422, {
          message: variableSetMismatch
            ? "sandbox:'shared' requires the same variableSet / same environment as the creator's box (the box variable set/environment is fixed at creation); omit sandbox or pass 'new' when attaching a different variableSet/environment."
            : "sandbox:'shared' requires the same rig as the creator's box (the box's rig setup is fixed at creation); omit sandbox or pass 'new' when binding a different rig.",
        });
      }
      // Inherited default: deterministic separation on the genuine shared-state
      // conflict — the worker gets its own box (resolved like a top-level
      // create: payload.sandboxBackend, else the deployment default) and its
      // turn runs.
    } else {
      sandboxGroupId = parent.sandboxGroupId;
      inheritedBackend = parent.sandboxBackend;
    }
  } else if (typeof sandboxChoice === "object") {
    const member = await getAnySessionInGroup(db, workspaceId, sandboxChoice.groupId);
    if (!member) {
      throw new HTTPException(404, {
        message: `sandbox group not found in workspace: ${sandboxChoice.groupId}`,
      });
    }
    if (member.sandboxBackend !== "none") {
      // Compare against EVERY member, not one arbitrary row: a legacy env-blind
      // group can carry mixed variableSetIds, and an any-member read would make
      // the join verdict nondeterministic. Post-env-aware groups are homogeneous
      // (both join paths enforce equality), so this reads one distinct value in
      // the common case; a mixed legacy group deterministically rejects.
      const memberVariableSetIds = await listDistinctVariableSetIdsInGroup(
        db,
        workspaceId,
        sandboxChoice.groupId,
      );
      if (
        !memberVariableSetIds.every((memberVariableSetId) =>
          variableSetMatchesGroup(memberVariableSetId),
        )
      ) {
        throw new HTTPException(422, {
          message: `sandbox group ${sandboxChoice.groupId} runs a different variableSet / different environment (the box variable set/environment is fixed at creation); create with the group's variableSet/environment or omit sandbox for an own box.`,
        });
      }
      // Same deterministic all-members check for the frozen rig version (M3): the
      // box's rig setup is fixed at creation, so every member must ride the rig
      // this create resolved (or the group is rig-less and so is this create).
      const memberRigVersionIds = await listDistinctRigVersionIdsInGroup(
        db,
        workspaceId,
        sandboxChoice.groupId,
      );
      if (
        !memberRigVersionIds.every((memberRigVersionId) =>
          rigVersionMatchesGroup(memberRigVersionId),
        )
      ) {
        throw new HTTPException(422, {
          message: `sandbox group ${sandboxChoice.groupId} runs a different rig (the box's rig setup is fixed at creation); create with the group's rig or omit sandbox for an own box.`,
        });
      }
    }
    sandboxGroupId = sandboxChoice.groupId;
    inheritedBackend = member.sandboxBackend;
  }
  // else "new": leave sandboxGroupId null → own singleton group (group ≡ id).
  // A working dir is only meaningful for a TARGETED machine (it is the chosen
  // box's path/cwd base). Present without a targetSandboxId is a malformed request
  // — reject it at the edge (mirrors the backend:'none' guard) rather than silently
  // dropping it, since the default group box has no working-dir seam yet.
  if (payload.workingDir !== undefined && !payload.targetSandboxId) {
    throw new HTTPException(422, {
      message:
        "workingDir requires targetSandboxId (it is the targeted machine's working directory)",
    });
  }
  // Honest-label (Stage-D closure): a top-level session TARGETED at a Connected
  // Machine (a selfhosted sandbox) runs machine-primary every turn, so its HOME
  // sandbox_backend must read "selfhosted" — not the deployment cloud default —
  // so the session row + first turn honestly reflect where the agent runs (the
  // Machines dashboard, the turn's warm-metering, and the file-download plane all
  // key off this). GUARDS: (1) only at a TOP-LEVEL create (inheritedBackend
  // undefined) — a shared/{groupId} spawn is literally the creator's box and must
  // NOT be relabeled; (2) only when the target's kind is actually "selfhosted" —
  // targetSandboxId also accepts a first-class MODAL sandbox id (resolveTarget),
  // which must never be mislabeled. A not-found / non-selfhosted / modal target
  // falls through to the default; the seed swap in createAndStartSession still
  // validates ownership/liveness and 422s a bad target. (3) only when the feature
  // flags that make the worker actually take the machine-primary path are ON
  // (sandboxOwnershipEnabled + sandboxSelfhostedEnabled/routing) — otherwise the
  // worker ignores the active pointer and a home="selfhosted" turn would fall to
  // the registry client with no bound agentId and throw; with the flags off we
  // keep the cloud default and the machine layers as a (pre-honest-label) overlay.
  // sandbox_os (the OS axis the worker's group-box resume + the OS-labeling
  // surfaces key off) must ALSO reflect the targeted machine, not the "linux"
  // schema default — a session run on a macOS Connected Machine that labels
  // itself linux lies to those surfaces. Derived under the SAME guards as the
  // backend relabel; the enrollment (joined via the sandbox's enrollmentId)
  // carries the OS. enrollmentOsValues and the sessions.sandbox_os value set are
  // both ("linux","macos","windows"), so a known value maps 1:1; any other value
  // is left to the "linux" default (never write a value no reader understands).
  let machineHomeBackend: Session["sandboxBackend"] | undefined;
  let machineHomeOs: Session["sandboxOs"] | undefined;
  if (
    payload.targetSandboxId &&
    inheritedBackend === undefined &&
    settings.sandboxOwnershipEnabled &&
    settings.sandboxSelfhostedEnabled
  ) {
    const targetSandbox = await getSandbox(db, workspaceId, payload.targetSandboxId);
    if (targetSandbox?.kind === "selfhosted") {
      machineHomeBackend = "selfhosted";
      if (targetSandbox.enrollmentId) {
        const enrollment = await getEnrollment(db, workspaceId, targetSandbox.enrollmentId);
        if (
          enrollment &&
          (enrollment.os === "macos" || enrollment.os === "windows" || enrollment.os === "linux")
        ) {
          machineHomeOs = enrollment.os;
        }
      }
    }
  }
  await requireLimit(deps, {
    accountId: grant.accountId,
    workspaceId,
    action: "agent_run:create",
    quantity: 1,
    model,
  });
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
    // sandboxBackend on a shared spawn is ignored (it is the same box). A
    // machine-targeted top-level create labels the home "selfhosted"
    // (machineHomeBackend), overriding the caller/deployment default so the row
    // matches where the session actually runs.
    sandboxBackend:
      inheritedBackend ?? machineHomeBackend ?? payload.sandboxBackend ?? settings.sandboxBackend,
    // Mirror the backend relabel on the OS axis: only a machine-targeted
    // top-level create carries a derived OS; everything else is omitted and the
    // "linux" default holds (shared spawns keep the parent-box behavior).
    ...(machineHomeOs ? { sandboxOs: machineHomeOs } : {}),
    sandboxGroupId,
    metadata: payload.metadata,
    variableSet: variableSet ? { id: variableSet.id, name: variableSet.name } : null,
    // Frozen rig binding (M3): both null for a rig-less session (today's path).
    rigId: frozenRigId,
    rigVersionId: frozenRigVersionId,
    goal: payload.goal ?? null,
    // Per-session persona instructions (already trimmed/validated by the
    // contracts schema). Persisted on the row; composed system-level at turn
    // time. Not surfaced as an event.
    instructions: payload.instructions ?? null,
    firstPartyMcpPermissions,
    mcpServers: sessionMcpServers.dbServers,
    sessionMcpServers: sessionMcpServers.metadata,
    parentSessionId,
    createIdempotencyKey: payload.idempotencyKey ?? null,
    // Create-time machine targeting (A-2a): when a target sandbox is named, the
    // active-sandbox pointer is seeded race-free inside createAndStartSession
    // (after the row exists, before the first turn dispatches). Validation
    // (ownership/liveness) lives in swapActiveSandbox; an invalid target 422s.
    seedTargetSandbox: payload.targetSandboxId
      ? { sandboxId: payload.targetSandboxId, settings, workingDir: payload.workingDir ?? null }
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
  deps: AcceptSessionUserMessageDependencies,
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
    mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[];
    queuePolicy?: "append" | "reject_conflicts";
  },
): Promise<{ accepted: SessionEvent; turn: SessionTurn }> {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const capabilityRuntimeSettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
  );
  // Hoisted above requireLimit so the codex-billed predicate can resolve the
  // turn's effective model (a follow-up turn inherits the session's model). A
  // pure read with no side effects.
  const existingSession = await requireSession(db, workspaceId, sessionId);
  const runtimeSettings = settingsWithSessionMcpServerMetadata(
    capabilityRuntimeSettings,
    existingSession.mcpServers,
  );
  const requestedResources = normalizeResources(input.resources ?? []);
  const validatedTools = validateToolRefs(input.tools ?? [], runtimeSettings);
  const requestedTools = input.toolsProvided
    ? validatedTools
    : withDefaultEnabledCapabilityMcpTools(validatedTools, settings, capabilityRuntimeSettings);
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
  await validateGitHubRepositorySelection(db, workspaceId, [
    ...existingSession.resources,
    ...requestedResources,
  ]);
  const mcpCredentialUpdates = validateSessionMcpCredentialUpdates({
    settings,
    grant,
    session: existingSession,
    updates: input.mcpCredentialUpdates ?? [],
  });
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
    mcpCredentialUpdates,
    queuePolicy: input.queuePolicy ?? "append",
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
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [
      {
        type: "session.title_set",
        payload: {
          title: result.title ?? title,
          source,
        },
      },
    ]);
  }
  return result;
}

export async function readSessionLineage(db: Database, workspaceId: string, sessionId: string) {
  const lineage = await getSessionLineage(db, workspaceId, sessionId);
  if (!lineage) {
    throw new HTTPException(404, { message: "session not found" });
  }
  return lineage;
}

function withFirstPartyTools(
  tools: ToolRef[],
  runtimeSettings: { mcpServers: Array<{ id: string }> },
): ToolRef[] {
  if (!runtimeSettings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return Boolean(
    value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key),
  );
}
