import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  addDocumentToBase,
  createDocumentBase,
  DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
  deterministicEmbedding,
  type DocumentServices,
} from "../../packages/documents/src/index";
import type { ObjectStorage } from "../../packages/storage/src/index";
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  bootstrapWorkspace,
  completeFileUpload,
  applyCreditLedgerEntry,
  createTurn,
  createDb,
  createFileUpload,
  createScheduledTask,
  createSession,
  createSessionGoal,
  createWorkspaceEnvironment,
  encryptEnvironmentValue,
  enqueueSessionTurn,
  setWorkspaceEnvironmentVariable,
  finishTurn,
  getSession,
  getSessionGoal,
  getBillingBalance,
  getLatestRunState,
  listSessionTurns,
  listUsageEvents,
  listSessionEvents,
  listScheduledTaskRuns,
  recordUsageEvent,
  requireScheduledTask,
  saveRunState,
  setSessionStatus,
  sumUsageQuantity,
  updateScheduledTask,
} from "@opengeni/db";
import type { AccessGrant, ResourceRef, SandboxBackend, ScheduledTaskAgentConfig } from "@opengeni/contracts";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime, MaxTurnsExceededError, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivities } from "../../apps/worker/src/activities";
import { loadWorkspaceEnvironmentForRun, sandboxEnvironmentForRun } from "../../apps/worker/src/activities/environment";
import { ScriptedModel, functionCall, latestStatus, startTestMcpServer, startTestServices, testSettings, type TestServices } from "@opengeni/testing";

describe("worker activities integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
    bus = await createNatsEventBus(services.natsUrl);
  }, 180_000);

  afterAll(async () => {
    await bus?.close();
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("streams scripted SDK model deltas into persisted session events", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "hello from model", chunks: ["hello ", "from ", "model"] }]),
      }),
    });

    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-activity",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(latestStatus(events)).toBe("idle");
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    expect(await getLatestRunState(dbClient.db, grant.workspaceId, session.id)).not.toBeNull();
  });

  test("uses saved SDK history for follow-up turns", async () => {
    const model = new ScriptedModel([
      { outputText: "first answer", chunks: ["first ", "answer"] },
      { outputText: "second answer", chunks: ["second ", "answer"] },
    ]);
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "first question",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [firstTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "first question" } },
    ]);
    await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: firstTrigger!.id,
      workflowId: "workflow-followup",
    });
    const [secondTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "second question" } },
    ]);
    await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: secondTrigger!.id,
      workflowId: "workflow-followup",
    });

    expect(model.calls).toBe(2);
    const secondRequest = JSON.stringify(model.requests[1]?.input ?? {});
    expect(secondRequest).toContain("first question");
    expect(secondRequest).toContain("first answer");
    expect(secondRequest).toContain("second question");
  });

  test("adds per-turn file resource paths to model text", async () => {
    const grant = await testGrant(dbClient.db);
    const fileId = crypto.randomUUID();
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId,
      filename: "diagram.png",
      safeFilename: "diagram.png",
      contentType: "image/png",
      sizeBytes: 4,
      bucket: "opengeni-files",
      objectKey: `workspaces/${grant.workspaceId}/files/${fileId}/original/diagram.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "saw image", chunks: ["saw ", "image"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("data:image/png");
    expect(request).toContain("look at this");
    expect(request).toContain("Attached files are available in the sandbox");
    expect(request).toContain(`diagram.png (image/png, 4 bytes): /workspace/files/${fileId}/diagram.png`);
  });

  test("does not require object storage reads for attached file path context", async () => {
    const grant = await testGrant(dbClient.db);
    const fileId = crypto.randomUUID();
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId,
      filename: "large.png",
      safeFilename: "large.png",
      contentType: "image/png",
      sizeBytes: 10,
      bucket: "opengeni-files",
      objectKey: `workspaces/${grant.workspaceId}/files/${fileId}/original/large.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "noted", chunks: ["noted"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-oversized-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("direct model vision context");
    expect(request).toContain(`/workspace/files/${fileId}/large.png`);
  });

  test("marks session failed when scripted model throws", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "fail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "fail" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new Error("scripted failure") }]),
      }),
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-fail",
    })).resolves.toEqual({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("failed");
  });

  test("max turns exceeded idles the session instead of failing it", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "long task",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "long task" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new MaxTurnsExceededError("Max turns (40) exceeded") }]),
      }),
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-max-turns",
    })).resolves.toEqual({ status: "idle" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toEqual({ output: "", segmentLimit: "max_turns" });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 10);
    expect(turns.every((turn) => turn.status !== "failed")).toBe(true);
  });

  test("classifies provider rate limits as retryable turn failures", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "rate limit",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "rate limit" } },
    ]);
    const error = new Error("Too Many Requests");
    Object.assign(error, { status: 429 });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error }]),
      }),
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-rate-limit",
    })).resolves.toEqual({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
    });
  });

  test("records worker observability when setup fails before a turn starts", async () => {
    const grant = await testGrant(dbClient.db);
    const exported: Array<{ body: any }> = [];
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      observabilityOtlpEndpoint: "http://collector:4318",
    });
    const observability = createObservability(settings, {
      component: "worker",
      exporter: async (_url, body) => {
        exported.push({ body });
      },
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
      observability,
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: crypto.randomUUID(),
      triggerEventId: crypto.randomUUID(),
      workflowId: "workflow-missing-session",
    })).rejects.toThrow("Session not found");
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    const span = exported[0]!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("worker.run_agent_segment");
    expect(span.status.code).toBe(2);
    expect(observability.prometheusMetrics()).toContain('status="failed"');
  });

  test("does not publish turn failure before turn start when status update fails", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: "workflow-status-update-fails",
      triggerEventId: trigger!.id,
    });
    const failingDb = new Proxy(dbClient.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: (tx: typeof dbClient.db) => Promise<unknown>, ...args: unknown[]) => await (target.transaction as any)(async (tx: typeof dbClient.db) => {
            const failingTx = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "update") {
                  return () => {
                    throw new Error("status update failed");
                  };
                }
                const value = Reflect.get(txTarget, txProp, txReceiver);
                return typeof value === "function" ? value.bind(txTarget) : value;
              },
            }) as typeof dbClient.db;
            return await fn(failingTx);
          }, ...args);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof dbClient.db;
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: failingDb,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-status-update-fails",
      turnId,
    })).rejects.toThrow("status update failed");

    const eventTypes = (await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50)).map((event) => event.type);
    expect(eventTypes).not.toContain("turn.started");
    expect(eventTypes).not.toContain("turn.failed");
  });

  test("marks approval reruns running before resuming the agent", async () => {
    const workflowId = "workflow-approval-rerun";
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "needs approval",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [initialTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "needs approval" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: workflowId,
      triggerEventId: initialTrigger!.id,
    });
    await finishTurn(dbClient.db, grant.workspaceId, turnId, "requires_action");
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "saved-state",
      pendingApprovals: [{ id: "approval-1" }],
    });
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "requires_action", turnId);
    const [approvalTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.approvalDecision", payload: { approvalId: "approval-1", decision: "approve" } },
    ]);
    let observedDuringRun: { status?: string; activeTurnId?: string | null } | null = null;
    const runtime: OpenGeniRuntime = {
      configure: () => {},
      buildAgent: () => ({} as never),
      prepareTools: async () => ({ mcpServers: [], close: async () => {} }),
      prepareInput: async (_agent, input) => {
        expect(input.kind).toBe("approval");
        return { input: "approved" };
      },
      runStream: async () => {
        const stored = await getSession(dbClient.db, grant.workspaceId, session.id);
        observedDuringRun = {
          status: stored?.status,
          activeTurnId: stored?.activeTurnId,
        };
        return {
          toStream: () => (async function* () {})(),
          completed: Promise.resolve(),
          interruptions: [],
          state: { toString: () => "resumed-state" },
          finalOutput: "approved",
        } as never;
      },
      serializeApprovals: () => [],
    };
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime,
    });

    await expect(activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: approvalTrigger!.id,
      workflowId,
      turnId,
    })).resolves.toEqual({ status: "idle" });

    expect(observedDuringRun).toEqual({ status: "running", activeTurnId: turnId });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
  });

  test("sets Docker and Modal sandbox home defaults", async () => {
    const docker = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "docker" }), []);
    const modal = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "modal" }), []);
    const disabled = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "none" }), []);

    expect(docker.HOME).toBe("/workspace");
    expect(docker.AZURE_CONFIG_DIR).toBeUndefined();
    expect(modal.HOME).toBe("/workspace");
    expect(modal.AZURE_CONFIG_DIR).toBeUndefined();
    expect(disabled.HOME).toBeUndefined();
    expect(disabled.AZURE_CONFIG_DIR).toBeUndefined();
  });

  test("injects run-scoped GitHub App token and bot identity for repository resources", async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let tokenRequestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      tokenRequestBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ token: "installation-token" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const environment = await sandboxEnvironmentForRun(testSettings({
        githubAppId: "99",
        githubClientId: "client-id",
        githubClientSecret: "client-secret",
        githubAppSlug: "opengeni",
        githubAppPrivateKey: privateKeyPem,
      }), [{
        kind: "repository",
        uri: "https://github.com/cloudgeni-ai/opengeni.git",
        ref: "main",
        githubInstallationId: 123,
        githubRepositoryId: 456,
      }]);

      expect(tokenRequestBody).toEqual({ repository_ids: [456] });
      expect(environment.GH_TOKEN).toBe("installation-token");
      expect(environment.GITHUB_TOKEN).toBe("installation-token");
      expect(environment.GIT_ASKPASS).toBe("/usr/local/bin/opengeni-git-askpass");
      expect(environment.GIT_AUTHOR_NAME).toBe("opengeni[bot]");
      expect(environment.GIT_AUTHOR_EMAIL).toBe("99+opengeni[bot]@users.noreply.github.com");
      expect(environment.GIT_COMMITTER_NAME).toBe("opengeni[bot]");
      expect(environment.GIT_COMMITTER_EMAIL).toBe("99+opengeni[bot]@users.noreply.github.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runs repository clone hook for Modal repository-backed sessions before SDK sandbox use", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "read repo",
      resources: [{
        kind: "repository",
        uri: "https://github.com/Futhark-AS/aifilesearch.git",
        ref: "main",
      }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "modal",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "read repo" } },
    ]);
    const sandboxExecCalls: Array<Record<string, unknown>> = [];
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "ok", chunks: ["ok"] }]),
        sandboxClient: {
          backendId: "test-modal",
          create: async () => ({
            state: { manifest: { root: "/workspace", entries: {}, environment: {} } },
            execCommand: async (args: Record<string, unknown>) => {
              sandboxExecCalls.push(args);
              return { status: 0, output: "" };
            },
          }),
        },
      }),
    });

    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-modal-repo-clone",
    });

    expect(result.status).toBe("failed");
    expect(sandboxExecCalls).toHaveLength(1);
    expect(String(sandboxExecCalls[0]?.cmd)).toContain("clone_repository '/workspace/repos/Futhark-AS/aifilesearch'");
    expect(String(sandboxExecCalls[0]?.cmd)).toContain("git -C \"$tmp\" fetch --depth 1 --no-tags --filter=blob:none origin \"$ref\"");
    expect(String(sandboxExecCalls[0]?.cmd)).not.toContain("x-access-token");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "sandbox.operation.started")).toBe(true);
    expect(events.some((event) => event.type === "sandbox.operation.completed")).toBe(true);
    expect(JSON.stringify(events)).toContain("Filesystem sandbox sessions must provide createEditor");
  });

  test("attaches configured MCP tools and executes a prefixed tool call during a run", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          outputText: "used document search",
          chunks: ["used ", "document ", "search"],
        },
      ]);
      const grant = await testGrant(dbClient.db);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "search docs",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [{
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          }],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentSegment({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-mcp",
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
      expect(JSON.stringify(model.requests[0])).not.toContain("docs__fetch_document");
      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
      expect(events.some((event) => event.type === "agent.toolCall.created")).toBe(true);
      expect(events.some((event) => event.type === "agent.toolCall.output")).toBe(true);
      expect(latestStatus(events)).toBe("idle");
    } finally {
      mcp.close();
    }
  });

  test("records and debits model usage once per streamed provider response", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          id: "scripted-response-tool",
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          id: "scripted-response-final",
          outputText: "used document search",
          chunks: ["used ", "document ", "search"],
        },
      ]);
      const grant = await testGrant(dbClient.db);
      await applyCreditLedgerEntry(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        type: "manual_adjustment",
        amountMicros: 1_000_000,
        sourceType: "test",
        sourceId: "per-response-usage",
        idempotencyKey: `test-credit:${grant.workspaceId}:per-response-usage`,
      });
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "search docs",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          billingMode: "stripe",
          modelPricingJson: JSON.stringify({
            "scripted-model": {
              inputMicrosPerMillionTokens: 1_000_000,
              outputMicrosPerMillionTokens: 1_000_000,
            },
          }),
          mcpServers: [{
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          }],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentSegment({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-per-response-usage",
      });

      expect(result.status).toBe("idle");
      expect(model.calls).toBe(2);
      const usage = await listUsageEvents(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId, limit: 20 });
      const tokenEvents = usage.filter((event) => event.eventType === "model.tokens");
      expect(tokenEvents).toHaveLength(2);
      expect(tokenEvents.map((event) => event.sourceResourceId?.split(":").at(-1)).sort()).toEqual([
        "scripted-response-final",
        "scripted-response-tool",
      ]);
      expect(usage.filter((event) => event.eventType === "model.cost")).toHaveLength(2);
      const balance = await getBillingBalance(dbClient.db, grant.accountId);
      expect(balance.balanceMicros).toBeLessThan(1_000_000);
      expect(balance.balanceMicros).toBeGreaterThan(0);
    } finally {
      mcp.close();
    }
  });

  test("caps model usage debits at the prepaid balance", async () => {
    const grant = await testGrant(dbClient.db);
    await applyCreditLedgerEntry(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "manual_adjustment",
      amountMicros: 1,
      sourceType: "test",
      sourceId: "capped-model-debit",
      idempotencyKey: `test-credit:${grant.workspaceId}:capped-model-debit`,
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "expensive run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "expensive run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        billingMode: "stripe",
        modelPricingJson: JSON.stringify({
          "scripted-model": {
            inputMicrosPerMillionTokens: 1_000_000_000,
            outputMicrosPerMillionTokens: 1_000_000_000,
          },
        }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ id: "expensive-response", outputText: "expensive response", chunks: ["expensive response"] }]),
      }),
    });

    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-capped-model-debit",
    });

    expect(result.status).toBe("failed");
    const balance = await getBillingBalance(dbClient.db, grant.accountId);
    expect(balance.balanceMicros).toBe(0);
    const usage = await listUsageEvents(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId, limit: 20 });
    const cost = usage.find((event) => event.eventType === "model.cost" && event.sourceResourceId?.endsWith("expensive-response"));
    expect(cost?.quantity).toBeGreaterThan(1);
  });

  test("blocks async document embeddings when managed credits are empty", async () => {
    const grant = await testGrant(dbClient.db);
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "no-credit-doc.txt",
      safeFilename: "no-credit-doc.txt",
      contentType: "text/plain",
      sizeBytes: 24,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/no-credit-doc.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const file = await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const base = await createDocumentBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "No credit worker docs",
    });
    const document = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: file.id,
    });
    let embedderCalled = false;
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        billingMode: "stripe",
        modelPricingJson: JSON.stringify({
          "scripted-model": {
            inputMicrosPerMillionTokens: 1_000_000,
            outputMicrosPerMillionTokens: 1_000_000,
          },
        }),
      }),
      db: dbClient.db,
      bus,
      objectStorage: fakeObjectStorage("OpenGeni managed document credit test."),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, inputFile) => ({
            text: new TextDecoder().decode(bytes),
            metadata: { filename: inputFile.filename, contentType: inputFile.contentType },
          }),
        },
        chunker: {
          chunk: (parsed, inputFile) => [{
            text: parsed.text,
            metadata: { filename: inputFile.filename, chunkIndex: 0 },
          }],
        },
        embedder: {
          model: "test-embedder",
          dimensions: 3,
          embedMany: async () => {
            embedderCalled = true;
            throw new Error("embedder should not run without credits");
          },
          embedQuery: async () => [0, 0, 0],
        },
      } satisfies DocumentServices,
    });

    const indexed = await activities.indexDocument({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      documentId: document.id,
    });

    expect(indexed.status).toBe("failed");
    expect(indexed.error).toContain("insufficient OpenGeni credits");
    expect(embedderCalled).toBe(false);
    const usage = await listUsageEvents(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId, limit: 20 });
    expect(usage.some((event) => event.eventType === "document.indexed")).toBe(false);
  });

  test("serializes concurrent document indexing against monthly chunk caps", async () => {
    const grant = await testGrant(dbClient.db);
    const uploadOne = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "limited-doc-1.txt",
      safeFilename: "limited-doc-1.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/limited-doc-1.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const uploadTwo = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "limited-doc-2.txt",
      safeFilename: "limited-doc-2.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/limited-doc-2.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const fileOne = await completeFileUpload(dbClient.db, grant.workspaceId, uploadOne.uploadId);
    const fileTwo = await completeFileUpload(dbClient.db, grant.workspaceId, uploadTwo.uploadId);
    const base = await createDocumentBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Serialized limit docs",
    });
    const documentOne = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: fileOne.id,
    });
    const documentTwo = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: fileTwo.id,
    });
    let embedCalls = 0;
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxDocumentIndexedChunksPerWorkspace: 2 }),
      }),
      db: dbClient.db,
      bus,
      objectStorage: fakeObjectStorage("0123456789abcdef"),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, inputFile) => ({
            text: new TextDecoder().decode(bytes),
            metadata: { filename: inputFile.filename, contentType: inputFile.contentType },
          }),
        },
        chunker: {
          chunk: (parsed, inputFile) => [0, 1].map((index) => ({
            text: parsed.text.slice(index * 8, index * 8 + 8),
            metadata: { filename: inputFile.filename, chunkIndex: index },
          })),
        },
        embedder: {
          model: "test-embedder",
          dimensions: DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
          embedMany: async (chunks) => {
            embedCalls += 1;
            return chunks.map((chunk) => deterministicEmbedding(chunk, DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS));
          },
          embedQuery: async (query) => deterministicEmbedding(query, DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS),
        },
      } satisfies DocumentServices,
    });

    const results = await Promise.all([
      activities.indexDocument({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        documentId: documentOne.id,
      }),
      activities.indexDocument({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        documentId: documentTwo.id,
      }),
    ]);

    expect(results.map((document) => document.status).sort()).toEqual(["failed", "ready"]);
    expect(results.find((document) => document.status === "failed")?.error).toContain("monthly document indexing limit reached (2 chunks)");
    expect(embedCalls).toBe(1);
    const indexedChunks = await sumUsageQuantity(dbClient.db, {
      workspaceId: grant.workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });
    expect(indexedChunks).toBe(2);
  });

  test("allows the worker to run an already accepted turn at the exact monthly run cap", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "allowed first run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "allowed first run" } },
    ]);
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session",
      sourceResourceId: session.id,
      idempotencyKey: `test-agent-run-created:${session.id}`,
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "within cap", chunks: ["within ", "cap"] }]),
      }),
    });

    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-exact-run-cap",
    });

    expect(result.status).toBe("idle");
    expect(latestStatus(await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50))).toBe("idle");
  });

  test("uses MCP tools added by a follow-up turn", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          outputText: "used follow-up document search",
          chunks: ["used ", "follow-up ", "document ", "search"],
        },
      ]);
      const grant = await testGrant(dbClient.db);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "start",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendSessionEventsAndUpdateSession(dbClient.db, grant.workspaceId, session.id, [
        {
          type: "user.message",
          payload: {
            text: "search docs now",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        },
      ], {
        tools: [{ kind: "mcp", id: "docs" }],
      });
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [{
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          }],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentSegment({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-follow-up-mcp",
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
    } finally {
      mcp.close();
    }
  });

	  test("dispatches scheduled tasks into new sessions and run history", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-new-session",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "inspect nightly",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: { source: "test" },
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "docs", url: "http://127.0.0.1:1/mcp", name: "Docs" }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const result = await activities.dispatchScheduledTaskRun({ workspaceId: grant.workspaceId, taskId: task.id, triggerType: "scheduled" });

    expect(result.action).toBe("start");
    expect(result.workflowId).toBe(`session-${result.sessionId}`);
    const session = await getSession(dbClient.db, grant.workspaceId, result.sessionId);
    expect(session?.metadata).toMatchObject({ scheduledTaskId: task.id, source: "test" });
    expect(session?.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, result.sessionId, 0, 10);
    expect(events.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);
    expect(events.find((event) => event.type === "user.message")?.payload).toMatchObject({ text: "inspect nightly", scheduledTaskId: task.id });
	    const [run] = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
	    expect(run).toMatchObject({ status: "dispatched", sessionId: result.sessionId, triggerEventId: result.triggerEventId });
	  });

	  test("blocks scheduled task dispatch when the account monthly model cost cap is reached", async () => {
	    const grant = await testGrant(dbClient.db);
	    const task = await createOwnedScheduledTask(dbClient.db, grant, {
	      name: "scheduled-cost-cap",
	      status: "active",
	      schedule: { type: "interval", everySeconds: 3600 },
	      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
	      runMode: "new_session_per_run",
	      overlapPolicy: "allow_concurrent",
	      agentConfig: {
	        prompt: "inspect after cost cap",
	        resources: [],
	        tools: [],
	        metadata: {},
	      },
	      metadata: {},
	    });
	    await recordUsageEvent(dbClient.db, {
	      accountId: grant.accountId,
	      workspaceId: grant.workspaceId,
	      eventType: "model.cost",
	      quantity: 100,
	      unit: "micro_usd",
	      sourceResourceType: "test",
	      sourceResourceId: task.id,
	      idempotencyKey: `test:scheduled-cost-cap:${task.id}`,
	    });
	    const activities = createActivities({
	      settings: testSettings({
	        databaseUrl: services.databaseUrl,
	        natsUrl: services.natsUrl,
	        usageLimitsMode: "static",
	        staticUsageLimitsJson: JSON.stringify({ maxMonthlyCostMicrosPerAccount: 100 }),
	      }),
	      db: dbClient.db,
	      bus,
	      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "should not run" }]) }),
	    });

	    await expect(activities.dispatchScheduledTaskRun({
	      workspaceId: grant.workspaceId,
	      taskId: task.id,
	      triggerType: "scheduled",
	    })).rejects.toThrow("monthly model cost limit reached (100 micros)");
	    expect(await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id)).toHaveLength(0);
	  });

	  test("does not double count a manually reserved scheduled task run", async () => {
	    const grant = await testGrant(dbClient.db);
	    const task = await createOwnedScheduledTask(dbClient.db, grant, {
	      name: "scheduled-manual-reserved",
	      status: "active",
	      schedule: { type: "interval", everySeconds: 3600 },
	      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
	      runMode: "new_session_per_run",
	      overlapPolicy: "allow_concurrent",
	      agentConfig: {
	        prompt: "manual reserved",
	        resources: [],
	        tools: [],
	        metadata: {},
	      },
	      metadata: {},
	    });
	    const reservationKey = `test:manual-reserved:${task.id}`;
	    await recordUsageEvent(dbClient.db, {
	      accountId: grant.accountId,
	      workspaceId: grant.workspaceId,
	      eventType: "agent_run.created",
	      quantity: 1,
	      unit: "run",
	      sourceResourceType: "scheduled_task",
	      sourceResourceId: task.id,
	      idempotencyKey: reservationKey,
	    });
	    const activities = createActivities({
	      settings: testSettings({
	        databaseUrl: services.databaseUrl,
	        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
	      }),
	      db: dbClient.db,
	      bus,
	      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
	    });

	    await activities.dispatchScheduledTaskRun({
	      workspaceId: grant.workspaceId,
	      taskId: task.id,
	      triggerType: "manual",
	      agentRunUsageIdempotencyKey: reservationKey,
	    });
	    const used = await sumUsageQuantity(dbClient.db, {
	      accountId: grant.accountId,
	      workspaceId: grant.workspaceId,
	      eventType: "agent_run.created",
	      since: startOfUtcMonth(),
	    });
	    expect(used).toBe(1);
	  });

  test("does not record scheduled agent run usage when dispatch fails", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-failing-dispatch",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "this cannot dispatch",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const failingBus: EventBus = {
      publish: async () => {
        throw new Error("bus publish unavailable");
      },
      subscribe: async () => async () => undefined,
      close: async () => undefined,
    };
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
      }),
      db: dbClient.db,
      bus: failingBus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "should not run" }]) }),
    });

    await expect(activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    })).rejects.toThrow("bus publish unavailable");
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed" });
    const agentRuns = await sumUsageQuantity(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    const fired = await sumUsageQuantity(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    expect(agentRuns).toBe(0);
    expect(fired).toBe(1);
  });

	  test("dispatches reusable scheduled tasks by signaling the stored session", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-reusable",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "follow up",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "docs", url: "http://127.0.0.1:1/mcp", name: "Docs" }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const first = await activities.dispatchScheduledTaskRun({ workspaceId: grant.workspaceId, taskId: task.id, triggerType: "scheduled" });
    const stored = await requireScheduledTask(dbClient.db, grant.workspaceId, task.id);
    const second = await activities.dispatchScheduledTaskRun({ workspaceId: grant.workspaceId, taskId: task.id, triggerType: "manual" });

    expect(first.action).toBe("start");
    expect(second.action).toBe("signal");
    expect(second.sessionId).toBe(first.sessionId);
    expect(stored.reusableSessionId).toBe(first.sessionId);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, first.sessionId, 0, 10);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(2);
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "dispatched")).toBe(true);
  });

  test("loads and decrypts attached workspace environments for runs and fails closed otherwise", async () => {
    const grant = await testGrant(dbClient.db);
    const settings = testSettings({ databaseUrl: services.databaseUrl, environmentsEncryptionKey: workerEnvironmentsKey });
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, {
      API_TOKEN: "worker-secret-token-1234",
      DB_PASSWORD: "worker-secret-pass-5678",
    });

    expect(await loadWorkspaceEnvironmentForRun(dbClient.db, settings, grant.workspaceId, null)).toBeNull();
    const loaded = await loadWorkspaceEnvironmentForRun(dbClient.db, settings, grant.workspaceId, environment.id);
    expect(loaded).toMatchObject({ id: environment.id, name: environment.name });
    expect(loaded?.values).toEqual({
      API_TOKEN: "worker-secret-token-1234",
      DB_PASSWORD: "worker-secret-pass-5678",
    });

    await expect(loadWorkspaceEnvironmentForRun(
      dbClient.db,
      testSettings({ databaseUrl: services.databaseUrl }),
      grant.workspaceId,
      environment.id,
    )).rejects.toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
    await expect(loadWorkspaceEnvironmentForRun(dbClient.db, settings, grant.workspaceId, crypto.randomUUID()))
      .rejects.toThrow("workspace environment not found");
  });

  test("layers workspace environment values between deployment env and GitHub run auth", async () => {
    const settings = testSettings({
      sandboxBackend: "docker",
      sandboxEnvAllowlist: "WORKER_TEST_ALLOWLISTED",
      gitAuthorName: "Deployment Author",
      gitAuthorEmail: "author@example.test",
    });
    const previous = process.env.WORKER_TEST_ALLOWLISTED;
    process.env.WORKER_TEST_ALLOWLISTED = "deployment-value";
    try {
      const unattached = await sandboxEnvironmentForRun(settings, []);
      expect(unattached.WORKER_TEST_ALLOWLISTED).toBe("deployment-value");
      const environment = await sandboxEnvironmentForRun(settings, [], {
        WORKER_TEST_ALLOWLISTED: "workspace-override",
        WORKSPACE_ONLY_TOKEN: "workspace-only-value",
      });
      expect(environment.WORKER_TEST_ALLOWLISTED).toBe("workspace-override");
      expect(environment.WORKSPACE_ONLY_TOKEN).toBe("workspace-only-value");
      expect(environment.GIT_AUTHOR_NAME).toBe("Deployment Author");
      expect(environment.HOME).toBe("/workspace");
    } finally {
      if (previous === undefined) {
        delete process.env.WORKER_TEST_ALLOWLISTED;
      } else {
        process.env.WORKER_TEST_ALLOWLISTED = previous;
      }
    }
  });

  test("redacts attached environment values echoed by the agent into session events", async () => {
    const secret = "echoed-workspace-secret-987654";
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, { LEAKED_TOKEN: secret });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      environmentId: environment.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{
          outputText: `the token is ${secret} end`,
          chunks: ["the token is ", secret, " end"],
        }]),
      }),
    });
    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-environment-redaction",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted:LEAKED_TOKEN]");
    const completed = events.find((event) => event.type === "agent.message.completed");
    expect((completed?.payload as { text: string }).text).toBe("the token is [redacted:LEAKED_TOKEN] end");
  });

  test("fails attached runs closed when the worker has no encryption key", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, { REQUIRED_TOKEN: "required-secret-123456" });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      environmentId: environment.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "never reached" }]) }),
    });
    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-environment-missing-key",
    });
    expect(result.status).toBe("failed");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(JSON.stringify(failed?.payload)).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
    expect(JSON.stringify(failed?.payload)).not.toContain("required-secret-123456");
  });

  test("propagates scheduled task environment attachments into dispatched sessions", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, { TASK_TOKEN: "task-secret-123456" });
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "environment dispatch",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      environmentId: environment.id,
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const dispatched = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(dispatched.action).toBe("start");
    const session = await getSession(dbClient.db, grant.workspaceId, dispatched.sessionId);
    expect(session?.environmentId).toBe(environment.id);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, dispatched.sessionId, 0, 10);
    const createdEvent = events.find((event) => event.type === "session.created");
    expect(createdEvent?.payload).toMatchObject({ environmentId: environment.id, environmentName: environment.name });
    expect(JSON.stringify(events)).not.toContain("task-secret-123456");
  });

  test("fails reusable dispatch when the task attachment diverges from its session", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, { DIVERGED_TOKEN: "diverged-value-123456" });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "reusable",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "diverged reusable",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      environmentId: environment.id,
      metadata: {},
    });
    await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, { reusableSessionId: session.id });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    await expect(activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    })).rejects.toThrow("scheduled task environment attachment does not match its reusable session");
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
  });

  test("synthesizes billed goal continuation turns and auto-pauses on no progress", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "pursue the goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "service deployed and healthy",
      successCriteria: "probe returns 200",
      createdBy: "api",
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        goalNoProgressLimit: 1,
        mcpServers: [{ id: "opengeni", name: "OpenGeni", url: "http://127.0.0.1:65531/v1/workspaces/{workspaceId}/mcp", cacheToolsList: true }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const first = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(first.action).toBe("continue");

    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    const continuation = turns.find((turn) => turn.source === "goal");
    expect(continuation).toBeTruthy();
    expect(continuation!.status).toBe("queued");
    expect(continuation!.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(continuation!.prompt).toContain("[GOAL CONTINUATION 1/20]");
    expect(continuation!.prompt).toContain("service deployed and healthy");
    expect(continuation!.prompt).toContain("probe returns 200");
    // The first-party MCP server is forced onto continuation turns so the
    // goal_complete/goal_pause escape hatches stay reachable.
    expect(continuation!.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    expect(continuation!.metadata.autoContinuation).toBe(1);

    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const continuationEvent = events.find((event) => event.type === "goal.continuation");
    expect(continuationEvent).toBeTruthy();
    expect(continuation!.triggerEventId).toBe(continuationEvent!.id);
    expect(events.some((event) => event.type === "turn.queued" && event.turnId === continuation!.id)).toBe(true);
    const usage = await listUsageEvents(dbClient.db, { accountId: grant.accountId, workspaceId: grant.workspaceId });
    expect(usage.some((event) => event.eventType === "agent_run.created" && event.sourceResourceId === continuation!.id)).toBe(true);

    // While the continuation turn is queued the queue wins.
    expect((await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    })).action).toBe("queue");

    // The continuation finishes without tool calls; goalNoProgressLimit 1
    // pauses the goal on the next pass with a visible event.
    await finishTurn(dbClient.db, grant.workspaceId, continuation!.id, "completed");
    const second = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(second.action).toBe("paused");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("no_progress");
    const afterEvents = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvent = afterEvents.find((event) => event.type === "goal.paused");
    expect(pausedEvent).toBeTruthy();
    expect((pausedEvent!.payload as { reason?: string }).reason).toBe("no_progress");
  });

  test("pauses goals on exhausted budgets without consuming continuation budget", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "budget goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "objective beyond the budget",
      createdBy: "api",
    });
    const activities = createActivities({
      // Managed limits with a zero credit balance block new agent runs.
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl, usageLimitsMode: "managed" }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const result = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(result.action).toBe("paused");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("limits");
    expect(goal?.rationale).toBe("insufficient OpenGeni credits");
    // The limits pause happened before the counter bump: no budget consumed,
    // no continuation turn synthesized.
    expect(goal?.autoContinuations).toBe(0);
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, session.id)).toHaveLength(0);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvent = events.find((event) => event.type === "goal.paused");
    expect((pausedEvent?.payload as { reason?: string } | undefined)?.reason).toBe("limits");
  });

  test("user interrupts pause active goals even when no turn is active", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "interrupt me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "long objective",
      createdBy: "api",
    });
    const [interruptEvent] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.interrupt", payload: {} },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    // The interrupt landed after the turn cleared activeTurnId; the goal must
    // still pause so the loop does not auto-continue what the user stopped.
    await activities.interruptActiveTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: interruptEvent!.id,
      workflowId: `session-${session.id}`,
    });
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("user_interrupt");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvents = events.filter((event) => event.type === "goal.paused");
    expect(pausedEvents).toHaveLength(1);
    expect((pausedEvents[0]!.payload as { actor?: string }).actor).toBe("user");

    // Idempotent: a second interrupt pause emits no duplicate event.
    await activities.pauseGoalForInterrupt({ workspaceId: grant.workspaceId, sessionId: session.id });
    const after = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(after.filter((event) => event.type === "goal.paused")).toHaveLength(1);

    // And a paused goal declines continuation.
    expect((await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    })).action).toBe("none");
  });

  test("scheduled tasks with goals arm and re-arm session goals on dispatch", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "maintain staging",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "keep staging healthy",
        resources: [],
        tools: [],
        metadata: {},
        goal: { text: "staging healthy", successCriteria: "all probes green" },
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "opengeni", name: "OpenGeni", url: "http://127.0.0.1:65532/v1/workspaces/{workspaceId}/mcp", cacheToolsList: true }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const firstDispatch = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(firstDispatch.action).toBe("start");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(goal?.status).toBe("active");
    expect(goal?.createdBy).toBe("scheduled_task");
    expect(goal?.successCriteria).toBe("all probes green");
    const session = await getSession(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(session?.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, firstDispatch.sessionId, 0, 50);
    expect(events.map((event) => event.type).slice(0, 3)).toEqual(["session.created", "goal.set", "user.message"]);

    // The goal paused between fires; the next fire re-arms it.
    await activities.pauseGoalForInterrupt({ workspaceId: grant.workspaceId, sessionId: firstDispatch.sessionId });
    const secondDispatch = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(secondDispatch.action).toBe("signal");
    expect(secondDispatch.sessionId).toBe(firstDispatch.sessionId);
    const rearmed = await getSessionGoal(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(rearmed?.status).toBe("active");
    expect(rearmed?.autoContinuations).toBe(0);
    const rearmEvents = await listSessionEvents(dbClient.db, grant.workspaceId, firstDispatch.sessionId, 0, 100);
    const goalSetEvents = rearmEvents.filter((event) => event.type === "goal.set");
    expect(goalSetEvents).toHaveLength(2);
    expect((goalSetEvents[1]!.payload as { replaced?: boolean }).replaced).toBe(true);
  });

  test("runs goal continuation turns through the agent with saved context", async () => {
    const model = new ScriptedModel([
      { outputText: "initial work", chunks: ["initial ", "work"] },
      { outputText: "continued work", chunks: ["continued ", "work"] },
    ]);
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "start",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [userTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "start" } },
    ]);
    expect((await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: userTrigger!.id,
      workflowId: "workflow-goal-continuation",
    })).status).toBe("idle");

    const [goalTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "goal.continuation", payload: { text: "[GOAL CONTINUATION 1/20] keep going" } },
    ]);
    const turn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: goalTrigger!.id,
      temporalWorkflowId: "workflow-goal-continuation",
      source: "goal",
      prompt: "[GOAL CONTINUATION 1/20] keep going",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    const result = await activities.runAgentSegment({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: goalTrigger!.id,
      workflowId: "workflow-goal-continuation",
      turnId: turn.id,
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const completions = events.filter((event) => event.type === "turn.completed");
    expect(completions).toHaveLength(2);
    expect((completions[1]!.payload as { output?: string }).output).toBe("continued work");
    // The continuation reused the saved run state from the first turn.
    expect(JSON.stringify(model.requests[1])).toContain("initial work");
  });
});

type TestDb = ReturnType<typeof createDb>["db"];

const workerEnvironmentsKey = Buffer.alloc(32, 8).toString("base64");

async function seedWorkspaceEnvironment(db: TestDb, grant: AccessGrant, values: Record<string, string>): Promise<{ id: string; name: string }> {
  const key = new Uint8Array(Buffer.from(workerEnvironmentsKey, "base64"));
  const environment = await createWorkspaceEnvironment(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: `worker-env-${crypto.randomUUID()}`,
  });
  for (const [name, value] of Object.entries(values)) {
    await setWorkspaceEnvironmentVariable(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      environmentId: environment.id,
      name,
      valueEncrypted: encryptEnvironmentValue(key, value),
    });
  }
  return { id: environment.id, name: environment.name };
}


async function testGrant(db: TestDb): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:worker",
    accountExternalId: `account:${id}`,
    accountName: "Worker integration account",
    workspaceExternalSource: "test:worker",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "Worker integration workspace",
    subjectId: `test:worker:${id}`,
    subjectLabel: "Worker integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("Worker test did not create a workspace grant");
  }
  return grant;
}

async function createOwnedSession(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createSession>[1], "accountId" | "workspaceId">,
) {
  return await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

async function appendOwnedEvents(
  db: TestDb,
  grant: AccessGrant,
  sessionId: string,
  events: Parameters<typeof appendSessionEvents>[3],
) {
  return await appendSessionEvents(db, grant.workspaceId, sessionId, events);
}

async function createOwnedFileUpload(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createFileUpload>[1], "accountId" | "workspaceId">,
) {
  return await createFileUpload(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

async function createOwnedScheduledTask(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createScheduledTask>[1], "accountId" | "workspaceId">,
) {
  return await createScheduledTask(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

function fakeObjectStorage(body: string): ObjectStorage {
  return {
    bucket: "test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    createPutUrl: async () => ({ url: "https://storage.example.test/put", requiredHeaders: {}, expiresAt: new Date(Date.now() + 60_000) }),
    createGetUrl: async () => ({ url: "https://storage.example.test/get", expiresAt: new Date(Date.now() + 60_000) }),
    headFile: async () => ({ ContentLength: new TextEncoder().encode(body).byteLength, ContentType: "text/plain" }),
    getFileBytes: async () => new TextEncoder().encode(body),
  };
}

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
