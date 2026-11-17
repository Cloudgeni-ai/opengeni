import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionGoal,
  initializeSessionStartAtomically,
  listSessionGoalRevisions,
  listSessionEvents,
  recoverSessionDispatch,
  setSessionGoalStatus,
  type DbClient,
} from "@opengeni/db";
import {
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type AccessGrant,
  type SessionEvent,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
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
      reasoningEffort: "medium",
      latencyMode: "standard",
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
        // A session-scoped grant registers only its signed selection.
        firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
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
      changeKind: "refinement",
      rationale: "preserve intent while clarifying the durable outcome",
      expectedObjectiveRevision: 1,
      idempotencyKey: firstKey,
    });
    expect(first).toMatchObject({
      version: 2,
      text: "Committed despite transient fanout failure",
      replay: false,
    });
    expect(first.operationId).toBeTruthy();
    const readableProgress =
      "The verified milestone retains normal spaces and clear prose. ".repeat(100);
    expect(Buffer.byteLength(readableProgress, "utf8")).toBeGreaterThan(4096);
    await callMcpTool(firstMcp, "goal_progress", {
      progressNote: readableProgress,
      idempotencyKey: crypto.randomUUID(),
    });
    const progressEvent = (
      await listSessionEvents(client.db, baseGrant.workspaceId, session.id)
    ).find((event) => event.type === "goal.progress");
    expect((progressEvent?.payload as { progressNote?: unknown } | undefined)?.progressNote).toBe(
      readableProgress,
    );

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
      changeKind: "refinement",
      rationale: "preserve intent while clarifying the durable outcome",
      expectedObjectiveRevision: 1,
      idempotencyKey: firstKey,
    });
    expect(replay).toEqual({ ...first, replay: true });

    const secondKey = crypto.randomUUID();
    const newer = await callMcpTool<GoalUpdateResult>(replacementMcp, "goal_update", {
      text: "Newer replacement-attempt goal truth",
      changeKind: "refinement",
      rationale: "newer recovered-attempt evidence clarifies the useful objective",
      expectedObjectiveRevision: 2,
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
      changeKind: "refinement",
      rationale: "preserve intent while clarifying the durable outcome",
      expectedObjectiveRevision: 1,
      idempotencyKey: firstKey,
    });
    expect(oldReplay).toEqual({ ...first, replay: true });
    expect((await getSessionGoal(client.db, baseGrant.workspaceId, session.id))?.text).toBe(
      "Newer replacement-attempt goal truth",
    );

    await expect(
      callMcpTool(replacementMcp, "goal_update", {
        text: "Conflicting reuse must not apply",
        changeKind: "replacement",
        rationale: "exercise conflicting idempotency reuse",
        expectedObjectiveRevision: 3,
        idempotencyKey: firstKey,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const durableGoalUpdates = (
      await listSessionEvents(client.db, baseGrant.workspaceId, session.id)
    ).filter((event) => event.type === "goal.updated");
    const liveGoalUpdates = bus.published.flat().filter((event) => event.type === "goal.updated");
    expect(durableGoalUpdates).toHaveLength(2);
    expect(liveGoalUpdates).toHaveLength(2);
    expect(bus.published.flat().filter((event) => event.type === "goal.progress")).toHaveLength(1);
    expect(bus.published).toHaveLength(3);
  });

  test("goal_update with the goal's own content is an idempotent no-op, never a database error", async () => {
    if (!available) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "goal-update-unchanged-test",
      accountExternalId: `account-${suffix}`,
      accountName: "Goal update unchanged",
      workspaceExternalSource: "goal-update-unchanged-test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Goal update unchanged",
      subjectId: `subject-${suffix}`,
    });
    const baseGrant = access.workspaceGrants[0]!;
    const { workspaceId } = baseGrant;
    const session = await createSession(client.db, {
      accountId: baseGrant.accountId,
      workspaceId,
      initialMessage: "start",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const text = "Fix the defect and open one draft PR.";
    const successCriteria = "Draft PR open with regression tests.";
    await initializeSessionStartAtomically(client.db, {
      accountId: baseGrant.accountId,
      workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: { text, successCriteria },
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("attempt was not claimed");
    const deps = {
      settings: testSettings({}),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test-state-secret",
      documentIndexer: { indexDocument: async () => undefined },
      getDocumentServices: () => {
        throw new Error("document services are not used by goal tests");
      },
      resumeBoxById: async () => {
        throw new Error("sandbox resume is not used by goal tests");
      },
    } as unknown as ApiRouteDeps;
    const server = buildOpenGeniMcpServer(deps, {
      ...baseGrant,
      metadata: {
        ...baseGrant.metadata,
        delegated: true,
        sessionId: session.id,
        firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
    });
    // What the model sees: the tool result as an MCP client receives it.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "goal-update-unchanged", version: "1" });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await mcp.callTool({ name, arguments: args });
      const resultText = (result.content as Array<{ text: string }>)[0]!.text;
      expect(resultText).not.toContain("Failed query");
      expect(resultText).not.toContain("session_goals");
      return { isError: result.isError === true, text: resultText };
    };

    // 1. goal_set reopens the completed goal with the same content. It changes
    // the goal (completed -> active, a new version) but not the objective.
    await setSessionGoalStatus(client.db, workspaceId, session.id, {
      status: "completed",
      evidence: "first pass done",
    });
    const reopened = await call("goal_set", { text, successCriteria });
    expect(reopened.isError).toBe(false);
    expect(JSON.parse(reopened.text)).toMatchObject({
      outcome: "updated",
      changed: true,
      resource: { state: "active" },
      facts: { replaced: true },
    });
    const active = (await getSessionGoal(client.db, workspaceId, session.id))!;
    expect(active).toMatchObject({ status: "active", objectiveRevision: 1 });
    const revisionsBefore = await listSessionGoalRevisions(client.db, workspaceId, session.id);
    const eventsBefore = await listSessionEvents(client.db, workspaceId, session.id);

    // 2. goal_update with exactly the current content changes nothing.
    const unchangedKey = crypto.randomUUID();
    const unchangedArgs = {
      text,
      successCriteria,
      changeKind: "refinement",
      rationale: "Restate the objective after reopening it.",
      expectedObjectiveRevision: active.objectiveRevision,
      idempotencyKey: unchangedKey,
    };
    const unchanged = await call("goal_update", unchangedArgs);
    expect(unchanged.isError).toBe(false);
    const unchangedResult = JSON.parse(unchanged.text);
    expect(unchangedResult).toMatchObject({
      text,
      successCriteria,
      status: "active",
      objectiveRevision: 1,
      version: active.version,
      replay: false,
      outcome: "unchanged",
      proposalId: null,
      message:
        "Nothing changed: the goal already has this content, so its objective revision stays 1.",
    });
    expect(await getSessionGoal(client.db, workspaceId, session.id)).toEqual(active);
    expect(await listSessionGoalRevisions(client.db, workspaceId, session.id)).toEqual(
      revisionsBefore,
    );
    expect(await listSessionEvents(client.db, workspaceId, session.id)).toHaveLength(
      eventsBefore.length,
    );
    // A retry with the same key replays the same answer.
    const replayed = await call("goal_update", unchangedArgs);
    expect(JSON.parse(replayed.text)).toEqual({ ...unchangedResult, replay: true });

    // 3. goal_set on the now active goal is refused in plain words.
    const refused = await call("goal_set", { text, successCriteria });
    expect(refused).toEqual({
      isError: true,
      text: "this session's goal is active at objective revision 1; use goal_update to revise it",
    });

    // A real change still advances the objective exactly once.
    const changed = await call("goal_update", {
      ...unchangedArgs,
      successCriteria: "Draft PR open with real-Postgres regression tests.",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(JSON.parse(changed.text)).toMatchObject({
      outcome: "applied",
      objectiveRevision: 2,
      version: active.version + 1,
    });
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
