import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  accrueWarmSeconds,
  acquireLease,
  bootstrapWorkspace,
  commitWarmingToWarm,
  computeSandboxNamed,
  createDb,
  createSandboxEnrollment,
  createSession,
  deleteSessionTreeIfQuiescent,
  forceDrainOverLimitViewerOnlyBoxes,
  openSandboxAgentLink,
  releaseLeaseHolder,
  reapStaleLeaseHolders,
  reapStaleLeaseHoldersGlobal,
  recordComputeSandboxPower,
  revokeSandboxEnrollment,
  type Database,
  type DbClient,
} from "../src/index";

// 0843: Opengeni compute's fabric sleeps an idle sandbox itself and keeps its
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
    // The drain is marked as a group end, so the reaper deletes without capture.
    expect(await groupEndRequestedAt(ids)).not.toBeNull();
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

  test("a lease re-armed after a deletion attempt forgets the group end", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    await releaseLastHolder(ids);
    await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(await groupEndRequestedAt(ids)).not.toBeNull();
    // A verified live box (as the turn that warmed it records).
    await admin`
      update sandbox_leases set resume_state = jsonb_set(
        jsonb_set(resume_state, '{opengeniRecovery,workspace,status}', '"ready"'),
        '{opengeniRecovery,provider}',
        jsonb_build_object('status', 'exists', 'instanceId', instance_id, 'observedAt', now()::text))
        || jsonb_build_object('opengeniProviderInstanceId', instance_id)
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    const arrival = await acquireLease(db, {
      ...ids,
      kind: "turn",
      holderId: "turn-2",
      backend: "compute",
      leaseTtlMs: 45_000,
    });
    expect(arrival.role).toBe("rearmed");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
    expect(await groupEndRequestedAt(ids)).toBeNull();
  }, 60_000);
});

async function groupEndRequestedAt(ids: { workspaceId: string; sandboxGroupId: string }) {
  const [row] = await admin<{ group_end_requested_at: Date | null }[]>`
    select group_end_requested_at from sandbox_leases
    where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
  return row?.group_end_requested_at ?? null;
}

describe("compute warm time follows the sandbox's sleep", () => {
  async function sleepingFixture() {
    const { ids } = await fixture("compute");
    const agentId = crypto.randomUUID();
    await createSandboxEnrollment(db, {
      ...ids,
      enrollmentId: agentId,
      hasDisplay: false,
      workspaceRoot: "/workspace",
    });
    // Warm since 300 s ago, never metered.
    await admin`
      update sandbox_leases set
        last_meter_at = null,
        resume_state = jsonb_set(resume_state, '{opengeniRecovery,restore,completedAt}',
          to_jsonb(${new Date(Date.now() - 300_000).toISOString()}::text))
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    const [lease] = await admin<{ lease_epoch: string }[]>`
      select lease_epoch from sandbox_leases
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    // The host's link session holds the agent under owner epoch 1.
    const claim = {
      workspaceId: ids.workspaceId,
      agentId,
      epoch: 1,
      connectionInstanceId: crypto.randomUUID(),
    };
    expect(await openSandboxAgentLink(db, { ...claim, leaseMs: 20_000 })).toMatchObject({
      opened: true,
    });
    const power = (asleep: boolean, sandboxId = "compute-box", from: typeof claim = claim) =>
      recordComputeSandboxPower(db, { ...from, sandboxId, asleep });
    const accrue = () =>
      accrueWarmSeconds(db, {
        ...ids,
        expectedEpoch: Number(lease!.lease_epoch),
        warmRateMicrosPerSecond: 0,
        billingMode: "usage_only",
      });
    /** Pretend the sandbox fell asleep this many seconds ago. */
    const backdateSleep = (seconds: number) => admin`
      update sandbox_leases set compute_asleep_since = now() - make_interval(secs => ${seconds})
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    return { ids, agentId, claim, power, accrue, backdateSleep };
  }

  test("no warm time accrues while asleep; the awake time before it still does", async () => {
    if (!available) return;
    const { power, accrue, backdateSleep } = await sleepingFixture();
    expect(await power(true)).toEqual({ accepted: true, changed: true });
    expect(await power(true)).toEqual({ accepted: true, changed: false });
    await backdateSleep(200);
    // Awake 100 s, then asleep 200 s: only the 100 s accrue.
    const first = await accrue();
    expect(first.seconds).toBeGreaterThanOrEqual(99);
    expect(first.seconds).toBeLessThanOrEqual(101);
    expect((await accrue()).accrued).toBe(false);
    expect(await power(false)).toEqual({ accepted: true, changed: true });
    expect((await accrue()).seconds).toBeLessThanOrEqual(1);
  }, 60_000);

  test("waking moves the cursor past the sleep, keeping unbilled awake time", async () => {
    if (!available) return;
    const { power, accrue, backdateSleep } = await sleepingFixture();
    await power(true);
    await backdateSleep(200);
    await power(false);
    const tick = await accrue();
    expect(tick.seconds).toBeGreaterThanOrEqual(99);
    expect(tick.seconds).toBeLessThanOrEqual(101);
  }, 60_000);

  test("only the lease's current sandbox reports for it", async () => {
    if (!available) return;
    const { power } = await sleepingFixture();
    expect(await power(true, "another-box")).toEqual({ accepted: true, changed: false });
  }, 60_000);

  test("only the agent's exact current claim reports: not an older epoch, not after revocation", async () => {
    if (!available) return;
    const { ids, agentId, claim, power } = await sleepingFixture();
    const asleepSince = async () => {
      const [row] = await admin<{ compute_asleep_since: Date | null }[]>`
        select compute_asleep_since from sandbox_leases
        where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
      return row?.compute_asleep_since ?? null;
    };
    // A later owner epoch opens the agent, then its sandbox reports awake.
    const newer = { ...claim, epoch: 2, connectionInstanceId: crypto.randomUUID() };
    expect(await openSandboxAgentLink(db, { ...newer, leaseMs: 20_000 })).toMatchObject({
      opened: true,
    });
    // The older session's delayed `asleep` lands after: refused, nothing changes.
    expect(await power(true)).toEqual({ accepted: false, changed: false });
    expect(await asleepSince()).toBeNull();
    expect(await power(true, "compute-box", newer)).toEqual({ accepted: true, changed: true });
    // A claim whose lease ran out no longer reports.
    await admin`update enrollments set connection_lease_expires_at = now() - interval '1 second'
      where id = ${agentId}`;
    expect(await power(false, "compute-box", newer)).toEqual({ accepted: false, changed: false });
    await admin`update enrollments set connection_lease_expires_at = now() + interval '20 seconds'
      where id = ${agentId}`;
    expect(
      await revokeSandboxEnrollment(db, { workspaceId: ids.workspaceId, enrollmentId: agentId }),
    ).toEqual({ revoked: true });
    expect(await power(false, "compute-box", newer)).toEqual({ accepted: false, changed: false });
    expect(await asleepSince()).not.toBeNull();
  }, 60_000);
});

describe("the compute orphan sweep's record check", () => {
  test("names the lease's box, and a group a creator is warming; nothing else", async () => {
    if (!available) return;
    const { ids } = await fixture("compute");
    const enroll = async () => {
      const enrollmentId = crypto.randomUUID();
      await createSandboxEnrollment(db, {
        ...ids,
        enrollmentId,
        hasDisplay: false,
        workspaceRoot: "/workspace",
      });
      return enrollmentId;
    };
    const live = await enroll();
    const stray = await enroll();
    const named = (enrollmentId: string, sandboxId: string, workspaceId = ids.workspaceId) =>
      computeSandboxNamed(db, {
        workspaceId,
        sandboxGroupId: ids.sandboxGroupId,
        enrollmentId,
        sandboxId,
      });
    // The warm lease's box is "compute-box".
    expect(await named(live, "compute-box")).toBe(true);
    // A box the lease does not hold, under an active enrollment of the group.
    expect(await named(stray, "lost-box")).toBe(false);
    // The lease names its box by enrollment too.
    await admin`update sandbox_leases
      set resume_state = jsonb_set(coalesce(resume_state, '{}'::jsonb), '{sessionState}',
        jsonb_build_object('enrollmentId', ${stray}::text))
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    expect(await named(stray, "lost-box")).toBe(true);
    // While a creator warms the group, its new box is not yet on the lease.
    await admin`update sandbox_leases set liveness = 'warming', resume_state = null
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    expect(await named(stray, "new-box")).toBe(true);
    // A revoked enrollment and a workspace that no longer has it name nothing.
    await revokeSandboxEnrollment(db, { workspaceId: ids.workspaceId, enrollmentId: stray });
    expect(await named(stray, "new-box")).toBe(false);
    expect(await named(live, "compute-box", crypto.randomUUID())).toBe(false);
  }, 60_000);
});
