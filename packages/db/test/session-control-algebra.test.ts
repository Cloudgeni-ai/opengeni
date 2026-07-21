import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  evaluateSessionControl,
  listWorkspaceControlEvents,
  markSessionAttemptQuiesced,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  SessionCommandIdempotencyError,
  SessionControlInvariantError,
  settleSessionAttemptInterruptions,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-control-algebra");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Session control algebra",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Session control algebra",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const root = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "root",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  const child = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    parentSessionId: root.id,
    initialMessage: "child",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return { grant, root, child };
}

async function control(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  action: "pause" | "resume",
  operationKey = crypto.randomUUID(),
  reason?: string,
) {
  return await withWorkspaceRls(client.db, fixtureValue.grant.workspaceId!, async (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: fixtureValue.grant.accountId,
      workspaceId: fixtureValue.grant.workspaceId!,
      sessionId,
      actor: { type: "human", subjectId: fixtureValue.grant.subjectId },
      operationKey,
      action,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
}

describe("recursive session control algebra", () => {
  test("a descendant Resume crosses an ancestor Pause and a later ancestor Pause wins", async () => {
    const value = await fixture();
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
      ),
    ).toMatchObject({ state: "active", directState: "active", blockers: [] });

    await control(value, value.root.id, "pause");
    const blocked = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
    );
    expect(blocked).toMatchObject({
      state: "paused",
      primaryBlocker: { kind: "session", sessionId: value.root.id },
    });

    const resumed = await control(value, value.child.id, "resume");
    expect(resumed.control).toMatchObject({
      state: "active",
      directState: "active",
      override: { rootSessionId: value.child.id },
    });
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.root.id),
      ),
    ).toMatchObject({ state: "paused" });

    await control(value, value.root.id, "pause");
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
      ),
    ).toMatchObject({
      state: "paused",
      primaryBlocker: { kind: "session", sessionId: value.root.id },
    });
  });

  test("Pause creates exact live-attempt interruptions without application-side descendant IDs", async () => {
    const value = await fixture();
    const attemptId = crypto.randomUUID();
    await withWorkspaceRls(client.db, value.grant.workspaceId!, async (db) => {
      const [turn] = await db
        .insert(schema.sessionTurns)
        .values({
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          sessionId: value.child.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${value.child.id}`,
          status: "running",
          source: "user",
          position: 1,
          prompt: "running",
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "low",
          sandboxBackend: "none",
          executionGeneration: 1,
          activeAttemptId: attemptId,
        })
        .returning();
      await db.insert(schema.sessionTurnAttempts).values({
        id: attemptId,
        accountId: value.grant.accountId,
        workspaceId: value.grant.workspaceId!,
        sessionId: value.child.id,
        turnId: turn!.id,
        executionGeneration: 1,
        state: "running",
        temporalWorkflowId: `session-${value.child.id}`,
        temporalWorkflowRunId: `run-${attemptId}`,
        temporalActivityId: `activity-${attemptId}`,
        verifiedControlRevision: 0,
      });
    });

    const paused = await control(value, value.root.id, "pause");
    expect(paused.interruptionCount).toBe(1);
    expect(paused.control).toMatchObject({
      state: "paused",
      settlement: { state: "stopping", attemptCount: 1 },
    });
    const interruptions = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .select()
        .from(schema.sessionAttemptInterruptions)
        .where(
          and(
            eq(schema.sessionAttemptInterruptions.workspaceId, value.grant.workspaceId!),
            eq(schema.sessionAttemptInterruptions.attemptId, attemptId),
          ),
        ),
    );
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toMatchObject({
      sessionId: value.child.id,
      attemptId,
      kind: "session_pause",
      state: "pending",
    });

    const settled = await settleSessionAttemptInterruptions(
      client.db,
      value.grant.workspaceId!,
      value.child.id,
      attemptId,
    );
    expect(settled).toMatchObject({
      action: "paused",
      attemptId,
      outcome: "interrupted_recoverable",
    });
    const [recovering] = await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, settled.turnId!)),
    );
    expect(recovering).toMatchObject({ status: "recovering", activeAttemptId: null });

    await control(value, value.child.id, "resume");
    const resumedAttemptId = crypto.randomUUID();
    const claimInput = {
      sessionId: value.child.id,
      workflowId: `session-${value.child.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: resumedAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" as const },
    };
    const blocked = await claimSessionWorkForAttempt(
      client.db,
      value.grant.workspaceId!,
      claimInput,
    );
    expect(blocked).toEqual({ action: "unclaimed", reason: "control-pending" });

    await markSessionAttemptQuiesced(client.db, {
      workspaceId: value.grant.workspaceId!,
      sessionId: value.child.id,
      attemptId,
      temporalWorkflowId: `session-${value.child.id}`,
    });
    const resumed = await claimSessionWorkForAttempt(
      client.db,
      value.grant.workspaceId!,
      claimInput,
    );
    expect(resumed).toMatchObject({ action: "claimed", turn: { id: settled.turnId } });
  });

  test("same operation replays and different input under the key writes nothing", async () => {
    const value = await fixture();
    const operationKey = crypto.randomUUID();
    const first = await control(value, value.root.id, "pause", operationKey);
    const replay = await control(value, value.root.id, "pause", operationKey);
    expect(replay.replay).toBe(true);
    expect(replay.receipt.id).toBe(first.receipt.id);
    await expect(
      control(value, value.root.id, "pause", operationKey, "different request"),
    ).rejects.toBeInstanceOf(SessionCommandIdempotencyError);
  });

  test("selected Resume crosses Workspace Pause until the next Workspace Pause", async () => {
    const value = await fixture();
    const workspaceControl = async (action: "pause" | "resume") =>
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        mutateWorkspaceControlInTransaction(db, {
          accountId: value.grant.accountId,
          workspaceId: value.grant.workspaceId!,
          actor: { type: "human", subjectId: value.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action,
        }),
      );

    await workspaceControl("pause");
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
      ),
    ).toMatchObject({ state: "paused", primaryBlocker: { kind: "workspace" } });
    await control(value, value.child.id, "resume");
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
      ),
    ).toMatchObject({ state: "active" });
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.root.id),
      ),
    ).toMatchObject({ state: "paused", primaryBlocker: { kind: "workspace" } });

    await workspaceControl("pause");
    expect(
      await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.child.id),
      ),
    ).toMatchObject({ state: "paused", primaryBlocker: { kind: "workspace" } });
    expect(
      (await listWorkspaceControlEvents(client.db, value.grant.workspaceId!, 0, 10)).map(
        (event) => ({ revision: event.revision, scope: event.scope, action: event.action }),
      ),
    ).toEqual([
      { revision: 1, scope: "workspace", action: "pause" },
      { revision: 2, scope: "session", action: "resume" },
      { revision: 3, scope: "workspace", action: "pause" },
    ]);
  });

  test("missing mandatory workspace control fails closed", async () => {
    const value = await fixture();
    await withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
      db
        .delete(schema.workspaceInferenceControls)
        .where(eq(schema.workspaceInferenceControls.workspaceId, value.grant.workspaceId!)),
    );
    await expect(
      withWorkspaceRls(client.db, value.grant.workspaceId!, (db) =>
        evaluateSessionControl(db, value.grant.workspaceId!, value.root.id),
      ),
    ).rejects.toBeInstanceOf(SessionControlInvariantError);
  });
});
