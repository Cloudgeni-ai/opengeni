import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, listSessionEvents, setSessionStatus } from "@infra-agents/db";
import { appendAndPublishEvents } from "@infra-agents/events";
import type { SessionEvent } from "@infra-agents/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { MemoryEventBus, parseSseBlock, startTestServices, testSettings, type TestServices } from "@infra-agents/testing";

describe("API component integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let workflow: FakeWorkflowClient;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("creates sessions, persists initial events, and starts workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });

    const response = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        clientEventId: "client-create",
        model: "scripted-model",
        reasoningEffort: "xhigh",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = await response.json() as { id: string; temporalWorkflowId: string; model: string; metadata: Record<string, unknown> };
    expect(session.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(session.model).toBe("scripted-model");
    expect(session.metadata.reasoningEffort).toBe("xhigh");
    expect(workflow.started).toHaveLength(1);
    const events = await listSessionEvents(dbClient.db, session.id);
    expect(events.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed"]);
  });

  test("returns client model and reasoning config", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = await response.json() as { defaultModel: string; allowedReasoningEfforts: string[] };
    expect(payload.defaultModel).toBe("scripted-model");
    expect(payload.allowedReasoningEfforts).toContain("high");
  });

  test("rejects mixed GitHub App repository installations during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "bad repos",
        resources: [
          { kind: "repository", uri: "https://github.com/a/one.git", metadata: { ref: "main", github_installation_id: 1, github_repository_id: 11 } },
          { kind: "repository", uri: "https://github.com/b/two.git", metadata: { ref: "main", github_installation_id: 2, github_repository_id: 22 } },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("validates command state transitions and signals workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "state" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };

    const rejected = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "too soon" } }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.status).toBe(409);

    await setSessionStatus(dbClient.db, session.id, "idle", null);
    const accepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "now" }, clientEventId: "follow-up" }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(202);
    expect(workflow.userMessages).toHaveLength(1);

    const approvalRejected = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.approvalDecision", payload: { approvalId: "x", decision: "approve" } }),
      headers: { "content-type": "application/json" },
    });
    expect(approvalRejected.status).toBe(409);

    await setSessionStatus(dbClient.db, session.id, "requires_action", null);
    const approvalAccepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.approvalDecision", payload: { approvalId: "x", decision: "approve" } }),
      headers: { "content-type": "application/json" },
    });
    expect(approvalAccepted.status).toBe(202);
    expect(workflow.approvals).toHaveLength(1);

    await setSessionStatus(dbClient.db, session.id, "running", null);
    const interruptAccepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.interrupt", payload: { reason: "stop" } }),
      headers: { "content-type": "application/json" },
    });
    expect(interruptAccepted.status).toBe(202);
    expect(workflow.interrupts).toHaveLength(1);

    const malformed = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "" } }),
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  test("lists events and streams SSE replay plus live fanout", async () => {
    const bus = new MemoryEventBus();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus,
      workflowClient: new FakeWorkflowClient(),
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "stream" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };

    const listed = await app.request(`/v1/sessions/${session.id}/events?limit=10`);
    expect(listed.status).toBe(200);
    const initialEvents = await listed.json() as SessionEvent[];
    expect(initialEvents.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed"]);

    const replayAbort = new AbortController();
    const replay = await app.request(new Request(`http://test/v1/sessions/${session.id}/events/stream?after=0`, {
      signal: replayAbort.signal,
    }));
    expect(replay.status).toBe(200);
    expect((await readSseEvents(replay, 3, replayAbort)).map((event) => event.type)).toEqual(initialEvents.map((event) => event.type));

    const liveAbortA = new AbortController();
    const liveAbortB = new AbortController();
    const liveA = await app.request(new Request(`http://test/v1/sessions/${session.id}/events/stream?after=${initialEvents.at(-1)!.sequence}`, {
      signal: liveAbortA.signal,
    }));
    const liveB = await app.request(new Request(`http://test/v1/sessions/${session.id}/events/stream?after=${initialEvents.at(-1)!.sequence}`, {
      signal: liveAbortB.signal,
    }));
    const readA = readSseEvents(liveA, 1, liveAbortA);
    const readB = readSseEvents(liveB, 1, liveAbortB);
    const [appended] = await appendAndPublishEvents(dbClient.db, bus, session.id, [
      { type: "agent.message.delta", payload: { text: "live" } },
    ]);
    expect((await readA)[0]?.id).toBe(appended?.id);
    expect((await readB)[0]?.id).toBe(appended?.id);
  });

  test("reports missing GitHub App configuration", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/github/app");
    expect(response.status).toBe(200);
    const body = await response.json() as { configured: boolean; missing: string[] };
    expect(body.configured).toBe(false);
    expect(body.missing.length).toBeGreaterThan(0);
  });
});

async function readSseEvents(response: Response, count: number, abort: AbortController): Promise<SessionEvent[]> {
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SessionEvent[] = [];
  let buffer = "";
  try {
    while (events.length < count) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const parsed = parseSseBlock(block);
        if (!parsed?.data) {
          continue;
        }
        events.push(JSON.parse(parsed.data) as SessionEvent);
        if (events.length === count) {
          break;
        }
      }
    }
    return events;
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
}

class FakeWorkflowClient implements SessionWorkflowClient {
  started: unknown[] = [];
  userMessages: unknown[] = [];
  approvals: unknown[] = [];
  interrupts: unknown[] = [];

  async startSessionWorkflow(input: unknown): Promise<void> {
    this.started.push(input);
  }

  async signalUserMessage(input: unknown): Promise<void> {
    this.userMessages.push(input);
  }

  async signalApprovalDecision(input: unknown): Promise<void> {
    this.approvals.push(input);
  }

  async signalInterrupt(input: unknown): Promise<void> {
    this.interrupts.push(input);
  }
}
