// Deterministic mock data for the SessionChrome DEV harness
// (`/dev/composer-chrome`). No live session, queue, or goal APIs.
import type {
  ComposerState,
  UseFileAttachmentsResult,
  UseGoalResult,
  UseTurnQueueResult,
} from "@opengeni/react";
import { projectPickerRows, type PickerModelRow } from "@opengeni/react";
import type {
  EffectiveSessionControl,
  LineageNode,
  Session,
  SessionGoal,
  SessionPendingInputPreview,
  SessionTurn,
  WorkspaceModelCatalogModel,
} from "@opengeni/sdk";
import { FIRST_PARTY_MCP_TOOL_NAMES, type FirstPartyMcpToolName } from "@opengeni/contracts";

import type { SessionToolSelection } from "@/components/pickers";
import { firstPartySessionToolOptions, type McpServerOption } from "@/lib/session-tools";

export const GALLERY_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const GALLERY_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const FIXED_NOW = Date.parse("2026-07-31T12:00:00.000Z");

function isoMinutesAgo(minutes: number, from = FIXED_NOW): string {
  return new Date(from - minutes * 60_000).toISOString();
}

function activeControl(sessionId: string): EffectiveSessionControl {
  return {
    state: "active",
    controlVersion: 0,
    controlEtag: `gallery-${sessionId}-active`,
    directState: "active",
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  };
}

export function gallerySession(overrides: Partial<Session> = {}): Session {
  const updatedAt = isoMinutesAgo(10);
  return {
    id: GALLERY_SESSION_ID,
    workspaceId: GALLERY_WORKSPACE_ID,
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    status: "idle",
    initialMessage: "Gallery session",
    title: "Composer chrome gallery",
    titleSource: "user",
    instructions: null,
    resources: [],
    skills: [],
    tools: [],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    toolPolicyVersion: 1,
    metadata: { title: "Composer chrome gallery" },
    createdBy: { kind: "subject", subjectId: "user:gallery" },
    createdByContext: {},
    model: "gpt-5.6-sol",
    sandboxBackend: "modal",
    sandboxOs: "linux",
    sandboxGroupId: GALLERY_SESSION_ID,
    activeSandboxId: null,
    activeEpoch: 0,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    rigVersionId: null,
    firstPartyMcpPermissions: null,
    firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
    mcpServers: [],
    parentSessionId: null,
    rootSessionId: GALLERY_SESSION_ID,
    nestedAgentDepth: 0,
    maxNestedAgentDepthOverride: null,
    effectiveMaxNestedAgentDepth: 3,
    nestedAgentDepthPolicySource: "default",
    nestedAgentDepthPolicySessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: null,
    activeTurnId: null,
    queueVersion: 0,
    queueHeadPosition: 0,
    queueTailPosition: 0,
    effectiveControl: activeControl(GALLERY_SESSION_ID),
    lastSequence: 0,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdAt: isoMinutesAgo(60 * 8),
    updatedAt,
    ...overrides,
    codexCompactionMode: overrides.codexCompactionMode ?? "portable",
  };
}

export function galleryTurn(index: number, prompt: string): SessionTurn {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-${suffix}`,
    workspaceId: GALLERY_WORKSPACE_ID,
    sessionId: GALLERY_SESSION_ID,
    triggerEventId: `${String(index + 1).padStart(8, "0")}-3333-4333-8333-${suffix}`,
    temporalWorkflowId: "gallery-queue",
    status: "queued",
    source: "user",
    position: index + 1,
    prompt,
    resources: [],
    tools: [],
    toolsProvided: false,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    sandboxOs: null,
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "subject", subjectId: "user:gallery" },
    initiatorContext: {},
    startedAt: null,
    finishedAt: null,
    createdAt: isoMinutesAgo(30 - index),
    updatedAt: isoMinutesAgo(30 - index),
  };
}

export function galleryPendingInput(
  index: number,
  overrides: Partial<SessionPendingInputPreview> = {},
): SessionPendingInputPreview {
  const suffix = String(index + 1).padStart(12, "0");
  return {
    id: `${String(index + 1).padStart(8, "0")}-4444-4444-8444-${suffix}`,
    sessionId: GALLERY_SESSION_ID,
    kind: "agent_message",
    classification: "info",
    sourceId: `${String(index + 1).padStart(8, "0")}-5555-4555-8555-${suffix}`,
    summary: `Incoming update ${index + 1}`,
    createdAt: isoMinutesAgo(20 - index),
    ...overrides,
  };
}

export function galleryQueue(overrides: Partial<UseTurnQueueResult> = {}): UseTurnQueueResult {
  return {
    snapshot: null,
    queue: [],
    pendingInputs: [],
    pendingInputAttachment: null,
    effectiveControl: activeControl(GALLERY_SESSION_ID),
    stoppingPreviousAttempt: false,
    loading: false,
    error: null,
    refresh: async () => {},
    moveTurn: async () => true,
    editTurn: async () => null,
    steerTurn: async () => true,
    removeTurn: async () => true,
    pendingByTurn: {},
    mutationFor: () => null,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
    ...overrides,
    activePersonalConnections: overrides.activePersonalConnections ?? [],
  };
}

function galleryGoalRecord(overrides: Partial<SessionGoal> = {}): SessionGoal {
  // Blocked/paused pills freeze elapsed at updatedAt − createdAt. Keep that
  // span at ~6h 15m so the screenshot-like scenario matches production chrome.
  const createdAt = isoMinutesAgo(6 * 60 + 15);
  const updatedAt = new Date(FIXED_NOW).toISOString();
  return {
    id: "66666666-6666-4666-8666-666666666666",
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspaceId: GALLERY_WORKSPACE_ID,
    sessionId: GALLERY_SESSION_ID,
    status: "active",
    text: "Make Linear activation on the live jorgebot OpenGeni deployment operational end-to-end",
    successCriteria: "Linear issues sync and activate from the live deployment",
    evidence: null,
    rationale: null,
    pausedReason: null,
    createdBy: "api",
    version: 4,
    autoContinuations: 12,
    noProgressStreak: 0,
    maxAutoContinuations: null,
    metadata: {},
    continuation: {
      state: "blocked",
      reason: "human_work_pending",
      wakeRevision: 3,
      observedRevision: 2,
      nextAttemptAt: null,
      lastError: "Waiting for a human follow-up before the next goal turn.",
    },
    createdAt,
    updatedAt,
    ...overrides,
  };
}

export function galleryGoal(overrides: Partial<SessionGoal> | null): UseGoalResult {
  const goal = overrides === null ? null : galleryGoalRecord(overrides);
  return {
    goal,
    isActive: goal?.status === "active",
    isPaused: goal?.status === "paused",
    isCompleted: goal?.status === "completed",
    loading: false,
    error: null,
    refresh: async () => {},
    pause: async () => goal,
    resume: async () => goal,
    clearGoal: async () => {},
    deleteGoal: async () => {},
    updating: false,
    mutationError: null,
    clearMutationError: () => {},
  };
}

export function galleryAgentNode(index: number, overrides: Partial<Session> = {}): LineageNode {
  const id = `${String(index + 1).padStart(8, "0")}-7777-4777-8777-${String(index + 1).padStart(12, "0")}`;
  return {
    session: gallerySession({
      id,
      parentSessionId: GALLERY_SESSION_ID,
      rootSessionId: GALLERY_SESSION_ID,
      nestedAgentDepth: 1,
      status: "idle",
      title: index === 0 ? "Linear activation worker" : "Durable child timeline",
      metadata: {
        title: index === 0 ? "Linear activation worker" : "Durable child timeline",
      },
      effectiveControl: activeControl(id),
      updatedAt: isoMinutesAgo(5 + index),
      ...overrides,
    }),
    children: [],
  };
}

export function emptyAttachments(): UseFileAttachmentsResult {
  return {
    attachments: [],
    readyResources: [],
    uploading: false,
    hasUnresolved: false,
    addFiles: () => {},
    addFromPaste: () => {},
    restoreReadyFiles: () => {},
    retry: () => {},
    remove: () => {},
    removeReadyFiles: () => {},
    clear: () => {},
  };
}

export function idleComposer(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    value: "",
    setValue: () => {},
    hasDraftContent: () => false,
    send: async () => true,
    steer: async () => true,
    sending: false,
    canSend: false,
    pause: async () => {},
    pausing: false,
    resume: async () => {},
    resumeScope: async () => {},
    resuming: false,
    draft: null,
    draftRevision: 0,
    draftLoading: false,
    draftSaving: false,
    draftConflict: null,
    draftPersistence: "disabled",
    applyDraft: () => {},
    reloadDraft: async () => {},
    resolveDraftConflict: async () => {},
    restoredResources: [],
    removeRestoredResource: () => {},
    error: null,
    clearError: () => {},
    ...overrides,
  };
}

function catalogModel(
  overrides: Partial<WorkspaceModelCatalogModel> & Pick<WorkspaceModelCatalogModel, "id" | "label">,
): WorkspaceModelCatalogModel {
  return {
    provider: "openai",
    providerLabel: "OpenAI",
    api: "responses",
    credentialReadiness: {
      status: "ready",
      reason: null,
      basis: "configuration",
      checkedAt: null,
    },
    availability: {
      status: "available",
      selectable: true,
      reason: null,
      checkedAt: null,
    },
    billing: { upstreamPayer: "deployment", metering: "opengeni_credits" },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [{ id: "standard", upstream: "supported", runnable: true }],
    },
    ...overrides,
  };
}

export const galleryModelRows: PickerModelRow[] = projectPickerRows([
  catalogModel({ id: "gpt-5.6-sol", label: "gpt-5.6-sol" }),
  catalogModel({ id: "gpt-5.4", label: "gpt-5.4" }),
]);

/** 52 first-party + 1 MCP = 53; leave two off → Tools · 51/53. */
export const galleryToolServers: McpServerOption[] = [{ id: "linear", name: "Linear" }];

export const galleryToolSelection: SessionToolSelection = {
  mcpServerIds: new Set<string>(),
  firstPartyToolIds: new Set<FirstPartyMcpToolName>(
    FIRST_PARTY_MCP_TOOL_NAMES.filter((name) => name !== "rig_propose_change"),
  ),
};

export const galleryFirstPartyTools = firstPartySessionToolOptions;

export const screenshotIncomingInputs: SessionPendingInputPreview[] = [
  galleryPendingInput(0, {
    kind: "child_terminal_result",
    classification: "failure",
    summary: "Child session failed; inspect the durable child timeline.",
  }),
  galleryPendingInput(1, {
    kind: "agent_message",
    classification: "info",
    summary: "Worker posted a status update from the activation pass.",
  }),
  galleryPendingInput(2, {
    kind: "agent_steer_instruction",
    classification: "action_required",
    summary: "Steer: keep Linear project keys aligned with production.",
  }),
  galleryPendingInput(3, {
    kind: "scheduled_occurrence",
    classification: "info",
    summary: "Scheduled check-in is waiting to join the next turn.",
  }),
];

export type ChromeScenarioId =
  | "screenshot"
  | "queued-only"
  | "incoming-and-queued"
  | "goal-running"
  | "goal-paused"
  | "goal-blocked"
  | "goal-held"
  | "agents-many"
  | "agents-none"
  | "composer-only";

export type ChromeScenario = {
  id: ChromeScenarioId;
  title: string;
  description: string;
  session: Session;
  queue: UseTurnQueueResult;
  goal: UseGoalResult;
  agentNodes: LineageNode[];
};

export function chromeScenarios(): ChromeScenario[] {
  const session = gallerySession();
  const twoAgents = [galleryAgentNode(0), galleryAgentNode(1)];
  const pausedAgentId = "00000003-7777-4777-8777-000000000003";
  const manyAgents = [
    galleryAgentNode(0, { status: "running" }),
    galleryAgentNode(1),
    galleryAgentNode(2, {
      id: pausedAgentId,
      status: "requires_action",
      effectiveControl: {
        ...activeControl(pausedAgentId),
        state: "paused",
        directState: "paused",
        controlVersion: 1,
        controlEtag: "gallery-paused",
        primaryBlocker: {
          kind: "session",
          sessionId: pausedAgentId,
          displayName: "Paused here",
          actor: "gallery",
          reason: null,
          changedAt: isoMinutesAgo(2),
          revision: 1,
        },
        blockers: [],
        resumeOptions: [],
      },
    }),
  ];

  return [
    {
      id: "screenshot",
      title: "Screenshot stack",
      description: "Incoming updates + continuation blocked + 2 agents — closest to the reference.",
      session,
      queue: galleryQueue({ pendingInputs: screenshotIncomingInputs }),
      goal: galleryGoal({}),
      agentNodes: twoAgents,
    },
    {
      id: "queued-only",
      title: "Queued messages only",
      description: "Human prompts waiting ahead of send; no machine inputs or goal.",
      session,
      queue: galleryQueue({
        queue: [
          galleryTurn(0, "Please retry the Linear webhook after the deploy finishes."),
          galleryTurn(1, "Then paste the activation evidence into the runbook."),
        ],
      }),
      goal: galleryGoal(null),
      agentNodes: [],
    },
    {
      id: "incoming-and-queued",
      title: "Incoming + queued",
      description: "Collapsed queue shows both counts and a preview.",
      session,
      queue: galleryQueue({
        queue: [galleryTurn(0, "Follow up once the child session is inspected.")],
        pendingInputs: screenshotIncomingInputs.slice(0, 2),
      }),
      goal: galleryGoal(null),
      agentNodes: [galleryAgentNode(0)],
    },
    {
      id: "goal-running",
      title: "Active goal running",
      description: "Pursuing goal with live elapsed clock.",
      session: gallerySession({ status: "running" }),
      queue: galleryQueue(),
      goal: galleryGoal({
        continuation: {
          state: "running",
          reason: "goal_turn_running",
          wakeRevision: 5,
          observedRevision: 5,
          nextAttemptAt: null,
          lastError: null,
        },
        updatedAt: new Date(FIXED_NOW).toISOString(),
      }),
      agentNodes: twoAgents,
    },
    {
      id: "goal-paused",
      title: "Goal paused",
      description: "Operator paused the goal loop from the console.",
      session,
      queue: galleryQueue(),
      goal: galleryGoal({
        status: "paused",
        pausedReason: "Paused from the console",
        continuation: {
          state: "inactive",
          reason: "goal_inactive",
          wakeRevision: 2,
          observedRevision: 2,
          nextAttemptAt: null,
          lastError: null,
        },
      }),
      agentNodes: [],
    },
    {
      id: "goal-blocked",
      title: "Goal blocked (approval)",
      description: "Continuation blocked waiting on approval.",
      session,
      queue: galleryQueue({
        pendingInputs: [
          galleryPendingInput(0, {
            kind: "child_terminal_result",
            classification: "action_required",
            summary: "Approval required before the next goal continuation.",
          }),
        ],
      }),
      goal: galleryGoal({
        continuation: {
          state: "blocked",
          reason: "approval_required",
          wakeRevision: 4,
          observedRevision: 3,
          nextAttemptAt: null,
          lastError: "A tool approval is outstanding.",
        },
      }),
      agentNodes: twoAgents,
    },
    {
      id: "goal-held",
      title: "Goal held by workstream",
      description: "Active goal held while the workstream is paused.",
      session,
      queue: galleryQueue(),
      goal: galleryGoal({
        continuation: {
          state: "blocked",
          reason: "workstream_paused",
          wakeRevision: 1,
          observedRevision: 1,
          nextAttemptAt: null,
          lastError: null,
        },
      }),
      agentNodes: [],
    },
    {
      id: "agents-many",
      title: "Multiple agents",
      description: "Running + idle + paused children on the agents pill.",
      session,
      queue: galleryQueue(),
      goal: galleryGoal({
        continuation: {
          state: "scheduled",
          reason: "wake_pending",
          wakeRevision: 2,
          observedRevision: 1,
          nextAttemptAt: isoMinutesAgo(-15),
          lastError: null,
        },
      }),
      agentNodes: manyAgents,
    },
    {
      id: "agents-none",
      title: "No agents",
      description: "Goal only — agents pill hides when lineage is empty.",
      session,
      queue: galleryQueue(),
      goal: galleryGoal({
        text: "Ship the migration checklist without spawning workers",
        continuation: {
          state: "running",
          reason: "goal_turn_running",
          wakeRevision: 1,
          observedRevision: 1,
          nextAttemptAt: null,
          lastError: null,
        },
        updatedAt: new Date(FIXED_NOW).toISOString(),
      }),
      agentNodes: [],
    },
    {
      id: "composer-only",
      title: "Composer only",
      description: "Minimal stack — no queue, goal, or agents chrome.",
      session,
      queue: galleryQueue(),
      goal: galleryGoal(null),
      agentNodes: [],
    },
  ];
}
