/* ----------------------------------------------------------------------------
   Scripted mock OpenGeni client for the harness.

   Implements the `SessionClientLike` surface the hooks use, backed by an
   in-memory event bus, so the real hooks + components run against a
   realistic manager ops-channel narrative (streaming deltas, tool calls,
   worker spawns) without a server. Swap in the real `OpenGeniClient` and
   everything renders identically.
   -------------------------------------------------------------------------- */

import type {
  ScheduledTask,
  Session,
  SessionEvent,
  SessionStatus,
  StreamSessionEventsOptions,
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
  bus.append("turn.completed", {}, turn);
  bus.setStatus("idle");
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
