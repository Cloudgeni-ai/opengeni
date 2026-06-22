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
  CreateWorkspaceEnvironmentRequest,
  CreateWorkspaceRequest,
  EnablePackRequest,
  FileAsset,
  FileDownloadUrlResponse,
  FsListResponse,
  FsReadResponse,
  FsTreeNode,
  GitDiffResponse,
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
  SessionEvent,
  SessionGoal,
  SessionStatus,
  SessionTurn,
  SteerMessageResult,
  StreamSessionEventsOptions,
  UploadFileInput,
  UpdateSessionGoalRequest,
  UpdateSessionTurnRequest,
  UpdateWorkspaceEnvironmentRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
  WorkspaceRegisteredPack,
} from "@opengeni/sdk";
import type { SessionClientLike } from "../src/index";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
export const MANAGER_SESSION_ID = "3f6e1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const WORKER_SESSION_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

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
      while (!signal?.aborted) {
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
    return this.fabricateSession(sessionId, this.bus(sessionId).status, "Ops channel — manager session");
  }

  async listSessions(): Promise<Session[]> {
    return FLEET.map((spec) => this.fabricateSession(spec.id, spec.status, spec.title, spec.agoMinutes));
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

  async interrupt(_workspaceId: string, sessionId: string): Promise<SessionEvent> {
    const bus = this.bus(sessionId);
    const event = bus.append("turn.cancelled", {}, "turn-live");
    bus.setStatus("idle");
    return event;
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

  async updateQueuedTurn(
    _workspaceId: string,
    sessionId: string,
    turnId: string,
    update: UpdateSessionTurnRequest,
  ): Promise<SessionTurn> {
    const turns = this.sessionTurns(sessionId);
    const turn = turns.find((candidate) => candidate.id === turnId && candidate.status === "queued");
    if (!turn) {
      throw new Error(`queued turn not found: ${turnId}`);
    }
    Object.assign(turn, {
      ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.reasoningEffort !== undefined ? { reasoningEffort: update.reasoningEffort } : {}),
      updatedAt: new Date().toISOString(),
    });
    this.bus(sessionId).append("turn.updated", { turnId }, turnId);
    return { ...turn };
  }

  async reorderQueuedTurns(_workspaceId: string, sessionId: string, turnIds: string[]): Promise<SessionTurn[]> {
    const turns = this.sessionTurns(sessionId);
    turnIds.forEach((turnId, index) => {
      const turn = turns.find((candidate) => candidate.id === turnId && candidate.status === "queued");
      if (turn) {
        turn.position = index + 1;
      }
    });
    this.bus(sessionId).append("turn.updated", { reorderedTurnIds: turnIds });
    return turns.filter((turn) => turn.status === "queued").sort((a, b) => a.position - b.position);
  }

  async deleteQueuedTurn(_workspaceId: string, sessionId: string, turnId: string): Promise<SessionTurn> {
    const turns = this.sessionTurns(sessionId);
    const turn = turns.find((candidate) => candidate.id === turnId && candidate.status === "queued");
    if (!turn) {
      throw new Error(`queued turn not found: ${turnId}`);
    }
    turn.status = "cancelled";
    this.bus(sessionId).append("turn.cancelled", { turnId }, turnId);
    return { ...turn };
  }

  async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SteerMessageResult> {
    const accepted = await this.sendMessage(workspaceId, sessionId, message);
    return { accepted, turn: null, interrupted: this.bus(sessionId).status === "running" };
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

  async updateGoal(workspaceId: string, sessionId: string, request: UpdateSessionGoalRequest): Promise<SessionGoal> {
    const goal = await this.getGoal(workspaceId, sessionId);
    goal.status = request.status;
    goal.rationale = request.rationale ?? goal.rationale;
    goal.pausedReason = request.status === "paused" ? "api" : null;
    goal.updatedAt = new Date().toISOString();
    this.goals.set(sessionId, goal);
    this.bus(sessionId).append(request.status === "paused" ? "goal.paused" : "goal.resumed", { goalId: goal.id });
    return { ...goal };
  }

  async clearSessionContext(_workspaceId: string, sessionId: string): Promise<void> {
    this.bus(sessionId).append("session.context.cleared", { clearedBy: "api" });
  }

  async compactSessionContext(_workspaceId: string, sessionId: string): Promise<{ status: "queued" | "noop"; message: string }> {
    this.bus(sessionId).append("session.context.compacted", { trigger: "operator" });
    return { status: "queued", message: "Compaction will run before the next turn." };
  }

  async sendApprovalDecision(
    _workspaceId: string,
    sessionId: string,
    decision: { approvalId: string; decision: "approve" | "reject"; message?: string },
  ): Promise<SessionEvent> {
    return this.bus(sessionId).append("user.approvalDecision", decision);
  }

  // --- Environments, packs, workspaces, billing (static-ish fixtures) ----------

  private environments: WorkspaceEnvironment[] = [fabricateEnvironment("staging"), fabricateEnvironment("production")];

  async listEnvironments(): Promise<WorkspaceEnvironment[]> {
    return [...this.environments];
  }

  async createEnvironment(_workspaceId: string, request: CreateWorkspaceEnvironmentRequest): Promise<WorkspaceEnvironment> {
    const environment = fabricateEnvironment(request.name, request.variables?.map((variable) => variable.name) ?? []);
    this.environments.push(environment);
    return { ...environment };
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

  async deleteEnvironment(_workspaceId: string, environmentId: string): Promise<void> {
    this.environments = this.environments.filter((candidate) => candidate.id !== environmentId);
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

  async deleteEnvironmentVariable(_workspaceId: string, environmentId: string, name: string): Promise<void> {
    const environment = this.environments.find((candidate) => candidate.id === environmentId);
    if (environment) {
      environment.variables = environment.variables.filter((variable) => variable.name !== name);
    }
  }

  private registeredPacks: WorkspaceRegisteredPack[] = [];
  private packInstallations: PackInstallation[] = [];

  async listPacks(): Promise<ListPacksResponse> {
    return {
      packs: [DEVOPS_PACK, ...this.registeredPacks.map((registration) => registration.pack)],
      installations: [...this.packInstallations],
    };
  }

  async registerPack(_workspaceId: string, manifest: RegisterCapabilityPackRequest): Promise<WorkspaceRegisteredPack> {
    const now = new Date().toISOString();
    const registration: WorkspaceRegisteredPack = {
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      pack: fabricatePack(manifest),
      createdAt: now,
      updatedAt: now,
    };
    this.registeredPacks = [...this.registeredPacks.filter((existing) => existing.pack.id !== manifest.id), registration];
    return registration;
  }

  async enablePack(_workspaceId: string, packId: string, request: EnablePackRequest = {}): Promise<PackInstallation> {
    const now = new Date().toISOString();
    const installation: PackInstallation = {
      id: crypto.randomUUID(),
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      packId,
      status: "active",
      metadata: { ...request.metadata, ...(request.environmentId ? { environmentId: request.environmentId } : {}) },
      enabledAt: now,
      updatedAt: now,
    };
    this.packInstallations = [...this.packInstallations.filter((existing) => existing.packId !== packId), installation];
    return installation;
  }

  async deletePack(_workspaceId: string, packId: string): Promise<void> {
    this.registeredPacks = this.registeredPacks.filter((registration) => registration.pack.id !== packId);
    this.packInstallations = this.packInstallations.filter((installation) => installation.packId !== packId);
  }

  private workspaces: Workspace[] = [fabricateWorkspace("Acme Platform")];

  async listWorkspaces(): Promise<Workspace[]> {
    return [...this.workspaces];
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
      balance: { accountId: ACCOUNT_ID, balanceMicros: 42_500_000, currency: "usd", updatedAt: new Date().toISOString() },
      usage: [],
    };
  }

  async uploadFile(workspaceId: string, input: UploadFileInput): Promise<FileAsset> {
    const sizeBytes = input.data instanceof Blob
      ? input.data.size
      : typeof input.data === "string"
        ? new TextEncoder().encode(input.data).byteLength
        : input.data instanceof Uint8Array
          ? input.data.byteLength
          : (input.data as ArrayBuffer).byteLength;
    return this.fileAsset(workspaceId, { filename: input.filename, contentType: input.contentType, sizeBytes });
  }

  async getFile(workspaceId: string, fileId: string): Promise<FileAsset> {
    return this.fileAsset(workspaceId, { id: fileId });
  }

  async createFileDownloadUrl(_workspaceId: string, fileId: string): Promise<FileDownloadUrlResponse> {
    return { url: `https://example.invalid/files/${fileId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  }

  async getStreamCapabilities(_workspaceId: string, sessionId: string): Promise<SessionCapabilities> {
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
      FileSystem: { available: true, readOnly: false, root: "/workspace", pathSep: "/", treeMode: "lazy", reason: null },
      Terminal: { transport: "pty-ws", ptyCapable: true, shell: "/bin/bash", url: null, token: null, reason: null },
      Git: { available: true, repos: ["."], reason: null },
      DesktopStream: {
        transport: "vnc-ws", client: "novnc", mode: "interactive",
        url: "wss://desktop.invalid/vnc", token: null, expiresAt: null,
        resolution: [1024, 768], unredacted: true, requiresAcknowledgment: false, acknowledged: true,
        shared: false, sharedSessionIds: [], reason: null,
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
    };
  }

  async heartbeatViewer(): Promise<ViewerHeartbeatResponse> {
    return { alive: true };
  }

  async detachViewer(): Promise<void> {
    // no-op in the demo
  }

  async fsList(_workspaceId: string, _sessionId: string, request?: { path?: string }): Promise<FsListResponse> {
    const dir = (name: string, path: string, children?: FsTreeNode[]): FsTreeNode => ({
      name, path, type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false,
      ...(children ? { children } : {}),
    });
    const file = (name: string, path: string, sizeBytes = 512): FsTreeNode => ({
      name, path, type: "file", sizeBytes, mtimeMs: Date.now(), mode: 0o644, truncated: false,
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

  async fsRead(_workspaceId: string, _sessionId: string, request: { path: string }): Promise<FsReadResponse> {
    const content = `// ${request.path}\nexport const ok = true;\n`;
    return { path: request.path, encoding: "utf8", content, sizeBytes: content.length, truncated: false, isBinary: false, revision: 1 };
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
        { path: "src/server.ts", oldPath: null, index: null, worktree: "modified", isConflicted: false },
        { path: "infra/main.tf", oldPath: null, index: null, worktree: "modified", isConflicted: false },
        { path: "src/config.ts", oldPath: null, index: null, worktree: "added", isConflicted: false },
      ],
      revision: 1,
    };
  }

  async gitDiff(_workspaceId: string, _sessionId: string, request?: { staged?: boolean }): Promise<GitDiffResponse> {
    if (request?.staged) {
      return { files: [], revision: 1 };
    }
    return {
      files: [
        {
          path: "src/server.ts", oldPath: null, status: "modified", isBinary: false, isImage: false,
          additions: 3, deletions: 1, truncated: false,
          hunks: [
            {
              oldStart: 12, oldLines: 4, newStart: 12, newLines: 6,
              header: "@@ -12,4 +12,6 @@ export function createServer() {",
              lines: [
                { type: "context", oldNo: 12, newNo: 12, text: "  const app = express();" },
                { type: "del", oldNo: 13, newNo: null, text: "  app.use(cors());" },
                { type: "add", oldNo: null, newNo: 13, text: "  app.use(cors({ origin: ALLOWED_ORIGINS }));" },
                { type: "add", oldNo: null, newNo: 14, text: "  app.use(helmet());" },
                { type: "add", oldNo: null, newNo: 15, text: "  app.use(rateLimit());" },
                { type: "context", oldNo: 14, newNo: 16, text: "  return app;" },
              ],
            },
          ],
        },
        {
          path: "infra/main.tf", oldPath: null, status: "modified", isBinary: false, isImage: false,
          additions: 2, deletions: 0, truncated: false,
          hunks: [
            {
              oldStart: 4, oldLines: 2, newStart: 4, newLines: 4,
              header: "@@ -4,2 +4,4 @@ resource \"aws_instance\" \"api\" {",
              lines: [
                { type: "context", oldNo: 4, newNo: 4, text: "  instance_type = \"t3.small\"" },
                { type: "add", oldNo: null, newNo: 5, text: "  monitoring    = true" },
                { type: "add", oldNo: null, newNo: 6, text: "  ebs_optimized = true" },
                { type: "context", oldNo: 5, newNo: 7, text: "  tags = local.tags" },
              ],
            },
          ],
        },
        {
          path: "src/config.ts", oldPath: null, status: "added", isBinary: false, isImage: false,
          additions: 3, deletions: 0, truncated: false,
          hunks: [
            {
              oldStart: 0, oldLines: 0, newStart: 1, newLines: 3,
              header: "@@ -0,0 +1,3 @@",
              lines: [
                { type: "add", oldNo: null, newNo: 1, text: "export const ALLOWED_ORIGINS = [" },
                { type: "add", oldNo: null, newNo: 2, text: "  \"https://app.acme.dev\"," },
                { type: "add", oldNo: null, newNo: 3, text: "];" },
              ],
            },
          ],
        },
      ],
      revision: 1,
    };
  }

  async terminalExec(): Promise<TerminalExecResponse> {
    return { stdout: "", stderr: "", exitCode: 0, running: false, wallTimeSeconds: 0 };
  }

  async terminalPtyOpen(): Promise<PtyOpenResponse> {
    return { ptyId: "00000000-0000-4000-8000-0000000000bb", streamVia: "sse-events", supportsInput: true };
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

  private fabricateSession(sessionId: string, status: SessionStatus, title: string, agoMinutes = 0): Session {
    const updatedAt = new Date(Date.now() - agoMinutes * 60_000).toISOString();
    return {
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status,
      initialMessage: title,
      resources: [],
      tools: [],
      metadata: { title },
      model: "gpt-5.2",
      sandboxBackend: "modal",
      environmentId: null,
      firstPartyMcpPermissions: null,
      createIdempotencyKey: null,
      temporalWorkflowId: null,
      activeTurnId: null,
      lastSequence: this.bus(sessionId).events.length,
      createdAt: updatedAt,
      updatedAt,
    };
  }
}

async function streamText(bus: SessionBus, turnId: string, text: string, delayMs = 14): Promise<void> {
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
  bus.append("user.message", { text: "Set up a staging environment for the api service, then run a drift check on prod." });
  await sleep(500);
  bus.setStatus("running");
  const turn = "turn-script-1";

  bus.append("agent.reasoning.delta", { text: "Two asks: a staging environment (substantial — needs a worker with cloud access) and a prod drift check (the drift scheduled task can be triggered, or a read-only worker). Check what's already running first." }, turn);
  await sleep(900);

  bus.append("agent.toolCall.created", { id: "call-1", name: "sessions_list", arguments: { limit: 10 } }, turn);
  await sleep(700);
  bus.append(
    "agent.toolCall.output",
    { id: "call-1", output: { content: [{ type: "text", text: JSON.stringify([{ id: WORKER_SESSION_ID, status: "idle" }]) }] } },
    turn,
  );
  await sleep(400);

  await streamText(bus, turn, "Nothing conflicting is running. I'll spawn a worker to stand up staging for the api service — it gets the workspace environment with your cloud credentials; I'll keep narrating its progress here.");
  await sleep(500);

  bus.append(
    "agent.toolCall.created",
    {
      id: "call-2",
      name: "session_create",
      arguments: { initialMessage: "Stand up the staging environment for the api service: cluster namespace, managed Postgres, deploy pipeline wired to the repo.", sandboxBackend: "modal" },
    },
    turn,
  );
  await sleep(1300);
  bus.append(
    "agent.toolCall.output",
    { id: "call-2", output: { content: [{ type: "text", text: JSON.stringify({ id: WORKER_SESSION_ID, workspaceId: WORKSPACE_ID, status: "queued" }) }] } },
    turn,
  );
  await sleep(400);

  bus.append("sandbox.operation.started", { name: "prepare", command: "git clone github.com/acme/api" }, turn);
  await sleep(900);
  bus.append("sandbox.operation.completed", { name: "prepare" }, turn);

  bus.append(
    "sandbox.command.output.delta",
    { stream: "stdout", chunk: "$ kubectl get pods -n api-staging\r\nNAME                   READY   STATUS    RESTARTS   AGE\r\napi-7c9d4f8b6-2xk4q    1/1     Running   0          42s\r\napi-7c9d4f8b6-9mlz7    1/1     Running   0          42s\r\n$ [32mDeploy reachable at https://api-staging.acme.dev[0m\r\n" },
    turn,
  );

  await streamText(bus, turn, "Worker is up and cloning the repo. For the drift check I'm triggering the existing scheduled drift task against prod rather than spawning a second worker — it already has the read-only credentials.");
  await sleep(400);

  bus.append("goal.set", { goal: { text: "Staging live for api + prod drift report delivered" } }, turn);
  await sleep(700);

  await streamText(bus, turn, "I'll report back when the worker has staging reachable. If the drift check finds anything that needs a decision (destructive changes, spend), I'll ask you here first.");
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
 * <ModelPicker>: the built-in OpenAI provider serving gpt-5.5 (the default,
 * `responses` wire API) plus a Fireworks AI registry provider serving GLM 5.2
 * (`chat` wire API) — exactly the host config example in model-providers.md.
 */
const CLIENT_CONFIG: ClientConfig = {
  deploymentRevision: "demo",
  defaultModel: "gpt-5.5",
  allowedModels: ["gpt-5.5", "accounts/fireworks/models/glm-5p2"],
  models: [
    { id: "gpt-5.5", label: "gpt-5.5", provider: "openai", providerLabel: "OpenAI", api: "responses" },
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
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE_ID,
    sessionId,
    triggerEventId: crypto.randomUUID(),
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
    metadata: {},
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fabricateGoal(sessionId: string): SessionGoal {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
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

function fabricateEnvironment(name: string, variableNames: string[] = ["CLOUD_API_TOKEN", "DATABASE_URL"]): WorkspaceEnvironment {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    description: `${name} credentials`,
    variables: variableNames.map((variableName) => ({ name: variableName, version: 1, createdAt: now, updatedAt: now })),
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
    id: crypto.randomUUID(),
    accountId: ACCOUNT_ID,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    createdAt: now,
    updatedAt: now,
  };
}

/* --- fleet + schedule fixtures ----------------------------------------------- */

const FLEET: { id: string; status: SessionStatus; title: string; agoMinutes: number }[] = [
  { id: MANAGER_SESSION_ID, status: "running", title: "Ops channel — manager session", agoMinutes: 0 },
  { id: WORKER_SESSION_ID, status: "running", title: "Stand up staging for the api service", agoMinutes: 2 },
  { id: "7385415a-aaaa-4bbb-8ccc-0123456789ab", status: "requires_action", title: "Migrate notification queue to managed Redis", agoMinutes: 34 },
  { id: "4ecb7a70-dddd-4eee-8fff-0123456789ab", status: "idle", title: "Nightly drift check — prod", agoMinutes: 540 },
  { id: "6d252830-1212-4343-8565-0123456789ab", status: "failed", title: "Rotate database credentials across environments", agoMinutes: 1500 },
  { id: "9a5be230-9898-4767-8545-0123456789ab", status: "cancelled", title: "Spike: evaluate preview environments per PR", agoMinutes: 4000 },
];

const SCHEDULED_TASKS: ScheduledTask[] = [
  scheduledTask("Drift check — prod", { type: "calendar", timeZone: "UTC", hour: 5, minute: 0 }, "Run a full drift check against prod and file a report."),
  scheduledTask("Dependency upgrade sweep", { type: "calendar", timeZone: "UTC", hour: 6, minute: 30, daysOfWeek: ["MONDAY"] }, "Open PRs for safe dependency upgrades."),
  scheduledTask("Preview-environment reaper", { type: "interval", everySeconds: 3600 }, "Tear down preview environments for merged or stale PRs."),
];

function scheduledTask(name: string, schedule: ScheduledTask["schedule"], prompt: string): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
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
    environmentId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
