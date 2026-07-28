import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, asc, eq } from "drizzle-orm";

import {
  addSessionSystemUpdate,
  beginSessionRealtimeInTransaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  endSessionRealtimeInTransaction,
  isSessionCompactionRequested,
  listOutstandingSessionSystemUpdates,
  mutateSessionControlInTransaction,
  peekSessionWork,
  renewSessionRealtimeInTransaction,
  requestSessionCompaction,
  saveComposerDraftInTransaction,
  SessionRealtimeConflictError,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  type Database,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-realtime");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 16 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `realtime-account-${suffix}`,
    accountName: "Realtime lifecycle",
    workspaceExternalSource: "test",
    workspaceExternalId: `realtime-workspace-${suffix}`,
    workspaceName: "Realtime lifecycle",
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
    sandboxBackend: "none",
  });
  return {
    grant: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      subjectId: grant.subjectId,
    },
    session,
  };
}

function owner(
  value: Fixture,
  overrides: Partial<{
    operationId: string;
    browserInstanceId: string;
    ownerKey: string;
  }> = {},
) {
  return {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    operationId: overrides.operationId ?? crypto.randomUUID(),
    ownerSubjectId: value.grant.subjectId,
    browserInstanceId: overrides.browserInstanceId ?? `browser-${crypto.randomUUID()}`,
    ownerKey: overrides.ownerKey ?? `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    model: "gpt-live-1-boulder-alpha" as const,
  };
}

async function begin(
  value: Fixture,
  input: ReturnType<typeof owner>,
  options: { now?: Date; leaseMs?: number } = {},
) {
  return await withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
    db.transaction((tx) =>
      beginSessionRealtimeInTransaction(tx as unknown as Database, {
        ...input,
        ...options,
      }),
    ),
  );
}

async function end(
  value: Fixture,
  input: ReturnType<typeof owner>,
  realtimeId: string,
  expectedVersion: number,
) {
  return await withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
    db.transaction((tx) =>
      endSessionRealtimeInTransaction(tx as unknown as Database, {
        workspaceId: value.grant.workspaceId,
        sessionId: value.session.id,
        realtimeId,
        ownerSubjectId: input.ownerSubjectId,
        browserInstanceId: input.browserInstanceId,
        ownerKey: input.ownerKey,
        expectedVersion,
        reason: "user_stop",
      }),
    ),
  );
}

function claim(value: Fixture) {
  return claimSessionWorkForAttempt(client.db, value.grant.workspaceId, {
    sessionId: value.session.id,
    workflowId: `session-${value.session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

async function addPendingUpdate(value: Fixture) {
  const updateId = crypto.randomUUID();
  return await addSessionSystemUpdate(client.db, {
    accountId: value.grant.accountId,
    workspaceId: value.grant.workspaceId,
    sessionId: value.session.id,
    classification: "info",
    sourceId: updateId,
    dedupeKey: `realtime-update-${updateId}`,
    summary: "durable update during realtime",
    kind: "scheduled_occurrence",
    payload: {
      type: "scheduled_occurrence",
      text: "durable update during realtime",
      scheduledTaskId: crypto.randomUUID(),
      scheduledTaskRunId: crypto.randomUUID(),
    },
  });
}

async function expectConflict(
  promise: Promise<unknown>,
  code: SessionRealtimeConflictError["code"],
) {
  try {
    await promise;
    throw new Error(`Expected realtime conflict ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SessionRealtimeConflictError);
    expect((error as SessionRealtimeConflictError).code).toBe(code);
  }
}

async function lifecycleRows(value: Fixture) {
  return await withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
    db
      .select({
        type: schema.sessionEvents.type,
        payload: schema.sessionEvents.payload,
        sequence: schema.sessionEvents.sequence,
      })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, value.grant.workspaceId),
          eq(schema.sessionEvents.sessionId, value.session.id),
        ),
      )
      .orderBy(asc(schema.sessionEvents.sequence)),
  );
}

async function waitForSessionLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`;
    if ((row?.count ?? 0) >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${minimum} session-row lock waiter(s)`);
}

async function withBlockedSession<T>(
  value: Fixture,
  run: (release: () => void) => Promise<T>,
): Promise<T> {
  let release!: () => void;
  let locked!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const blocker = shared.admin.begin(async (tx) => {
    await tx`select id from sessions where workspace_id = ${value.grant.workspaceId} and id = ${value.session.id} for update`;
    locked();
    await hold;
  });
  await ready;
  try {
    return await run(release);
  } finally {
    release();
    await blocker;
  }
}

describe("session realtime lifecycle (real PostgreSQL)", () => {
  test("starts, replays, renews, and ends one durable owner with ordered lifecycle events", async () => {
    const value = await fixture();
    const proof = owner(value);
    const started = await begin(value, proof);
    expect(started).toMatchObject({
      replay: false,
      workflowWakeRevision: null,
      mode: { state: "active", version: 1, connectionEpoch: 1 },
    });
    expect(started.eventIds).toHaveLength(1);

    const replay = await begin(value, proof);
    expect(replay.replay).toBe(true);
    expect(replay.mode.id).toBe(started.mode.id);
    expect(replay.eventIds).toEqual([]);

    const renewed = await withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
      db.transaction((tx) =>
        renewSessionRealtimeInTransaction(tx as unknown as Database, {
          workspaceId: value.grant.workspaceId,
          sessionId: value.session.id,
          realtimeId: started.mode.id,
          ownerSubjectId: proof.ownerSubjectId,
          browserInstanceId: proof.browserInstanceId,
          ownerKey: proof.ownerKey,
          expectedVersion: 1,
        }),
      ),
    );
    expect(renewed).toMatchObject({ replay: false, expired: false, mode: { version: 2 } });

    const ended = await end(value, proof, started.mode.id, 2);
    expect(ended.mode).toMatchObject({ state: "ended", version: 3, endReason: "user_stop" });
    expect(ended.workflowWakeRevision).toBeGreaterThan(0);
    expect(ended.eventIds).toHaveLength(1);

    const endReplay = await end(value, proof, started.mode.id, 2);
    expect(endReplay.replay).toBe(true);
    expect(endReplay.eventIds).toEqual([]);

    expect(
      (await lifecycleRows(value))
        .filter((event) => event.type.startsWith("session.realtime."))
        .map((event) => event.type),
    ).toEqual(["session.realtime.started", "session.realtime.ended"]);
  });

  test("fences owner and version changes and admits only one concurrent browser owner", async () => {
    const value = await fixture();
    const left = owner(value);
    const right = owner(value);
    const outcomes = await Promise.allSettled([begin(value, left), begin(value, right)]);
    const winner = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof begin>>> =>
        outcome.status === "fulfilled",
    );
    const loser = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser!.reason).toBeInstanceOf(SessionRealtimeConflictError);
    expect((loser!.reason as SessionRealtimeConflictError).code).toBe("REALTIME_ACTIVE");

    const winningProof = winner!.value.mode.operationId === left.operationId ? left : right;
    await expectConflict(
      end(
        value,
        { ...winningProof, ownerKey: `${winningProof.ownerKey}-wrong` },
        winner!.value.mode.id,
        1,
      ),
      "REALTIME_OWNER_MISMATCH",
    );
    await expectConflict(
      end(value, winningProof, winner!.value.mode.id, 99),
      "REALTIME_VERSION_CHANGED",
    );
  });

  test("rejects queued human work and paused control at admission", async () => {
    const queued = await fixture();
    await withWorkspaceRls(client.db, queued.grant.workspaceId, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as Database, {
          accountId: queued.grant.accountId,
          workspaceId: queued.grant.workspaceId,
          sessionId: queued.session.id,
          subjectId: queued.grant.subjectId,
          actor: { type: "human", subjectId: queued.grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "queued prompt",
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
    );
    await expectConflict(begin(queued, owner(queued)), "QUEUED_PROMPT");

    const paused = await fixture();
    await withWorkspaceRls(client.db, paused.grant.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateSessionControlInTransaction(tx as unknown as Database, {
          accountId: paused.grant.accountId,
          workspaceId: paused.grant.workspaceId,
          sessionId: paused.session.id,
          actor: { type: "human", subjectId: paused.grant.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await expectConflict(begin(paused, owner(paused)), "CONTROL_NOT_ACTIVE");
  });

  test("blocks composer and human Send while preserving ordinary inbound updates without a wake", async () => {
    const value = await fixture();
    const proof = owner(value);
    await begin(value, proof);

    await expect(
      withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
        db.transaction((tx) =>
          saveComposerDraftInTransaction(tx as unknown as Database, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId,
            sessionId: value.session.id,
            subjectId: value.grant.subjectId,
            expectedRevision: 0,
            text: "blocked draft",
            resources: [],
            tools: [],
            toolsProvided: false,
            model: "scripted-model",
            reasoningEffort: "low",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ACTIVE" });

    await expect(
      withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as Database, {
            accountId: value.grant.accountId,
            workspaceId: value.grant.workspaceId,
            sessionId: value.session.id,
            subjectId: value.grant.subjectId,
            actor: { type: "human", subjectId: value.grant.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "blocked send",
            resources: [],
            tools: [],
            reasoningEffortFallback: "low",
            source: "user",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "REALTIME_ACTIVE" });

    const update = await addPendingUpdate(value);
    expect(update).toMatchObject({ added: true, shouldWake: false, workflowWakeRevision: null });
    expect(
      await listOutstandingSessionSystemUpdates(
        client.db,
        value.grant.workspaceId,
        value.session.id,
      ),
    ).toHaveLength(1);
    expect(
      await peekSessionWork(client.db, value.grant.workspaceId, value.session.id),
    ).toMatchObject({
      kind: "realtime-active",
    });
    await expect(claim(value)).resolves.toEqual({ action: "unclaimed", reason: "realtime-active" });
  });

  test("claim first wins the session lock and makes concurrent realtime admission reject", async () => {
    const value = await fixture();
    await requestSessionCompaction(client.db, value.grant.workspaceId, value.session.id);
    const proof = owner(value);

    await withBlockedSession(value, async (release) => {
      const ordinaryClaim = claim(value);
      await waitForSessionLockWaiters(1);
      const realtimeBegin = begin(value, proof);
      await waitForSessionLockWaiters(2);
      release();

      await expect(ordinaryClaim).resolves.toMatchObject({ action: "claimed" });
      await expectConflict(realtimeBegin, "SESSION_NOT_IDLE");
    });
  });

  test("realtime first wins the session lock, preserves pending maintenance, and resumes it on end", async () => {
    const value = await fixture();
    await requestSessionCompaction(client.db, value.grant.workspaceId, value.session.id);
    const proof = owner(value);

    await withBlockedSession(value, async (release) => {
      const realtimeBegin = begin(value, proof);
      await waitForSessionLockWaiters(1);
      const ordinaryClaim = claim(value);
      await waitForSessionLockWaiters(2);
      release();

      const started = await realtimeBegin;
      await expect(ordinaryClaim).resolves.toEqual({
        action: "unclaimed",
        reason: "realtime-active",
      });
      expect(
        await isSessionCompactionRequested(client.db, value.grant.workspaceId, value.session.id),
      ).toBe(true);

      const ended = await end(value, proof, started.mode.id, started.mode.version);
      expect(ended.workflowWakeRevision).toBeGreaterThan(0);
      await expect(claim(value)).resolves.toMatchObject({ action: "claimed" });
    });
  });

  test("an expired lease ends durably under the claim lock and pending work is not lost", async () => {
    const value = await fixture();
    await addPendingUpdate(value);
    const proof = owner(value);
    const started = await begin(value, proof, {
      now: new Date(Date.now() - 10_000),
      leaseMs: 5_000,
    });

    await expect(claim(value)).resolves.toMatchObject({ action: "claimed" });
    const [row] = await withWorkspaceRls(client.db, value.grant.workspaceId, (db) =>
      db
        .select()
        .from(schema.sessionRealtimeModes)
        .where(eq(schema.sessionRealtimeModes.id, started.mode.id))
        .limit(1),
    );
    expect(row).toMatchObject({ state: "ended", endReason: "lease_expired", version: 2 });
    expect(
      (await lifecycleRows(value))
        .filter((event) => event.type.startsWith("session.realtime."))
        .map((event) => event.type),
    ).toEqual(["session.realtime.started", "session.realtime.ended"]);
  });
});
