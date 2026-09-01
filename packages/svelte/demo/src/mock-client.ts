import type {
  ComposerDraft,
  FileAsset,
  Session,
  SessionControlResponse,
  SessionEvent,
  SessionGoal,
  SessionHumanInputRequest,
  SessionLineageResponse,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
  UpdateSessionToolPolicyRequest,
} from "@opengeni/sdk";

export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
export const SESSION_ID = "22222222-2222-4222-8222-222222222222";

let sequence = 20;
let draftRevision = 1;
let queueVersion = 2;
let events = fixtureEvents();
let composerDraft = draft("Inspect the deployment receipts and explain the remaining risk.");
let queue = queueSnapshot();
let goal = goalFixture();
let humanRequests = [humanInputFixture()];

export type MissionControlMockClientOptions = Readonly<{
  failControl?: boolean;
  failToolPolicy?: boolean;
  composerFailure?: "definitive" | "outcome-unknown";
}>;

export class MissionControlMockClient {
  private selectedToolIds = ["search", "github"];
  private firstPartyMcpTools: Session["firstPartyMcpTools"] = [];
  private toolPolicyMode: Session["toolPolicy"]["mode"] = "explicit";
  private toolPolicyVersion = 1;

  constructor(private readonly options: MissionControlMockClientOptions = {}) {}

  private session(): Session {
    return sessionFixture({
      selectedToolIds: this.selectedToolIds,
      firstPartyMcpTools: this.firstPartyMcpTools,
      toolPolicyMode: this.toolPolicyMode,
      toolPolicyVersion: this.toolPolicyVersion,
    });
  }

  async getSession(_workspaceId?: string, _sessionId?: string): Promise<Session> {
    return this.session();
  }
  async updateSession(
    _workspaceId: string,
    _sessionId: string,
    input: { title: string },
  ): Promise<Session> {
    return { ...this.session(), title: input.title, titleSource: "user" };
  }
  async updateSessionToolPolicy(
    _workspaceId: string,
    _sessionId: string,
    request: UpdateSessionToolPolicyRequest,
  ): Promise<Session> {
    if (this.options.failToolPolicy) throw new Error("Fixture tool policy update failed.");
    if (request.expectedVersion !== this.toolPolicyVersion) {
      throw new Error("Fixture tool policy version is stale.");
    }
    this.toolPolicyMode = request.mode;
    if (request.mode === "explicit") {
      this.selectedToolIds = request.tools.map((tool) => tool.id);
      this.firstPartyMcpTools = [...request.firstPartyMcpTools];
    } else {
      this.selectedToolIds = ["search", "github"];
      this.firstPartyMcpTools = [];
    }
    this.toolPolicyVersion += 1;
    return this.session();
  }
  async listEvents(): Promise<SessionEvent[]> {
    return [...events];
  }
  streamEvents(): AsyncIterable<SessionEvent> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };
  }
  async getComposerDraft(): Promise<ComposerDraft> {
    return { ...composerDraft, resources: [...composerDraft.resources] };
  }
  async saveComposerDraft(
    _workspaceId: string,
    _sessionId: string,
    request: Omit<ComposerDraft, "revision" | "sourceTurnId" | "sourceTurnVersion" | "updatedAt">,
  ): Promise<ComposerDraft> {
    composerDraft = {
      ...composerDraft,
      ...request,
      revision: ++draftRevision,
      updatedAt: new Date().toISOString(),
    };
    return composerDraft;
  }
  async submitComposerDraft(
    _workspaceId: string,
    _sessionId: string,
    request: SubmitComposerDraftRequest,
  ): Promise<SubmitComposerDraftResponse> {
    if (this.options.composerFailure === "definitive") {
      throw new Error("Fixture composer delivery failed.");
    }
    if (this.options.composerFailure === "outcome-unknown") {
      throw Object.assign(new Error("Fixture composer delivery outcome is unknown."), {
        outcomeUnknown: true as const,
      });
    }
    const accepted = {
      ...event("user.message", { text: request.text, resources: request.resources }, ++sequence),
      clientEventId: request.clientEventId,
    };
    const turnId = `turn-${sequence}`;
    const turn = {
      id: turnId,
      triggerEventId: accepted.id,
      prompt: request.text,
      annotations: request.annotations,
      resources: request.resources,
      tools: [],
      metadata: { delivery: request.delivery },
      version: 1,
    } as never;
    events = [
      ...events,
      accepted,
      event(
        "agent.message.completed",
        { text: "Fixture accepted. The controller path is shared with live mode." },
        ++sequence,
      ),
    ];
    composerDraft = draft("");
    return {
      accepted,
      turn,
      draft: composerDraft,
      receipt: {
        id: `receipt-${sequence}`,
        action: request.delivery === "steer" ? "prompt.steered" : "prompt.sent",
        operationKey: request.clientEventId,
        targetSessionId: SESSION_ID,
        targetTurnId: turnId,
        appliedControlRevision: null,
        appliedQueueVersion: queueVersion,
        appliedTurnVersion: 1,
        appliedDraftRevision: composerDraft.revision,
        createdAt: new Date().toISOString(),
      },
      routing: request.delivery === "steer" ? "accepted_for_steering" : "accepted_for_execution",
      replay: false,
      interruptionCount: 0,
    } as SubmitComposerDraftResponse;
  }
  async sendMessage(..._args: unknown[]) {
    return event("user.message", {}, ++sequence);
  }
  async steerMessage(..._args: unknown[]) {
    return event("user.message", {}, ++sequence);
  }
  async getQueue(): Promise<SessionQueueSnapshot> {
    return queue;
  }
  async moveQueueItem(...args: unknown[]): Promise<SessionQueueMutationResponse> {
    return this.queueMutation(args);
  }
  async editQueueItem(...args: unknown[]): Promise<SessionQueueMutationResponse> {
    return { ...(await this.queueMutation(args)), draft: composerDraft };
  }
  async steerQueueItem(...args: unknown[]): Promise<SessionQueueMutationResponse> {
    return this.queueMutation(args);
  }
  async deleteQueueItem(...args: unknown[]): Promise<SessionQueueMutationResponse> {
    return this.queueMutation(args);
  }
  private async queueMutation(args: unknown[]): Promise<SessionQueueMutationResponse> {
    const turnId = String(args[2]);
    queue = {
      ...queue,
      version: ++queueVersion,
      items: queue.items.filter((turn) => turn.id !== turnId),
    };
    return { snapshot: queue } as SessionQueueMutationResponse;
  }
  async pauseSession(): Promise<SessionControlResponse> {
    if (this.options.failControl) throw new Error("Fixture pause request failed.");
    return controlResponse("paused");
  }
  async resumeSession(): Promise<SessionControlResponse> {
    if (this.options.failControl) throw new Error("Fixture resume request failed.");
    return controlResponse("active");
  }
  async sendApprovalDecision(): Promise<SessionEvent> {
    events = events.filter((candidate) => candidate.type !== "session.requiresAction");
    return event(
      "user.approvalDecision",
      { approvalId: "approval-1", decision: "approve" },
      ++sequence,
    );
  }
  async getGoal(): Promise<SessionGoal> {
    return goal;
  }
  async updateGoal(
    _workspaceId: string,
    _sessionId: string,
    input: { status: "active" | "paused" },
  ): Promise<SessionGoal> {
    goal = { ...goal, status: input.status };
    return goal;
  }
  async deleteGoal(): Promise<void> {
    goal = null as never;
  }
  async listHumanInputRequests(): Promise<SessionHumanInputRequest[]> {
    return humanRequests;
  }
  async submitHumanInputResponse(): Promise<SessionEvent> {
    humanRequests = [];
    return event("user.humanInputResponse", { requestId: "input-1" }, ++sequence);
  }
  async getSessionLineage(): Promise<SessionLineageResponse> {
    return { ancestors: [], children: [], truncated: false };
  }
  async updateSessionMcpApprovalPolicy() {
    return { server: this.session().mcpServers[0], effectiveFrom: "next_attempt" };
  }
  async uploadFile(
    _workspaceId: string,
    input: { filename: string; contentType: string; data: Blob },
  ): Promise<FileAsset> {
    return {
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE_ID,
      status: "ready",
      filename: input.filename,
      safeFilename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.data.size,
      sha256: null,
      bucket: "fixture",
      objectKey: input.filename,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

function event(type: string, payload: unknown, number: number): SessionEvent {
  return {
    id: `event-${number}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence: number,
    type,
    payload,
    occurredAt: new Date(Date.parse("2026-08-29T12:00:00Z") + number * 1000).toISOString(),
    turnId: "turn-live",
  };
}
function fixtureEvents(): SessionEvent[] {
  const childSessionId = "33333333-3333-4333-8333-333333333333";
  return [
    event("session.created", {}, 1),
    event(
      "user.message",
      { text: "Review the infrastructure rollout.\nPreserve  the operator's spacing." },
      2,
    ),
    event(
      "agent.message.completed",
      {
        text: "I verified the rollout receipts.\nOne approval  and one operator answer remain before completion.",
      },
      3,
    ),
    event(
      "agent.toolCall.created",
      { id: "tool-1", name: "terraform_plan", arguments: { workspace: "production" } },
      4,
    ),
    event(
      "agent.toolCall.output",
      { id: "tool-1", name: "terraform_plan", output: "Plan: 2 to add, 0 to change, 0 to destroy" },
      5,
    ),
    event(
      "session.requiresAction",
      {
        approvals: [
          {
            approvalId: "approval-1",
            name: "terraform_apply",
            arguments: { plan: "retained-plan-42" },
          },
        ],
      },
      6,
    ),
    event("session.status.changed", { status: "requires_action" }, 7),
    event("goal.set", { text: "Ship the verified framework-neutral session UI" }, 8),
    event("turn.startup.phase.completed", { phase: "tools", durationMs: 350 }, 9),
    event(
      "agent.toolCall.created",
      {
        id: "worker-call-1",
        name: "session_create",
        arguments: JSON.stringify({ initialMessage: "Audit the release candidate independently." }),
      },
      10,
    ),
    event(
      "agent.toolCall.output",
      {
        id: "worker-call-1",
        output: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                receiptVersion: "mcp-mutation-receipt.v1",
                operation: "session_create",
                resource: { type: "session", id: childSessionId, state: "queued" },
              }),
            },
          ],
        },
      },
      11,
    ),
    event(
      "user.message",
      {
        text: "The package boundary and release closure checks pass.",
        childCompletion: {
          childSessionId,
          status: "idle",
          goal: {
            status: "completed",
            text: "Audit the release candidate independently",
            evidence: "No React runtime crossed the native Svelte boundary.",
          },
        },
      },
      12,
    ),
    event(
      "sandbox.operation.started",
      {
        name: "release-verification",
        command: "bun test packages/svelte/test",
        origin: "resumed",
      },
      13,
    ),
    event(
      "sandbox.command.output.delta",
      {
        name: "release-verification",
        chunk: "9 tests passed\n",
      },
      14,
    ),
    event("sandbox.operation.completed", { name: "release-verification" }, 15),
    event(
      "memory.saved",
      {
        memoryId: "memory-1",
        kind: "decision",
        preview: "Keep the Svelte package native and share only framework-neutral controllers.",
      },
      16,
    ),
    event("codex.fleet.decision", fleetDecisionFixture(), 17),
    event(
      "session.context.compaction.started",
      {
        trigger: "auto",
        estimatedTokensBefore: 28_800,
      },
      18,
    ),
    event(
      "session.context.compacted",
      {
        trigger: "auto",
        estimatedTokensBefore: 28_800,
        estimatedTokensAfter: 4_200,
        implementation: "responses_compaction_v2",
      },
      19,
    ),
    event(
      "tool.auth_needed",
      {
        serverId: "mcp-github",
        toolName: "create_pull_request",
        providerDomain: "github.com",
        connectionId: "connection-1",
        reason: "refresh_failed",
        scopes: ["pull_requests:write"],
      },
      20,
    ),
  ];
}
function fleetDecisionFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: "shadow",
    actual: { outcome: "selected", candidateKey: "c00", reason: "active" },
    comparison: "different_candidate",
    replay: {
      schemaVersion: 1,
      policyVersion: "adaptive-shadow-v1",
      mode: "shadow",
      input: { candidates: [{ key: "c00" }, { key: "c01" }] },
      truncatedCandidateCount: 0,
      decision: {
        outcome: "selected",
        selectedCandidateKey: "c01",
        reason: "best_score",
        admission: {
          outcome: "admit",
          reason: "work_conserving_borrow",
          borrowedIdleCapacity: true,
        },
        borrowedOverlayCapacity: false,
        strandedEligibleCount: 1,
        confidence: "low",
        scores: [
          {
            candidateKey: "c00",
            eligible: false,
            rejectionReason: "overlay_isolation",
            total: 2_000,
            confidence: "low",
          },
          {
            candidateKey: "c01",
            eligible: true,
            rejectionReason: null,
            total: 1_200,
            confidence: "low",
          },
        ],
      },
    },
  };
}
function draft(text: string): ComposerDraft {
  return {
    revision: draftRevision,
    text,
    annotations: [],
    resources: [],
    model: "gpt-5.4",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: new Date().toISOString(),
  };
}
function queueSnapshot(): SessionQueueSnapshot {
  return {
    version: queueVersion,
    effectiveControl: {
      state: "active",
      controlVersion: 1,
      controlEtag: "control-1",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [
      {
        id: "turn-queued",
        triggerEventId: "event-queued",
        prompt: "Run the final accessibility sweep",
        annotations: [],
        resources: [],
        tools: [],
        metadata: { delivery: "send" },
        version: 1,
      } as never,
    ],
    pendingInputs: [],
    pendingInputAttachment: null,
  };
}
function sessionFixture(policy: {
  selectedToolIds: readonly string[];
  firstPartyMcpTools: Session["firstPartyMcpTools"];
  toolPolicyMode: Session["toolPolicy"]["mode"];
  toolPolicyVersion: number;
}): Session {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status: "requires_action",
    title: "Framework-neutral UI release",
    titleSource: "agent",
    tools: policy.selectedToolIds.map((id) => ({ kind: "mcp", id })),
    toolPolicy: { mode: policy.toolPolicyMode, inheritedFromSessionId: null },
    toolPolicyVersion: policy.toolPolicyVersion,
    firstPartyMcpTools: [...policy.firstPartyMcpTools],
    mcpServers: [{ id: "github", name: "GitHub", requireApproval: true }],
  } as Session;
}
function goalFixture(): SessionGoal {
  return {
    id: "goal-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    status: "active",
    text: "Ship the verified framework-neutral session UI",
    successCriteria: "React and Svelte pass the same contract",
    rootConstraints: [],
    version: 1,
    objectiveRevision: 1,
  } as unknown as SessionGoal;
}
function humanInputFixture(): SessionHumanInputRequest {
  return {
    id: "input-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: "turn-live",
    turnGeneration: 1,
    creationAttemptId: "attempt-1",
    toolCallId: "tool-input",
    status: "pending",
    questions: [
      {
        id: "risk",
        kind: "single_select",
        prompt: "How should the residual rollout risk be handled?",
        options: [
          { id: "block", label: "Block release" },
          { id: "document", label: "Document and continue" },
        ],
        required: true,
        allowOther: true,
      },
    ],
    allowSkip: false,
    response: null,
    respondedBy: null,
    respondedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function controlResponse(state: "active" | "paused"): SessionControlResponse {
  return {
    effectiveControl: { ...queue.effectiveControl, state, directState: state },
    interruptionCount: 0,
    wakeCount: 0,
    cancelledSessionCount: 0,
    cancelledTurnCount: 0,
  } as SessionControlResponse;
}
