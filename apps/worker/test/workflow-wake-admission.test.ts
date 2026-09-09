import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimPendingSessionWorkflowWakes,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  listSessionTurns,
  markSessionWorkflowWakeDelivered,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
} from "@opengeni/db";
import * as schema from "../../../packages/db/src/schema";

import {
  reconcilePendingSessionWorkflowWakes,
  type NotifyServices,
} from "../src/activities/parent-wake";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workflow-wake-admission");
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
    accountExternalSource: "wake-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Wake outbox test",
    workspaceExternalSource: "wake-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Wake outbox test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return { grant, session };
}

type WakeFixture = Awaited<ReturnType<typeof fixture>>;

async function send(
  wakeFixture: WakeFixture,
  text: string,
  delivery: "send" | "steer" = "send",
  clientEventId = crypto.randomUUID(),
) {
  return await withWorkspaceSubjectRls(
    client.db,
    wakeFixture.grant.workspaceId!,
    wakeFixture.grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: wakeFixture.grant.accountId,
          workspaceId: wakeFixture.grant.workspaceId!,
          sessionId: wakeFixture.session.id,
          subjectId: wakeFixture.grant.subjectId,
          actor: { type: "human", subjectId: wakeFixture.grant.subjectId },
          operationKey: clientEventId,
          delivery,
          text,
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
}

async function wakeRow(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select()
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, sessionId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

test("accepted Send stays pending in supervision until the actual durable claim", async () => {
  const ctx = await fixture();
  const queued = await send(ctx, "finish the outstanding work");
  const wake = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
    (row) => row.sessionId === ctx.session.id,
  )!;
  let signals = 0;
  const service = {
    db: client.db,
    observability: { info: () => {}, error: () => {} },
    wakeSessionWorkflow: async ({ onSignalAccepted }: { onSignalAccepted?: () => void }) => {
      signals++;
      onSignalAccepted?.();
      return await markSessionWorkflowWakeDelivered(client.db, wake);
    },
  } as unknown as NotifyServices;
  const dispatch = () =>
    reconcilePendingSessionWorkflowWakes(service, 1, {
      claimPendingSessionWorkflowWakes: async () => [wake],
    });
  const first = await dispatch();
  expect(first).toMatchObject({
    signaled: 1,
    delivered: 0,
    pendingAdmission: 1,
    pendingAdmissionBlockers: { pending_prompt_turn: 1 },
  });
  expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
    wakeRevision: queued.wakeRevision,
    deliveredRevision: 0,
  });
  const turns = await listSessionTurns(client.db, ctx.grant.workspaceId!, ctx.session.id, 10);
  expect(turns[0]).toMatchObject({ status: "queued", executionGeneration: 0 });
  const claim = await claimSessionWorkForAttempt(client.db, ctx.grant.workspaceId!, {
    sessionId: ctx.session.id,
    workflowId: wake.temporalWorkflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claim.action).toBe("claimed");
  expect(await dispatch()).toMatchObject({ signaled: 1, delivered: 1, pendingAdmission: 0 });
  expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
    deliveredRevision: queued.wakeRevision,
  });
  expect(signals).toBe(2);
});

test("transport acceptance survives a failed acknowledgment without consuming the wake", async () => {
  const ctx = await fixture();
  const queued = await send(ctx, "continue after the database recovers");
  const wake = (await claimPendingSessionWorkflowWakes(client.db, 1000)).find(
    (row) => row.sessionId === ctx.session.id,
  )!;
  const service = {
    db: client.db,
    observability: { info: () => {}, error: () => {} },
    wakeSessionWorkflow: async ({ onSignalAccepted }: { onSignalAccepted?: () => void }) => {
      // Fault at the acknowledgment boundary after transport accepted the signal.
      onSignalAccepted?.();
      throw new Error("acknowledgment database unavailable");
    },
  } as unknown as NotifyServices;
  const result = await reconcilePendingSessionWorkflowWakes(service, 1, {
    claimPendingSessionWorkflowWakes: async () => [wake],
  });
  expect(result).toMatchObject({ signaled: 1, delivered: 0, failed: 1 });
  expect(await wakeRow(ctx.grant.workspaceId!, ctx.session.id)).toMatchObject({
    wakeRevision: queued.wakeRevision,
    deliveredRevision: 0,
    lastError: "acknowledgment database unavailable",
  });
  const transportFailure = await reconcilePendingSessionWorkflowWakes(
    {
      ...service,
      wakeSessionWorkflow: async () => {
        throw new Error("transport unavailable");
      },
    },
    1,
    { claimPendingSessionWorkflowWakes: async () => [wake] },
  );
  expect(transportFailure).toMatchObject({ signaled: 0, delivered: 0, failed: 1 });
  // An immediate caller still sees the original failure instead of a false ACK.
  await expect(
    service.wakeSessionWorkflow!({
      accountId: wake.accountId,
      workspaceId: wake.workspaceId,
      sessionId: wake.sessionId,
      workflowId: wake.temporalWorkflowId,
      wakeRevision: wake.wakeRevision,
    }),
  ).rejects.toThrow("acknowledgment database unavailable");
});
