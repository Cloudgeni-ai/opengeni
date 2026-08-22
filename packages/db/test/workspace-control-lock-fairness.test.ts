import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  evaluateSessionControl,
  lockWorkspaceInferenceControl,
  lockWorkspaceInferenceControlForAdmission,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  submitHumanPromptInTransaction,
  WorkspaceControlBusyError,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
} from "../src/index";

// Real PostgreSQL lock semantics are the subject under test. The shared
// container can be slow under the repository-wide parallel run; keep a finite
// file-scoped ceiling so contention cannot cascade into timeouts.
setDefaultTimeout(60_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let admin: postgres.Sql;

type Grant = { accountId: string; workspaceId: string; subjectId: string };

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("workspace-control-lock-fairness");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 32 });
  admin = postgres(shared.adminUrl, { max: 4, prepare: false });
}, 180_000);

afterAll(async () => {
  await admin?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function fixture(sessionCount = 1) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Workspace control lock fairness",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Workspace control lock fairness",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const sessions: string[] = [];
  for (let index = 0; index < sessionCount; index += 1) {
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
    sessions.push(session.id);
  }
  const typedGrant: Grant = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  return { grant: typedGrant, sessions };
}

/**
 * Run one Send and optionally keep its transaction open after the prompt is
 * admitted so the held control prefix can be inspected from another backend.
 */
async function send(
  grant: Grant,
  sessionId: string,
  text: string,
  options: {
    delivery?: "send" | "steer";
    controlLockTimeoutMs?: number;
    holdOpen?: { admitted: () => void; release: Promise<void> };
  } = {},
) {
  return await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    async (db) => {
      const result = await submitHumanPromptInTransaction(db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: `${options.delivery ?? "send"}-${text}-${crypto.randomUUID()}`,
        delivery: options.delivery ?? "send",
        text,
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
        ...(options.controlLockTimeoutMs !== undefined
          ? { controlLockTimeoutMs: options.controlLockTimeoutMs }
          : {}),
      });
      if (options.holdOpen) {
        options.holdOpen.admitted();
        await options.holdOpen.release;
      }
      return result;
    },
  );
}

async function controlSession(grant: Grant, sessionId: string, action: "pause" | "resume") {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function controlWorkspace(
  grant: Grant,
  action: "pause" | "resume",
  options: { holdOpen?: { applied: () => void; release: Promise<void> } } = {},
) {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
    const result = await mutateWorkspaceControlInTransaction(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
      reason: "fairness test",
    });
    if (options.holdOpen) {
      options.holdOpen.applied();
      await options.holdOpen.release;
    }
    return result;
  });
}

async function effectiveState(grant: Grant, sessionId: string) {
  return await withWorkspaceRls(
    client.db,
    grant.workspaceId,
    async (db) =>
      (await evaluateSessionControl(db, grant.workspaceId, sessionId, { lock: "none" })).state,
  );
}

/** Probe the control prefix from an independent superuser backend without waiting. */
async function probeControlPrefix(workspaceId: string) {
  const key = `workspace-control:${workspaceId}`;
  return await admin.begin(async (tx) => {
    const [advisoryShared] = await tx<{ ok: boolean }[]>`
      select pg_try_advisory_xact_lock_shared(hashtextextended(${key}, 0)) as ok`;
    const [advisoryExclusive] = await tx<{ ok: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`;
    // SKIP LOCKED returns no row when the requested row mode conflicts with a
    // lock another backend holds, without aborting the probe transaction.
    const [rowShare] = await tx<{ ok: boolean }[]>`
      select exists (
        select 1 from workspace_inference_controls
        where workspace_id = ${workspaceId} for share skip locked
      ) as ok`;
    const [rowUpdate] = await tx<{ ok: boolean }[]>`
      select exists (
        select 1 from workspace_inference_controls
        where workspace_id = ${workspaceId} for update skip locked
      ) as ok`;
    return {
      advisoryShared: advisoryShared!.ok,
      advisoryExclusive: advisoryExclusive!.ok,
      rowShare: rowShare!.ok,
      rowUpdate: rowUpdate!.ok,
    };
  });
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    Bun.sleep(ms).then(() => pending),
  ]);
  return outcome !== pending;
}

describe("workspace control lock fairness", () => {
  test("a Send on an active session holds the control prefix shared, not exclusive", async () => {
    const { grant, sessions } = await fixture();
    const admitted = deferred();
    const release = deferred();
    const held = send(grant, sessions[0]!, "hold shared", {
      holdOpen: { admitted: admitted.resolve, release: release.promise },
    });
    await admitted.promise;
    try {
      const probe = await probeControlPrefix(grant.workspaceId);
      // Shared holders remain compatible with other shared admission...
      expect(probe.advisoryShared).toBe(true);
      expect(probe.rowShare).toBe(true);
      // ...while a genuine control mutation still waits for the Send to commit.
      expect(probe.advisoryExclusive).toBe(false);
      expect(probe.rowUpdate).toBe(false);
    } finally {
      release.resolve();
    }
    await held;
  });

  test("a Send on a paused branch escalates to the exclusive prefix without a deadlock", async () => {
    const { grant, sessions } = await fixture(8);
    for (const sessionId of sessions) await controlSession(grant, sessionId, "pause");
    const admitted = deferred();
    const release = deferred();
    const held = send(grant, sessions[0]!, "resume by send", {
      holdOpen: { admitted: admitted.resolve, release: release.promise },
    });
    await admitted.promise;
    try {
      const probe = await probeControlPrefix(grant.workspaceId);
      expect(probe.advisoryShared).toBe(false);
      expect(probe.rowShare).toBe(false);
    } finally {
      release.resolve();
    }
    const first = await held;
    expect(first.workspaceControlEventId).not.toBeNull();
    expect(await effectiveState(grant, sessions[0]!)).toBe("active");

    // Concurrent Sends to paused sessions all take the shared prefix, observe
    // the pause, release it through the savepoint, and queue for the exclusive
    // prefix. None may fail with a deadlock (no retry wrapper is involved here).
    const results = await Promise.all(
      sessions.slice(1).map((sessionId, index) => send(grant, sessionId, `resume ${index}`)),
    );
    for (const result of results) expect(result.workspaceControlEventId).not.toBeNull();
    for (const sessionId of sessions) expect(await effectiveState(grant, sessionId)).toBe("active");
  });

  test("a Send arriving during a Pause waits for it and then resumes its branch", async () => {
    const { grant, sessions } = await fixture();
    const applied = deferred();
    const release = deferred();
    const pause = controlWorkspace(grant, "pause", {
      holdOpen: { applied: applied.resolve, release: release.promise },
    });
    await applied.promise;
    const blockedSend = send(grant, sessions[0]!, "blocked behind pause");
    expect(await settledWithin(blockedSend, 400)).toBe(false);
    release.resolve();
    await pause;
    const result = await blockedSend;
    // The Send took the shared prefix after the Pause committed, observed the
    // paused workspace, and escalated to resume its own branch.
    expect(result.workspaceControlEventId).not.toBeNull();
    expect(await effectiveState(grant, sessions[0]!)).toBe("active");

    // And the mirror image: a Pause waits for an in-flight Send to commit.
    const admitted = deferred();
    const releaseSend = deferred();
    const heldSend = send(grant, sessions[0]!, "hold against pause", {
      holdOpen: { admitted: admitted.resolve, release: releaseSend.promise },
    });
    await admitted.promise;
    const blockedPause = controlSession(grant, sessions[0]!, "pause");
    expect(await settledWithin(blockedPause, 400)).toBe(false);
    releaseSend.resolve();
    await heldSend;
    await blockedPause;
    expect(await effectiveState(grant, sessions[0]!)).toBe("paused");
  });

  test("a waiting control mutation is not starved by continuous shared admission", async () => {
    const { grant } = await fixture();
    const workspaceId = grant.workspaceId;
    const HOLDERS = 8;

    type Holder = { acquired: Promise<void>; release: () => void; done: Promise<void> };
    function spawnHolder(acquire: (tx: Database) => Promise<void>): Holder {
      const acquired = deferred();
      const release = deferred();
      const done = withWorkspaceRls(client.db, workspaceId, async (db) => {
        await acquire(db);
        acquired.resolve();
        await release.promise;
      });
      return { acquired: acquired.promise, release: release.resolve, done };
    }

    // Before: bare row locks. A new FOR SHARE joins the share-locked tuple
    // without queueing behind the waiting FOR UPDATE, so an unbroken relay of
    // sharers keeps the mutator waiting until the very last one commits.
    {
      const rowShare = async (tx: Database) => {
        await tx.execute(
          sql`select 1 from workspace_inference_controls where workspace_id = ${workspaceId} for share`,
        );
      };
      const holders = [spawnHolder(rowShare)];
      await holders[0]!.acquired;
      const mutation = withWorkspaceRls(client.db, workspaceId, async (db) => {
        await db.execute(
          sql`select 1 from workspace_inference_controls where workspace_id = ${workspaceId} for update`,
        );
      });
      expect(await settledWithin(mutation, 200)).toBe(false);
      for (let index = 1; index < HOLDERS; index += 1) {
        const next = spawnHolder(rowShare);
        holders.push(next);
        // The successor joins immediately despite the queued FOR UPDATE.
        expect(await settledWithin(next.acquired, 2_000)).toBe(true);
        holders[index - 1]!.release();
        await holders[index - 1]!.done;
        expect(await settledWithin(mutation, 50)).toBe(false);
      }
      holders[HOLDERS - 1]!.release();
      await holders[HOLDERS - 1]!.done;
      expect(await settledWithin(mutation, 5_000)).toBe(true);
      await mutation;
    }

    // After: the canonical helper. The advisory lock queues the very next
    // shared requester behind the waiting mutation, so the mutator waits only
    // for the holders that preceded it and sharers resume afterwards.
    {
      const helperShare = async (tx: Database) => {
        await lockWorkspaceInferenceControl(tx, workspaceId, "share");
      };
      const first = spawnHolder(helperShare);
      await first.acquired;
      const mutation = withWorkspaceRls(client.db, workspaceId, async (db) => {
        await lockWorkspaceInferenceControl(db, workspaceId, "update");
      });
      expect(await settledWithin(mutation, 200)).toBe(false);
      const successor = spawnHolder(helperShare);
      // The successor is queued behind the waiting mutation instead of joining.
      expect(await settledWithin(successor.acquired, 500)).toBe(false);
      first.release();
      await first.done;
      expect(await settledWithin(mutation, 5_000)).toBe(true);
      await mutation;
      // Sharers flow again once the mutation commits.
      expect(await settledWithin(successor.acquired, 5_000)).toBe(true);
      successor.release();
      await successor.done;
    }
  });
  test("request-scoped admission fails typed and retryable when the prefix stays busy", async () => {
    const { grant, sessions } = await fixture();
    const reserved = await admin.reserve();
    let holding = true;
    await reserved`begin`;
    await reserved`select 1 from workspace_inference_controls where workspace_id = ${grant.workspaceId} for update`;
    try {
      const started = Date.now();
      await expect(
        send(grant, sessions[0]!, "bounded", { controlLockTimeoutMs: 250 }),
      ).rejects.toBeInstanceOf(WorkspaceControlBusyError);
      expect(Date.now() - started).toBeLessThan(5_000);
      // Lifecycle callers never pass a bound: they keep waiting.
      const unbounded = send(grant, sessions[0]!, "unbounded");
      expect(await settledWithin(unbounded, 400)).toBe(false);
      holding = false;
      await reserved`rollback`;
      await unbounded;
    } finally {
      if (holding) await reserved`rollback`;
      reserved.release();
    }
    // A successful bounded acquisition restores the prior lock_timeout for the
    // rest of the transaction.
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      await lockWorkspaceInferenceControl(db, grant.workspaceId, "share", { lockTimeoutMs: 250 });
      const [row] = await db.execute<{ value: string }>(
        sql`select current_setting('lock_timeout') as value`,
      );
      expect(row?.value).toBe("0");
    });
  });

  test("a nested admission inside an exclusive admission keeps the exclusive prefix", async () => {
    // Realtime ledger sync on a paused branch escalates to the exclusive prefix
    // and then re-enters the same admission helper for its delegation Send:
    // the inner shared attempt is taken and rolled back inside its savepoint
    // while the outer exclusive prefix stays held for the whole transaction.
    const { grant, sessions } = await fixture();
    await controlSession(grant, sessions[0]!, "pause");
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      const outer = await lockWorkspaceInferenceControlForAdmission(db, {
        workspaceId: grant.workspaceId,
        sessionId: sessions[0]!,
      });
      expect(outer.mode).toBe("update");
      const inner = await lockWorkspaceInferenceControlForAdmission(db, {
        workspaceId: grant.workspaceId,
        sessionId: sessions[0]!,
      });
      expect(inner.mode).toBe("update");
      expect(inner.control.revision).toEqual(outer.control.revision);
      const probe = await probeControlPrefix(grant.workspaceId);
      expect(probe.advisoryShared).toBe(false);
      expect(probe.rowShare).toBe(false);
    });
    // Nothing leaked past the transaction.
    const after = await probeControlPrefix(grant.workspaceId);
    expect(after.advisoryExclusive).toBe(true);
    expect(after.rowUpdate).toBe(true);
  });

  test("the bounded wait is one budget across the advisory and row steps", async () => {
    const { grant, sessions } = await fixture();
    const workspaceId = grant.workspaceId;
    const key = `workspace-control:${workspaceId}`;
    // Backend A holds the advisory lock exclusively for ~350 ms; backend B
    // holds the row exclusively for the whole test. A 600 ms budget therefore
    // spends ~350 ms on the advisory step and must fail on the row step at
    // roughly 600 ms total, not 350 ms + another full 600 ms.
    const advisoryHolder = await admin.reserve();
    const rowHolder = await admin.reserve();
    try {
      await rowHolder`begin`;
      await rowHolder`select 1 from workspace_inference_controls where workspace_id = ${workspaceId} for update`;
      await advisoryHolder`begin`;
      await advisoryHolder`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const releaseAdvisory = Bun.sleep(350).then(async () => {
        await advisoryHolder`rollback`;
      });
      const started = Date.now();
      await expect(
        send(grant, sessions[0]!, "budgeted", { controlLockTimeoutMs: 600 }),
      ).rejects.toBeInstanceOf(WorkspaceControlBusyError);
      const elapsed = Date.now() - started;
      await releaseAdvisory;
      expect(elapsed).toBeGreaterThanOrEqual(500);
      expect(elapsed).toBeLessThan(950);
      await rowHolder`rollback`;
    } finally {
      advisoryHolder.release();
      rowHolder.release();
    }
  });

  test("concurrent Sends, Steers, and event appends on one workspace all commit", async () => {
    const { grant, sessions } = await fixture(6);
    const work: Promise<unknown>[] = [];
    for (const [index, sessionId] of sessions.entries()) {
      work.push(send(grant, sessionId, `send ${index} a`));
      work.push(send(grant, sessionId, `send ${index} b`));
      work.push(send(grant, sessionId, `steer ${index}`, { delivery: "steer" }));
      work.push(
        appendSessionEvents(client.db, grant.workspaceId, sessionId, [
          { type: "session.title_set", payload: { title: `title ${index}` } },
        ]),
      );
    }
    const started = Date.now();
    await Promise.all(work);
    expect(Date.now() - started).toBeLessThan(30_000);
    for (const sessionId of sessions) expect(await effectiveState(grant, sessionId)).toBe("active");
  });
});
