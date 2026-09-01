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
  SteerMessageResult,
  StreamSessionEventsOptions,
  SubmitComposerDraftRequest,
  SubmitComposerDraftResponse,
  UpdateSessionMcpApprovalPolicyResponse,
} from "@opengeni/sdk";
import type { SessionRuntimeClientLike } from "@opengeni/sdk/session";
import {
  FRAMEWORK_DEMO_EVENT_SPECS,
  FRAMEWORK_DEMO_SESSION_ID,
  FRAMEWORK_DEMO_TITLE,
  FRAMEWORK_DEMO_WORKSPACE_ID,
  createFrameworkDemoHumanInputRequest,
} from "../../../../test/fixtures/framework-session/demo-scenario";

export const WORKSPACE_ID = FRAMEWORK_DEMO_WORKSPACE_ID;
export const SESSION_ID = FRAMEWORK_DEMO_SESSION_ID;

let sequence = 20;
let draftRevision = 1;
let queueVersion = 2;
let events = fixtureEvents();
let composerDraft = draft("");
let queue = queueSnapshot();
let goal = goalFixture();
let humanRequests = [createFrameworkDemoHumanInputRequest()];

export class FrameworkDemoClient implements SessionRuntimeClientLike {
  readonly requests: Array<{ action: string; payload: unknown }> = [];
  private readonly eventListeners = new Set<(event: SessionEvent) => void>();

  async getSession(): Promise<Session> {
    return sessionFixture();
  }
  async updateSession(
    _workspaceId: string,
    _sessionId: string,
    input: { title: string },
  ): Promise<Session> {
    return { ...sessionFixture(), title: input.title, titleSource: "user" };
  }
  async listEvents(): Promise<SessionEvent[]> {
    return [...events];
  }
  async *streamEvents(
    _workspaceId: string,
    _sessionId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<SessionEvent, void, void> {
    const pending: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (next: SessionEvent) => {
      if (next.sequence <= (options.after ?? 0)) return;
      pending.push(next);
      wake?.();
    };
    const abort = () => wake?.();
    this.eventListeners.add(listener);
    options.signal?.addEventListener("abort", abort, { once: true });
    options.onStateChange?.("live");
    options.onOpen?.();
    try {
      while (!options.signal?.aborted) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      this.eventListeners.delete(listener);
      options.signal?.removeEventListener("abort", abort);
    }
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
    this.requests.push({ action: "composer.submit", payload: request });
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
    } as unknown as SubmitComposerDraftResponse["turn"];
    const reply = event(
      "agent.message.completed",
      { text: "Fixture accepted. The same request contract drives both demos." },
      ++sequence,
    );
    events = [...events, accepted, reply];
    this.publish(accepted, reply);
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
  async sendMessage(
    _workspaceId: string,
    _sessionId: string,
    message: string | { text: string; clientEventId?: string },
  ): Promise<SessionEvent> {
    const payload = typeof message === "string" ? { text: message } : message;
    const accepted = {
      ...event("user.message", { text: payload.text }, ++sequence),
      ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
    };
    events = [...events, accepted];
    this.publish(accepted);
    return accepted;
  }
  async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | { text: string; clientEventId?: string },
  ): Promise<SteerMessageResult> {
    const accepted = await this.sendMessage(workspaceId, sessionId, message);
    const turnId = `turn-${sequence}`;
    return {
      accepted,
      turn: {
        id: turnId,
        triggerEventId: accepted.id,
        prompt: typeof message === "string" ? message : message.text,
        version: 1,
      } as SteerMessageResult["turn"],
      receipt: {
        id: `receipt-${sequence}`,
        action: "prompt.steered",
        operationKey: accepted.clientEventId ?? accepted.id,
        targetSessionId: SESSION_ID,
        targetTurnId: turnId,
        appliedControlRevision: null,
        appliedQueueVersion: queueVersion,
        appliedTurnVersion: 1,
        appliedDraftRevision: composerDraft.revision,
        createdAt: accepted.occurredAt,
      },
      routing: "accepted_for_steering",
      interruptionCount: 1,
      replay: false,
    };
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
    this.requests.push({ action: "session.pause", payload: null });
    return controlResponse("paused");
  }
  async resumeSession(): Promise<SessionControlResponse> {
    this.requests.push({ action: "session.resume", payload: null });
    return controlResponse("active");
  }
  async sendApprovalDecision(
    _workspaceId: string,
    _sessionId: string,
    decision: { approvalId: string; decision: "approve" | "reject"; message?: string },
  ): Promise<SessionEvent> {
    this.requests.push({ action: "approval.respond", payload: decision });
    events = events.filter((candidate) => candidate.type !== "session.requiresAction");
    const response = event("user.approvalDecision", decision, ++sequence);
    events = [...events, response];
    this.publish(response);
    return response;
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
    goal = { ...goal, status: "completed" };
  }
  async listHumanInputRequests(): Promise<SessionHumanInputRequest[]> {
    return humanRequests;
  }
  async submitHumanInputResponse(
    _workspaceId: string,
    _sessionId: string,
    requestId: string,
    response: unknown,
  ): Promise<SessionEvent> {
    this.requests.push({ action: "human-input.respond", payload: { requestId, response } });
    humanRequests = [];
    const accepted = event("user.humanInputResponse", { requestId, response }, ++sequence);
    events = [...events, accepted];
    this.publish(accepted);
    return accepted;
  }
  async getSessionLineage(): Promise<SessionLineageResponse> {
    return { ancestors: [], children: [], truncated: false };
  }
  async updateSessionMcpApprovalPolicy(): Promise<UpdateSessionMcpApprovalPolicyResponse> {
    return {
      server: sessionFixture().mcpServers[0]!,
      effectiveFrom: "next_attempt",
    };
  }
  async uploadFile(
    _workspaceId: string,
    input: { filename: string; contentType: string; data: Blob },
  ): Promise<FileAsset> {
    this.requests.push({ action: "file.upload", payload: { filename: input.filename } });
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

  private publish(...published: SessionEvent[]): void {
    for (const next of published) {
      for (const listener of this.eventListeners) listener(next);
    }
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
  return FRAMEWORK_DEMO_EVENT_SPECS.map((spec, index) => ({
    ...event(spec.type, spec.payload, index + 1),
    turnId: spec.turnId ?? null,
  }));
}
function draft(text: string): ComposerDraft {
  return {
    revision: draftRevision,
    text,
    annotations: [],
    resources: [],
    model: "gpt-5.6-sol",
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
    items: [],
    pendingInputs: [],
    pendingInputAttachment: null,
  };
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
function sessionFixture(): Session {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status: "running",
    title: FRAMEWORK_DEMO_TITLE,
    titleSource: "agent",
    mcpServers: [{ id: "github", name: "GitHub", requireApproval: true }],
  } as Session;
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
