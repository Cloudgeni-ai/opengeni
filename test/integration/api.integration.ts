import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, getScheduledTask, listSessionEvents, listScheduledTasks, listSessionTurns, requireSession, setSessionStatus } from "@infra-agents/db";
import { appendAndPublishEvents } from "@infra-agents/events";
import type { SessionEvent } from "@infra-agents/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { buildInfraAgentsMcpServer } from "../../apps/api/src/mcp/server";
import { MemoryEventBus, parseSseBlock, startTestServices, testSettings, type TestServices } from "@infra-agents/testing";
import { prepareAgentTools } from "@infra-agents/runtime";

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
    expect(workflow.wakeups).toHaveLength(1);
    const events = await listSessionEvents(dbClient.db, session.id);
    expect(events.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);
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

  test("queues model settings on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const created = await app.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        model: "scripted-model",
        reasoningEffort: "low",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = await created.json() as { id: string };
    await setSessionStatus(dbClient.db, session.id, "idle", null);

    const accepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        payload: {
          text: "use a stronger model",
          model: "gpt-5.5",
          reasoningEffort: "xhigh",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(accepted.status).toBe(202);
    const event = await accepted.json() as SessionEvent;
    expect(event.payload).toEqual({
      text: "use a stronger model",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });
    const turns = await listSessionTurns(dbClient.db, session.id);
    const turn = turns.find((item) => item.triggerEventId === event.id);
    expect(turn?.model).toBe("gpt-5.5");
    expect(turn?.reasoningEffort).toBe("xhigh");
  });

  test("queues concurrent follow-up user messages while merging session tools", async () => {
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

    expect(responses.filter((response) => response.status === 202)).toHaveLength(mcpServers.length);
    expect((await requireSession(dbClient.db, session.id)).tools).toHaveLength(mcpServers.length);
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

  test("creates and manages scheduled tasks", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const created = await app.request("/v1/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: "hourly",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = await created.json() as { id: string; temporalScheduleId: string };
    expect(task.temporalScheduleId).toBe(`scheduled-task-${task.id}`);
    expect(workflow.synced).toHaveLength(1);

    const paused = await app.request(`/v1/scheduled-tasks/${task.id}/pause`, { method: "POST" });
    expect(paused.status).toBe(200);
    expect(workflow.synced).toHaveLength(2);

    const triggered = await app.request(`/v1/scheduled-tasks/${task.id}/trigger`, { method: "POST" });
    expect(triggered.status).toBe(202);
    expect(workflow.triggers).toEqual([{ taskId: task.id }]);

    const listed = await app.request("/v1/scheduled-tasks");
    expect(listed.status).toBe(200);
    expect((await listed.json() as Array<{ id: string }>).some((item) => item.id === task.id)).toBe(true);
  });

  test("keeps scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `sync-fail-${crypto.randomUUID()}`;
    const failedCreate = await app.request("/v1/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(failedCreate.status).toBe(500);
    expect((await listScheduledTasks(dbClient.db)).some((task) => task.name === failedCreateName)).toBe(false);

    workflow.syncError = null;
    const created = await app.request("/v1/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: `rollback-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = await created.json() as { id: string };

    workflow.syncError = new Error("temporal unavailable");
    const failedPause = await app.request(`/v1/scheduled-tasks/${task.id}/pause`, { method: "POST" });
    expect(failedPause.status).toBe(500);
    expect((await getScheduledTask(dbClient.db, task.id))?.status).toBe("active");
  });

  test("keeps MCP scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const mcp = buildInfraAgentsMcpServer({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by scheduled task MCP tests");
      },
    });

    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `mcp-sync-fail-${crypto.randomUUID()}`;
    await expect(callMcpTool(mcp, "scheduled_tasks_create", {
      name: failedCreateName,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    })).rejects.toThrow("temporal unavailable");
    expect((await listScheduledTasks(dbClient.db)).some((task) => task.name === failedCreateName)).toBe(false);

    workflow.syncError = null;
    const task = await callMcpTool<{ id: string }>(mcp, "scheduled_tasks_create", {
      name: `mcp-rollback-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });

    workflow.syncError = new Error("temporal unavailable");
    await expect(callMcpTool(mcp, "scheduled_tasks_pause", { id: task.id })).rejects.toThrow("temporal unavailable");
    expect((await getScheduledTask(dbClient.db, task.id))?.status).toBe("active");
    await expect(callMcpTool(mcp, "scheduled_tasks_resume", { id: crypto.randomUUID() })).rejects.toThrow("Scheduled task not found");
  });

  test("returns 404 for missing scheduled task actions", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request(`/v1/scheduled-tasks/${crypto.randomUUID()}/pause`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("validates scheduled task semantic edge cases", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const blankName = await app.request("/v1/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: "   ",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(blankName.status).toBe(422);

    const invalidWindow = await app.request("/v1/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify({
        name: "bad-window",
        schedule: {
          type: "interval",
          everySeconds: 3600,
          startAt: "2026-05-08T12:00:00.000Z",
          endAt: "2026-05-08T11:00:00.000Z",
        },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidWindow.status).toBe(422);
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
    expect(rejected.status).toBe(202);

    await setSessionStatus(dbClient.db, session.id, "idle", null);
    const accepted = await app.request(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({ type: "user.message", payload: { text: "now" }, clientEventId: "follow-up" }),
      headers: { "content-type": "application/json" },
    });
    expect(accepted.status).toBe(202);
    expect(workflow.wakeups.length).toBeGreaterThanOrEqual(2);

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
    expect(initialEvents.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);

    const replayAbort = new AbortController();
    const replay = await app.request(new Request(`http://test/v1/sessions/${session.id}/events/stream?after=0`, {
      signal: replayAbort.signal,
    }));
    expect(replay.status).toBe(200);
    expect((await readSseEvents(replay, 4, replayAbort)).map((event) => event.type)).toEqual(initialEvents.map((event) => event.type));

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

  test("indexes uploaded files into document bases and searches them", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const uploadResponse = await app.request("/v1/files/uploads", {
      method: "POST",
      body: JSON.stringify({
        filename: "network-runbook.txt",
        contentType: "text/plain",
        sizeBytes: 67,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = await uploadResponse.json() as { fileId: string; uploadId: string; putUrl: string; requiredHeaders: Record<string, string> };
    const body = "Private endpoint failures are fixed by updating the network policy.";
    await fetch(upload.putUrl, { method: "PUT", body, headers: upload.requiredHeaders });
    expect((await app.request(`/v1/files/uploads/${upload.uploadId}/complete`, { method: "POST" })).status).toBe(200);

    const baseResponse = await app.request("/v1/document-bases", {
      method: "POST",
      body: JSON.stringify({ name: "Runbooks", description: "Operational docs" }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = await baseResponse.json() as { id: string; name: string };
    expect(base.name).toBe("Runbooks");

    const addResponse = await app.request(`/v1/document-bases/${base.id}/documents`, {
      method: "POST",
      body: JSON.stringify({ fileId: upload.fileId }),
      headers: { "content-type": "application/json" },
    });
    expect(addResponse.status).toBe(201);
    const document = await addResponse.json() as { id: string; status: string; chunkCount: number };
    expect(document.status).toBe("ready");
    expect(document.chunkCount).toBe(1);

    const listResponse = await app.request(`/v1/document-bases/${base.id}/documents`);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toHaveLength(1);

    const searchResponse = await app.request(`/v1/document-bases/${base.id}/search`, {
      method: "POST",
      body: JSON.stringify({ query: "network policy", limit: 3 }),
      headers: { "content-type": "application/json" },
    });
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json() as { results: Array<{ text: string; title: string }> };
    expect(search.results[0]?.text).toContain("network policy");
    expect(search.results[0]?.title).toBe("network-runbook.txt");
  });

  test("serves indexed documents through the built-in MCP endpoint", async () => {
    const port = 19_000 + Math.floor(Math.random() * 1_000);
    const settings = {
      ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      mcpServers: [{
        id: "docs",
        name: "Document Search",
        url: `http://127.0.0.1:${port}/v1/mcp/docs`,
        allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
        timeoutMs: undefined,
        cacheToolsList: false,
      }],
    };
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const uploadResponse = await app.request("/v1/files/uploads", {
        method: "POST",
        body: JSON.stringify({ filename: "mcp-runbook.txt", contentType: "text/plain", sizeBytes: 60 }),
        headers: { "content-type": "application/json" },
      });
      const upload = await uploadResponse.json() as { fileId: string; uploadId: string; putUrl: string; requiredHeaders: Record<string, string> };
      await fetch(upload.putUrl, { method: "PUT", body: "MCP document search returns private endpoint runbook chunks.", headers: upload.requiredHeaders });
      expect((await app.request(`/v1/files/uploads/${upload.uploadId}/complete`, { method: "POST" })).status).toBe(200);
      const baseResponse = await app.request("/v1/document-bases", {
        method: "POST",
        body: JSON.stringify({ name: "MCP Runbooks" }),
        headers: { "content-type": "application/json" },
      });
      const base = await baseResponse.json() as { id: string };
      expect((await app.request(`/v1/document-bases/${base.id}/documents`, {
        method: "POST",
        body: JSON.stringify({ fileId: upload.fileId }),
        headers: { "content-type": "application/json" },
      })).status).toBe(201);

      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "docs" }]);
      const tools = await prepared.mcpServers[0]!.listTools();
      expect(tools.map((tool) => tool.name)).toContain("docs__search_documents");
      const result = await prepared.mcpServers[0]!.callTool("docs__search_documents", { query: "private endpoint", baseIds: [base.id], limit: 3 });
      expect(JSON.stringify(result)).toContain("private endpoint runbook");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
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

async function callMcpTool<T = unknown>(server: unknown, name: string, args: Record<string, unknown>): Promise<T> {
  const tool = (server as { _registeredTools?: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  userMessages: unknown[] = [];
  wakeups: unknown[] = [];
  approvals: unknown[] = [];
  interrupts: unknown[] = [];
  synced: unknown[] = [];
  deletedSchedules: unknown[] = [];
  triggers: unknown[] = [];
  syncError: Error | null = null;

  async signalUserMessage(input: unknown): Promise<void> {
    this.userMessages.push(input);
  }

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
  }

  async signalApprovalDecision(input: unknown): Promise<void> {
    this.approvals.push(input);
  }

  async signalInterrupt(input: unknown): Promise<void> {
    this.interrupts.push(input);
  }

  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
    if (this.syncError) {
      throw this.syncError;
    }
  }

  async deleteScheduledTaskSchedule(input: unknown): Promise<void> {
    this.deletedSchedules.push(input);
  }

  async triggerScheduledTask(input: unknown): Promise<void> {
    this.triggers.push(input);
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
