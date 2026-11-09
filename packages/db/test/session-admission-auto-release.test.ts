import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { and, eq } from "drizzle-orm";
import {
  blockSessionWorkBeforeAttemptClaim,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  peekSessionWork,
  releaseSessionAdmissionBlocksAfterAccessChange,
  withWorkspaceSessionActivityRls,
  withWorkspaceRls,
  type StoredSessionAdmissionBlock,
} from "../src";
import * as schema from "../src/schema";

// A saved message held by an admission block starts by itself once what
// blocked it changes: exactly once, never while paused, never for the wrong
// change, and never parked again by a claim that ran against the old access.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("admission-auto-release");
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
    accountExternalId: suffix,
    accountName: "Admission release",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Admission release",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Saved work",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  return { grant, workspaceId, sessionId: session.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function runnablePeek(f: Fixture) {
  const peek = await peekSessionWork(client.db, f.workspaceId, f.sessionId, true);
  if (peek.kind !== "runnable" || !peek.admissionFence) throw new Error("fixture not runnable");
  return peek;
}

async function block(
  f: Fixture,
  reason: StoredSessionAdmissionBlock["reason"] = "personal_resource_grant_required",
  sqlState: string | null = "OG002",
) {
  const peek = await runnablePeek(f);
  const blocked = await blockSessionWorkBeforeAttemptClaim(client.db, f.workspaceId, {
    accountId: f.grant.accountId,
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence!,
    wakeRevision: peek.admissionWakeRevision!,
    reason,
    sqlState,
  });
  expect(blocked.action).toBe("blocked");
}

function release(f: Fixture, change: "personal_resource" | "membership" | "machine", only = true) {
  return releaseSessionAdmissionBlocksAfterAccessChange(client.db, {
    accountId: f.grant.accountId,
    workspaceId: f.workspaceId,
    change,
    ...(only ? { sessionIds: [f.sessionId] } : {}),
  });
}

async function wake(f: Fixture) {
  const [row] = await withWorkspaceRls(client.db, f.workspaceId, (db) =>
    db
      .select()
      .from(schema.sessionWorkflowWakeOutbox)
      .where(
        and(
          eq(schema.sessionWorkflowWakeOutbox.workspaceId, f.workspaceId),
          eq(schema.sessionWorkflowWakeOutbox.sessionId, f.sessionId),
        ),
      ),
  );
  return row;
}

function claim(f: Fixture) {
  return claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

function control(f: Fixture, action: "pause" | "resume") {
  return withWorkspaceSessionActivityRls(client.db, f.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

test("a granted machine starts the saved message by itself, exactly once", async () => {
  const f = await fixture();
  await block(f);
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toEqual({
    kind: "admission-blocked",
  });
  const before = await wake(f);

  const first = await release(f, "personal_resource");
  expect(first.released.map((entry) => entry.sessionId)).toEqual([f.sessionId]);
  expect(first.released[0]!.events).toHaveLength(1);
  expect(first.released[0]!.events[0]).toMatchObject({
    type: "session.status.changed",
    payload: { status: "queued", code: "admission_access_changed" },
  });
  expect(await getSession(client.db, f.workspaceId, f.sessionId)).toMatchObject({
    status: "queued",
    admissionBlock: null,
  });
  const after = await wake(f);
  expect(after?.reason).toBe("admission_access_changed");
  expect(after!.wakeRevision).toBeGreaterThan(before?.wakeRevision ?? 0);
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toMatchObject({
    kind: "runnable",
  });

  // A second change, or the same one delivered twice, releases nothing more.
  const again = await release(f, "personal_resource");
  expect(again.released).toHaveLength(0);

  // The released work is claimed once; a second claimant finds nothing to start.
  expect(await claim(f)).toMatchObject({ action: "claimed" });
  expect((await claim(f)).action).not.toBe("claimed");
});

test("a workspace-wide change finds the blocked chat without naming it", async () => {
  const f = await fixture();
  await block(f, "database_claim_rejected", "42501");
  const released = await release(f, "membership", false);
  expect(released.released.map((entry) => entry.sessionId)).toContain(f.sessionId);
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).toBeNull();
});

test("a change that cannot fix the block leaves it alone", async () => {
  const f = await fixture();
  await block(f, "initiator_membership_required", "OG001");
  expect((await release(f, "personal_resource")).released).toHaveLength(0);
  expect((await release(f, "machine")).released).toHaveLength(0);
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toEqual({
    kind: "admission-blocked",
  });
  // An unknown database failure is never released by an access change.
  const g = await fixture();
  await block(g, "database_claim_rejected", "23505");
  expect((await release(g, "personal_resource")).released).toHaveLength(0);
  expect((await release(g, "membership")).released).toHaveLength(0);

  expect((await release(f, "membership")).released).toHaveLength(1);
});

test("a paused chat keeps its saved message until it is resumed", async () => {
  const f = await fixture();
  await block(f);
  await control(f, "pause");
  expect((await release(f, "personal_resource")).released).toHaveLength(0);
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).not.toBeNull();
  // Resume itself clears the block, as it always has.
  await control(f, "resume");
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).toBeNull();
});

test("a claim that ran against the old access is not parked after access changed", async () => {
  const f = await fixture();
  // The workflow reads its fence, then the claim is refused; access changes
  // before the refusal is recorded.
  const peek = await runnablePeek(f);
  const nudged = await release(f, "personal_resource");
  expect(nudged).toMatchObject({ released: [], nudged: [f.sessionId] });
  const stale = await blockSessionWorkBeforeAttemptClaim(client.db, f.workspaceId, {
    accountId: f.grant.accountId,
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence!,
    wakeRevision: peek.admissionWakeRevision!,
    reason: "personal_resource_grant_required",
    sqlState: "OG002",
  });
  expect(stale.action).toBe("stale");
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).toBeNull();
  // Re-read and refused again with nothing changed: now it is parked.
  await block(f);
});

test("a workspace-wide change also reaches a claim refused before it was recorded", async () => {
  const f = await fixture();
  // Restoring membership names no chat. A claim refused just before it must
  // not park afterwards with the old access, or nothing would ever start it.
  const peek = await runnablePeek(f);
  const nudged = await release(f, "membership", false);
  expect(nudged.nudged).toContain(f.sessionId);
  const stale = await blockSessionWorkBeforeAttemptClaim(client.db, f.workspaceId, {
    accountId: f.grant.accountId,
    sessionId: f.sessionId,
    workflowId: `session-${f.sessionId}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence!,
    wakeRevision: peek.admissionWakeRevision!,
    reason: "initiator_membership_required",
    sqlState: "OG001",
  });
  expect(stale.action).toBe("stale");
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).toBeNull();
  // A chat already running its message is not woken.
  expect(await claim(f)).toMatchObject({ action: "claimed" });
  expect((await release(f, "membership", false)).nudged).not.toContain(f.sessionId);
});
