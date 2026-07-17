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
  AttachViewerResponse,
  BillingUsageResponse,
  CapabilityPack,
  ClientConfig,
  ComposerDraft,
  CreateWorkspaceEnvironmentRequest,
  CreateVariableSetRequest,
  CreateRigRequest,
  UpdateRigRequest,
  ProposeRigChangeRequest,
  Rig,
  RigVersion,
  RigChange,
  CreateWorkspaceRequest,
  EnablePackRequest,
  FileAsset,
  FileDownloadUrlResponse,
  FsListResponse,
  FsReadResponse,
  FsWriteResponse,
  FsDeleteResponse,
  FsMoveResponse,
  FsMkdirResponse,
  FsTreeNode,
  GitDiffResponse,
  GetWorkspaceCaptureResponse,
  GetWorkspaceCaptureFileResponse,
  GitStatusResponse,
  ListPacksResponse,
  PackInstallation,
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
  SessionLineageResponse,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionControlResponse,
  SessionStatus,
  SessionTurn,
  SteerMessageResult,
  StreamSessionEventsOptions,
  UploadFileInput,
  UpdateSessionGoalRequest,
  UpdateSessionRequest,
  UpdateSessionPinRequest,
  UpdateWorkspaceEnvironmentRequest,
  UpdateVariableSetRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceControlEvent,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
  VariableSet,
  VariableSetVariableMetadata,
  WorkspaceRegisteredPack,
} from "@opengeni/sdk";
import type { SessionClientLike } from "../src/index";
import type { MachinesResponse } from "../src/machines";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
export const MANAGER_SESSION_ID = "3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const WORKER_SESSION_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
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
    const event = bus.append("user.message", { text });
    void this.respond(bus, text);
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
      void runOpsChannelScript(bus);
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
      tools: turn.tools,
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
        tools: [],
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
      items: this.sessionTurns(sessionId).filter((turn) => turn.status === "queued"),
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
    this.bus(sessionId).append("session.context.compacted", { trigger: "operator" });
    return { status: "completed", message: "Context compacted." };
  }

  async sendApprovalDecision(
    _workspaceId: string,
    sessionId: string,
    decision: { approvalId: string; decision: "approve" | "reject"; message?: string },
  ): Promise<SessionEvent> {
    return this.bus(sessionId).append("user.approvalDecision", decision);
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

  async listWorkspaceControlEvents(): Promise<WorkspaceControlEvent[]> {
    return [];
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
      viewerHeartbeatIntervalMs: 30_000,
      dataPlaneUrl: null,
      streamToken: null,
      streamExpiresAt: null,
      resolution: null,
      transport: null,
      client: null,
      terminalUrl: null,
      terminalToken: null,
      terminalTransport: null,
    };
  }

  async heartbeatViewer(): Promise<ViewerHeartbeatResponse> {
    return { alive: true };
  }

  async detachViewer(): Promise<void> {
    // no-op in the demo
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
      resources: [],
      tools: [],
      metadata: { title },
      model: "gpt-5.2",
      sandboxBackend: "modal",
      sandboxOs: "linux",
      sandboxGroupId: sessionId,
      activeSandboxId: null,
      activeEpoch: 0,
      variableSetId: null,
      environmentId: null,
      rigId: null,
      rigVersionId: null,
      firstPartyMcpPermissions: null,
      mcpServers: [],
      parentSessionId: sessionId === WORKER_SESSION_ID ? MANAGER_SESSION_ID : null,
      createIdempotencyKey: null,
      temporalWorkflowId: null,
      activeTurnId: null,
      queueVersion: 0,
      queueHeadPosition: 0,
      queueTailPosition: 0,
      effectiveControl: this.effectiveControl(sessionId),
      lastSequence: this.bus(sessionId).events.length,
      pinned: false,
      pinnedAt: null,
      pinVersion: 0,
      createdAt: updatedAt,
      updatedAt,
    };
  }
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
  apiContractRevision: "2026-07-session-control-v1",
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
  allowedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  mcpServers: [{ id: "opengeni", name: "OpenGeni" }],
  fileUploads: { enabled: true, maxSizeBytes: 25 * 1024 * 1024 },
  productAccessMode: "managed",
  auth: { mode: "none" },
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
    model: "gpt-5.2",
    reasoningEffort: "medium",
    sandboxBackend: "modal",
    sandboxOs: "linux",
    metadata: {},
    version: 1,
    executionGeneration: 0,
    activeAttemptId: null,
    lineage: {},
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
    tools: manifest.tools ?? [],
    connectors: [],
    knowledge: [],
    scheduledTaskTemplates: [],
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
    agentConfig: { prompt, resources: [], tools: [], metadata: {} },
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
