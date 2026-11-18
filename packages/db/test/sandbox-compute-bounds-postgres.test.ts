import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { DEFAULT_SANDBOX_PLAN_LIMITS, parseSandboxPlanLimitsJson } from "@opengeni/config";
import {
  acquireLease as acquireLeaseUnscoped,
  commitWarmingToWarm,
  createAdditionalManagedOrganization,
  createDb,
  drainNoTurnLeaseForComputeBounds,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listNoTurnWarmLeases,
  resetOrganizationSuspensionCache,
  resetSandboxPersonStandingCache,
  resolveOrganizationSuspension,
  SandboxOrganizationBoxLimitError,
  withCreditDebitAttribution,
  type AcquireLeaseInput,
  type Database,
  type DbClient,
} from "../src/index";

// The free-compute bounds (docs/deployment.md, "Free compute bounds") through
// the real admission path: a held or denied organization that has not paid
// gets no sandbox of any kind, Free organizations share a running-box budget
// and a daily box-time budget per organization and per person, a person's
// restriction follows them into the organizations they run, and paid,
// Enterprise and host-provisioned organizations are untouched.

const acquireLease: typeof acquireLeaseUnscoped = (db, input) =>
  withCreditDebitAttribution({ kind: "service" }, () => acquireLeaseUnscoped(db, input));

const limits = DEFAULT_SANDBOX_PLAN_LIMITS;
/** The default limits of a deployment without subscription plans. */
const limitsWithoutPlans = parseSandboxPlanLimitsJson("", { subscriptionPlansEnabled: false });

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-compute-bounds");
  if (!shared) throw new Error("Real PostgreSQL required for the free-compute bounds");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  await admin.unsafe(
    "grant execute on function opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid) to opengeni_app",
  );
  await setPromotionEnforcement(true);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function setPromotionEnforcement(enabled: boolean): Promise<void> {
  await admin`insert into promotion_enforcement (singleton, enabled) values (true, ${enabled})
    on conflict (singleton) do update set enabled = excluded.enabled`;
}

function forgetCaches(): void {
  resetSandboxPersonStandingCache();
  resetOrganizationSuspensionCache();
}

type Org = { accountId: string; workspaceId: string };

async function organization(
  options: {
    plan?: string | undefined;
    status?: string;
    decision?: "held" | "denied";
    source?: string;
  } = {},
): Promise<Org> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name, external_source)
    values ('acct', ${options.source ?? null}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const org = { accountId: account!.id, workspaceId: workspace!.id };
  if (options.plan) await plan(org.accountId, options.plan, options.status ?? "active");
  if (options.decision) await decide(org.accountId, options.decision);
  return org;
}

async function plan(accountId: string, planKey: string, status = "active"): Promise<void> {
  await admin`insert into organization_plans (account_id, plan_key, status)
    values (${accountId}, ${planKey}, ${status})
    on conflict (account_id) do update set plan_key = excluded.plan_key, status = excluded.status`;
}

async function decide(accountId: string, decision: "held" | "denied" | "eligible"): Promise<void> {
  await admin`insert into promotion_decisions (account_id, decision, revision, actor)
    values (${accountId}, ${decision}, 1, 'test')
    on conflict (account_id) do update set decision = excluded.decision`;
  forgetCaches();
}

async function boxSecondsToday(org: Org, seconds: number, daysAgo = 0): Promise<void> {
  await admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
      idempotency_key, occurred_at)
    values (${org.accountId}, ${org.workspaceId}, 'sandbox.warm_seconds', ${seconds}, 'seconds',
      ${crypto.randomUUID()}, now() - (${String(daysAgo)} || ' days')::interval)`;
  forgetCaches();
}

function acquire(
  org: Org,
  kind: AcquireLeaseInput["kind"],
  options: {
    group?: string;
    holderId?: string;
    subjectId?: string;
    backend?: string;
    /** false: a deployment without subscription plans. */
    subscriptionPlansEnabled?: boolean;
  } = {},
) {
  const withoutPlans = options.subscriptionPlansEnabled === false;
  return acquireLease(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: options.group ?? crypto.randomUUID(),
    kind,
    holderId: options.holderId ?? `${kind}-${crypto.randomUUID()}`,
    backend: options.backend ?? "modal",
    leaseTtlMs: 90_000,
    sandboxPlanLimits: withoutPlans ? limitsWithoutPlans : limits,
    ...(options.subscriptionPlansEnabled !== undefined
      ? { subscriptionPlansEnabled: options.subscriptionPlansEnabled }
      : {}),
    ...(options.subjectId
      ? {
          actingSubjectId: options.subjectId,
          ...(kind === "viewer" ? { viewerSubjectId: options.subjectId } : {}),
        }
      : {}),
  });
}

async function refusal(attempt: Promise<unknown>): Promise<SandboxOrganizationBoxLimitError> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof SandboxOrganizationBoxLimitError) return error;
    throw error;
  }
  throw new Error("expected a compute-bounds refusal");
}

async function warm(org: Org, group: string): Promise<number> {
  const committed = await commitWarmingToWarm(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: group,
    expectedEpoch: 0,
    instanceId: `box-${group}`,
    leaseTtlMs: 90_000,
  });
  return committed.lease!.leaseEpoch;
}

/** The turn that held a warm box finishes; other holders keep it warm. */
async function endTurn(org: Org, group: string, holderId: string): Promise<void> {
  await admin`delete from sandbox_lease_holders holder using sandbox_leases lease
    where holder.lease_id = lease.id and lease.workspace_id = ${org.workspaceId}
      and lease.sandbox_group_id = ${group} and holder.kind = 'turn'
      and holder.holder_id = ${holderId}`;
  await admin`update sandbox_leases lease set
      turn_holders = (select count(*) from sandbox_lease_holders holder
        where holder.lease_id = lease.id and holder.kind = 'turn'),
      refcount = (select count(*) from sandbox_lease_holders holder
        where holder.lease_id = lease.id)
    where lease.workspace_id = ${org.workspaceId} and lease.sandbox_group_id = ${group}`;
}

describe("free compute bounds (real PostgreSQL)", () => {
  test("a held or denied organization that has not paid gets no sandbox of any kind", async () => {
    for (const decision of ["held", "denied"] as const) {
      for (const planKey of ["free", undefined]) {
        const org = await organization({ plan: planKey, decision });
        for (const kind of ["viewer", "direct", "interaction", "turn"] as const) {
          const refused = await refusal(acquire(org, kind));
          expect(refused.reason).toBe("closed");
          expect(refused.code).toBe("sandbox_compute_unavailable");
          expect(refused.message).toContain("Add credit");
        }
        // A Connected Machine is the person's own computer and never counts.
        expect((await acquire(org, "turn", { backend: "selfhosted" })).role).toBe("spawner");
      }
    }
  }, 120_000);

  test("a box already running when the organization is held stays only while its turn runs", async () => {
    const org = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    expect((await acquire(org, "turn", { group, holderId: "t1" })).role).toBe("spawner");
    await warm(org, group);
    expect((await acquire(org, "viewer", { group, holderId: "v1" })).role).toBe("attached");
    await decide(org.accountId, "held");
    // The turn that holds the box finishes.
    expect((await acquire(org, "turn", { group, holderId: "t1" })).role).not.toBe("fenced");
    // While that turn runs, the agent's own requests, interaction holders and
    // the person watching it still join the box it already pays for.
    expect((await acquire(org, "viewer", { group, holderId: "v1" })).role).toBe("attached");
    expect((await acquire(org, "direct", { group })).role).toBe("attached");
    expect((await acquire(org, "interaction", { group })).role).toBe("attached");
    // A new box is refused even then.
    expect((await refusal(acquire(org, "direct"))).reason).toBe("closed");
    // Once the turn ends, nothing joins or keeps the box warm: not a new
    // viewer, not a replayed viewer, not a request, not another turn.
    await endTurn(org, group, "t1");
    expect((await refusal(acquire(org, "viewer", { group, holderId: "v2" }))).reason).toBe(
      "closed",
    );
    expect((await refusal(acquire(org, "viewer", { group, holderId: "v1" }))).reason).toBe(
      "closed",
    );
    expect((await refusal(acquire(org, "direct", { group }))).reason).toBe("closed");
    expect((await refusal(acquire(org, "turn", { group, holderId: "t2" }))).reason).toBe("closed");
  }, 60_000);

  test("buying credit or a paid subscription lifts the restriction", async () => {
    const toppedUp = await organization({ plan: "free", decision: "denied" });
    await admin`insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values (${toppedUp.accountId}::uuid, 'credit_topup', 5000000, ${crypto.randomUUID()})`;
    forgetCaches();
    expect((await acquire(toppedUp, "direct")).role).toBe("spawner");
    expect(await resolveOrganizationSuspension(db, { accountId: toppedUp.accountId })).toBe(false);

    const subscribed = await organization({ plan: "free", decision: "held" });
    await admin`update organization_plans set stripe_subscription_id = 'sub_test'
      where account_id = ${subscribed.accountId}`;
    expect((await acquire(subscribed, "direct")).role).toBe("spawner");

    // A granted credit is not a purchase.
    const granted = await organization({ plan: "free", decision: "held" });
    await admin`insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values (${granted.accountId}::uuid, 'plan_credit_grant', 5000000, ${crypto.randomUUID()})`;
    expect((await refusal(acquire(granted, "direct"))).reason).toBe("closed");
  }, 60_000);

  test("a Free organization that bought credit is a paying customer for every bound", async () => {
    const org = await organization({ plan: "free" });
    await admin`insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values (${org.accountId}::uuid, 'credit_topup', 5000000, ${crypto.randomUUID()})`;
    forgetCaches();
    await boxSecondsToday(org, 1_000_000);
    const started = await acquire(org, "direct");
    expect(started).toMatchObject({ role: "spawner", sandboxPaidHistory: true });
    // Past the Free daily budget, it still starts boxes.
    expect((await acquire(org, "interaction")).role).toBe("spawner");
  }, 60_000);

  test("paid, Enterprise and host-provisioned organizations are not limited by the new bounds", async () => {
    const orgs = [
      await organization({ plan: "pro", decision: "denied" }),
      await organization({ plan: "max", decision: "held" }),
      await organization({ plan: "enterprise", decision: "denied" }),
      await organization({ source: "host:embedded-product", decision: "denied" }),
    ];
    for (const org of orgs) {
      await boxSecondsToday(org, 1_000_000);
      // More boxes than any Free bound, of every kind, all start.
      for (const kind of ["direct", "interaction", "viewer", "turn", "direct"] as const) {
        expect((await acquire(org, kind, { subjectId: `user:${crypto.randomUUID()}` })).role).toBe(
          "spawner",
        );
      }
      expect(await resolveOrganizationSuspension(db, { accountId: org.accountId })).toBe(false);
    }
  }, 120_000);

  test("Free shares two running boxes across every holder kind", async () => {
    const org = await organization({ plan: "free" });
    expect((await acquire(org, "direct")).role).toBe("spawner");
    expect((await acquire(org, "interaction")).role).toBe("spawner");
    const refused = await refusal(acquire(org, "direct"));
    expect([refused.reason, refused.limit]).toEqual(["running", 2]);
    // A turn waits for a slot instead of failing.
    expect(await acquire(org, "turn")).toMatchObject({
      role: "fenced",
      reason: "organization_sandbox_capacity",
    });
  }, 60_000);

  describe("a plan-less organization", () => {
    // With subscription plans on, a new self-serve organization has no plan
    // row until subscription maintenance enrolls it in Free, so it is bounded
    // like Free; without them no organization ever gets a plan row, and a
    // plan-less organization is not bounded at all.
    const selfServe = () => organization({ source: "better-auth:user" });

    test("is bounded like Free while it waits for Free enrollment", async () => {
      for (const plansOn of [{}, { subscriptionPlansEnabled: true }]) {
        const org = await selfServe();
        expect(await acquire(org, "direct", plansOn)).toMatchObject({
          role: "spawner",
          sandboxPlanTier: "none",
        });
        expect((await acquire(org, "interaction", plansOn)).role).toBe("spawner");
        const refused = await refusal(acquire(org, "direct", plansOn));
        expect([refused.reason, refused.limit]).toEqual(["running", 2]);
        expect(await acquire(org, "turn", plansOn)).toMatchObject({
          role: "fenced",
          reason: "organization_sandbox_capacity",
          organizationBoxLimit: 2,
        });
        const spent = await selfServe();
        await boxSecondsToday(spent, 43_200);
        expect((await refusal(acquire(spent, "direct", plansOn))).reason).toBe("daily_budget");
      }
    }, 120_000);

    test("is not bounded on a deployment without subscription plans", async () => {
      const plansOff = { subscriptionPlansEnabled: false };
      const org = await selfServe();
      await boxSecondsToday(org, 1_000_000);
      // More boxes than any Free bound, of every kind, all start, past a
      // Free daily budget, for a person too.
      for (const kind of ["direct", "interaction", "viewer", "turn", "turn", "direct"] as const) {
        expect(
          await acquire(org, kind, { ...plansOff, subjectId: `user:${crypto.randomUUID()}` }),
        ).toMatchObject({ role: "spawner", sandboxPlanTier: "none" });
      }
    }, 120_000);

    test("is still restricted by a held or denied decision without subscription plans", async () => {
      const plansOff = { subscriptionPlansEnabled: false };
      for (const decision of ["held", "denied"] as const) {
        const org = await organization({ source: "better-auth:user", decision });
        for (const kind of ["viewer", "direct", "interaction", "turn"] as const) {
          expect((await refusal(acquire(org, kind, plansOff))).reason).toBe("closed");
        }
      }
    }, 60_000);
  });

  test("a spent day refuses new boxes and joins, lets an in-flight turn finish, and resets the next UTC day", async () => {
    const org = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    expect((await acquire(org, "turn", { group, holderId: "t1" })).role).toBe("spawner");
    await warm(org, group);
    // Yesterday's box time does not count.
    await boxSecondsToday(org, 50_000, 1);
    expect((await acquire(org, "direct", { group })).role).toBe("attached");
    await boxSecondsToday(org, 43_200);
    const spent = await refusal(acquire(org, "direct"));
    expect([spent.reason, spent.limit]).toEqual(["daily_budget", 43_200]);
    expect(spent.message).toContain("12 sandbox hours");
    expect((await refusal(acquire(org, "turn"))).reason).toBe("daily_budget");
    // The in-flight turn finishes, and the person can still watch it.
    expect((await acquire(org, "turn", { group, holderId: "t1" })).role).not.toBe("fenced");
    expect((await acquire(org, "viewer", { group })).role).toBe("attached");
    // Once the turn ends, the box takes no new holder.
    await endTurn(org, group, "t1");
    expect((await refusal(acquire(org, "viewer", { group }))).reason).toBe("daily_budget");
  }, 60_000);

  describe("across a person's organizations", () => {
    async function personWithTwoOrganizations(planKey: string | null = "free") {
      const userId = `compute-bounds-${crypto.randomUUID()}`;
      const subjectId = `user:${userId}`;
      const access = await ensureManagedAccessForUserWithOrganizationMemberships(db, {
        userId,
        email: `${userId}@example.test`,
        name: "Bounds person",
      });
      await admin`insert into auth_users (id, name, email, email_verified)
        values (${userId}, 'Bounds person', ${`${userId}@example.test`}, true)
        on conflict (id) do update set email_verified = true`;
      const first = access.organizationMemberships[0]!;
      const second = await createAdditionalManagedOrganization(db, {
        subjectId,
        subjectLabel: "Bounds person",
        name: `Second ${crypto.randomUUID().slice(0, 8)}`,
        workspaceName: "Team",
        operationId: crypto.randomUUID(),
      });
      const one = { accountId: first.organizationId, workspaceId: first.personalWorkspaceId! };
      const two = { accountId: second.organization.id, workspaceId: second.workspaceId };
      for (const org of [one, two]) {
        await admin`insert into workspace_inference_controls (workspace_id, account_id)
          values (${org.workspaceId}, ${org.accountId}) on conflict do nothing`;
        if (planKey !== null) await plan(org.accountId, planKey);
      }
      forgetCaches();
      return { subjectId, one, two };
    }

    test("a person runs at most two boxes across their Free organizations", async () => {
      const { subjectId, one, two } = await personWithTwoOrganizations();
      expect((await acquire(one, "direct", { subjectId })).role).toBe("spawner");
      expect((await acquire(two, "direct", { subjectId })).role).toBe("spawner");
      forgetCaches();
      // Each organization has room for one more, but the person does not.
      const refused = await refusal(acquire(two, "interaction", { subjectId }));
      expect([refused.reason, refused.limit]).toEqual(["person_running", 2]);
      // Work that no person acts for (a scheduled task's service subject)
      // counts against the organization only.
      expect((await acquire(two, "direct")).role).toBe("spawner");
    }, 120_000);

    test("a person's box time counts across their Free organizations", async () => {
      const { subjectId, one, two } = await personWithTwoOrganizations();
      await boxSecondsToday(one, 30_000);
      await boxSecondsToday(two, 13_200);
      expect((await refusal(acquire(two, "direct", { subjectId }))).reason).toBe("daily_budget");
      expect((await acquire(two, "direct")).role).toBe("spawner");
    }, 120_000);

    test("a held organization restricts and a denied one suspends every organization its person runs", async () => {
      const { subjectId, one, two } = await personWithTwoOrganizations();
      expect((await acquire(two, "direct", { subjectId })).role).toBe("spawner");
      await decide(one.accountId, "held");
      expect((await refusal(acquire(two, "direct", { subjectId }))).reason).toBe("closed");
      expect(await resolveOrganizationSuspension(db, { accountId: two.accountId, subjectId })).toBe(
        false,
      );
      await decide(one.accountId, "denied");
      expect(await resolveOrganizationSuspension(db, { accountId: one.accountId })).toBe(true);
      expect(await resolveOrganizationSuspension(db, { accountId: two.accountId, subjectId })).toBe(
        true,
      );
      // Reversing the decision clears both.
      await decide(one.accountId, "eligible");
      expect(await resolveOrganizationSuspension(db, { accountId: one.accountId })).toBe(false);
      expect(await resolveOrganizationSuspension(db, { accountId: two.accountId, subjectId })).toBe(
        false,
      );
      expect((await acquire(two, "direct", { subjectId })).role).toBe("spawner");
    }, 120_000);

    test("without subscription plans, a held plan-less organization still restricts every organization its person runs", async () => {
      const plansOff = { subscriptionPlansEnabled: false };
      const { subjectId, one, two } = await personWithTwoOrganizations(null);
      expect((await acquire(two, "direct", { ...plansOff, subjectId })).role).toBe("spawner");
      await decide(one.accountId, "held");
      expect((await refusal(acquire(two, "direct", { ...plansOff, subjectId }))).reason).toBe(
        "closed",
      );
      await decide(one.accountId, "eligible");
      expect((await acquire(two, "direct", { ...plansOff, subjectId })).role).toBe("spawner");
    }, 120_000);
  });

  test("a system-held box (a rig verification turn) gets no box for a held organization; only the named test opt-out skips the bounds", async () => {
    const held = await organization({ plan: "free", decision: "held" });
    const verification = await refusal(
      acquire(held, "turn", { holderId: `rig-verification:${crypto.randomUUID()}` }),
    );
    expect([verification.reason, verification.limit]).toEqual(["closed", 0]);
    const unbounded = await acquireLease(db, {
      accountId: held.accountId,
      workspaceId: held.workspaceId,
      sandboxGroupId: crypto.randomUUID(),
      kind: "turn",
      holderId: `rig-verification:${crypto.randomUUID()}`,
      backend: "modal",
      leaseTtlMs: 90_000,
      sandboxPlanLimits: "unbounded_test_fixture",
    });
    expect(unbounded.role).toBe("spawner");
  }, 60_000);

  test("the reaper drains a box no turn holds and never one a turn holds", async () => {
    const org = await organization({ plan: "free" });
    const viewerOnly = crypto.randomUUID();
    const turnHeld = crypto.randomUUID();
    expect((await acquire(org, "viewer", { group: viewerOnly })).role).toBe("spawner");
    const viewerEpoch = await warm(org, viewerOnly);
    expect((await acquire(org, "turn", { group: turnHeld })).role).toBe("spawner");
    await warm(org, turnHeld);
    const listed = await listNoTurnWarmLeases(db, org);
    expect(listed.map((lease) => lease.sandboxGroupId)).toEqual([viewerOnly]);
    const drained = await drainNoTurnLeaseForComputeBounds(db, {
      ...org,
      sandboxGroupId: viewerOnly,
      expectedEpoch: viewerEpoch,
      reason: "compute_closed",
      quietForMs: 0,
      idleGraceMs: 60_000,
    });
    expect(drained).toMatchObject({ drained: true, mode: "drained", releasedHolders: 1 });
    const [row] = await admin<{ liveness: string }[]>`select liveness from sandbox_leases
      where workspace_id = ${org.workspaceId} and sandbox_group_id = ${viewerOnly}`;
    expect(row!.liveness).toBe("draining");
    // A stale decision is rechecked under the lock.
    expect(
      await drainNoTurnLeaseForComputeBounds(db, {
        ...org,
        sandboxGroupId: turnHeld,
        expectedEpoch: 99,
        reason: "compute_closed",
        quietForMs: 0,
        idleGraceMs: 60_000,
      }),
    ).toMatchObject({ drained: false });
  }, 60_000);

  test("the reaper drains a compute box only when its tier is closed, never for a spent day", async () => {
    const org = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    expect((await acquire(org, "viewer", { group, backend: "compute" })).role).toBe("spawner");
    const epoch = await warm(org, group);
    const drain = (reason: "compute_daily_budget" | "compute_closed") =>
      drainNoTurnLeaseForComputeBounds(db, {
        ...org,
        sandboxGroupId: group,
        expectedEpoch: epoch,
        reason,
        quietForMs: 0,
        idleGraceMs: 60_000,
      });
    // Its own disk and memory are its state, which a drain does not save.
    expect(await drain("compute_daily_budget")).toMatchObject({ drained: false });
    const [kept] = await admin<{ liveness: string }[]>`select liveness from sandbox_leases
      where workspace_id = ${org.workspaceId} and sandbox_group_id = ${group}`;
    expect(kept!.liveness).toBe("warm");
    expect(await drain("compute_closed")).toMatchObject({ drained: true });
  }, 60_000);

  test("a turnless drain never cuts off someone using the box or a running command", async () => {
    const org = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    expect((await acquire(org, "viewer", { group })).role).toBe("spawner");
    const epoch = await warm(org, group);
    const drain = (target: string, expectedEpoch: number, quietForMs: number) =>
      drainNoTurnLeaseForComputeBounds(db, {
        ...org,
        sandboxGroupId: target,
        expectedEpoch,
        reason: "compute_turnless",
        quietForMs,
        idleGraceMs: 60_000,
      });
    // Active within the idle window: kept.
    expect(await drain(group, epoch, 3_600_000)).toEqual({
      drained: false,
      reason: "active_since_decision",
    });
    // A running command or Browser/ComputerSession holder: kept, never stopped.
    const busy = crypto.randomUUID();
    expect((await acquire(org, "interaction", { group: busy })).role).toBe("spawner");
    const busyEpoch = await warm(org, busy);
    expect(await drain(busy, busyEpoch, 0)).toEqual({ drained: false, reason: "compute_commands" });
    const [running] = await admin<{ liveness: string; rotation_reason: string | null }[]>`
      select liveness, rotation_reason from sandbox_leases
      where workspace_id = ${org.workspaceId} and sandbox_group_id = ${busy}`;
    expect(running).toEqual({ liveness: "warm", rotation_reason: null });
    // Idle: drained.
    expect(await drain(group, epoch, 0)).toMatchObject({ drained: true, mode: "drained" });
  }, 60_000);
});
