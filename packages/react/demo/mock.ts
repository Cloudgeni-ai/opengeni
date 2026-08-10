/* ----------------------------------------------------------------------------
   Scripted mock OpenGeni client for the harness.

   Implements the `SessionClientLike` surface the hooks use, backed by an
   in-memory event bus, so the real hooks + components run against a
   realistic manager ops-channel narrative (streaming deltas, tool calls,
   worker spawns) without a server. Swap in the real `OpenGeniClient` and
   everything renders identically.
   -------------------------------------------------------------------------- */

import type {
  AcknowledgeStreamResponse,
  AuthRun,
  AuthRunListOptions,
  AuthRunListResponse,
  AuthRunMutationResponse,
  AttachViewerResponse,
  AttachedBrowserDevice,
  AttachedBrowserDeviceListOptions,
  AttachedBrowserDeviceListResponse,
  BillingUsageResponse,
  BrowserActionReceipt,
  BrowserActionRequest,
  BrowserDiagnosticBatch,
  BrowserDiagnosticsOptions,
  BrowserIdentity,
  BrowserIdentityListOptions,
  BrowserIdentityListResponse,
  BrowserIdentityMutationResponse,
  BrowserObservation,
  BrowserOpenTargetRequest,
  BrowserSession,
  BrowserSessionAttachment,
  BrowserSessionAttachmentRequest,
  BrowserSessionHeartbeatResponse,
  BrowserSessionLifecycleRequest,
  BrowserSessionListResponse,
  BrowserSessionMutationResponse,
  BrowserTarget,
  BrowserTargetListResponse,
  BrowserRevision,
  BrowserRevisionListResponse,
  CapabilityPack,
  ClientConfig,
  ComposerDraft,
  ComputerActionReceipt,
  ComputerActionRequest,
  ComputerObservation,
  ComputerSession,
  ComputerSessionAttachment,
  ComputerSessionAttachmentRequest,
  ComputerSessionHeartbeatResponse,
  ComputerSessionLifecycleRequest,
  ComputerSessionListResponse,
  ComputerSessionMutationResponse,
  ComputerTarget,
  ComputerTargetListResponse,
  CreateComputerSessionRequest,
  CreateSessionRequest,
  CreateBrowserIdentityRequest,
  CreateBrowserSessionRequest,
  CreateInteractionInterventionRequest,
  CreateNetworkRouteRequest,
  CreateSiteAuthConnectionRequest,
  CreateWorkspaceEnvironmentRequest,
  CreateVariableSetRequest,
  CreateRigRequest,
  UpdateRigRequest,
  ProposeRigChangeRequest,
  PublishBrowserRevisionRequest,
  PublishBrowserRevisionResponse,
  ReportAuthRunRequest,
  ResolveInteractionInterventionRequest,
  Rig,
  RigVersion,
  RigChange,
  CreateWorkspaceRequest,
  EnablePackRequest,
  InstallPackRequest,
  FileAsset,
  FileDownloadUrlResponse,
  FsListResponse,
  FsListBatchResponse,
  FsReadResponse,
  FsWriteResponse,
  FsDeleteResponse,
  FsMoveResponse,
  FsMkdirResponse,
  FsTreeNode,
  GitDiffResponse,
  GitReadBatchResponse,
  GetWorkspaceCaptureResponse,
  GetWorkspaceCaptureFileResponse,
  GitStatusResponse,
  InteractionIntervention,
  InteractionInterventionListOptions,
  InteractionInterventionListResponse,
  InteractionInterventionMutationResponse,
  ListPacksResponse,
  NetworkRoute,
  NetworkRouteListOptions,
  NetworkRouteListResponse,
  NetworkRouteMutationResponse,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
  PreviewPackInstallationRequest,
  ProtectedAuthFillRequest,
  ProtectedAuthFillResponse,
  PtyOpenResponse,
  RegisterCapabilityPackRequest,
  SessionCapabilities,
  TerminalExecResponse,
  ViewerHeartbeatResponse,
  ScheduledTask,
  SendMessageInput,
  Session,
  SessionListResponse,
  SessionEvent,
  SessionGoal,
  SessionHumanInputRequest,
  SessionLineageResponse,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionControlResponse,
  SessionStatus,
  SessionTurn,
  SiteAuthConnection,
  SiteAuthConnectionListOptions,
  SiteAuthConnectionListResponse,
  SiteAuthConnectionMutationResponse,
  StartAuthRunRequest,
  SteerMessageResult,
  StreamSessionEventsOptions,
  SubmitHumanInputResponseRequest,
  UploadFileInput,
  UpdateSessionGoalRequest,
  UpdateSessionMcpApprovalPolicyRequest,
  UpdateSessionMcpApprovalPolicyResponse,
  UpdateSessionRequest,
  UpdateSessionPinRequest,
  UpdateNetworkRouteRequest,
  UpdateSiteAuthConnectionRequest,
  UpdateWorkspaceEnvironmentRequest,
  UpdateVariableSetRequest,
  UpdateWorkspaceRequest,
  UninstallPackRequest,
  UninstallPackResult,
  Workspace,
  WorkspaceControlEvent,
  WorkspaceInteractionRevisionEvent,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
  VariableSet,
  VariableSetSecret,
  VariableSetVariableMetadata,
  VerifyAuthRunRequest,
  WorkspaceRegisteredPack,
  WorkspaceRealtimeModelCatalogResponse,
} from "@opengeni/sdk";
import type { SessionClientLike } from "@opengeni/react";
import type { MachinesResponse } from "@opengeni/react/machines";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
export const MANAGER_SESSION_ID = "3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const WORKER_SESSION_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
export const DEMO_BROWSER_SESSION_ID = "81000000-0000-4000-8000-000000000001";
export const DEMO_BROWSER_TARGET_ID = "82000000-0000-4000-8000-000000000001";
export const DEMO_BROWSER_IDENTITY_ID = "83000000-0000-4000-8000-000000000001";
export const DEMO_COMPUTER_SESSION_ID = "84000000-0000-4000-8000-000000000001";
export const DEMO_COMPUTER_WINDOW_ID = "85000000-0000-4000-8000-000000000001";
export const DEMO_COMPUTER_SCREEN_ID = "85000000-0000-4000-8000-000000000002";
let nextDemoUuid = 0;

/** Stable UUIDs keep screenshots deterministic and work in Vite's module
 *  evaluation context, where the browser-only `crypto.randomUUID` API is not
 *  guaranteed to exist. */
function demoUuid(): string {
  nextDemoUuid += 1;
  return `00000000-0000-4000-8000-${String(nextDemoUuid).padStart(12, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SessionBus {
  readonly events: SessionEvent[] = [];
  private listeners = new Set<(event: SessionEvent) => void>();
  private sequence = 0;
  status: SessionStatus = "idle";

  constructor(readonly sessionId: string) {}

  append(type: string, payload: unknown, turnId: string | null = null): SessionEvent {
    this.sequence += 1;
    const event: SessionEvent = {
      id: `evt-${this.sessionId.slice(0, 4)}-${this.sequence}`,
      workspaceId: WORKSPACE_ID,
      sessionId: this.sessionId,
      sequence: this.sequence,
      type,
      payload,
      occurredAt: new Date().toISOString(),
      turnId,
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }

  setStatus(status: SessionStatus): void {
    this.status = status;
    this.append("session.status.changed", { status });
  }

  async *stream(after: number, signal?: AbortSignal): AsyncGenerator<SessionEvent, void, void> {
    const queue: SessionEvent[] = this.events.filter((event) => event.sequence > after);
    let wake: (() => void) | null = null;
    const listener = (event: SessionEvent) => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);
    try {
      while (true) {
        if (signal?.aborted) break;
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
    } finally {
      this.listeners.delete(listener);
    }
  }
}

export class MockOpenGeniClient implements SessionClientLike {
  private buses = new Map<string, SessionBus>();
  private queueVersions = new Map<string, number>();
  private pausedSessions = new Set<string>();
  private drafts = new Map<string, ComposerDraft>();
  private scripted = false;
  private managerScript: Promise<void> | null = null;
  private responseQueues = new Map<string, Promise<void>>();
  private networkRouteRevision = 1;
  private networkRoutes = new Map<string, NetworkRoute>();
  private siteAuthRevision = 1;
  private siteAuthConnections = new Map<string, SiteAuthConnection>();
  private authRuns = new Map<string, AuthRun>();
  private interventions = new Map<string, InteractionIntervention>();
  private browserRevision = 1;
  private browserIdentities = new Map<string, BrowserIdentity>([
    [DEMO_BROWSER_IDENTITY_ID, fabricateBrowserIdentity()],
  ]);
  private browserIdentityRevisions = new Map<string, BrowserRevision[]>([
    [DEMO_BROWSER_IDENTITY_ID, []],
  ]);
  private browserSessions = new Map<string, BrowserSession>([
    [DEMO_BROWSER_SESSION_ID, fabricateBrowserSession(MANAGER_SESSION_ID)],
  ]);
  private browserTargets = new Map<string, BrowserTarget[]>([
    [DEMO_BROWSER_SESSION_ID, [fabricateBrowserTarget(DEMO_BROWSER_SESSION_ID)]],
  ]);
  private computerRevision = 1;
  private computerSessions = new Map<string, ComputerSession>([
    [DEMO_COMPUTER_SESSION_ID, fabricateComputerSession(MANAGER_SESSION_ID)],
  ]);
  private computerTargets = new Map<string, ComputerTarget[]>([
    [
      DEMO_COMPUTER_SESSION_ID,
      [
        fabricateComputerTarget(DEMO_COMPUTER_SESSION_ID),
        fabricateComputerTarget(DEMO_COMPUTER_SESSION_ID, {
          id: DEMO_COMPUTER_SCREEN_ID,
          targetGeneration: "demo-screen-1",
          kind: "screen",
          applicationId: null,
          processId: null,
          title: "Agent desktop",
          bounds: { x: 0, y: 0, width: 1_280, height: 720 },
          focused: false,
        }),
      ],
    ],
  ]);

  bus(sessionId: string): SessionBus {
    let bus = this.buses.get(sessionId);
    if (!bus) {
      bus = new SessionBus(sessionId);
      this.buses.set(sessionId, bus);
    }
    return bus;
  }

  async getClientConfig(): Promise<ClientConfig> {
    return CLIENT_CONFIG;
  }

  async getWorkspaceModelCatalog(_workspaceId: string) {
    return {
      models: (CLIENT_CONFIG.models ?? []).map((model) => ({
        ...model,
        credentialReadiness: {
          status: "ready" as const,
          reason: null,
          basis: "configuration" as const,
          checkedAt: null,
        },
        availability: {
          status: "available" as const,
          selectable: true,
          reason: null,
          checkedAt: null,
        },
      })),
    };
  }

  async getWorkspaceRealtimeModelCatalog(
    _workspaceId: string,
  ): Promise<WorkspaceRealtimeModelCatalogResponse> {
    return {
      models: [
        {
          id: "opengeni-gateway/openai/gpt-realtime-2.1",
          label: "GPT Realtime 2.1",
          provider: "OpenGeni",
          description: "Best overall voice intelligence",
          available: true,
          unavailableReason: null,
          recommended: true,
        },
        {
          id: "gpt-live-1-boulder-alpha",
          label: "Codex Live",
          provider: "Connected Codex",
          description: "Deep session integration",
          available: true,
          unavailableReason: null,
          recommended: false,
        },
        {
          id: "workspace-gateway/openai/gpt-realtime-mini",
          label: "GPT Realtime Mini",
          provider: "Your Gateway",
          description: "Faster, lighter live voice",
          available: true,
          unavailableReason: null,
          recommended: false,
        },
      ],
    };
  }

  async createSession(
    _workspaceId: string,
    request: CreateSessionRequest,
  ): Promise<Session & { initialTurnId: string | null }> {
    const sessionId = request.requestedSessionId ?? demoUuid();
    const bus = this.bus(sessionId);
    bus.setStatus("idle");
    return {
      ...this.fabricateSession(sessionId, "idle", "Realtime-first demo session"),
      createIdempotencyKey: request.idempotencyKey ?? null,
      initialTurnId: null,
    };
  }

  async getSession(_workspaceId: string, sessionId: string): Promise<Session> {
    return this.fabricateSession(
      sessionId,
      this.bus(sessionId).status,
      "Ops channel — manager session",
    );
  }

  async getSessionLineage(
    _workspaceId: string,
    sessionId: string,
  ): Promise<SessionLineageResponse> {
    const children =
      sessionId === MANAGER_SESSION_ID
        ? [
            {
              session: this.fabricateSession(WORKER_SESSION_ID, "running", "Worker session"),
              children: [],
            },
          ]
        : [];
    return { ancestors: [], children, truncated: false };
  }

  async updateSession(
    _workspaceId: string,
    sessionId: string,
    request: UpdateSessionRequest,
  ): Promise<Session> {
    const session = this.fabricateSession(
      sessionId,
      this.bus(sessionId).status,
      "Ops channel — manager session",
    );
    return { ...session, title: request.title, titleSource: "user" };
  }

  async updateSessionMcpApprovalPolicy(
    _workspaceId: string,
    _sessionId: string,
    serverId: string,
    request: UpdateSessionMcpApprovalPolicyRequest,
  ): Promise<UpdateSessionMcpApprovalPolicyResponse> {
    return {
      server: {
        id: serverId,
        name: serverId,
        url: "https://tools.example.test/mcp",
        headerNames: [],
        credentialVersion: 1,
        requireApproval: request.requireApproval,
        connectionRef: null,
      },
      effectiveFrom: "next_attempt",
    };
  }

  async updateSessionPin(
    _workspaceId: string,
    sessionId: string,
    request: UpdateSessionPinRequest,
  ): Promise<Session> {
    const session = this.fabricateSession(
      sessionId,
      this.bus(sessionId).status,
      "Ops channel — manager session",
    );
    return {
      ...session,
      pinned: request.pinned,
      pinnedAt: request.pinned ? new Date().toISOString() : null,
      pinVersion: request.pinned ? Math.max(1, (session.pinVersion ?? 0) + 1) : 0,
    };
  }

  async listSessions(): Promise<Session[]> {
    return FLEET.map((spec) =>
      this.fabricateSession(spec.id, spec.status, spec.title, spec.agoMinutes),
    );
  }

  async listSessionPage(): Promise<SessionListResponse> {
    return {
      pinned: [],
      pinnedTruncated: false,
      sessions: FLEET.map((spec) =>
        this.fabricateSession(spec.id, spec.status, spec.title, spec.agoMinutes),
      ),
      nextCursor: null,
    };
  }

  async listEvents(
    _workspaceId: string,
    sessionId: string,
    options: { after?: number; before?: number; limit?: number } = {},
  ): Promise<SessionEvent[]> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 500;
    let events = this.bus(sessionId).events.filter((event) => event.sequence > after);
    if (options.before !== undefined) {
      const before = options.before;
      events = events.filter((event) => event.sequence < before);
      return events.slice(-limit);
    }
    return events.slice(0, limit);
  }

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    return SCHEDULED_TASKS;
  }

  async sendMessage(
    _workspaceId: string,
    sessionId: string,
    message: string | { text: string },
  ): Promise<SessionEvent> {
    const bus = this.bus(sessionId);
    const text = typeof message === "string" ? message : message.text;
    // The managed API accepts the message and clears the matching durable
    // composer draft atomically. Mirror that ordering before publishing the
    // user.message invalidation so a reconciliation read cannot resurrect the
    // just-submitted text and leave the Send action enabled.
    const currentDraft = await this.getComposerDraft(_workspaceId, sessionId);
    this.drafts.set(sessionId, {
      ...currentDraft,
      revision: currentDraft.revision + 1,
      text: "",
      resources: [],
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    });
    const event = bus.append("user.message", { text });
    this.queueResponse(bus, text);
    return event;
  }

  async pauseSession(_workspaceId: string, sessionId: string): Promise<SessionControlResponse> {
    const bus = this.bus(sessionId);
    bus.append("session.control.paused", {});
    this.pausedSessions.add(sessionId);
    return this.controlResponse(sessionId, "pause");
  }

  async resumeSession(_workspaceId: string, sessionId: string): Promise<SessionControlResponse> {
    const bus = this.bus(sessionId);
    bus.append("session.control.resumed", {});
    bus.setStatus("idle");
    this.pausedSessions.delete(sessionId);
    return this.controlResponse(sessionId, "resume");
  }

  streamEvents(
    _workspaceId: string,
    sessionId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<SessionEvent, void, void> {
    options.onStateChange?.("connecting");
    const bus = this.bus(sessionId);
    if (sessionId === MANAGER_SESSION_ID && !this.scripted) {
      this.scripted = true;
      const script = runOpsChannelScript(bus);
      this.managerScript = script;
      void script.then(
        () => {
          if (this.managerScript === script) this.managerScript = null;
        },
        () => {
          if (this.managerScript === script) this.managerScript = null;
        },
      );
    }
    options.onStateChange?.("live");
    return bus.stream(options.after ?? 0, options.signal);
  }

  // --- Turn queue (in-memory, drives the queue UI in the demo) ---------------

  private turns = new Map<string, SessionTurn[]>();

  private sessionTurns(sessionId: string): SessionTurn[] {
    let turns = this.turns.get(sessionId);
    if (!turns) {
      turns = [
        fabricateTurn(sessionId, 1, "Summarize the staging rollout status for the changelog"),
        fabricateTurn(sessionId, 2, "Open a PR bumping the api service base image"),
      ];
      this.turns.set(sessionId, turns);
    }
    return turns;
  }

  async listTurns(_workspaceId: string, sessionId: string): Promise<SessionTurn[]> {
    return [...this.sessionTurns(sessionId)];
  }

  async getQueue(_workspaceId: string, sessionId: string): Promise<SessionQueueSnapshot> {
    return this.queueSnapshot(sessionId);
  }

  async deleteQueueItem(
    _workspaceId: string,
    sessionId: string,
    turnId: string,
  ): Promise<SessionQueueMutationResponse> {
    const turns = this.sessionTurns(sessionId);
    const turn = turns.find(
      (candidate) => candidate.id === turnId && candidate.status === "queued",
    );
    if (!turn) throw new Error(`queued turn not found: ${turnId}`);
    turn.status = "cancelled";
    turn.version += 1;
    this.bus(sessionId).append("turn.cancelled", { turnId }, turnId);
    return this.queueMutation(sessionId);
  }

  async moveQueueItem(
    _workspaceId: string,
    sessionId: string,
    turnId: string,
    request: { beforeTurnId: string | null },
  ): Promise<SessionQueueMutationResponse> {
    const turns = this.sessionTurns(sessionId).filter((turn) => turn.status === "queued");
    const moving = turns.find((turn) => turn.id === turnId);
    if (!moving) throw new Error("queued turn not found");
    const ordered = turns.filter((turn) => turn.id !== turnId);
    const index =
      request.beforeTurnId === null
        ? ordered.length
        : ordered.findIndex((turn) => turn.id === request.beforeTurnId);
    ordered.splice(Math.max(0, index), 0, moving);
    ordered.forEach((turn, position) => (turn.position = position + 1));
    this.turns.set(sessionId, ordered);
    return this.queueMutation(sessionId, "queue.move", turnId);
  }

  async editQueueItem(
    _workspaceId: string,
    sessionId: string,
    turnId: string,
  ): Promise<SessionQueueMutationResponse> {
    const turn = this.sessionTurns(sessionId).find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error("queued turn not found");
    turn.status = "withdrawn_for_edit";
    const draft: ComposerDraft = {
      revision: 1,
      text: turn.prompt,
      resources: turn.resources,
      model: turn.model,
      reasoningEffort: turn.reasoningEffort,
      sourceTurnId: turn.id,
      sourceTurnVersion: turn.version,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(sessionId, draft);
    return { ...this.queueMutation(sessionId, "queue.edit", turnId), draft };
  }

  async steerQueueItem(
    _workspaceId: string,
    sessionId: string,
    turnId: string,
  ): Promise<SessionQueueMutationResponse> {
    const turns = this.sessionTurns(sessionId);
    const index = turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) throw new Error("queued turn not found");
    const [turn] = turns.splice(index, 1);
    turns.unshift(turn!);
    turns.forEach((candidate, position) => (candidate.position = position + 1));
    this.pausedSessions.delete(sessionId);
    return this.queueMutation(sessionId, "queue.steer", turnId);
  }

  async getComposerDraft(_workspaceId: string, sessionId: string): Promise<ComposerDraft> {
    return (
      this.drafts.get(sessionId) ?? {
        revision: 0,
        text: "",
        resources: [],
        model: "gpt-5.2",
        reasoningEffort: "medium",
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: null,
      }
    );
  }

  async saveComposerDraft(
    _workspaceId: string,
    sessionId: string,
    request: Omit<ComposerDraft, "revision" | "sourceTurnId" | "sourceTurnVersion" | "updatedAt">,
  ): Promise<ComposerDraft> {
    const current = await this.getComposerDraft(_workspaceId, sessionId);
    const draft: ComposerDraft = {
      ...request,
      revision: current.revision + 1,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(sessionId, draft);
    return draft;
  }

  async setWorkspaceInferenceState() {
    return {
      receipt: this.receipt("workspace.control", null),
      state: "active" as const,
      revision: 1,
      interruptionCount: 0,
      wakeCount: 0,
    };
  }

  private queueSnapshot(sessionId: string): SessionQueueSnapshot {
    return {
      version: this.queueVersions.get(sessionId) ?? 0,
      effectiveControl: this.effectiveControl(sessionId),
      activePersonalConnections: [],
      stoppingPreviousAttempt: false,
      items: this.sessionTurns(sessionId).filter((turn) => turn.status === "queued"),
      pendingInputs: [],
      pendingInputAttachment: null,
    };
  }

  private queueMutation(
    sessionId: string,
    action = "queue.delete",
    turnId: string | null = null,
  ): SessionQueueMutationResponse {
    this.queueVersions.set(sessionId, (this.queueVersions.get(sessionId) ?? 0) + 1);
    return { receipt: this.receipt(action, turnId), snapshot: this.queueSnapshot(sessionId) };
  }

  private receipt(action: string, turnId: string | null) {
    return {
      id: demoUuid(),
      action,
      operationKey: demoUuid(),
      targetSessionId: MANAGER_SESSION_ID,
      targetTurnId: turnId,
      appliedControlRevision: 1,
      appliedQueueVersion: 1,
      appliedTurnVersion: 1,
      appliedDraftRevision: null,
      createdAt: new Date().toISOString(),
    };
  }

  private effectiveControl(sessionId: string) {
    const paused = this.pausedSessions.has(sessionId);
    return {
      state: paused ? ("paused" as const) : ("active" as const),
      controlVersion: paused ? 1 : 0,
      controlEtag: `demo-${sessionId}-${paused}`,
      directState: paused ? ("paused" as const) : ("active" as const),
      primaryBlocker: paused
        ? {
            kind: "session" as const,
            sessionId,
            displayName: "Paused here",
            actor: "demo operator",
            reason: null,
            changedAt: new Date().toISOString(),
            revision: 1,
          }
        : null,
      additionalBlockerCount: 0,
      blockers: paused
        ? [
            {
              kind: "session" as const,
              sessionId,
              displayName: "Paused here",
              actor: "demo operator",
              reason: null,
              changedAt: new Date().toISOString(),
              revision: 1,
            },
          ]
        : [],
      resumeOptions: paused
        ? [
            {
              scope: "selected" as const,
              targetId: sessionId,
              selectedStateAfter: "active" as const,
              impactCopy: "This workstream can run.",
            },
          ]
        : [],
      override: null,
      settlement: null,
    };
  }

  private controlResponse(sessionId: string, action: string): SessionControlResponse {
    return {
      receipt: this.receipt(`session.${action}`, null),
      effectiveControl: this.effectiveControl(sessionId),
      interruptionCount: 0,
      wakeCount: 0,
      cancelledSessionCount: 0,
      cancelledTurnCount: 0,
    };
  }

  async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SteerMessageResult> {
    const accepted = await this.sendMessage(workspaceId, sessionId, message);
    const prompt = typeof message === "string" ? message : message.text;
    const turns = this.sessionTurns(sessionId);
    for (const queued of turns) {
      if (queued.status === "queued") queued.position += 1;
    }
    const turn = fabricateTurn(sessionId, 1, prompt);
    turn.triggerEventId = accepted.id;
    turns.unshift(turn);
    return { accepted, turn: { ...turn } };
  }

  // --- Goal -------------------------------------------------------------------

  private goals = new Map<string, SessionGoal>();

  async getGoal(_workspaceId: string, sessionId: string): Promise<SessionGoal> {
    let goal = this.goals.get(sessionId);
    if (!goal) {
      goal = fabricateGoal(sessionId);
      this.goals.set(sessionId, goal);
    }
    return { ...goal };
  }

  async updateGoal(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionGoalRequest,
  ): Promise<SessionGoal> {
    const goal = await this.getGoal(workspaceId, sessionId);
    goal.status = request.status;
    goal.rationale = request.rationale ?? goal.rationale;
    goal.pausedReason = request.status === "paused" ? "api" : null;
    goal.updatedAt = new Date().toISOString();
    this.goals.set(sessionId, goal);
    this.bus(sessionId).append(request.status === "paused" ? "goal.paused" : "goal.resumed", {
      goalId: goal.id,
    });
    return { ...goal };
  }

  async deleteGoal(_workspaceId: string, sessionId: string): Promise<void> {
    const goal = this.goals.get(sessionId);
    this.goals.delete(sessionId);
    if (goal) {
      this.bus(sessionId).append("goal.cleared", { goalId: goal.id });
    }
  }

  async clearSessionContext(_workspaceId: string, sessionId: string): Promise<void> {
    this.bus(sessionId).append("session.context.cleared", { clearedBy: "api" });
  }

  async compactSessionContext(
    _workspaceId: string,
    sessionId: string,
  ): Promise<{ status: "completed" | "noop"; message: string }> {
    this.bus(sessionId).append("session.context.compaction.started", {
      trigger: "operator",
      estimatedTokensBefore: 120_000,
    });
    this.bus(sessionId).append("session.context.compacted", {
      trigger: "operator",
      estimatedTokensBefore: 120_000,
      estimatedTokensAfter: 24_000,
    });
    return { status: "completed", message: "Context compacted." };
  }

  async sendApprovalDecision(
    _workspaceId: string,
    sessionId: string,
    decision: { approvalId: string; decision: "approve" | "reject"; message?: string },
  ): Promise<SessionEvent> {
    return this.bus(sessionId).append("user.approvalDecision", decision);
  }

  async listHumanInputRequests(): Promise<SessionHumanInputRequest[]> {
    return [];
  }

  async getHumanInputRequest(
    _workspaceId: string,
    _sessionId: string,
    requestId: string,
  ): Promise<SessionHumanInputRequest> {
    throw new Error(`No demo human-input request ${requestId}`);
  }

  async submitHumanInputResponse(
    _workspaceId: string,
    sessionId: string,
    requestId: string,
    response: SubmitHumanInputResponseRequest,
  ): Promise<SessionEvent> {
    return this.bus(sessionId).append("user.humanInputResponse", { requestId, response });
  }

  // --- Environments, packs, workspaces, billing (static-ish fixtures) ----------

  private environments: WorkspaceEnvironment[] = [
    fabricateEnvironment("staging"),
    fabricateEnvironment("production"),
  ];

  async listEnvironments(): Promise<WorkspaceEnvironment[]> {
    return [...this.environments];
  }

  async listVariableSets(): Promise<VariableSet[]> {
    return await this.listEnvironments();
  }

  async getVariableSetVariable(
    _workspaceId: string,
    variableSetId: string,
    name: string,
  ): Promise<VariableSetSecret> {
    const variableSet = this.environments.find((candidate) => candidate.id === variableSetId);
    const variable = variableSet?.variables.find((candidate) => candidate.name === name);
    if (!variableSet || !variable) {
      throw new Error("variable set variable not found");
    }
    return {
      variableSetId,
      name,
      version: variable.version,
      value: "demo-secret-value",
    };
  }

  async createEnvironment(
    _workspaceId: string,
    request: CreateWorkspaceEnvironmentRequest,
  ): Promise<WorkspaceEnvironment> {
    const environment = fabricateEnvironment(
      request.name,
      request.variables?.map((variable) => variable.name) ?? [],
    );
    this.environments.push(environment);
    return { ...environment };
  }

  async createVariableSet(
    workspaceId: string,
    request: CreateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.createEnvironment(workspaceId, request);
  }

  async updateEnvironment(
    _workspaceId: string,
    environmentId: string,
    request: UpdateWorkspaceEnvironmentRequest,
  ): Promise<WorkspaceEnvironment> {
    const environment = this.environments.find((candidate) => candidate.id === environmentId);
    if (!environment) {
      throw new Error("environment not found");
    }
    if (request.name !== undefined) {
      environment.name = request.name;
    }
    if (request.description !== undefined) {
      environment.description = request.description;
    }
    return { ...environment };
  }

  async updateVariableSet(
    workspaceId: string,
    variableSetId: string,
    request: UpdateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.updateEnvironment(workspaceId, variableSetId, request);
  }

  async deleteEnvironment(_workspaceId: string, environmentId: string): Promise<void> {
    this.environments = this.environments.filter((candidate) => candidate.id !== environmentId);
  }

  async deleteVariableSet(workspaceId: string, variableSetId: string): Promise<void> {
    await this.deleteEnvironment(workspaceId, variableSetId);
  }

  async setEnvironmentVariable(
    _workspaceId: string,
    environmentId: string,
    name: string,
    _value: string,
  ): Promise<WorkspaceEnvironmentVariableMetadata> {
    const environment = this.environments.find((candidate) => candidate.id === environmentId);
    if (!environment) {
      throw new Error("environment not found");
    }
    const now = new Date().toISOString();
    const existing = environment.variables.find((variable) => variable.name === name);
    if (existing) {
      existing.version += 1;
      existing.updatedAt = now;
      return { ...existing };
    }
    const created = { name, version: 1, createdAt: now, updatedAt: now };
    environment.variables.push(created);
    return { ...created };
  }

  async setVariableSetVariable(
    workspaceId: string,
    variableSetId: string,
    name: string,
    value: string,
  ): Promise<VariableSetVariableMetadata> {
    return await this.setEnvironmentVariable(workspaceId, variableSetId, name, value);
  }

  async deleteEnvironmentVariable(
    _workspaceId: string,
    environmentId: string,
    name: string,
  ): Promise<void> {
    const environment = this.environments.find((candidate) => candidate.id === environmentId);
    if (environment) {
      environment.variables = environment.variables.filter((variable) => variable.name !== name);
    }
  }

  async deleteVariableSetVariable(
    workspaceId: string,
    variableSetId: string,
    name: string,
  ): Promise<void> {
    await this.deleteEnvironmentVariable(workspaceId, variableSetId, name);
  }

  // Rigs — minimal in-memory demo store (real UI lands in M5).
  private rigs: Rig[] = [];
  private rigVersions: RigVersion[] = [];
  private rigChanges: RigChange[] = [];

  async listRigs(): Promise<Rig[]> {
    return [...this.rigs];
  }

  async createRig(_workspaceId: string, request: CreateRigRequest): Promise<Rig> {
    const now = new Date().toISOString();
    const rigId = `rig-${this.rigs.length + 1}`;
    const version: RigVersion = {
      id: `${rigId}-v1`,
      rigId,
      version: 1,
      image: request.image ?? null,
      setupScript: request.setupScript ?? null,
      checks: request.checks ?? [],
      credentialHooks: request.credentialHooks ?? [],
      defaultVariableSetIds: request.defaultVariableSetIds ?? [],
      changelog: "Initial version",
      providerImages: {},
      createdBy: "user:demo",
      active: true,
      createdAt: now,
    };
    const rig: Rig = {
      id: rigId,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      name: request.name,
      description: request.description ?? null,
      createdBy: "user:demo",
      activeVersion: version,
      versionCount: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rigs.push(rig);
    this.rigVersions.push(version);
    return rig;
  }

  async getRig(_workspaceId: string, rigId: string): Promise<Rig> {
    const rig = this.rigs.find((candidate) => candidate.id === rigId);
    if (!rig) {
      throw new Error(`rig not found: ${rigId}`);
    }
    return rig;
  }

  async updateRig(_workspaceId: string, rigId: string, request: UpdateRigRequest): Promise<Rig> {
    const rig = await this.getRig(_workspaceId, rigId);
    if (request.name !== undefined) {
      rig.name = request.name;
    }
    if (request.description !== undefined) {
      rig.description = request.description;
    }
    rig.updatedAt = new Date().toISOString();
    return rig;
  }

  async deleteRig(_workspaceId: string, rigId: string): Promise<void> {
    this.rigs = this.rigs.filter((candidate) => candidate.id !== rigId);
    this.rigVersions = this.rigVersions.filter((candidate) => candidate.rigId !== rigId);
    this.rigChanges = this.rigChanges.filter((candidate) => candidate.rigId !== rigId);
  }

  async listRigVersions(_workspaceId: string, rigId: string): Promise<RigVersion[]> {
    return this.rigVersions
      .filter((candidate) => candidate.rigId === rigId)
      .sort((a, b) => b.version - a.version);
  }

  async activateRigVersion(
    _workspaceId: string,
    rigId: string,
    versionId: string,
  ): Promise<RigVersion> {
    let activated: RigVersion | undefined;
    for (const version of this.rigVersions) {
      if (version.rigId === rigId) {
        version.active = version.id === versionId;
        if (version.active) {
          activated = version;
        }
      }
    }
    if (!activated) {
      throw new Error(`rig version not found: ${versionId}`);
    }
    const rig = this.rigs.find((candidate) => candidate.id === rigId);
    if (rig) {
      rig.activeVersion = activated;
      rig.updatedAt = new Date().toISOString();
    }
    return activated;
  }

  async listRigChanges(_workspaceId: string, rigId: string): Promise<RigChange[]> {
    return this.rigChanges.filter((candidate) => candidate.rigId === rigId);
  }

  async proposeRigChange(
    _workspaceId: string,
    rigId: string,
    request: ProposeRigChangeRequest,
  ): Promise<RigChange> {
    const rig = await this.getRig(_workspaceId, rigId);
    const now = new Date().toISOString();
    const change: RigChange = {
      id: `${rigId}-change-${this.rigChanges.length + 1}`,
      rigId,
      baseVersionId: rig.activeVersion?.id ?? null,
      kind: request.kind,
      payload: request.payload as Record<string, unknown>,
      status: "proposed",
      proposedBy: "user:demo",
      verification: null,
      resultVersionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rigChanges.push(change);
    return change;
  }

  async getRigChange(_workspaceId: string, rigId: string, changeId: string): Promise<RigChange> {
    const change = this.rigChanges.find(
      (candidate) => candidate.id === changeId && candidate.rigId === rigId,
    );
    if (!change) {
      throw new Error(`rig change not found: ${changeId}`);
    }
    return change;
  }

  async verifyRigChange(_workspaceId: string, rigId: string, changeId: string): Promise<RigChange> {
    const change = await this.getRigChange(_workspaceId, rigId, changeId);
    change.status = "verifying";
    change.updatedAt = new Date().toISOString();
    return change;
  }

  async promoteRigChange(
    _workspaceId: string,
    rigId: string,
    changeId: string,
  ): Promise<RigVersion> {
    const change = await this.getRigChange(_workspaceId, rigId, changeId);
    const rig = this.rigs.find((candidate) => candidate.id === rigId);
    const base = rig?.activeVersion ?? null;
    const now = new Date().toISOString();
    const version: RigVersion = {
      id: `${rigId}-v${this.rigVersions.filter((candidate) => candidate.rigId === rigId).length + 1}`,
      rigId,
      version: (base?.version ?? 0) + 1,
      image: base?.image ?? null,
      setupScript: base?.setupScript ?? null,
      checks: base?.checks ?? [],
      credentialHooks: base?.credentialHooks ?? [],
      defaultVariableSetIds: base?.defaultVariableSetIds ?? [],
      changelog: "Promoted from a verified change",
      providerImages: {},
      createdBy: "user:demo",
      active: true,
      createdAt: now,
    };
    this.rigVersions = this.rigVersions.map((candidate) =>
      candidate.rigId === rigId ? { ...candidate, active: false } : candidate,
    );
    this.rigVersions.push(version);
    if (rig) {
      rig.activeVersion = version;
      rig.versionCount += 1;
      rig.updatedAt = now;
    }
    change.status = "merged";
    change.resultVersionId = version.id;
    change.updatedAt = now;
    return version;
  }

  async verifyRig(
    _workspaceId: string,
    rigId: string,
  ): Promise<{ ok: boolean; versionId: string }> {
    const rig = await this.getRig(_workspaceId, rigId);
    return { ok: true, versionId: rig.activeVersion?.id ?? "" };
  }

  private registeredPacks: WorkspaceRegisteredPack[] = [];
  private packInstallations: PackInstallation[] = [];

  async listPacks(): Promise<ListPacksResponse> {
    return {
      packs: [DEVOPS_PACK, ...this.registeredPacks.map((registration) => registration.pack)],
      installations: [...this.packInstallations],
    };
  }

  async registerPack(
    _workspaceId: string,
    manifest: RegisterCapabilityPackRequest,
  ): Promise<WorkspaceRegisteredPack> {
    const now = new Date().toISOString();
    const registration: WorkspaceRegisteredPack = {
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      pack: fabricatePack(manifest),
      createdAt: now,
      updatedAt: now,
    };
    this.registeredPacks = [
      ...this.registeredPacks.filter((existing) => existing.pack.id !== manifest.id),
      registration,
    ];
    return registration;
  }

  async enablePack(
    _workspaceId: string,
    packId: string,
    request: EnablePackRequest = {},
  ): Promise<PackInstallation> {
    const now = new Date().toISOString();
    const installation: PackInstallation = {
      id: demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      packId,
      status: "active",
      version: 1,
      manifestSnapshot: null,
      manifestDigest: null,
      selectedRigId: null,
      installedBySubjectId: null,
      metadata: {
        ...request.metadata,
        ...(request.environmentId ? { environmentId: request.environmentId } : {}),
      },
      enabledAt: now,
      updatedAt: now,
    };
    this.packInstallations = [
      ...this.packInstallations.filter((existing) => existing.packId !== packId),
      installation,
    ];
    return installation;
  }

  async previewPackInstallation(
    _workspaceId: string,
    packId: string,
    request: PreviewPackInstallationRequest = {},
  ): Promise<PackInstallationPreview> {
    const pack = (await this.listPacks()).packs.find((candidate) => candidate.id === packId);
    if (!pack) throw new Error("pack not found");
    const installation = this.packInstallations.find((candidate) => candidate.packId === packId);
    return {
      packId,
      packVersion: pack.version,
      manifestDigest: "0".repeat(64),
      installationVersion: installation?.version ?? null,
      action: !installation || installation.status === "disabled" ? "install" : "update",
      ready: true,
      blockers: [],
      components: [],
      rig: {
        required: false,
        status: "not_required",
        requestedRigId: request.rigId ?? null,
        rigId: null,
        rigVersionId: null,
        name: null,
        image: null,
      },
      variableSetId: request.variableSetId ?? null,
      legacyInlineSkillCount: pack.skills.length,
      legacySandboxImage: pack.sandboxImage ?? null,
    };
  }

  async installPack(
    _workspaceId: string,
    packId: string,
    request: InstallPackRequest,
  ): Promise<PackInstallation> {
    const pack = (await this.listPacks()).packs.find((candidate) => candidate.id === packId);
    if (!pack) throw new Error("pack not found");
    const existing = this.packInstallations.find((candidate) => candidate.packId === packId);
    const now = new Date().toISOString();
    const installation: PackInstallation = {
      id: existing?.id ?? demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      packId,
      status: "active",
      version: (existing?.version ?? 0) + 1,
      manifestSnapshot: pack,
      manifestDigest: request.expectedManifestDigest,
      selectedRigId: request.rigId ?? null,
      installedBySubjectId: "demo:user",
      metadata: {
        ...request.metadata,
        ...(request.variableSetId ? { variableSetId: request.variableSetId } : {}),
      },
      enabledAt: now,
      updatedAt: now,
    };
    this.packInstallations = [
      ...this.packInstallations.filter((candidate) => candidate.packId !== packId),
      installation,
    ];
    return installation;
  }

  async previewPackUninstall(_workspaceId: string, packId: string): Promise<PackUninstallPreview> {
    const installation = this.packInstallations.find((candidate) => candidate.packId === packId);
    return {
      packId,
      installed: Boolean(installation && installation.status !== "disabled"),
      installationVersion: installation?.version ?? null,
      components: [],
    };
  }

  async uninstallPack(
    _workspaceId: string,
    packId: string,
    _request: UninstallPackRequest,
  ): Promise<UninstallPackResult> {
    const installation = this.packInstallations.find((candidate) => candidate.packId === packId);
    if (installation) {
      this.packInstallations = [
        ...this.packInstallations.filter((candidate) => candidate.packId !== packId),
        { ...installation, status: "disabled", version: installation.version + 1 },
      ];
    }
    return {
      packId,
      status: installation ? "uninstalled" : "not_installed",
      retainedComponents: [],
    };
  }

  async deletePack(_workspaceId: string, packId: string): Promise<void> {
    this.registeredPacks = this.registeredPacks.filter(
      (registration) => registration.pack.id !== packId,
    );
    this.packInstallations = this.packInstallations.filter(
      (installation) => installation.packId !== packId,
    );
  }

  private workspaces: Workspace[] = [fabricateWorkspace("Acme Platform")];

  async listWorkspaces(): Promise<Workspace[]> {
    return [...this.workspaces];
  }

  async getWorkspace(_workspaceId: string): Promise<Workspace> {
    const workspace = this.workspaces[0];
    if (!workspace) throw new Error("workspace not found");
    return { ...workspace };
  }

  async listWorkspaceControlEvents() {
    return [];
  }

  async listWorkspaceControlEventPage() {
    return { events: [], bytes: 2, truncated: false, nextAfter: null };
  }

  async *streamWorkspaceControlEvents(
    _workspaceId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<WorkspaceControlEvent, void, void> {
    yield* [] as WorkspaceControlEvent[];
    options.onStateChange?.("live");
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async *streamWorkspaceInteractionRevisions(
    _workspaceId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<WorkspaceInteractionRevisionEvent, void, void> {
    yield* [] as WorkspaceInteractionRevisionEvent[];
    options.onStateChange?.("live");
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace> {
    const workspace = fabricateWorkspace(request.name);
    this.workspaces.push(workspace);
    return { ...workspace };
  }

  async updateWorkspace(workspaceId: string, request: UpdateWorkspaceRequest): Promise<Workspace> {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new Error("workspace not found");
    }
    if (request.name !== undefined) {
      workspace.name = request.name;
    }
    return { ...workspace };
  }

  async getBillingUsage(): Promise<BillingUsageResponse> {
    return {
      balance: {
        accountId: ACCOUNT_ID,
        balanceMicros: 42_500_000,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      },
      usage: [],
    };
  }

  async uploadFile(workspaceId: string, input: UploadFileInput): Promise<FileAsset> {
    const sizeBytes =
      input.data instanceof Blob
        ? input.data.size
        : typeof input.data === "string"
          ? new TextEncoder().encode(input.data).byteLength
          : input.data instanceof Uint8Array
            ? input.data.byteLength
            : (input.data as ArrayBuffer).byteLength;
    return this.fileAsset(workspaceId, {
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes,
    });
  }

  async getFile(workspaceId: string, fileId: string): Promise<FileAsset> {
    return this.fileAsset(workspaceId, { id: fileId });
  }

  async createFileDownloadUrl(
    _workspaceId: string,
    fileId: string,
  ): Promise<FileDownloadUrlResponse> {
    return {
      url: `https://example.invalid/files/${fileId}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  async getStreamCapabilities(
    _workspaceId: string,
    sessionId: string,
  ): Promise<SessionCapabilities> {
    // A full-surface advertisement so the headless harness lights up all three
    // dock tabs: a lazy FileSystem, a Git repo, an interactive PTY, and a
    // warm desktop stream (vnc-ws) in interactive mode.
    return {
      sessionId,
      backend: "modal",
      os: "linux",
      liveness: "warm",
      leaseEpoch: 1,
      workspaceGeneration: null,
      archiveGeneration: null,
      archiveComplete: false,
      viewerHeartbeatIntervalMs: 30_000,
      FileSystem: {
        available: true,
        readOnly: false,
        root: "/workspace",
        pathSep: "/",
        treeMode: "lazy",
        reason: null,
      },
      Terminal: {
        transport: "pty-ws",
        ptyCapable: true,
        shell: "/bin/bash",
        url: null,
        token: null,
        expiresAt: null,
        reason: null,
      },
      Git: { available: true, repos: ["."], reason: null },
      DesktopStream: {
        transport: "vnc-ws",
        client: "novnc",
        mode: "interactive",
        url: "wss://desktop.invalid/vnc",
        token: null,
        expiresAt: null,
        resolution: [1024, 768],
        unredacted: true,
        requiresAcknowledgment: false,
        acknowledged: true,
        shared: false,
        sharedSessionIds: [],
        reason: null,
      },
      Recording: { available: false, modes: [], codecs: [], reason: "tier_headless" },
      ComputerUse: { available: false, readOnly: true, reason: "tier_headless" },
      negotiatedAt: new Date().toISOString(),
    };
  }

  async acknowledgeStream(): Promise<AcknowledgeStreamResponse> {
    return { acknowledged: true, acknowledgedShared: true };
  }

  async attachViewer(): Promise<AttachViewerResponse> {
    return {
      viewerId: "00000000-0000-4000-8000-000000000001",
      sandboxGroupId: "00000000-0000-4000-8000-0000000000aa",
      liveness: "cold",
      leaseEpoch: 0,
      workspaceGeneration: null,
      archiveGeneration: null,
      archiveComplete: false,
      viewerHeartbeatIntervalMs: 30_000,
      dataPlaneUrl: null,
      streamToken: null,
      streamExpiresAt: null,
      resolution: null,
      transport: null,
      client: null,
      terminalUrl: null,
      terminalToken: null,
      terminalExpiresAt: null,
      terminalTransport: null,
    };
  }

  async heartbeatViewer(): Promise<ViewerHeartbeatResponse> {
    return { alive: true };
  }

  async detachViewer(): Promise<void> {
    // no-op in the demo
  }

  async listNetworkRoutes(
    _workspaceId: string,
    options: NetworkRouteListOptions = {},
  ): Promise<NetworkRouteListResponse> {
    return {
      revision: this.networkRouteRevision,
      routes: [...this.networkRoutes.values()].filter(
        (route) => options.includeArchived || route.status === "active",
      ),
    };
  }

  async getNetworkRoute(_workspaceId: string, routeId: string): Promise<NetworkRoute> {
    const route = this.networkRoutes.get(routeId);
    if (!route) throw new Error("NetworkRoute not found");
    return route;
  }

  async createNetworkRoute(
    _workspaceId: string,
    request: CreateNetworkRouteRequest,
  ): Promise<NetworkRouteMutationResponse> {
    const now = new Date().toISOString();
    const route: NetworkRoute = {
      id: demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      name: request.name,
      status: "active",
      configuration: request.configuration,
      consistency: request.consistency,
      version: 1,
      createdBySubjectId: "user:demo",
      createdAt: now,
      updatedAt: now,
    };
    this.networkRoutes.set(route.id, route);
    this.networkRouteRevision += 1;
    return { route, operationId: request.operationId, replayed: false };
  }

  async updateNetworkRoute(
    _workspaceId: string,
    routeId: string,
    request: UpdateNetworkRouteRequest,
  ): Promise<NetworkRouteMutationResponse> {
    const current = await this.getNetworkRoute(WORKSPACE_ID, routeId);
    if (current.version !== request.expectedVersion) throw new Error("NetworkRoute changed");
    const route: NetworkRoute = {
      ...current,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(request.configuration !== undefined ? { configuration: request.configuration } : {}),
      ...(request.consistency !== undefined ? { consistency: request.consistency } : {}),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.networkRoutes.set(route.id, route);
    this.networkRouteRevision += 1;
    return { route, operationId: request.operationId, replayed: false };
  }

  async listSiteAuthConnections(
    _workspaceId: string,
    options: SiteAuthConnectionListOptions = {},
  ): Promise<SiteAuthConnectionListResponse> {
    return {
      revision: this.siteAuthRevision,
      connections: [...this.siteAuthConnections.values()].filter(
        (connection) => options.includeArchived || connection.status === "active",
      ),
    };
  }

  async getSiteAuthConnection(
    _workspaceId: string,
    connectionId: string,
  ): Promise<SiteAuthConnection> {
    const connection = this.siteAuthConnections.get(connectionId);
    if (!connection) throw new Error("SiteAuthConnection not found");
    return connection;
  }

  async createSiteAuthConnection(
    _workspaceId: string,
    request: CreateSiteAuthConnectionRequest,
  ): Promise<SiteAuthConnectionMutationResponse> {
    const now = new Date().toISOString();
    const { operationId, ...configuration } = request;
    const connection: SiteAuthConnection = {
      ...configuration,
      id: demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      status: "active",
      verificationState: "unknown",
      lastVerifiedAt: null,
      lastVerifiedUrl: null,
      repairCode: null,
      version: 1,
      createdBySubjectId: "user:demo",
      createdAt: now,
      updatedAt: now,
    };
    this.siteAuthConnections.set(connection.id, connection);
    this.siteAuthRevision += 1;
    return { connection, operationId, replayed: false };
  }

  async updateSiteAuthConnection(
    _workspaceId: string,
    connectionId: string,
    request: UpdateSiteAuthConnectionRequest,
  ): Promise<SiteAuthConnectionMutationResponse> {
    const current = await this.getSiteAuthConnection(WORKSPACE_ID, connectionId);
    if (current.version !== request.expectedVersion) throw new Error("SiteAuthConnection changed");
    const { operationId, expectedVersion: _expectedVersion, ...requestedChanges } = request;
    const changes = Object.fromEntries(
      Object.entries(requestedChanges).filter(([, value]) => value !== undefined),
    ) as Partial<SiteAuthConnection>;
    const connection: SiteAuthConnection = {
      ...current,
      ...changes,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.siteAuthConnections.set(connection.id, connection);
    this.siteAuthRevision += 1;
    return { connection, operationId, replayed: false };
  }

  async listAuthRuns(
    _workspaceId: string,
    options: AuthRunListOptions = {},
  ): Promise<AuthRunListResponse> {
    return {
      runs: [...this.authRuns.values()].filter(
        (run) =>
          (!options.browserSessionId || run.browserSessionId === options.browserSessionId) &&
          (!options.siteAuthConnectionId ||
            run.siteAuthConnectionId === options.siteAuthConnectionId) &&
          (options.includeSettled || !authRunSettled(run)),
      ),
    };
  }

  async getAuthRun(_workspaceId: string, authRunId: string): Promise<AuthRun> {
    const run = this.authRuns.get(authRunId);
    if (!run) throw new Error("AuthRun not found");
    return run;
  }

  async startBrowserAuthRun(
    _workspaceId: string,
    browserSessionId: string,
    request: StartAuthRunRequest,
  ): Promise<AuthRunMutationResponse> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const now = new Date().toISOString();
    const run: AuthRun = {
      id: demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      siteAuthConnectionId: request.siteAuthConnectionId,
      browserSessionId,
      targetId: request.targetId,
      controllerGeneration: requireDemoBrowserController(session).controllerGeneration,
      targetGeneration: request.expectedTargetGeneration,
      documentGeneration: request.expectedDocumentGeneration,
      methodId: request.methodId ?? null,
      authorityId: request.authorityId ?? null,
      state: "discovering",
      choices: [],
      pendingFields: [],
      externalAction: null,
      interventionId: null,
      verifiedUrl: null,
      failureCode: null,
      version: 1,
      operationId: request.operationId,
      createdBySubjectId: "agent:demo",
      createdAt: now,
      updatedAt: now,
      settledAt: null,
    };
    this.authRuns.set(run.id, run);
    return { run, operationId: request.operationId, replayed: false };
  }

  async reportBrowserAuthRun(
    _workspaceId: string,
    browserSessionId: string,
    authRunId: string,
    request: ReportAuthRunRequest,
  ): Promise<AuthRunMutationResponse> {
    const current = await this.getAuthRun(WORKSPACE_ID, authRunId);
    if (
      current.browserSessionId !== browserSessionId ||
      current.version !== request.expectedVersion
    ) {
      throw new Error("AuthRun changed");
    }
    const now = new Date().toISOString();
    const run: AuthRun = {
      ...current,
      methodId: request.methodId ?? current.methodId,
      authorityId: request.authorityId ?? current.authorityId,
      state: request.state,
      choices: request.choices ?? [],
      pendingFields: request.pendingFields ?? [],
      externalAction: request.externalAction ?? null,
      failureCode: request.failureCode ?? null,
      version: current.version + 1,
      updatedAt: now,
      settledAt: request.state === "failed" || request.state === "cancelled" ? now : null,
    };
    this.authRuns.set(run.id, run);
    return { run, operationId: request.operationId, replayed: false };
  }

  async protectedBrowserAuthFill(
    _workspaceId: string,
    browserSessionId: string,
    authRunId: string,
    request: ProtectedAuthFillRequest,
  ): Promise<ProtectedAuthFillResponse> {
    const current = await this.getAuthRun(WORKSPACE_ID, authRunId);
    if (
      current.browserSessionId !== browserSessionId ||
      current.version !== request.expectedVersion
    ) {
      throw new Error("AuthRun changed");
    }
    const run: AuthRun = {
      ...current,
      authorityId: request.authorityId,
      state: "working",
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.authRuns.set(run.id, run);
    return { run, status: "working", operationId: request.operationId, replayed: false };
  }

  async verifyBrowserAuthRun(
    _workspaceId: string,
    browserSessionId: string,
    authRunId: string,
    request: VerifyAuthRunRequest,
  ): Promise<AuthRunMutationResponse> {
    const current = await this.getAuthRun(WORKSPACE_ID, authRunId);
    if (
      current.browserSessionId !== browserSessionId ||
      current.version !== request.expectedVersion
    ) {
      throw new Error("AuthRun changed");
    }
    const target = (this.browserTargets.get(browserSessionId) ?? []).find(
      (candidate) => candidate.id === current.targetId,
    );
    const now = new Date().toISOString();
    const run: AuthRun = {
      ...current,
      state: "verified",
      verifiedUrl: target?.url ?? null,
      version: current.version + 1,
      updatedAt: now,
      settledAt: now,
    };
    this.authRuns.set(run.id, run);
    return { run, operationId: request.operationId, replayed: false };
  }

  async listInteractionInterventions(
    _workspaceId: string,
    options: InteractionInterventionListOptions = {},
  ): Promise<InteractionInterventionListResponse> {
    return {
      interventions: [...this.interventions.values()].filter(
        (intervention) =>
          (!options.resourceKind || intervention.resourceKind === options.resourceKind) &&
          (!options.resourceId || intervention.resourceId === options.resourceId) &&
          (options.includeSettled || intervention.status === "open"),
      ),
    };
  }

  async getInteractionIntervention(
    _workspaceId: string,
    interventionId: string,
  ): Promise<InteractionIntervention> {
    const intervention = this.interventions.get(interventionId);
    if (!intervention) throw new Error("InteractionIntervention not found");
    return intervention;
  }

  async createInteractionIntervention(
    _workspaceId: string,
    request: CreateInteractionInterventionRequest,
  ): Promise<InteractionInterventionMutationResponse> {
    const now = new Date().toISOString();
    const intervention: InteractionIntervention = {
      id: demoUuid(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      resourceKind: request.resourceKind,
      resourceId: request.resourceId,
      targetId: request.targetId,
      controllerGeneration: request.expectedControllerGeneration,
      targetGeneration: request.expectedTargetGeneration,
      documentGeneration: request.expectedDocumentGeneration,
      kind: request.kind,
      reason: request.reason,
      status: "open",
      authRunId: request.authRunId ?? null,
      originatingSessionId: MANAGER_SESSION_ID,
      originatingTurnId: null,
      originatingAttemptId: null,
      originatingToolOperationId: null,
      responseActorSubjectId: null,
      version: 1,
      operationId: request.operationId,
      expiresAt: new Date(Date.now() + (request.expiresInSeconds ?? 900) * 1_000).toISOString(),
      createdAt: now,
      updatedAt: now,
      settledAt: null,
    };
    this.interventions.set(intervention.id, intervention);
    return { intervention, operationId: request.operationId, replayed: false };
  }

  async resolveInteractionIntervention(
    _workspaceId: string,
    interventionId: string,
    request: ResolveInteractionInterventionRequest,
  ): Promise<InteractionInterventionMutationResponse> {
    const current = await this.getInteractionIntervention(WORKSPACE_ID, interventionId);
    if (current.version !== request.expectedVersion) throw new Error("Intervention changed");
    const now = new Date().toISOString();
    const intervention: InteractionIntervention = {
      ...current,
      status: request.outcome,
      responseActorSubjectId: "user:demo",
      version: current.version + 1,
      updatedAt: now,
      settledAt: now,
    };
    this.interventions.set(intervention.id, intervention);
    return { intervention, operationId: request.operationId, replayed: false };
  }

  async listAttachedBrowsers(
    _workspaceId: string,
    _options: AttachedBrowserDeviceListOptions = {},
  ): Promise<AttachedBrowserDeviceListResponse> {
    return { revision: this.browserRevision, devices: [] };
  }

  async getAttachedBrowser(
    _workspaceId: string,
    _deviceId: string,
  ): Promise<AttachedBrowserDevice> {
    throw new Error("Attached browser not found");
  }

  async listBrowserIdentities(
    _workspaceId: string,
    options: BrowserIdentityListOptions = {},
  ): Promise<BrowserIdentityListResponse> {
    const identities = [...this.browserIdentities.values()].filter(
      (identity) => options.includeArchived || identity.status === "active",
    );
    return { revision: this.browserRevision, identities };
  }

  async getBrowserIdentity(_workspaceId: string, identityId: string): Promise<BrowserIdentity> {
    const identity = this.browserIdentities.get(identityId);
    if (!identity) throw new Error("BrowserIdentity not found");
    return identity;
  }

  async createBrowserIdentity(
    _workspaceId: string,
    request: CreateBrowserIdentityRequest,
  ): Promise<BrowserIdentityMutationResponse> {
    const identity = fabricateBrowserIdentity({ id: demoUuid(), name: request.name });
    this.browserIdentities.set(identity.id, identity);
    this.browserIdentityRevisions.set(identity.id, []);
    this.browserRevision += 1;
    return { identity, operationId: request.operationId, replayed: false };
  }

  async listBrowserRevisions(
    _workspaceId: string,
    identityId: string,
  ): Promise<BrowserRevisionListResponse> {
    return {
      identity: await this.getBrowserIdentity(WORKSPACE_ID, identityId),
      revisions: [...(this.browserIdentityRevisions.get(identityId) ?? [])],
    };
  }

  async listBrowserSessions(): Promise<BrowserSessionListResponse> {
    return { revision: this.browserRevision, sessions: [...this.browserSessions.values()] };
  }

  /** Frame metadata source for the deterministic demo transport. Not part of
   *  SessionClientLike; production frames come from browserd. */
  demoBrowserFrameTarget(browserSessionId: string, targetId: string): BrowserTarget | null {
    const target = (this.browserTargets.get(browserSessionId) ?? []).find(
      (candidate) => candidate.id === targetId,
    );
    return target ? { ...target } : null;
  }

  async getBrowserSession(_workspaceId: string, browserSessionId: string): Promise<BrowserSession> {
    const session = this.browserSessions.get(browserSessionId);
    if (!session) throw new Error("BrowserSession not found");
    return session;
  }

  async createBrowserSession(
    _workspaceId: string,
    request: CreateBrowserSessionRequest,
  ): Promise<BrowserSessionMutationResponse> {
    const id = demoUuid();
    const identity = request.identityId
      ? await this.getBrowserIdentity(WORKSPACE_ID, request.identityId)
      : null;
    const session = fabricateBrowserSession(request.sessionId, {
      id,
      name: request.name ?? "New browser",
      headless: request.headless ?? true,
      identityId: identity?.id ?? null,
      baseRevisionId: request.baseRevisionId ?? identity?.defaultRevisionId ?? null,
      networkRouteId: request.networkRouteId ?? null,
      linkedComputerSessionId: request.linkedComputerSessionId ?? null,
    });
    const target = fabricateBrowserTarget(id, {
      id: demoUuid(),
      url: request.initialUrl ?? "about:blank",
      title: request.initialUrl ? "New page" : "New tab",
    });
    this.browserSessions.set(id, session);
    this.browserTargets.set(id, [target]);
    this.browserRevision += 1;
    return {
      session,
      operation: browserLifecycleReceipt(request.operationId, id, "create"),
    };
  }

  async listBrowserTargets(
    _workspaceId: string,
    browserSessionId: string,
  ): Promise<BrowserTargetListResponse> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    return {
      browserSessionId,
      controllerGeneration: session.controller?.controllerGeneration ?? "demo-controller-1",
      targets: [...(this.browserTargets.get(browserSessionId) ?? [])],
    };
  }

  async openBrowserTarget(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserOpenTargetRequest = {},
  ): Promise<BrowserTarget> {
    const targets = (this.browserTargets.get(browserSessionId) ?? []).map((target) => ({
      ...target,
      selected: false,
    }));
    const target = fabricateBrowserTarget(browserSessionId, {
      id: demoUuid(),
      url: request.url ?? "about:blank",
      title: request.url ? "New page" : "New tab",
    });
    targets.push(target);
    this.browserTargets.set(browserSessionId, targets);
    return target;
  }

  async selectBrowserTarget(
    _workspaceId: string,
    browserSessionId: string,
    targetId: string,
  ): Promise<BrowserTarget> {
    let selected: BrowserTarget | null = null;
    const targets = (this.browserTargets.get(browserSessionId) ?? []).map((target) => {
      const next = { ...target, selected: target.id === targetId };
      if (next.selected) selected = next;
      return next;
    });
    if (!selected) throw new Error("Browser target not found");
    this.browserTargets.set(browserSessionId, targets);
    return selected;
  }

  async closeBrowserTarget(
    _workspaceId: string,
    browserSessionId: string,
    targetId: string,
  ): Promise<BrowserTargetListResponse> {
    const remaining = (this.browserTargets.get(browserSessionId) ?? []).filter(
      (target) => target.id !== targetId,
    );
    if (remaining.length > 0 && !remaining.some((target) => target.selected)) {
      remaining[0] = { ...remaining[0]!, selected: true };
    }
    this.browserTargets.set(browserSessionId, remaining);
    return await this.listBrowserTargets(WORKSPACE_ID, browserSessionId);
  }

  async observeBrowserTarget(
    _workspaceId: string,
    browserSessionId: string,
    targetId: string,
  ): Promise<BrowserObservation> {
    const target = (this.browserTargets.get(browserSessionId) ?? []).find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error("Browser target not found");
    return fabricateBrowserObservation(target);
  }

  async actInBrowser(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserActionRequest,
  ): Promise<BrowserActionReceipt> {
    const targets = this.browserTargets.get(browserSessionId) ?? [];
    const current = targets.find((target) => target.id === request.targetId);
    if (!current) throw new Error("Browser target not found");
    const actions = request.action.type === "batch" ? request.action.actions : [request.action];
    let target = current;
    for (const action of actions) {
      if (action.type === "navigate") {
        target = {
          ...target,
          title: new URL(action.url).hostname || "New page",
          url: action.url,
          documentGeneration: `demo-document-${this.browserRevision + 1}`,
        };
      }
    }
    this.browserTargets.set(
      browserSessionId,
      targets.map((candidate) => (candidate.id === target.id ? target : candidate)),
    );
    const now = new Date().toISOString();
    return {
      protocolVersion: 1,
      operationId: request.operationId,
      browserSessionId,
      controllerGeneration: target.controllerGeneration,
      targetId: target.id,
      state: "completed",
      dispatchedAt: now,
      settledAt: now,
      observation: fabricateBrowserObservation(target),
      error: null,
    };
  }

  async getBrowserActionReceipt(): Promise<BrowserActionReceipt> {
    throw new Error("The scripted browser has no unsettled operations.");
  }

  async listBrowserDiagnostics(
    _workspaceId: string,
    browserSessionId: string,
    targetId: string,
    _options: BrowserDiagnosticsOptions = {},
  ): Promise<BrowserDiagnosticBatch> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const controller = requireDemoBrowserController(session);
    const target = (this.browserTargets.get(browserSessionId) ?? []).find(
      (candidate) => candidate.id === targetId,
    );
    return {
      browserSessionId,
      controllerGeneration: controller.controllerGeneration,
      targetId,
      targetGeneration: target?.targetGeneration ?? "demo-target-1",
      entries: [],
      cursor: 0,
      truncated: false,
    };
  }

  async attachBrowserSession(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionAttachmentRequest,
  ): Promise<BrowserSessionAttachment> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const controller = requireDemoBrowserController(session);
    return {
      browserSessionId,
      controllerGeneration: controller.controllerGeneration,
      targetId: request.targetId,
      stream: {
        kind: "direct_websocket",
        url: `wss://browser.invalid/${browserSessionId}/${request.targetId}`,
        protocols: ["opengeni.browser.v1", "opengeni.auth.demo-only"],
      },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  }

  async heartbeatBrowserSession(
    _workspaceId: string,
    browserSessionId: string,
  ): Promise<BrowserSessionHeartbeatResponse> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const controller = requireDemoBrowserController(session);
    return {
      browserSessionId,
      controllerGeneration: controller.controllerGeneration,
      alive: true,
    };
  }

  async publishBrowserRevision(
    _workspaceId: string,
    browserSessionId: string,
    request: PublishBrowserRevisionRequest,
  ): Promise<PublishBrowserRevisionResponse> {
    const session = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const identity = await this.getBrowserIdentity(WORKSPACE_ID, request.identityId);
    if (identity.headGeneration !== request.expectedHeadGeneration) {
      throw new Error("BrowserIdentity head changed");
    }
    const prior = this.browserIdentityRevisions.get(identity.id) ?? [];
    const revision = fabricateBrowserRevision(session, identity, prior.at(-1) ?? null);
    const advanceDefault = request.advanceDefault ?? true;
    const updated: BrowserIdentity = {
      ...identity,
      defaultRevisionId: advanceDefault ? revision.id : identity.defaultRevisionId,
      headGeneration: identity.headGeneration + (advanceDefault ? 1 : 0),
      revisionCount: identity.revisionCount + 1,
      updatedAt: new Date().toISOString(),
    };
    this.browserIdentityRevisions.set(identity.id, [...prior, revision]);
    this.browserIdentities.set(identity.id, updated);
    this.browserSessions.set(browserSessionId, {
      ...session,
      identityId: identity.id,
      baseRevisionId: revision.id,
      lastUsedAt: new Date().toISOString(),
    });
    this.browserRevision += 1;
    return {
      identity: updated,
      revision,
      outcome: advanceDefault ? "saved_as_default" : "saved_not_default",
      replayed: false,
    };
  }

  async suspendBrowserSession(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
  ): Promise<BrowserSessionMutationResponse> {
    const current = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const session: BrowserSession = {
      ...current,
      lifecycle: "suspended",
      controller: null,
      lastUsedAt: new Date().toISOString(),
      failureCode: null,
    };
    this.browserSessions.set(browserSessionId, session);
    this.browserRevision += 1;
    return {
      session,
      operation: browserLifecycleReceipt(request.operationId, browserSessionId, "suspend"),
    };
  }

  async resumeBrowserSession(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
  ): Promise<BrowserSessionMutationResponse> {
    const current = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const controllerGeneration = `demo-controller-${demoUuid()}`;
    const session: BrowserSession = {
      ...current,
      lifecycle: "active",
      controller: {
        controllerId: "opengeni-browserd",
        controllerGeneration,
        placementInstanceId: "demo-placement-1",
      },
      lastUsedAt: new Date().toISOString(),
      failureCode: null,
    };
    this.browserSessions.set(browserSessionId, session);
    this.browserTargets.set(
      browserSessionId,
      (this.browserTargets.get(browserSessionId) ?? []).map((target) => ({
        ...target,
        controllerGeneration,
      })),
    );
    this.browserRevision += 1;
    return {
      session,
      operation: browserLifecycleReceipt(request.operationId, browserSessionId, "resume"),
    };
  }

  async endBrowserSession(
    _workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
  ): Promise<BrowserSessionMutationResponse> {
    const current = await this.getBrowserSession(WORKSPACE_ID, browserSessionId);
    const session = {
      ...current,
      lifecycle: "ended" as const,
      lastUsedAt: new Date().toISOString(),
    };
    this.browserSessions.set(browserSessionId, session);
    this.browserRevision += 1;
    return {
      session,
      operation: browserLifecycleReceipt(request.operationId, browserSessionId, "end"),
    };
  }

  async listComputerSessions(): Promise<ComputerSessionListResponse> {
    return { revision: this.computerRevision, sessions: [...this.computerSessions.values()] };
  }

  /** Frame metadata source for the deterministic Computer demo transport. */
  demoComputerFrameTarget(computerSessionId: string, targetId: string): ComputerTarget | null {
    const target = (this.computerTargets.get(computerSessionId) ?? []).find(
      (candidate) => candidate.id === targetId,
    );
    return target ? { ...target } : null;
  }

  async getComputerSession(
    _workspaceId: string,
    computerSessionId: string,
  ): Promise<ComputerSession> {
    const session = this.computerSessions.get(computerSessionId);
    if (!session) throw new Error("ComputerSession not found");
    return session;
  }

  async createComputerSession(
    _workspaceId: string,
    request: CreateComputerSessionRequest,
  ): Promise<ComputerSessionMutationResponse> {
    const id = demoUuid();
    const session = fabricateComputerSession(request.sessionId, {
      id,
      name: request.name ?? "Computer",
      ...(request.placement ? { placement: request.placement } : {}),
    });
    const window = fabricateComputerTarget(id, { id: demoUuid() });
    const screen = fabricateComputerTarget(id, {
      id: demoUuid(),
      targetGeneration: `demo-screen-${demoUuid()}`,
      kind: "screen",
      applicationId: null,
      processId: null,
      title: "Agent desktop",
      bounds: { x: 0, y: 0, width: 1_280, height: 720 },
      focused: false,
    });
    this.computerSessions.set(id, session);
    this.computerTargets.set(id, [window, screen]);
    this.computerRevision += 1;
    return {
      session,
      operation: computerLifecycleReceipt(request.operationId, id, "create"),
    };
  }

  async listComputerTargets(
    _workspaceId: string,
    computerSessionId: string,
  ): Promise<ComputerTargetListResponse> {
    const session = await this.getComputerSession(WORKSPACE_ID, computerSessionId);
    const controller = requireDemoComputerController(session);
    return {
      computerSessionId,
      controllerGeneration: controller.controllerGeneration,
      targets: [...(this.computerTargets.get(computerSessionId) ?? [])],
    };
  }

  async observeComputerTarget(
    _workspaceId: string,
    computerSessionId: string,
    targetId: string,
  ): Promise<ComputerObservation> {
    const target = (this.computerTargets.get(computerSessionId) ?? []).find(
      (candidate) => candidate.id === targetId,
    );
    if (!target) throw new Error("Computer target not found");
    return fabricateComputerObservation(target);
  }

  async actInComputer(
    _workspaceId: string,
    computerSessionId: string,
    request: ComputerActionRequest,
  ): Promise<ComputerActionReceipt> {
    let targets = this.computerTargets.get(computerSessionId) ?? [];
    let target = targets.find((candidate) => candidate.id === request.targetId) ?? null;
    if (!target) throw new Error("Computer target not found");
    if (request.action.type === "focus") {
      const focusId = request.action.targetId;
      targets = targets.map((candidate) => ({ ...candidate, focused: candidate.id === focusId }));
      target = targets.find((candidate) => candidate.id === focusId) ?? target;
    } else if (request.action.type === "launch") {
      target = fabricateComputerTarget(computerSessionId, {
        id: demoUuid(),
        targetGeneration: `demo-window-${demoUuid()}`,
        applicationId: request.action.applicationId,
        title: request.action.applicationId,
      });
      targets = [...targets.map((candidate) => ({ ...candidate, focused: false })), target];
    }
    this.computerTargets.set(computerSessionId, targets);
    const now = new Date().toISOString();
    return {
      protocolVersion: 1,
      operationId: request.operationId,
      computerSessionId,
      controllerGeneration: target.controllerGeneration,
      targetId: target.id,
      state: "completed",
      dispatchedAt: now,
      settledAt: now,
      observation: fabricateComputerObservation(target),
      error: null,
    };
  }

  async getComputerActionReceipt(): Promise<ComputerActionReceipt> {
    throw new Error("The scripted computer has no unsettled operations.");
  }

  async attachComputerSession(
    _workspaceId: string,
    computerSessionId: string,
    request: ComputerSessionAttachmentRequest,
  ): Promise<ComputerSessionAttachment> {
    const session = await this.getComputerSession(WORKSPACE_ID, computerSessionId);
    const controller = requireDemoComputerController(session);
    return {
      computerSessionId,
      controllerGeneration: controller.controllerGeneration,
      targetId: request.targetId,
      stream: {
        kind: "direct_websocket",
        url: `wss://computer.invalid/${computerSessionId}/${request.targetId}`,
        protocols: ["opengeni.computer.v1", "opengeni.auth.demo-only"],
      },
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
  }

  async heartbeatComputerSession(
    _workspaceId: string,
    computerSessionId: string,
  ): Promise<ComputerSessionHeartbeatResponse> {
    const session = await this.getComputerSession(WORKSPACE_ID, computerSessionId);
    const controller = requireDemoComputerController(session);
    return {
      computerSessionId,
      controllerGeneration: controller.controllerGeneration,
      alive: true,
    };
  }

  async endComputerSession(
    _workspaceId: string,
    computerSessionId: string,
    request: ComputerSessionLifecycleRequest,
  ): Promise<ComputerSessionMutationResponse> {
    const current = await this.getComputerSession(WORKSPACE_ID, computerSessionId);
    const session: ComputerSession = {
      ...current,
      lifecycle: "ended",
      lastUsedAt: new Date().toISOString(),
    };
    this.computerSessions.set(computerSessionId, session);
    this.computerRevision += 1;
    return {
      session,
      operation: computerLifecycleReceipt(request.operationId, computerSessionId, "end"),
    };
  }

  async fsList(
    _workspaceId: string,
    _sessionId: string,
    request?: { path?: string },
  ): Promise<FsListResponse> {
    const dir = (name: string, path: string, children?: FsTreeNode[]): FsTreeNode => ({
      name,
      path,
      type: "dir",
      sizeBytes: null,
      mtimeMs: null,
      mode: null,
      truncated: false,
      ...(children ? { children } : {}),
    });
    const file = (name: string, path: string, sizeBytes = 512): FsTreeNode => ({
      name,
      path,
      type: "file",
      sizeBytes,
      mtimeMs: Date.now(),
      mode: 0o644,
      truncated: false,
    });
    const path = request?.path ?? "";
    // Root level (depth 1) — dirs come back without children (lazy expand).
    if (path === "") {
      return {
        root: dir("", "", [
          dir("src", "src"),
          dir("infra", "infra"),
          file("package.json", "package.json", 842),
          file("README.md", "README.md", 1280),
        ]),
        revision: 1,
        truncated: false,
      };
    }
    if (path === "src") {
      return {
        root: dir("src", "src", [
          file("index.ts", "src/index.ts", 2048),
          file("server.ts", "src/server.ts", 3120),
          file("config.ts", "src/config.ts", 640),
        ]),
        revision: 1,
        truncated: false,
      };
    }
    if (path === "infra") {
      return {
        root: dir("infra", "infra", [
          file("main.tf", "infra/main.tf", 1860),
          file("variables.tf", "infra/variables.tf", 420),
        ]),
        revision: 1,
        truncated: false,
      };
    }
    return { root: dir(path, path, []), revision: 1, truncated: false };
  }

  async fsListBatch(
    workspaceId: string,
    sessionId: string,
    request: { requests: Array<{ path?: string }> },
  ): Promise<FsListBatchResponse> {
    return {
      results: await Promise.all(
        request.requests.map(async (item) => await this.fsList(workspaceId, sessionId, item)),
      ),
    };
  }

  async fsRead(
    _workspaceId: string,
    _sessionId: string,
    request: { path: string },
  ): Promise<FsReadResponse> {
    const content = `// ${request.path}\nexport const ok = true;\n`;
    return {
      path: request.path,
      encoding: "utf8",
      content,
      sizeBytes: content.length,
      truncated: false,
      isBinary: false,
      revision: 1,
    };
  }

  async fsWrite(
    _workspaceId: string,
    _sessionId: string,
    request: { path: string; content: string },
  ): Promise<FsWriteResponse> {
    return { path: request.path, sizeBytes: request.content.length, revision: 1 };
  }

  async fsDelete(
    _workspaceId: string,
    _sessionId: string,
    _request: { path: string },
  ): Promise<FsDeleteResponse> {
    return { revision: 1 };
  }

  async fsMove(
    _workspaceId: string,
    _sessionId: string,
    request: { path: string; newPath: string },
  ): Promise<FsMoveResponse> {
    return { path: request.path, newPath: request.newPath, revision: 1 };
  }

  async fsMkdir(
    _workspaceId: string,
    _sessionId: string,
    request: { path: string },
  ): Promise<FsMkdirResponse> {
    return { path: request.path, revision: 1 };
  }

  async gitStatus(): Promise<GitStatusResponse> {
    return {
      isRepo: true,
      head: "feat/sandbox-dock",
      detached: false,
      upstream: "origin/feat/sandbox-dock",
      ahead: 2,
      behind: 1,
      files: [
        {
          path: "src/server.ts",
          oldPath: null,
          index: null,
          worktree: "modified",
          isConflicted: false,
        },
        {
          path: "infra/main.tf",
          oldPath: null,
          index: null,
          worktree: "modified",
          isConflicted: false,
        },
        {
          path: "src/config.ts",
          oldPath: null,
          index: null,
          worktree: "added",
          isConflicted: false,
        },
      ],
      revision: 1,
    };
  }

  async gitDiff(
    _workspaceId: string,
    _sessionId: string,
    request?: { staged?: boolean },
  ): Promise<GitDiffResponse> {
    if (request?.staged) {
      return { files: [], revision: 1 };
    }
    return {
      files: [
        {
          path: "src/server.ts",
          oldPath: null,
          status: "modified",
          isBinary: false,
          isImage: false,
          additions: 3,
          deletions: 1,
          truncated: false,
          hunks: [
            {
              oldStart: 12,
              oldLines: 4,
              newStart: 12,
              newLines: 6,
              header: "@@ -12,4 +12,6 @@ export function createServer() {",
              lines: [
                { type: "context", oldNo: 12, newNo: 12, text: "  const app = express();" },
                { type: "del", oldNo: 13, newNo: null, text: "  app.use(cors());" },
                {
                  type: "add",
                  oldNo: null,
                  newNo: 13,
                  text: "  app.use(cors({ origin: ALLOWED_ORIGINS }));",
                },
                { type: "add", oldNo: null, newNo: 14, text: "  app.use(helmet());" },
                { type: "add", oldNo: null, newNo: 15, text: "  app.use(rateLimit());" },
                { type: "context", oldNo: 14, newNo: 16, text: "  return app;" },
              ],
            },
          ],
        },
        {
          path: "infra/main.tf",
          oldPath: null,
          status: "modified",
          isBinary: false,
          isImage: false,
          additions: 2,
          deletions: 0,
          truncated: false,
          hunks: [
            {
              oldStart: 4,
              oldLines: 2,
              newStart: 4,
              newLines: 4,
              header: '@@ -4,2 +4,4 @@ resource "aws_instance" "api" {',
              lines: [
                { type: "context", oldNo: 4, newNo: 4, text: '  instance_type = "t3.small"' },
                { type: "add", oldNo: null, newNo: 5, text: "  monitoring    = true" },
                { type: "add", oldNo: null, newNo: 6, text: "  ebs_optimized = true" },
                { type: "context", oldNo: 5, newNo: 7, text: "  tags = local.tags" },
              ],
            },
          ],
        },
        {
          path: "src/config.ts",
          oldPath: null,
          status: "added",
          isBinary: false,
          isImage: false,
          additions: 3,
          deletions: 0,
          truncated: false,
          hunks: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 3,
              header: "@@ -0,0 +1,3 @@",
              lines: [
                { type: "add", oldNo: null, newNo: 1, text: "export const ALLOWED_ORIGINS = [" },
                { type: "add", oldNo: null, newNo: 2, text: '  "https://app.acme.dev",' },
                { type: "add", oldNo: null, newNo: 3, text: "];" },
              ],
            },
          ],
        },
      ],
      revision: 1,
    };
  }

  async gitReadBatch(
    workspaceId: string,
    sessionId: string,
    request: {
      requests: Array<{
        status: { path?: string };
        diff?: { staged?: boolean };
      }>;
    },
  ): Promise<GitReadBatchResponse> {
    return {
      results: await Promise.all(
        request.requests.map(async (item) => ({
          status: await this.gitStatus(),
          ...(item.diff ? { diff: await this.gitDiff(workspaceId, sessionId, item.diff) } : {}),
        })),
      ),
    };
  }

  // The demo mock serves a live warm workspace (fsList/gitDiff above), so there
  // is no cold capture to read — the workbench falls back to the live path. M3/M4
  // add a fixture-capture mock for the cold-paint demo state.
  async getWorkspaceCapture(): Promise<GetWorkspaceCaptureResponse> {
    return { available: false };
  }

  async getWorkspaceCaptureFile(
    _workspaceId: string,
    _sessionId: string,
    _path: string,
  ): Promise<GetWorkspaceCaptureFileResponse> {
    throw new Error("no capture in the demo mock");
  }

  // The machine fleet backing the dock-header chip: one live session-group box.
  async listMachines(): Promise<MachinesResponse> {
    return {
      activeSandboxId: "demo-sandbox",
      activeEpoch: 1,
      machines: [
        {
          sandboxId: "demo-sandbox",
          enrollmentId: null,
          name: "Cloud sandbox",
          kind: "modal",
          state: "online",
          workspaceGeneration: null,
          archiveGeneration: null,
          archiveComplete: false,
          active: true,
          isSessionGroup: true,
          os: "linux",
          arch: "x86_64",
          hasDisplay: true,
          allowScreenControl: false,
          sharedSessionCount: 1,
          lastSeenAt: new Date().toISOString(),
          metrics: null,
        },
      ],
    };
  }

  async terminalExec(): Promise<TerminalExecResponse> {
    return { stdout: "", stderr: "", exitCode: 0, running: false, wallTimeSeconds: 0 };
  }

  async terminalPtyOpen(): Promise<PtyOpenResponse> {
    return {
      ptyId: "00000000-0000-4000-8000-0000000000bb",
      streamVia: "sse-events",
      supportsInput: true,
    };
  }

  async terminalPtyWrite(): Promise<void> {
    // no-op
  }

  async terminalPtyResize(): Promise<void> {
    // no-op
  }

  async terminalPtyClose(): Promise<void> {
    // no-op
  }

  private fileAsset(workspaceId: string, overrides: Partial<FileAsset>): FileAsset {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? `file-${Date.now()}`,
      workspaceId,
      status: "ready",
      filename: overrides.filename ?? "file",
      safeFilename: overrides.filename ?? "file",
      contentType: overrides.contentType ?? "application/octet-stream",
      sizeBytes: overrides.sizeBytes ?? 0,
      sha256: null,
      bucket: "mock",
      objectKey: `mock/${overrides.id ?? "file"}`,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Keep the scripted narrative and interactive turns ordered per session. */
  private queueResponse(bus: SessionBus, text: string): void {
    const previous = this.responseQueues.get(bus.sessionId) ?? Promise.resolve();
    const script = bus.sessionId === MANAGER_SESSION_ID ? this.managerScript : null;
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        await script?.catch(() => undefined);
        await this.respond(bus, text);
      });
    this.responseQueues.set(bus.sessionId, queued);
    void queued.then(
      () => {
        if (this.responseQueues.get(bus.sessionId) === queued) {
          this.responseQueues.delete(bus.sessionId);
        }
      },
      () => {
        if (this.responseQueues.get(bus.sessionId) === queued) {
          this.responseQueues.delete(bus.sessionId);
        }
      },
    );
  }

  /** Canned manager acknowledgment for anything typed into the composer. */
  private async respond(bus: SessionBus, text: string): Promise<void> {
    bus.setStatus("running");
    const turnId = `turn-${Date.now()}`;
    await streamText(
      bus,
      turnId,
      `Got it — "${text.trim().slice(0, 80)}". I'll fold that into the current plan and report back here.`,
    );
    bus.append("turn.completed", {}, turnId);
    bus.setStatus("idle");
  }

  private fabricateSession(
    sessionId: string,
    status: SessionStatus,
    title: string,
    agoMinutes = 0,
  ): Session {
    const updatedAt = new Date(Date.now() - agoMinutes * 60_000).toISOString();
    return {
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status,
      initialMessage: title,
      title: null,
      titleSource: null,
      instructions: null,
      policyRole: null,
      resources: [],
      skills: [],
      tools: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      toolPolicyVersion: 1,
      metadata: { title },
      createdBy: { kind: "subject", subjectId: "user:demo" },
      createdByContext: {},
      model: "gpt-5.2",
      sandboxBackend: "modal",
      workingDir: null,
      sandboxOs: "linux",
      sandboxGroupId: sessionId,
      activeSandboxId: null,
      activeEpoch: 0,
      variableSetId: null,
      environmentId: null,
      rigId: null,
      rigVersionId: null,
      firstPartyMcpPermissions: null,
      firstPartyMcpTools: [],
      mcpServers: [],
      parentSessionId: sessionId === WORKER_SESSION_ID ? MANAGER_SESSION_ID : null,
      rootSessionId: sessionId === WORKER_SESSION_ID ? MANAGER_SESSION_ID : sessionId,
      nestedAgentDepth: sessionId === WORKER_SESSION_ID ? 1 : 0,
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
      effectiveControl: this.effectiveControl(sessionId),
      lastSequence: this.bus(sessionId).events.length,
      codexCompactionMode: "portable",
      pinned: false,
      pinnedAt: null,
      pinVersion: 0,
      createdAt: updatedAt,
      updatedAt,
    };
  }
}

function fabricateBrowserSession(
  associationSessionId: string,
  overrides: Partial<BrowserSession> = {},
): BrowserSession {
  const now = new Date().toISOString();
  const base: BrowserSession = {
    id: DEMO_BROWSER_SESSION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Agent browser",
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: MANAGER_SESSION_ID },
    controller: {
      controllerId: "opengeni-browserd",
      controllerGeneration: "demo-controller-1",
      placementInstanceId: "demo-placement-1",
    },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    engineVersion: "151",
    headless: false,
    identityId: null,
    baseRevisionId: null,
    networkRouteId: null,
    linkedComputerSessionId: DEMO_COMPUTER_SESSION_ID,
    capabilities: {
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      tabs: true,
      downloads: true,
      uploads: true,
      clipboard: false,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: true,
      privateCheckpoint: true,
      identityPublication: true,
      parallelTargets: true,
    },
    associations: [
      {
        sessionId: associationSessionId,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "agent:demo",
        lastUsedAt: now,
      },
    ],
    createdBySubjectId: "agent:demo",
    createdAt: now,
    lastUsedAt: now,
    failureCode: null,
  };
  const session = { ...base, ...overrides };
  return {
    ...session,
    capabilities: {
      ...base.capabilities,
      ...(overrides.capabilities ?? {}),
      linkedComputer: session.linkedComputerSessionId !== null,
    },
  };
}

function requireDemoBrowserController(
  session: BrowserSession,
): NonNullable<BrowserSession["controller"]> {
  if (session.lifecycle !== "active" || !session.controller) {
    throw new Error("The scripted browser controller is not active.");
  }
  return session.controller;
}

function authRunSettled(run: AuthRun): boolean {
  return run.state === "verified" || run.state === "failed" || run.state === "cancelled";
}

function fabricateComputerSession(
  associationSessionId: string,
  overrides: Partial<ComputerSession> = {},
): ComputerSession {
  const now = new Date().toISOString();
  return {
    id: DEMO_COMPUTER_SESSION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Agent computer",
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: MANAGER_SESSION_ID },
    controller: {
      controllerId: "opengeni-interaction-controller",
      controllerGeneration: "demo-computer-controller-1",
      placementInstanceId: "demo-placement-1",
    },
    platform: "linux",
    adapter: "opengeni.linux.atspi-x11.v1",
    seatId: "demo-seat-1",
    displayId: ":99",
    capabilities: {
      semanticObservation: true,
      appDiscovery: true,
      appLaunch: true,
      windowCapture: true,
      screenCapture: true,
      semanticActions: true,
      pointerInput: true,
      keyboardInput: true,
      backgroundActions: true,
      parallelApps: true,
    },
    associations: [
      {
        sessionId: associationSessionId,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "agent:demo",
        lastUsedAt: now,
      },
    ],
    createdBySubjectId: "agent:demo",
    createdAt: now,
    lastUsedAt: now,
    failureCode: null,
    ...overrides,
  };
}

function requireDemoComputerController(
  session: ComputerSession,
): NonNullable<ComputerSession["controller"]> {
  if (session.lifecycle !== "active" || !session.controller) {
    throw new Error("The scripted computer controller is not active.");
  }
  return session.controller;
}

function fabricateComputerTarget(
  computerSessionId: string,
  overrides: Partial<ComputerTarget> = {},
): ComputerTarget {
  return {
    id: DEMO_COMPUTER_WINDOW_ID,
    computerSessionId,
    controllerGeneration: "demo-computer-controller-1",
    targetGeneration: "demo-window-1",
    kind: "window",
    applicationId: "org.opengeni.demo",
    processId: 4_201,
    title: "OpenGeni workspace",
    bounds: { x: 92, y: 68, width: 1_096, height: 612 },
    focused: true,
    ...overrides,
  };
}

function fabricateComputerObservation(target: ComputerTarget): ComputerObservation {
  const semantic =
    target.kind === "screen"
      ? null
      : {
          kind: "snapshot" as const,
          roots: [
            {
              ref: "demo-window",
              role: "window",
              name: target.title,
              states: target.focused ? ["focused"] : [],
              actions: ["focus"],
              children: [
                {
                  ref: "demo-run",
                  role: "button",
                  name: "Run checks",
                  states: [],
                  actions: ["invoke"],
                },
                {
                  ref: "demo-status",
                  role: "status",
                  name: "Ready",
                  value: "All systems operational",
                  states: [],
                  actions: [],
                },
              ],
            },
          ],
          nodeCount: 3,
        };
  return {
    protocolVersion: 1,
    observationId: `demo-computer-observation-${Date.now()}`,
    computerSessionId: target.computerSessionId,
    target,
    frameId: `demo-computer-frame-${target.targetGeneration}`,
    semantic,
    screenshot: null,
    focusedRef: target.focused ? "demo-window" : null,
    changedRegions: [],
    observedAt: new Date().toISOString(),
  };
}

function fabricateBrowserIdentity(overrides: Partial<BrowserIdentity> = {}): BrowserIdentity {
  const now = new Date().toISOString();
  return {
    id: DEMO_BROWSER_IDENTITY_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Signed-in work",
    status: "active",
    defaultRevisionId: null,
    headGeneration: 0,
    revisionCount: 0,
    createdBySubjectId: "user:demo",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fabricateBrowserRevision(
  session: BrowserSession,
  identity: BrowserIdentity,
  parent: BrowserRevision | null,
): BrowserRevision {
  return {
    id: demoUuid(),
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    identityId: identity.id,
    parentRevisionId: parent?.id ?? session.baseRevisionId,
    ordinal: identity.revisionCount + 1,
    sourceBrowserSessionId: session.id,
    manifestDigest: "a".repeat(64),
    components: [
      {
        id: demoUuid(),
        kind: "chromium_profile",
        format: "opengeni.chromium-profile.v1+gzip+aes-256-gcm",
        artifactDigest: "b".repeat(64),
        sizeBytes: 1_024,
        materialization: {
          portability: "portable",
          reason: null,
          platform: "linux",
          architecture: "x64",
          engine: "chromium",
          engineVersion: session.engineVersion,
          driverId: session.driverId,
          driverSchemaVersion: 1,
          profileCrypto: "chromium_basic",
          providerId: null,
          placement: null,
        },
      },
    ],
    createdBySubjectId: "user:demo",
    createdAt: new Date().toISOString(),
  };
}

function fabricateBrowserTarget(
  browserSessionId: string,
  overrides: Partial<BrowserTarget> = {},
): BrowserTarget {
  return {
    id: DEMO_BROWSER_TARGET_ID,
    browserSessionId,
    controllerGeneration: "demo-controller-1",
    targetGeneration: "demo-target-1",
    documentGeneration: "demo-document-1",
    kind: "page",
    title: "OpenGeni browser",
    url: "https://opengeni.ai/",
    selected: true,
    attached: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fabricateBrowserObservation(target: BrowserTarget): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: `demo-observation-${Date.now()}`,
    browserSessionId: target.browserSessionId,
    target,
    frameId: `demo-frame-${target.documentGeneration ?? "blank"}`,
    semantic: {
      kind: "snapshot",
      roots: [
        {
          ref: "demo-document",
          role: "document",
          name: target.title,
          states: [],
          actions: [],
          children: [
            {
              ref: "demo-link",
              role: "link",
              name: "Explore OpenGeni",
              states: [],
              actions: ["click"],
            },
          ],
        },
      ],
      nodeCount: 2,
    },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: new Date().toISOString(),
  };
}

function browserLifecycleReceipt(
  operationId: string,
  browserSessionId: string,
  kind: "create" | "resume" | "suspend" | "end",
): BrowserSessionMutationResponse["operation"] {
  const now = new Date().toISOString();
  return {
    operationId,
    resourceKind: "browser_session",
    resourceId: browserSessionId,
    kind,
    state: "completed",
    replayed: false,
    error: null,
    createdAt: now,
    dispatchedAt: now,
    settledAt: now,
  };
}

function computerLifecycleReceipt(
  operationId: string,
  computerSessionId: string,
  kind: "create" | "end",
): ComputerSessionMutationResponse["operation"] {
  const now = new Date().toISOString();
  return {
    operationId,
    resourceKind: "computer_session",
    resourceId: computerSessionId,
    kind,
    state: "completed",
    replayed: false,
    error: null,
    createdAt: now,
    dispatchedAt: now,
    settledAt: now,
  };
}

async function streamText(
  bus: SessionBus,
  turnId: string,
  text: string,
  delayMs = 14,
): Promise<void> {
  const words = text.split(/(?<=\s)/);
  for (const word of words) {
    bus.append("agent.message.delta", { text: word }, turnId);
    await sleep(delayMs);
  }
  bus.append("agent.message.completed", { text }, turnId);
}

/** The hero narrative: a manager session orchestrating a worker. */
async function runOpsChannelScript(bus: SessionBus): Promise<void> {
  bus.setStatus("idle");
  // Seed the Terminal surface up-front (an interactive PTY + a populated
  // transcript) so the tab is live the moment the dock opens, instead of an
  // empty read-only void until the narrative reaches the worker.
  bus.append("terminal.pty.started", { ptyId: "00000000-0000-4000-8000-0000000000bb" });
  bus.append("terminal.pty.output.delta", {
    ptyId: "00000000-0000-4000-8000-0000000000bb",
    stream: "stdout",
    chunk: TERMINAL_TRANSCRIPT,
  });
  bus.append("user.message", {
    text: "Set up a staging environment for the api service, then run a drift check on prod.",
  });
  await sleep(500);
  bus.setStatus("running");
  const turn = "turn-script-1";

  bus.append(
    "agent.reasoning.delta",
    {
      text: "Two asks: a staging environment (substantial — needs a worker with cloud access) and a prod drift check (the drift scheduled task can be triggered, or a read-only worker). Check what's already running first.",
    },
    turn,
  );
  await sleep(900);

  bus.append(
    "agent.toolCall.created",
    { id: "call-1", name: "sessions_list", arguments: { limit: 10 } },
    turn,
  );
  await sleep(700);
  bus.append(
    "agent.toolCall.output",
    {
      id: "call-1",
      output: {
        content: [
          { type: "text", text: JSON.stringify([{ id: WORKER_SESSION_ID, status: "idle" }]) },
        ],
      },
    },
    turn,
  );
  await sleep(400);

  await streamText(
    bus,
    turn,
    "Nothing conflicting is running. I'll spawn a worker to stand up staging for the api service — it gets the workspace environment with your cloud credentials; I'll keep narrating its progress here.",
  );
  await sleep(500);

  bus.append(
    "agent.toolCall.created",
    {
      id: "call-2",
      name: "session_create",
      arguments: {
        initialMessage:
          "Stand up the staging environment for the api service: cluster namespace, managed Postgres, deploy pipeline wired to the repo.",
        sandboxBackend: "modal",
      },
    },
    turn,
  );
  await sleep(1300);
  bus.append(
    "agent.toolCall.output",
    {
      id: "call-2",
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: WORKER_SESSION_ID,
              workspaceId: WORKSPACE_ID,
              status: "queued",
            }),
          },
        ],
      },
    },
    turn,
  );
  await sleep(400);

  bus.append(
    "sandbox.operation.started",
    { name: "prepare", command: "git clone github.com/acme/api" },
    turn,
  );
  await sleep(900);
  bus.append("sandbox.operation.completed", { name: "prepare" }, turn);

  bus.append(
    "sandbox.command.output.delta",
    {
      stream: "stdout",
      chunk: `kubectl rollout status deploy/api -n api-staging\r\ndeployment "api" successfully rolled out\r\n${DIM}operator@api-staging${RESET}:${CYAN}~/api${RESET}$ ${GREEN}Deploy reachable at https://api-staging.acme.dev${RESET}\r\n`,
    },
    turn,
  );

  await streamText(
    bus,
    turn,
    "Worker is up and cloning the repo. For the drift check I'm triggering the existing scheduled drift task against prod rather than spawning a second worker — it already has the read-only credentials.",
  );
  await sleep(400);

  bus.append(
    "goal.set",
    { goal: { text: "Staging live for api + prod drift report delivered" } },
    turn,
  );
  await sleep(700);

  await streamText(
    bus,
    turn,
    "I'll report back when the worker has staging reachable. If the drift check finds anything that needs a decision (destructive changes, spend), I'll ask you here first.",
  );
  await sleep(600);

  // A rich, formatted status report — exercises the full markdown surface
  // (headings, emphasis, lists incl. nested + task lists, inline + fenced
  // code, a blockquote, a table, a link, and a rule) so the timeline's
  // default renderer can be judged end-to-end.
  await streamText(bus, turn, MARKDOWN_REPORT, 6);

  bus.append("turn.completed", {}, turn);
  bus.setStatus("idle");
}

/**
 * A realistic interactive-PTY transcript for the Terminal tab: a couple of
 * prompts, colorized output, and a trailing prompt with a block cursor so the
 * surface reads as a live shell (not a dead black void) the instant it mounts.
 * `[…m` are ANSI SGR codes; xterm renders them.
 */
const GREEN = "[32m";
const CYAN = "[36m";
const BOLD = "[1m";
const DIM = "[2m";
const RESET = "[0m";
const TERMINAL_TRANSCRIPT = [
  `${DIM}operator@api-staging${RESET}:${CYAN}~/api${RESET}$ kubectl get pods -n api-staging`,
  "NAME                   READY   STATUS    RESTARTS   AGE",
  `api-7c9d4f8b6-2xk4q    1/1     ${GREEN}Running${RESET}   0          42s`,
  `api-7c9d4f8b6-9mlz7    1/1     ${GREEN}Running${RESET}   0          42s`,
  "",
  `${DIM}operator@api-staging${RESET}:${CYAN}~/api${RESET}$ curl -s https://api-staging.acme.dev/healthz`,
  `${GREEN}{"status":"ok","db":"reachable","version":"a049964"}${RESET}`,
  "",
  `${DIM}operator@api-staging${RESET}:${CYAN}~/api${RESET}$ ${BOLD}git status -sb${RESET}`,
  `${CYAN}## feat/sandbox-dock...origin/feat/sandbox-dock [ahead 2, behind 1]${RESET}`,
  ` ${GREEN}M${RESET} src/server.ts`,
  ` ${GREEN}M${RESET} infra/main.tf`,
  `${GREEN}A${RESET}  src/config.ts`,
  "",
  `${DIM}operator@api-staging${RESET}:${CYAN}~/api${RESET}$ `,
].join("\r\n");

/** A formatted "staging is live" report covering every common markdown element. */
const MARKDOWN_REPORT = `## Staging is live

Staging for the **api** service is reachable and the prod drift check finished. Here's the rundown.

### What landed

- Namespace \`api-staging\` created on the cluster
  - Ingress wired with a *temporary* TLS cert (auto-renews)
  - HPA set to **2–6** replicas
- Managed Postgres provisioned and migrated
- Deploy pipeline connected to [the api repo](https://example.com/acme/api)

### Drift check

Prod is mostly clean. Outstanding items:

1. One untracked security group rule (port 6379, Redis)
2. A manually-bumped instance size on \`api-prod-2\`
3. Two stale DNS records

> **Heads up:** the Redis rule looks like a hotfix from last week — I'd confirm before reverting, since removing it could drop cache connectivity.

### Cost delta

| Resource | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Compute | $420 | $510 | +$90 |
| Postgres | $0 | $85 | +$85 |
| Egress | $30 | $34 | +$4 |

### Next steps

- [x] Stand up staging namespace
- [x] Run prod drift check
- [ ] Decide on the Redis rule (needs you)
- [ ] Schedule the DNS cleanup

You can reach staging with:

\`\`\`ts
const res = await fetch("https://api-staging.acme.dev/healthz", {
  headers: { authorization: \`Bearer \${process.env.STAGING_TOKEN}\` },
});
console.log(res.status); // 200
\`\`\`

Run \`og sessions tail\` to follow the worker, or reply here and I'll fold it into the plan.

---

Everything above is staged behind the \`staging\` flag — nothing prod-facing changed.`;

/* --- fixtures ------------------------------------------------------------------ */

const ACCOUNT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/**
 * A two-provider deployment config so the demo composer exercises the
 * <ModelPicker>: the built-in OpenAI provider serving gpt-5.6-sol (the default,
 * `responses` wire API) plus a Fireworks AI registry provider serving GLM 5.2
 * (`chat` wire API) — exactly the host config example in model-providers.md.
 */
const CLIENT_CONFIG: ClientConfig = {
  deploymentRevision: "demo",
  apiContractRevision: "2026-08-social-provider-tools-v1",
  defaultModel: "gpt-5.6-sol",
  allowedModels: ["gpt-5.6-sol", "accounts/fireworks/models/glm-5p2"],
  models: [
    {
      id: "gpt-5.6-sol",
      label: "gpt-5.6-sol",
      provider: "openai",
      providerLabel: "OpenAI",
      api: "responses",
    },
    {
      id: "accounts/fireworks/models/glm-5p2",
      label: "GLM 5.2",
      provider: "fireworks",
      providerLabel: "Fireworks AI",
      api: "chat",
      contextWindowTokens: 1_048_576,
    },
  ],
  defaultReasoningEffort: "medium",
  allowedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  mcpServers: [{ id: "opengeni", name: "OpenGeni" }],
  fileUploads: { enabled: true, maxSizeBytes: 25 * 1024 * 1024 },
  productAccessMode: "managed",
  auth: { mode: "none" },
  analytics: { consentRequired: true, providers: {} },
  structuredServices: { fileSystem: true, git: true, terminalEvents: true },
};

function fabricateTurn(sessionId: string, position: number, prompt: string): SessionTurn {
  const now = new Date(Date.now() - (10 - position) * 60_000).toISOString();
  return {
    id: demoUuid(),
    workspaceId: WORKSPACE_ID,
    sessionId,
    triggerEventId: demoUuid(),
    temporalWorkflowId: `wf-${sessionId.slice(0, 8)}`,
    status: "queued",
    source: "user",
    position,
    prompt,
    resources: [],
    tools: [],
    toolsProvided: false,
    model: "gpt-5.2",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "modal",
    sandboxOs: "linux",
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
    initiator: { kind: "subject", subjectId: "user:demo" },
    initiatorContext: {},
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fabricateGoal(sessionId: string): SessionGoal {
  const now = new Date().toISOString();
  return {
    id: demoUuid(),
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    sessionId,
    status: "active",
    text: "Staging live for api + prod drift report delivered",
    successCriteria: "Staging environment reachable and drift report filed",
    evidence: null,
    rationale: null,
    pausedReason: null,
    createdBy: "agent",
    version: 1,
    autoContinuations: 2,
    noProgressStreak: 0,
    maxAutoContinuations: 25,
    metadata: {},
    continuation: {
      state: "running",
      reason: "goal_turn_running",
      wakeRevision: 2,
      observedRevision: 2,
      nextAttemptAt: null,
      lastError: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function fabricateEnvironment(
  name: string,
  variableNames: string[] = ["CLOUD_API_TOKEN", "DATABASE_URL"],
): WorkspaceEnvironment {
  const now = new Date().toISOString();
  return {
    id: demoUuid(),
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    description: `${name} credentials`,
    variables: variableNames.map((variableName) => ({
      name: variableName,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

function fabricatePack(manifest: RegisterCapabilityPackRequest): CapabilityPack {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    role: manifest.role,
    category: manifest.category,
    version: manifest.version,
    skills: (manifest.skills ?? []).map((skill) => ({ name: skill.name, files: skill.files })),
    components: (manifest.components ?? []).map((component) => ({
      ...component,
      required: component.required ?? true,
    })),
    ...(manifest.rig
      ? {
          rig: {
            ...manifest.rig,
            required: manifest.rig.required ?? true,
            requireVerified: manifest.rig.requireVerified ?? false,
          },
        }
      : {}),
    ...(manifest.sandboxImage ? { sandboxImage: manifest.sandboxImage } : {}),
    connectors: [],
    knowledge: [],
    scheduledTaskTemplates: [],
    tools: manifest.tools ?? [],
    ...(manifest.variableSet
      ? {
          variableSet: {
            ...manifest.variableSet,
            requiredVariables: manifest.variableSet.requiredVariables ?? [],
            required: manifest.variableSet.required ?? false,
          },
        }
      : {}),
    metadata: manifest.metadata ?? {},
  };
}

const DEVOPS_PACK: CapabilityPack = fabricatePack({
  id: "autonomous-devops",
  name: "Autonomous DevOps",
  description: "Long-running infrastructure agents: drift checks, deploys, incident response.",
  role: "devops",
  category: "infrastructure",
  version: "1.2.0",
  skills: [{ name: "drift-checks", files: [{ path: "SKILL.md", content: "# Drift checks" }] }],
});

function fabricateWorkspace(name: string): Workspace {
  const now = new Date().toISOString();
  return {
    id: demoUuid(),
    accountId: ACCOUNT_ID,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    settings: {},
    createdAt: now,
    updatedAt: now,
  };
}

/* --- fleet + schedule fixtures ----------------------------------------------- */

const FLEET: { id: string; status: SessionStatus; title: string; agoMinutes: number }[] = [
  {
    id: MANAGER_SESSION_ID,
    status: "running",
    title: "Ops channel — manager session",
    agoMinutes: 0,
  },
  {
    id: WORKER_SESSION_ID,
    status: "running",
    title: "Stand up staging for the api service",
    agoMinutes: 2,
  },
  {
    id: "7385415a-aaaa-4bbb-8ccc-0123456789ab",
    status: "requires_action",
    title: "Migrate notification queue to managed Redis",
    agoMinutes: 34,
  },
  {
    id: "4ecb7a70-dddd-4eee-8fff-0123456789ab",
    status: "idle",
    title: "Nightly drift check — prod",
    agoMinutes: 540,
  },
  {
    id: "6d252830-1212-4343-8565-0123456789ab",
    status: "failed",
    title: "Rotate database credentials across environments",
    agoMinutes: 1500,
  },
  {
    id: "9a5be230-9898-4767-8545-0123456789ab",
    status: "cancelled",
    title: "Spike: evaluate preview environments per PR",
    agoMinutes: 4000,
  },
];

const SCHEDULED_TASKS: ScheduledTask[] = [
  scheduledTask(
    "Drift check — prod",
    { type: "calendar", timeZone: "UTC", hour: 5, minute: 0 },
    "Run a full drift check against prod and file a report.",
  ),
  scheduledTask(
    "Dependency upgrade sweep",
    { type: "calendar", timeZone: "UTC", hour: 6, minute: 30, daysOfWeek: ["MONDAY"] },
    "Open PRs for safe dependency upgrades.",
  ),
  scheduledTask(
    "Preview-environment reaper",
    { type: "interval", everySeconds: 3600 },
    "Tear down preview environments for merged or stale PRs.",
  ),
];

function scheduledTask(
  name: string,
  schedule: ScheduledTask["schedule"],
  prompt: string,
): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: demoUuid(),
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspaceId: WORKSPACE_ID,
    name,
    status: "active",
    schedule,
    temporalScheduleId: `sched-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    action: { kind: "agent_turn" },
    agentConfig: { prompt, resources: [], tools: [], metadata: {} },
    targetSessionId: null,
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
