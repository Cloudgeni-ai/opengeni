import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acquireLease,
  bootstrapWorkspace,
  commitWarmingToWarm,
  createDb,
  createSession,
  deleteSessionTreeIfQuiescent,
  forceDrainOverLimitViewerOnlyBoxes,
  releaseLeaseHolder,
  reapStaleLeaseHolders,
  reapStaleLeaseHoldersGlobal,
  type Database,
  type DbClient,
} from "../src/index";

// 0840: Opengeni compute's fabric sleeps an idle sandbox itself and keeps its
// memory and disk, so a compute lease is never drained for being idle. It
// stays warm without holders until its group ends (session or workspace
// deletion asks for the teardown) or it rotates. Other backends drain exactly
// as before. Runs as opengeni_app so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("compute-lease-lifecycle");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[compute-lease-lifecycle] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

async function fixture(backend: "compute" | "modal") {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "compute-lease-test",
    accountExternalId: id,
    accountName: "Compute lease test",
    workspaceExternalSource: "compute-lease-test",
    workspaceExternalId: id,
    workspaceName: "Compute lease test",
    subjectId: `subject-${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: backend,
  });
  const ids = {
    accountId: grant.accountId,
    workspaceId,
    sandboxGroupId: session.sandboxGroupId,
  };
  await acquireLease(db, {
    ...ids,
    kind: "turn",
    holderId: "turn-1",
    backend,
    leaseTtlMs: 45_000,
  });
  await commitWarmingToWarm(db, {
    ...ids,
    expectedEpoch: 0,
    instanceId: `${backend}-box`,
    leaseTtlMs: 45_000,
  });
  return { grant, session, ids };
}

async function readRow(workspaceId: string, groupId: string) {
  const [row] = await admin<{ liveness: string; expires_at: Date; refcount: number }[]>`
    select liveness, expires_at, refcount from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return row;
}

async function releaseLastHolder(ids: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
}) {
  return await releaseLeaseHolder(db, {
    ...ids,
    kind: "turn",
    holderId: "turn-1",
    idleGraceMs: 0,
  });
}

describe("compute leases and idle drain", () => {
  test("a compute lease stays warm when its last holder leaves; Modal still drains", async () => {
    if (!available) return;
    const compute = await fixture("compute");
    const modal = await fixture("modal");
    expect((await releaseLastHolder(compute.ids))?.liveness).toBe("warm");
    expect((await releaseLastHolder(modal.ids))?.liveness).toBe("draining");
  }, 60_000);

  test("neither the workspace sweep nor the global reaper idles a compute lease out", async () => {
    if (!available) return;
    const { ids } = await fixture("compute");
    await releaseLastHolder(ids);
    const sweep = await reapStaleLeaseHolders(db, {
      workspaceId: ids.workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 0,
    });
    expect(sweep.drained.some((row) => row.sandboxGroupId === ids.sandboxGroupId)).toBe(false);
    const global = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 90_000,
      idleGraceMs: 0,
    });
    expect(global.some((row) => row.sandboxGroupId === ids.sandboxGroupId)).toBe(false);
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
  }, 60_000);

  test("the global reaper still drains a compute lease that must rotate", async () => {
    if (!available) return;
    const { ids } = await fixture("compute");
    await releaseLastHolder(ids);
    // The holder recount happens in the reaper itself: restore a stale count so
    // its idle transition is what decides.
    await admin`
      update sandbox_leases set rotation_requested_at = now(), rotation_reason = 'operator', refcount = 1
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 90_000,
      idleGraceMs: 0,
    });
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("draining");
  }, 60_000);

  test("the warm-seconds cap never force-drains a compute lease", async () => {
    if (!available) return;
    const { ids } = await fixture("compute");
    await releaseLastHolder(ids);
    const forced = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ids.workspaceId,
      enforceBalance: false,
      maxWarmSecondsPerWorkspace: 0,
      idleGraceMs: 0,
    });
    expect(forced.drained.some((row) => row.sandboxGroupId === ids.sandboxGroupId)).toBe(false);
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
  }, 60_000);

  test("deleting the chat ends the compute group: its lease drains now", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    await releaseLastHolder(ids);
    const first = await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(first.status).toBe("live_sandboxes");
    const row = await readRow(ids.workspaceId, ids.sandboxGroupId);
    expect(row?.liveness).toBe("draining");
    expect(row!.expires_at.getTime()).toBeLessThan(Date.now());
    // The reaper's teardown deletes the sandbox and settles the lease cold.
    await admin`
      update sandbox_leases set liveness = 'cold', instance_id = null
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    const second = await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(second.status).toBe("deleted");
  }, 60_000);

  test("a compute lease with a live holder is not ended by a deletion attempt", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    const result = await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(result.status).not.toBe("deleted");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
  }, 60_000);
});
