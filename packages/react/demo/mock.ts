/* ----------------------------------------------------------------------------
   Scripted mock OpenGeni client for the harness.

   Implements the `SessionClientLike` surface the hooks use, backed by an
   in-memory event bus, so the real hooks + components run against a
   realistic manager ops-channel narrative (streaming deltas, tool calls,
   worker spawns) without a server. Swap in the real `OpenGeniClient` and
   everything renders identically.
   -------------------------------------------------------------------------- */

import type {
  BillingUsageResponse,
  CapabilityPack,
  ClientConfig,
  CreateWorkspaceEnvironmentRequest,
  CreateWorkspaceRequest,
  EnablePackRequest,
  FileAsset,
  FileDownloadUrlResponse,
  ListPacksResponse,
  PackInstallation,
  RegisterCapabilityPackRequest,
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
