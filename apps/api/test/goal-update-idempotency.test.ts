import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionGoal,
  initializeSessionStartAtomically,
  listSessionEvents,
  recoverSessionDispatch,
  type DbClient,
} from "@opengeni/db";
import type { AccessGrant, SessionEvent } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("goal-update-idempotency");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    console.warn("[goal-update-idempotency] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

class ThrowAfterFirstPublishBus extends MemoryEventBus {
  private failNext = true;

  override async publish(
    workspaceId: string,
    sessionId: string,
    events: SessionEvent[],
  ): Promise<void> {
    await super.publish(workspaceId, sessionId, events);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated transient live-bus failure after publication");
    }
  }
}

type GoalUpdateResult = {
  version: number;
  text: string;
  operationId: string;
  replay: boolean;
};

describe("goal_update idempotency", () => {
  test("replacement attempts reconcile an ambiguous commit while newer goal truth stays authoritative", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "goal-update-idempotency-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Goal update idempotency",
      workspaceExternalSource: "goal-update-idempotency-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Goal update idempotency",
      subjectId: `subject-${suffix}`,
    });
    const baseGrant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: baseGrant.accountId,
      workspaceId: baseGrant.workspaceId,
      initialMessage: "start",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: baseGrant.accountId,
      workspaceId: baseGrant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: { text: "Initial revision" },
    });
    const firstAttemptId = crypto.randomUUID();
    const firstClaim = await claimSessionWorkForAttempt(client.db, baseGrant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: firstAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(firstClaim.action).toBe("claimed");
    if (firstClaim.action !== "claimed") throw new Error("initial attempt was not claimed");

    const bus = new ThrowAfterFirstPublishBus();
    const deps = {
      settings: testSettings({}),
      db: client.db,
      bus,
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by goal_update tests");
      },
      resumeBoxById: async () => {
        throw new Error("sandbox resume is not used by goal_update tests");
      },
    } as unknown as ApiRouteDeps;
    const grantForAttempt = (attemptId: string, executionGeneration: number): AccessGrant => ({
      ...baseGrant,
      metadata: {
        ...baseGrant.metadata,
        delegated: true,
        sessionId: session.id,
        turnId: firstClaim.turn.id,
        attemptId,
        executionGeneration,
      },
    });

    const firstKey = crypto.randomUUID();
    const firstMcp = buildOpenGeniMcpServer(
      deps,
      grantForAttempt(firstAttemptId, firstClaim.turn.executionGeneration),
    );
    const first = await callMcpTool<GoalUpdateResult>(firstMcp, "goal_update", {
      text: "Committed despite transient fanout failure",
      progressNote: "first attempt persisted",
      idempotencyKey: firstKey,
    });
    expect(first).toMatchObject({
      version: 2,
      text: "Committed despite transient fanout failure",
      replay: false,
    });
    expect(first.operationId).toBeTruthy();

    const recovered = await recoverSessionDispatch(client.db, baseGrant.workspaceId, {
      sessionId: session.id,
      attemptId: firstAttemptId,
      timeoutType: "HEARTBEAT",
      maxRedispatches: 3,
    });
    expect(recovered.action).toBe("recovering");
    const replacementAttemptId = crypto.randomUUID();
    const replacementClaim = await claimSessionWorkForAttempt(client.db, baseGrant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: replacementAttemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(replacementClaim.action).toBe("claimed");
    if (replacementClaim.action !== "claimed") {
      throw new Error("replacement attempt was not claimed");
    }

    const replacementMcp = buildOpenGeniMcpServer(
      deps,
      grantForAttempt(replacementAttemptId, replacementClaim.turn.executionGeneration),
    );
    const replay = await callMcpTool<GoalUpdateResult>(replacementMcp, "goal_update", {
      text: "Committed despite transient fanout failure",
      progressNote: "first attempt persisted",
      idempotencyKey: firstKey,
    });
    expect(replay).toEqual({ ...first, replay: true });

    const secondKey = crypto.randomUUID();
    const newer = await callMcpTool<GoalUpdateResult>(replacementMcp, "goal_update", {
      text: "Newer replacement-attempt goal truth",
      progressNote: "replacement attempt advanced the goal",
      idempotencyKey: secondKey,
    });
    expect(newer).toMatchObject({
      version: 3,
      text: "Newer replacement-attempt goal truth",
      replay: false,
    });
    expect(newer.operationId).not.toBe(first.operationId);

    const oldReplay = await callMcpTool<GoalUpdateResult>(replacementMcp, "goal_update", {
      text: "Committed despite transient fanout failure",
      progressNote: "first attempt persisted",
      idempotencyKey: firstKey,
    });
    expect(oldReplay).toEqual({ ...first, replay: true });
    expect((await getSessionGoal(client.db, baseGrant.workspaceId, session.id))?.text).toBe(
      "Newer replacement-attempt goal truth",
    );

    await expect(
      callMcpTool(replacementMcp, "goal_update", {
        text: "Conflicting reuse must not apply",
        idempotencyKey: firstKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const durableGoalUpdates = (
      await listSessionEvents(client.db, baseGrant.workspaceId, session.id)
    ).filter((event) => event.type === "goal.updated");
    const liveGoalUpdates = bus.published.flat().filter((event) => event.type === "goal.updated");
    expect(durableGoalUpdates).toHaveLength(2);
    expect(liveGoalUpdates).toHaveLength(2);
    expect(bus.published).toHaveLength(2);
  });
});

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) throw new Error(`MCP tool not registered: ${name}`);
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error(`MCP tool returned no text: ${name}`);
  return JSON.parse(text) as T;
}
