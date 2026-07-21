import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  allAccountPermissions,
  allWorkspacePermissions,
  appendSessionEvents,
  applyCreditLedgerEntry,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  buildConnectionTokenResolver,
  claimSessionWorkForAttempt,
  isSessionCompactionRequested,
  createDb,
  createSession,
  createWorkspaceEnvironment,
  dbSql,
  decryptEnvironmentValue,
  enableCapabilityInstallation,
  encryptEnvironmentValue,
  getActiveSessionHistoryItems,
  getBillingBalance,
  getCapabilityInstallation,
  getKnowledgeMemory,
  hashMemoryText,
  MEMORY_VISIBLE_RECORD_CAP,
  getSession,
  getPackInstallation,
  getScheduledTask,
  getSessionGoal,
  getWorkspaceEnvironmentValuesForRun,
  listSessionEvents,
  listScheduledTasks,
  listOutstandingSessionSystemUpdates,
  listSessionTurns,
  listSessionMcpServersForRun,
  listUsageEvents,
  recordStripeWebhookEvent,
  recordUsageEvent,
  requireFile,
  requireSession,
  setSessionGoalStatus,
  sumUsageQuantity,
  updateScheduledTask,
  updateWorkspaceSettings,
  upsertCapabilityCatalogItem,
  withWorkspaceRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import { appendAndPublishEvents } from "@opengeni/events";
import { migrate } from "@opengeni/db/migrate";
import {
  signDelegatedAccessToken,
  type AccessContext,
  type Permission,
  type SessionEvent,
  type SessionStatus,
} from "@opengeni/contracts";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { buildOpenGeniMcpServer } from "../../apps/api/src/mcp/server";
import {
  settingsWithCodexCredential,
  settingsWithEnabledCapabilityMcpServers,
  settingsWithSessionMcpServersForRun,
} from "../../apps/worker/src/activities/capabilities";
import {
  MemoryEventBus,
  parseSseBlock,
  startTestMcpServer,
  startTestServices,
  testSettings,
  type TestServices,
} from "@opengeni/testing";
import { prepareAgentTools } from "@opengeni/runtime";
import { createSignedState, readSignedState } from "@opengeni/github";
import { buildTimeline } from "../../packages/react/src/timeline";
import {
  createDocumentServices,
  DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
  DEFAULT_DOCUMENT_EMBEDDING_MODEL,
  searchDocuments,
} from "../../packages/documents/src";
import { submitTestHumanPrompt } from "./helpers/session-control";

async function setSessionStatus(
  db: Database,
  workspaceId: string,
  sessionId: string,
  status: SessionStatus,
  activeTurnId: string | null = null,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(dbSql`
      update sessions
      set status = ${status}, active_turn_id = ${activeTurnId}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${sessionId}
    `);
  });
}

describe("API component integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let workflow: FakeWorkflowClient;

  beforeAll(async () => {
    services = await startTestServices({
      temporal: false,
      objectStorage: true,
    });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("configured browser principals pass the CORS preflight", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const response = await app.request("http://api.test/v1/config/client", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:24000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "content-type,x-opengeni-api-contract,x-opengeni-subject",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:24000");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "x-opengeni-subject",
    );
  });

  test("creates sessions, persists initial events, and starts workflow", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
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
    const session = (await response.json()) as {
      id: string;
      temporalWorkflowId: string;
      model: string;
      metadata: Record<string, unknown>;
    };
    expect(session.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(session.model).toBe("scripted-model");
    expect(session.metadata.reasoningEffort).toBe("xhigh");
    expect(workflow.wakeups).toHaveLength(1);
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    // The initial prompt is still waiting, so it exists only in the compact
    // prompt queue. Timeline projection begins it when the turn actually starts.
    expect(buildTimeline(events).map((item) => item.kind)).toEqual([]);

    const listed = await app.request(workspacePath(workspaceId, "/sessions?limit=10"));
    expect(listed.status).toBe(200);
    const sessions = (await listed.json()) as Array<{
      id: string;
      workspaceId: string;
      initialMessage: string;
    }>;
    expect(
      sessions.some(
        (item) =>
          item.id === session.id &&
          item.workspaceId === workspaceId &&
          item.initialMessage === "hello",
      ),
    ).toBe(true);
  });

  test("HTTP session creation returns typed depth denials and privilege-gates increases", async () => {
    await migrate(services.databaseUrl, undefined, { maxNestedAgentDepth: 0 });
    try {
      const wf = new FakeWorkflowClient();
      const delegationSecret = "test-nested-depth-http-secret";
      const grant = await bootstrapMcpGrant(dbClient.db);
      const app = createApp({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          productAccessMode: "configured",
          delegationSecret,
          maxNestedAgentDepth: 0,
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: wf,
      });
      const rootAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "test:nested-depth-http-root",
        permissions: ["workspace:read", "sessions:create", "sessions:read"],
      });
      const rootResponse = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: rootAuth },
        body: JSON.stringify({ initialMessage: "depth-zero root", model: "scripted-model" }),
      });
      expect(rootResponse.status).toBe(202);
      const root = (await rootResponse.json()) as {
        id: string;
        rootSessionId: string;
        nestedAgentDepth: number;
        effectiveMaxNestedAgentDepth: number;
        nestedAgentDepthPolicySource: string;
      };
      expect(root).toMatchObject({
        rootSessionId: root.id,
        nestedAgentDepth: 0,
        effectiveMaxNestedAgentDepth: 0,
        nestedAgentDepthPolicySource: "deployment",
      });

      const childAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "test:nested-depth-http-child",
        permissions: ["workspace:read", "sessions:create", "sessions:read"],
        sessionId: root.id,
      });
      const denialKey = `depth-http-denial-${crypto.randomUUID()}`;
      const denyChild = () =>
        app.request(workspacePath(grant.workspaceId, "/sessions"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: childAuth },
          body: JSON.stringify({
            initialMessage: "must not exist",
            model: "scripted-model",
            sandbox: "new",
            idempotencyKey: denialKey,
          }),
        });
      const usageBefore = await listUsageEvents(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        limit: 100,
      });
      const wakeupsBefore = wf.wakeups.length;
      const denied = await denyChild();
      const deniedRetry = await denyChild();
      expect(denied.status).toBe(409);
      expect(deniedRetry.status).toBe(409);
      const deniedBody = (await denied.json()) as NestedDepthErrorEnvelope;
      const deniedRetryBody = (await deniedRetry.json()) as NestedDepthErrorEnvelope;
      expect(deniedBody.error.code).toBe("nested_agent_depth_exceeded");
      expect(deniedBody.error.details.denial).toMatchObject({
        parentSessionId: root.id,
        rootSessionId: root.id,
        currentDepth: 0,
        attemptedDepth: 1,
        effectiveMaxNestedAgentDepth: 0,
        policySource: "deployment",
        idempotencyKey: denialKey,
      });
      expect(deniedRetryBody.error.details.denial.id).toBe(deniedBody.error.details.denial.id);
      expect(
        await deniedSessionArtifactCounts(
          dbClient.db,
          grant.workspaceId,
          deniedBody.error.details.denial.id,
        ),
      ).toEqual(emptyDeniedSessionArtifactCounts());
      expect(
        await listUsageEvents(dbClient.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          limit: 100,
        }),
      ).toHaveLength(usageBefore.length);
      expect(wf.wakeups).toHaveLength(wakeupsBefore);

      const forbidden = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: childAuth },
        body: JSON.stringify({
          initialMessage: "unprivileged increase",
          model: "scripted-model",
          sandbox: "new",
          maxNestedAgentDepth: 1,
        }),
      });
      expect(forbidden.status).toBe(403);
      const forbiddenBody = (await forbidden.json()) as NestedDepthErrorEnvelope;
      expect(forbiddenBody.error).toMatchObject({
        code: "nested_agent_depth_override_forbidden",
        details: {
          denial: {
            parentSessionId: root.id,
            currentDepth: 0,
            attemptedDepth: 1,
            effectiveMaxNestedAgentDepth: 0,
            requestedMaxNestedAgentDepthOverride: 1,
          },
        },
      });
      expect(
        await deniedSessionArtifactCounts(
          dbClient.db,
          grant.workspaceId,
          forbiddenBody.error.details.denial.id,
        ),
      ).toEqual(emptyDeniedSessionArtifactCounts());

      const adminChildAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "test:nested-depth-http-admin-child",
        permissions: ["workspace:admin"],
        sessionId: root.id,
      });
      const authorized = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: adminChildAuth },
        body: JSON.stringify({
          initialMessage: "authorized child",
          model: "scripted-model",
          sandbox: "new",
          maxNestedAgentDepth: 1,
        }),
      });
      expect(authorized.status).toBe(202);
      expect(await authorized.json()).toMatchObject({
        parentSessionId: root.id,
        rootSessionId: root.id,
        nestedAgentDepth: 1,
        maxNestedAgentDepthOverride: 1,
        effectiveMaxNestedAgentDepth: 1,
        nestedAgentDepthPolicySource: "session",
      });

      const workspaceAdminAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "test:nested-depth-workspace-admin",
        permissions: ["workspace:admin"],
      });
      const setWorkspacePolicy = await app.request(workspacePath(grant.workspaceId, "/settings"), {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: workspaceAdminAuth },
        body: JSON.stringify({ maxNestedAgentDepth: 2 }),
      });
      expect(setWorkspacePolicy.status).toBe(200);
      expect(await setWorkspacePolicy.json()).toMatchObject({
        settings: { maxNestedAgentDepth: 2 },
      });
      const workspacePolicyRoot = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: workspaceAdminAuth },
        body: JSON.stringify({ initialMessage: "workspace policy root", model: "scripted-model" }),
      });
      expect(workspacePolicyRoot.status).toBe(202);
      expect(await workspacePolicyRoot.json()).toMatchObject({
        nestedAgentDepth: 0,
        effectiveMaxNestedAgentDepth: 2,
        nestedAgentDepthPolicySource: "workspace",
      });

      const clearWorkspacePolicy = await app.request(
        workspacePath(grant.workspaceId, "/settings"),
        {
          method: "PATCH",
          headers: { "content-type": "application/json", authorization: workspaceAdminAuth },
          body: JSON.stringify({ maxNestedAgentDepth: null }),
        },
      );
      expect(clearWorkspacePolicy.status).toBe(200);
      const clearedWorkspace = (await clearWorkspacePolicy.json()) as {
        settings: Record<string, unknown>;
      };
      expect(clearedWorkspace.settings).not.toHaveProperty("maxNestedAgentDepth");
      const deploymentPolicyRoot = await app.request(
        workspacePath(grant.workspaceId, "/sessions"),
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: workspaceAdminAuth },
          body: JSON.stringify({
            initialMessage: "deployment policy root",
            model: "scripted-model",
          }),
        },
      );
      expect(deploymentPolicyRoot.status).toBe(202);
      expect(await deploymentPolicyRoot.json()).toMatchObject({
        nestedAgentDepth: 0,
        effectiveMaxNestedAgentDepth: 0,
        nestedAgentDepthPolicySource: "deployment",
      });
    } finally {
      await migrate(services.databaseUrl, undefined, {});
    }
  });

  test("MCP permits inclusive depth three and returns one idempotent depth-four denial", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by nested-depth MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const spawn = async (parentSessionId: string | null, label: string) => {
      const server = buildOpenGeniMcpServer(mcpDeps, {
        ...grant,
        ...(parentSessionId ? { metadata: { delegated: true, sessionId: parentSessionId } } : {}),
      });
      return await callMcpTool<{
        id: string;
        parentSessionId: string | null;
        rootSessionId: string;
        nestedAgentDepth: number;
        effectiveMaxNestedAgentDepth: number;
        nestedAgentDepthPolicySource: string;
      }>(server, "session_create", {
        initialMessage: label,
        model: "scripted-model",
        sandbox: "new",
      });
    };
    const root = await spawn(null, "mcp depth zero");
    const depthOne = await spawn(root.id, "mcp depth one");
    const depthTwo = await spawn(depthOne.id, "mcp depth two");
    const depthThree = await spawn(depthTwo.id, "mcp depth three");
    for (const [session, depth, parentSessionId] of [
      [root, 0, null],
      [depthOne, 1, root.id],
      [depthTwo, 2, depthOne.id],
      [depthThree, 3, depthTwo.id],
    ] as const) {
      expect(session).toMatchObject({
        parentSessionId,
        rootSessionId: root.id,
        nestedAgentDepth: depth,
        effectiveMaxNestedAgentDepth: 3,
        nestedAgentDepthPolicySource: "default",
      });
    }

    const depthFourServer = buildOpenGeniMcpServer(mcpDeps, {
      ...grant,
      metadata: { delegated: true, sessionId: depthThree.id },
    });
    const denialKey = `depth-mcp-denial-${crypto.randomUUID()}`;
    const usageBefore = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 100,
    });
    const wakeupsBefore = wf.wakeups.length;
    const first = await callMcpToolResult(depthFourServer, "session_create", {
      initialMessage: "mcp depth four must not exist",
      model: "scripted-model",
      sandbox: "new",
      idempotencyKey: denialKey,
    });
    const retry = await callMcpToolResult(depthFourServer, "session_create", {
      initialMessage: "mcp depth four retry",
      model: "scripted-model",
      sandbox: "new",
      idempotencyKey: denialKey,
    });
    expect(first.isError).toBe(true);
    expect(retry.isError).toBe(true);
    const firstBody = first.body as NestedDepthErrorEnvelope;
    const retryBody = retry.body as NestedDepthErrorEnvelope;
    expect(firstBody.error).toMatchObject({
      code: "nested_agent_depth_exceeded",
      details: {
        denial: {
          parentSessionId: depthThree.id,
          rootSessionId: root.id,
          currentDepth: 3,
          attemptedDepth: 4,
          effectiveMaxNestedAgentDepth: 3,
          policySource: "default",
          idempotencyKey: denialKey,
        },
      },
    });
    expect(retryBody.error.details.denial.id).toBe(firstBody.error.details.denial.id);
    expect(
      await deniedSessionArtifactCounts(
        dbClient.db,
        grant.workspaceId,
        firstBody.error.details.denial.id,
      ),
    ).toEqual(emptyDeniedSessionArtifactCounts());
    expect(
      await listUsageEvents(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        limit: 100,
      }),
    ).toHaveLength(usageBefore.length);
    expect(wf.wakeups).toHaveLength(wakeupsBefore);
  });

  test("scheduled-task agent depth policy persists and privilege-gates increases", async () => {
    const wf = new FakeWorkflowClient();
    const delegationSecret = "test-scheduled-agent-depth-secret";
    const grant = await bootstrapMcpGrant(dbClient.db);
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        maxNestedAgentDepth: 1,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const managerAuth = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: "test:scheduled-depth-manager",
      permissions: ["workspace:read", "scheduled_tasks:manage"],
    });
    const taskBody = (maxNestedAgentDepth: number) => ({
      name: `depth-${maxNestedAgentDepth}`,
      schedule: { type: "once", runAt: "2035-01-01T00:00:00.000Z", timeZone: "UTC" },
      agentConfig: {
        prompt: "test scheduled nested policy",
        maxNestedAgentDepth,
      },
    });

    const forbidden = await app.request(workspacePath(grant.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: managerAuth },
      body: JSON.stringify(taskBody(2)),
    });
    expect(forbidden.status).toBe(403);
    expect(await listScheduledTasks(dbClient.db, grant.workspaceId)).toHaveLength(0);

    const adminAuth = await signDelegatedBearer(delegationSecret, grant, {
      subjectId: "test:scheduled-depth-admin",
      permissions: ["workspace:admin"],
    });
    const createdResponse = await app.request(
      workspacePath(grant.workspaceId, "/scheduled-tasks"),
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: adminAuth },
        body: JSON.stringify(taskBody(5)),
      },
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      agentConfig: { maxNestedAgentDepth?: number };
    };
    expect(created.agentConfig.maxNestedAgentDepth).toBe(5);

    const loweredResponse = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${created.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: managerAuth },
        body: JSON.stringify({
          agentConfig: {
            prompt: "lowered scheduled nested policy",
            maxNestedAgentDepth: 1,
          },
        }),
      },
    );
    expect(loweredResponse.status).toBe(200);
    expect(await loweredResponse.json()).toMatchObject({
      agentConfig: { maxNestedAgentDepth: 1 },
    });

    const forbiddenUpdate = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${created.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: managerAuth },
        body: JSON.stringify({
          agentConfig: {
            prompt: "forbidden scheduled nested policy increase",
            maxNestedAgentDepth: 2,
          },
        }),
      },
    );
    expect(forbiddenUpdate.status).toBe(403);
    expect(
      (await getScheduledTask(dbClient.db, grant.workspaceId, created.id))?.agentConfig,
    ).toMatchObject({ maxNestedAgentDepth: 1 });
  });

  test("keeps array session lists stable while pin pages are idempotent and OCC-fenced", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const create = async (initialMessage: string) => {
      const response = await app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({ initialMessage, model: "scripted-model" }),
        headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(202);
      return (await response.json()) as {
        id: string;
        updatedAt: string;
        pinned: boolean;
        pinVersion: number;
      };
    };
    const pinnedTarget = await create("find pinned alpha");
    await create("ordinary beta");
    await create("ordinary gamma");

    const setPin = (body: { pinned: boolean; expectedVersion?: number }) =>
      app.request(workspacePath(workspaceId, `/sessions/${pinnedTarget.id}/pin`), {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });

    const first = await setPin({ pinned: true, expectedVersion: 0 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: pinnedTarget.id,
      pinned: true,
      pinVersion: 1,
      updatedAt: pinnedTarget.updatedAt,
    });
    // A timed-out client may retry the same desired state with its stale
    // version. That is idempotent success, not an OCC conflict.
    const retry = await setPin({ pinned: true, expectedVersion: 0 });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ pinned: true, pinVersion: 1 });

    const conflict = await setPin({ pinned: false, expectedVersion: 0 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      current: { pinned: true, pinVersion: 1 },
    });

    // The historical endpoint remains an array for same-major SDK clients, but
    // carries pin metadata and puts the caller's pins before ordinary rows.
    const legacy = await app.request(workspacePath(workspaceId, "/sessions?limit=1"));
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{
      id: string;
      pinned: boolean;
      pinVersion: number;
    }>;
    expect(Array.isArray(legacyRows)).toBe(true);
    expect(legacyRows[0]).toMatchObject({
      id: pinnedTarget.id,
      pinned: true,
      pinVersion: 1,
    });

    const firstPageResponse = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&limit=1"),
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      pinned: Array<{ id: string }>;
      sessions: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.pinned.map((row) => row.id)).toEqual([pinnedTarget.id]);
    expect(firstPage.sessions).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.sessions.map((row) => row.id)).not.toContain(pinnedTarget.id);

    const secondPageResponse = await app.request(
      workspacePath(
        workspaceId,
        `/sessions?view=page&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as typeof firstPage;
    expect(secondPage.pinned.map((row) => row.id)).toEqual([pinnedTarget.id]);
    expect(secondPage.sessions).toHaveLength(1);
    expect(secondPage.sessions[0]!.id).not.toBe(firstPage.sessions[0]!.id);
    expect(secondPage.sessions[0]!.id).not.toBe(pinnedTarget.id);

    const filtered = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&search=pinned%20alpha"),
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      pinned: [{ id: pinnedTarget.id }],
      sessions: [],
    });
    expect(
      (await app.request(workspacePath(workspaceId, "/sessions?view=page&cursor=not-a-cursor")))
        .status,
    ).toBe(400);

    const unpinned = await setPin({ pinned: false, expectedVersion: 1 });
    expect(unpinned.status).toBe(200);
    expect(await unpinned.json()).toMatchObject({
      id: pinnedTarget.id,
      pinned: false,
      pinnedAt: null,
      pinVersion: 2,
      updatedAt: pinnedTarget.updatedAt,
    });
    const afterUnpinResponse = await app.request(
      workspacePath(workspaceId, "/sessions?view=page&search=find%20pinned%20alpha"),
    );
    expect(afterUnpinResponse.status).toBe(200);
    expect(await afterUnpinResponse.json()).toMatchObject({
      pinned: [],
      sessions: [{ id: pinnedTarget.id, pinned: false, pinnedAt: null, pinVersion: 2 }],
    });

    const renamed = await app.request(workspacePath(workspaceId, `/sessions/${pinnedTarget.id}`), {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed before re-pin" }),
      headers: { "content-type": "application/json" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: pinnedTarget.id,
      title: "Renamed before re-pin",
      pinned: false,
      pinVersion: 2,
    });

    const repinned = await setPin({ pinned: true, expectedVersion: 2 });
    expect(repinned.status).toBe(200);
    expect(await repinned.json()).toMatchObject({
      pinned: true,
      pinVersion: 3,
    });
    const staleAfterRepin = await setPin({ pinned: false, expectedVersion: 0 });
    expect(staleAfterRepin.status).toBe(409);
    expect(await staleAfterRepin.json()).toMatchObject({
      current: { pinned: true, pinVersion: 3 },
    });

    const malformedSessionId = await app.request(
      workspacePath(workspaceId, "/sessions/not-a-uuid/pin"),
      {
        method: "PUT",
        body: JSON.stringify({ pinned: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformedSessionId.status).toBe(404);
    const malformedBody = await app.request(
      workspacePath(workspaceId, `/sessions/${pinnedTarget.id}/pin`),
      {
        method: "PUT",
        body: "{",
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformedBody.status).toBe(400);
  });

  test("create-with-instructions persists and reads back the field without leaking a timeline event", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "review this PR",
        model: "scripted-model",
        // Trailing whitespace exercises the contracts .trim() on the create path.
        instructions: "  You are the PR-reviewer persona: be terse and cite files.  ",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const created = (await response.json()) as {
      id: string;
      instructions: string | null;
    };
    // Create response exposes the (trimmed) instructions.
    expect(created.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // Read path (GET /sessions/:id) returns it too.
    const read = await app.request(workspacePath(workspaceId, `/sessions/${created.id}`));
    expect(read.status).toBe(200);
    const fetched = (await read.json()) as { instructions: string | null };
    expect(fetched.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // Persisted on the row (core/db roundtrip).
    const row = await requireSession(dbClient.db, workspaceId, created.id);
    expect(row.instructions).toBe("You are the PR-reviewer persona: be terse and cite files.");

    // It must NEVER surface as a timeline event, and no payload may carry it.
    const events = await listSessionEvents(dbClient.db, workspaceId, created.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    const serialized = JSON.stringify(events.map((event) => event.payload));
    expect(serialized).not.toContain("PR-reviewer persona");

    // Absent instructions read back as null (byte-identical to today).
    const plain = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no instructions",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plainSession = (await plain.json()) as {
      id: string;
      instructions: string | null;
    };
    expect(plainSession.instructions).toBeNull();
  });

  test("create idempotency key dedups double-submit and concurrent creates to one session over the API", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const create = (idempotencyKey: string) =>
      app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({
          initialMessage: "dedup me",
          idempotencyKey,
          model: "scripted-model",
        }),
        headers: { "content-type": "application/json" },
      });

    // Sequential double-submit: one session and one durable start state. The
    // retry re-delivers the same wake revision so an ambiguous first response
    // can repair a lost signal without duplicating the turn.
    const seqKey = `route-seq-${crypto.randomUUID()}`;
    const wakeupsBefore = workflow.wakeups.length;
    const firstResp = await create(seqKey);
    expect(firstResp.status).toBe(202);
    const firstSession = (await firstResp.json()) as { id: string };
    const secondResp = await create(seqKey);
    expect(secondResp.status).toBe(202);
    const secondSession = (await secondResp.json()) as { id: string };
    expect(secondSession.id).toBe(firstSession.id);
    expect(workflow.wakeups.length).toBe(wakeupsBefore + 2);
    const seqEvents = await listSessionEvents(dbClient.db, workspaceId, firstSession.id);
    expect(seqEvents.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    // Concurrent double-dispatch: N at once on the same key -> one session.
    const raceKey = `route-race-${crypto.randomUUID()}`;
    const wakeupsBeforeRace = workflow.wakeups.length;
    const responses = await Promise.all(Array.from({ length: 6 }, () => create(raceKey)));
    const raceSessions = await Promise.all(
      responses.map(async (resp) => {
        expect(resp.status).toBe(202);
        return ((await resp.json()) as { id: string }).id;
      }),
    );
    const uniqueRaceIds = new Set(raceSessions);
    expect(uniqueRaceIds.size).toBe(1);
    // Every retry may safely re-deliver the same revision; durable state still
    // contains exactly one session, first turn, and event batch.
    expect(workflow.wakeups.length).toBe(wakeupsBeforeRace + 6);
    const rows = await withWorkspaceCount(dbClient.db, workspaceId, raceKey);
    expect(rows).toBe(1);

    // Different key -> an independent session (back-compat).
    const otherResp = await create(`route-other-${crypto.randomUUID()}`);
    const otherSession = (await otherResp.json()) as { id: string };
    expect(otherSession.id).not.toBe(firstSession.id);

    // Absent key -> independent each time (the legacy path).
    const plain1 = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no key",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plain2 = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no key",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(((await plain1.json()) as { id: string }).id).not.toBe(
      ((await plain2.json()) as { id: string }).id,
    );
  });

  test("creates sessions with goals and manages the goal lifecycle over the API", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: "http://127.0.0.1:65530/v1/workspaces/{workspaceId}/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "take repo zero-to-one",
        model: "scripted-model",
        goal: {
          text: "repo deployed to staging",
          successCriteria: "health probe green",
          maxAutoContinuations: 7,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as {
      id: string;
      tools: Array<{ kind: string; id: string }>;
    };
    // Goal-bearing sessions force the first-party MCP server so goal tools are reachable.
    expect(session.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    const fetched = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`));
    expect(fetched.status).toBe(200);
    const goal = (await fetched.json()) as {
      id: string;
      status: string;
      text: string;
      maxAutoContinuations: number;
    };
    expect(goal.status).toBe("active");
    expect(goal.text).toBe("repo deployed to staging");
    expect(goal.maxAutoContinuations).toBe(7);

    const paused = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`), {
      method: "PATCH",
      body: JSON.stringify({ status: "paused", rationale: "operator hold" }),
      headers: { "content-type": "application/json" },
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { status: string }).status).toBe("paused");

    const wakeupsBeforeResume = workflow.wakeups.length;
    const resumed = await app.request(workspacePath(workspaceId, `/sessions/${session.id}/goal`), {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
      headers: { "content-type": "application/json" },
    });
    expect(resumed.status).toBe(200);
    const resumedGoal = (await resumed.json()) as {
      status: string;
      autoContinuations: number;
      pausedReason: string | null;
    };
    expect(resumedGoal.status).toBe("active");
    expect(resumedGoal.autoContinuations).toBe(0);
    expect(resumedGoal.pausedReason).toBeNull();
    // Resume wakes the workflow so an idle session re-enters the goal loop.
    expect(workflow.wakeups.length).toBe(wakeupsBeforeResume + 1);

    const lifecycleEvents = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(lifecycleEvents.some((event) => event.type === "goal.paused")).toBe(true);
    expect(lifecycleEvents.some((event) => event.type === "goal.resumed")).toBe(true);

    // Resuming an already-active goal is an invalid transition.
    const resumeActive = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/goal`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumeActive.status).toBe(409);

    // Completed goals reject operator transitions.
    await setSessionGoalStatus(dbClient.db, workspaceId, session.id, {
      status: "completed",
      evidence: "done",
    });
    const resumeCompleted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/goal`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumeCompleted.status).toBe(409);

    // Sessions without goals 404.
    const plain = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no goal here",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const plainSession = (await plain.json()) as { id: string };
    const missing = await app.request(
      workspacePath(workspaceId, `/sessions/${plainSession.id}/goal`),
    );
    expect(missing.status).toBe(404);
  });

  test("POST /context/clear clears context (audit-preserved), 409s mid-turn, and emits the event", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "clear me",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    const persisted = await requireSession(dbClient.db, workspaceId, session.id);
    await withWorkspaceRls(dbClient.db, workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: persisted.accountId,
          workspaceId,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "earlier work" },
        },
        {
          accountId: persisted.accountId,
          workspaceId,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
      ]);
    });

    // While a turn is in flight, clearing is refused (409) — mid-turn safety.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "running", null);
    const blocked = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(blocked.status).toBe(409);

    // An explicit confirm is required on the wire.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const noConfirm = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(noConfirm.status).toBe(400);

    const cleared = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/clear`),
      {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(cleared.status).toBe(204);

    // Active read collapses to the single neutral marker; the cleared event lands.
    const active = await getActiveSessionHistoryItems(dbClient.db, workspaceId, session.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.item).toMatchObject({ content: "[context cleared]" });
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    expect(events.some((event) => event.type === "session.context.cleared")).toBe(true);
  });

  test("POST /context/compact: records one provider-independent durable request", async () => {
    workflow = new FakeWorkflowClient();
    const workspaceId = await defaultWorkspaceId(
      createApp({
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
      }),
    );

    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "compact me",
        model: "scripted-model",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const pending = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/context/compact`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");
    expect(await isSessionCompactionRequested(dbClient.db, workspaceId, session.id)).toBe(true);
  });

  test("registers session-scoped goal MCP tools only for session-bound grants", async () => {
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const baseGrant = await bootstrapMcpGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: baseGrant.accountId,
      workspaceId: baseGrant.workspaceId,
      initialMessage: "goal tools",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by goal MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };

    // Without the worker-asserted sessionId claim, goal tools do not exist.
    const sessionlessMcp = buildOpenGeniMcpServer(mcpDeps, baseGrant);
    await expect(callMcpTool(sessionlessMcp, "goal_set", { text: "x" })).rejects.toThrow(
      "MCP tool not registered",
    );

    const grant = {
      ...baseGrant,
      metadata: { delegated: true, sessionId: session.id },
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    const setGoal = await callMcpTool<{
      id: string;
      status: string;
      version: number;
    }>(mcp, "goal_set", {
      text: "keep CI green",
      successCriteria: "main pipeline passes",
    });
    expect(setGoal.status).toBe("active");
    expect(setGoal.version).toBe(1);

    const updated = await callMcpTool<{ version: number; text: string }>(mcp, "goal_update", {
      text: "keep CI green on main",
      progressNote: "fixed two flaky tests",
    });
    expect(updated.version).toBe(2);

    const pausedGoal = await callMcpTool<{
      status: string;
      pausedReason: string;
    }>(mcp, "goal_pause", { rationale: "waiting on upstream fix" });
    expect(pausedGoal.status).toBe("paused");
    expect(pausedGoal.pausedReason).toBe("agent");

    const replacedGoal = await callMcpTool<{ status: string }>(mcp, "goal_set", {
      text: "upstream fixed; finish the job",
    });
    expect(replacedGoal.status).toBe("active");

    const completedGoal = await callMcpTool<{
      status: string;
      evidence: string;
    }>(mcp, "goal_complete", { evidence: "CI green for 3 consecutive runs" });
    expect(completedGoal.status).toBe("completed");
    expect(completedGoal.evidence).toBe("CI green for 3 consecutive runs");
    await expect(callMcpTool(mcp, "goal_pause", { rationale: "too late" })).rejects.toThrow(
      "completed",
    );
    await expect(callMcpTool(mcp, "goal_update", { text: "also too late" })).rejects.toThrow(
      "completed",
    );

    const events = await listSessionEvents(dbClient.db, baseGrant.workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "goal.set",
      "goal.updated",
      "goal.paused",
      "goal.set",
      "goal.completed",
    ]);
    expect((await getSessionGoal(dbClient.db, baseGrant.workspaceId, session.id))?.status).toBe(
      "completed",
    );
  });

  test("managed email/password auth bootstraps account access and workspace API keys", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const email = `managed-${crypto.randomUUID()}@example.com`;
    const password = "password1234";
    const signup = await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Managed User", email, password }),
    });
    expect(signup.status).toBeGreaterThanOrEqual(200);
    expect(signup.status).toBeLessThan(300);
    await dbClient.db.execute(
      dbSql`update auth_users set email_verified = true where email = ${email}`,
    );

    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    expect(signin.status).toBeGreaterThanOrEqual(200);
    expect(signin.status).toBeLessThan(300);
    const cookie = signin.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const access = await app.request("/v1/access/me", {
      headers: { cookie: cookie! },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.accountGrants[0]?.permissions).toContain("billing:manage");
    const workspaceId = context.defaultWorkspaceId!;
    const createdKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Managed test key",
        permissions: ["workspace:read", "sessions:create"],
      }),
    });
    expect(createdKey.status).toBe(201);
    const keyBody = (await createdKey.json()) as {
      token: string;
      apiKey: { workspaceId: string };
    };
    expect(keyBody.token).toStartWith("ogk_");
    expect(keyBody.apiKey.workspaceId).toBe(workspaceId);
    const keyWorkspaceList = await app.request("/v1/workspaces", {
      headers: { authorization: `Bearer ${keyBody.token}` },
    });
    expect(keyWorkspaceList.status).toBe(200);
    const keyWorkspaces = (await keyWorkspaceList.json()) as Array<{
      id: string;
    }>;
    expect(keyWorkspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);

    const billingKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Managed billing key",
        permissions: ["workspace:read", "billing:read"],
      }),
    });
    expect(billingKey.status).toBe(201);
    const billingKeyBody = (await billingKey.json()) as { token: string };
    const billing = await app.request(`/v1/billing?accountId=${context.defaultAccountId}`, {
      headers: { authorization: `Bearer ${billingKeyBody.token}` },
    });
    expect(billing.status).toBe(200);

    const workspaceOnlyKey = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({
        name: "Workspace only key",
        permissions: ["workspace:read"],
      }),
    });
    expect(workspaceOnlyKey.status).toBe(201);
    const workspaceOnlyKeyBody = (await workspaceOnlyKey.json()) as {
      token: string;
    };
    const deniedBilling = await app.request(`/v1/billing?accountId=${context.defaultAccountId}`, {
      headers: { authorization: `Bearer ${workspaceOnlyKeyBody.token}` },
    });
    expect(deniedBilling.status).toBe(403);

    const otherAccount = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-key-other",
      accountExternalId: crypto.randomUUID(),
      accountName: "Other managed key account",
      workspaceExternalSource: "test:managed-key-other",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Other managed key workspace",
      subjectId: `test:managed-key-other:${crypto.randomUUID()}`,
    });
    const deniedOtherAccountBilling = await app.request(
      `/v1/billing?accountId=${otherAccount.defaultAccountId}`,
      {
        headers: { authorization: `Bearer ${billingKeyBody.token}` },
      },
    );
    expect(deniedOtherAccountBilling.status).toBe(403);
  });

  test("managed session cookie still authenticates when an invalid bearer header is present", async () => {
    const userId = `managed-user-${crypto.randomUUID()}`;
    const email = `managed-cookie-${crypto.randomUUID()}@example.com`;
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      managedAuth: {
        api: {
          getSession: async () => ({
            user: { id: userId, email, name: "Managed Cookie User" },
          }),
        },
      } as any,
    });

    const access = await app.request("/v1/access/me", {
      headers: {
        authorization: "Bearer not-a-valid-opengeni-token",
        cookie: "better-auth.session_token=test",
      },
    });
    expect(access.status).toBe(200);
    const context = (await access.json()) as AccessContext;
    expect(context.mode).toBe("managed");
    expect(context.subjectId).toBe(`user:${userId}`);
    expect(context.defaultWorkspaceId).toBeTruthy();
  });

  test("managed credit gate blocks costly writes and exposes recorded usage", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed credit test",
      workspaceExternalSource: "test:managed-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed credit workspace",
      subjectId: "test:managed-credit",
    });
    const grant = context.workspaceGrants[0]!;
    const workspaceId = grant.workspaceId;
    const accountId = grant.accountId;
    const token = await signDelegatedAccessToken("test-delegation-secret", {
      accountId,
      workspaceId,
      subjectId: grant.subjectId,
      permissions: [...grant.permissions, "billing:read"],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked until credits exist" }),
    });
    expect(blocked.status).toBe(402);

    await applyCreditLedgerEntry(dbClient.db, {
      accountId,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: "managed-credit-gate",
      idempotencyKey: `test-credit:${accountId}`,
    });

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed with credits" }),
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as { id: string };

    const usage = await app.request(
      `/v1/billing/usage?accountId=${accountId}&workspaceId=${workspaceId}`,
      { headers: authHeaders },
    );
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as {
      usage: Array<{ eventType: string; sourceResourceId: string }>;
    };
    expect(usageBody.usage).toContainEqual(
      expect.objectContaining({
        eventType: "agent_run.created",
        sourceResourceId: session.id,
      }),
    );
  });

  test("zero-credit attachment staging survives tenant checks, duplicate finalize, and a rejected turn", async () => {
    const delegationSecret = "test-zero-credit-file-staging-secret";
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const owner = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:zero-credit-file-owner",
      accountExternalId: crypto.randomUUID(),
      accountName: "Zero credit file owner",
      workspaceExternalSource: "test:zero-credit-file-owner",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Zero credit file workspace",
      subjectId: `test:zero-credit-file-owner:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const otherTenant = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:zero-credit-file-other",
      accountExternalId: crypto.randomUUID(),
      accountName: "Other file account",
      workspaceExternalSource: "test:zero-credit-file-other",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Other file workspace",
      subjectId: `test:zero-credit-file-other:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const ownerWorkspaceId = owner.defaultWorkspaceId!;
    const otherWorkspaceId = otherTenant.defaultWorkspaceId!;
    const ownerHeaders = {
      authorization: `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: owner.defaultAccountId!,
        workspaceId: ownerWorkspaceId,
        subjectId: owner.subjectId,
        permissions: [...allAccountPermissions, ...allWorkspacePermissions],
        exp: Math.floor(Date.now() / 1000) + 60,
      })}`,
    };
    const otherHeaders = {
      authorization: `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: otherTenant.defaultAccountId!,
        workspaceId: otherWorkspaceId,
        subjectId: otherTenant.subjectId,
        permissions: [...allAccountPermissions, ...allWorkspacePermissions],
        exp: Math.floor(Date.now() / 1000) + 60,
      })}`,
    };
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // Storage staging is not an inference purchase: no credit entry exists for
    // this account, but prepare must issue a scoped signed PUT.
    const begin = await app.request(workspacePath(ownerWorkspaceId, "/files/uploads"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        filename: "a very long screenshot name with spaces and _ punctuation.png",
        contentType: "image/png",
        sizeBytes: image.byteLength,
      }),
    });
    expect(begin.status).toBe(201);
    const upload = (await begin.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };

    // The upload id and asset are invisible outside their RLS workspace.
    const wrongTenantComplete = await app.request(
      workspacePath(otherWorkspaceId, `/files/uploads/${upload.uploadId}/complete`),
      { method: "POST", headers: otherHeaders },
    );
    expect(wrongTenantComplete.status).toBe(404);
    const wrongTenantRead = await app.request(
      workspacePath(otherWorkspaceId, `/files/${upload.fileId}`),
      { headers: otherHeaders },
    );
    expect(wrongTenantRead.status).toBe(404);

    const put = await fetch(upload.putUrl, {
      method: "PUT",
      body: image,
      headers: upload.requiredHeaders,
    });
    expect(put.ok).toBe(true);

    // Two tabs (or a lost response retry) must converge on the one ready asset.
    const complete = () =>
      app.request(workspacePath(ownerWorkspaceId, `/files/uploads/${upload.uploadId}/complete`), {
        method: "POST",
        headers: ownerHeaders,
      });
    const [firstComplete, secondComplete] = await Promise.all([complete(), complete()]);
    expect(firstComplete.status).toBe(200);
    expect(secondComplete.status).toBe(200);
    const firstFile = ((await firstComplete.json()) as { file: { id: string; status: string } })
      .file;
    const secondFile = ((await secondComplete.json()) as { file: { id: string; status: string } })
      .file;
    expect(firstFile).toMatchObject({ id: upload.fileId, status: "ready" });
    expect(secondFile).toEqual(firstFile);

    // A later model-turn admission still fails at zero balance, but cannot
    // delete or orphan the already-finalized attachment reference.
    const rejectedTurn = await app.request(workspacePath(ownerWorkspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        initialMessage: "inspect this screenshot",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
    });
    expect(rejectedTurn.status).toBe(402);
    expect(await rejectedTurn.text()).toContain("insufficient OpenGeni credits");
    const preserved = await app.request(
      workspacePath(ownerWorkspaceId, `/files/${upload.fileId}`),
      {
        headers: ownerHeaders,
      },
    );
    expect(preserved.status).toBe(200);
    expect((await preserved.json()) as { status: string }).toMatchObject({
      status: "ready",
    });

    // Retrying after funds arrive attaches the same durable file rather than
    // creating another object or requiring a re-upload.
    await applyCreditLedgerEntry(dbClient.db, {
      accountId: owner.defaultAccountId!,
      type: "credit_topup",
      amountMicros: 1_000_000,
      sourceType: "test",
      sourceId: "zero-credit-file-retry",
      idempotencyKey: `test:zero-credit-file-retry:${owner.defaultAccountId!}`,
    });
    const retriedTurn = await app.request(workspacePath(ownerWorkspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...ownerHeaders },
      body: JSON.stringify({
        initialMessage: "inspect this screenshot",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
    });
    expect(retriedTurn.status).toBe(202);
    expect((await retriedTurn.json()) as { resources: unknown[] }).toMatchObject({
      resources: [{ kind: "file", fileId: upload.fileId }],
    });
  });

  test("managed credit gate blocks document indexing before enqueueing work", async () => {
    const delegationSecret = "test-managed-document-credit-secret";
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        productAccessMode: "managed",
        billingMode: "stripe",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentIndexer: {
        indexDocument: async () => {
          throw new Error("document indexer should not run without credits");
        },
      },
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-document-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed document credit test",
      workspaceExternalSource: "test:managed-document-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed document credit workspace",
      subjectId: `test:managed-document-credit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { authorization: `Bearer ${token}` };
    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "No credit docs" }),
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string };

    const blocked = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ fileId: crypto.randomUUID() }),
      },
    );
    expect(blocked.status).toBe(402);
    expect(await blocked.text()).toContain("insufficient OpenGeni credits");
  });

  test("managed credit gate allows schedule creation but blocks manual trigger without credits", async () => {
    const delegationSecret = "test-managed-schedule-credit-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        usageLimitsMode: "managed",
        delegationSecret,
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:managed-schedule-credit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Managed schedule credit test",
      workspaceExternalSource: "test:managed-schedule-credit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Managed schedule credit workspace",
      subjectId: `test:managed-schedule-credit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: access.defaultAccountId!,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const headers = { authorization: `Bearer ${token}` };

    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        name: "runs later",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const triggered = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      {
        method: "POST",
        headers,
      },
    );
    expect(triggered.status).toBe(402);
    expect(await triggered.text()).toContain("insufficient OpenGeni credits");
  });

  test("static usage limits enforce operator caps without Better Auth or Stripe", async () => {
    const delegationSecret = "test-static-usage-limits-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxWorkspacesPerAccount: 1,
          maxApiKeysPerWorkspace: 1,
          maxMonthlyAgentRunsPerWorkspace: 1,
        }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-usage-limits",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static limits test",
      workspaceExternalSource: "test:static-usage-limits",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static limits workspace",
      subjectId: `test:static-usage-limits:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const authHeaders = { authorization: `Bearer ${token}` };

    expect((await app.request("/v1/access/me")).status).toBe(401);
    expect(
      (
        await app.request("/v1/access/me", {
          headers: { authorization: "Bearer invalid-token" },
        })
      ).status,
    ).toBe(401);

    const extraWorkspace = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ accountId, name: "extra workspace" }),
    });
    expect(extraWorkspace.status).toBe(429);

    const keyOne = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        name: "first key",
        permissions: ["workspace:read"],
      }),
    });
    expect(keyOne.status).toBe(201);
    const keyTwo = await app.request(workspacePath(workspaceId, "/api-keys"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        name: "second key",
        permissions: ["workspace:read"],
      }),
    });
    expect(keyTwo.status).toBe(429);

    const runOne = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "allowed first run" }),
    });
    expect(runOne.status).toBe(202);
    const runTwo = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ initialMessage: "blocked second run" }),
    });
    expect(runTwo.status).toBe(429);
  });

  test("static monthly cost cap blocks costly actions once reached", async () => {
    const delegationSecret = "test-static-cost-limit-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxMonthlyCostMicrosPerAccount: 100,
        }),
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const access = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:static-cost-limit",
      accountExternalId: crypto.randomUUID(),
      accountName: "Static cost limit test",
      workspaceExternalSource: "test:static-cost-limit",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Static cost limit workspace",
      subjectId: `test:static-cost-limit:${crypto.randomUUID()}`,
      accountPermissions: allAccountPermissions,
      workspacePermissions: allWorkspacePermissions,
    });
    const workspaceId = access.defaultWorkspaceId!;
    const accountId = access.defaultAccountId!;
    await recordUsageEvent(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "model.cost",
      quantity: 100,
      unit: "usd_micros",
      sourceResourceType: "test",
      sourceResourceId: "static-cost-limit",
      idempotencyKey: `test:model.cost:${accountId}:static-cost-limit`,
    });
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId: access.subjectId,
      permissions: [...allAccountPermissions, ...allWorkspacePermissions],
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const blocked = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ initialMessage: "blocked by cost cap" }),
    });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("monthly model cost limit reached");
  });

  test("Stripe webhooks apply checkout, refund, and dispute ledger entries idempotently", async () => {
    const webhookSecret = "whsec_test_webhook_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook test",
      workspaceExternalSource: "test:stripe-webhook",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook workspace",
      subjectId: "test:stripe-webhook",
    });
    const accountId = context.defaultAccountId!;
    const metadata = {
      opengeni_account_id: accountId,
      opengeni_package_id: "topup_25",
      opengeni_credit_micros: "25000000",
      opengeni_credit_idempotency_key: `stripe:test:checkout:${accountId}`,
    };

    const checkout = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          customer_email: "billing@example.com",
          customer_details: { email: "billing@example.com" },
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (checkout.status !== 200) {
      throw new Error(`checkout webhook failed: ${checkout.status} ${await checkout.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    await checkout.json();
    const duplicate = await postStripeEvent(app, webhookSecret, {
      id: `evt_checkout_duplicate_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_duplicate_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (duplicate.status !== 200) {
      throw new Error(
        `duplicate checkout webhook failed: ${duplicate.status} ${await duplicate.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const refund = await postStripeEvent(app, webhookSecret, {
      id: `evt_refund_${crypto.randomUUID()}`,
      object: "event",
      type: "refund.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "re_test_123",
          object: "refund",
          amount: 500,
          currency: "usd",
          status: "succeeded",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (refund.status !== 200) {
      throw new Error(`refund webhook failed: ${refund.status} ${await refund.text()}`);
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const releaseWithoutHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_without_hold_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.funds_reinstated",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_without_hold",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_without_hold",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (releaseWithoutHold.status !== 200) {
      throw new Error(
        `dispute release without hold webhook failed: ${releaseWithoutHold.status} ${await releaseWithoutHold.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);

    const disputeHold = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.created",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "needs_response",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeHold.status !== 200) {
      throw new Error(
        `dispute hold webhook failed: ${disputeHold.status} ${await disputeHold.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(10_000_000);

    const disputeRelease = await postStripeEvent(app, webhookSecret, {
      id: `evt_dispute_release_${crypto.randomUUID()}`,
      object: "event",
      type: "charge.dispute.closed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "dp_test_123",
          object: "dispute",
          amount: 1000,
          currency: "usd",
          status: "won",
          charge: "ch_test_123",
          payment_intent: "pi_test_123",
          metadata,
        },
      },
    });
    if (disputeRelease.status !== 200) {
      throw new Error(
        `dispute release webhook failed: ${disputeRelease.status} ${await disputeRelease.text()}`,
      );
    }
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(20_000_000);
  });

  test("Stripe webhook retry processes stored events that were not marked processed", async () => {
    const webhookSecret = "whsec_test_webhook_retry_secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        billingMode: "stripe",
        betterAuthSecret: "test-better-auth-secret-32-bytes",
        publicBaseUrl: "http://127.0.0.1:3000",
        stripeSecretKey: "sk_test_fake",
        stripeWebhookSecret: webhookSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const context = await bootstrapWorkspace(dbClient.db, {
      accountExternalSource: "test:stripe-webhook-retry",
      accountExternalId: crypto.randomUUID(),
      accountName: "Stripe webhook retry test",
      workspaceExternalSource: "test:stripe-webhook-retry",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Stripe webhook retry workspace",
      subjectId: "test:stripe-webhook-retry",
    });
    const accountId = context.defaultAccountId!;
    const event = {
      id: `evt_checkout_retry_${crypto.randomUUID()}`,
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `cs_test_retry_${crypto.randomUUID()}`,
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_retry",
          customer_email: "retry@example.com",
          customer_details: { email: "retry@example.com" },
          payment_intent: "pi_test_retry",
          metadata: {
            opengeni_account_id: accountId,
            opengeni_package_id: "topup_25",
            opengeni_credit_micros: "25000000",
            opengeni_credit_idempotency_key: `stripe:test:checkout-retry:${accountId}`,
          },
        },
      },
    };
    await recordStripeWebhookEvent(dbClient.db, {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      payload: event,
    });

    const retry = await postStripeEvent(app, webhookSecret, event);
    if (retry.status !== 200) {
      throw new Error(`retry checkout webhook failed: ${retry.status} ${await retry.text()}`);
    }
    expect(await retry.json()).toEqual({ received: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);

    const duplicate = await postStripeEvent(app, webhookSecret, event);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    expect((await getBillingBalance(dbClient.db, accountId)).balanceMicros).toBe(25_000_000);
  });

  test("rejects unknown MCP tool refs during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
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
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: "http://127.0.0.1:8787/mcp",
            allowedTools: ["search_documents", "fetch_document"],
            cacheToolsList: false,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "search docs",
        tools: [{ kind: "mcp", id: "docs" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(202);
    const session = (await response.json()) as { tools: unknown[] };
    expect(session.tools).toEqual([{ kind: "mcp", id: "docs" }]);
  });

  test("adds MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        mcpServers: [
          {
            id: "docs",
            name: "Document Search",
            url: "http://127.0.0.1:8787/mcp",
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          },
        ],
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "search docs",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(accepted.status).toBe(202);
    const event = (await accepted.json()) as SessionEvent;
    expect(event.payload).toEqual({
      text: "search docs",
      tools: [{ kind: "mcp", id: "docs" }],
      delivery: "send",
    });
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toEqual([
      { kind: "mcp", id: "docs" },
    ]);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const duplicate = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "again", tools: [{ kind: "mcp", id: "docs" }] },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicate.status).toBe(202);
    const currentSession = await requireSession(dbClient.db, workspaceId, session.id);
    expect(currentSession.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const turnIds = new Set(
      (await listSessionTurns(dbClient.db, workspaceId, session.id)).map((turn) => turn.id),
    );
    const usage = await listUsageEvents(dbClient.db, {
      accountId: currentSession.accountId,
      workspaceId,
      limit: 100,
    });
    expect(
      usage
        .filter((usageEvent) => usageEvent.eventType === "agent_run.created")
        .filter(
          (usageEvent) =>
            usageEvent.sourceResourceId === session.id ||
            turnIds.has(usageEvent.sourceResourceId ?? ""),
        ),
    ).toHaveLength(3);
  });

  test("revives a failed session on a new user message but keeps cancelled terminal", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    // A failed manager channel must answer when spoken to: the message is
    // accepted, the session transitions failed -> queued (stale active turn
    // cleared), the status change is on the timeline, and the workflow is
    // woken via signalWithStart exactly as for idle sessions.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "failed", null);
    const wakeupsBefore = workflowClient.wakeups.length;
    const revived = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "are you still there?" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(revived.status).toBe(202);
    const afterRevival = await requireSession(dbClient.db, workspaceId, session.id);
    expect(afterRevival.status).toBe("queued");
    expect(afterRevival.activeTurnId).toBeNull();
    expect(workflowClient.wakeups.length).toBe(wakeupsBefore + 1);
    const events = await listSessionEvents(dbClient.db, workspaceId, session.id, 0, 100);
    const statusChanges = events.filter((event) => event.type === "session.status.changed");
    expect((statusChanges.at(-1)?.payload as { status?: string } | undefined)?.status).toBe(
      "queued",
    );

    // Cancelled stays terminal: an explicit user act, not a failure.
    await setSessionStatus(dbClient.db, workspaceId, session.id, "cancelled", null);
    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "hello?" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(409);
  });

  test("queues model settings on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "hello",
        model: "scripted-model",
        reasoningEffort: "low",
      }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "use a stronger model",
            model: "gpt-5.6-sol",
            reasoningEffort: "xhigh",
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(accepted.status).toBe(202);
    const event = (await accepted.json()) as SessionEvent;
    expect(event.payload).toEqual({
      text: "use a stronger model",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      delivery: "send",
    });
    const turns = await listSessionTurns(dbClient.db, workspaceId, session.id);
    const turn = turns.find((item) => item.triggerEventId === event.id);
    expect(turn?.model).toBe("gpt-5.6-sol");
    expect(turn?.reasoningEffort).toBe("xhigh");
  });

  test("keeps a committed follow-up accepted and metered when immediate workflow wake fails", async () => {
    const failingWorkflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: failingWorkflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    failingWorkflow.wakeError = new Error("temporal wake unavailable");
    const before = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });

    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "this wake fails" },
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(accepted.status).toBe(202);
    const after = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(after).toBe(before + 1);
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
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);

    const responses = await Promise.all(
      mcpServers.map((server) =>
        app.request(workspacePath(workspaceId, `/sessions/${session.id}/events`), {
          method: "POST",
          body: JSON.stringify({
            type: "user.message",
            payload: {
              text: `search ${server.id}`,
              tools: [{ kind: "mcp", id: server.id }],
            },
          }),
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 202)).toHaveLength(mcpServers.length);
    expect((await requireSession(dbClient.db, workspaceId, session.id)).tools).toHaveLength(
      mcpServers.length,
    );
  });

  test("rejects unknown MCP tool refs on follow-up user messages", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "hello" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "search docs",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
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
    const payload = (await response.json()) as {
      deploymentRevision: string;
      defaultModel: string;
      allowedReasoningEfforts: string[];
      fileUploads: { enabled: boolean; maxSizeBytes: number };
    };
    expect(payload.deploymentRevision).toBe("dev");
    expect(payload.defaultModel).toBe("scripted-model");
    expect(payload.allowedReasoningEfforts).toContain("high");
    expect(payload.fileUploads).toEqual({
      enabled: false,
      maxSizeBytes: 5_000_000_000,
    });
  });

  test("catalog exposes workspace-template API paths and default MCP capability tools", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const context = await defaultAccessContext(app);
    const capabilityId = `mcp:test-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: context.defaultAccountId!,
      workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Route MCP",
      endpointUrl: "https://example.com/mcp",
      metadata: { mcpServerId: "cap-route-mcp" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: context.defaultAccountId!,
      workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {
        mcpConnectivity: {
          status: "ok",
          checkedAt: new Date().toISOString(),
          toolCount: 1,
        },
      },
    });

    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      items: Array<{
        id: string;
        metadata: Record<string, unknown>;
        runtime: { mcpServerId?: string };
        enabled: boolean;
      }>;
    };
    const apiPaths = Object.fromEntries(
      catalog.items
        .filter((item) => item.id.startsWith("api:"))
        .map((item) => [item.id, item.metadata.endpointPath]),
    );
    expect(apiPaths).toMatchObject({
      "api:github-app": "/v1/workspaces/{workspaceId}/github/app",
      "api:documents": "/v1/workspaces/{workspaceId}/document-bases",
      "api:social": "/v1/workspaces/{workspaceId}/social/connections",
      "api:scheduled-tasks": "/v1/workspaces/{workspaceId}/scheduled-tasks",
    });
    expect(catalog.items.find((item) => item.id === capabilityId)).toMatchObject({
      enabled: true,
      runtime: { mcpServerId: "cap-route-mcp" },
    });

    const omittedTools = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "default tools" }),
      headers: { "content-type": "application/json" },
    });
    expect(omittedTools.status).toBe(202);
    const omittedSession = (await omittedTools.json()) as { id: string };
    expect(
      (await requireSession(dbClient.db, workspaceId, omittedSession.id)).tools,
    ).toContainEqual({ kind: "mcp", id: "cap-route-mcp", optional: true });

    const explicitEmptyTools = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "no tools", tools: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(explicitEmptyTools.status).toBe(202);
    const explicitEmptySession = (await explicitEmptyTools.json()) as {
      id: string;
    };
    expect((await requireSession(dbClient.db, workspaceId, explicitEmptySession.id)).tools).toEqual(
      [],
    );

    // Scheduled tasks mirror sessions: an absent agentConfig.tools key means
    // "give me the workspace's enabled capability MCP servers", an explicit
    // list (even empty) is taken verbatim. Without this, a task created
    // toolless runs with no MCP servers at all (live customer-one lesson:
    // maintenance tasks that cannot reach the workspace notebook MCP).
    const omittedTaskResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "default tools task",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "sweep" },
      }),
    });
    expect(omittedTaskResponse.status).toBe(201);
    const omittedTask = (await omittedTaskResponse.json()) as {
      id: string;
      agentConfig: { tools: unknown[] };
    };
    expect(omittedTask.agentConfig.tools).toContainEqual({
      kind: "mcp",
      id: "cap-route-mcp",
      optional: true,
    });

    const explicitEmptyTaskResponse = await app.request(
      workspacePath(workspaceId, "/scheduled-tasks"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "explicit empty tools task",
          schedule: { type: "interval", everySeconds: 3600 },
          agentConfig: { prompt: "sweep", tools: [] },
        }),
      },
    );
    expect(explicitEmptyTaskResponse.status).toBe(201);
    const explicitEmptyTask = (await explicitEmptyTaskResponse.json()) as {
      id: string;
      agentConfig: { tools: unknown[] };
    };
    expect(explicitEmptyTask.agentConfig.tools).toEqual([]);

    // Updates follow the same contract when agentConfig is replaced.
    const patchedDefault = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${explicitEmptyTask.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentConfig: { prompt: "sweep again" } }),
      },
    );
    expect(patchedDefault.status).toBe(200);
    expect(
      ((await patchedDefault.json()) as { agentConfig: { tools: unknown[] } }).agentConfig.tools,
    ).toContainEqual({ kind: "mcp", id: "cap-route-mcp", optional: true });
    const patchedExplicit = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${omittedTask.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentConfig: { prompt: "sweep verbatim", tools: [] },
        }),
      },
    );
    expect(patchedExplicit.status).toBe(200);
    expect(
      ((await patchedExplicit.json()) as { agentConfig: { tools: unknown[] } }).agentConfig.tools,
    ).toEqual([]);
    await dbClient.db.execute(dbSql`
      update capability_installations
      set status = 'disabled', updated_at = now()
      where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
    `);
  });

  test("enables a credential-header MCP capability end to end with encrypted storage", async () => {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: Buffer.from(encryptionKey).toString("base64"),
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const context = await defaultAccessContext(app);
    const bearer = `Bearer secure-${crypto.randomUUID()}`;
    const mcp = startTestMcpServer({ requiredAuthorization: bearer });
    const capabilityId = `mcp:secure-test-${crypto.randomUUID()}`;
    const mcpServerId = `cap-secure-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await upsertCapabilityCatalogItem(dbClient.db, {
        accountId: context.defaultAccountId!,
        workspaceId,
        id: capabilityId,
        kind: "mcp",
        source: "manual",
        name: "Secure Test MCP",
        endpointUrl: mcp.url,
        authModel: "credential_ref",
        metadata: { mcpServerId, requiredHeaders: ["Authorization"] },
      });

      // Without the declared credential header the enable is rejected up front.
      const withoutHeaders = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        },
      );
      expect(withoutHeaders.status).toBe(422);
      expect(await withoutHeaders.text()).toContain("requires credential header(s) Authorization");

      // A wrong credential fails the live probe (the test MCP returns 401).
      const wrongHeaders = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({ headers: { Authorization: "Bearer wrong" } }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(wrongHeaders.status).toBe(422);
      expect(await wrongHeaders.text()).toContain("could not be enabled");

      // Header values must be valid HTTP field values (RFC 9110): control
      // characters beyond CR/LF are rejected too.
      const controlChars = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            headers: { Authorization: "Bearer bad\u0007value" },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(controlChars.status).toBe(422);
      expect(await controlChars.text()).toContain("forbidden control characters");

      const enabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            headers: { Authorization: bearer },
            // Reserved keys in caller config must be stripped, never stored —
            // a plaintext config.headers map must not bypass encryption.
            config: {
              headers: { Authorization: "plaintext-bypass" },
              headersEncrypted: "spoofed",
              note: "kept",
            },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(enabled.status).toBe(201);
      const enabledBody = await enabled.text();
      // The API response exposes header names only — never the credential.
      expect(enabledBody).not.toContain(bearer);
      expect(enabledBody).not.toContain("plaintext-bypass");
      const installation = JSON.parse(enabledBody) as {
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      expect(installation.config.headerNames).toEqual(["Authorization"]);
      expect(installation.config.headersEncrypted).toBeUndefined();
      expect(installation.config.headers).toBeUndefined();
      expect(installation.config.note).toBe("kept");
      expect(installation.metadata.mcpConnectivity).toMatchObject({
        status: "ok",
      });

      // The stored value is AES-GCM ciphertext that decrypts back to the credential.
      const [row] = (await dbClient.db.execute(dbSql`
        select config from capability_installations
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `)) as Array<{ config: { headersEncrypted: Record<string, string> } }>;
      const storedCiphertext = row!.config.headersEncrypted.Authorization!;
      expect(storedCiphertext.startsWith("v1:")).toBe(true);
      expect(decryptEnvironmentValue(encryptionKey, storedCiphertext)).toBe(bearer);

      // The catalog reports the capability enabled and runtime-ready.
      const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
      const catalog = (await catalogResponse.json()) as {
        items: Array<{
          id: string;
          enabled: boolean;
          runtime: { available: boolean; mcpServerId?: string };
        }>;
      };
      expect(catalog.items.find((item) => item.id === capabilityId)).toMatchObject({
        enabled: true,
        runtime: { available: true, mcpServerId },
      });

      // The worker-side merge decrypts the headers for the runtime MCP client,
      // and the runtime can list tools against the credentialed server.
      const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
        dbClient.db,
        workspaceId,
        settings,
      );
      const merged = runtimeSettings.mcpServers.find((server) => server.id === mcpServerId);
      expect(merged?.headers).toEqual({ Authorization: bearer });
      const prepared = await prepareAgentTools(runtimeSettings, [{ kind: "mcp", id: mcpServerId }]);
      try {
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain(`${mcpServerId}__search_documents`);
      } finally {
        await prepared.close();
      }

      // Re-enabling without headers reuses the stored credentials (probe still passes).
      const reEnabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        },
      );
      expect(reEnabled.status).toBe(201);
      const reEnabledInstallation = (await reEnabled.json()) as {
        config: Record<string, unknown>;
      };
      expect(reEnabledInstallation.config.headerNames).toEqual(["Authorization"]);
    } finally {
      mcp.close();
      await dbClient.db.execute(dbSql`
        update capability_installations
        set status = 'disabled', updated_at = now()
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `);
    }
  });

  test("broker-authenticates a connectionRef MCP capability through the worker settings overlay", async () => {
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: Buffer.from(encryptionKey).toString("base64"),
    });
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const bearer = `Bearer broker-${crypto.randomUUID()}`;
    const mcp = startTestMcpServer({
      requiredHeaders: { authorization: bearer },
    });
    const providerDomain = new URL(mcp.url).host;
    const capabilityId = `mcp:i1accept-${crypto.randomUUID()}`;
    const mcpServerId = "i1accept";
    try {
      const createdCapability = await app.request(workspacePath(workspaceId, "/capabilities"), {
        method: "POST",
        body: JSON.stringify({
          id: capabilityId,
          kind: "mcp",
          source: "manual",
          name: "I1 Acceptance MCP",
          endpointUrl: mcp.url,
          authModel: "api_key",
          metadata: { mcpServerId },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdCapability.status).toBe(201);

      const createdConnection = await app.request(workspacePath(workspaceId, "/connections"), {
        method: "POST",
        body: JSON.stringify({
          providerDomain,
          kind: "api_key",
          credential: { headers: { authorization: bearer } },
          metadata: { label: "I1 acceptance key" },
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdConnection.status).toBe(201);
      const { connection } = (await createdConnection.json()) as {
        connection: { id: string };
      };

      const enabled = await app.request(
        workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/enable`),
        {
          method: "POST",
          body: JSON.stringify({
            connectionRef: {
              connectionId: connection.id,
              providerDomain,
              kind: "api_key",
            },
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(enabled.status).toBe(201);
      const installation = (await enabled.json()) as {
        config: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      expect(installation.config.connectionRef).toMatchObject({
        connectionId: connection.id,
        providerDomain,
        kind: "api_key",
        subjectScope: "workspace",
      });
      expect(installation.metadata.mcpConnectivity).toMatchObject({
        status: "auth_deferred",
      });

      const createdSession = await app.request(workspacePath(workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({
          initialMessage: "use the acceptance MCP",
          model: "scripted-model",
          tools: [{ kind: "mcp", id: mcpServerId }],
        }),
        headers: { "content-type": "application/json" },
      });
      expect(createdSession.status).toBe(202);
      const session = (await createdSession.json()) as {
        id: string;
        tools: Array<{ kind: string; id: string }>;
      };
      expect(session.tools).toContainEqual({ kind: "mcp", id: mcpServerId });

      const mcpSettings = await settingsWithEnabledCapabilityMcpServers(
        dbClient.db,
        workspaceId,
        settings,
      );
      const capabilitySettings = await settingsWithCodexCredential(
        dbClient.db,
        workspaceId,
        mcpSettings,
        false,
      );
      const runSettings = await settingsWithSessionMcpServersForRun(
        dbClient.db,
        workspaceId,
        session.id,
        capabilitySettings,
      );
      const resolveCredential = buildConnectionTokenResolver(dbClient.db, runSettings);
      const prepared = await prepareAgentTools(runSettings, [{ kind: "mcp", id: mcpServerId }], {
        workspaceId,
        subjectId: "worker:first-party-mcp",
        resolveCredential,
      });
      try {
        const merged = runSettings.mcpServers.find((server) => server.id === mcpServerId);
        expect(merged?.connectionRef).toMatchObject({
          connectionId: connection.id,
          providerDomain,
          kind: "api_key",
          subjectScope: "workspace",
        });
        const tools = await prepared.mcpServers[0]!.listTools();
        expect(tools.map((tool) => tool.name)).toContain(`${mcpServerId}__search_documents`);
        const result = await prepared.mcpServers[0]!.callTool(`${mcpServerId}__search_documents`, {
          query: "broker",
        });
        expect(JSON.stringify(result)).toContain("found document for broker");
      } finally {
        await prepared.close();
      }
    } finally {
      mcp.close();
      await dbClient.db.execute(dbSql`
        update capability_installations
        set status = 'disabled', updated_at = now()
        where workspace_id = ${workspaceId} and capability_id = ${capabilityId}
      `);
    }
  });

  test("returns 409 when disabling a never-enabled capability", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const capabilityId = `skill:test-${crypto.randomUUID()}`;
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/capabilities"), {
      method: "POST",
      body: JSON.stringify({
        id: capabilityId,
        kind: "skill",
        source: "manual",
        name: "Test Skill",
        category: "test",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);

    const disabled = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(capabilityId)}/disable`),
      { method: "POST" },
    );
    expect(disabled.status).toBe(409);
    expect(await disabled.text()).toContain("capability is not currently enabled");
  });

  test("enforces shared-key auth on user-facing routes when enabled", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    const config = await app.request("/v1/config/client");
    expect(config.status).toBe(200);
    expect(((await config.json()) as { auth: { mode: string } }).auth.mode).toBe("deploymentKey");

    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/metrics")).status).toBe(401);
    const authHeaders = { "x-opengeni-access-key": "local-test-key" };
    const workspaceId = await defaultWorkspaceId(app, authHeaders);
    expect(
      (
        await app.request(workspacePath(workspaceId, "/sessions"), {
          method: "POST",
          body: JSON.stringify({ initialMessage: "blocked" }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(401);

    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "allowed" }),
      headers: {
        "content-type": "application/json",
        "x-opengeni-access-key": "local-test-key",
      },
    });
    expect(created.status).toBe(202);
  });

  test("can explicitly allow unauthenticated metrics for internal scrapers", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        authRequired: true,
        accessKey: "local-test-key",
        authAllowMetrics: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });

    // opengeni_http_requests_total is recorded after the response for each
    // request finishes, so a fresh app's very first request (this /metrics
    // scrape itself) can never see its own count. Warm the counter with a
    // prior request first, same as any real deployment's traffic would.
    await app.request("/healthz");
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("opengeni_http_requests_total");
  });

  test("creates and manages scheduled tasks", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
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
    const task = (await created.json()) as {
      id: string;
      temporalScheduleId: string;
    };
    expect(task.temporalScheduleId).toBe(`scheduled-task-${task.id}`);
    expect(workflow.synced).toHaveLength(1);

    const paused = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`),
      { method: "POST" },
    );
    expect(paused.status).toBe(200);
    expect(workflow.synced).toHaveLength(2);

    const firedBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    const agentRunsBefore = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    const triggered = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      { method: "POST" },
    );
    expect(triggered.status).toBe(202);
    expect(workflow.triggers).toHaveLength(1);
    expect(
      (workflow.triggers[0] as { task?: { id?: string; workspaceId?: string } }).task,
    ).toMatchObject({
      id: task.id,
      workspaceId,
    });
    const firedAfter = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    expect(firedAfter).toBe(firedBefore);
    const agentRunsAfter = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(agentRunsAfter).toBe(agentRunsBefore + 1);

    const listed = await app.request(workspacePath(workspaceId, "/scheduled-tasks"));
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as Array<{ id: string }>).some((item) => item.id === task.id),
    ).toBe(true);
  });

  test("a retried manual trigger (same triggerId) charges once and starts one run", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "idempotent",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const triggerWith = async (triggerId: string) =>
      await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
        method: "POST",
        body: JSON.stringify({ triggerId }),
        headers: { "content-type": "application/json" },
      });

    // The client retries the SAME logical trigger (a network blip re-POSTs with
    // the same idempotency token). Both reach the handler.
    const first = await triggerWith("retry-token-1");
    const second = await triggerWith("retry-token-1");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // Both calls derive the SAME usage idempotency key AND the SAME workflowId
    // from the shared token, so the charge dedupes and the duplicate workflow
    // start collapses (deterministic id + REJECT_DUPLICATE at the worker).
    const triggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(triggers).toHaveLength(2);
    expect(triggers[0]?.agentRunUsageIdempotencyKey).toBe(triggers[1]?.agentRunUsageIdempotencyKey);
    expect(triggers[0]?.triggerWorkflowId).toBe(triggers[1]?.triggerWorkflowId);
    expect(triggers[0]?.agentRunUsageIdempotencyKey).toContain("retry-token-1");
    expect(triggers[0]?.triggerWorkflowId).toContain("retry-token-1");

    // Exactly ONE agent_run.created usage row exists for this token despite two
    // POSTs (idempotency-key dedup in recordWorkspaceUsage).
    const usage = await listUsageEvents(dbClient.db, {
      accountId: (await getScheduledTask(dbClient.db, workspaceId, task.id))!.accountId,
      workspaceId,
    });
    const charged = usage.filter(
      (event) => event.idempotencyKey === triggers[0]?.agentRunUsageIdempotencyKey,
    );
    expect(charged).toHaveLength(1);

    // A DIFFERENT token is a genuinely distinct trigger: new key, new run, a
    // second charge.
    const third = await triggerWith("retry-token-2");
    expect(third.status).toBe(202);
    const allTriggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(allTriggers[2]?.agentRunUsageIdempotencyKey).not.toBe(
      triggers[0]?.agentRunUsageIdempotencyKey,
    );
    expect(allTriggers[2]?.triggerWorkflowId).not.toBe(triggers[0]?.triggerWorkflowId);
  });

  test("a manual trigger without a triggerId stays a distinct run each time", async () => {
    const workflowClient = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "anon-trigger",
        schedule: { type: "interval", everySeconds: 3600 },
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = (await created.json()) as { id: string };

    // A bare POST (no body) is still a valid, distinct trigger.
    const a = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
      method: "POST",
    });
    const b = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`), {
      method: "POST",
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const triggers = workflowClient.triggers as Array<{
      agentRunUsageIdempotencyKey?: string;
      triggerWorkflowId?: string;
    }>;
    expect(triggers[0]?.agentRunUsageIdempotencyKey).not.toBe(
      triggers[1]?.agentRunUsageIdempotencyKey,
    );
    expect(triggers[0]?.triggerWorkflowId).not.toBe(triggers[1]?.triggerWorkflowId);
  });

  test("does not record manual scheduled trigger usage when workflow start fails", async () => {
    workflow = new FakeWorkflowClient();
    workflow.triggerError = new Error("temporal trigger unavailable");
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "Manual trigger failure",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect", resources: [], tools: [] },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    const before = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });

    const failed = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/trigger`),
      { method: "POST" },
    );

    expect(failed.status).toBe(500);
    const after = await sumUsageQuantity(dbClient.db, {
      workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(after).toBe(before);
  });

  test("creates marketing social scheduled tasks from connected accounts only", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: firstPartyMcpSettings(services.databaseUrl),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const suffix = crypto.randomUUID();
    const workspaceId = await defaultWorkspaceId(app);

    const enabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabled.status).toBeLessThan(300);

    const activeResponse = await app.request(workspacePath(workspaceId, "/social/connections"), {
      method: "POST",
      body: JSON.stringify({
        provider: "linkedin",
        accountHandle: `active-${suffix}`,
        accountName: "Active Company",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(activeResponse.status).toBe(201);
    const activeConnection = (await activeResponse.json()) as { id: string };

    const disabledResponse = await app.request(workspacePath(workspaceId, "/social/connections"), {
      method: "POST",
      body: JSON.stringify({
        provider: "linkedin",
        accountHandle: `disabled-${suffix}`,
        accountName: "Disabled Company",
        status: "disabled",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(disabledResponse.status).toBe(201);
    const disabledConnection = (await disabledResponse.json()) as {
      id: string;
    };

    const created = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/scheduled-tasks"),
      {
        method: "POST",
        body: JSON.stringify({
          connectionIds: [],
          documentBaseIds: [],
          timeZone: "UTC",
          hour: 9,
          minute: 0,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(201);
    const task = JSON.parse(createdBody) as {
      metadata: Record<string, unknown>;
      agentConfig: { metadata: Record<string, unknown> };
    };
    expect(task.metadata.socialConnectionIds).toEqual([activeConnection.id]);
    expect(task.agentConfig.metadata.socialConnectionIds).toEqual([activeConnection.id]);
    expect(task.metadata.socialConnectionIds).not.toContain(disabledConnection.id);
    expect(workflow.synced).toHaveLength(1);
  });

  test("registers workspace packs from manifests and installs them", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const packId = `infra-test-${crypto.randomUUID().slice(0, 8)}`;
    const manifest = {
      id: packId,
      name: "Infra test pack",
      description: "Registered from a manifest payload in tests.",
      role: "infrastructure",
      category: "deployment",
      version: "0.1.0",
      scheduledTaskTemplates: [
        {
          id: "drift-daily",
          name: "Daily drift check",
          description: "Compare expected state against live state.",
          defaultSchedule: {
            type: "calendar",
            timeZone: "UTC",
            hour: 6,
            minute: 0,
          },
          defaultRunMode: "new_session_per_run",
          defaultOverlapPolicy: "skip",
          prompt: "Run the daily drift check.",
        },
      ],
      environment: {
        description: "Cloud credentials for substrate work.",
        requiredVariables: ["CLOUD_TOKEN"],
        required: true,
      },
    };

    const registered = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify(manifest),
      headers: { "content-type": "application/json" },
    });
    expect(registered.status).toBe(201);
    const registeredBody = (await registered.json()) as {
      pack: { id: string; scheduledTaskTemplates: Array<{ prompt?: string }> };
    };
    expect(registeredBody.pack.id).toBe(packId);
    expect(registeredBody.pack.scheduledTaskTemplates[0]?.prompt).toBe(
      "Run the daily drift check.",
    );

    const replaced = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify({ ...manifest, version: "0.1.1" }),
      headers: { "content-type": "application/json" },
    });
    expect(replaced.status).toBe(200);

    const builtInCollision = await app.request(workspacePath(workspaceId, "/packs"), {
      method: "POST",
      body: JSON.stringify({
        ...manifest,
        id: "marketing-social-daily-analysis",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(builtInCollision.status).toBe(409);

    const listed = await app.request(workspacePath(workspaceId, "/packs"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      packs: Array<{ id: string; version: string }>;
    };
    expect(listedBody.packs.map((pack) => pack.id)).toContain(packId);
    expect(listedBody.packs.find((pack) => pack.id === packId)?.version).toBe("0.1.1");

    const enabledWithoutEnvironment = await app.request(
      workspacePath(workspaceId, `/packs/${packId}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabledWithoutEnvironment.status).toBe(422);

    const environmentResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      body: JSON.stringify({
        name: `cloud-${crypto.randomUUID().slice(0, 8)}`,
        variables: [{ name: "OTHER_TOKEN", value: "value-1" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(environmentResponse.status).toBe(201);
    const environment = (await environmentResponse.json()) as { id: string };

    const enabledMissingVariable = await app.request(
      workspacePath(workspaceId, `/packs/${packId}/enable`),
      {
        method: "POST",
        body: JSON.stringify({ environmentId: environment.id }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabledMissingVariable.status).toBe(422);
    expect(await enabledMissingVariable.text()).toContain("CLOUD_TOKEN");

    const capabilityEnableWithoutAttachment = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableWithoutAttachment.status).toBe(422);

    const setVariable = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}/variables/CLOUD_TOKEN`),
      {
        method: "PUT",
        body: JSON.stringify({ value: "cloud-token-value" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(setVariable.status).toBeLessThan(300);

    // Env-on-enable through the unified capability path: an environment.required
    // pack with no prior attachment enables when an environmentId is supplied
    // (no 422), and the initial attachment is persisted — mirroring what the
    // dedicated /packs/:id/enable endpoint does.
    const capabilityEnableWithEnvironment = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({ environmentId: environment.id }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableWithEnvironment.status).toBe(201);
    const capabilityInstallation = (await capabilityEnableWithEnvironment.json()) as {
      status: string;
    };
    expect(capabilityInstallation.status).toBe("active");
    // The attachment is persisted on the pack installation (mirroring the
    // dedicated /packs/:id/enable endpoint), which the catalog reads for
    // enablement; the returned capability installation is the pack:{id} row.
    const storedAfterUnifiedEnable = await getPackInstallation(dbClient.db, workspaceId, packId);
    expect(storedAfterUnifiedEnable?.status).toBe("active");
    expect(storedAfterUnifiedEnable?.metadata.variableSetId).toBe(environment.id);

    // A bogus environmentId on the unified path is rejected up front.
    const capabilityEnableUnknownEnvironment = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({ environmentId: crypto.randomUUID() }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableUnknownEnvironment.status).toBe(422);

    const enabled = await app.request(workspacePath(workspaceId, `/packs/${packId}/enable`), {
      method: "POST",
      body: JSON.stringify({ environmentId: environment.id }),
      headers: { "content-type": "application/json" },
    });
    expect(enabled.status).toBe(200);
    const installation = (await enabled.json()) as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(installation.status).toBe("active");
    expect(installation.metadata.packVersion).toBe("0.1.1");
    expect(installation.metadata.variableSetId).toBe(environment.id);

    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      items: Array<{
        id: string;
        kind: string;
        source: string;
        enabled: boolean;
      }>;
    };
    expect(catalog.items.find((item) => item.id === `pack:${packId}`)).toMatchObject({
      kind: "pack",
      source: "manual",
      enabled: true,
    });

    // Re-enabling through the generic capabilities path keeps the stored
    // environment attachment instead of overwriting it.
    const capabilityEnable = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnable.status).toBe(201);
    const installationAfterCapabilityEnable = await getPackInstallation(
      dbClient.db,
      workspaceId,
      packId,
    );
    expect(installationAfterCapabilityEnable?.metadata.variableSetId).toBe(environment.id);

    const deletedBuiltIn = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis"),
      { method: "DELETE" },
    );
    expect(deletedBuiltIn.status).toBe(409);

    // Once the required variable disappears, the generic enable path
    // re-validates the stored attachment and refuses.
    const removeVariable = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}/variables/CLOUD_TOKEN`),
      { method: "DELETE" },
    );
    expect(removeVariable.status).toBeLessThan(300);
    const capabilityEnableMissingVariable = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packId}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnableMissingVariable.status).toBe(422);
    expect(await capabilityEnableMissingVariable.text()).toContain("CLOUD_TOKEN");

    const deleted = await app.request(workspacePath(workspaceId, `/packs/${packId}`), {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    const missing = await app.request(workspacePath(workspaceId, `/packs/${packId}`));
    expect(missing.status).toBe(404);
    const installationAfterDelete = await getPackInstallation(dbClient.db, workspaceId, packId);
    expect(installationAfterDelete?.status).toBe("disabled");
    // The capability installation row is disabled too, so a future
    // re-registration does not inherit stale enablement.
    const capabilityInstallationAfterDelete = await getCapabilityInstallation(
      dbClient.db,
      workspaceId,
      `pack:${packId}`,
    );
    expect(capabilityInstallationAfterDelete?.status).toBe("disabled");
  });

  test("allows only one enabled pack per workspace to declare a sandbox image", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const suffix = crypto.randomUUID().slice(0, 8);
    const imagePackManifest = (id: string, image: string) => ({
      id,
      name: `Pack ${id}`,
      description: "Pack with a pack-scoped sandbox image.",
      role: "infrastructure",
      category: "infrastructure",
      version: "0.1.0",
      sandboxImage: image,
      skills: [
        {
          name: "infra-ops",
          description: "Operate infrastructure with the pack runbook.",
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: infra-ops\ndescription: Operate infrastructure.\n---\n# Infra ops\n",
            },
            { path: "references/runbook.md", content: "Runbook." },
          ],
        },
      ],
    });
    const packA = `img-a-${suffix}`;
    const packB = `img-b-${suffix}`;
    for (const [packId, image] of [
      [packA, "example.com/sandbox-a@sha256:aaaa"],
      [packB, "example.com/sandbox-b@sha256:bbbb"],
    ] as const) {
      const registered = await app.request(workspacePath(workspaceId, "/packs"), {
        method: "POST",
        body: JSON.stringify(imagePackManifest(packId, image)),
        headers: { "content-type": "application/json" },
      });
      expect(registered.status).toBe(201);
    }

    const enabledA = await app.request(workspacePath(workspaceId, `/packs/${packA}/enable`), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(enabledA.status).toBe(201);

    // The catalog surfaces the pack's runtime composition (image ref and
    // skill names) without leaking skill file content.
    const catalogResponse = await app.request(workspacePath(workspaceId, "/capabilities"));
    const catalog = (await catalogResponse.json()) as {
      items: Array<{ id: string; metadata: Record<string, unknown> }>;
    };
    const packAItem = catalog.items.find((item) => item.id === `pack:${packA}`);
    expect(packAItem?.metadata.sandboxImage).toBe("example.com/sandbox-a@sha256:aaaa");
    expect(packAItem?.metadata.skills).toEqual(["infra-ops"]);
    expect(JSON.stringify(packAItem?.metadata)).not.toContain("Runbook.");

    // A second image-declaring pack cannot be enabled, on either enable path.
    const enabledB = await app.request(workspacePath(workspaceId, `/packs/${packB}/enable`), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(enabledB.status).toBe(409);
    expect(await enabledB.text()).toContain(
      "only one enabled pack per workspace may declare sandboxImage",
    );
    const capabilityEnabledB = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packB}`)}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(capabilityEnabledB.status).toBe(409);

    // Re-enabling the already-enabled image pack stays allowed.
    const reenabledA = await app.request(workspacePath(workspaceId, `/packs/${packA}/enable`), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(reenabledA.status).toBe(200);

    // Disabling the first pack frees the slot for the second.
    const disabledA = await app.request(
      workspacePath(workspaceId, `/capabilities/${encodeURIComponent(`pack:${packA}`)}/disable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(disabledA.status).toBeLessThan(300);
    const enabledBAfterDisable = await app.request(
      workspacePath(workspaceId, `/packs/${packB}/enable`),
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(enabledBAfterDisable.status).toBe(201);
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
    const workspaceId = await defaultWorkspaceId(app);
    const failedCreate = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(failedCreate.status).toBe(500);
    expect(
      (await listScheduledTasks(dbClient.db, workspaceId)).some(
        (task) => task.name === failedCreateName,
      ),
    ).toBe(false);

    workflow.syncError = null;
    const created = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: `rollback-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    const task = (await created.json()) as { id: string };

    workflow.syncError = new Error("temporal unavailable");
    const failedPause = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}/pause`),
      { method: "POST" },
    );
    expect(failedPause.status).toBe(500);
    expect((await getScheduledTask(dbClient.db, workspaceId, task.id))?.status).toBe("active");
  });

  test("keeps MCP scheduled task persistence consistent when schedule sync fails", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({ databaseUrl: services.databaseUrl });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcp = buildOpenGeniMcpServer(
      {
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
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );

    workflow.syncError = new Error("temporal unavailable");
    const failedCreateName = `mcp-sync-fail-${crypto.randomUUID()}`;
    await expect(
      callMcpTool(mcp, "scheduled_tasks_create", {
        name: failedCreateName,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
    ).rejects.toThrow("temporal unavailable");
    expect(
      (await listScheduledTasks(dbClient.db, grant.workspaceId)).some(
        (task) => task.name === failedCreateName,
      ),
    ).toBe(false);

    workflow.syncError = null;
    const task = await callMcpTool<{ id: string }>(mcp, "scheduled_tasks_create", {
      name: `mcp-rollback-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });

    workflow.syncError = new Error("temporal unavailable");
    await expect(callMcpTool(mcp, "scheduled_tasks_pause", { id: task.id })).rejects.toThrow(
      "temporal unavailable",
    );
    expect((await getScheduledTask(dbClient.db, grant.workspaceId, task.id))?.status).toBe(
      "active",
    );
    await expect(
      callMcpTool(mcp, "scheduled_tasks_resume", { id: crypto.randomUUID() }),
    ).rejects.toThrow("Scheduled task not found");
  });

  test("MCP scheduled task tools enforce the same billing limits as REST routes", async () => {
    workflow = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const allowedMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({ databaseUrl: services.databaseUrl }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    const task = await callMcpTool<{ id: string }>(allowedMcp, "scheduled_tasks_create", {
      name: `mcp-limit-trigger-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
    });
    workflow.synced = [];

    const blockedCreateMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxSchedulesPerWorkspace: 1,
          }),
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );

    await expect(
      callMcpTool(blockedCreateMcp, "scheduled_tasks_create", {
        name: `mcp-limit-create-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
    ).rejects.toThrow("scheduled task limit reached");
    expect(workflow.synced).toHaveLength(0);
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "test",
      sourceResourceId: task.id,
      idempotencyKey: `test:mcp-agent-run-cap:${task.id}`,
    });

    const blockedTriggerMcp = buildOpenGeniMcpServer(
      {
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxMonthlyAgentRunsPerWorkspace: 1,
          }),
        }),
        db: dbClient.db,
        bus: new MemoryEventBus(),
        workflowClient: workflow,
        objectStorage: null,
        githubStateSecret: "test-state-secret",
        documentIndexer: { indexDocument: async () => undefined },
        getDocumentServices: () => {
          throw new Error("document services are not used by scheduled task MCP tests");
        },
        resumeBoxById: fakeResumeBoxById,
      },
      grant,
    );
    await expect(
      callMcpTool(blockedTriggerMcp, "scheduled_tasks_trigger", {
        id: task.id,
      }),
    ).rejects.toThrow("monthly agent run limit reached");
    expect(workflow.triggers).toHaveLength(0);
  });

  test("returns 404 for missing scheduled task actions", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${crypto.randomUUID()}/pause`),
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });

  test("validates scheduled task semantic edge cases", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const blankName = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      body: JSON.stringify({
        name: "   ",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(blankName.status).toBe(422);

    const invalidWindow = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
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
    const payload = (await response.json()) as {
      fileUploads: { enabled: boolean; maxSizeBytes: number };
    };
    expect(payload.fileUploads).toEqual({
      enabled: true,
      maxSizeBytes: 5_000_000_000,
    });
  });

  test("rejects mixed GitHub App repository installations during session create", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "bad repos",
        resources: [
          {
            kind: "repository",
            uri: "https://github.com/a/one.git",
            ref: "main",
            githubInstallationId: 1,
            githubRepositoryId: 11,
          },
          {
            kind: "repository",
            uri: "https://github.com/b/two.git",
            ref: "main",
            githubInstallationId: 2,
            githubRepositoryId: 22,
          },
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
    const workspaceId = await defaultWorkspaceId(app);

    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
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
    const upload = (await uploadResponse.json()) as {
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

    const completeResponse = await app.request(
      workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
      {
        method: "POST",
      },
    );
    expect(completeResponse.status).toBe(200);
    const completed = (await completeResponse.json()) as {
      file: { id: string; status: string; objectKey: string };
    };
    expect(completed.file.id).toBe(upload.fileId);
    expect(completed.file.status).toBe("ready");
    expect(completed.file.objectKey).toContain(`/original/spec.txt`);

    const metadataResponse = await app.request(
      workspacePath(workspaceId, `/files/${upload.fileId}`),
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as Record<string, unknown>;
    expect(metadata.status).toBe("ready");
    expect(metadata).not.toHaveProperty("url");

    const downloadResponse = await app.request(
      workspacePath(workspaceId, `/files/${upload.fileId}/download-url`),
      { method: "POST" },
    );
    expect(downloadResponse.status).toBe(200);
    const download = (await downloadResponse.json()) as { url: string };
    expect(download.url).toContain("X-Amz-Signature");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(sessionResponse.status).toBe(202);
    const session = (await sessionResponse.json()) as {
      id: string;
      resources: unknown[];
    };
    expect(session.resources).toEqual([
      {
        kind: "file",
        fileId: upload.fileId,
        mountPath: `files/${upload.fileId}`,
      },
    ]);
    const initialEvents = await listSessionEvents(dbClient.db, workspaceId, session.id, 0, 10);
    const initialPayload = initialEvents.find((event) => event.type === "user.message")?.payload as
      | Record<string, unknown>
      | undefined;
    expect(initialPayload).toMatchObject({
      text: "use file",
      resources: [
        {
          kind: "file",
          fileId: upload.fileId,
          mountPath: `files/${upload.fileId}`,
        },
      ],
    });
    if (Array.isArray(initialPayload?.tools)) {
      expect(initialPayload.tools).toContainEqual({
        kind: "mcp",
        id: "cap-route-mcp",
        optional: true,
      });
    }

    const followUpSessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "start empty" }),
      headers: { "content-type": "application/json" },
    });
    const followUpSession = (await followUpSessionResponse.json()) as {
      id: string;
    };
    await setSessionStatus(dbClient.db, workspaceId, followUpSession.id, "idle", null);
    const followUp = await app.request(
      workspacePath(workspaceId, `/sessions/${followUpSession.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "use file now",
            resources: [{ kind: "file", fileId: upload.fileId }],
          },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(followUp.status).toBe(202);
    const followUpEvent = (await followUp.json()) as SessionEvent;
    expect(followUpEvent.payload).toMatchObject({
      text: "use file now",
      resources: [
        {
          kind: "file",
          fileId: upload.fileId,
          mountPath: `files/${upload.fileId}`,
        },
      ],
    });
    if (Array.isArray((followUpEvent.payload as Record<string, unknown>).tools)) {
      expect((followUpEvent.payload as { tools: unknown[] }).tools).toContainEqual({
        kind: "mcp",
        id: "cap-route-mcp",
        optional: true,
      });
    }
    expect((await requireSession(dbClient.db, workspaceId, followUpSession.id)).resources).toEqual([
      {
        kind: "file",
        fileId: upload.fileId,
        mountPath: `files/${upload.fileId}`,
      },
    ]);
  });

  test("rejects pending file resources during session create", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "pending.txt",
        contentType: "text/plain",
        sizeBytes: 7,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = (await uploadResponse.json()) as { fileId: string };
    const response = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use pending file",
        resources: [{ kind: "file", fileId: upload.fileId }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(422);
  });

  test("validates message, approval, Pause, and Resume state transitions", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "state" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };

    const rejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "too soon" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(rejected.status).toBe(202);

    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const accepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: { text: "now" },
          clientEventId: "follow-up",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(accepted.status).toBe(202);
    expect(workflow.wakeups.length).toBeGreaterThanOrEqual(2);

    const approvalRejected = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.approvalDecision",
          payload: { approvalId: "x", decision: "approve" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvalRejected.status).toBe(409);

    const approvalWaitAttemptId = crypto.randomUUID();
    const approvalWaitClaim = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: approvalWaitAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (approvalWaitClaim.action !== "claimed") {
      throw new Error(`failed to claim approval fixture: ${approvalWaitClaim.reason}`);
    }
    await applySessionTurnSettlement(dbClient.db, workspaceId, {
      sessionId: session.id,
      turnId: approvalWaitClaim.turn.id,
      triggerEventId: approvalWaitClaim.turn.triggerEventId,
      attemptId: approvalWaitAttemptId,
      turnStatus: "requires_action",
      sessionStatus: "requires_action",
      activeTurnId: approvalWaitClaim.turn.id,
      events: [{ type: "session.requiresAction", payload: { approvalId: "x" } }],
    });
    const approvalAccepted = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.approvalDecision",
          payload: { approvalId: "x", decision: "approve" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvalAccepted.status).toBe(202);
    expect(workflow.approvals).toHaveLength(1);
    const approvalEvent = (await approvalAccepted.json()) as SessionEvent;

    const attemptId = crypto.randomUUID();
    const running = await claimSessionWorkForAttempt(dbClient.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "approval", triggerEventId: approvalEvent.id },
    });
    expect(running).toMatchObject({ action: "claimed" });
    if (running.action !== "claimed") throw new Error("approval fixture did not resume");

    const dispatchCountBeforePause = workflow.wakeDispatches;
    const paused = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/control`),
      {
        method: "POST",
        body: JSON.stringify({
          action: "pause",
          reason: "operator pause",
          clientEventId: `pause-${crypto.randomUUID()}`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      effectiveControl: { state: "paused" },
      interruptionCount: 1,
    });
    expect(workflow.wakeDispatches).toBe(dispatchCountBeforePause + 1);

    const resumed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/control`),
      {
        method: "POST",
        body: JSON.stringify({
          action: "resume",
          reason: "continue",
          clientEventId: `resume-${crypto.randomUUID()}`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      effectiveControl: { state: "active" },
    });

    const malformed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({ type: "user.message", payload: { text: "" } }),
        headers: { "content-type": "application/json" },
      },
    );
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
    const workspaceId = await defaultWorkspaceId(app);
    const created = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({ initialMessage: "stream" }),
      headers: { "content-type": "application/json" },
    });
    const session = (await created.json()) as { id: string };

    const listed = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=10`),
    );
    expect(listed.status).toBe(200);
    const initialEvents = (await listed.json()) as SessionEvent[];
    expect(initialEvents.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);

    const bulkEventCount = 2005;
    await appendSessionEvents(
      dbClient.db,
      workspaceId,
      session.id,
      Array.from({ length: bulkEventCount }, (_, index) => ({
        type: "agent.message.delta",
        payload: { text: `bulk-${index}` },
      })),
    );
    const latestSequence = initialEvents.length + bulkEventCount;
    const newest = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${Number.MAX_SAFE_INTEGER}&limit=3`,
      ),
    );
    expect(newest.status).toBe(200);
    expect(((await newest.json()) as SessionEvent[]).map((event) => event.sequence)).toEqual([
      latestSequence - 2,
      latestSequence - 1,
      latestSequence,
    ]);

    const ranged = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?after=4&before=8&limit=10`),
    );
    expect(ranged.status).toBe(200);
    expect(((await ranged.json()) as SessionEvent[]).map((event) => event.sequence)).toEqual([
      5, 6, 7,
    ]);

    const clampedMax = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=1000000000`),
    );
    expect(clampedMax.status).toBe(200);
    expect((await clampedMax.json()) as SessionEvent[]).toHaveLength(2000);
    const clampedMin = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=0`),
    );
    expect(clampedMin.status).toBe(200);
    expect((await clampedMin.json()) as SessionEvent[]).toHaveLength(1);

    const compact = await app.request(
      workspacePath(workspaceId, `/sessions/${session.id}/events?limit=1000000000&compact=1`),
    );
    expect(compact.status).toBe(200);
    const compactEvents = (await compact.json()) as SessionEvent[];
    expect(compactEvents.slice(0, 4)).toEqual(initialEvents);
    expect(compactEvents).toHaveLength(5);
    expect(compactEvents[4]).toMatchObject({
      sequence: 5,
      type: "agent.message.delta",
      payload: { coalescedUntil: latestSequence },
    });
    expect(
      (compactEvents[4]?.payload as { text?: string } | undefined)?.text?.startsWith("bulk-0"),
    ).toBe(true);
    expect(
      (compactEvents[4]?.payload as { text?: string } | undefined)?.text?.endsWith(
        `bulk-${bulkEventCount - 1}`,
      ),
    ).toBe(true);

    const compactNewest = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${Number.MAX_SAFE_INTEGER}&limit=3&compact=true`,
      ),
    );
    expect(compactNewest.status).toBe(200);
    const compactNewestEvents = (await compactNewest.json()) as SessionEvent[];
    expect(compactNewestEvents).toHaveLength(1);
    expect(compactNewestEvents[0]?.sequence).toBe(latestSequence - 2);
    expect(
      (compactNewestEvents[0]?.payload as { coalescedUntil?: number } | undefined)?.coalescedUntil,
    ).toBe(latestSequence);

    const compactOlder = await app.request(
      workspacePath(
        workspaceId,
        `/sessions/${session.id}/events?before=${compactNewestEvents[0]!.sequence}&limit=3&compact=1`,
      ),
    );
    expect(compactOlder.status).toBe(200);
    const compactOlderEvents = (await compactOlder.json()) as SessionEvent[];
    expect(compactOlderEvents).toHaveLength(1);
    const compactPageChunks = [
      ...(((compactOlderEvents[0]?.payload as { text?: string } | undefined)?.text ?? "").match(
        /bulk-\d+/g,
      ) ?? []),
      ...(((compactNewestEvents[0]?.payload as { text?: string } | undefined)?.text ?? "").match(
        /bulk-\d+/g,
      ) ?? []),
    ];
    expect(compactPageChunks).toEqual(
      Array.from({ length: 6 }, (_, offset) => `bulk-${bulkEventCount - 6 + offset}`),
    );
    expect(new Set(compactPageChunks).size).toBe(compactPageChunks.length);

    const replayAbort = new AbortController();
    const replay = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=0`)}`,
        {
          signal: replayAbort.signal,
        },
      ),
    );
    expect(replay.status).toBe(200);
    expect((await readSseEvents(replay, 4, replayAbort)).map((event) => event.type)).toEqual(
      initialEvents.map((event) => event.type),
    );

    const liveAbortA = new AbortController();
    const liveAbortB = new AbortController();
    const liveA = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${latestSequence}`)}`,
        {
          signal: liveAbortA.signal,
        },
      ),
    );
    const liveB = await app.request(
      new Request(
        `http://test${workspacePath(workspaceId, `/sessions/${session.id}/events/stream?after=${latestSequence}`)}`,
        {
          signal: liveAbortB.signal,
        },
      ),
    );
    const readA = readSseEvents(liveA, 1, liveAbortA);
    const readB = readSseEvents(liveB, 1, liveAbortB);
    const [appended] = await appendAndPublishEvents(dbClient.db, bus, workspaceId, session.id, [
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
    const workspaceId = await defaultWorkspaceId(app);
    const response = await app.request(workspacePath(workspaceId, "/github/app"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      missing: string[];
    };
    expect(body.configured).toBe(false);
    expect(body.missing.length).toBeGreaterThan(0);
  });

  test("redirects GitHub install callbacks through OAuth before binding a workspace installation", async () => {
    const stateSecret = "test-github-install-state-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        githubClientId: "test-github-client-id",
        githubAppManifestBaseUrl: "https://staging.app.opengeni.ai",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
    });
    const context = await defaultAccessContext(app);
    const state = createSignedState(stateSecret, {
      accountId: context.defaultAccountId,
      workspaceId: context.defaultWorkspaceId,
    });

    const rejected = await app.request(
      `/v1/github/install/callback?installation_id=138826628&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("invalid or expired GitHub installation browser state");

    const response = await app.request(
      `/v1/github/install/callback?installation_id=138826628&setup_action=install&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: `opengeni_github_state=${state}` },
      },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    const redirect = new URL(location!);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(redirect.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      "https://staging.app.opengeni.ai/v1/github/oauth/callback",
    );
    const oauthState = redirect.searchParams.get("state");
    expect(oauthState).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain(`opengeni_github_state=${oauthState}`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
    const payload = readSignedState(oauthState!, stateSecret);
    expect(payload).toMatchObject({
      accountId: context.defaultAccountId,
      workspaceId: context.defaultWorkspaceId,
      installationId: 138826628,
    });
  });

  test("indexes uploaded files into document bases and searches them", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "network-runbook.txt",
        contentType: "text/plain",
        sizeBytes: 67,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = (await uploadResponse.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };
    const body = "Private endpoint failures are fixed by updating the network policy.";
    await fetch(upload.putUrl, {
      method: "PUT",
      body,
      headers: upload.requiredHeaders,
    });
    expect(
      (
        await app.request(
          workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
          { method: "POST" },
        )
      ).status,
    ).toBe(200);

    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({
        name: "Runbooks",
        description: "Operational docs",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string; name: string };
    expect(base.name).toBe("Runbooks");

    const addResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        body: JSON.stringify({
          fileId: upload.fileId,
          sourceKind: "meeting_transcript",
          sourceUri: "https://meetings.example.test/network-runbook",
          sourceTitle: "Network policy review",
          sourceAuthor: "platform team",
          aclTags: ["platform", "private"],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(addResponse.status).toBe(201);
    const document = (await addResponse.json()) as {
      id: string;
      status: string;
      chunkCount: number;
      sourceKind: string;
      sourceTitle: string | null;
      aclTags: string[];
    };
    expect(document.status).toBe("ready");
    expect(document.chunkCount).toBe(1);
    expect(document.sourceKind).toBe("meeting_transcript");
    expect(document.sourceTitle).toBe("Network policy review");
    expect(document.aclTags).toEqual(["platform", "private"]);

    const readyRetryResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents/${document.id}/reindex`),
      { method: "POST" },
    );
    expect(readyRetryResponse.status).toBe(422);
    expect(await readyRetryResponse.text()).toContain("only failed documents can be retried");

    const listResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
    );
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toHaveLength(1);

    const searchResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/search`),
      {
        method: "POST",
        body: JSON.stringify({
          query: "network policy",
          limit: 3,
          mode: "keyword",
          sourceKinds: ["meeting_transcript"],
          aclTags: ["platform"],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {
      results: Array<{
        text: string;
        title: string;
        matchType: string;
        sourceKind: string;
        aclTags: string[];
      }>;
    };
    expect(search.results[0]?.text).toContain("network policy");
    expect(search.results[0]?.title).toBe("Network policy review");
    expect(search.results[0]?.matchType).toBe("keyword");
    expect(search.results[0]?.sourceKind).toBe("meeting_transcript");
    expect(search.results[0]?.aclTags).toEqual(["platform", "private"]);

    const knowledgeSearchResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/search"),
      {
        method: "POST",
        body: JSON.stringify({
          query: "private endpoint",
          baseIds: [base.id],
          mode: "hybrid",
          aclTags: ["private"],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(knowledgeSearchResponse.status).toBe(200);
    const knowledgeSearch = (await knowledgeSearchResponse.json()) as {
      results: Array<{ text: string }>;
    };
    expect(knowledgeSearch.results[0]?.text).toContain("Private endpoint");

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const fallbackResults = await searchDocuments(
        dbClient.db,
        {
          workspaceId,
          query: "network policy",
          baseIds: [base.id],
          mode: "hybrid",
        },
        {
          embedder: {
            model: DEFAULT_DOCUMENT_EMBEDDING_MODEL,
            dimensions: DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
            embedMany: async () => {
              throw new Error("not used in search");
            },
            embedQuery: async () => {
              throw new Error("embedding unavailable");
            },
          },
        },
      );
      expect(fallbackResults[0]?.matchType).toBe("keyword");
      expect(fallbackResults[0]?.text).toContain("network policy");
      expect(warnings[0]?.[0]).toBe(
        "document hybrid search vector component failed; falling back to keyword search",
      );
      expect(warnings[0]?.[1]).toMatchObject({
        workspaceId,
        error: "embedding unavailable",
      });
    } finally {
      console.warn = originalWarn;
    }

    const readdResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        body: JSON.stringify({
          fileId: upload.fileId,
          sourceKind: "document",
          sourceAuthor: "security team",
          aclTags: ["platform"],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(readdResponse.status).toBe(200);
    const readded = (await readdResponse.json()) as {
      id: string;
      sourceKind: string;
      sourceAuthor: string | null;
      aclTags: string[];
    };
    expect(readded.id).toBe(document.id);
    expect(readded.sourceKind).toBe("document");
    expect(readded.sourceAuthor).toBe("security team");
    expect(readded.aclTags).toEqual(["platform"]);

    const deleteResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents/${document.id}`),
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe("");

    const deletedListResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
    );
    expect(deletedListResponse.status).toBe(200);
    expect(await deletedListResponse.json()).toEqual([]);

    const deletedSearchResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/search`),
      {
        method: "POST",
        body: JSON.stringify({ query: "network policy", limit: 3 }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(deletedSearchResponse.status).toBe(200);
    const deletedSearch = (await deletedSearchResponse.json()) as {
      results: unknown[];
    };
    expect(deletedSearch.results).toEqual([]);

    await expect(requireFile(dbClient.db, workspaceId, upload.fileId)).resolves.toMatchObject({
      id: upload.fileId,
      filename: "network-runbook.txt",
    });

    const missingDeleteResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents/${document.id}`),
      { method: "DELETE" },
    );
    expect(missingDeleteResponse.status).toBe(404);
  });

  test("creates, reviews, and searches workspace knowledge memories", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);

    const proposedResponse = await app.request(workspacePath(workspaceId, "/knowledge/memories"), {
      method: "POST",
      body: JSON.stringify({
        // Explicit `proposed` keeps this the legacy curated-review lane; the
        // default status is now `active` (the memory write gate).
        status: "proposed",
        text: "Use Azure Blob for production object storage.",
        kind: "decision",
        confidence: 0.92,
        sourceRefs: [{ kind: "external", id: "adr-42", title: "ADR 42" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(proposedResponse.status).toBe(201);
    const proposed = (await proposedResponse.json()) as {
      id: string;
      status: string;
      kind: string;
      workspaceId: string;
    };
    expect(proposed.status).toBe("proposed");
    expect(proposed.kind).toBe("decision");
    expect(proposed.workspaceId).toBe(workspaceId);

    const approvedSearchBefore = await app.request(
      workspacePath(workspaceId, "/knowledge/memories?status=approved&query=Azure"),
    );
    expect(approvedSearchBefore.status).toBe(200);
    expect(await approvedSearchBefore.json()).toHaveLength(0);

    const approvedResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${proposed.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "approved", reviewedBy: "operator" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvedResponse.status).toBe(200);
    const approved = (await approvedResponse.json()) as {
      id: string;
      status: string;
      reviewedBy: string | null;
      reviewedAt: string | null;
    };
    expect(approved.id).toBe(proposed.id);
    expect(approved.status).toBe("approved");
    expect(approved.reviewedBy).toBe("operator");
    expect(approved.reviewedAt).toBeTruthy();

    const approvedSearchAfter = await app.request(
      workspacePath(workspaceId, "/knowledge/memories?status=approved&query=Azure"),
    );
    expect(approvedSearchAfter.status).toBe(200);
    const memories = (await approvedSearchAfter.json()) as Array<{
      id: string;
      text: string;
    }>;
    expect(memories[0]?.id).toBe(proposed.id);
    expect(memories[0]?.text).toContain("Azure Blob");

    const invalidLimitResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories?limit=abc"),
    );
    expect(invalidLimitResponse.status).toBe(400);
    const invalidStatusResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories?status=pending"),
    );
    expect(invalidStatusResponse.status).toBe(400);

    const reproposedResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${proposed.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "proposed" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(reproposedResponse.status).toBe(200);
    const reproposed = (await reproposedResponse.json()) as {
      status: string;
      reviewedBy: string | null;
      reviewedAt: string | null;
    };
    expect(reproposed.status).toBe("proposed");
    expect(reproposed.reviewedBy).toBeNull();
    expect(reproposed.reviewedAt).toBeNull();
  });

  test("workspace memory REST lifecycle: create(active)/list/search/pin/archive/edit + settings", async () => {
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);

    // Create defaults to active (memory write gate: sanitized + embedded).
    const createResponse = await app.request(workspacePath(workspaceId, "/knowledge/memories"), {
      method: "POST",
      body: JSON.stringify({
        text: "Staging deploys from main only, via opengeni-ops.",
        kind: "procedural",
        metadata: { source: "rest-lifecycle" },
      }),
      headers: { "content-type": "application/json" },
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      id: string;
      status: string;
      pinned: boolean;
      usageCount: number;
      metadata: Record<string, unknown>;
    };
    expect(created.status).toBe("active");
    expect(created.pinned).toBe(false);
    expect(created.metadata).toMatchObject({
      source: "rest-lifecycle",
      origin: "human",
    });

    // List (active) shows it.
    const listResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories?status=active"),
    );
    expect(listResponse.status).toBe(200);
    expect(
      ((await listResponse.json()) as Array<{ id: string }>).some((m) => m.id === created.id),
    ).toBe(true);

    // Hybrid search finds it and bumps usage.
    const searchResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories/search"),
      {
        method: "POST",
        body: JSON.stringify({ query: "how do we deploy staging" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(searchResponse.status).toBe(200);
    const search = (await searchResponse.json()) as {
      results: Array<{
        memory: { id: string; usageCount: number };
        score: number;
      }>;
    };
    const found = search.results.find((r) => r.memory.id === created.id);
    expect(found).toBeTruthy();
    expect(found!.memory.usageCount).toBe(1);

    // Pin.
    const pinResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${created.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ pinned: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(pinResponse.status).toBe(200);
    expect(((await pinResponse.json()) as { pinned: boolean }).pinned).toBe(true);

    // Edit text: PATCH bypasses dedup only, not sanitization/redaction/hash/embed.
    const editedSecret = "AKIAIOSFODNN7EXAMPLE";
    const editResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${created.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({
          text: `Staging deploys from the release branch now with ${editedSecret}.`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(editResponse.status).toBe(200);
    const edited = (await editResponse.json()) as { text: string };
    expect(edited.text).toContain("release branch");
    expect(edited.text).toContain("[REDACTED]");
    expect(edited.text).not.toContain(editedSecret);
    const [editedRow] = await dbClient.db.execute<{
      textHash: string | null;
      embeddingModel: string | null;
      hasEmbedding: boolean;
    }>(dbSql`
      select text_hash as "textHash", embedding_model as "embeddingModel", embedding is not null as "hasEmbedding"
      from knowledge_memories
      where id = ${created.id}
    `);
    expect(editedRow?.textHash).toBe(hashMemoryText(edited.text));
    expect(editedRow?.embeddingModel).toBeTruthy();
    expect(editedRow?.hasEmbedding).toBe(true);

    // Status transitions into visible memory gate existing text too.
    const activateSecret = "AKIAIOSFODNN7EXAMPLE";
    const proposedActiveResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories"),
      {
        method: "POST",
        body: JSON.stringify({
          status: "proposed",
          text: `Activate this note with ${activateSecret}.`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(proposedActiveResponse.status).toBe(201);
    const proposedActive = (await proposedActiveResponse.json()) as {
      id: string;
    };
    const activatedResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${proposedActive.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(activatedResponse.status).toBe(200);
    const activated = (await activatedResponse.json()) as {
      text: string;
      status: string;
    };
    expect(activated.status).toBe("active");
    expect(activated.text).toContain("[REDACTED]");
    expect(activated.text).not.toContain(activateSecret);
    const [activatedRow] = await dbClient.db.execute<{
      textHash: string | null;
      embeddingModel: string | null;
      hasEmbedding: boolean;
    }>(dbSql`
      select text_hash as "textHash", embedding_model as "embeddingModel", embedding is not null as "hasEmbedding"
      from knowledge_memories
      where id = ${proposedActive.id}
    `);
    expect(activatedRow?.textHash).toBe(hashMemoryText(activated.text));
    expect(activatedRow?.embeddingModel).toBeTruthy();
    expect(activatedRow?.hasEmbedding).toBe(true);

    const approveSecret = "AKIAIOSFODNN7EXAMPLE";
    const proposedApprovedResponse = await app.request(
      workspacePath(workspaceId, "/knowledge/memories"),
      {
        method: "POST",
        body: JSON.stringify({
          status: "proposed",
          text: `Approve this note with ${approveSecret}.`,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(proposedApprovedResponse.status).toBe(201);
    const proposedApproved = (await proposedApprovedResponse.json()) as {
      id: string;
    };
    const approvedTransitionResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${proposedApproved.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "approved" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvedTransitionResponse.status).toBe(200);
    const approvedTransition = (await approvedTransitionResponse.json()) as {
      text: string;
      status: string;
    };
    expect(approvedTransition.status).toBe("approved");
    expect(approvedTransition.text).toContain("[REDACTED]");
    expect(approvedTransition.text).not.toContain(approveSecret);
    const [approvedTransitionRow] = await dbClient.db.execute<{
      textHash: string | null;
      embeddingModel: string | null;
      hasEmbedding: boolean;
    }>(dbSql`
      select text_hash as "textHash", embedding_model as "embeddingModel", embedding is not null as "hasEmbedding"
      from knowledge_memories
      where id = ${proposedApproved.id}
    `);
    expect(approvedTransitionRow?.textHash).toBe(hashMemoryText(approvedTransition.text));
    expect(approvedTransitionRow?.embeddingModel).toBeTruthy();
    expect(approvedTransitionRow?.hasEmbedding).toBe(true);
    for (const id of [proposedActive.id, proposedApproved.id]) {
      const cleanupVisible = await app.request(
        workspacePath(workspaceId, `/knowledge/memories/${id}`),
        {
          method: "PATCH",
          body: JSON.stringify({ status: "archived" }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(cleanupVisible.status).toBe(200);
    }

    // PATCH status into the agent-visible set enforces the workspace cap.
    const cappedResponse = await app.request(workspacePath(workspaceId, "/knowledge/memories"), {
      method: "POST",
      body: JSON.stringify({
        status: "proposed",
        text: "A proposed row to activate at cap.",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(cappedResponse.status).toBe(201);
    const capped = (await cappedResponse.json()) as { id: string };
    try {
      await dbClient.db.execute(dbSql`
        insert into knowledge_memories (account_id, workspace_id, status, kind, scope, text, text_hash)
        select (select account_id from workspaces where id = ${workspaceId}::uuid), ${workspaceId}::uuid,
               'active', 'semantic', 'workspace', 'patch-capfill ' || g, 'patch-caphash-' || g
        from generate_series(1, ${MEMORY_VISIBLE_RECORD_CAP}) as g
      `);
      const activateAtCap = await app.request(
        workspacePath(workspaceId, `/knowledge/memories/${capped.id}`),
        {
          method: "PATCH",
          body: JSON.stringify({ status: "active" }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(activateAtCap.status).toBe(400);
      expect(await activateAtCap.text()).toContain("visible memory is full");
    } finally {
      await dbClient.db.execute(dbSql`
        delete from knowledge_memories
        where workspace_id = ${workspaceId}::uuid
          and (text like 'patch-capfill %' or id = ${capped.id})
      `);
    }

    const archiveResponse = await app.request(
      workspacePath(workspaceId, `/knowledge/memories/${created.id}`),
      {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(archiveResponse.status).toBe(200);
    expect(((await archiveResponse.json()) as { status: string }).status).toBe("archived");
    // Archived rows drop out of search.
    const afterArchive = await app.request(
      workspacePath(workspaceId, "/knowledge/memories/search"),
      {
        method: "POST",
        body: JSON.stringify({ query: "deploy staging" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(
      (
        (await afterArchive.json()) as {
          results: Array<{ memory: { id: string } }>;
        }
      ).results.some((r) => r.memory.id === created.id),
    ).toBe(false);

    // Invalid params → 400 not 500.
    const overLong = await app.request(workspacePath(workspaceId, "/knowledge/memories"), {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(5000) }),
      headers: { "content-type": "application/json" },
    });
    expect(overLong.status).toBe(400);
    const badSearch = await app.request(workspacePath(workspaceId, "/knowledge/memories/search"), {
      method: "POST",
      body: JSON.stringify({ notAQuery: true }),
      headers: { "content-type": "application/json" },
    });
    expect(badSearch.status).toBe(400);

    // Settings default off, PATCH round-trips + preserves unknown keys.
    const beforeSettings = await app.request(workspacePath(workspaceId, ""));
    const workspaceBefore = (await beforeSettings.json()) as {
      settings: Record<string, unknown>;
    };
    expect(workspaceBefore.settings.memoryEnabled ?? false).toBe(false);

    const seedUnknown = await app.request(workspacePath(workspaceId, "/settings"), {
      method: "PATCH",
      body: JSON.stringify({ someFutureKey: "keep-me" }),
      headers: { "content-type": "application/json" },
    });
    expect(seedUnknown.status).toBe(200);
    const enableResponse = await app.request(workspacePath(workspaceId, "/settings"), {
      method: "PATCH",
      body: JSON.stringify({ memoryEnabled: true }),
      headers: { "content-type": "application/json" },
    });
    expect(enableResponse.status).toBe(200);
    const enabled = (await enableResponse.json()) as {
      settings: Record<string, unknown>;
    };
    expect(enabled.settings.memoryEnabled).toBe(true);
    expect(enabled.settings.someFutureKey).toBe("keep-me");
  });

  test("reindex returns queued document state when production indexer enqueues async work", async () => {
    let indexCalls = 0;
    const app = createApp({
      settings: objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentIndexer: {
        indexDocument: async () => {
          indexCalls += 1;
        },
      },
    });
    const workspaceId = await defaultWorkspaceId(app);
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "async-reindex.txt",
        contentType: "text/plain",
        sizeBytes: 13,
      }),
      headers: { "content-type": "application/json" },
    });
    const upload = (await uploadResponse.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };
    await fetch(upload.putUrl, {
      method: "PUT",
      body: "Async reindex",
      headers: upload.requiredHeaders,
    });
    expect(
      (
        await app.request(
          workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
          { method: "POST" },
        )
      ).status,
    ).toBe(200);

    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({ name: "Async reindex docs" }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string };
    const addResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        body: JSON.stringify({ fileId: upload.fileId }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(addResponse.status).toBe(201);
    const document = (await addResponse.json()) as {
      id: string;
      status: string;
      error: string | null;
    };
    expect(document.status).toBe("queued");
    expect(indexCalls).toBe(1);

    await dbClient.db.execute(dbSql`
      update documents
      set status = 'failed', error = 'temporary indexing failure', updated_at = now()
      where workspace_id = ${workspaceId} and id = ${document.id}
    `);
    const reindexResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents/${document.id}/reindex`),
      { method: "POST" },
    );
    expect(reindexResponse.status).toBe(200);
    const reindexed = (await reindexResponse.json()) as {
      id: string;
      status: string;
      error: string | null;
    };
    expect(reindexed.id).toBe(document.id);
    expect(reindexed.status).toBe("queued");
    expect(reindexed.error).toBeNull();
    expect(indexCalls).toBe(2);
  });

  test("document indexing enforces exact chunk limits before embedding", async () => {
    const app = createApp({
      settings: {
        ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({
          maxDocumentIndexedChunksPerWorkspace: 2,
        }),
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, file) => ({
            text: new TextDecoder().decode(bytes),
            metadata: {
              filename: file.filename,
              contentType: file.contentType,
            },
          }),
        },
        chunker: {
          chunk: (parsed, file) =>
            parsed.text.match(/.{1,8}/g)!.map((text, index) => ({
              text,
              metadata: { filename: file.filename, chunkIndex: index },
            })),
        },
        embedder: {
          model: "test-embedder",
          dimensions: 3,
          embedMany: async () => {
            throw new Error("embedder should not run after document chunk cap fails");
          },
          embedQuery: async () => [0, 0, 0],
        },
      },
    });
    const context = await defaultAccessContext(app);
    const workspaceId = context.defaultWorkspaceId!;
    const accountId = context.defaultAccountId!;
    const oversizedBody = "This document is intentionally long enough to become many chunks.";
    const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
      method: "POST",
      body: JSON.stringify({
        filename: "oversized-doc.txt",
        contentType: "text/plain",
        sizeBytes: new TextEncoder().encode(oversizedBody).byteLength,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(uploadResponse.status).toBe(201);
    const upload = (await uploadResponse.json()) as {
      fileId: string;
      uploadId: string;
      putUrl: string;
      requiredHeaders: Record<string, string>;
    };
    await fetch(upload.putUrl, {
      method: "PUT",
      body: oversizedBody,
      headers: upload.requiredHeaders,
    });
    expect(
      (
        await app.request(
          workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
          { method: "POST" },
        )
      ).status,
    ).toBe(200);

    const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
      method: "POST",
      body: JSON.stringify({ name: "Limited docs" }),
      headers: { "content-type": "application/json" },
    });
    expect(baseResponse.status).toBe(201);
    const base = (await baseResponse.json()) as { id: string };
    const usageBefore = await sumUsageQuantity(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });

    const addResponse = await app.request(
      workspacePath(workspaceId, `/document-bases/${base.id}/documents`),
      {
        method: "POST",
        body: JSON.stringify({ fileId: upload.fileId }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(addResponse.status).toBe(201);
    const document = (await addResponse.json()) as {
      status: string;
      chunkCount: number;
      error: string | null;
    };
    expect(document.status).toBe("failed");
    expect(document.chunkCount).toBe(0);
    expect(document.error).toContain("monthly document indexing limit reached (2 chunks)");
    const usageAfter = await sumUsageQuantity(dbClient.db, {
      accountId,
      workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });
    expect(usageAfter).toBe(usageBefore);
  });

  test("serves indexed documents through the built-in MCP endpoint", async () => {
    const appSettings = {
      ...objectStorageSettings(services.databaseUrl, services.objectStorageEndpoint!),
      delegationSecret: "test-delegation-secret",
    };
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const mcpApp = createApp({
      settings: {
        ...appSettings,
        productAccessMode: "configured",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: mcpApp.fetch,
    });
    const settings = {
      ...appSettings,
      mcpServers: [
        {
          id: "docs",
          name: "Document Search",
          url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp/docs`,
          allowedTools: [
            "search_documents",
            "fetch_document_chunk",
            "list_document_bases",
            "memory_propose",
          ],
          timeoutMs: undefined,
          cacheToolsList: false,
        },
        {
          id: "files",
          name: "Files",
          url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
          allowedTools: ["files_get_download_url"],
          timeoutMs: undefined,
          cacheToolsList: false,
        },
      ],
    };
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const access = await defaultAccessContext(app);
      const workspaceId = access.defaultWorkspaceId!;
      const accountId = access.defaultAccountId!;
      const serverSession = await createSession(dbClient.db, {
        accountId,
        workspaceId,
        initialMessage: "server-attributed docs MCP session",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const forgedSession = await createSession(dbClient.db, {
        accountId,
        workspaceId,
        initialMessage: "forged attribution target",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const uploadResponse = await app.request(workspacePath(workspaceId, "/files/uploads"), {
        method: "POST",
        body: JSON.stringify({
          filename: "mcp-runbook.txt",
          contentType: "text/plain",
          sizeBytes: 60,
        }),
        headers: { "content-type": "application/json" },
      });
      const upload = (await uploadResponse.json()) as {
        fileId: string;
        uploadId: string;
        putUrl: string;
        requiredHeaders: Record<string, string>;
      };
      await fetch(upload.putUrl, {
        method: "PUT",
        body: "MCP document search returns private endpoint runbook chunks.",
        headers: upload.requiredHeaders,
      });
      expect(
        (
          await app.request(
            workspacePath(workspaceId, `/files/uploads/${upload.uploadId}/complete`),
            { method: "POST" },
          )
        ).status,
      ).toBe(200);
      const baseResponse = await app.request(workspacePath(workspaceId, "/document-bases"), {
        method: "POST",
        body: JSON.stringify({ name: "MCP Runbooks" }),
        headers: { "content-type": "application/json" },
      });
      const base = (await baseResponse.json()) as { id: string };
      expect(
        (
          await app.request(workspacePath(workspaceId, `/document-bases/${base.id}/documents`), {
            method: "POST",
            body: JSON.stringify({ fileId: upload.fileId }),
            headers: { "content-type": "application/json" },
          })
        ).status,
      ).toBe(201);

      prepared = await prepareAgentTools(
        settings,
        [
          { kind: "mcp", id: "docs" },
          { kind: "mcp", id: "files" },
        ],
        {
          accountId,
          workspaceId,
          sessionId: serverSession.id,
          subjectId: "test:mcp-client",
        },
      );
      const docsServer = prepared.mcpServers[0]!;
      const filesServer = prepared.mcpServers[1]!;
      const docTools = await docsServer.listTools();
      expect(docTools.map((tool) => tool.name)).toContain("docs__search_documents");
      const fileTools = await filesServer.listTools();
      expect(fileTools.map((tool) => tool.name)).toEqual(["files__files_get_download_url"]);

      const result = await docsServer.callTool("docs__search_documents", {
        query: "private endpoint",
        baseIds: [base.id],
        limit: 3,
      });
      expect(JSON.stringify(result)).toContain("private endpoint runbook");

      const proposedMemory = JSON.parse(
        mcpText(
          await docsServer.callTool("docs__memory_propose", {
            text: "Private endpoint MCP memory should be reviewed.",
            kind: "decision",
            createdBySessionId: forgedSession.id,
          }),
        ),
      ) as { text: string; createdBySessionId: string | null };
      expect(proposedMemory.text).toBe("Private endpoint MCP memory should be reviewed.");
      expect(proposedMemory.createdBySessionId).toBe(serverSession.id);
      expect(proposedMemory.createdBySessionId).not.toBe(forgedSession.id);

      const downloadResult = await filesServer.callTool("files__files_get_download_url", {
        fileId: upload.fileId,
      });
      const downloadPayload = JSON.parse(mcpText(downloadResult)) as {
        file: { id: string; filename: string };
        downloadUrl: { url: string };
      };
      expect(downloadPayload.file).toMatchObject({
        id: upload.fileId,
        filename: "mcp-runbook.txt",
      });
      const downloaded = await fetch(downloadPayload.downloadUrl.url);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toContain("private endpoint runbook");

      const pendingUploadResponse = await app.request(
        workspacePath(workspaceId, "/files/uploads"),
        {
          method: "POST",
          body: JSON.stringify({
            filename: "pending-mcp.txt",
            contentType: "text/plain",
            sizeBytes: 7,
          }),
          headers: { "content-type": "application/json" },
        },
      );
      const pendingUpload = (await pendingUploadResponse.json()) as {
        fileId: string;
      };
      expect(
        mcpText(
          await filesServer.callTool("files__files_get_download_url", {
            fileId: pendingUpload.fileId,
          }),
        ),
      ).toContain("file is pending_upload");
      expect(
        mcpText(
          await filesServer.callTool("files__files_get_download_url", {
            fileId: crypto.randomUUID(),
          }),
        ),
      ).toContain("File not found");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("exposes workspace memory tools through first-party MCP only when enabled and session-bound", async () => {
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
    });
    const documentServices = createDocumentServices(appSettings);
    const mcpApp = createApp({
      settings: {
        ...appSettings,
        productAccessMode: "configured",
      },
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      documentServices,
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: mcpApp.fetch,
    });
    const settings = {
      ...appSettings,
      mcpServers: [
        {
          id: "opengeni",
          name: "OpenGeni",
          url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
          allowedTools: ["memory_search", "memory_save", "memory_correct"],
          timeoutMs: undefined,
          cacheToolsList: false,
        },
      ],
    };
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const grant = await bootstrapMcpGrant(dbClient.db);
      const workspaceId = grant.workspaceId;
      const accountId = grant.accountId;
      const session = await createSession(dbClient.db, {
        accountId,
        workspaceId,
        initialMessage: "workspace memory MCP session",
        resources: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });

      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
        accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: "test:mcp-memory-disabled",
      });
      expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([]);
      await prepared.close();
      prepared = null;

      await updateWorkspaceSettings(dbClient.db, workspaceId, {
        memoryEnabled: true,
      });

      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
        accountId,
        workspaceId,
        subjectId: "test:mcp-memory-sessionless",
      });
      expect((await prepared.mcpServers[0]!.listTools()).map((tool) => tool.name)).toEqual([]);
      await prepared.close();
      prepared = null;

      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
        accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: "test:mcp-memory-enabled",
      });
      const memoryTools = (await prepared.mcpServers[0]!.listTools())
        .map((tool) => tool.name)
        .sort();
      expect(memoryTools).toEqual([
        "opengeni__memory_correct",
        "opengeni__memory_save",
        "opengeni__memory_search",
      ]);

      const saved = JSON.parse(
        mcpText(
          await prepared.mcpServers[0]!.callTool("opengeni__memory_save", {
            text: "Staging deploys from main only, via opengeni-ops.",
            kind: "procedural",
            confidence: 0.91,
          }),
        ),
      ) as {
        memory: {
          id: string;
          status: string;
          kind: string;
          createdBySessionId: string | null;
          metadata: Record<string, unknown>;
        };
        deduped: boolean;
      };
      expect(saved.deduped).toBe(false);
      expect(saved.memory).toMatchObject({
        status: "active",
        kind: "procedural",
        createdBySessionId: session.id,
        metadata: { origin: "agent" },
      });
      expect(await getKnowledgeMemory(dbClient.db, workspaceId, saved.memory.id)).toMatchObject({
        id: saved.memory.id,
        status: "active",
        createdBySessionId: session.id,
        metadata: { origin: "agent" },
      });

      const saveEvents = (await listSessionEvents(dbClient.db, workspaceId, session.id)).filter(
        (event) => event.type === "memory.saved",
      );
      expect(saveEvents).toHaveLength(1);
      expect(saveEvents[0]?.payload).toMatchObject({
        memoryId: saved.memory.id,
        kind: "procedural",
        preview: "Staging deploys from main only, via opengeni-ops.",
      });
      expect(
        ((saveEvents[0]?.payload as { preview?: string } | undefined)?.preview ?? "").length,
      ).toBeLessThanOrEqual(120);

      const search = JSON.parse(
        mcpText(
          await prepared.mcpServers[0]!.callTool("opengeni__memory_search", {
            query: "how does staging deploy",
            limit: 3,
          }),
        ),
      ) as {
        results: Array<{
          memory: { id: string; usageCount: number };
          score: number;
          matchType: string;
        }>;
      };
      expect(search.results[0]?.memory.id).toBe(saved.memory.id);
      expect(search.results[0]!.score).toBeGreaterThan(0);
      expect(search.results[0]!.memory.usageCount).toBe(1);

      const superseded = JSON.parse(
        mcpText(
          await prepared.mcpServers[0]!.callTool("opengeni__memory_correct", {
            id: saved.memory.id.slice(0, 8),
            reason: "Deployment branch changed",
            replacement_text: "Staging deploys from release only, via opengeni-ops.",
          }),
        ),
      ) as {
        action: string;
        memory: { id: string; status: string };
        replacement: { id: string; status: string } | null;
      };
      expect(superseded.action).toBe("superseded");
      expect(superseded.memory.id).toBe(saved.memory.id);
      expect(superseded.replacement?.status).toBe("active");
      expect(await getKnowledgeMemory(dbClient.db, workspaceId, saved.memory.id)).toMatchObject({
        status: "superseded",
        supersededById: superseded.replacement!.id,
      });

      const archived = JSON.parse(
        mcpText(
          await prepared.mcpServers[0]!.callTool("opengeni__memory_correct", {
            id: superseded.replacement!.id,
            reason: "Staging deploy process moved into a runbook.",
          }),
        ),
      ) as {
        action: string;
        memory: { id: string; status: string };
        replacement: null;
      };
      expect(archived.action).toBe("archived");
      expect(archived.memory.status).toBe("archived");
      expect(
        await getKnowledgeMemory(dbClient.db, workspaceId, superseded.replacement!.id),
      ).toMatchObject({ status: "archived" });

      const correctionEvents = (
        await listSessionEvents(dbClient.db, workspaceId, session.id)
      ).filter((event) => event.type === "memory.corrected");
      expect(correctionEvents).toHaveLength(2);
      expect(correctionEvents[0]?.payload).toMatchObject({
        memoryId: saved.memory.id,
        action: "superseded",
        reason: "Deployment branch changed",
        replacementMemoryId: superseded.replacement!.id,
      });
      expect(correctionEvents[1]?.payload).toMatchObject({
        memoryId: superseded.replacement!.id,
        action: "archived",
        reason: "Staging deploy process moved into a runbook.",
      });
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("manages workspace environments with write-only values", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const name = `staging-${crypto.randomUUID()}`;
    const createdResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "staging secrets",
        variables: [
          { name: "API_TOKEN", value: "tok-write-only-123456" },
          { name: "DB_PASSWORD", value: "p4ssw0rd-write-only" },
        ],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      variables: Array<{ name: string; version: number }>;
    };
    expect(created.name).toBe(name);
    expect(created.variables.map((variable) => variable.name).sort()).toEqual([
      "API_TOKEN",
      "DB_PASSWORD",
    ]);
    expect(created.variables.every((variable) => variable.version === 1)).toBe(true);
    expect(JSON.stringify(created)).not.toContain("tok-write-only-123456");
    expect(JSON.stringify(created)).not.toContain("p4ssw0rd-write-only");

    const reserved = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `reserved-${crypto.randomUUID()}`,
        variables: [{ name: "GH_TOKEN", value: "stolen-platform-token" }],
      }),
    });
    expect(reserved.status).toBe(422);
    expect(await reserved.text()).toContain("reserved environment variable name: GH_TOKEN");

    const duplicate = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(duplicate.status).toBe(409);

    const listed = await app.request(workspacePath(workspaceId, "/environments"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as Array<{ id: string }>;
    expect(listedBody.some((environment) => environment.id === created.id)).toBe(true);
    expect(JSON.stringify(listedBody)).not.toContain("tok-write-only-123456");
    const canonicalListed = await app.request(workspacePath(workspaceId, "/variable-sets"));
    expect(canonicalListed.status).toBe(200);
    const canonicalListedBody = (await canonicalListed.json()) as Array<{
      id: string;
    }>;
    expect(canonicalListedBody).toEqual(listedBody);

    const rotated = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/API_TOKEN`),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "tok-rotated-654321" }),
      },
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      name: string;
      version: number;
    };
    expect(rotatedBody).toMatchObject({ name: "API_TOKEN", version: 2 });
    expect(JSON.stringify(rotatedBody)).not.toContain("tok-rotated-654321");

    const storedRows = await dbClient.db.execute(dbSql<{
      value_encrypted: string;
    }>`
      select value_encrypted from workspace_variable_set_variables
      where variable_set_id = ${created.id} and name = 'API_TOKEN'
    `);
    expect(storedRows[0]?.value_encrypted).toStartWith("v1:");
    expect(storedRows[0]?.value_encrypted).not.toContain("tok-rotated-654321");

    const renamed = await app.request(workspacePath(workspaceId, `/environments/${created.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${name}-renamed`, description: null }),
    });
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { name: string; description: string | null }).description,
    ).toBeNull();

    const deletedVariable = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/DB_PASSWORD`),
      { method: "DELETE" },
    );
    expect(deletedVariable.status).toBe(200);
    const deletedAgain = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}/variables/DB_PASSWORD`),
      { method: "DELETE" },
    );
    expect(deletedAgain.status).toBe(404);

    const missing = await app.request(
      workspacePath(workspaceId, `/environments/${crypto.randomUUID()}`),
    );
    expect(missing.status).toBe(404);

    const audited = await dbClient.db.execute(dbSql<{ count: string }>`
      select count(*)::text as count from audit_events
      where target_id = ${created.id} and action like 'variable_set.%'
    `);
    expect(Number(audited[0]?.count ?? 0)).toBeGreaterThanOrEqual(4);
    const auditedPayloads = await dbClient.db.execute(dbSql<{
      metadata: unknown;
    }>`
      select metadata from audit_events where target_id = ${created.id}
    `);
    expect(JSON.stringify(auditedPayloads)).not.toContain("tok-rotated-654321");

    const deletedEnvironment = await app.request(
      workspacePath(workspaceId, `/environments/${created.id}`),
      { method: "DELETE" },
    );
    expect(deletedEnvironment.status).toBe(200);
  });

  test("returns 503 for environment writes and attachments without the encryption key", async () => {
    const app = createApp({
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const createResponse = await app.request(workspacePath(workspaceId, "/environments"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `nokey-${crypto.randomUUID()}` }),
    });
    expect(createResponse.status).toBe(503);
    expect(await createResponse.text()).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(sessionResponse.status).toBe(503);
  });

  test("attaches environments to sessions at creation with names-only events", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {
      variables: [{ name: "SERVICE_TOKEN", value: "session-secret-abcdef" }],
    });

    const unknownAttachment = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(unknownAttachment.status).toBe(422);
    expect(await unknownAttachment.text()).toContain("unknown variableSetId");

    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: environment.id,
      }),
    });
    expect(sessionResponse.status).toBe(202);
    const session = (await sessionResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(session.environmentId).toBe(environment.id);

    const events = await listSessionEvents(dbClient.db, workspaceId, session.id);
    const createdEvent = events.find((event) => event.type === "session.created");
    expect(createdEvent?.payload).toMatchObject({
      variableSetId: environment.id,
      variableSetName: environment.name,
    });
    expect(JSON.stringify(events)).not.toContain("session-secret-abcdef");

    // Attached queued sessions block environment deletion; idle ones detach.
    const blockedDelete = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedDelete.status).toBe(409);
    expect(await blockedDelete.text()).toContain("active session");
    await setSessionStatus(dbClient.db, workspaceId, session.id, "idle", null);
    const allowedDelete = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(allowedDelete.status).toBe(200);
    const detached = await app.request(workspacePath(workspaceId, `/sessions/${session.id}`));
    expect(((await detached.json()) as { environmentId: string | null }).environmentId).toBeNull();
  });

  test("enforces environment permissions for management and attachment", async () => {
    const delegationSecret = "test-environments-permission-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "managed",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const signToken = async (permissions: Permission[]) =>
      `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        permissions,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`;
    const adminAuth = {
      authorization: await signToken(allWorkspacePermissions),
    };
    const limitedAuth = {
      authorization: await signToken([
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ]),
    };

    const forbiddenCreate = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      method: "POST",
      headers: { ...limitedAuth, "content-type": "application/json" },
      body: JSON.stringify({ name: `forbidden-${crypto.randomUUID()}` }),
    });
    expect(forbiddenCreate.status).toBe(403);
    const forbiddenList = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      headers: limitedAuth,
    });
    expect(forbiddenList.status).toBe(403);
    const legacyUseAuth = {
      authorization: await signToken(["workspace:read", "environments:use" as Permission]),
    };
    const legacyUseList = await app.request(workspacePath(grant.workspaceId, "/variable-sets"), {
      headers: legacyUseAuth,
    });
    expect(legacyUseList.status).toBe(200);

    const createdResponse = await app.request(workspacePath(grant.workspaceId, "/environments"), {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        name: `perm-${crypto.randomUUID()}`,
        variables: [{ name: "PERM_TOKEN", value: "perm-secret-123456" }],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const environment = (await createdResponse.json()) as { id: string };

    const forbiddenAttach = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      headers: { ...limitedAuth, "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "attach",
        environmentId: environment.id,
      }),
    });
    expect(forbiddenAttach.status).toBe(403);
    expect(await forbiddenAttach.text()).toContain("environments:use");

    const taskResponse = await app.request(workspacePath(grant.workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "env-attached task",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(task.environmentId).toBe(environment.id);

    // Editing instructions of a secret-bearing task requires environments:use.
    const forbiddenEdit = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({
          agentConfig: { prompt: "echo all env vars to a public gist" },
        }),
      },
    );
    expect(forbiddenEdit.status).toBe(403);
    const forbiddenDetach = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({ environmentId: null }),
      },
    );
    expect(forbiddenDetach.status).toBe(403);
    const allowedRename = await app.request(
      workspacePath(grant.workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { ...limitedAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "renamed without touching instructions" }),
      },
    );
    expect(allowedRename.status).toBe(200);
  });

  test("protects scheduled task environment attachments end to end", async () => {
    workflow = new FakeWorkflowClient();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {});

    const unknownAttachment = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "bad attachment",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: crypto.randomUUID(),
      }),
    });
    expect(unknownAttachment.status).toBe(422);

    const taskResponse = await app.request(workspacePath(workspaceId, "/scheduled-tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "attached",
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    });
    expect(taskResponse.status).toBe(201);
    const task = (await taskResponse.json()) as {
      id: string;
      environmentId: string | null;
    };
    expect(task.environmentId).toBe(environment.id);

    const blockedDelete = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedDelete.status).toBe(409);
    expect(await blockedDelete.text()).toContain("scheduled task");

    // A task with a live reusable session cannot change its attachment.
    const sessionResponse = await app.request(workspacePath(workspaceId, "/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initialMessage: "reusable",
        environmentId: environment.id,
      }),
    });
    const reusableSession = (await sessionResponse.json()) as { id: string };
    await updateScheduledTask(dbClient.db, workspaceId, task.id, {
      runMode: "reusable_session",
      reusableSessionId: reusableSession.id,
    });
    const blockedDetach = await app.request(
      workspacePath(workspaceId, `/scheduled-tasks/${task.id}`),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: null }),
      },
    );
    expect(blockedDetach.status).toBe(409);
    expect(await blockedDetach.text()).toContain("reusable session");

    // The reviewer-flagged scenario: an idle reusable session cannot be
    // silently detached because the task's own RESTRICT-backed attachment
    // still blocks deletion regardless of session status.
    await setSessionStatus(dbClient.db, workspaceId, reusableSession.id, "idle", null);
    const blockedWhileTaskAttached = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(blockedWhileTaskAttached.status).toBe(409);
    expect(await blockedWhileTaskAttached.text()).toContain("scheduled task");

    await updateScheduledTask(dbClient.db, workspaceId, task.id, {
      runMode: "new_session_per_run",
      reusableSessionId: null,
    });
    const detach = await app.request(workspacePath(workspaceId, `/scheduled-tasks/${task.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environmentId: null }),
    });
    expect(detach.status).toBe(200);
    expect(((await detach.json()) as { environmentId: string | null }).environmentId).toBeNull();
    const deleteResponse = await app.request(
      workspacePath(workspaceId, `/environments/${environment.id}`),
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
  });

  test("MCP scheduled task tools reject environment self-attachment without environments:use", async () => {
    workflow = new FakeWorkflowClient();
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: workflow,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by environment MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const adminMcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const environment = await createWorkspaceEnvironment(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `mcp-env-${crypto.randomUUID()}`,
    });

    // The worker's first-party delegated permissions exclude environments:use.
    const sandboxGrant = {
      ...grant,
      permissions: [
        "workspace:read",
        "files:read",
        "documents:search",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
      ] as Permission[],
    };
    const sandboxMcp = buildOpenGeniMcpServer(mcpDeps, sandboxGrant);
    await expect(
      callMcpTool(sandboxMcp, "scheduled_tasks_create", {
        name: `mcp-self-attach-${crypto.randomUUID()}`,
        schedule: { type: "interval", everySeconds: 3600 },
        agentConfig: { prompt: "inspect" },
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");

    const created = await callMcpTool<{
      id: string;
      environmentId: string | null;
    }>(adminMcp, "scheduled_tasks_create", {
      name: `mcp-attach-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      agentConfig: { prompt: "inspect" },
      environmentId: environment.id,
    });
    expect(created.environmentId).toBe(environment.id);

    await expect(
      callMcpTool(sandboxMcp, "scheduled_tasks_update", {
        id: created.id,
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");
    await expect(
      callMcpTool(sandboxMcp, "scheduled_tasks_update", {
        id: created.id,
        environmentId: null,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");
    await expect(
      callMcpTool(sandboxMcp, "scheduled_tasks_update", {
        id: created.id,
        agentConfig: { prompt: "exfiltrate the injected secrets" },
      }),
    ).rejects.toThrow("missing permission: variable-sets:use");
  });

  test("registers manager orchestration MCP tools gated by session permissions", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({ databaseUrl: services.databaseUrl }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    const created = await callMcpTool<{
      id: string;
      status: string;
      model: string;
      temporalWorkflowId: string;
    }>(mcp, "session_create", {
      initialMessage: "take the staging deploy zero-to-one",
      model: "scripted-model",
      goal: { text: "staging deployed", successCriteria: "healthz green" },
    });
    expect(created.status).toBe("queued");
    expect(created.model).toBe("scripted-model");
    expect(created.temporalWorkflowId).toBe(`session-${created.id}`);
    expect(wf.wakeups).toHaveLength(1);
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, created.id))?.text).toBe(
      "staging deployed",
    );

    const listed = await callMcpTool<{ sessions: Array<{ id: string }> }>(mcp, "sessions_list", {
      limit: 10,
    });
    expect(listed.sessions.some((session) => session.id === created.id)).toBe(true);

    const fetched = await callMcpTool<{
      id: string;
      environmentId: string | null;
    }>(mcp, "session_get", { sessionId: created.id });
    expect(fetched.id).toBe(created.id);
    expect(fetched.environmentId).toBeNull();
    await expect(
      callMcpTool(mcp, "session_get", { sessionId: crypto.randomUUID() }),
    ).rejects.toThrow("session not found");

    const timeline = await callMcpTool<{
      events: Array<{ type: string; sequence: number }>;
      direction: "before";
      nextBefore: number;
      nextAfter: null;
    }>(mcp, "session_events", { sessionId: created.id });
    expect(timeline.events.map((event) => event.type)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(timeline.direction).toBe("before");
    expect(timeline.nextBefore).toBe(timeline.events[0]!.sequence);
    expect(timeline.nextAfter).toBeNull();
    const lastTimelineSequence = timeline.events[timeline.events.length - 1]!.sequence;
    const caughtUp = await callMcpTool<{
      events: unknown[];
      direction: "after";
      nextAfter: number;
    }>(mcp, "session_events", {
      sessionId: created.id,
      after: lastTimelineSequence,
    });
    expect(caughtUp.events).toHaveLength(0);
    expect(caughtUp.direction).toBe("after");
    expect(caughtUp.nextAfter).toBe(lastTimelineSequence);

    const appended = await appendSessionEvents(dbClient.db, grant.workspaceId, created.id, [
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "agent.message.completed" as const,
        payload: { index, text: "x".repeat(7_000) },
      })),
      {
        type: "turn.completed" as const,
        payload: { result: "stale" },
        turnGeneration: 1,
      },
      {
        type: "turn.completed" as const,
        payload: { result: "authoritative" },
        turnGeneration: 2,
      },
    ]);
    const latestTerminal = await callMcpTool<{
      events: Array<{
        sequence: number;
        type: string;
        turnGeneration: number | null;
        payload: { result: string };
      }>;
    }>(mcp, "session_events", { sessionId: created.id, latest: "terminal" });
    expect(latestTerminal.events).toEqual([
      expect.objectContaining({
        sequence: appended.at(-1)!.sequence,
        type: "turn.completed",
        turnGeneration: 2,
        payload: { result: "authoritative" },
      }),
    ]);

    const boundedForensic = await callMcpTool<{
      events: Array<{ id: string; sequence: number }>;
      direction: "after";
      nextAfter: number;
      hasMore: boolean;
      truncated: boolean;
      truncation: { reasons: string[]; resumeCursor: number };
      bytes: number;
      maxBytes: number;
    }>(mcp, "session_events", {
      sessionId: created.id,
      after: lastTimelineSequence,
      mode: "forensic",
      payloadMode: "full",
      limit: 40,
    });
    expect(boundedForensic.bytes).toBe(
      Buffer.byteLength(JSON.stringify(boundedForensic, null, 2), "utf8"),
    );
    expect(boundedForensic.bytes).toBeLessThanOrEqual(boundedForensic.maxBytes);
    expect(boundedForensic.maxBytes).toBe(64 * 1024);
    expect(boundedForensic.hasMore).toBeTrue();
    expect(boundedForensic.truncated).toBeTrue();
    expect(boundedForensic.truncation.reasons).toEqual(
      expect.arrayContaining(["model_payload", "model_bytes"]),
    );
    expect(boundedForensic.nextAfter).toBe(boundedForensic.events.at(-1)!.sequence);
    expect(boundedForensic.truncation.resumeCursor).toBe(boundedForensic.nextAfter);
    expect(
      boundedForensic.events.every((event) => event.id !== "00000000-0000-0000-0000-000000000000"),
    ).toBeTrue();

    const sent = await callMcpTool<{
      event: { type: string; payload: { text: string } };
      turnId: string;
    }>(mcp, "session_send_message", {
      sessionId: created.id,
      text: "also enable the health alerts",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(sent.event.type).toBe("user.message");
    expect(sent.event.payload.text).toBe("also enable the health alerts");
    expect(wf.wakeups).toHaveLength(2);
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, created.id);
    expect(turns.some((turn) => turn.id === sent.turnId && turn.status === "queued")).toBe(true);

    const callerAttemptId = crypto.randomUUID();
    const callerClaim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: created.id,
      workflowId: `session-${created.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: callerAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (callerClaim.action !== "claimed") {
      throw new Error(`manager MCP caller was not claimed: ${callerClaim.reason}`);
    }
    const workerMcpWithIdentity = buildOpenGeniMcpServer(mcpDeps, {
      ...grant,
      metadata: {
        delegated: true,
        sessionId: created.id,
        turnId: callerClaim.turn.id,
        attemptId: callerAttemptId,
        executionGeneration: callerClaim.turn.executionGeneration,
      },
    });
    const beforeInternalTurnIds = (
      await listSessionTurns(dbClient.db, grant.workspaceId, created.id)
    )
      .map((turn) => turn.id)
      .sort();
    const internal = await callMcpTool<{
      delivered: boolean;
      updateId: string;
      delivery: string;
    }>(workerMcpWithIdentity, "session_send_message", {
      sessionId: created.id,
      text: "child result one of several",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(internal).toMatchObject({
      delivered: true,
      delivery: "coalesced_internal_update",
    });
    expect(
      (await listSessionTurns(dbClient.db, grant.workspaceId, created.id))
        .map((turn) => turn.id)
        .sort(),
    ).toEqual(beforeInternalTurnIds);
    expect(
      await listOutstandingSessionSystemUpdates(dbClient.db, grant.workspaceId, created.id),
    ).toEqual([
      expect.objectContaining({
        id: internal.updateId,
        kind: "agent_message",
        sourceId: created.id,
        summary: "child result one of several",
      }),
    ]);

    // Agent MCP owns the same recursive Pause/Resume plane as the UI. A live
    // descendant attempt receives an immediate revisioned control wake; Resume
    // creates no human prompt, and Agent Steer is one typed internal update
    // rather than a fake prompt-queue row.
    const controlledChild = await callMcpTool<{ id: string }>(
      workerMcpWithIdentity,
      "session_create",
      {
        initialMessage: "wait for manager control",
        model: "scripted-model",
      },
    );
    const childAttemptId = crypto.randomUUID();
    const childClaim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: controlledChild.id,
      workflowId: `session-${controlledChild.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: childAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (childClaim.action !== "claimed") {
      throw new Error(`controlled child was not claimed: ${childClaim.reason}`);
    }
    const dispatchCountBeforeAgentPause = wf.wakeDispatches;
    const agentPause = await callMcpTool<{
      effectiveControl: { state: string };
      interruptionCount: number;
    }>(workerMcpWithIdentity, "session_pause", {
      sessionId: controlledChild.id,
      idempotencyKey: crypto.randomUUID(),
      reason: "manager inspection",
    });
    expect(agentPause).toMatchObject({
      effectiveControl: { state: "paused" },
      interruptionCount: 1,
    });
    expect(wf.wakeDispatches).toBe(dispatchCountBeforeAgentPause + 1);
    const turnsBeforeAgentResume = await listSessionTurns(
      dbClient.db,
      grant.workspaceId,
      controlledChild.id,
    );
    const agentResume = await callMcpTool<{
      effectiveControl: { state: string };
    }>(workerMcpWithIdentity, "session_resume", {
      sessionId: controlledChild.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(agentResume.effectiveControl.state).toBe("active");
    expect(
      (await listSessionTurns(dbClient.db, grant.workspaceId, controlledChild.id)).map(
        (turn) => turn.id,
      ),
    ).toEqual(turnsBeforeAgentResume.map((turn) => turn.id));
    const agentSteer = await callMcpTool<{
      updateId: string;
      interruptionCount: number;
    }>(workerMcpWithIdentity, "session_steer", {
      sessionId: controlledChild.id,
      instruction: "Inspect the new control-plane evidence first",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(agentSteer).toMatchObject({
      updateId: expect.any(String),
      interruptionCount: 1,
    });
    expect(
      await listOutstandingSessionSystemUpdates(dbClient.db, grant.workspaceId, controlledChild.id),
    ).toContainEqual(
      expect.objectContaining({
        id: agentSteer.updateId,
        kind: "agent_steer_instruction",
        summary: "Inspect the new control-plane evidence first",
      }),
    );

    // The sandboxed worker's first-party delegated permission set sees none of
    // the manager tools: orchestration, environments, or the connect link.
    const workerGrant = {
      ...grant,
      permissions: [
        "workspace:read",
        "files:read",
        "documents:search",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
        "goals:manage",
      ] as Permission[],
    };
    const workerMcp = buildOpenGeniMcpServer(mcpDeps, workerGrant);
    for (const tool of [
      "sessions_list",
      "session_get",
      "session_events",
      "session_create",
      "session_send_message",
      "session_pause",
      "session_resume",
      "session_steer",
      "environment_list",
      "environment_set_variable",
      "github_connect_link",
    ]) {
      await expect(callMcpTool(workerMcp, tool, {})).rejects.toThrow("MCP tool not registered");
    }
  });

  test("per-session first-party MCP permissions are capped by the creator and gate the manager tools", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    // Configured access mode: every request authenticates with a delegated
    // bearer token, so the grant the MCP endpoint sees is exactly the token's
    // permission set - the same shape the worker runtime uses live.
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const signToken = async (permissions: Permission[]) =>
      await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: "test:first-party-mcp-permissions",
        permissions,
        exp: Math.floor(Date.now() / 1000) + 300,
      });

    // REST create: the permission set is stored and echoed; the creator must
    // hold every requested permission.
    const managerToken = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "goals:manage",
    ]);
    const createResponse = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "orchestrate the fleet",
        model: "scripted-model",
        firstPartyMcpPermissions: [
          "workspace:read",
          "sessions:read",
          "sessions:create",
          "goals:manage",
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managerToken}`,
      },
    });
    expect(createResponse.status).toBe(202);
    const managerSession = (await createResponse.json()) as {
      id: string;
      firstPartyMcpPermissions: string[] | null;
    };
    expect(managerSession.firstPartyMcpPermissions).toEqual([
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "goals:manage",
    ]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, managerSession.id))
        ?.firstPartyMcpPermissions,
    ).toEqual([
      "workspace:read",
      "sessions:read",
      "sessions:create",
      "goals:manage",
    ] as Permission[]);

    // No escalation: a creator without the permission cannot mint it.
    const limitedToken = await signToken(["workspace:read", "sessions:create"]);
    const escalation = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "try to escalate",
        model: "scripted-model",
        firstPartyMcpPermissions: ["environments:manage"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${limitedToken}`,
      },
    });
    expect(escalation.status).toBe(403);
    expect(await escalation.text()).toContain(
      "cannot grant first-party MCP permission beyond the creating grant: environments:manage",
    );

    // An empty set would sign an unusable zero-permission token; omit the
    // field for the default worker set instead.
    const emptySet = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "empty permission set",
        model: "scripted-model",
        firstPartyMcpPermissions: [],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managerToken}`,
      },
    });
    expect(emptySet.status).toBe(422);
    expect(await emptySet.text()).toContain("firstPartyMcpPermissions must not be empty");

    // Same rule through the MCP session_create tool: a manager can only
    // delegate a subset of what it was itself granted.
    const mcpDeps = {
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const managerGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create", "sessions:read"] as Permission[],
    };
    const managerMcp = buildOpenGeniMcpServer(mcpDeps, managerGrant);
    await expect(
      callMcpTool(managerMcp, "session_create", {
        initialMessage: "spawn an over-privileged worker",
        model: "scripted-model",
        firstPartyMcpPermissions: ["environments:manage"],
      }),
    ).rejects.toThrow("cannot grant first-party MCP permission beyond the creating grant");
    const spawned = await callMcpTool<{
      id: string;
      firstPartyMcpPermissions: string[] | null;
      sandboxBackend: string;
    }>(managerMcp, "session_create", {
      initialMessage: "spawn a delegated worker",
      model: "scripted-model",
      sandboxBackend: "none",
      firstPartyMcpPermissions: ["sessions:read"],
    });
    expect(spawned.firstPartyMcpPermissions).toEqual(["sessions:read"]);
    expect(spawned.sandboxBackend).toBe("none");

    // The delegated token the runtime mints for a session's first-party MCP
    // connection carries the session's permission set, which gates manager
    // tool visibility end to end; the default set stays worker-shaped.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let managerPrepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    let workerPrepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const runtimeSettings = {
        ...appSettings,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      };
      managerPrepared = await prepareAgentTools(
        runtimeSettings,
        [{ kind: "mcp", id: "opengeni" }],
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: managerSession.id,
          firstPartyPermissions: [
            "workspace:read",
            "sessions:read",
            "sessions:create",
            "goals:manage",
          ],
        },
      );
      const managerTools = (await managerPrepared.mcpServers[0]!.listTools()).map(
        (tool) => tool.name,
      );
      expect(managerTools).toContain("opengeni__sessions_list");
      expect(managerTools).toContain("opengeni__session_create");
      expect(managerTools).not.toContain("opengeni__set_child_notifications_mode");
      expect(managerTools).not.toContain("opengeni__environment_set_variable");

      workerPrepared = await prepareAgentTools(runtimeSettings, [{ kind: "mcp", id: "opengeni" }], {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: managerSession.id,
      });
      const workerTools = (await workerPrepared.mcpServers[0]!.listTools()).map(
        (tool) => tool.name,
      );
      expect(workerTools).toContain("opengeni__sessions_list");
      expect(workerTools).toContain("opengeni__session_create");
      expect(workerTools).not.toContain("opengeni__set_child_notifications_mode");
      expect(workerTools).toContain("opengeni__environment_set_variable");
      expect(workerTools).toContain("opengeni__scheduled_tasks_list");
      expect(workerTools).not.toContain("opengeni__mcp_servers_attach");
    } finally {
      await managerPrepared?.close().catch(() => undefined);
      await workerPrepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });

  test("per-session MCP servers are attach-gated, sanitized, rotatable credentials", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const signToken = async (permissions: Permission[]) =>
      `Bearer ${await signDelegatedAccessToken(delegationSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: "test:session-mcp-servers",
        permissions,
        exp: Math.floor(Date.now() / 1000) + 300,
      })}`;
    const attachAuth = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "mcp_servers:attach",
    ]);
    const limitedAuth = await signToken([
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);

    const createSecret = "Bearer create-secret";
    const created = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use the crm server",
        model: "scripted-model",
        tools: [{ kind: "mcp", id: "crm" }],
        mcpServers: [
          {
            id: "crm",
            name: "CRM MCP",
            url: "https://crm.example/mcp",
            allowedTools: ["workouts.list"],
            timeoutMs: 2500,
            cacheToolsList: false,
            headers: { Authorization: createSecret },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(created.status).toBe(202);
    const createText = await created.text();
    expect(createText).not.toContain(createSecret);
    const session = JSON.parse(createText) as {
      id: string;
      tools: Array<{ kind: string; id: string }>;
      mcpServers: Array<{
        id: string;
        name: string | null;
        url: string;
        headerNames: string[];
        credentialVersion: number;
        headers?: unknown;
      }>;
    };
    expect(session.tools).toContainEqual({ kind: "mcp", id: "crm" });
    expect(session.mcpServers).toEqual([
      {
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        headerNames: ["Authorization"],
        credentialVersion: 1,
      },
    ]);
    expect(session.mcpServers[0]?.headers).toBeUndefined();

    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    const runServers = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      key,
    );
    expect(runServers[0]?.headers).toEqual({ Authorization: createSecret });
    expect(runServers[0]?.allowedTools).toEqual(["workouts.list"]);
    const rawMcpRows = await dbClient.db.execute(dbSql<{
      headers_encrypted: Record<string, string>;
    }>`
      select headers_encrypted from session_mcp_servers where session_id = ${session.id}
    `);
    expect(JSON.stringify(rawMcpRows)).not.toContain(createSecret);

    const createdEventRows = await dbClient.db.execute(dbSql<{
      payload: unknown;
    }>`
      select payload from session_events where session_id = ${session.id} order by sequence
    `);
    const createdEventsJson = JSON.stringify(createdEventRows);
    expect(createdEventsJson).not.toContain(createSecret);
    expect(createdEventsJson).toContain("headerNames");

    const rotatedSecret = "Bearer rotated-secret";
    const rotated = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "rotate then continue",
            mcpCredentialUpdates: [
              {
                id: "crm",
                headers: { Authorization: rotatedSecret, "X-Turn": "2" },
              },
            ],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(rotated.status).toBe(202);
    const rotatedText = await rotated.text();
    expect(rotatedText).not.toContain(rotatedSecret);
    const accepted = JSON.parse(rotatedText) as {
      payload: {
        mcpCredentialUpdates?: Array<{
          id: string;
          headerNames: string[];
          credentialVersion: number;
          headers?: unknown;
        }>;
      };
    };
    expect(accepted.payload.mcpCredentialUpdates).toBeUndefined();
    const afterRotation = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      key,
    );
    expect(afterRotation[0]?.headers).toEqual({
      Authorization: rotatedSecret,
      "X-Turn": "2",
    });
    expect(afterRotation[0]?.credentialVersion).toBe(2);

    const allEventRows = await dbClient.db.execute(dbSql<{ payload: unknown }>`
      select payload from session_events where session_id = ${session.id} order by sequence
    `);
    const allEventsJson = JSON.stringify(allEventRows);
    expect(allEventsJson).not.toContain(createSecret);
    expect(allEventsJson).not.toContain(rotatedSecret);
    expect(allEventsJson).not.toContain('"headers"');

    const unknown = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "bad rotate",
            mcpCredentialUpdates: [{ id: "unknown", headers: { Authorization: "Bearer nope" } }],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(unknown.status).toBe(422);
    expect(await unknown.text()).toContain("unknown session MCP server id: unknown");

    const deniedRotate = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "denied rotate",
            mcpCredentialUpdates: [{ id: "crm", headers: { Authorization: "Bearer denied" } }],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: limitedAuth,
        },
      },
    );
    expect(deniedRotate.status).toBe(403);
    expect(await deniedRotate.text()).toContain("missing permission: mcp_servers:attach");

    const deniedCreate = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no permission",
        model: "scripted-model",
        mcpServers: [
          {
            id: "denied",
            url: "https://denied.example/mcp",
            headers: { Authorization: "Bearer denied" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: limitedAuth,
      },
    });
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.text()).toContain("missing permission: mcp_servers:attach");

    const collision = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "reserved id",
        model: "scripted-model",
        mcpServers: [
          {
            id: "opengeni",
            url: "https://reserved.example/mcp",
            headers: { Authorization: "Bearer reserved" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(collision.status).toBe(422);
    expect(await collision.text()).toContain("MCP server id already exists: opengeni");

    const appWithoutKey = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const missingKey = await appWithoutKey.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "missing key",
        model: "scripted-model",
        mcpServers: [
          {
            id: "needs_key",
            url: "https://needs-key.example/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(missingKey.status).toBe(503);
    expect(await missingKey.text()).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
  });

  test("toolspace bearer expands to selected session MCP servers, proxies calls, and cannot escalate", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const requiredAuthorization = "Bearer crm-session-secret";
    const upstream = startTestMcpServer({
      requiredHeaders: { authorization: requiredAuthorization },
    });
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
        toolspaceEnabled: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let toolspaceClient: Awaited<ReturnType<typeof prepareToolspaceClient>> | null = null;
    let workspaceClient: Awaited<ReturnType<typeof prepareToolspaceClient>> | null = null;
    try {
      const { session, turnId } = await createToolspaceMcpSession(dbClient.db, grant, {
        url: upstream.url,
        headers: { authorization: requiredAuthorization },
      });
      await dbClient.db.execute(dbSql`
        update workspaces set settings = '{"memoryEnabled":true}'::jsonb where id = ${grant.workspaceId}
      `);
      const mcpUrl = `http://127.0.0.1:${server.port}/v1/workspaces/${grant.workspaceId}/mcp`;
      const toolspaceAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "sandbox:run-proxy",
        permissions: ["toolspace:call"],
        sessionId: session.id,
      });
      toolspaceClient = await prepareToolspaceClient(mcpUrl, toolspaceAuth);

      const listed = await toolspaceClient.mcpServers[0]!.listTools();
      const toolNames = listed.map((tool) => tool.name);
      expect(toolNames).toContain("toolspace__crm__search_documents");
      // Toolspace is a narrowed proxy surface: the bare toolspace:call bearer
      // does not receive unpermissioned first-party session tools, including
      // workspace memory even when the workspace setting is enabled.
      expect(toolNames).not.toContain("set_session_title");
      expect(toolNames).not.toContain("goal_set");
      expect(toolNames).not.toContain("memory_search");
      expect(toolNames).not.toContain("memory_save");
      expect(toolNames).not.toContain("memory_correct");
      expect(toolNames).not.toContain("session_create");
      expect(toolNames).not.toContain("mcp_servers_attach");
      expect(toolNames).not.toContain("environment_set_variable");

      const output = await toolspaceClient.mcpServers[0]!.callTool(
        "toolspace__crm__search_documents",
        { query: "network policy" },
      );
      expect(mcpText(output)).toContain("found document for network policy");
      expect(upstream.calls).toEqual([
        { tool: "search_documents", args: { query: "network policy" } },
      ]);

      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
      const toolspaceEvents = events.filter(
        (event) =>
          event.type === "agent.toolCall.created" || event.type === "agent.toolCall.output",
      );
      expect(toolspaceEvents.map((event) => event.type)).toEqual([
        "agent.toolCall.created",
        "agent.toolCall.output",
      ]);
      expect(toolspaceEvents.every((event) => event.turnId === turnId)).toBe(true);
      const producerRows = await dbClient.db.execute(dbSql<{
        producer_id: string | null;
      }>`
        select producer_id from session_events
        where workspace_id = ${grant.workspaceId}
          and session_id = ${session.id}
          and type in ('agent.toolCall.created', 'agent.toolCall.output')
        order by sequence
      `);
      expect(producerRows.map((row) => row.producer_id)).toEqual([
        "sandbox:run-proxy",
        "sandbox:run-proxy",
      ]);
      expect(
        (
          toolspaceEvents[0]?.payload as {
            origin?: string;
            subjectId?: string;
            raw?: { serverId?: string; toolName?: string };
          }
        )?.origin,
      ).toBe("toolspace");
      expect(
        (
          toolspaceEvents[0]?.payload as {
            origin?: string;
            subjectId?: string;
            raw?: { serverId?: string; toolName?: string };
          }
        )?.subjectId,
      ).toBe("sandbox:run-proxy");
      expect(
        (
          toolspaceEvents[0]?.payload as
            | { raw?: { serverId?: string; toolName?: string } }
            | undefined
        )?.raw,
      ).toEqual({
        type: "toolspace_call",
        serverId: "crm",
        toolName: "search_documents",
      });

      const workspaceAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "test:workspace-mcp",
        permissions: ["workspace:read"],
      });
      workspaceClient = await prepareToolspaceClient(mcpUrl, workspaceAuth);
      const workspaceToolNames = (await workspaceClient.mcpServers[0]!.listTools()).map(
        (tool) => tool.name,
      );
      expect(workspaceToolNames).not.toContain("toolspace__crm__search_documents");

      const missingSessionAuth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "sandbox:no-session",
        permissions: ["toolspace:call"],
      });
      const missingSession = await app.request(workspacePath(grant.workspaceId, "/mcp"), {
        headers: { authorization: missingSessionAuth },
      });
      expect(missingSession.status).toBe(403);

      const restRead = await app.request(
        workspacePath(grant.workspaceId, `/sessions/${session.id}`),
        {
          headers: { authorization: toolspaceAuth },
        },
      );
      expect(restRead.status).toBe(403);

      const attachAttempt = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
        method: "POST",
        body: JSON.stringify({
          initialMessage: "try attach",
          model: "scripted-model",
          mcpServers: [
            {
              id: "denied",
              url: upstream.url,
              headers: { authorization: "Bearer denied" },
            },
          ],
        }),
        headers: {
          "content-type": "application/json",
          authorization: toolspaceAuth,
        },
      });
      expect(attachAttempt.status).toBe(403);
    } finally {
      await toolspaceClient?.close().catch(() => undefined);
      await workspaceClient?.close().catch(() => undefined);
      server.stop(true);
      upstream.close();
    }
  });

  test("toolspace excludes approval-required session MCP tool execution", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const upstream = startTestMcpServer();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
        toolspaceEnabled: true,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let client: Awaited<ReturnType<typeof prepareToolspaceClient>> | null = null;
    try {
      const { session } = await createToolspaceMcpSession(dbClient.db, grant, {
        url: upstream.url,
        requireApproval: ["search_documents"],
      });
      const mcpUrl = `http://127.0.0.1:${server.port}/v1/workspaces/${grant.workspaceId}/mcp`;
      const auth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "sandbox:approval",
        permissions: ["toolspace:call"],
        sessionId: session.id,
      });
      client = await prepareToolspaceClient(mcpUrl, auth);
      const listed = await client.mcpServers[0]!.listTools();
      const search = listed.find((tool) => tool.name === "toolspace__crm__search_documents");
      expect(search?.description).toContain(
        "unavailable: requires approval - invoke via the agent",
      );

      const denied = await rawMcpRequest(mcpUrl, auth, "tools/call", {
        name: "crm__search_documents",
        arguments: { query: "approval path" },
      });
      expect((denied.result as { isError?: boolean }).isError).toBe(true);
      expect(mcpText(denied.result)).toContain("requires approval - invoke via the agent");
      expect(upstream.calls).toEqual([]);
    } finally {
      await client?.close().catch(() => undefined);
      server.stop(true);
      upstream.close();
    }
  });

  test("toolspace enforces the per-turn call budget before proxying", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const upstream = startTestMcpServer();
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
        toolspaceEnabled: true,
        toolspaceMaxCallsPerTurn: 1,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    let client: Awaited<ReturnType<typeof prepareToolspaceClient>> | null = null;
    try {
      const { session } = await createToolspaceMcpSession(dbClient.db, grant, {
        url: upstream.url,
      });
      const mcpUrl = `http://127.0.0.1:${server.port}/v1/workspaces/${grant.workspaceId}/mcp`;
      const auth = await signDelegatedBearer(delegationSecret, grant, {
        subjectId: "sandbox:budget",
        permissions: ["toolspace:call"],
        sessionId: session.id,
      });
      client = await prepareToolspaceClient(mcpUrl, auth);
      expect(
        mcpText(
          await client.mcpServers[0]!.callTool("toolspace__crm__search_documents", {
            query: "first",
          }),
        ),
      ).toContain("found document for first");

      const exhausted = await rawMcpRequest(mcpUrl, auth, "tools/call", {
        name: "crm__search_documents",
        arguments: { query: "second" },
      });
      expect((exhausted.result as { isError?: boolean }).isError).toBe(true);
      expect(mcpText(exhausted.result)).toContain("toolspace call budget exhausted (1/turn)");
      expect(upstream.calls).toEqual([{ tool: "search_documents", args: { query: "first" } }]);
    } finally {
      await client?.close().catch(() => undefined);
      server.stop(true);
      upstream.close();
    }
  });

  test("cancelled-session user messages do not rotate per-session MCP credentials", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        productAccessMode: "configured",
        delegationSecret,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    const attachAuth = `Bearer ${await signDelegatedAccessToken(delegationSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "test:session-mcp-cancelled-rotation",
      permissions: [
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "sessions:control",
        "mcp_servers:attach",
      ],
      exp: Math.floor(Date.now() / 1000) + 300,
    })}`;

    const createSecret = "Bearer create-secret";
    const created = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "use the crm server",
        model: "scripted-model",
        tools: [{ kind: "mcp", id: "crm" }],
        mcpServers: [
          {
            id: "crm",
            name: "CRM MCP",
            url: "https://crm.example/mcp",
            headers: { Authorization: createSecret, "X-Initial": "1" },
          },
        ],
      }),
      headers: {
        "content-type": "application/json",
        authorization: attachAuth,
      },
    });
    expect(created.status).toBe(202);
    const session = (await created.json()) as { id: string };
    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    const beforeCredentials = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      key,
    );
    expect(beforeCredentials[0]?.headers).toEqual({
      Authorization: createSecret,
      "X-Initial": "1",
    });
    expect(beforeCredentials[0]?.credentialVersion).toBe(1);

    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "cancelled", null);
    const beforeEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      session.id,
      0,
      100,
    );
    const beforeTurns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 100);
    const beforeUsage = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 100,
    });
    const wakeupsBefore = wf.wakeups.length;

    const rejected = await app.request(
      workspacePath(grant.workspaceId, `/sessions/${session.id}/events`),
      {
        method: "POST",
        body: JSON.stringify({
          type: "user.message",
          payload: {
            text: "rotate after cancellation",
            mcpCredentialUpdates: [
              {
                id: "crm",
                headers: { Authorization: "Bearer rejected", "X-Initial": "2" },
              },
            ],
          },
        }),
        headers: {
          "content-type": "application/json",
          authorization: attachAuth,
        },
      },
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toContain("Cancelled session cannot accept work");

    const afterCredentials = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      key,
    );
    expect(afterCredentials[0]?.headers).toEqual({
      Authorization: createSecret,
      "X-Initial": "1",
    });
    expect(afterCredentials[0]?.credentialVersion).toBe(1);
    expect(
      await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100),
    ).toHaveLength(beforeEvents.length);
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 100)).toHaveLength(
      beforeTurns.length,
    );
    expect(
      await listUsageEvents(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        limit: 100,
      }),
    ).toHaveLength(beforeUsage.length);
    expect(wf.wakeups.length).toBe(wakeupsBefore);
  });

  test("goal-bearing sessions always hold goals:manage in their first-party MCP permissions", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
    });
    // The creating grant deliberately lacks goals:manage: the auto-added
    // permission is exempt from the creator-holds-it check because goal
    // tools are scoped to the spawned session itself via the worker-signed
    // sessionId claim - a worker managing its OWN goal is not an escalation
    // of the spawner's authority.
    const creatorToken = await signDelegatedAccessToken(delegationSecret, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: "test:goal-first-party-permissions",
      permissions: ["workspace:read", "sessions:create", "sessions:read"],
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    // REST create with a goal: goals:manage is unioned into the explicit
    // set, otherwise the agent could never call goal_complete/goal_pause and
    // the goal continuation loop would run until an operator intervenes.
    const withGoal = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "take repo zero-to-one",
        model: "scripted-model",
        goal: { text: "repo deployed to staging" },
        firstPartyMcpPermissions: ["workspace:read"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creatorToken}`,
      },
    });
    expect(withGoal.status).toBe(202);
    const goalSession = (await withGoal.json()) as {
      id: string;
      firstPartyMcpPermissions: string[] | null;
    };
    expect(goalSession.firstPartyMcpPermissions).toEqual(["workspace:read", "goals:manage"]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, goalSession.id))?.firstPartyMcpPermissions,
    ).toEqual(["workspace:read", "goals:manage"] as Permission[]);

    // Without a goal the explicit permission set is stored untouched.
    const withoutGoal = await app.request(workspacePath(grant.workspaceId, "/sessions"), {
      method: "POST",
      body: JSON.stringify({
        initialMessage: "no goal here",
        model: "scripted-model",
        firstPartyMcpPermissions: ["workspace:read"],
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creatorToken}`,
      },
    });
    expect(withoutGoal.status).toBe(202);
    const plainSession = (await withoutGoal.json()) as {
      id: string;
      firstPartyMcpPermissions: string[] | null;
    };
    expect(plainSession.firstPartyMcpPermissions).toEqual(["workspace:read"]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, plainSession.id))?.firstPartyMcpPermissions,
    ).toEqual(["workspace:read"] as Permission[]);

    // Same invariant through the MCP session_create tool, from a manager
    // grant that also lacks goals:manage.
    const mcpDeps = {
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const managerGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create", "sessions:read"] as Permission[],
    };
    const managerMcp = buildOpenGeniMcpServer(mcpDeps, managerGrant);
    const spawned = await callMcpTool<{
      id: string;
      firstPartyMcpPermissions: string[] | null;
    }>(managerMcp, "session_create", {
      initialMessage: "spawn a goal-bearing worker",
      model: "scripted-model",
      sandboxBackend: "none",
      goal: { text: "fleet healthy" },
      firstPartyMcpPermissions: ["workspace:read"],
    });
    expect(spawned.firstPartyMcpPermissions).toEqual(["workspace:read", "goals:manage"]);
    expect(
      (await getSession(dbClient.db, grant.workspaceId, spawned.id))?.firstPartyMcpPermissions,
    ).toEqual(["workspace:read", "goals:manage"] as Permission[]);
  });

  test("manager MCP session tools enforce environment attachment permission and billing limits", async () => {
    const wf = new FakeWorkflowClient();
    const grant = await bootstrapMcpGrant(dbClient.db);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: environmentsTestKey,
    });
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: wf,
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const environment = await createWorkspaceEnvironment(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `manager-env-${crypto.randomUUID()}`,
    });

    // sessions:create alone cannot attach workspace secrets to a spawned
    // session; environments:use stays the attachment gate on every surface.
    const spawnOnlyGrant = {
      ...grant,
      permissions: ["workspace:read", "sessions:create"] as Permission[],
    };
    const spawnOnlyMcp = buildOpenGeniMcpServer(mcpDeps, spawnOnlyGrant);
    await expect(
      callMcpTool(spawnOnlyMcp, "session_create", {
        initialMessage: "exfiltrate",
        model: "scripted-model",
        environmentId: environment.id,
      }),
    ).rejects.toThrow("missing permission: variable-sets:use (deprecated alias: environments:use)");

    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const attached = await callMcpTool<{
      id: string;
      environmentId: string | null;
    }>(mcp, "session_create", {
      initialMessage: "deploy with cloud credentials",
      model: "scripted-model",
      environmentId: environment.id,
    });
    expect(attached.environmentId).toBe(environment.id);
    await expect(
      callMcpTool(mcp, "session_create", {
        initialMessage: "unknown environment",
        model: "scripted-model",
        environmentId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("unknown variableSetId");

    // The successful create recorded one agent_run.created usage event, so a
    // one-run monthly cap now blocks both spawn and send-message.
    const limitedMcp = buildOpenGeniMcpServer(
      {
        ...mcpDeps,
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          environmentsEncryptionKey: environmentsTestKey,
          usageLimitsMode: "static",
          staticUsageLimitsJson: JSON.stringify({
            maxMonthlyAgentRunsPerWorkspace: 1,
          }),
        }),
      },
      grant,
    );
    await expect(
      callMcpTool(limitedMcp, "session_create", {
        initialMessage: "over the cap",
        model: "scripted-model",
      }),
    ).rejects.toThrow("monthly agent run limit reached");
    await expect(
      callMcpTool(limitedMcp, "session_send_message", {
        sessionId: attached.id,
        text: "over the cap",
      }),
    ).rejects.toThrow("monthly agent run limit reached");
  });

  test("manager MCP session_create forwards targetSandboxId to the domain (create-time machine targeting)", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);

    // Control: a backend:"none" create WITHOUT a target succeeds — no machine
    // is pinned, so nothing exercises the create-time targeting path.
    const plain = await callMcpTool<{ id: string; sandboxBackend: string }>(mcp, "session_create", {
      initialMessage: "no target",
      model: "scripted-model",
      sandboxBackend: "none",
    });
    expect(plain.sandboxBackend).toBe("none");

    // The fix: targetSandboxId is now declared on the session_create inputSchema,
    // so the MCP SDK no longer strips it before the handler runs — it reaches
    // createSessionForRequest's seedTargetSandbox path. With backend:"none" the
    // seed guard rejects (you cannot pin a machine for a sandbox-less session),
    // which PROVES the value flowed end-to-end. Before the fix the unknown key
    // was dropped and this create would have succeeded, silently swallowing the
    // agent's machine-targeting request.
    await expect(
      callMcpTool(mcp, "session_create", {
        initialMessage: "pin to a machine",
        model: "scripted-model",
        sandboxBackend: "none",
        targetSandboxId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/cannot target a machine for a session with no sandbox/);
  });

  test("manager MCP environment tools set variables write-only and create environments by name", async () => {
    const grant = await bootstrapMcpGrant(dbClient.db);
    const mcpDeps = {
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const environmentName = `geni-cloud-${crypto.randomUUID()}`;
    const secretValue = `super-secret-${crypto.randomUUID()}`;

    const first = await callMcpTool<{
      environment: { id: string; name: string; created: boolean };
      variable: { name: string; version: number };
    }>(mcp, "environment_set_variable", {
      environmentName,
      name: "AZURE_CLIENT_SECRET",
      value: secretValue,
    });
    expect(first.environment.created).toBe(true);
    expect(first.environment.name).toBe(environmentName);
    expect(first.variable).toMatchObject({
      name: "AZURE_CLIENT_SECRET",
      version: 1,
    });

    const rotatedValue = `rotated-${crypto.randomUUID()}`;
    const rotated = await callMcpTool<{
      environment: { id: string; created: boolean };
      variable: { version: number };
    }>(mcp, "environment_set_variable", {
      environmentId: first.environment.id,
      name: "AZURE_CLIENT_SECRET",
      value: rotatedValue,
    });
    expect(rotated.environment.created).toBe(false);
    expect(rotated.variable.version).toBe(2);

    // The stored value round-trips through the operator key, proving the MCP
    // write path encrypts exactly like the REST route.
    const stored = await getWorkspaceEnvironmentValuesForRun(
      dbClient.db,
      grant.workspaceId,
      first.environment.id,
    );
    const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
    expect(decryptEnvironmentValue(key, stored!.values["AZURE_CLIENT_SECRET"]!)).toBe(rotatedValue);

    const listedEnvironments = await callMcpTool<{
      environments: Array<{
        id: string;
        name: string;
        variables: Array<{ name: string; version: number }>;
      }>;
    }>(mcp, "environment_list", {});
    const listedEnvironment = listedEnvironments.environments.find(
      (candidate) => candidate.id === first.environment.id,
    );
    expect(listedEnvironment?.variables).toEqual([
      expect.objectContaining({ name: "AZURE_CLIENT_SECRET", version: 2 }),
    ]);
    // Write-only invariant: no response carries a variable value.
    expect(JSON.stringify(listedEnvironments)).not.toContain(rotatedValue);
    expect(JSON.stringify(rotated)).not.toContain(rotatedValue);

    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentName,
        name: "GH_TOKEN",
        value: "nope",
      }),
    ).rejects.toThrow("reserved environment variable name");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentName,
        name: "lowercase",
        value: "nope",
      }),
    ).rejects.toThrow("environment variable names must match");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentId: first.environment.id,
        environmentName,
        name: "AMBIGUOUS",
        value: "nope",
      }),
    ).rejects.toThrow("exactly one of environmentId or environmentName");
    await expect(
      callMcpTool(mcp, "environment_set_variable", {
        environmentId: crypto.randomUUID(),
        name: "MISSING_TARGET",
        value: "nope",
      }),
    ).rejects.toThrow("environment not found");

    // environments:use lists but cannot write; environments:manage is the
    // write gate, mirroring the REST routes.
    const useOnlyGrant = {
      ...grant,
      permissions: ["workspace:read", "environments:use"] as Permission[],
    };
    const useOnlyMcp = buildOpenGeniMcpServer(mcpDeps, useOnlyGrant);
    const useOnlyList = await callMcpTool<{
      environments: Array<{ id: string }>;
    }>(useOnlyMcp, "environment_list", {});
    expect(
      useOnlyList.environments.some((candidate) => candidate.id === first.environment.id),
    ).toBe(true);
    await expect(
      callMcpTool(useOnlyMcp, "environment_set_variable", {
        environmentName,
        name: "BLOCKED",
        value: "nope",
      }),
    ).rejects.toThrow("MCP tool not registered");
  });

  test("manager MCP github_connect_link mints a browser entry link that plants the CSRF state cookie", async () => {
    const stateSecret = "test-github-connect-state-secret";
    const grant = await bootstrapMcpGrant(dbClient.db);
    const configuredGitHub = {
      githubAppId: "12345",
      githubClientId: "test-client-id",
      githubClientSecret: "test-client-secret",
      githubAppSlug: "opengeni-test-app",
      githubAppPrivateKey: "test-private-key",
    };
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      publicBaseUrl: "https://api.opengeni.test",
      ...configuredGitHub,
    });
    const mcpDeps = {
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      objectStorage: null,
      githubStateSecret: stateSecret,
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by manager MCP tests");
      },
      resumeBoxById: fakeResumeBoxById,
    };
    const mcp = buildOpenGeniMcpServer(mcpDeps, grant);
    const link = await callMcpTool<{
      configured: boolean;
      appSlug: string;
      installUrl: string;
      expiresInSeconds: number;
    }>(mcp, "github_connect_link", {});
    expect(link.configured).toBe(true);
    expect(link.appSlug).toBe("opengeni-test-app");
    expect(link.expiresInSeconds).toBeGreaterThan(0);
    const installUrl = new URL(link.installUrl);
    expect(installUrl.origin).toBe("https://api.opengeni.test");
    expect(installUrl.pathname).toBe(`/v1/workspaces/${grant.workspaceId}/github/connect`);
    const state = installUrl.searchParams.get("state");
    expect(readSignedState(state!, stateSecret)).toMatchObject({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });

    // Opening the link plants the CSRF state cookie the install/OAuth
    // callbacks require and forwards the same state to GitHub.
    const app = createApp({
      settings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
    });
    const redirect = await app.request(`${installUrl.pathname}${installUrl.search}`);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/apps/opengeni-test-app/installations/new",
    );
    expect(location.searchParams.get("state")).toBe(state);
    expect(redirect.headers.get("set-cookie")).toContain(`opengeni_github_state=${state}`);

    expect((await app.request(`/v1/workspaces/${grant.workspaceId}/github/connect`)).status).toBe(
      400,
    );
    expect(
      (await app.request(`/v1/workspaces/${grant.workspaceId}/github/connect?state=tampered`))
        .status,
    ).toBe(400);
    // A state minted for one workspace cannot start the flow for another.
    expect(
      (
        await app.request(
          `/v1/workspaces/${crypto.randomUUID()}/github/connect${installUrl.search}`,
        )
      ).status,
    ).toBe(400);

    // The browser entry stays reachable when deployment-level access-key auth
    // is enabled (the browser opening the link holds no API credentials), like
    // the install/OAuth callbacks it feeds; the signed state is the gate.
    const lockedApp = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        publicBaseUrl: "https://api.opengeni.test",
        ...configuredGitHub,
        authRequired: true,
        accessKey: "test-deployment-access-key",
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
      githubStateSecret: stateSecret,
    });
    expect(
      (await lockedApp.request(`/v1/workspaces/${grant.workspaceId}/github/repositories`)).status,
    ).toBe(401);
    const lockedRedirect = await lockedApp.request(`${installUrl.pathname}${installUrl.search}`);
    expect(lockedRedirect.status).toBe(302);
    expect(lockedRedirect.headers.get("set-cookie")).toContain(`opengeni_github_state=${state}`);

    // Unconfigured deployments report what is missing instead of minting links.
    const unconfiguredMcp = buildOpenGeniMcpServer(
      {
        ...mcpDeps,
        settings: testSettings({ databaseUrl: services.databaseUrl }),
      },
      grant,
    );
    const unconfigured = await callMcpTool<{
      configured: boolean;
      installUrl: string | null;
      missing: string[];
    }>(unconfiguredMcp, "github_connect_link", {});
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.installUrl).toBeNull();
    expect(unconfigured.missing.length).toBeGreaterThan(0);

    // Without a configured base URL the request origin is the fallback.
    const originMcp = buildOpenGeniMcpServer(
      {
        ...mcpDeps,
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          publicBaseUrl: undefined,
          ...configuredGitHub,
        }),
      },
      grant,
      { requestOrigin: "http://127.0.0.1:8000" },
    );
    const originLink = await callMcpTool<{ installUrl: string }>(
      originMcp,
      "github_connect_link",
      {},
    );
    expect(
      originLink.installUrl.startsWith(
        `http://127.0.0.1:8000/v1/workspaces/${grant.workspaceId}/github/connect?state=`,
      ),
    ).toBe(true);
    const noBaseMcp = buildOpenGeniMcpServer(
      {
        ...mcpDeps,
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          publicBaseUrl: undefined,
          ...configuredGitHub,
        }),
      },
      grant,
    );
    await expect(callMcpTool(noBaseMcp, "github_connect_link", {})).rejects.toThrow(
      "OPENGENI_PUBLIC_BASE_URL",
    );
  });

  test("pack enable validates and stores environment attachments", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: environmentsTestKey,
      }),
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const workspaceId = await defaultWorkspaceId(app);
    const environment = await createTestEnvironment(app, workspaceId, {});

    const unknownAttachment = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: crypto.randomUUID() }),
      },
    );
    expect(unknownAttachment.status).toBe(422);

    const enabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environmentId: environment.id }),
      },
    );
    expect([200, 201]).toContain(enabled.status);
    const installation = (await enabled.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(installation.metadata.variableSetId).toBe(environment.id);

    // Re-enabling without environmentId keeps the stored attachment.
    const reenabled = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(reenabled.status).toBe(200);
    const reenabledInstallation = (await reenabled.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(reenabledInstallation.metadata.variableSetId).toBe(environment.id);

    // Back-compat: an installation enabled BEFORE the Variable Set rename stored
    // the attachment under the legacy `metadata.environmentId` key. Simulate that
    // legacy row, then re-enable empty and assert the attachment is still
    // inherited (the environmentId fallback), not silently dropped.
    await dbClient.db.execute(dbSql`
      update pack_installations set metadata = ${JSON.stringify({ environmentId: environment.id })}::jsonb
      where workspace_id = ${workspaceId} and pack_id = 'marketing-social-daily-analysis'`);
    const reenabledLegacy = await app.request(
      workspacePath(workspaceId, "/packs/marketing-social-daily-analysis/enable"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(reenabledLegacy.status).toBe(200);
    const reenabledLegacyInstallation = (await reenabledLegacy.json()) as {
      metadata: Record<string, unknown>;
    };
    expect(reenabledLegacyInstallation.metadata.variableSetId).toBe(environment.id);
  });

  test("file download MCP tool reports unconfigured object storage", async () => {
    const appSettings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
    });
    const app = createApp({
      settings: appSettings,
      db: dbClient.db,
      bus: new MemoryEventBus(),
      workflowClient: new FakeWorkflowClient(),
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      delegationSecret: "test-delegation-secret",
      mcpServers: [
        {
          id: "files",
          name: "Files",
          url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
          allowedTools: ["files_get_download_url"],
          timeoutMs: undefined,
          cacheToolsList: false,
        },
      ],
    });
    let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | null = null;
    try {
      const access = await defaultAccessContext(app);
      prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "files" }], {
        accountId: access.defaultAccountId!,
        workspaceId: access.defaultWorkspaceId!,
        subjectId: "test:mcp-client",
      });
      expect(
        mcpText(
          await prepared.mcpServers[0]!.callTool("files__files_get_download_url", {
            fileId: crypto.randomUUID(),
          }),
        ),
      ).toContain("object storage is not configured");
    } finally {
      await prepared?.close().catch(() => undefined);
      server.stop(true);
    }
  });
});

const environmentsTestKey = Buffer.alloc(32, 5).toString("base64");

async function createTestEnvironment(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  input: {
    name?: string;
    variables?: Array<{ name: string; value: string }>;
  },
): Promise<{ id: string; name: string }> {
  const response = await app.request(workspacePath(workspaceId, "/environments"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: input.name ?? `env-${crypto.randomUUID()}`,
      variables: input.variables ?? [],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

function mcpText(result: unknown): string {
  const content = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : [];
  const first = content[0];
  if (
    first &&
    typeof first === "object" &&
    typeof (first as { text?: unknown }).text === "string"
  ) {
    return (first as { text: string }).text;
  }
  throw new Error(`MCP result did not contain text content: ${JSON.stringify(result)}`);
}

async function fakeResumeBoxById(): Promise<never> {
  throw new Error("sandbox resume is not used by API integration MCP tests");
}

async function defaultAccessContext(
  app: ReturnType<typeof createApp>,
  headers?: HeadersInit,
): Promise<AccessContext> {
  const response = await app.request("/v1/access/me", {
    ...(headers ? { headers } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as AccessContext;
}

async function defaultWorkspaceId(
  app: ReturnType<typeof createApp>,
  headers?: HeadersInit,
): Promise<string> {
  const context = await defaultAccessContext(app, headers);
  expect(context.defaultWorkspaceId).toBeTruthy();
  return context.defaultWorkspaceId!;
}

async function postStripeEvent(
  app: ReturnType<typeof createApp>,
  webhookSecret: string,
  event: Record<string, unknown>,
): Promise<Response> {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(webhookSecret, `${timestamp}.${payload}`);
  return await app.request("/v1/webhooks/stripe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`,
    },
    body: payload,
  });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function workspacePath(workspaceId: string, path: string): string {
  return `/v1/workspaces/${workspaceId}${path}`;
}

async function withWorkspaceCount(
  db: ReturnType<typeof createDb>["db"],
  workspaceId: string,
  createIdempotencyKey: string,
): Promise<number> {
  const rows = await db.execute(
    dbSql<{
      n: number;
    }>`select count(*)::int as n from sessions where workspace_id = ${workspaceId} and create_idempotency_key = ${createIdempotencyKey}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function bootstrapMcpGrant(db: ReturnType<typeof createDb>["db"]) {
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:mcp",
    accountExternalId: crypto.randomUUID(),
    accountName: "MCP test account",
    workspaceExternalSource: "test:mcp",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "MCP test workspace",
    subjectId: `test:mcp:${crypto.randomUUID()}`,
    subjectLabel: "MCP test",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("MCP bootstrap did not create a workspace grant");
  }
  return grant;
}

type TestWorkspaceGrant = AccessContext["workspaceGrants"][number];

async function signDelegatedBearer(
  secret: string,
  grant: TestWorkspaceGrant,
  input: {
    subjectId: string;
    permissions: Permission[];
    sessionId?: string;
  },
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(secret, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: input.subjectId,
    subjectLabel: input.subjectId,
    permissions: input.permissions,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
}

async function prepareToolspaceClient(
  url: string,
  authorization: string,
): Promise<Awaited<ReturnType<typeof prepareAgentTools>>> {
  return await prepareAgentTools(
    testSettings({
      mcpServers: [
        {
          id: "toolspace",
          name: "Toolspace",
          url,
          headers: { authorization },
          cacheToolsList: false,
        },
      ],
    }),
    [{ kind: "mcp", id: "toolspace" }],
  );
}

async function rawMcpRequest(
  url: string,
  authorization: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`MCP request failed ${response.status}: ${text}`);
  }
  return JSON.parse(text) as { result?: unknown; error?: unknown };
}

async function createToolspaceMcpSession(
  db: ReturnType<typeof createDb>["db"],
  grant: TestWorkspaceGrant,
  input: {
    url: string;
    headers?: Record<string, string>;
    requireApproval?: boolean | string[];
  },
) {
  const key = new Uint8Array(Buffer.from(environmentsTestKey, "base64"));
  const headersEncrypted = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([name, value]) => [
      name,
      encryptEnvironmentValue(key, value),
    ]),
  );
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "use the crm server from toolspace",
    resources: [],
    tools: [{ kind: "mcp", id: "crm" }],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    mcpServers: [
      {
        id: "crm",
        name: "CRM MCP",
        url: input.url,
        allowedTools: ["search_documents"],
        cacheToolsList: false,
        ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
        headersEncrypted,
      },
    ],
  });
  const queued = await submitTestHumanPrompt(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    text: "start toolspace turn",
    resources: [],
    tools: [{ kind: "mcp", id: "crm" }],
    delivery: "send",
    reasoningEffortFallback: "medium",
  });
  const running = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (running.action !== "claimed" || running.turn.id !== queued.turn.id) {
    throw new Error("failed to claim the toolspace fixture turn");
  }
  return { session, turnId: running.turn.id };
}

async function readSseEvents(
  response: Response,
  count: number,
  abort: AbortController,
): Promise<SessionEvent[]> {
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

type NestedDepthErrorEnvelope = {
  error: {
    code: "nested_agent_depth_exceeded" | "nested_agent_depth_override_forbidden";
    message: string;
    details: {
      denial: {
        id: string;
        parentSessionId: string | null;
        rootSessionId: string | null;
        currentDepth: number;
        attemptedDepth: number;
        effectiveMaxNestedAgentDepth: number;
        requestedMaxNestedAgentDepthOverride: number | null;
        policySource: "session" | "workspace" | "deployment" | "default";
        policySessionId: string | null;
        idempotencyKey: string | null;
      };
    };
  };
};

type DeniedSessionArtifactCounts = {
  sessions: number;
  mcpServers: number;
  goals: number;
  events: number;
  historyItems: number;
  turns: number;
  turnAttempts: number;
  pendingToolCalls: number;
  runStates: number;
  systemUpdates: number;
  systemUpdateOutbox: number;
  workflowWakeOutbox: number;
  sandboxEnvelopes: number;
  sandboxLeases: number;
  sandboxLeaseHolders: number;
  recordings: number;
  usageEvents: number;
  creditLedgerEntries: number;
  auditEvents: number;
};

function emptyDeniedSessionArtifactCounts(): DeniedSessionArtifactCounts {
  return {
    sessions: 0,
    mcpServers: 0,
    goals: 0,
    events: 0,
    historyItems: 0,
    turns: 0,
    turnAttempts: 0,
    pendingToolCalls: 0,
    runStates: 0,
    systemUpdates: 0,
    systemUpdateOutbox: 0,
    workflowWakeOutbox: 0,
    sandboxEnvelopes: 0,
    sandboxLeases: 0,
    sandboxLeaseHolders: 0,
    recordings: 0,
    usageEvents: 0,
    creditLedgerEntries: 0,
    auditEvents: 0,
  };
}

async function deniedSessionArtifactCounts(
  db: ReturnType<typeof createDb>["db"],
  workspaceId: string,
  deniedId: string,
): Promise<DeniedSessionArtifactCounts> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute(
      dbSql<Record<keyof DeniedSessionArtifactCounts, number>>`
        select
          (select count(*)::int from sessions where workspace_id = ${workspaceId} and id = ${deniedId}) as "sessions",
          (select count(*)::int from session_mcp_servers where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "mcpServers",
          (select count(*)::int from session_goals where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "goals",
          (select count(*)::int from session_events where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "events",
          (select count(*)::int from session_history_items where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "historyItems",
          (select count(*)::int from session_turns where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "turns",
          (select count(*)::int from session_turn_attempts where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "turnAttempts",
          (select count(*)::int from session_pending_tool_calls where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "pendingToolCalls",
          (select count(*)::int from agent_run_states where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "runStates",
          (select count(*)::int from session_system_updates where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "systemUpdates",
          (select count(*)::int from session_system_update_outbox where workspace_id = ${workspaceId} and (source_session_id = ${deniedId} or target_session_id = ${deniedId})) as "systemUpdateOutbox",
          (select count(*)::int from session_workflow_wake_outbox where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "workflowWakeOutbox",
          (select count(*)::int from sandbox_session_envelopes where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "sandboxEnvelopes",
          (select count(*)::int from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${deniedId}) as "sandboxLeases",
          (select count(*)::int from sandbox_lease_holders where workspace_id = ${workspaceId} and subject_id = ${deniedId}) as "sandboxLeaseHolders",
          (select count(*)::int from session_recordings where workspace_id = ${workspaceId} and session_id = ${deniedId}) as "recordings",
          (select count(*)::int from usage_events where workspace_id = ${workspaceId} and source_resource_id = ${deniedId}) as "usageEvents",
          (select count(*)::int from credit_ledger_entries where workspace_id = ${workspaceId} and source_id = ${deniedId}) as "creditLedgerEntries",
          (select count(*)::int from audit_events where workspace_id = ${workspaceId} and target_id = ${deniedId}) as "auditEvents"
      `,
    );
    const row = rows[0];
    if (!row) throw new Error("denied-session artifact count query returned no row");
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    ) as DeniedSessionArtifactCounts;
  });
}

async function callMcpToolResult(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ body: unknown; isError: boolean }> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        {
          handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = (await tool.handler(args, {})) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return { body: JSON.parse(text) as unknown, isError: result.isError === true };
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return (await callMcpToolResult(server, name, args)).body as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  userMessages: unknown[] = [];
  wakeups: unknown[] = [];
  wakeDispatches = 0;
  approvals: unknown[] = [];
  interrupts: unknown[] = [];
  synced: unknown[] = [];
  deletedSchedules: unknown[] = [];
  triggers: unknown[] = [];
  syncError: Error | null = null;
  wakeError: Error | null = null;
  triggerError: Error | null = null;

  async signalUserMessage(input: unknown): Promise<void> {
    this.userMessages.push(input);
  }

  async wakeSessionWorkflow(input: unknown): Promise<void> {
    this.wakeups.push(input);
    if (this.wakeError) {
      throw this.wakeError;
    }
  }

  async requestSessionWorkflowWakeDispatch(): Promise<void> {
    this.wakeDispatches += 1;
  }

  async signalApprovalDecision(input: unknown): Promise<void> {
    this.approvals.push(input);
  }

  async signalSessionControl(input: unknown): Promise<void> {
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
    if (this.triggerError) {
      throw this.triggerError;
    }
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

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function firstPartyMcpSettings(databaseUrl: string) {
  return testSettings({
    databaseUrl,
    mcpServers: [
      {
        id: "opengeni",
        name: "OpenGeni",
        url: "http://127.0.0.1:8000/v1/mcp",
        cacheToolsList: true,
      },
      {
        id: "docs",
        name: "Document Search",
        url: "http://127.0.0.1:8000/v1/mcp/docs",
        allowedTools: ["search_documents", "fetch_document_chunk", "list_document_bases"],
        cacheToolsList: false,
      },
    ],
  });
}
