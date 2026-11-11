import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deleteSessionQueueItemInTransaction,
  failSessionWorkBeforeAttemptClaim,
  getActiveSessionHistoryItemsPaged,
  listSessionEvents,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("queued-steer-batch");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture(overrides: Array<Partial<typeof schema.sessionTurns.$inferInsert>> = []) {
  const subjectId = `user:batch:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "batch",
    accountExternalId: crypto.randomUUID(),
    accountName: "Batch",
    workspaceExternalSource: "batch",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Batch",
    subjectId,
  });
  const { accountId, workspaceId: ws } = access.workspaceGrants[0]!;
  const workspaceId = ws!;
  const session = await createSession(app.db, {
    accountId,
    workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const rows = await withWorkspaceSessionActivityRls(app.db, workspaceId, async (db) => {
    const turns = await db
      .insert(schema.sessionTurns)
      .values(
        Array.from({ length: 4 }, (_, i) => ({
          accountId,
          workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${session.id}`,
          status: "queued",
          source: "user",
          promptRouting: "queued_for_execution",
          position: i + 1,
          prompt: `Message ${i}`,
          resources: [],
          tools: [],
          model: `model-${i}`,
          reasoningEffort: "medium",
          sandboxBackend: "none",
          metadata: i === 3 ? {} : { delivery: "steer", deferredUntilModelStep: true },
          initiatorKind: "subject",
          initiatorSubjectId: subjectId,
          initiatingHumanSubjectId: subjectId,
          initiatorContext: {},
          createdAt: new Date(Date.UTC(2026, 9, 20, 12, i)),
          goalSnapshot: {
            state: "none" as const,
            capturedAt: new Date(Date.UTC(2026, 9, 20, 12, i)).toISOString(),
          },
          ...overrides[i],
        })),
      )
      .returning();
    await db
      .update(schema.sessions)
      .set({ queueVersion: 1, queueHeadPosition: 0, queueTailPosition: 4, status: "queued" })
      .where(eq(schema.sessions.id, session.id));
    return turns;
  });
  const input = {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" as const },
  };
  const read = () =>
    withWorkspaceSessionActivityRls(app.db, workspaceId, (db) =>
      db
        .select()
        .from(schema.sessionTurns)
        .where(
          and(
            eq(schema.sessionTurns.workspaceId, workspaceId),
            eq(schema.sessionTurns.sessionId, session.id),
          ),
        )
        .orderBy(asc(schema.sessionTurns.position)),
    );
  return { accountId, workspaceId, subjectId, session, rows, input, read };
}

test("claim keeps accepted messages and final policy, leaves Send untouched, and replays once", async () => {
  const ctx = await fixture();
  const result = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, ctx.input);
  expect(result.action).toBe("claimed");
  if (result.action !== "claimed") throw new Error("Not claimed");
  expect(result.turn.id).toBe(ctx.rows[2]!.id);
  expect(result.turn.model).toBe("model-2");
  const rows = await ctx.read();
  expect(rows.map((r) => r.status)).toEqual(["superseded", "superseded", "running", "queued"]);
  expect(rows[3]!.version).toBe(ctx.rows[3]!.version);
  expect(
    rows
      .slice(0, 2)
      .every((r) => r.startedAt === null && r.activeAttemptId === null && r.finishedAt !== null),
  ).toBe(true);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.session.id);
  const historyOwners = await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
    db
      .select({ turnId: schema.sessionHistoryItems.turnId })
      .from(schema.sessionHistoryItems)
      .where(eq(schema.sessionHistoryItems.sessionId, ctx.session.id))
      .orderBy(asc(schema.sessionHistoryItems.position)),
  );
  expect(historyOwners.map((h) => h.turnId)).toEqual(ctx.rows.slice(0, 3).map((r) => r.id));
  for (let i = 0; i < 3; i++) {
    expect(JSON.stringify(history[i]!.item)).toContain(`Message ${i}`);
    expect(JSON.stringify(history[i]!.item)).toContain(`2026-10-20 12:0${i} UTC`);
    expect(rows[i]!.goalSnapshot).toEqual(ctx.rows[i]!.goalSnapshot);
  }
  const before = await listSessionEvents(app.db, ctx.workspaceId, ctx.session.id, { limit: 100 });
  const superseded = before.filter((event) => event.type === "turn.superseded");
  expect(superseded.map((event) => event.turnId)).toEqual(ctx.rows.slice(0, 2).map((r) => r.id));
  expect(superseded[1]!.sequence).toBe(superseded[0]!.sequence + 1);
  await claimSessionWorkForAttempt(app.db, ctx.workspaceId, ctx.input);
  expect(await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.session.id)).toEqual(
    history,
  );
  expect(await listSessionEvents(app.db, ctx.workspaceId, ctx.session.id, { limit: 100 })).toEqual(
    before,
  );
}, 60_000);

test.each(["files", "attachment", "person", "send", "started"] as const)(
  "%s is a batching boundary",
  async (boundary) => {
    const overrides: Partial<typeof schema.sessionTurns.$inferInsert> =
      boundary === "files"
        ? { resources: [{ kind: "file", id: crypto.randomUUID() }] }
        : boundary === "attachment"
          ? {
              personalResourceAttachmentSummary: {
                mode: "once",
                context: "user_private",
                resourceCount: 1,
                resourceKinds: ["variable_set"],
                sharedOutputWarningVersion: 1,
              },
            }
          : boundary === "person"
            ? { initiatorSubjectId: "user:other", initiatingHumanSubjectId: "user:other" }
            : boundary === "send"
              ? { metadata: {} }
              : { startedAt: new Date(), executionGeneration: 1 };
    const ctx = await fixture([{}, overrides]);
    const result = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, ctx.input);
    expect(result.action).toBe("claimed");
    if (result.action !== "claimed") throw new Error("Not claimed");
    expect(result.turn.id).toBe(ctx.rows[0]!.id);
    expect((await ctx.read()).map((r) => r.status)).toEqual([
      "running",
      "queued",
      "queued",
      "queued",
    ]);
  },
  60_000,
);

test("a corrupt batch member fails only itself and rolls back every consumed history item", async () => {
  const ctx = await fixture([{}, { metadata: { delivery: "steer", dispatchGeneration: -1 } }]);
  await expect(claimSessionWorkForAttempt(app.db, ctx.workspaceId, ctx.input)).rejects.toThrow(
    "Malformed turn dispatch metadata",
  );
  expect((await ctx.read()).every((r) => r.status === "queued")).toBe(true);
  expect(await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.session.id)).toEqual(
    [],
  );
  const failed = await failSessionWorkBeforeAttemptClaim(app.db, ctx.workspaceId, {
    accountId: ctx.accountId,
    sessionId: ctx.session.id,
    workflowId: ctx.input.workflowId,
    trigger: { kind: "next" },
    error: "Invalid queued dispatch",
    admissionFailure: { disposition: "permanent", code: "claim_invariant" },
  });
  expect(failed.turnId).toBe(ctx.rows[1]!.id);
  expect((await ctx.read()).map((r) => r.status)).toEqual(["queued", "failed", "queued", "queued"]);
}, 60_000);

test("a concurrent withdrawal either removes the message or loses to the atomic claim", async () => {
  const ctx = await fixture();
  const target = ctx.rows[1]!;
  const [claim, withdrawal] = await Promise.allSettled([
    claimSessionWorkForAttempt(app.db, ctx.workspaceId, ctx.input),
    withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
      db.transaction((tx) =>
        deleteSessionQueueItemInTransaction(tx as unknown as typeof db, {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          turnId: target.id,
          expectedTurnVersion: target.version,
          actor: { type: "human", subjectId: ctx.subjectId },
          operationKey: crypto.randomUUID(),
        }),
      ),
    ),
  ]);
  expect(claim.status).toBe("fulfilled");
  if (claim.status === "fulfilled") expect(claim.value.action).toBe("claimed");
  const history = JSON.stringify(
    await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, ctx.session.id),
  );
  const stored = (await ctx.read()).find((row) => row.id === target.id)!;
  if (withdrawal.status === "fulfilled") {
    expect(stored.status).toBe("cancelled");
    expect(history).not.toContain("Message 1");
  } else {
    expect(withdrawal.reason.code).toBe("QUEUE_PROMPT_STARTED");
    expect(stored.status).toBe("superseded");
    expect(history).toContain("Message 1");
  }
}, 60_000);
