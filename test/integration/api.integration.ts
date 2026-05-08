import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, listSessionEvents, requireSession, setSessionStatus } from "@infra-agents/db";
import { appendAndPublishEvents } from "@infra-agents/events";
import type { SessionEvent } from "@infra-agents/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { MemoryEventBus, parseSseBlock, startTestServices, testSettings, type TestServices } from "@infra-agents/testing";

describe("API component integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let workflow: FakeWorkflowClient;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false, objectStorage: true });
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

  test("rejects unknown MCP tool refs during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("persists valid MCP tool refs on sessions", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [{
          id: "docs",
          name: "Document Search",
          url: "http://127.0.0.1:8787/mcp",
          allowedTools: ["search_documents", "fetch_document"],
          cacheToolsList: false,
        }],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = await response.json() as { tools: unknown[] };
    expect(session.tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("adds MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [{
          id: "docs",
          name: "Document Search",
          url: "http://127.0.0.1:8787/mcp",
          allowedTools: ["search_documents"],
          cacheToolsList: false,
        }],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, session.id, "idle", null);

    const accepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "search docs", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(202);
    const event = await accepted.json() as SessionEvent;
    expect(event.payload).toEqual({ text: "search docs", tools: [{ kind: "mcp", id: "docs" }] });
    expect((await requireSession(dbClient.db, session.id)).tools).toEqual([{ kind: "mcp", id: "docs" }]);

    await setSessionStatus(dbClient.db, session.id, "idle", null);
    const duplicate = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "again", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(duplicate.status).toBe(202);
    expect((await requireSession(dbClient.db, session.id)).tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("serializes concurrent follow-up user messages before merging session tools", async () => {
    const mcpServers = Array.from({ length: 12 }, (_, index) => ({
      id: `docs-${index}`,
      name: `Docs ${index}`,
      url: `http://127.0.0.1:${8787 + index}/mcp`,
      allowedTools: ["search_documents"],
      cacheToolsList: false,
    }));
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, session.id, "idle", null);

    const responses = await Promise.all(mcpServers.map((server) => app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: `search ${server.id}`, tools: [{ kind: "mcp", id: server.id }] },
      }),
      headers: { "content-type": "application/json" },
    })));

    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(mcpServers.length - 1);
    expect((await requireSession(dbClient.db, session.id)).tools).toHaveLength(1);
  });

  test("rejects unknown MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, session.id, "idle", null);
    const rejected = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "search docs", tools: [{ kind: "mcp", id: "docs" }] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(rejected.status).toBe(422);
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
    const payload = await response.json() as { defaultModel: string; allowedReasoningEfforts: string[]; fileUploads: { enabled: boolean; maxSizeBytes: number } };
    expect(payload.defaultModel).toBe("scripted-model");
    expect(payload.allowedReasoningEfforts).toContain("high");
    expect(payload.fileUploads).toEqual({ enabled: false, maxSizeBytes: 5_000_000_000 });
  });

  test("reports file upload support when object storage is configured", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        objectStorageEndpoint: "http://127.0.0.1:9000",
        objectStorageAccessKeyId: "minioadmin",
        objectStorageSecretAccessKey: "minioadmin",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("/v1/config/client");
    expect(response.status).toBe(200);
    const payload = await response.json() as { fileUploads: { enabled: boolean; maxSizeBytes: number } };
    expect(payload.fileUploads).toEqual({ enabled: true, maxSizeBytes: 5_000_000_000 });
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
          { kind: "repository", uri: "https://github.com/a/one.git", ref: "main", githubInstallationId: 1, githubRepositoryId: 11 },
          { kind: "repository", uri: "https://github.com/b/two.git", ref: "main", githubInstallationId: 2, githubRepositoryId: 22 },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("supports direct-to-object-storage file uploads and file resources", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    const uploadResponse = await app.request("/v1/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        filename: "spec.txt",
        contentType: "text/plain",
        sizeBytes: 11,
        sha256: "test-sha",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(uploadResponse.status).toBe(201);
    const upload = await uploadResponse.json() as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
      maxSizeBytes: number;
    };
    expect(upload.maxSizeBytes).toBeGreaterThan(1_000_000_000);
    expect(upload.requiredHeaders).toMatchObject({
      "content-type": "text/plain",
    });

    const put = await fetch(upload.putUrl, {
      method: "PUT",
      body: "hello world",
      headers: upload.requiredHeaders,
    });
    expect(put.status).toBeGreaterThanOrEqual(200);
    expect(put.status).toBeLessThan(300);

    const completeResponse = await app.request(`/v1/files/uploads/${upload.uploadId}/complete`, {
      method: "POST",
    });
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as { file: { id: string; status: string; objectKey: string } };
    expect(completed.file.id).toBe(upload.fileId);
    expect(completed.file.status).toBe("ready");
    expect(completed.file.objectKey).toContain(`/original/spec.txt`);

    const metadataResponse = await app.request(`/v1/files/${upload.fileId}`);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    expect(metadata.status).toBe("ready");
    expect(metadata).not.toHaveProperty("url");

    const downloadResponse = await app.request(`/v1/files/${upload.fileId}/download-url`, { method: "POST" });
    expect(downloadResponse.status).toBe(200);
    const download = await downloadResponse.json() as { url: string };
    expect(download.url).toContain("X-Amz-Signature");

    const sessionResponse = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(sessionResponse.status).toBe(202);
    const session = await sessionResponse.json() as { id: string; resources: unknown[] };
    expect(session.resources).toEqual([{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }]);
    const initialEvents = await listSessionEvents(dbClient.db, session.id, 0, 10);
    expect(initialEvents.find((event) => event.type === "user.message")?.payload).toEqual({
      text: "use file",
      resources: [{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }],
    });

    const followUpSessionResponse = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ initialMessage: "start empty" }),
      headers: { "content-type": "application/json" },
    });
    const followUpSession = await followUpSessionResponse.json() as { id: string };
    await setSessionStatus(dbClient.db, followUpSession.id, "idle", null);
    const followUp = await app.request(`/v1/sessions/${followUpSession.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: {
          text: "use file now",
          resources: [{ kind: "file", fileId: upload.fileId }],
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(followUp.status).toBe(202);
    const followUpEvent = await followUp.json() as SessionEvent;
    expect(followUpEvent.payload).toEqual({
      text: "use file now",
      resources: [{ kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` }],
    });
    expect((await requireSession(dbClient.db, followUpSession.id)).resources).toEqual([
      { kind: "file", fileId: upload.fileId, mountPath: `files/${upload.fileId}` },
    ]);
  });

  test("rejects pending file resources during session create", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const uploadResponse = await app.request("/v1/files/uploads", {
      method: "POST",
      body: JSON.stringify({ filename: "pending.txt", contentType: "text/plain", sizeBytes: 7 }),
      headers: { "content-type": "application/json" },
    });
    const upload = await uploadResponse.json() as { fileId: string };
    const response = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use pending file",
        resources: [{ kind: "file", fileId: upload.fileId }],
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

function objectStorageSettings(databaseUrl: string, endpoint: string) {
  return testSettings({
    databaseUrl,
    objectStorageEndpoint: endpoint,
    objectStorageSandboxEndpoint: endpoint,
    objectStorageAccessKeyId: "minioadmin",
    objectStorageSecretAccessKey: "minioadmin",
  });
}
