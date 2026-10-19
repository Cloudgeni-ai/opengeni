import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  accrueWarmSeconds,
  acquireLease,
  bootstrapWorkspace,
  commitWarmingToWarm,
  computeSandboxNamed,
  computeSandboxOfEnrollment,
  createDb,
  createSandboxEnrollment,
  createSession,
  deleteSessionTreeIfQuiescent,
  forceDrainOverLimitViewerOnlyBoxes,
  MANAGED_BROWSER_SESSION_CAPABILITIES,
  openSandboxAgentLink,
  releaseLeaseHolder,
  reapStaleLeaseHolders,
  reapStaleLeaseHoldersGlobal,
  recordAbandonedDirectConnectedMachineCommand,
  recordComputeSandboxPower,
  revokeSandboxEnrollment,
  type Database,
  type DbClient,
} from "../src/index";

// 0853: Opengeni compute sleeps an idle sandbox itself and keeps its
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

  test("a command abandoned on the chat's own sandbox does not hold its deletion; a running one does", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    const enrollmentId = crypto.randomUUID();
    await createSandboxEnrollment(db, {
      ...ids,
      enrollmentId,
      hasDisplay: false,
      workspaceRoot: "/workspace",
    });
    // A direct terminal request lost its command to an agent restart and
    // handed it to the ledger with a stop request.
    const command = await recordAbandonedDirectConnectedMachineCommand(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      commandId: crypto.randomUUID(),
      controlWorkspaceId: ids.workspaceId,
      enrollmentId,
      connectionInstanceId: "launch",
      opId: "op-1",
      command: "sleep 600",
    });
    expect(command.state).toBe("stopping");
    await releaseLastHolder(ids);
    const remove = () =>
      deleteSessionTreeIfQuiescent(db, {
        workspaceId: ids.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
      });
    // A command the user still runs keeps the chat, as on any machine.
    await admin`update session_background_commands
      set state = 'running', cancel_requested_at = null, cancel_requested_by = null
      where id = ${command.id}`;
    expect((await remove()).status).toBe("active_background_commands");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
    // Once it is only waiting to be stopped, the group ends: deleting the
    // sandbox stops it, and the tree waits for that as for any live sandbox.
    await admin`update session_background_commands
      set state = 'stopping', cancel_requested_at = now(), cancel_requested_by = 'test'
      where id = ${command.id}`;
    expect((await remove()).status).toBe("live_sandboxes");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("draining");
    await admin`
      update sandbox_leases set liveness = 'cold', instance_id = null
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    expect((await remove()).status).toBe("deleted");
    const [left] = await admin<{ count: number }[]>`
      select count(*)::int as count from session_background_commands where id = ${command.id}`;
    expect(left?.count).toBe(0);
  }, 60_000);

  test("a command abandoned on another machine still holds the deletion until it settles", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    await recordAbandonedDirectConnectedMachineCommand(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      commandId: crypto.randomUUID(),
      controlWorkspaceId: ids.workspaceId,
      enrollmentId: crypto.randomUUID(),
      connectionInstanceId: "launch",
      opId: "op-1",
      command: "sleep 600",
    });
    await releaseLastHolder(ids);
    const result = await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(result.status).toBe("active_background_commands");
  }, 60_000);

  test("deleting the chat ends the browser and desktop an agent left open on its sandbox", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    await releaseLastHolder(ids);
    const opened = await openInteractions(ids);
    const first = await deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    expect(first.status).toBe("live_sandboxes");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("draining");
    expect(await groupEndRequestedAt(ids)).not.toBeNull();
    const [browser] = await admin<
      { lifecycle: string; failure_code: string; controller_id: string | null }[]
    >`
      select lifecycle, failure_code, controller_id from browser_sessions where id = ${opened.browserId}`;
    expect(browser).toEqual({
      lifecycle: "lost",
      failure_code: "sandbox_deleted",
      controller_id: null,
    });
    const [computer] = await admin<{ lifecycle: string; failure_code: string }[]>`
      select lifecycle, failure_code from computer_sessions where id = ${opened.computerId}`;
    expect(computer).toEqual({ lifecycle: "lost", failure_code: "sandbox_deleted" });
    const [holders] = await admin<{ n: number }[]>`
      select count(*)::int as n from sandbox_lease_holders where lease_id = ${opened.leaseId}`;
    expect(holders!.n).toBe(0);
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

  test("a browser mid-operation, or another holder, keeps the group until it settles", async () => {
    if (!available) return;
    for (const blocker of ["operation", "viewer"] as const) {
      const { grant, session, ids } = await fixture("compute");
      await releaseLastHolder(ids);
      const opened = await openInteractions(ids);
      if (blocker === "operation") {
        await admin`insert into interaction_operations (operation_id, account_id, workspace_id,
            resource_kind, resource_id, kind, request_digest, state, controller_generation,
            actor_subject_id, dispatched_at)
          values (${crypto.randomUUID()}, ${ids.accountId}, ${ids.workspaceId}, 'browser_session',
            ${opened.browserId}, 'suspend', ${"b".repeat(64)}, 'dispatched',
            ${opened.browserGeneration}, 'fixture-human', now())`;
      } else {
        await admin`insert into sandbox_lease_holders (account_id, workspace_id, lease_id, kind,
            holder_id, last_heartbeat_at)
          values (${ids.accountId}, ${ids.workspaceId}, ${opened.leaseId}, 'direct',
            ${`direct:${crypto.randomUUID()}`}, now())`;
        await admin`update sandbox_leases set refcount = 3 where id = ${opened.leaseId}`;
      }
      const result = await deleteSessionTreeIfQuiescent(db, {
        workspaceId: ids.workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
      });
      expect(result.status).toBe("live_sandboxes");
      expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
      expect(await groupEndRequestedAt(ids)).toBeNull();
      const [browser] = await admin<{ lifecycle: string }[]>`
        select lifecycle from browser_sessions where id = ${opened.browserId}`;
      expect(browser!.lifecycle).toBe("active");
    }
  }, 60_000);

  test("a browser that starts suspending while the deletion waits for it keeps the group", async () => {
    if (!available) return;
    const { grant, session, ids } = await fixture("compute");
    await releaseLastHolder(ids);
    const opened = await openInteractions(ids);
    // A suspend prepares as the browser code does: it locks the browser, records
    // its operation and moves it to suspending, and commits only once the
    // deletion is waiting for that browser.
    let commitPreparation!: () => void;
    const preparationMayCommit = new Promise<void>((resolve) => {
      commitPreparation = resolve;
    });
    let preparationLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      preparationLocked = resolve;
    });
    const preparation = admin.begin(async (tx) => {
      await tx`select id from browser_sessions where id = ${opened.browserId} for update`;
      await tx`insert into interaction_operations (operation_id, account_id, workspace_id,
          resource_kind, resource_id, kind, request_digest, state, controller_generation,
          actor_subject_id)
        values (${crypto.randomUUID()}, ${ids.accountId}, ${ids.workspaceId}, 'browser_session',
          ${opened.browserId}, 'suspend', ${"c".repeat(64)}, 'prepared',
          ${opened.browserGeneration}, 'fixture-human')`;
      await tx`update browser_sessions set lifecycle = 'suspending' where id = ${opened.browserId}`;
      preparationLocked();
      await preparationMayCommit;
    });
    await locked;
    const deletion = deleteSessionTreeIfQuiescent(db, {
      workspaceId: ids.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    });
    const waitingStartedAt = Date.now();
    for (;;) {
      const [waiting] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%browser_sessions%'`;
      if (waiting!.n > 0) break;
      if (Date.now() - waitingStartedAt > 10_000) throw new Error("the deletion never waited");
      await Bun.sleep(20);
    }
    commitPreparation();
    await preparation;
    const result = await deletion;
    expect(result.status).toBe("live_sandboxes");
    expect((await readRow(ids.workspaceId, ids.sandboxGroupId))?.liveness).toBe("warm");
    expect(await groupEndRequestedAt(ids)).toBeNull();
    const [browser] = await admin<{ lifecycle: string }[]>`
      select lifecycle from browser_sessions where id = ${opened.browserId}`;
    expect(browser!.lifecycle).toBe("suspending");
    const [computer] = await admin<{ lifecycle: string }[]>`
      select lifecycle from computer_sessions where id = ${opened.computerId}`;
    expect(computer!.lifecycle).toBe("active");
    const [holders] = await admin<{ n: number }[]>`
      select count(*)::int as n from sandbox_lease_holders where lease_id = ${opened.leaseId}`;
    expect(holders!.n).toBe(2);
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
    // The lease names its box by enrollment or sandbox id in its envelope too,
    // where the worker writes the provider state.
    await admin`update sandbox_leases
      set resume_state = jsonb_build_object('backendId', 'compute', 'sessionState',
        jsonb_build_object('providerState', jsonb_build_object(
          'enrollmentId', ${stray}::text, 'sandboxId', 'parked-box')))
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    expect(await named(stray, "lost-box")).toBe(true);
    expect(await named(live, "parked-box")).toBe(true);
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

describe("the sandbox an enrollment runs in", () => {
  test("is the box its group's lease names for it; nothing for anything else", async () => {
    if (!available) return;
    const { ids } = await fixture("compute");
    const enrollmentId = crypto.randomUUID();
    await createSandboxEnrollment(db, {
      ...ids,
      enrollmentId,
      hasDisplay: false,
      workspaceRoot: "/workspace",
    });
    const of = (id: string, workspaceId = ids.workspaceId) =>
      computeSandboxOfEnrollment(db, { workspaceId, enrollmentId: id });
    const envelope = (providerState: Record<string, string>) => admin`update sandbox_leases
      set resume_state = jsonb_build_object('backendId', 'compute', 'sessionState',
        jsonb_build_object('providerState', ${admin.json(providerState)}::jsonb))
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
    // The lease names the enrollment and its box.
    await envelope({ enrollmentId, sandboxId: "parked-box" });
    expect(await of(enrollmentId)).toBe("parked-box");
    // Without a box in the envelope, the lease's instance is the box.
    await envelope({ enrollmentId });
    expect(await of(enrollmentId)).toBe("compute-box");
    // The lease runs another enrollment: this one is in no sandbox.
    await envelope({ enrollmentId: crypto.randomUUID(), sandboxId: "other-box" });
    expect(await of(enrollmentId)).toBeNull();
    // Not an enrollment id, another workspace, a revoked enrollment: nothing.
    await envelope({ enrollmentId, sandboxId: "parked-box" });
    expect(await of("not-an-enrollment")).toBeNull();
    expect(await of(enrollmentId, crypto.randomUUID())).toBeNull();
    await revokeSandboxEnrollment(db, { workspaceId: ids.workspaceId, enrollmentId });
    expect(await of(enrollmentId)).toBeNull();
  }, 60_000);
});

/** The browser (shown in a desktop) an agent opened on the chat's sandbox and
 * left open after its turn ended: only their holders keep the lease. */
async function openInteractions(ids: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
}) {
  const [lease] = await admin<{ id: string; instance_id: string }[]>`
    select id, instance_id from sandbox_leases
    where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.sandboxGroupId}`;
  const computerId = crypto.randomUUID();
  const computerGeneration = crypto.randomUUID();
  const computerOperationId = crypto.randomUUID();
  await admin`insert into interaction_operations (operation_id, account_id, workspace_id,
      resource_kind, resource_id, kind, request_digest, state, controller_generation,
      actor_subject_id, dispatched_at, settled_at)
    values (${computerOperationId}, ${ids.accountId}, ${ids.workspaceId}, 'computer_session',
      ${computerId}, 'create', ${"a".repeat(64)}, 'completed', ${computerGeneration},
      'fixture-human', now(), now())`;
  await admin`insert into computer_sessions (id, account_id, workspace_id, name, lifecycle,
      placement_kind, sandbox_group_id, controller_id, controller_generation,
      placement_instance_id, platform, adapter, seat_id, display_id, capabilities,
      create_operation_id, created_by_subject_id, controller_heartbeat_at)
    values (${computerId}, ${ids.accountId}, ${ids.workspaceId}, 'Browser desktop', 'active',
      'sandbox_group', ${ids.sandboxGroupId}, 'computerd:fixture', ${computerGeneration},
      ${lease!.instance_id}, 'linux', 'native', 'seat-1', 'display-1', '{}'::jsonb,
      ${computerOperationId}, 'fixture-human', now())`;
  const browserId = crypto.randomUUID();
  const browserGeneration = crypto.randomUUID();
  const browserOperationId = crypto.randomUUID();
  await admin`insert into interaction_operations (operation_id, account_id, workspace_id,
      resource_kind, resource_id, kind, request_digest, state, controller_generation,
      actor_subject_id, dispatched_at, settled_at)
    values (${browserOperationId}, ${ids.accountId}, ${ids.workspaceId}, 'browser_session',
      ${browserId}, 'create', ${"a".repeat(64)}, 'completed', ${browserGeneration},
      'fixture-human', now(), now())`;
  await admin`insert into browser_sessions (id, account_id, workspace_id, name, lifecycle,
      placement_kind, sandbox_group_id, controller_host_sandbox_group_id, controller_id,
      controller_generation, placement_instance_id, driver_id, engine, headless, capabilities,
      create_operation_id, created_by_subject_id, controller_heartbeat_at,
      linked_computer_session_id)
    values (${browserId}, ${ids.accountId}, ${ids.workspaceId}, 'Browser', 'active',
      'sandbox_group', ${ids.sandboxGroupId}, ${ids.sandboxGroupId}, 'browserd:fixture',
      ${browserGeneration}, ${lease!.instance_id}, 'opengeni.cdp.v1', 'chromium', false,
      ${JSON.stringify(MANAGED_BROWSER_SESSION_CAPABILITIES)}::text::jsonb,
      ${browserOperationId}, 'fixture-human', now() - interval '1 hour', ${computerId})`;
  for (const holderId of [`browser-session:${browserId}`, `computer-session:${computerId}`]) {
    await admin`insert into sandbox_lease_holders (account_id, workspace_id, lease_id, kind,
        holder_id, last_heartbeat_at)
      values (${ids.accountId}, ${ids.workspaceId}, ${lease!.id}, 'interaction', ${holderId},
        now() - interval '1 hour')`;
  }
  await admin`update sandbox_leases set refcount = 2 where id = ${lease!.id}`;
  return { leaseId: lease!.id, browserId, browserGeneration, computerId };
}
