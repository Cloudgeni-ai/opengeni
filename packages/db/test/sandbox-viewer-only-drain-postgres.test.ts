import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import {
  acquireLease as acquireLeaseUnscoped,
  commitWarmingToWarm,
  createDb,
  createSession,
  drainViewerOnlyLease,
  heartbeatLeaseHolderStatus,
  listViewerOnlyWarmLeases,
  normalizeViewerInteractionAgeMs,
  resolveSandboxPlanTierInWorkspace,
  SANDBOX_EMBEDDED_PLAN_TIER,
  SandboxViewerBoxLimitError,
  withCreditDebitAttribution,
  type Database,
  type DbClient,
} from "../src/index";

// Bounds on warm boxes held only by viewers (docs/run-lifecycle.md, "Boxes
// held only by viewers"), driven through the real packages/db functions as the
// RLS-bound app role:
//
//   - the inventory reports a viewer-only box's last activity from viewer
//     attach, reported viewer interaction and session turns, and excludes
//     boxes with any other holder;
//   - an idle box is drained through the ordinary warm -> draining path; an
//     active person, a recent message or open session work keeps the box;
//   - an old client that never reports interaction falls back to attach time
//     and session activity;
//   - after an idle release, a re-attach without newer interaction or session
//     activity is refused;
//   - an organization that is not self-serve resolves to the unbounded
//     `embedded` tier, and joining a box a process or Browser/ComputerSession
//     already keeps warm is never refused as one more viewer-only box.

const acquireLease: typeof acquireLeaseUnscoped = (database, input) =>
  withCreditDebitAttribution({ kind: "service" }, () => acquireLeaseUnscoped(database, input));

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

type Ids = { accountId: string; workspaceId: string };

async function freshWorkspace(accountId?: string): Promise<Ids> {
  let account = accountId;
  if (!account) {
    const [a] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('acct') returning id`;
    account = a!.id;
  }
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${account})`;
  return { accountId: account, workspaceId: w!.id };
}

async function warmGroup(
  ids: Ids,
  holders: { kind: "turn" | "viewer" | "direct"; holderId: string }[],
): Promise<{ groupId: string; epoch: number }> {
  const groupId = crypto.randomUUID();
  for (const holder of holders) {
    await acquireLease(db, {
      ...ids,
      sandboxGroupId: groupId,
      kind: holder.kind,
      holderId: holder.holderId,
      backend: "modal",
      leaseTtlMs: 90_000,
    });
  }
  const committed = await commitWarmingToWarm(db, {
    ...ids,
    sandboxGroupId: groupId,
    expectedEpoch: 0,
    instanceId: "box",
    leaseTtlMs: 90_000,
  });
  return { groupId, epoch: committed.lease!.leaseEpoch };
}

async function backdateHolders(ids: Ids, groupId: string, minutesAgo: number): Promise<void> {
  await admin`
    update sandbox_lease_holders holder set
      created_at = now() - (${String(minutesAgo)} || ' minutes')::interval
    from sandbox_leases lease
    where holder.lease_id = lease.id
      and lease.workspace_id = ${ids.workspaceId}
      and lease.sandbox_group_id = ${groupId}`;
}

// A session on the box whose only turn finished `minutesAgo` minutes ago.
async function sessionOnBox(
  ids: Ids,
  groupId: string,
  options: { minutesAgo: number; status?: string },
): Promise<string> {
  const sessionId = crypto.randomUUID();
  await createSession(db, {
    requestedSessionId: sessionId,
    ...ids,
    initialMessage: "go",
    resources: [],
    metadata: {},
    model: "gpt",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
  });
  await admin`
    update sessions set sandbox_group_id = ${groupId}, status = ${options.status ?? "idle"}
    where workspace_id = ${ids.workspaceId} and id = ${sessionId}`;
  await admin`delete from session_turns where workspace_id = ${ids.workspaceId} and session_id = ${sessionId}`;
  await admin`
    insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
                               status, position, prompt, model, reasoning_effort, sandbox_backend,
                               created_at, finished_at)
    values (${crypto.randomUUID()}, ${ids.accountId}, ${ids.workspaceId}, ${sessionId}, ${crypto.randomUUID()}, 'wf',
            'completed', 1, 'go', 'gpt', 'medium', 'modal',
            now() - (${String(options.minutesAgo + 1)} || ' minutes')::interval,
            now() - (${String(options.minutesAgo)} || ' minutes')::interval)`;
  return sessionId;
}

async function readLease(ids: Ids, groupId: string) {
  const [lease] = await admin<
    {
      liveness: string;
      refcount: number;
      viewer_holders: number;
      holders: number;
    }[]
  >`
    select lease.liveness, lease.refcount, lease.viewer_holders,
      (select count(*)::int from sandbox_lease_holders holder where holder.lease_id = lease.id) as holders
    from sandbox_leases lease
    where lease.workspace_id = ${ids.workspaceId} and lease.sandbox_group_id = ${groupId}`;
  return lease!;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("viewer-only-drain-db");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Viewer-only drain verification requires PostgreSQL");
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[viewer-only-drain-db] docker unavailable, skipping");
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

describe("viewer-only warm box bounds (real packages/db + RLS)", () => {
  test("normalizes reported interaction ages leniently", () => {
    expect(normalizeViewerInteractionAgeMs(1234.9)).toBe(1234);
    expect(normalizeViewerInteractionAgeMs(0)).toBe(0);
    expect(normalizeViewerInteractionAgeMs(-1)).toBeNull();
    expect(normalizeViewerInteractionAgeMs(Number.NaN)).toBeNull();
    expect(normalizeViewerInteractionAgeMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeViewerInteractionAgeMs("5")).toBeNull();
    expect(normalizeViewerInteractionAgeMs(undefined)).toBeNull();
    expect(normalizeViewerInteractionAgeMs(10 ** 15)).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test("an old client's idle viewer-only box drains through the ordinary path and can re-warm", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const { groupId, epoch } = await warmGroup(ids, [{ kind: "viewer", holderId: "tab-a" }]);
    await sessionOnBox(ids, groupId, { minutesAgo: 120 });
    await backdateHolders(ids, groupId, 90);
    // The viewer keeps heartbeating without reporting interaction (an old
    // client, or an API key whose report the route drops): heartbeats keep
    // the hold alive but are not activity.
    const beat = await heartbeatLeaseHolderStatus(db, {
      ...ids,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "tab-a",
      leaseTtlMs: 90_000,
      expectedEpoch: epoch,
    });
    expect(beat.holderAlive).toBe(true);

    const [lease] = await listViewerOnlyWarmLeases(db, ids);
    expect(lease).toMatchObject({
      sandboxGroupId: groupId,
      leaseEpoch: epoch,
      viewerHolders: 1,
      interactionReported: false,
      openSessionWork: false,
      transitioning: false,
    });
    // Old client: no interaction reported, so the attach time is the activity.
    expect(lease!.lastActiveAt.getTime()).toBeLessThan(minutesAgo(89).getTime());
    expect(lease!.lastActiveAt.getTime()).toBeGreaterThan(minutesAgo(91).getTime());

    const outcome = await drainViewerOnlyLease(db, {
      ...ids,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      reason: "viewer_idle",
      quietForMs: 30 * 60_000,
      idleGraceMs: 60_000,
    });
    expect(outcome).toEqual({ drained: true, releasedViewers: 1 });
    expect(await readLease(ids, groupId)).toMatchObject({
      liveness: "draining",
      refcount: 0,
      viewer_holders: 0,
      holders: 0,
    });
    expect(await listViewerOnlyWarmLeases(db, ids)).toEqual([]);

    // The unattended page (or an old client) re-attaches on its own, without
    // reporting interaction since the release: refused, so it cannot reset
    // the idle clock. A stale report is refused the same way.
    const reattach = (holderId: string, viewerInteractionAgeMs?: number) =>
      acquireLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        kind: "viewer",
        holderId,
        backend: "modal",
        leaseTtlMs: 90_000,
        enforceViewerIdleReattach: true,
        ...(viewerInteractionAgeMs === undefined ? {} : { viewerInteractionAgeMs }),
      });
    await expect(reattach("tab-a")).rejects.toMatchObject({ reason: "viewer_idle" });
    await expect(reattach("tab-a", 60 * 60_000)).rejects.toMatchObject({
      reason: "viewer_idle",
    });
    expect((await readLease(ids, groupId)).holders).toBe(0);

    // The reaper saves the workspace and stops the box (simulated: cold).
    // The person comes back and interacts: the viewer attaches again and the
    // box cold starts.
    await admin`
        update sandbox_leases set liveness = 'cold', instance_id = null, expires_at = now()
        where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${groupId}`;
    const back = await acquireLease(db, {
      ...ids,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "tab-a",
      backend: "modal",
      leaseTtlMs: 90_000,
      enforceViewerIdleReattach: true,
      // The person just interacted (after the release).
      viewerInteractionAgeMs: 0,
    });
    expect(back.role).toBe("spawner");
    const [marker] = await admin<{ drained_at: Date | null; interaction_at: Date | null }[]>`
      select lease.viewer_idle_drained_at as drained_at, holder.last_interaction_at as interaction_at
      from sandbox_leases lease join sandbox_lease_holders holder on holder.lease_id = lease.id
      where lease.workspace_id = ${ids.workspaceId} and lease.sandbox_group_id = ${groupId}`;
    expect(marker!.drained_at).toBeNull();
    expect(marker!.interaction_at).not.toBeNull();
    expect(await readLease(ids, groupId)).toMatchObject({
      liveness: "warming",
      holders: 1,
    });
  }, 180_000);

  test("an active person with an open tab keeps the box; stale reports never move activity back", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const { groupId, epoch } = await warmGroup(ids, [{ kind: "viewer", holderId: "tab-a" }]);
    await sessionOnBox(ids, groupId, { minutesAgo: 120 });
    await backdateHolders(ids, groupId, 90);

    const beat = await heartbeatLeaseHolderStatus(db, {
      ...ids,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "tab-a",
      leaseTtlMs: 90_000,
      expectedEpoch: epoch,
      interactionAgeMs: 5_000,
    });
    expect(beat.holderAlive).toBe(true);
    // A later heartbeat reporting an older interaction does not rewind it.
    await heartbeatLeaseHolderStatus(db, {
      ...ids,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "tab-a",
      leaseTtlMs: 90_000,
      expectedEpoch: epoch,
      interactionAgeMs: 3 * 60 * 60_000,
    });

    const [lease] = await listViewerOnlyWarmLeases(db, ids);
    expect(lease!.interactionReported).toBe(true);
    expect(lease!.lastActiveAt.getTime()).toBeGreaterThan(minutesAgo(1).getTime());

    // A decision taken on an older read cannot drain the active person's box.
    const outcome = await drainViewerOnlyLease(db, {
      ...ids,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      reason: "viewer_idle",
      quietForMs: 30 * 60_000,
      idleGraceMs: 60_000,
    });
    expect(outcome).toEqual({
      drained: false,
      reason: "active_since_decision",
    });
    expect(await readLease(ids, groupId)).toMatchObject({
      liveness: "warm",
      holders: 1,
    });
  }, 180_000);

  test("a recent turn, open session work or a non-viewer holder keeps the box", async () => {
    if (!available) return;
    const ids = await freshWorkspace();

    // Recent message: the holder attached long ago and never reported, but a
    // turn finished a few minutes ago (old-client fallback to session activity).
    const recent = await warmGroup(ids, [{ kind: "viewer", holderId: "tab-recent" }]);
    await sessionOnBox(ids, recent.groupId, { minutesAgo: 3 });
    await backdateHolders(ids, recent.groupId, 90);

    // Open session work.
    const open = await warmGroup(ids, [{ kind: "viewer", holderId: "tab-open" }]);
    await sessionOnBox(ids, open.groupId, {
      minutesAgo: 120,
      status: "running",
    });
    await backdateHolders(ids, open.groupId, 90);

    // A direct op next to the viewer: not viewer-only.
    const direct = await warmGroup(ids, [
      { kind: "viewer", holderId: "tab-direct" },
      { kind: "direct", holderId: "op-1" },
    ]);
    await backdateHolders(ids, direct.groupId, 90);

    // A turn holder: not viewer-only.
    const turn = await warmGroup(ids, [
      { kind: "viewer", holderId: "tab-turn" },
      { kind: "turn", holderId: "turn-1" },
    ]);
    await backdateHolders(ids, turn.groupId, 90);

    const leases = await listViewerOnlyWarmLeases(db, ids);
    const byGroup = new Map(leases.map((lease) => [lease.sandboxGroupId, lease]));
    expect(byGroup.has(direct.groupId)).toBe(false);
    expect(byGroup.has(turn.groupId)).toBe(false);
    expect(byGroup.get(recent.groupId)!.lastActiveAt.getTime()).toBeGreaterThan(
      minutesAgo(4).getTime(),
    );
    expect(byGroup.get(open.groupId)!.openSessionWork).toBe(true);

    const drain = (groupId: string, expectedEpoch: number) =>
      drainViewerOnlyLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        expectedEpoch,
        reason: "viewer_idle",
        quietForMs: 30 * 60_000,
        idleGraceMs: 60_000,
      });
    expect(await drain(recent.groupId, recent.epoch)).toEqual({
      drained: false,
      reason: "active_since_decision",
    });
    expect(await drain(open.groupId, open.epoch)).toEqual({
      drained: false,
      reason: "open_session_work",
    });
    expect(await drain(direct.groupId, direct.epoch)).toEqual({
      drained: false,
      reason: "not_viewer_only",
    });
    expect(await drain(turn.groupId, turn.epoch)).toEqual({
      drained: false,
      reason: "not_viewer_only",
    });
    expect(await drain(recent.groupId, recent.epoch + 1)).toEqual({
      drained: false,
      reason: "epoch_changed",
    });
    for (const group of [recent, open, direct, turn]) {
      expect((await readLease(ids, group.groupId)).liveness).toBe("warm");
    }
  }, 180_000);

  test("after an idle release, a turn in the session lets a page re-attach without reporting interaction", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const { groupId, epoch } = await warmGroup(ids, [{ kind: "viewer", holderId: "tab-a" }]);
    const sessionId = await sessionOnBox(ids, groupId, { minutesAgo: 120 });
    await backdateHolders(ids, groupId, 90);
    expect(
      await drainViewerOnlyLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        reason: "viewer_idle",
        quietForMs: 30 * 60_000,
        idleGraceMs: 60_000,
      }),
    ).toEqual({ drained: true, releasedViewers: 1 });
    const reattach = () =>
      acquireLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        kind: "viewer",
        holderId: "tab-a",
        backend: "modal",
        leaseTtlMs: 90_000,
        enforceViewerIdleReattach: true,
      });
    await expect(reattach()).rejects.toMatchObject({ reason: "viewer_idle" });
    // The reaper saves and stops the box (simulated: cold); then a turn runs.
    await admin`
      update sandbox_leases set liveness = 'cold', instance_id = null, expires_at = now()
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${groupId}`;
    await expect(reattach()).rejects.toMatchObject({ reason: "viewer_idle" });
    await admin`
      insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
                                 status, position, prompt, model, reasoning_effort, sandbox_backend, created_at)
      values (${crypto.randomUUID()}, ${ids.accountId}, ${ids.workspaceId}, ${sessionId}, ${crypto.randomUUID()}, 'wf',
              'completed', 2, 'again', 'gpt', 'medium', 'modal', now())`;
    const back = await reattach();
    expect(back.role).toBe("spawner");
    expect((await readLease(ids, groupId)).holders).toBe(1);
  }, 180_000);
  test("a free self-serve organization is capped; one with an external-source workspace is not", async () => {
    if (!available) return;
    const limits = DEFAULT_SANDBOX_PLAN_LIMITS;
    const viewer = (ids: Ids, holderId: string) =>
      acquireLease(db, {
        ...ids,
        sandboxGroupId: crypto.randomUUID(),
        kind: "viewer",
        holderId,
        viewerSubjectId: `user:${holderId}`,
        backend: "modal",
        leaseTtlMs: 90_000,
        viewerOnlyBoxLimit: 1,
        sandboxPlanLimits: limits,
      });
    const tierOf = (ids: Ids) => resolveSandboxPlanTierInWorkspace(db, ids);

    // Plain free self-serve organization: the workspace limit (1) applies.
    const selfServe = await freshWorkspace();
    await admin`insert into organization_plans (account_id, plan_key, status)
      values (${selfServe.accountId}, 'free', 'active')`;
    expect(await tierOf(selfServe)).toBe("free");
    expect((await viewer(selfServe, "a")).role).toBe("spawner");
    await expect(viewer(selfServe, "b")).rejects.toBeInstanceOf(SandboxViewerBoxLimitError);

    // Free organization that owns a workspace with an external source (an
    // embedding host): `embedded`, outside the workspace and plan limits.
    const embedded = await freshWorkspace();
    await admin`insert into organization_plans (account_id, plan_key, status)
      values (${embedded.accountId}, 'free', 'active')`;
    await admin`insert into workspaces (account_id, name, external_source)
      values (${embedded.accountId}, 'host', 'federation:test-host')`;
    expect(await tierOf(embedded)).toBe(SANDBOX_EMBEDDED_PLAN_TIER);
    for (const holderId of ["a", "b", "c", "d"]) {
      expect((await viewer(embedded, holderId)).role).toBe("spawner");
    }

    // An organization with an external source is embedded too.
    const external = await freshWorkspace();
    await admin`update managed_accounts set external_source = 'opengeni-sdk:test'
      where id = ${external.accountId}`;
    expect(await tierOf(external)).toBe(SANDBOX_EMBEDDED_PLAN_TIER);
  }, 180_000);

  test("joining a box a process or Browser/ComputerSession keeps warm is not one more viewer-only box", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    // One viewer-only box fills the workspace limit.
    await warmGroup(ids, [{ kind: "viewer", holderId: "tab-a" }]);
    for (const kind of ["process", "interaction"] as const) {
      const groupId = crypto.randomUUID();
      // Process holders come only from retained-process promotion; stand one
      // in by retyping a direct holder.
      await acquireLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        kind: kind === "process" ? "direct" : kind,
        holderId: `${kind}-1`,
        backend: "modal",
        leaseTtlMs: 90_000,
      });
      if (kind === "process") {
        await admin`
          update sandbox_lease_holders holder set kind = 'process'
          from sandbox_leases lease
          where holder.lease_id = lease.id and lease.workspace_id = ${ids.workspaceId}
            and lease.sandbox_group_id = ${groupId}`;
      }
      const joined = await acquireLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        kind: "viewer",
        holderId: `tab-${kind}`,
        backend: "modal",
        leaseTtlMs: 90_000,
        viewerOnlyBoxLimit: 1,
      });
      expect(joined.role).toBe("attached");
    }
    // A box nothing else holds is still refused.
    await expect(
      acquireLease(db, {
        ...ids,
        sandboxGroupId: crypto.randomUUID(),
        kind: "viewer",
        holderId: "tab-new",
        backend: "modal",
        leaseTtlMs: 90_000,
        viewerOnlyBoxLimit: 1,
      }),
    ).rejects.toBeInstanceOf(SandboxViewerBoxLimitError);
  }, 180_000);
});
