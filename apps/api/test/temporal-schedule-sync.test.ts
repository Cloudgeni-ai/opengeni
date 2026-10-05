import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ScheduledTask } from "@opengeni/contracts";
import {
  ScheduledTaskSyncError,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  type SessionWorkflowClient,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  updateScheduledTask,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createTemporalScheduleSynchronizer } from "../src/temporal-schedule-sync";

let shared: SharedTestDatabase;
let client: DbClient;
let workspace: { accountId: string; workspaceId: string; subjectId: string };
let available = false;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("temporal-schedule-sync");
  if (!acquired) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Temporal schedule synchronization requires real PostgreSQL");
    return;
  }
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Schedule synchronization",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Schedule synchronization",
    subjectId: crypto.randomUUID(),
  });
  workspace = access.workspaceGrants[0]!;
  available = true;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function task(schedule: ScheduledTask["schedule"] = { type: "interval", everySeconds: 60 }) {
  return await createScheduledTask(client.db, {
    ...workspace,
    name: "Scheduled review",
    status: "active",
    schedule,
    temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    agentConfig: {
      prompt: "Review activity",
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
    createdBy: { kind: "subject", subjectId: workspace.subjectId },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const withDeadline = async <T>(deadline: number, work: () => Promise<T>): Promise<T> => {
  expect(deadline - Date.now()).toBeGreaterThan(0);
  expect(deadline - Date.now()).toBeLessThanOrEqual(5_000);
  return await work();
};

async function waitForScheduleLockWaiter(temporalScheduleId: string) {
  const key = `scheduled-task-temporal:${temporalScheduleId}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = await shared.admin<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_locks
      where locktype = 'advisory' and not granted and objsubid = 1
        and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${key}, 0) & 4294967295)::oid
    `;
    if (row?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected the second writer to wait for the schedule lock");
}

test.each(["interval", "manual"] as const)(
  "a late successful %s snapshot writes the newest recurring schedule",
  async (type) => {
    if (!available) return;
    const original = await task(type === "manual" ? { type } : { type, everySeconds: 60 });
    const latest = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
      schedule: { type: "interval", everySeconds: 3_600 },
      status: "paused",
    });
    const writes: ScheduledTask[] = [];
    const removals: string[] = [];
    const sync = createTemporalScheduleSynchronizer({
      db: client.db,
      withDeadline,
      upsert: async (saved) => {
        writes.push(saved);
      },
      remove: async (id) => {
        removals.push(id);
      },
    });
    await sync.sync(latest);
    await sync.sync(original);
    expect(writes).toEqual([latest, latest]);
    expect(removals).toEqual([]);
  },
);

test("overlapping writers serialize and the waiting replica rereads the newer edit", async () => {
  if (!available) return;
  const original = await task();
  const entered = deferred();
  const release = deferred();
  let external: ScheduledTask | null = null;
  const first = createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async (saved) => {
      entered.resolve();
      await release.promise;
      external = saved;
    },
    remove: async () => {
      throw new Error("Unexpected removal");
    },
  });
  const second = createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async (saved) => {
      external = saved;
    },
    remove: async () => {
      throw new Error("Unexpected removal");
    },
  });
  const running = first.sync(original);
  await entered.promise;
  const latest = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
    schedule: { type: "interval", everySeconds: 7_200 },
  });
  // Even a replica handed the obsolete row must reread after taking the lock.
  const waiting = second.sync(original);
  try {
    await waitForScheduleLockWaiter(original.temporalScheduleId);
    expect(external).toBeNull();
  } finally {
    release.resolve();
    await Promise.all([running, waiting]);
  }
  expect(external).toEqual(latest);
  expect(await getScheduledTask(client.db, workspace.workspaceId, original.id)).toEqual(latest);
});

test("cleanup follows an in-flight sync and a delayed sync cannot resurrect a tombstone", async () => {
  if (!available) return;
  const original = await task();
  const entered = deferred();
  const release = deferred();
  let present = false;
  const writes: string[] = [];
  const sync = createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async () => {
      entered.resolve();
      await release.promise;
      present = true;
      writes.push("upsert");
    },
    remove: async () => {
      present = false;
      writes.push("delete");
    },
  });
  const running = sync.sync(original);
  await entered.promise;
  await deleteScheduledTask(client.db, workspace.workspaceId, original.id);
  const cleanup = sync.remove(original.temporalScheduleId);
  try {
    await waitForScheduleLockWaiter(original.temporalScheduleId);
    expect(writes).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([running, cleanup]);
  }
  expect(present).toBe(false);
  await sync.sync(original);
  expect(present).toBe(false);
  expect(writes).toEqual(["upsert", "delete", "delete"]);
});

test("a current manual schedule removes the old recurring schedule", async () => {
  if (!available) return;
  const original = await task();
  await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
    schedule: { type: "manual" },
  });
  const removed: string[] = [];
  await createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async () => {
      throw new Error("Manual schedules cannot create timers");
    },
    remove: async (id) => {
      removed.push(id);
    },
  }).sync(original);
  expect(removed).toEqual([original.temporalScheduleId]);
});

test("an unknown network outcome propagates unchanged and releases the writer lock", async () => {
  if (!available) return;
  const original = await task();
  const failure = new Error("Synthetic acknowledgement lost");
  let attempts = 0;
  const sync = createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async () => {
      if (attempts++ === 0) throw failure;
    },
    remove: async () => {},
  });
  await expect(sync.sync(original)).rejects.toBe(failure);
  await sync.sync(original);
  expect(attempts).toBe(2);
});

test.each(["restore", "delete"] as const)(
  "a queued writer observes committed %s compensation after a failed sync",
  async (compensation) => {
    if (!available) return;
    const original = await task();
    const changed =
      compensation === "delete"
        ? original
        : await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
            schedule: { type: "interval", everySeconds: 7_200 },
          });
    const entered = deferred();
    const release = deferred();
    const failure = new Error("Synthetic sync rejection");
    let external: ScheduledTask | null = original;
    const failing = createTemporalScheduleSynchronizer({
      db: client.db,
      withDeadline,
      upsert: async () => {
        throw failure;
      },
      remove: async () => {},
    });
    const next = createTemporalScheduleSynchronizer({
      db: client.db,
      withDeadline,
      upsert: async (saved) => {
        external = saved;
      },
      remove: async () => {
        external = null;
      },
    });
    const workflowClient = {
      syncScheduledTask: async ({ task: saved, onFailure }) =>
        failing.sync(saved, async (tx, error) => {
          expect(error).toBe(failure);
          entered.resolve();
          await release.promise;
          return await onFailure!(tx, error);
        }),
    } as SessionWorkflowClient;
    const input = { db: client.db, workflowClient, task: changed };
    const running = (
      compensation === "delete"
        ? syncCreatedScheduledTask(input)
        : syncUpdatedScheduledTask({ ...input, previous: { task: original } })
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    const waiting = next.sync(changed);
    let result: unknown;
    try {
      await waitForScheduleLockWaiter(original.temporalScheduleId);
      expect(
        (await getScheduledTask(client.db, workspace.workspaceId, original.id))?.schedule,
      ).toEqual(changed.schedule);
    } finally {
      release.resolve();
      [result] = await Promise.all([running, waiting]);
    }
    expect(result).toBeInstanceOf(ScheduledTaskSyncError);
    expect(result).toMatchObject({ persistenceRestored: true, cause: failure });
    const saved = await getScheduledTask(client.db, workspace.workspaceId, original.id);
    expect(external).toEqual(saved);
    if (compensation === "delete") expect(saved).toBeNull();
    else expect(saved?.schedule).toEqual(original.schedule);
  },
);

test("a failed transaction commit never reports compensation as committed", async () => {
  if (!available) return;
  const original = await task();
  const changed = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
    schedule: { type: "interval", everySeconds: 7_200 },
  });
  const failure = new Error("Synthetic sync rejection");
  const commitFailure = new Error("Synthetic transaction commit failure");
  const failedCommitDb = {
    transaction: async (work: (tx: Database) => Promise<unknown>) =>
      client.db.transaction(async (tx) => {
        await work(tx);
        throw commitFailure;
      }),
  } as Database;
  const sync = createTemporalScheduleSynchronizer({
    db: failedCommitDb,
    withDeadline,
    upsert: async () => {
      throw failure;
    },
    remove: async () => {},
  });
  await expect(
    syncUpdatedScheduledTask({
      db: client.db,
      task: changed,
      previous: { task: original },
      workflowClient: {
        syncScheduledTask: async ({ task: saved, onFailure }) => sync.sync(saved, onFailure),
      } as SessionWorkflowClient,
    }),
  ).rejects.toMatchObject({ persistenceRestored: false, cause: commitFailure });
  expect(await getScheduledTask(client.db, workspace.workspaceId, original.id)).toEqual(changed);
});

test("a failed compensation savepoint rolls back its edits and reports unrestored persistence", async () => {
  if (!available) return;
  const original = await task();
  const changed = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
    schedule: { type: "interval", everySeconds: 7_200 },
  });
  const failure = new Error("Synthetic sync rejection");
  const sync = createTemporalScheduleSynchronizer({
    db: client.db,
    withDeadline,
    upsert: async () => {
      throw failure;
    },
    remove: async () => {},
  });
  await expect(
    syncUpdatedScheduledTask({
      db: client.db,
      task: changed,
      previous: { task: original },
      workflowClient: {
        syncScheduledTask: async ({ task: saved, onFailure }) =>
          sync.sync(saved, async (tx, error) =>
            onFailure!(
              {
                transaction: async (work: (savepoint: Database) => Promise<unknown>) =>
                  tx.transaction(async (savepoint) => {
                    await work(savepoint);
                    throw new Error("Synthetic compensation savepoint failure");
                  }),
              } as Database,
              error,
            ),
          ),
      } as SessionWorkflowClient,
    }),
  ).rejects.toMatchObject({ persistenceRestored: false, cause: failure });
  expect(await getScheduledTask(client.db, workspace.workspaceId, original.id)).toEqual(changed);
});

test.each(["create", "update"] as const)(
  "failed %s synchronization cannot compensate over a concurrent name-only edit",
  async (operation) => {
    if (!available) return;
    const original = await task();
    const changed =
      operation === "create"
        ? original
        : await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
            schedule: { type: "interval", everySeconds: 7_200 },
          });
    const entered = deferred();
    const release = deferred();
    const failure = new Error("Synthetic sync rejection");
    let external: ScheduledTask | null = original;
    const failing = createTemporalScheduleSynchronizer({
      db: client.db,
      withDeadline,
      upsert: async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      },
      remove: async () => {
        throw new Error("Unexpected removal");
      },
    });
    const workflowClient = {
      syncScheduledTask: async ({ task: saved, onFailure }) => failing.sync(saved, onFailure),
    } as SessionWorkflowClient;
    const input = { db: client.db, workflowClient, task: changed };
    const running = (
      operation === "create"
        ? syncCreatedScheduledTask(input)
        : syncUpdatedScheduledTask({ ...input, previous: { task: original } })
    ).catch((error: unknown) => error);
    await entered.promise;
    let latest: ScheduledTask;
    let result: unknown;
    try {
      latest = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
        name: "Concurrent edit must survive",
      });
      // Names are outside the execution digest; compensation must fence the
      // complete saved row, not only the execution configuration.
      expect(latest.executionDigest).toBe(changed.executionDigest);
    } finally {
      release.resolve();
      result = await running;
    }
    expect(result).toBeInstanceOf(ScheduledTaskSyncError);
    expect(result).toMatchObject({ persistenceRestored: false, cause: failure });
    expect(await getScheduledTask(client.db, workspace.workspaceId, original.id)).toEqual(latest!);
    await createTemporalScheduleSynchronizer({
      db: client.db,
      withDeadline,
      upsert: async (saved) => {
        external = saved;
      },
      remove: async () => {
        external = null;
      },
    }).sync(changed);
    expect(external).toEqual(latest!);
  },
);
