import { CODEX_MODEL_ID_PREFIX, isCodexBilledModel } from "@opengeni/codex";
import {
  canonicalizeConfiguredModelId,
  configuredAllowedModels,
  resolveFirstPartyMcpToolPolicy,
  policyProviderIdForModel,
  resolveTurnExecutionPolicyV1,
  WORKSPACE_GATEWAY_MODEL_ID_PREFIX,
  XAI_SUBSCRIPTION_MODEL_ID_PREFIX,
  type Settings,
} from "@opengeni/config";
import {
  CreateSessionRequest,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  DraftTimelineAnnotations,
  FIRST_PARTY_MCP_TOOL_NAMES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  SessionSpawnDenial,
  ServiceTurnInitiator,
  ServiceTurnInitiatorContext,
  evaluateWorkspaceModelPolicy,
  stableJson,
  type AccessGrant,
  type ComposerDraft,
  type CreateSessionResponse,
  type GoalSpec,
  type FirstPartyMcpToolName,
  type McpPersonalConnectionDelegation,
  type McpConnectionAuthoritySelection,
  type Permission,
  type PersonalResourceAttachmentIntent,
  type ReasoningEffort,
  type ResourceRef,
  type Session,
  type SessionSkill,
  type SessionEvent,
  SessionMcpApprovalPolicy,
  type SessionMcpCredentialUpdateInput,
  type SessionMcpServerInput,
  type SessionMcpServerMetadata,
  type SubmittedTimelineAnnotation,
  type TimelineAnnotation,
  type UpdateSessionMcpApprovalPolicyResponse,
  type UpdateSessionToolPolicyRequest,
  type SessionAuthorizationPort,
  type SessionToolPolicy,
  type SessionTurn,
  type SessionGoalSnapshot,
  type ToolRef,
  type TurnInitiator,
  type TurnInitiatorContext,
  type TurnExecutionPolicyV1,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import {
  createSession,
  createSessionWithIdempotencyKeyResult,
  encryptVariableSetValue,
  getAnySessionInGroup,
  getEnrollment,
  getChannel,
  getRig,
  getWorkspaceDefaultRigId,
  listDistinctVariableSetIdsInGroup,
  listDistinctRigVersionIdsInGroup,
  getSandbox,
  getSession,
  getSessionAuthorityProjection,
  SessionIdConflictError,
  NewSessionDraftConflictError,
  getSessionSpawnDenialByIdempotencyKey,
  getWorkspaceControlEvent,
  getSessionLineage,
  getSessionTurn,
  getSessionTurnForAttempt,
  getSessionTurnPersonalConnectionDelegations,
  getSessionTurnXaiProviderAccountAuthoritySnapshot,
  getWorkspaceModelPolicy,
  initializeSessionStartAtomically,
  listSessionTurns,
  listSessionMcpServersForChildInheritance,
  requireSession,
  submitHumanPromptInTransaction,
  appendSessionEventsWithLockedSessionUpdate,
  updateSessionTitle as updateSessionTitleRow,
  withWorkspaceSubjectSessionActivityRls,
  type CreateSessionMcpServerInput,
  type Database,
  type UpdateSessionMcpServerCredentialsInput,
  QueueCommandConflictError,
  AgentCommandAuthorityError,
  runIdempotentPersistenceTransaction,
  SessionSpawnDeniedDbError,
  SessionControlConflictError,
  SessionToolPolicyVersionConflictError,
  SessionCreateIdempotencyConflictError,
  PersonalResourceAttachmentAcceptanceError,
  sessionTenancyProductActivated,
  workspaceControlRequestLockTimeoutMs,
  WorkspaceControlBusyError,
  type SessionCommandActor,
  type NewSessionDraftSnapshot,
} from "@opengeni/db";
import {
  appendAndPublishEvents,
  publishDurableSessionEvents,
  publishDurableWorkspaceControlEvent,
  type EventBus,
} from "@opengeni/events";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requirePermission, type AccessGrantAuthorization } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type {
  AcceptSessionUserMessageDependencies,
  ApiRouteDeps,
  SessionWorkflowClient,
} from "../dependencies";
import {
  requireLiveAgentAttemptAuthorization,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
} from "../session-authorization";
import { swapActiveSandbox, type FleetContext } from "../sandbox/fleet";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { validateSubmittedTimelineAnnotations } from "./timeline-annotations";
import { requireVariableSetEncryption, validateVariableSetAttachment } from "./environments";
import {
  freezePersonalConnectionDelegations,
  personalConnectionDelegationSourceForGrant,
} from "./personal-connection-delegations";
import { hasReservedOpenGeniSlackBotSessionMetadata } from "./slack-bot";
import {
  getManagedHumanPrivateSessionCreatePolicy,
  requireCanonicalManagedHuman,
  requireManagedHumanPrivateSessionCreate,
} from "../application/session-tenancy";
import {
  assertToolRefsSubset,
  availableToolRefs,
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
// Keep the durable snapshot below the shared event-preview array boundary so
// the generic lossy projection cannot silently rewrite this audit fact.
const maxToolPolicyAuditRefs = 40;
// RFC 9110 field-name token characters.
const sessionMcpCredentialHeaderName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

async function requireAtomicPersonalResourceAttachment(
  deps: Pick<ApiRouteDeps, "db">,
  authorization: AccessGrantAuthorization | undefined,
  workspaceId: string,
  intent: PersonalResourceAttachmentIntent | undefined,
  existingSession: boolean,
): Promise<void> {
  if (!intent) return;
  if (!authorization) {
    throw new HTTPException(403, {
      message: "Personal resources require the owning managed-human session.",
    });
  }
  try {
    requireCanonicalManagedHuman(authorization, workspaceId);
  } catch (error) {
    throw new HTTPException(403, {
      message: "Personal resources require the owning managed-human session.",
      cause: error,
    });
  }
  if (!(await sessionTenancyProductActivated(deps.db, workspaceId))) {
    throw new HTTPException(409, {
      message: "Session tenancy is not activated for this organization.",
    });
  }
  if (existingSession && intent.expectedAuthorityEpoch === undefined) {
    throw new HTTPException(422, {
      message: "Personal-resource attachment requires expectedAuthorityEpoch.",
    });
  }
}

/** Transport-neutral typed denial raised only after its audit row committed. */
export class SessionSpawnDeniedError extends Error {
  readonly denial: SessionSpawnDenial;

  constructor(denial: SessionSpawnDenial) {
    super(sessionSpawnDeniedMessage(denial));
    this.name = "SessionSpawnDeniedError";
    this.denial = denial;
  }
}

/**
 * Resolve per-session first-party tool visibility without consulting
 * authorization. Top-level omission snapshots the complete runtime default;
 * child omission snapshots the parent's exact effective selection. Explicit
 * [] is authoritative and must never widen.
 */
export function resolveFirstPartyMcpToolsForCreate(
  requested: FirstPartyMcpToolName[] | undefined,
  parentStored: FirstPartyMcpToolName[] | null | undefined,
  policy: {
    default: readonly FirstPartyMcpToolName[];
    allowed: readonly FirstPartyMcpToolName[];
  } = {
    default: DEFAULT_FIRST_PARTY_MCP_TOOLS,
    allowed: FIRST_PARTY_MCP_TOOL_NAMES,
  },
): FirstPartyMcpToolName[] {
  if (requested !== undefined) return [...requested];
  const allowed = new Set(policy.allowed);
  const inherited = parentStored === undefined ? policy.default : (parentStored ?? policy.default);
  return [...inherited].filter((tool) => allowed.has(tool));
}

function sessionSpawnDeniedMessage(denial: SessionSpawnDenial): string {
  if (denial.code === "nested_agent_depth_override_forbidden") {
    return `requested nested-agent depth limit ${denial.requestedMaxNestedAgentDepthOverride ?? "unknown"} exceeds inherited limit ${denial.effectiveMaxNestedAgentDepth}; workspace:admin is required to increase it`;
  }
  return `nested-agent depth ${denial.attemptedDepth} exceeds effective limit ${denial.effectiveMaxNestedAgentDepth} (current parent depth ${denial.currentDepth})`;
}

export function sessionSpawnDenialEnvelope(error: SessionSpawnDeniedError) {
  return {
    error: {
      code: error.denial.code,
      message: error.message,
      details: { denial: error.denial },
    },
  } as const;
}

type ValidatedSessionMcpServers = {
  runtimeServers: Settings["mcpServers"];
  dbServers: CreateSessionMcpServerInput[];
  metadata: SessionMcpServerMetadata[];
};

export type FrozenCreationInitiator = {
  initiator?: TurnInitiator;
  context?: TurnInitiatorContext;
  actor?: Extract<SessionCommandActor, { type: "agent_attempt" }>;
};

function serviceInitiatorForGrant(grant: AccessGrant): {
  initiator: ServiceTurnInitiator;
  context: ServiceTurnInitiatorContext;
} | null {
  if (!grant.serviceInitiator) {
    if (grant.serviceInitiatorContext) {
      throw new HTTPException(403, {
        message: "service initiator context requires a signed service initiator",
      });
    }
    return null;
  }
  const initiator = ServiceTurnInitiator.safeParse(grant.serviceInitiator);
  if (!initiator.success) {
    throw new HTTPException(403, {
      message: "a delegated command initiator must be a bounded service principal",
    });
  }
  const context = ServiceTurnInitiatorContext.safeParse(grant.serviceInitiatorContext ?? {});
  if (!context.success) {
    throw new HTTPException(403, {
      message: "delegated service initiator context is invalid or reserved",
    });
  }
  const callerTurnId = grant.metadata?.["turnId"];
  const callerAttemptId = grant.metadata?.["attemptId"];
  const callerExecutionGeneration = grant.metadata?.["executionGeneration"];
  if (
    callerTurnId !== undefined ||
    callerAttemptId !== undefined ||
    callerExecutionGeneration !== undefined
  ) {
    throw new HTTPException(403, {
      message: "a service initiator cannot replace an exact agent-attempt initiator",
    });
  }
  return {
    initiator: initiator.data,
    context: context.data,
  };
}

export function creationInitiatorForGrant(grant: AccessGrant): FrozenCreationInitiator {
  const serviceInitiator = serviceInitiatorForGrant(grant);
  const callerSessionId = grant.metadata?.["sessionId"];
  const callerTurnId = grant.metadata?.["turnId"];
  const callerAttemptId = grant.metadata?.["attemptId"];
  const callerExecutionGeneration = grant.metadata?.["executionGeneration"];
  const hasCallerTurnClaim =
    callerTurnId !== undefined ||
    callerAttemptId !== undefined ||
    callerExecutionGeneration !== undefined;
  if (hasCallerTurnClaim) {
    if (
      typeof callerSessionId !== "string" ||
      typeof callerTurnId !== "string" ||
      typeof callerAttemptId !== "string" ||
      typeof callerExecutionGeneration !== "number" ||
      !Number.isSafeInteger(callerExecutionGeneration) ||
      callerExecutionGeneration < 1
    ) {
      throw new HTTPException(403, {
        message: "caller attempt claims are incomplete",
      });
    }
    const actor = {
      type: "agent_attempt",
      sessionId: callerSessionId,
      turnId: callerTurnId,
      attemptId: callerAttemptId,
      executionGeneration: callerExecutionGeneration,
    } as const;
    // The DB create transaction validates this exact attempt and derives the
    // inherited subject under the same locks as the child-session insert.
    return { actor };
  }
  if (serviceInitiator) {
    return serviceInitiator;
  }
  return {
    initiator: {
      kind: "subject",
      subjectId: grant.subjectId,
      ...(grant.subjectLabel ? { label: grant.subjectLabel } : {}),
    },
    context: {},
  };
}

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
      throw new HTTPException(422, {
        message: `invalid credential header name: ${name}`,
      });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      throw new HTTPException(422, {
        message: `duplicate credential header name: ${name}`,
      });
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
    ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
  };
}

function mcpServerConfigFromStoredInput(
  server: CreateSessionMcpServerInput,
): Settings["mcpServers"][number] {
  return {
    id: server.id,
    ...(server.name ? { name: server.name } : {}),
    url: server.url,
    ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
    ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
    cacheToolsList: server.cacheToolsList ?? false,
    ...(server.requireApproval != null ? { requireApproval: server.requireApproval } : {}),
    ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
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
    requireApproval: server.requireApproval,
    ...(server.connectionRef ? { connectionRef: server.connectionRef } : {}),
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
  const encryptionKey = servers.some((server) => Object.keys(server.headers ?? {}).length > 0)
    ? requireVariableSetEncryption(settings)
    : null;
  const existingIds = new Set(settings.mcpServers.map((server) => server.id));
  const seenIds = new Set<string>();
  const runtimeServers: Settings["mcpServers"] = [];
  const dbServers: CreateSessionMcpServerInput[] = [];
  const metadata: SessionMcpServerMetadata[] = [];
  for (const server of servers) {
    if (seenIds.has(server.id)) {
      throw new HTTPException(422, {
        message: `duplicate session MCP server id: ${server.id}`,
      });
    }
    seenIds.add(server.id);
    if (reservedSessionMcpServerIds.has(server.id) || existingIds.has(server.id)) {
      throw new HTTPException(422, {
        message: `MCP server id already exists: ${server.id}`,
      });
    }
    const headers = normalizedSessionMcpCredentialHeaders(server.headers);
    const headersEncrypted = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        encryptVariableSetValue(encryptionKey!, value),
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
      connectionRef: server.connectionRef ?? null,
      headersEncrypted,
    });
    metadata.push({
      id: server.id,
      name: server.name ?? null,
      url: server.url,
      headerNames: Object.keys(headersEncrypted).sort(),
      credentialVersion: 1,
      requireApproval: server.requireApproval ?? false,
      connectionRef: server.connectionRef ?? null,
    });
  }
  return { runtimeServers, dbServers, metadata };
}

function validateInheritedSessionMcpServersForCreate(
  servers: CreateSessionMcpServerInput[],
): ValidatedSessionMcpServers {
  if (servers.length === 0) {
    return { runtimeServers: [], dbServers: [], metadata: [] };
  }
  const seenIds = new Set<string>();
  for (const server of servers) {
    if (seenIds.has(server.id)) {
      throw new HTTPException(422, {
        message: `duplicate inherited session MCP server id: ${server.id}`,
      });
    }
    seenIds.add(server.id);
    if (reservedSessionMcpServerIds.has(server.id)) {
      throw new HTTPException(422, {
        message: `reserved inherited session MCP server id: ${server.id}`,
      });
    }
  }
  // A newly enabled deployment/workspace capability may now reuse an id that
  // belonged to this parent attachment first. Preserve the parent's existing
  // session-overlay precedence instead of making child creation depend on a
  // later workspace setting; settingsWithSessionMcpServerConfigs performs that
  // same overlay for ordinary parent turns.
  return {
    runtimeServers: servers.map(mcpServerConfigFromStoredInput),
    dbServers: servers.map((server) => ({
      ...server,
      headersEncrypted: { ...(server.headersEncrypted ?? {}) },
    })),
    metadata: servers.map((server) => ({
      id: server.id,
      name: server.name ?? null,
      url: server.url,
      headerNames: Object.keys(server.headersEncrypted ?? {}).sort(),
      credentialVersion: 1,
      requireApproval: server.requireApproval ?? false,
      connectionRef: server.connectionRef ?? null,
    })),
  };
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
      throw new HTTPException(422, {
        message: `unknown session MCP server id: ${update.id}`,
      });
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

export type CreateSessionOutcome = {
  session: CreateSessionResponse;
  /** The committed create/start effect represented by this request. */
  outcome: "created" | "repaired" | "replayed";
  /** Backward-compatible replay flag for existing entity-oriented callers. */
  replay: boolean;
  /** True when the request created/repaired start state or committed a new wake revision. */
  changed: boolean;
};

export type CreateSessionRequestOutcome = CreateSessionOutcome & {
  /** Billing telemetry is recorded after the committed session start. */
  usageRecording: "recorded" | "failed";
};

export async function createAndStartSessionWithOutcome(input: {
  requestedSessionId?: string;
  db: Database;
  bus: EventBus;
  workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
  /** Internal database-only composition seam. The exact session shell and this
   * linkage commit together before its first event/turn can be initialized. */
  beforeCreateCommit?: (tx: Database, sessionId: string) => Promise<void>;
  accountId: string;
  workspaceId: string;
  visibility?: "user_private" | "workspace_shared";
  initialMessage: string;
  /** Create the session shell without an initial user event/agent turn. */
  deferInitialTurn?: boolean;
  modelContext?: string | null;
  resources: ResourceRef[];
  skills?: SessionSkill[];
  tools: ToolRef[];
  // Public admission always supplies provenance; optional keeps internal
  // callers that predate durable tool-policy provenance source-compatible
  // during the rolling deploy.
  toolPolicy: SessionToolPolicy;
  clientEventId?: string;
  model: string;
  reasoningEffort: Settings["openaiReasoningEffort"];
  /** Session default Fast/standard; mirrored into metadata when set. */
  latencyMode?: "standard" | "priority" | "fast";
  turnExecutionPolicy: TurnExecutionPolicyV1;
  sandboxBackend: Settings["sandboxBackend"];
  metadata: Record<string, unknown>;
  createdBy?: TurnInitiator;
  createdByContext?: TurnInitiatorContext;
  createdByActor?: Extract<SessionCommandActor, { type: "agent_attempt" }> | null;
  // Names/ids only; the session.created payload never carries variable values.
  variableSet?: { id: string; name: string } | null;
  // The rig + frozen active rig version resolved at create (M3). Both null ⇒ a
  // rig-less session (byte-for-byte today's behavior). Frozen here so a later
  // rig promote never moves an existing session's version.
  rigId?: string | null;
  rigVersionId?: string | null;
  // The workspace channel the session is filed under (rail organization only;
  // resolved workspace-scoped by the caller). Null/omitted ⇒ unfiled (inbox).
  channelId?: string | null;
  goal?: GoalSpec | null;
  // Per-session agent persona/system instructions (org-visible metadata, not a
  // secret). Persisted on the session row and composed system-level AFTER the
  // workspace agentInstructions at turn time; never emitted as a timeline event.
  // Null/omitted ⇒ the session carries none.
  instructions?: string | null;
  // Immutable normalized prompt-policy role. This never derives from a
  // workspace membership role; null retains the bounded metadata.role fallback.
  policyRole?: string | null;
  // Validated against the creating grant before this is called.
  firstPartyMcpPermissions?: Permission[] | null;
  // Model-visible first-party tool names. Authorization remains controlled by
  // firstPartyMcpPermissions and the target resource checks.
  firstPartyMcpTools: FirstPartyMcpToolName[];
  // Encrypted DB rows plus matching safe metadata for create-time per-session
  // MCP servers. Metadata is the only shape emitted in events/responses.
  mcpServers?: CreateSessionMcpServerInput[];
  sessionMcpServers?: SessionMcpServerMetadata[];
  personalConnectionDelegations?: McpPersonalConnectionDelegation[];
  initialPersonalResourceAttachmentIntent?: PersonalResourceAttachmentIntent | null;
  xaiProviderAccountAuthoritySnapshot?: XaiProviderAccountAuthoritySnapshotV1;
  // The manager session spawning this worker (a worker-signed sessionId claim
  // on the creating grant); null for direct API creates and scheduled runs.
  // When set, the worker's terminal-for-now transitions wake this parent.
  parentSessionId?: string | null;
  // Workspace-scoped CREATE idempotency key. When present, a double-fire with
  // the same key (sequential retry OR concurrent race) collapses to a single
  // session. Every caller repairs or re-delivers the winner's one atomic start;
  // the durable initializer prevents duplicate events or turns.
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
  seedTargetSandbox?: {
    sandboxId: string;
    settings: Settings;
    workingDir?: string | null;
    resourceSubjectId?: string | null;
  } | null;
  // Exact actor-private pre-session draft represented by this create. The
  // initializer consumes it only after the first durable runnable unit commits.
  consumeNewSessionDraft?: {
    subjectId: string;
    expectedRevision: number;
    expectedSnapshot: NewSessionDraftSnapshot;
    acceptedSelection: {
      channelId: string | null;
      targetSandboxId: string | null;
      workingDir: string | null;
    };
  } | null;
  rememberNewSessionSelection?: {
    subjectId: string;
    acceptedSelection: {
      channelId: string | null;
      targetSandboxId: string | null;
      workingDir: string | null;
    };
  } | null;
  // A child may lower its inherited nested-agent depth limit freely; increases
  // are authorized by the caller's workspace:admin grant and checked again by
  // the database admission transaction.
  maxNestedAgentDepthOverride?: number | null;
  allowNestedAgentDepthIncrease?: boolean;
  subjectId?: string | null;
}): Promise<CreateSessionOutcome> {
  const sessionMetadata = {
    ...input.metadata,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    ...(input.latencyMode !== undefined ? { latencyMode: input.latencyMode } : {}),
  };
  // Keyed creation is intentionally handled only by the database admission
  // transaction below. Its workspace/key lock replays either the successful
  // session or the committed denial atomically; an application-side lookup
  // cannot serialize those two source tables against an older writer.
  if (input.createIdempotencyKey) {
    const keyedResult = await createSessionWithIdempotencyKeyResult(input.db, {
      ...(input.requestedSessionId ? { requestedSessionId: input.requestedSessionId } : {}),
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      visibility: input.visibility ?? "workspace_shared",
      initialMessage: input.initialMessage,
      initialModelContext: input.modelContext ?? null,
      resources: input.resources,
      skills: input.skills ?? [],
      tools: input.tools,
      toolPolicy: input.toolPolicy,
      metadata: sessionMetadata,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.createdByContext ? { createdByContext: input.createdByContext } : {}),
      createdByActor: input.createdByActor ?? null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      latencyMode: input.latencyMode ?? "standard",
      sandboxBackend: input.sandboxBackend,
      variableSetId: input.variableSet?.id ?? null,
      rigId: input.rigId ?? null,
      rigVersionId: input.rigVersionId ?? null,
      channelId: input.channelId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      firstPartyMcpTools: input.firstPartyMcpTools,
      instructions: input.instructions ?? null,
      policyRole: input.policyRole ?? null,
      parentSessionId: input.parentSessionId ?? null,
      createIdempotencyKey: input.createIdempotencyKey,
      sandboxGroupId: input.sandboxGroupId ?? null,
      ...(input.sandboxOs ? { sandboxOs: input.sandboxOs } : {}),
      mcpServers: input.mcpServers ?? [],
      personalConnectionDelegations: input.personalConnectionDelegations ?? [],
      initialPersonalResourceAttachmentIntent:
        input.initialPersonalResourceAttachmentIntent ?? null,
      ...(input.xaiProviderAccountAuthoritySnapshot
        ? {
            initialXaiProviderAccountAuthoritySnapshot: input.xaiProviderAccountAuthoritySnapshot,
          }
        : {}),
      maxNestedAgentDepthOverride: input.maxNestedAgentDepthOverride ?? null,
      allowNestedAgentDepthIncrease: input.allowNestedAgentDepthIncrease ?? false,
      subjectId: input.subjectId ?? null,
      ...(input.beforeCreateCommit ? { beforeCreateCommit: input.beforeCreateCommit } : {}),
    });
    if (keyedResult.denied) {
      throw new SessionSpawnDeniedError(SessionSpawnDenial.parse(keyedResult.denial));
    }
    const { session: keyed, created } = keyedResult;
    if (!created) {
      const finished = await finishStartSession(
        keyed.temporalWorkflowId ? { ...input, seedTargetSandbox: null } : input,
        keyed,
      );
      return {
        session: finished.session,
        outcome: finished.changed ? "repaired" : "replayed",
        replay: !finished.changed,
        changed: finished.changed,
      };
    }
    const finished = await finishStartSession(input, keyed);
    return {
      session: finished.session,
      outcome: "created",
      replay: false,
      changed: true,
    };
  }
  let session: Session;
  try {
    session = await createSession(input.db, {
      ...(input.requestedSessionId ? { requestedSessionId: input.requestedSessionId } : {}),
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      visibility: input.visibility ?? "workspace_shared",
      initialMessage: input.initialMessage,
      initialModelContext: input.modelContext ?? null,
      resources: input.resources,
      skills: input.skills ?? [],
      tools: input.tools,
      toolPolicy: input.toolPolicy,
      metadata: sessionMetadata,
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.createdByContext ? { createdByContext: input.createdByContext } : {}),
      createdByActor: input.createdByActor ?? null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      latencyMode: input.latencyMode ?? "standard",
      sandboxBackend: input.sandboxBackend,
      variableSetId: input.variableSet?.id ?? null,
      rigId: input.rigId ?? null,
      rigVersionId: input.rigVersionId ?? null,
      channelId: input.channelId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      firstPartyMcpTools: input.firstPartyMcpTools,
      instructions: input.instructions ?? null,
      policyRole: input.policyRole ?? null,
      parentSessionId: input.parentSessionId ?? null,
      sandboxGroupId: input.sandboxGroupId ?? null,
      ...(input.sandboxOs ? { sandboxOs: input.sandboxOs } : {}),
      mcpServers: input.mcpServers ?? [],
      personalConnectionDelegations: input.personalConnectionDelegations ?? [],
      initialPersonalResourceAttachmentIntent:
        input.initialPersonalResourceAttachmentIntent ?? null,
      ...(input.xaiProviderAccountAuthoritySnapshot
        ? {
            initialXaiProviderAccountAuthoritySnapshot: input.xaiProviderAccountAuthoritySnapshot,
          }
        : {}),
      maxNestedAgentDepthOverride: input.maxNestedAgentDepthOverride ?? null,
      allowNestedAgentDepthIncrease: input.allowNestedAgentDepthIncrease ?? false,
      subjectId: input.subjectId ?? null,
      ...(input.beforeCreateCommit ? { beforeCreateCommit: input.beforeCreateCommit } : {}),
    });
  } catch (error) {
    if (error instanceof SessionSpawnDeniedDbError) {
      throw new SessionSpawnDeniedError(SessionSpawnDenial.parse(error.denial));
    }
    throw error;
  }
  const finished = await finishStartSession(input, session);
  return {
    session: finished.session,
    outcome: "created",
    replay: false,
    changed: true,
  };
}

/** Backward-compatible entity-returning create path used by existing callers. */
export async function createAndStartSession(
  input: Parameters<typeof createAndStartSessionWithOutcome>[0],
): Promise<CreateSessionResponse> {
  return (await createAndStartSessionWithOutcome(input)).session;
}

/**
 * Complete or repair the post-insert half of {@link createAndStartSession}.
 * All durable initial state is installed by one idempotent transaction; every
 * caller may then advance and deliver the coalesced wake revision without
 * duplicating the goal, events, or first turn.
 */
async function finishStartSession(
  input: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
    initialMessage: string;
    deferInitialTurn?: boolean;
    modelContext?: string | null;
    resources: ResourceRef[];
    tools: ToolRef[];
    toolPolicy: SessionToolPolicy;
    clientEventId?: string;
    model: string;
    reasoningEffort: Settings["openaiReasoningEffort"];
    turnExecutionPolicy: TurnExecutionPolicyV1;
    sandboxBackend: Settings["sandboxBackend"];
    variableSet?: { id: string; name: string } | null;
    goal?: GoalSpec | null;
    sessionMcpServers?: SessionMcpServerMetadata[];
    seedTargetSandbox?: {
      sandboxId: string;
      settings: Settings;
      workingDir?: string | null;
      resourceSubjectId?: string | null;
    } | null;
    consumeNewSessionDraft?: {
      subjectId: string;
      expectedRevision: number;
      expectedSnapshot: NewSessionDraftSnapshot;
      acceptedSelection: {
        channelId: string | null;
        targetSandboxId: string | null;
        workingDir: string | null;
      };
    } | null;
    rememberNewSessionSelection?: {
      subjectId: string;
      acceptedSelection: {
        channelId: string | null;
        targetSandboxId: string | null;
        workingDir: string | null;
      };
    } | null;
  },
  session: Session,
): Promise<{ session: CreateSessionResponse; changed: boolean }> {
  // Create-time machine targeting (A-2a): seed the active-sandbox pointer BEFORE
  // the atomic initial turn transaction, so the FIRST turn routes to the chosen
  // machine. swapActiveSandbox does
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
      ...(input.seedTargetSandbox.resourceSubjectId
        ? { subjectId: input.seedTargetSandbox.resourceSubjectId }
        : {}),
    };
    const seeded = await swapActiveSandbox(
      {
        db: input.db,
        settings: input.seedTargetSandbox.settings,
        bus: input.bus,
      },
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
  const started = await initializeSessionStartAtomically(input.db, {
    accountId: session.accountId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    reasoningEffortFallback: input.reasoningEffort,
    turnExecutionPolicy: input.turnExecutionPolicy,
    createdEventPayload: {
      toolPolicy: input.toolPolicy,
      ...(input.variableSet
        ? {
            variableSetId: input.variableSet.id,
            variableSetName: input.variableSet.name,
          }
        : {}),
      ...(input.sessionMcpServers?.length ? { mcpServers: input.sessionMcpServers } : {}),
    },
    goal: input.goal
      ? {
          text: input.goal.text,
          ...(input.goal.successCriteria !== undefined
            ? { successCriteria: input.goal.successCriteria }
            : {}),
          ...(input.goal.rootConstraints !== undefined
            ? { rootConstraints: input.goal.rootConstraints }
            : {}),
          ...(input.goal.maxAutoContinuations !== undefined
            ? { maxAutoContinuations: input.goal.maxAutoContinuations }
            : {}),
          ...(input.goal.mutationPolicy !== undefined
            ? { mutationPolicy: input.goal.mutationPolicy }
            : {}),
        }
      : null,
    consumeNewSessionDraft: input.consumeNewSessionDraft ?? null,
    rememberNewSessionSelection: input.rememberNewSessionSelection ?? null,
    deferInitialTurn: input.deferInitialTurn === true,
  });
  await publishDurableSessionEvents(input.bus, session.workspaceId, session.id, started.events);
  if (started.workflowWakeRevision !== null) {
    await input.workflowClient.wakeSessionWorkflow({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      workflowId: started.temporalWorkflowId,
      wakeRevision: started.workflowWakeRevision,
    });
  }
  const persisted = await requireSession(input.db, session.workspaceId, session.id);
  const initialTurnId =
    started.turn?.id ??
    (await listSessionTurns(input.db, session.workspaceId, session.id, 1))[0]?.id ??
    null;
  return {
    session: {
      ...persisted,
      ...(session.tenancy ? { tenancy: session.tenancy } : {}),
      initialTurnId,
    },
    changed: started.changed,
  };
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
 * `model` is the effective value selected by the caller's boundary. Top-level
 * omission defaults to `settings.openaiModel`; child-session omission inherits
 * the worker-signed calling turn before reaching this helper. Centralized here
 * so every model-carrying choke point
 * (create-session, user-message/turn-accept, queued-turn update, and
 * scheduled-task agentConfig — a scheduled task is a session the worker runs
 * later) and the MCP surfaces that share them validate identically and cannot
 * drift.
 */
export function canonicalConfiguredModel(
  settings: Settings,
  model: string | null | undefined,
): string | null | undefined {
  if (model === null || model === undefined) {
    return model;
  }
  const canonicalModel = canonicalizeConfiguredModelId(settings, model);
  if (configuredAllowedModels(settings).includes(canonicalModel)) {
    return canonicalModel;
  }
  // Codex subscription models (codex/<slug>) are injected per-workspace by the
  // worker overlay at turn time, so they are never in the deployment-global
  // allow-list. Accept them at the edge when the feature is enabled — the picker
  // only surfaces them for a connected workspace, and the worker enforces the
  // actual connection (an unconnected workspace fails the turn with a clear
  // "no Codex subscription connected" error rather than a misleading 422 here).
  if (settings.codexSubscriptionEnabled && canonicalModel.startsWith(CODEX_MODEL_ID_PREFIX)) {
    return canonicalModel;
  }
  // SuperGrok subscription models are also discovered per workspace rather
  // than stored in the deployment-global allow-list. Connection availability
  // is enforced by the workspace policy and worker; this edge guard only needs
  // to admit the product-model namespace when the feature is enabled.
  if (
    settings.supergrokSubscriptionEnabled &&
    canonicalModel.startsWith(XAI_SUBSCRIPTION_MODEL_ID_PREFIX)
  ) {
    return canonicalModel;
  }
  if (canonicalModel.startsWith(WORKSPACE_GATEWAY_MODEL_ID_PREFIX)) {
    return canonicalModel;
  }
  throw new HTTPException(422, { message: `model is not available: ${model}` });
}

export function assertConfiguredModel(settings: Settings, model: string | null | undefined): void {
  canonicalConfiguredModel(settings, model);
}

export const CODEX_COMPACTION_V2_PROVIDER_LOCKED = "codex_compaction_v2_provider_locked" as const;

/** Session is frozen on Codex remote compaction v2; non-Codex models are refused. */
export class CodexCompactionV2ProviderLockedError extends Error {
  readonly code = CODEX_COMPACTION_V2_PROVIDER_LOCKED;
  readonly productModelId: string;

  constructor(productModelId: string) {
    super(
      `session is locked to Codex remote compaction v2; model "${productModelId}" is not a Codex subscription model`,
    );
    this.name = "CodexCompactionV2ProviderLockedError";
    this.productModelId = productModelId;
  }
}

/**
 * Fail closed when a remote_v2 session would run a non-Codex product model.
 * Portable sessions and non-Codex sessions keep free mid-session provider swap.
 */
export function assertSessionAllowsProductModel(
  session: Pick<Session, "codexCompactionMode">,
  productModelId: string | null | undefined,
): void {
  if (productModelId === null || productModelId === undefined) return;
  if (session.codexCompactionMode !== "remote_v2") return;
  if (isCodexBilledModel(productModelId)) return;
  throw new CodexCompactionV2ProviderLockedError(productModelId);
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
  const canonicalModel = canonicalConfiguredModel(settings, model);
  if (canonicalModel === null || canonicalModel === undefined) {
    return;
  }
  const policy = await getWorkspaceModelPolicy(db, workspaceId);
  if (!policy) {
    return;
  }
  const providerId = policyProviderIdForModel(settings, canonicalModel);
  const verdict = evaluateWorkspaceModelPolicy(policy, {
    providerId,
    modelId: canonicalModel,
  });
  if (!verdict.allowed) {
    throw new HTTPException(422, {
      message:
        verdict.reason === "provider"
          ? `model "${canonicalModel}" is not allowed by this workspace's model policy: provider "${providerId}" is not in the allowed providers`
          : `model "${canonicalModel}" is not allowed by this workspace's model policy`,
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
  annotations?: TimelineAnnotation[];
  modelContext?: string | null;
  resources: ResourceRef[];
  model?: string | null;
  reasoningEffort?: Settings["openaiReasoningEffort"] | null;
  latencyMode?: "standard" | "priority" | "fast" | null;
  clientEventId?: string;
  mcpCredentialUpdates?: UpdateSessionMcpServerCredentialsInput[];
  personalConnectionDelegations?: McpPersonalConnectionDelegation[];
  personalResourceAttachment?: PersonalResourceAttachmentIntent;
  delivery?: "send" | "steer";
  origin?: "human" | "operator";
  actor?: string;
  actorLabel?: string;
  commandActor?: SessionCommandActor;
  controlEtag?: string | null;
  expectedDraftRevision?: number | null;
  reasoningEffortFallback?: Settings["openaiReasoningEffort"];
  turnExecutionPolicy: TurnExecutionPolicyV1;
  recordAgentRunUsage?: boolean;
  schedulePostCommit?: (task: () => Promise<void>) => void;
}): Promise<{
  accepted: SessionEvent;
  turn: SessionTurn;
  draft: ComposerDraft | null;
  interruptionCount: number;
  replay: boolean;
}> {
  const { db, bus, workflowClient, settings, accountId, workspaceId, sessionId } = input;
  const requestedModel = canonicalConfiguredModel(settings, input.model ?? null) ?? null;
  const requestedReasoningEffort = input.reasoningEffort ?? null;
  // Reject an explicit per-message model the host does not expose; an omitted
  // model inherits the session's model downstream (always a configured id).
  assertConfiguredModel(settings, requestedModel);
  await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, requestedModel);
  const sessionForModelGate = await requireSession(db, workspaceId, sessionId);
  const effectiveModelForGate = requestedModel ?? sessionForModelGate.model;
  try {
    assertSessionAllowsProductModel(sessionForModelGate, effectiveModelForGate);
  } catch (error) {
    if (error instanceof CodexCompactionV2ProviderLockedError) {
      throw new HTTPException(422, { message: error.message, cause: error });
    }
    throw error;
  }
  const operationKey = input.clientEventId ?? crypto.randomUUID();
  let result;
  try {
    result = await runIdempotentPersistenceTransaction(
      {
        stage: "session.prompt.submit",
        eventTypes: ["user.message", "turn.queued", "session.status.changed"],
        maxAttempts: 3,
      },
      async () =>
        await withWorkspaceSubjectSessionActivityRls(
          db,
          workspaceId,
          input.actor ?? accountId,
          (scoped) =>
            submitHumanPromptInTransaction(scoped, {
              accountId,
              workspaceId,
              sessionId,
              subjectId: input.actor ?? accountId,
              ...(input.actorLabel ? { subjectLabel: input.actorLabel } : {}),
              actor: input.commandActor ?? {
                type: "human",
                subjectId: input.actor ?? accountId,
              },
              operationKey,
              delivery: input.delivery ?? "send",
              controlEtag: input.controlEtag ?? null,
              expectedDraftRevision: input.expectedDraftRevision ?? null,
              text: input.text,
              annotations: input.annotations ?? [],
              modelContext: input.modelContext ?? null,
              resources: input.resources,
              model: requestedModel,
              reasoningEffort: requestedReasoningEffort,
              latencyMode: input.latencyMode ?? null,
              reasoningEffortFallback:
                input.reasoningEffortFallback ?? settings.openaiReasoningEffort,
              turnExecutionPolicy: input.turnExecutionPolicy,
              source: input.origin === "operator" ? "api" : "user",
              ...(input.recordAgentRunUsage !== undefined
                ? { recordAgentRunUsage: input.recordAgentRunUsage }
                : {}),
              personalConnectionDelegations: input.personalConnectionDelegations ?? [],
              ...(input.personalResourceAttachment
                ? {
                    personalResourceAttachment: input.personalResourceAttachment,
                  }
                : {}),
              mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
              controlLockTimeoutMs: workspaceControlRequestLockTimeoutMs(),
            }),
        ),
    );
  } catch (error) {
    if (error instanceof WorkspaceControlBusyError) {
      // Bounded control-prefix wait expired before any write; the request may
      // be retried. The API layer renders the retryable 503 envelope.
      throw error;
    }
    if (error instanceof PersonalResourceAttachmentAcceptanceError) {
      throw new HTTPException(
        error.kind === "invalid" ? 422 : error.kind === "forbidden" ? 403 : 409,
        { message: error.message, cause: error },
      );
    }
    if (
      error instanceof QueueCommandConflictError ||
      error instanceof SessionControlConflictError
    ) {
      throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof Error && error.message.includes("cancelled")) {
      throw new HTTPException(409, { message: error.message });
    }
    if (error instanceof Error && error.message.startsWith("Unknown session MCP server")) {
      throw new HTTPException(422, { message: error.message });
    }
    throw error;
  }
  const postCommitTask = async () => {
    try {
      await publishDurableSessionEvents(bus, workspaceId, sessionId, result.events);
      if (result.workspaceControlEventId) {
        const controlEvent = await getWorkspaceControlEvent(
          db,
          workspaceId,
          result.workspaceControlEventId,
        );
        if (!controlEvent) {
          throw new Error(
            `Committed workspace control event disappeared: ${result.workspaceControlEventId}`,
          );
        }
        await publishDurableWorkspaceControlEvent(bus, workspaceId, controlEvent);
      }
    } catch {
      console.warn("[sessions] prompt event fanout failed; durable rows remain replayable", {
        errorClass: "PromptEventFanoutOperationError",
        errorCode: "session_prompt_event_fanout_failed",
        origin: "core",
      });
    }
    try {
      await workflowClient.wakeSessionWorkflow({
        accountId,
        workspaceId,
        sessionId,
        workflowId: result.turn.temporalWorkflowId,
        wakeRevision: result.wakeRevision,
        ...((input.delivery ?? "send") === "steer" || result.interruptionCount > 0
          ? { interruptionRequested: true }
          : {}),
      });
    } catch {
      console.warn("[sessions] workflow wake failed; durable outbox will retry", {
        errorClass: "WorkflowWakeOperationError",
        errorCode: "session_workflow_wake_failed",
        origin: "core",
      });
    }
  };
  const schedulePostCommit =
    input.schedulePostCommit ??
    ((task: () => Promise<void>) => {
      void task();
    });
  try {
    schedulePostCommit(postCommitTask);
  } catch {
    console.warn("[sessions] prompt post-commit scheduling failed; durable recovery remains", {
      errorClass: "PromptPostCommitScheduleError",
      errorCode: "session_prompt_post_commit_schedule_failed",
      origin: "core",
    });
  }
  return {
    accepted: result.accepted,
    turn: result.turn,
    draft: result.draft
      ? {
          revision: result.draft.revision,
          text: result.draft.text,
          annotations: DraftTimelineAnnotations.parse(result.draft.annotations),
          resources: result.draft.resources as ResourceRef[],
          model: result.draft.model,
          reasoningEffort: result.draft.reasoningEffort as ReasoningEffort,
          latencyMode: result.draft.latencyMode as ComposerDraft["latencyMode"],
          sourceTurnId: result.draft.sourceTurnId,
          sourceTurnVersion: result.draft.sourceTurnVersion,
          updatedAt: result.draft.updatedAt.toISOString(),
        }
      : null,
    interruptionCount: result.interruptionCount,
    replay: result.replay,
  };
}

/**
 * Full create-session flow shared by `POST /sessions` and the first-party MCP
 * `session_create` tool: payload validation, resource/tool/variableSet
 * checks, usage limits, session start, and usage recording. `rawPayload` is
 * the unparsed request body so absent-vs-empty execution-context fields keep
 * their meaning: a child inherits omitted resources/tools/mcpServers from its
 * trusted immediate parent, while explicit arrays (including []) win. A
 * top-level create with omitted tools applies workspace-default capability MCPs.
 */
export function resolveChildGoalFromAcceptedSnapshot(
  goal: GoalSpec,
  parentGoalSnapshot: SessionGoalSnapshot,
): GoalSpec {
  const inheritedRootConstraints =
    parentGoalSnapshot.state === "none" ? [] : parentGoalSnapshot.rootConstraints;
  const requestedRootConstraints = goal.rootConstraints;
  if (
    requestedRootConstraints?.some((constraint) => !inheritedRootConstraints.includes(constraint))
  ) {
    throw new Error(
      "child goal rootConstraints must be an exact subset of the calling turn's frozen root constraints",
    );
  }
  return {
    ...goal,
    rootConstraints: requestedRootConstraints ?? inheritedRootConstraints,
  };
}

export function resolveSessionCreateVisibility(input: {
  requestedVisibility: "private" | "workspace";
  visibilityProvided: boolean;
  parentVisibility: "user_private" | "workspace_shared" | null;
  personalWorkspace?: boolean;
}): "user_private" | "workspace_shared" {
  if (input.parentVisibility === "user_private") {
    if (input.visibilityProvided && input.requestedVisibility !== "private") {
      throw new Error("A private parent cannot create a workspace-visible child");
    }
    return "user_private";
  }
  if (input.parentVisibility === "workspace_shared") {
    if (input.visibilityProvided && input.requestedVisibility === "private") {
      throw new Error("A workspace-visible parent cannot create a private child");
    }
    return "workspace_shared";
  }
  if (input.personalWorkspace) return "user_private";
  return input.requestedVisibility === "private" ? "user_private" : "workspace_shared";
}

export async function createSessionForRequestWithOutcome(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  rawPayload: unknown,
  authorization?: AccessGrantAuthorization,
): Promise<CreateSessionRequestOutcome> {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const payload = CreateSessionRequest.parse(rawPayload);
  const visibilityProvided = hasOwnProperty(rawPayload, "visibility");
  let personalWorkspace = false;
  if (!grant.metadata?.["sessionId"] && authorization?.canonicalManagedHumanSession) {
    const policy = await getManagedHumanPrivateSessionCreatePolicy(
      deps,
      authorization,
      workspaceId,
    );
    personalWorkspace = policy.personalWorkspace;
  }
  if ((payload.visibility === "private" || personalWorkspace) && !grant.metadata?.["sessionId"]) {
    if (!authorization) {
      throw new HTTPException(403, {
        message: "managed human session required",
      });
    }
    if (!personalWorkspace && !payload.idempotencyKey) {
      // A committed keyed success must replay after an owner/admin disables
      // new organization-private creates. The database admission transaction
      // checks the durable success/denial ledger before opening the mutable
      // private-create capability; fresh keys still fail closed there.
      await requireManagedHumanPrivateSessionCreate(deps, authorization, workspaceId);
    }
    if (payload.sandbox === "shared" || typeof payload.sandbox === "object") {
      throw new HTTPException(422, {
        message: "Only-me sessions require their own sandbox",
      });
    }
  }
  if (hasReservedOpenGeniSlackBotSessionMetadata(payload.metadata)) {
    throw new HTTPException(422, {
      message: `${OPENGENI_SLACK_BOT_SESSION_METADATA_KEY} is reserved for scheduler routing`,
    });
  }
  // A committed keyed denial is the idempotent outcome even if mutable
  // resources, policy, authorization, or budget have changed since the first
  // attempt. Replay it before any of those checks, just as a keyed successful
  // session is returned rather than recreated later in createAndStartSession.
  if (payload.idempotencyKey) {
    const denial = await getSessionSpawnDenialByIdempotencyKey(
      db,
      workspaceId,
      payload.idempotencyKey,
    );
    if (denial) {
      throw new SessionSpawnDeniedError(SessionSpawnDenial.parse(denial));
    }
  }
  await requireAtomicPersonalResourceAttachment(
    deps,
    authorization,
    workspaceId,
    payload.personalResourceAttachment,
    false,
  );
  // Parent linkage and execution-context inheritance come ONLY from the
  // worker-signed sessionId claim. A caller cannot nominate a parent in the
  // payload, so inheriting an existing repository/tool/credential snapshot does
  // not turn sessions:create into arbitrary cross-session read authority.
  const parentSessionId =
    typeof grant.metadata?.["sessionId"] === "string"
      ? (grant.metadata["sessionId"] as string)
      : null;
  if (parentSessionId) {
    try {
      await requireSessionAuthorization(deps, grant, {
        sessionId: parentSessionId,
        operation: "session.child.create",
        surface: "core",
      });
    } catch (error) {
      if (error instanceof SessionAuthorizationDeniedError) {
        throw new HTTPException(403, { message: error.message, cause: error });
      }
      throw error;
    }
  }
  const parentSession = parentSessionId ? await getSession(db, workspaceId, parentSessionId) : null;
  if (parentSessionId && !parentSession) {
    throw new HTTPException(404, {
      message: `parent session not found in workspace: ${parentSessionId}`,
    });
  }
  const parentAuthority = parentSession
    ? await getSessionAuthorityProjection(db, workspaceId, parentSession.id)
    : null;
  if (parentSession && !parentAuthority) {
    throw new HTTPException(403, {
      message: "parent session authority is unavailable",
    });
  }
  let effectiveVisibility: "user_private" | "workspace_shared";
  try {
    effectiveVisibility = resolveSessionCreateVisibility({
      requestedVisibility: personalWorkspace ? "private" : payload.visibility,
      visibilityProvided: personalWorkspace || visibilityProvided,
      parentVisibility: parentAuthority?.visibility ?? null,
      personalWorkspace,
    });
  } catch (error) {
    throw new HTTPException(422, {
      message: error instanceof Error ? error.message : "invalid child visibility",
    });
  }
  const creationInitiator = creationInitiatorForGrant(grant);
  const parentCallingTurn =
    parentSession && creationInitiator.actor
      ? await getSessionTurnForAttempt(
          db,
          workspaceId,
          parentSession.id,
          creationInitiator.actor.attemptId,
        )
      : null;
  if (
    creationInitiator.actor &&
    (!parentCallingTurn || parentCallingTurn.sessionId !== parentSession?.id)
  ) {
    throw new HTTPException(403, {
      message: "caller attempt does not belong to the parent session",
    });
  }
  let effectiveGoal = payload.goal;
  if (parentSession && payload.goal) {
    try {
      effectiveGoal = resolveChildGoalFromAcceptedSnapshot(
        payload.goal,
        parentCallingTurn?.goalSnapshot ?? {
          state: "none",
          capturedAt: "unavailable",
        },
      );
    } catch (error) {
      throw new HTTPException(422, {
        message: error instanceof Error ? error.message : "invalid child goal root constraints",
      });
    }
  }
  const personalResourceSubjectId = creationInitiator.actor
    ? (await requireLiveAgentAttemptAuthorization(db, grant, creationInitiator.actor.sessionId))
        .initiatingHumanSubjectId
    : grant.subjectId;
  const xaiProviderAccountAuthoritySnapshot =
    parentSession && creationInitiator.actor
      ? await getSessionTurnXaiProviderAccountAuthoritySnapshot(
          db,
          workspaceId,
          parentSession.id,
          creationInitiator.actor.turnId,
        )
      : undefined;
  const connectionDelegationSource = personalConnectionDelegationSourceForGrant(grant);
  const inheritedPersonalConnectionDelegations =
    connectionDelegationSource.kind === "turn"
      ? await getSessionTurnPersonalConnectionDelegations(
          db,
          workspaceId,
          connectionDelegationSource.sessionId,
          connectionDelegationSource.turnId,
        )
      : null;
  const capabilityRuntimeSettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
    inheritedPersonalConnectionDelegations
      ? {
          personalConnectionDelegations: inheritedPersonalConnectionDelegations,
        }
      : { subjectId: grant.subjectId },
  );
  const sessionMcpServers = hasOwnProperty(rawPayload, "mcpServers")
    ? validateSessionMcpServersForCreate(capabilityRuntimeSettings, grant, payload.mcpServers)
    : parentSession
      ? validateInheritedSessionMcpServersForCreate(
          await listSessionMcpServersForChildInheritance(db, workspaceId, parentSession.id),
        )
      : validateSessionMcpServersForCreate(capabilityRuntimeSettings, grant, payload.mcpServers);
  const runtimeSettings = settingsWithSessionMcpServerConfigs(
    capabilityRuntimeSettings,
    sessionMcpServers.runtimeServers,
  );
  const resources = normalizeResources(
    hasOwnProperty(rawPayload, "resources")
      ? payload.resources
      : (parentSession?.resources ?? payload.resources),
  );
  const skills = hasOwnProperty(rawPayload, "skills")
    ? payload.skills
    : (parentSession?.skills ?? payload.skills);
  const toolsProvided = hasOwnProperty(rawPayload, "tools");
  // Visibility became durable draft state after older clients had already
  // written rows without it. Compare it only when the create request supplied
  // the field explicitly; the parsed schema default must not manufacture a
  // mismatch for a legacy draft.
  const requestedTools = validateToolRefs(
    toolsProvided ? payload.tools : (parentSession?.tools ?? payload.tools),
    runtimeSettings,
  );
  let selectedTools: ToolRef[];
  let toolPolicy: SessionToolPolicy;
  if (parentSession) {
    const parentTracksWorkspaceDefaults = parentSession.toolPolicy?.mode === "workspace_default";
    const parentEffective = withFirstPartyTools(
      parentTracksWorkspaceDefaults
        ? withDefaultEnabledCapabilityMcpTools(
            availableToolRefs(parentSession.tools, runtimeSettings),
            settings,
            runtimeSettings,
          )
        : parentSession.tools,
      runtimeSettings,
    );
    if (toolsProvided) {
      assertToolRefsSubset(
        requestedTools,
        parentEffective,
        "child tools may only narrow the parent session tool policy",
      );
      selectedTools = requestedTools;
      toolPolicy = {
        mode: "explicit",
        inheritedFromSessionId: parentSession.id,
      };
    } else {
      selectedTools = parentEffective;
      toolPolicy = {
        mode: parentTracksWorkspaceDefaults ? "workspace_default" : "inherited",
        inheritedFromSessionId: parentSession.id,
      };
    }
  } else if (toolsProvided) {
    selectedTools = requestedTools;
    toolPolicy = { mode: "explicit", inheritedFromSessionId: null };
  } else {
    selectedTools = withDefaultEnabledCapabilityMcpTools(
      requestedTools,
      settings,
      capabilityRuntimeSettings,
    );
    toolPolicy = { mode: "workspace_default", inheritedFromSessionId: null };
  }
  // The first-party MCP server is attached to EVERY session. Registration is
  // independently intersected with the exact model-visible selection and the
  // tool's permission/target authorization predicate, so attachment alone
  // exposes nothing.
  const tools = withFirstPartyTools(selectedTools, runtimeSettings);
  await validateGitHubRepositorySelection(db, workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, {
      message: "object storage is not configured",
    });
  }
  await validateFileResources(db, grant.accountId, workspaceId, grant.subjectId, resources);
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
  // RIG BINDING (M3). Resolve the rig this session rides — a UUID binds that
  // rig, null explicitly opts out, and omission inherits the workspace default
  // (workspaces.default_rig_id) — then FREEZE both the rig id and its currently-
  // ACTIVE version onto the row.
  // The session then rides that exact version for its whole life; a later
  // promote never moves it. Rig-less (both null) when neither resolves, which is
  // byte-for-byte today's behavior (zero extra work, zero row change).
  //   - An EXPLICIT unknown/inactive rigId is a caller error → 422.
  //   - A stale workspace-default rig (deleted → FK-nulled, or somehow with no
  //     active version) degrades SILENTLY to rig-less: an operator-side default
  //     must never brick every create in the workspace.
  const requestedRigId =
    payload.rigId === undefined ? await getWorkspaceDefaultRigId(db, workspaceId) : payload.rigId;
  let frozenRigId: string | null = null;
  let frozenRigVersionId: string | null = null;
  if (requestedRigId) {
    const rig = await getRig(db, grant, requestedRigId);
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
      for (const defaultVariableSetId of new Set(rig.activeVersion.defaultVariableSetIds)) {
        await validateVariableSetAttachment(
          { settings, db },
          grant,
          workspaceId,
          defaultVariableSetId,
        );
      }
      frozenRigId = rig.id;
      frozenRigVersionId = rig.activeVersion.id;
    }
  }
  // CHANNEL FILING. Pure rail organization: a UUID files the session into that
  // workspace channel, omission/null leaves it unfiled (inbox). Resolved
  // workspace-scoped so a foreign channel id can never attach; an explicit
  // unknown channelId is a caller error → 422.
  let channelId: string | null = null;
  if (payload.channelId) {
    const channel = await getChannel(db, workspaceId, payload.channelId);
    if (!channel) {
      throw new HTTPException(422, {
        message: `unknown channelId: ${payload.channelId}`,
      });
    }
    channelId = channel.id;
  }
  // A spawned worker is causally part of the exact turn that created it. Omitted
  // execution policy fields therefore inherit that calling turn rather than the
  // deployment defaults. This is especially important for Codex subscription
  // managers: falling back to the deployment model would silently move a child
  // onto the OpenGeni-credits billing path. Legacy session-bound grants without
  // exact attempt claims fall back to the parent session's persisted defaults.
  const inheritedModel = parentCallingTurn?.model ?? parentSession?.model ?? settings.openaiModel;
  const model = canonicalConfiguredModel(settings, payload.model ?? inheritedModel);
  if (model === null || model === undefined) {
    throw new Error("effective session model unexpectedly resolved to null");
  }
  // Session creation persists the EFFECTIVE model — the explicit selection,
  // inherited calling-turn model, or deployment default — so the policy must
  // vet that effective value, not just explicit ones (a restricted workspace's
  // inherited/default-model session would otherwise be born blocked).
  await assertWorkspaceModelPolicyAllows(db, settings, workspaceId, model);
  const inheritedReasoningEffort =
    parentCallingTurn?.reasoningEffort ??
    parentSession?.reasoningEffort ??
    settings.openaiReasoningEffort;
  const inheritedLatencyMode =
    parentCallingTurn?.latencyMode ?? parentSession?.latencyMode ?? "standard";
  const reasoningEffort = payload.reasoningEffort ?? inheritedReasoningEffort;
  const latencyMode = payload.latencyMode ?? inheritedLatencyMode;
  if (payload.expectedNewSessionDraftRevision !== undefined && payload.rigId === null) {
    throw new HTTPException(409, {
      message: "The submitted session options are not represented by the new-session draft",
    });
  }
  const expectedNewSessionDraftSnapshot: NewSessionDraftSnapshot | null =
    payload.expectedNewSessionDraftRevision !== undefined
      ? {
          text: payload.initialMessage ?? "",
          resources,
          tools: toolsProvided ? requestedTools : [],
          toolsProvided,
          model,
          reasoningEffort,
          latencyMode,
          options: {
            ...(visibilityProvided ? { visibility: payload.visibility } : {}),
            ...(payload.sandboxBackend ? { sandboxBackend: payload.sandboxBackend } : {}),
            ...(payload.targetSandboxId ? { targetSandboxId: payload.targetSandboxId } : {}),
            ...(payload.workingDir ? { workingDir: payload.workingDir } : {}),
            ...(payload.variableSetId ? { variableSetId: payload.variableSetId } : {}),
            ...(payload.rigId ? { rigId: payload.rigId } : {}),
            ...(payload.goal ? { goal: payload.goal } : {}),
            ...(payload.firstPartyMcpPermissions
              ? { firstPartyMcpPermissions: payload.firstPartyMcpPermissions }
              : {}),
            ...(payload.firstPartyMcpTools
              ? { firstPartyMcpTools: payload.firstPartyMcpTools }
              : {}),
          },
        }
      : null;
  const inheritedFromParent = parentSession !== null;
  const turnExecutionPolicy = resolveTurnExecutionPolicyV1(settings, {
    modelId: model,
    requestedModelId: payload.model ?? null,
    modelSource:
      payload.model === undefined
        ? inheritedFromParent
          ? "continuation"
          : "deployment"
        : "explicit",
    reasoningEffort,
    reasoningSource:
      payload.reasoningEffort === undefined
        ? inheritedFromParent
          ? "continuation"
          : "deployment"
        : "explicit",
    latencyMode,
    latencyModeSource:
      payload.latencyMode === undefined
        ? inheritedFromParent
          ? "continuation"
          : "deployment"
        : "explicit",
  });
  // Parent linkage was resolved above, before context validation. A child with
  // no explicit permission override inherits the creating session's effective
  // grant instead of silently expanding to standalone worker defaults.
  // A session's first-party MCP token can carry a non-default permission set
  // (how an operator hands a manager-style session the orchestration tools),
  // but never one out-ranking its creator: every requested permission must be
  // held by the creating grant. A top-level omission keeps the deployment's
  // normal worker defaults. A child omission inherits its creator's exact
  // effective grant, preserving a host/operator's narrowed capability boundary
  // through the whole session tree.
  const parentFirstPartyMcpPermissions = parentSession
    ? [...(parentSession.firstPartyMcpPermissions ?? DEFAULT_FIRST_PARTY_MCP_PERMISSIONS)]
    : null;
  if (
    parentFirstPartyMcpPermissions &&
    payload.firstPartyMcpPermissions?.some(
      (permission) => !hasPermission(parentFirstPartyMcpPermissions, permission),
    )
  ) {
    throw new HTTPException(403, {
      message: "child first-party MCP permissions may only narrow the parent session grant",
    });
  }
  // A worker-signed creator may itself carry less authority than its parent
  // session (for example a narrowly delegated spawn token). Inherit the
  // intersection in the shared canonical default order so null/default parent
  // policies cannot expand when runtime signing resolves them.
  let firstPartyMcpPermissions =
    payload.firstPartyMcpPermissions ??
    (parentFirstPartyMcpPermissions
      ? parentFirstPartyMcpPermissions.filter((permission) =>
          hasPermission(grant.permissions, permission),
        )
      : null);
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
  // A goal-bearing session with an explicit/effective permission set must
  // already carry goals:manage. Without it the worker cannot stop its own
  // continuation loop, but silently adding it would violate the child
  // authority contract: a child inherits or narrows its creator's exact grant
  // and never gains an unrequested permission. Top-level omission remains the
  // deployment's worker default, which includes the goal tools.
  if (
    effectiveGoal &&
    firstPartyMcpPermissions &&
    !firstPartyMcpPermissions.includes("goals:manage")
  ) {
    throw new HTTPException(422, {
      message:
        "goal-bearing sessions require goals:manage in the resulting first-party MCP permission set",
    });
  }
  // Tool visibility is independent from permission authority. A child that
  // omits the field inherits the parent's exact effective selection; a
  // top-level omission selects the safe non-connector default catalog.
  const deploymentFirstPartyMcpToolPolicy = resolveFirstPartyMcpToolPolicy(settings);
  const disallowedFirstPartyMcpTool = payload.firstPartyMcpTools?.find(
    (tool) => !deploymentFirstPartyMcpToolPolicy.allowed.includes(tool),
  );
  if (disallowedFirstPartyMcpTool) {
    throw new HTTPException(422, {
      message: `first-party MCP tool is disabled by deployment policy: ${disallowedFirstPartyMcpTool}`,
    });
  }
  const firstPartyMcpTools = resolveFirstPartyMcpToolsForCreate(
    payload.firstPartyMcpTools,
    parentSession ? parentSession.firstPartyMcpTools : undefined,
    deploymentFirstPartyMcpToolPolicy,
  );
  const googleDrivePublicationEnabled =
    firstPartyMcpTools.includes("editable_artifact_export") &&
    firstPartyMcpTools.includes("editable_artifact_export_status") &&
    (!firstPartyMcpPermissions?.length ||
      (firstPartyMcpPermissions.includes("artifacts:read") &&
        firstPartyMcpPermissions.includes("artifacts:publish")));
  const atlassianEnabled =
    firstPartyMcpTools.some((tool) => tool.startsWith("atlassian_")) &&
    (!firstPartyMcpPermissions?.length || firstPartyMcpPermissions.includes("connections:read"));
  const personalConnectionDelegations = await freezePersonalConnectionDelegations({
    db,
    workspaceId,
    settings: runtimeSettings,
    tools,
    resources,
    source: connectionDelegationSource,
    authoritySelections: payload.connectionAuthorities,
    googleDrivePublicationEnabled,
    atlassianEnabled,
  });
  if (effectiveGoal) {
    const missingGoalTools = ["goal_update", "goal_progress", "goal_complete", "goal_pause"].filter(
      (name) => !firstPartyMcpTools.includes(name as FirstPartyMcpToolName),
    );
    if (missingGoalTools.length > 0) {
      throw new HTTPException(422, {
        message: `goal-bearing sessions require first-party MCP tools: ${missingGoalTools.join(", ")}`,
      });
    }
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
  // Shared-sandbox placement (addendum 05 §D.2/§D.3, decision I10/OD-S1).
  //
  // The DEFAULT rule is context-dependent and resolved server-side from the
  // TRUSTED claim, never caller-supplied: when `sandbox` is omitted, a session
  // spawned FROM INSIDE a session (parentSessionId present ⇒ a worker-signed
  // sessionId claim) defaults to "shared" (join the creator's box); a top-level
  // create (no parent) defaults to "new" (a private singleton box). Explicit
  // values always win — except a named `targetSandboxId` is a different compute
  // home, not a share of the creator's box. Omission plus a machine target
  // therefore defaults to "new" so the honest-label selfhosted home can fire
  // (a backend:"none" parent has no box to share; inheriting "none" then 422s
  // at seed). Explicit shared/{groupId} plus a machine target is contradictory
  // and 422s rather than silently dropping the target.
  //
  // null sandboxGroupId ⇒ createSession seeds the new row's own id (singleton,
  // today's 1:1 behavior). A shared/{groupId} spawn inherits the box's backend
  // (it is literally the same box; the child cannot pick its own). Cross-
  // workspace sharing is forbidden by construction: getSession/
  // getAnySessionInGroup are RLS-workspace-scoped, so a foreign parent/group
  // returns null → 404; the group uuid is NOT an access boundary, the workspace
  // filter is (stress (e)).
  if (payload.targetSandboxId && payload.sandbox !== undefined && payload.sandbox !== "new") {
    throw new HTTPException(422, {
      message:
        "targetSandboxId requires an own sandbox (omit sandbox or pass 'new'); it cannot join a shared group",
    });
  }
  const sandboxChoice =
    payload.sandbox ?? (payload.targetSandboxId ? "new" : parentSessionId ? "shared" : "new");
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
    if (!parentSession) {
      throw new Error("trusted parent session was not resolved");
    }
    const parent = parentSession;
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
  // Honest-label (Stage-D closure): a session TARGETED at a Connected
  // Machine (a selfhosted sandbox) runs machine-primary every turn, so its HOME
  // sandbox_backend must read "selfhosted" — not the deployment cloud default —
  // so the session row + first turn honestly reflect where the agent runs (the
  // Machines dashboard, the turn's warm-metering, and the file-download plane all
  // key off this). GUARDS: (1) only when not inheriting a shared box
  // (inheritedBackend undefined). Named targetSandboxId already 422s
  // shared/{groupId} and defaults omission to own-box above, so this check is a
  // backstop if those placement rules change; a shared spawn without a target
  // is still literally the creator's box and must NOT be relabeled; (2) only
  // when the target's kind is actually "selfhosted" — targetSandboxId also
  // accepts a first-class MODAL sandbox id (resolveTarget), which must never be
  // mislabeled. A not-found / non-selfhosted / modal target falls through to the
  // default; the seed swap in createAndStartSession still validates
  // ownership/liveness and 422s a bad target. (3) only when the feature flags
  // that make the worker actually take the machine-primary path are ON
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
    const targetSandbox = await getSandbox(
      db,
      personalResourceSubjectId ? { ...grant, subjectId: personalResourceSubjectId } : grant,
      payload.targetSandboxId,
    );
    if (targetSandbox?.kind === "selfhosted") {
      machineHomeBackend = "selfhosted";
      if (targetSandbox.enrollmentId) {
        const enrollment = await getEnrollment(
          db,
          targetSandbox.workspaceId,
          targetSandbox.enrollmentId,
        );
        if (
          enrollment &&
          (enrollment.os === "macos" || enrollment.os === "windows" || enrollment.os === "linux")
        ) {
          machineHomeOs = enrollment.os;
        }
      }
    }
  }
  if (payload.startMode !== "realtime") {
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "agent_run:create",
      quantity: 1,
      model,
    });
  }
  let createOutcome: CreateSessionOutcome;
  try {
    createOutcome = await createAndStartSessionWithOutcome({
      ...(payload.requestedSessionId ? { requestedSessionId: payload.requestedSessionId } : {}),
      db,
      bus,
      workflowClient,
      accountId: grant.accountId,
      workspaceId,
      visibility: effectiveVisibility,
      initialMessage: payload.initialMessage ?? "",
      deferInitialTurn: payload.startMode === "realtime",
      modelContext: payload.modelContext ?? null,
      resources,
      skills,
      tools,
      toolPolicy,
      ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
      model,
      reasoningEffort,
      latencyMode,
      turnExecutionPolicy,
      // A shared spawn inherits the box's backend; a caller-supplied
      // sandboxBackend on a shared spawn is ignored (it is the same box). A
      // machine-targeted create (top-level or own-box child) labels the home
      // "selfhosted" (machineHomeBackend), overriding the caller/deployment
      // default so the row matches where the session actually runs.
      sandboxBackend:
        inheritedBackend ?? machineHomeBackend ?? payload.sandboxBackend ?? settings.sandboxBackend,
      // Mirror the backend relabel on the OS axis: a machine-targeted own-box
      // create carries a derived OS; shared spawns keep the parent-box behavior.
      ...(machineHomeOs ? { sandboxOs: machineHomeOs } : {}),
      sandboxGroupId,
      metadata: payload.metadata,
      ...(creationInitiator.initiator ? { createdBy: creationInitiator.initiator } : {}),
      ...(creationInitiator.context ? { createdByContext: creationInitiator.context } : {}),
      createdByActor: creationInitiator.actor ?? null,
      variableSet: variableSet ? { id: variableSet.id, name: variableSet.name } : null,
      // Frozen rig binding (M3): both null for a rig-less session (today's path).
      rigId: frozenRigId,
      rigVersionId: frozenRigVersionId,
      channelId,
      goal: effectiveGoal ?? null,
      // Per-session persona instructions (already trimmed/validated by the
      // contracts schema). Persisted on the row; composed system-level at turn
      // time. Not surfaced as an event.
      instructions: payload.instructions ?? null,
      policyRole: payload.policyRole ?? null,
      firstPartyMcpPermissions,
      firstPartyMcpTools,
      mcpServers: sessionMcpServers.dbServers,
      sessionMcpServers: sessionMcpServers.metadata,
      personalConnectionDelegations,
      initialPersonalResourceAttachmentIntent: payload.personalResourceAttachment ?? null,
      ...(xaiProviderAccountAuthoritySnapshot ? { xaiProviderAccountAuthoritySnapshot } : {}),
      parentSessionId,
      createIdempotencyKey: payload.idempotencyKey ?? null,
      maxNestedAgentDepthOverride: payload.maxNestedAgentDepth ?? null,
      allowNestedAgentDepthIncrease: hasPermission(grant.permissions, "workspace:admin"),
      subjectId: grant.subjectId,
      // Create-time machine targeting (A-2a): when a target sandbox is named, the
      // active-sandbox pointer is seeded race-free inside createAndStartSession
      // (after the row exists, before the first turn dispatches). Validation
      // (ownership/liveness) lives in swapActiveSandbox; an invalid target 422s.
      seedTargetSandbox: payload.targetSandboxId
        ? {
            sandboxId: payload.targetSandboxId,
            settings,
            workingDir: payload.workingDir ?? null,
            resourceSubjectId: personalResourceSubjectId,
          }
        : null,
      consumeNewSessionDraft:
        payload.expectedNewSessionDraftRevision !== undefined && payload.startMode !== "realtime"
          ? {
              subjectId: grant.subjectId,
              expectedRevision: payload.expectedNewSessionDraftRevision,
              expectedSnapshot: expectedNewSessionDraftSnapshot!,
              acceptedSelection: {
                channelId,
                targetSandboxId: payload.targetSandboxId ?? null,
                workingDir: payload.targetSandboxId ? (payload.workingDir ?? null) : null,
              },
            }
          : null,
      rememberNewSessionSelection:
        payload.expectedNewSessionDraftRevision !== undefined && payload.startMode === "realtime"
          ? {
              subjectId: grant.subjectId,
              acceptedSelection: {
                channelId,
                targetSandboxId: payload.targetSandboxId ?? null,
                workingDir: payload.targetSandboxId ? (payload.workingDir ?? null) : null,
              },
            }
          : null,
    });
  } catch (error) {
    if (error instanceof PersonalResourceAttachmentAcceptanceError) {
      throw new HTTPException(
        error.kind === "invalid" ? 422 : error.kind === "forbidden" ? 403 : 409,
        { message: error.message, cause: error },
      );
    }
    if (error instanceof AgentCommandAuthorityError) {
      throw new HTTPException(403, { message: error.message });
    }
    if (error instanceof SessionIdConflictError) {
      throw new HTTPException(409, {
        message: "requested session id is already in use",
      });
    }
    if (error instanceof NewSessionDraftConflictError) {
      throw new HTTPException(409, {
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof SessionCreateIdempotencyConflictError) {
      throw new HTTPException(409, { message: error.message, cause: error });
    }
    throw error;
  }
  let usageRecording: CreateSessionRequestOutcome["usageRecording"] = "recorded";
  if (payload.startMode !== "realtime") {
    try {
      await recordWorkspaceUsage(deps, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        eventType: "agent_run.created",
        quantity: 1,
        unit: "run",
        sourceResourceType: "session",
        sourceResourceId: createOutcome.session.id,
        sessionId: createOutcome.session.id,
        initiator: createOutcome.session.createdBy,
        initiatorContext: createOutcome.session.createdByContext,
        origin: creationInitiator.actor ? "system" : "user",
        idempotencyKey: `agent_run.created:${workspaceId}:${createOutcome.session.id}`,
      });
    } catch (error) {
      usageRecording = "failed";
      reportSessionUsageRecordingFailure(error);
    }
  }
  return { ...createOutcome, usageRecording };
}

/** @internal Fixed public projection; the committed session outcome remains authoritative. */
export function reportSessionUsageRecordingFailure(_error: unknown): void {
  console.warn(
    "[sessions] usage recording failed after committed session create; returning committed outcome",
    {
      errorClass: "UsageRecordingError",
      errorCode: "session_create_usage_recording_failed",
      origin: "core",
    },
  );
}

/** Backward-compatible entity-returning request path for REST and core callers. */
export async function createSessionForRequest(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  rawPayload: unknown,
  authorization?: AccessGrantAuthorization,
): Promise<CreateSessionResponse> {
  return (
    await createSessionForRequestWithOutcome(deps, grant, workspaceId, rawPayload, authorization)
  ).session;
}

/**
 * Full accept-user-message flow shared by the `user.message` branch of
 * `POST /sessions/:id/events` and the first-party MCP `session_send_message`
 * tool: resource/tool validation, usage limits, the locked append + turn
 * enqueue, and usage recording. `toolsProvided: false` durably preserves an
 * Tool selection is durable session state and never rides a follow-up prompt.
 */
export async function acceptSessionUserMessageWithOutcome(
  deps: AcceptSessionUserMessageDependencies,
  grant: AccessGrant,
  workspaceId: string,
  sessionId: string,
  input: {
    text: string;
    annotations?: SubmittedTimelineAnnotation[];
    modelContext?: string | null;
    resources?: ResourceRef[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    latencyMode?: "standard" | "priority" | "fast" | null;
    clientEventId?: string;
    mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[];
    connectionAuthorities?: McpConnectionAuthoritySelection[];
    delivery?: "send" | "steer";
    origin?: "human" | "operator";
    controlEtag?: string | null;
    expectedDraftRevision?: number | null;
    personalResourceAttachment?: PersonalResourceAttachmentIntent;
    authorization?: AccessGrantAuthorization;
  },
): Promise<{
  accepted: SessionEvent;
  turn: SessionTurn;
  draft: ComposerDraft | null;
  interruptionCount: number;
  replay: boolean;
}> {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const delegatedServiceInitiator = serviceInitiatorForGrant(grant);
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: input.delivery === "steer" ? "session.steer" : "session.append",
    surface: "core",
  });
  await requireAtomicPersonalResourceAttachment(
    deps,
    input.authorization,
    workspaceId,
    input.personalResourceAttachment,
    true,
  );
  // Hoisted above requireLimit so the codex-billed predicate can resolve the
  // turn's effective model (a follow-up turn inherits the session's model). A
  // pure read with no side effects.
  const existingSession = await requireSession(db, workspaceId, sessionId);
  const requestedModel = canonicalConfiguredModel(settings, input.model ?? null) ?? null;
  const effectiveModel =
    canonicalConfiguredModel(settings, requestedModel ?? existingSession.model) ?? null;
  if (effectiveModel === null) {
    throw new Error("effective follow-up model unexpectedly resolved to null");
  }
  try {
    assertSessionAllowsProductModel(existingSession, effectiveModel);
  } catch (error) {
    if (error instanceof CodexCompactionV2ProviderLockedError) {
      throw new HTTPException(422, { message: error.message, cause: error });
    }
    throw error;
  }
  const sessionReasoningEffort = existingSession.reasoningEffort;
  const effectiveReasoningEffort = input.reasoningEffort ?? sessionReasoningEffort;
  const sessionLatencyMode = existingSession.latencyMode;
  const effectiveLatencyMode = input.latencyMode ?? sessionLatencyMode;
  const turnExecutionPolicy = resolveTurnExecutionPolicyV1(settings, {
    modelId: effectiveModel,
    requestedModelId: input.model ?? null,
    modelSource: input.model == null ? "session" : "explicit",
    reasoningEffort: effectiveReasoningEffort,
    reasoningSource: input.reasoningEffort == null ? "session" : "explicit",
    latencyMode: effectiveLatencyMode,
    latencyModeSource: input.latencyMode == null ? "session" : "explicit",
  });
  const requestedResources = normalizeResources(input.resources ?? []);
  const annotations = await validateSubmittedTimelineAnnotations(
    db,
    workspaceId,
    sessionId,
    input.annotations ?? [],
  );
  await requireLimit(deps, {
    accountId: grant.accountId,
    workspaceId,
    action: "agent_run:create",
    quantity: 1,
    model: effectiveModel,
  });
  if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
    throw new HTTPException(503, {
      message: "object storage is not configured",
    });
  }
  await validateFileResources(
    db,
    grant.accountId,
    workspaceId,
    grant.subjectId,
    requestedResources,
  );
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
  const connectionDelegationSource = personalConnectionDelegationSourceForGrant(grant);
  const inheritedPersonalConnectionDelegations =
    connectionDelegationSource.kind === "turn"
      ? await getSessionTurnPersonalConnectionDelegations(
          db,
          workspaceId,
          connectionDelegationSource.sessionId,
          connectionDelegationSource.turnId,
        )
      : null;
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
    inheritedPersonalConnectionDelegations
      ? {
          personalConnectionDelegations: inheritedPersonalConnectionDelegations,
        }
      : { subjectId: grant.subjectId },
  );
  const personalConnectionDelegations = await freezePersonalConnectionDelegations({
    db,
    workspaceId,
    settings: runtimeSettings,
    tools: existingSession.tools,
    resources: [...existingSession.resources, ...requestedResources],
    source: connectionDelegationSource,
    targetSessionId: sessionId,
    googleDrivePublicationEnabled:
      existingSession.firstPartyMcpTools.includes("editable_artifact_export") &&
      existingSession.firstPartyMcpTools.includes("editable_artifact_export_status") &&
      (!existingSession.firstPartyMcpPermissions?.length ||
        (existingSession.firstPartyMcpPermissions.includes("artifacts:read") &&
          existingSession.firstPartyMcpPermissions.includes("artifacts:publish"))),
    atlassianEnabled:
      existingSession.firstPartyMcpTools.some((tool) => tool.startsWith("atlassian_")) &&
      (!existingSession.firstPartyMcpPermissions?.length ||
        existingSession.firstPartyMcpPermissions.includes("connections:read")),
    ...(input.connectionAuthorities ? { authoritySelections: input.connectionAuthorities } : {}),
  });
  const { accepted, turn, draft, interruptionCount, replay } = await postUserMessageTurn({
    db,
    bus,
    workflowClient,
    settings,
    accountId: grant.accountId,
    workspaceId,
    sessionId,
    text: input.text,
    annotations,
    modelContext: input.modelContext ?? null,
    resources: requestedResources,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    latencyMode: input.latencyMode ?? null,
    reasoningEffortFallback: sessionReasoningEffort,
    turnExecutionPolicy,
    mcpCredentialUpdates,
    personalConnectionDelegations,
    ...(input.personalResourceAttachment
      ? { personalResourceAttachment: input.personalResourceAttachment }
      : {}),
    delivery: input.delivery ?? "send",
    origin: delegatedServiceInitiator ? "operator" : (input.origin ?? "human"),
    actor: grant.subjectId,
    ...(grant.subjectLabel ? { actorLabel: grant.subjectLabel } : {}),
    ...(delegatedServiceInitiator
      ? {
          commandActor: {
            type: "service" as const,
            subjectId: delegatedServiceInitiator.initiator.subjectId,
            ...(delegatedServiceInitiator.initiator.label
              ? { subjectLabel: delegatedServiceInitiator.initiator.label }
              : {}),
            context: delegatedServiceInitiator.context,
          },
        }
      : {}),
    ...(input.controlEtag !== undefined ? { controlEtag: input.controlEtag } : {}),
    ...(input.expectedDraftRevision !== undefined
      ? { expectedDraftRevision: input.expectedDraftRevision }
      : {}),
    ...(input.clientEventId ? { clientEventId: input.clientEventId } : {}),
    recordAgentRunUsage: true,
    ...(deps.schedulePromptPostCommit ? { schedulePostCommit: deps.schedulePromptPostCommit } : {}),
  });
  return { accepted, turn, draft, interruptionCount, replay };
}

/** Backward-compatible entity-returning path used by existing REST callers. */
export async function acceptSessionUserMessage(
  deps: Parameters<typeof acceptSessionUserMessageWithOutcome>[0],
  grant: Parameters<typeof acceptSessionUserMessageWithOutcome>[1],
  workspaceId: Parameters<typeof acceptSessionUserMessageWithOutcome>[2],
  sessionId: Parameters<typeof acceptSessionUserMessageWithOutcome>[3],
  input: Parameters<typeof acceptSessionUserMessageWithOutcome>[4],
): Promise<{
  accepted: SessionEvent;
  turn: SessionTurn;
  interruptionCount: number;
  replay: boolean;
}> {
  const { accepted, turn, interruptionCount, replay } = await acceptSessionUserMessageWithOutcome(
    deps,
    grant,
    workspaceId,
    sessionId,
    input,
  );
  return { accepted, turn, interruptionCount, replay };
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
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  grant: AccessGrant,
  sessionId: string,
  title: string,
  source: "user" | "agent",
): Promise<{
  updated: boolean;
  title: string | null;
  relatedSessionAccess: "target" | "root";
}> {
  const { db, bus } = deps;
  const authorization = await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.title.write",
    surface: "core",
  });
  const workspaceId = grant.workspaceId;
  const result = await updateSessionTitleRow(db, {
    workspaceId,
    sessionId,
    title,
    source,
  });
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
  return {
    ...result,
    relatedSessionAccess: authorization?.relatedSessionAccess ?? "root",
  };
}

/**
 * Update one existing session MCP server's approval policy. The database
 * serializes this write with attempt claim under the session lock: an already
 * claimed attempt retains its immutable snapshot, while the next claim captures
 * this value. No attempt is cancelled, restarted, or reinterpreted.
 */
export async function updateSessionMcpApprovalPolicy(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  grant: AccessGrant,
  sessionId: string,
  serverId: string,
  requireApproval: SessionMcpApprovalPolicy,
): Promise<UpdateSessionMcpApprovalPolicyResponse> {
  const normalizedPolicy = SessionMcpApprovalPolicy.parse(requireApproval);
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.mcp.approval_policy.write",
    surface: "core",
  });
  requirePermission(grant, "sessions:control");

  const outcome: { server?: SessionMcpServerMetadata } = {};
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    grant.workspaceId,
    sessionId,
    async (_session, context) => {
      const result = await context.updateSessionMcpApprovalPolicy(serverId, normalizedPolicy);
      if (!result.server) {
        throw new HTTPException(404, {
          message: "session MCP server not found",
        });
      }
      outcome.server = result.server;
      return {
        events: result.changed
          ? [
              {
                type: "session.mcp.approval_policy.updated" as const,
                payload: {
                  serverId,
                  effectiveFrom: "next_attempt",
                },
              },
            ]
          : [],
      };
    },
    { activity: "semantic" },
  );
  const updatedServer = outcome.server;
  if (!updatedServer) {
    throw new Error("session MCP approval policy update returned no server");
  }
  await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, events);
  return {
    server: updatedServer,
    effectiveFrom: "next_attempt",
  };
}

function toolPolicyAuditSnapshot(
  session: Session,
  tools: ToolRef[],
  firstPartyMcpTools: FirstPartyMcpToolName[],
  policy = session.toolPolicy,
) {
  // Tool policy refs contain only public server ids and the optional/strict
  // execution mode; they never carry URLs, names, headers, credentials,
  // schemas, or arguments. The request is capped at 64 refs and the mandatory
  // first-party server can add one more, so the complete snapshot remains a
  // small bounded payload rather than silently dropping security-relevant
  // optional/strict changes.
  const allToolRefs = mergeToolRefs([], tools)
    .sort((left, right) => {
      // Keep the mandatory first-party authority visible even when the
      // bounded audit preview has to omit the middle of a large selection.
      const leftMandatory = left.kind === "mcp" && left.id === "opengeni";
      const rightMandatory = right.kind === "mcp" && right.id === "opengeni";
      if (leftMandatory !== rightMandatory) return leftMandatory ? -1 : 1;
      return `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`);
    })
    .map((tool) => ({
      kind: tool.kind,
      id: tool.id,
      ...(tool.optional === undefined ? {} : { optional: tool.optional }),
      ...(tool.eager === undefined ? {} : { eager: tool.eager }),
    }));
  const toolRefs = allToolRefs.slice(0, maxToolPolicyAuditRefs);
  return {
    mode: policy.mode,
    inheritedFromSessionId: policy.inheritedFromSessionId,
    // IDs only: no MCP URLs, names, headers, credentials, schemas, or args.
    toolIds: [...toolRefs]
      .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
      .map((tool) => tool.id),
    toolRefs,
    toolCount: allToolRefs.length,
    firstPartyMcpTools: [...firstPartyMcpTools].sort(),
    firstPartyMcpToolCount: firstPartyMcpTools.length,
    truncated: allToolRefs.length > toolRefs.length,
  };
}

/**
 * Replace the durable session tool policy. The target and its parent (when
 * present) are locked by the DB event-writer helper, and the update/event are
 * committed under one version-fenced transaction. An already claimed turn
 * keeps its immutable snapshot; the next attempt observes this policy.
 */
export async function updateSessionToolPolicy(
  deps: {
    db: Database;
    bus: EventBus;
    settings: Settings;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  grant: AccessGrant,
  sessionId: string,
  request: UpdateSessionToolPolicyRequest,
): Promise<Session> {
  await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.tool_policy.write",
    surface: "core",
  });
  requirePermission(grant, "sessions:control");

  const existingSession = await requireSession(deps.db, grant.workspaceId, sessionId);
  const capabilityRuntimeSettings = await settingsWithEnabledCapabilityMcpServers(
    deps.db,
    grant.workspaceId,
    deps.settings,
    { subjectId: grant.subjectId },
  );
  const runtimeSettings = settingsWithSessionMcpServerMetadata(
    capabilityRuntimeSettings,
    existingSession.mcpServers,
  );
  const explicitRequest = request.mode === "workspace_default" ? null : request;
  const requestedMode = explicitRequest ? "explicit" : "workspace_default";
  const explicitRequestedTools = explicitRequest
    ? (() => {
        const validatedTools = validateToolRefs(explicitRequest.tools, runtimeSettings);
        const validatedIds = new Set(validatedTools.map((tool) => `${tool.kind}:${tool.id}`));
        const unknown = explicitRequest.tools.find(
          (tool) => !validatedIds.has(`${tool.kind}:${tool.id}`),
        );
        if (unknown) {
          throw new HTTPException(422, {
            message: `unknown MCP server id: ${unknown.id}`,
          });
        }
        return withFirstPartyTools(validatedTools, runtimeSettings);
      })()
    : null;
  const explicitRequestedFirstPartyTools = explicitRequest
    ? [...explicitRequest.firstPartyMcpTools]
    : null;
  const deploymentFirstPartyMcpToolPolicy = resolveFirstPartyMcpToolPolicy(deps.settings);
  const disallowedFirstPartyMcpTool = explicitRequestedFirstPartyTools?.find(
    (tool) => !deploymentFirstPartyMcpToolPolicy.allowed.includes(tool),
  );
  if (disallowedFirstPartyMcpTool) {
    throw new HTTPException(422, {
      message: `first-party MCP tool is disabled by deployment policy: ${disallowedFirstPartyMcpTool}`,
    });
  }
  const workspaceDefaultTools = withFirstPartyTools(
    withDefaultEnabledCapabilityMcpTools([], deps.settings, capabilityRuntimeSettings),
    runtimeSettings,
  );
  const workspaceDefaultFirstPartyTools = [...deploymentFirstPartyMcpToolPolicy.default];
  const events = await appendSessionEventsWithLockedSessionUpdate(
    deps.db,
    grant.workspaceId,
    sessionId,
    async (session, context) => {
      const currentVersion = session.toolPolicyVersion ?? 1;
      if (request.expectedVersion !== currentVersion) {
        throw new SessionToolPolicyVersionConflictError(currentVersion);
      }

      let nextTools: ToolRef[];
      let nextFirstPartyMcpTools: FirstPartyMcpToolName[];
      let nextPolicy: SessionToolPolicy;
      if (session.parentSessionId) {
        const parent = await context.getLockedSession(session.parentSessionId);
        if (!parent) {
          throw new HTTPException(409, {
            message: "parent session is no longer available",
          });
        }
        const parentTracksWorkspaceDefaults = parent.toolPolicy?.mode === "workspace_default";
        const parentEffective = withFirstPartyTools(
          parentTracksWorkspaceDefaults
            ? withDefaultEnabledCapabilityMcpTools(
                availableToolRefs(parent.tools, runtimeSettings),
                deps.settings,
                runtimeSettings,
              )
            : parent.tools,
          runtimeSettings,
        );
        const deploymentAllowedFirstPartyMcpTools = new Set(
          deploymentFirstPartyMcpToolPolicy.allowed,
        );
        const parentFirstPartyMcpTools = [
          ...(parent.firstPartyMcpTools ?? deploymentFirstPartyMcpToolPolicy.default),
        ].filter((tool) => deploymentAllowedFirstPartyMcpTools.has(tool));
        if (requestedMode === "workspace_default") {
          if (!parentTracksWorkspaceDefaults) {
            throw new HTTPException(403, {
              message:
                "a child may adopt workspace defaults only while its parent tracks workspace defaults",
            });
          }
          nextTools = parentEffective;
          nextFirstPartyMcpTools = parentFirstPartyMcpTools;
          nextPolicy = {
            mode: "workspace_default",
            inheritedFromSessionId: parent.id,
          };
        } else {
          nextTools = explicitRequestedTools!;
          assertToolRefsSubset(
            nextTools,
            parentEffective,
            "session tools may only narrow the parent session tool policy",
          );
          const parentFirstPartySet = new Set(parentFirstPartyMcpTools);
          const widenedFirstPartyTool = explicitRequestedFirstPartyTools!.find(
            (tool) => !parentFirstPartySet.has(tool),
          );
          if (widenedFirstPartyTool) {
            throw new HTTPException(403, {
              message: `session OpenGeni tools may only narrow the parent policy: ${widenedFirstPartyTool}`,
            });
          }
          nextFirstPartyMcpTools = explicitRequestedFirstPartyTools!;
          nextPolicy = {
            mode: "explicit",
            inheritedFromSessionId: parent.id,
          };
        }
      } else {
        nextTools =
          requestedMode === "workspace_default" ? workspaceDefaultTools : explicitRequestedTools!;
        nextFirstPartyMcpTools =
          requestedMode === "workspace_default"
            ? workspaceDefaultFirstPartyTools
            : explicitRequestedFirstPartyTools!;
        nextPolicy = { mode: requestedMode, inheritedFromSessionId: null };
      }

      const currentPolicy = session.toolPolicy;
      // JSONB normalizes object-key order on the round trip, so plain
      // JSON.stringify would turn an identical retry into a second mutation
      // (and version bump) merely because the persisted key order differs from
      // the request object. Compare canonical JSON instead.
      const unchanged =
        stableJson({
          tools: session.tools,
          firstPartyMcpTools:
            session.firstPartyMcpTools ?? deploymentFirstPartyMcpToolPolicy.default,
          policy: currentPolicy,
        }) ===
        stableJson({
          tools: nextTools,
          firstPartyMcpTools: nextFirstPartyMcpTools,
          policy: nextPolicy,
        });
      if (unchanged) {
        return { events: [] };
      }

      const nextVersion = currentVersion + 1;
      return {
        events: [
          {
            type: "session.tool_policy.updated" as const,
            payload: {
              before: toolPolicyAuditSnapshot(
                session,
                session.tools,
                [...(session.firstPartyMcpTools ?? deploymentFirstPartyMcpToolPolicy.default)],
                currentPolicy,
              ),
              after: toolPolicyAuditSnapshot(
                session,
                nextTools,
                nextFirstPartyMcpTools,
                nextPolicy,
              ),
              version: nextVersion,
              effectiveFrom: "next_attempt",
            },
          },
        ],
        update: {
          tools: nextTools,
          firstPartyMcpTools: nextFirstPartyMcpTools,
          toolPolicy: nextPolicy,
          toolPolicyVersion: nextVersion,
          expectedToolPolicyVersion: request.expectedVersion,
        },
      };
    },
    { activity: "semantic", lockParentSession: true },
  );
  if (events.length > 0) {
    await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, events);
  }
  return await requireSession(deps.db, grant.workspaceId, sessionId);
}

export async function readSessionLineage(
  deps: Pick<ApiRouteDeps, "db" | "sessionAuthorization">,
  grant: AccessGrant,
  sessionId: string,
) {
  const authorization = await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation: "session.lineage.read",
    surface: "core",
  });
  if (authorization?.relatedSessionAccess === "target") {
    const session = await getSession(deps.db, grant.workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return { ancestors: [], children: [], truncated: false };
  }
  const lineage = await getSessionLineage(deps.db, grant.workspaceId, sessionId);
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
