import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  DEFAULT_SANDBOX_PLAN_LIMITS,
  parseSandboxPlanLimitsJson,
  type SandboxFleetLimits,
} from "@opengeni/config";
import {
  acquireLease as acquireLeaseUnscoped,
  createDb,
  readSandboxUnpaidFleet,
  resetOrganizationSuspensionCache,
  resetSandboxFleetState,
  resetSandboxPersonStandingCache,
  SandboxOrganizationBoxLimitError,
  withCreditDebitAttribution,
  type AcquireLeaseInput,
  type Database,
  type DbClient,
} from "../src/index";

// The unpaid fleet limits (docs/deployment.md, "Unpaid fleet limits") through
// the real admission path: every unpaid organization together has a running
// cap and a daily box-time budget, a young unpaid organization runs one box,
// fleet pressure stops new unpaid boxes, and paid, Enterprise and
// host-provisioned organizations are never counted or limited.

const acquireLease: typeof acquireLeaseUnscoped = (db, input) =>
  withCreditDebitAttribution({ kind: "service" }, () => acquireLeaseUnscoped(db, input));

const FLEET_ROUTINE = "opengeni_private.sandbox_unpaid_fleet_v1(uuid, boolean)";
const DAY_MS = 24 * 60 * 60 * 1000;

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-fleet-limits");
  if (!shared) throw new Error("Real PostgreSQL required for the unpaid fleet limits");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  await admin.unsafe(
    "grant execute on function opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid) to opengeni_app",
  );
  await grantFleet(true);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

beforeEach(() => {
  resetSandboxFleetState();
  resetSandboxPersonStandingCache();
  resetOrganizationSuspensionCache();
});

async function grantFleet(granted: boolean): Promise<void> {
  await admin.unsafe(
    granted
      ? `grant execute on function ${FLEET_ROUTINE} to opengeni_app`
      : `revoke execute on function ${FLEET_ROUTINE} from opengeni_app`,
  );
  resetSandboxFleetState();
}

type Org = { accountId: string; workspaceId: string };

async function organization(
  options: { plan?: string; ageMs?: number; source?: string } = {},
): Promise<Org> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name, external_source, created_at)
    values ('acct', ${options.source ?? null},
      now() - (${String(options.ageMs ?? 7 * DAY_MS)} || ' milliseconds')::interval)
    returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  if (options.plan) {
    await admin`insert into organization_plans (account_id, plan_key, status)
      values (${account!.id}, ${options.plan}, 'active')`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function acquire(
  org: Org,
  kind: AcquireLeaseInput["kind"],
  fleet: SandboxFleetLimits,
  options: { group?: string; holderId?: string; subscriptionPlansEnabled?: boolean } = {},
) {
  const withoutPlans = options.subscriptionPlansEnabled === false;
  return acquireLease(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: options.group ?? crypto.randomUUID(),
    kind,
    holderId: options.holderId ?? `${kind}-${crypto.randomUUID()}`,
    backend: "modal",
    leaseTtlMs: 90_000,
    sandboxPlanLimits: withoutPlans
      ? parseSandboxPlanLimitsJson("", { subscriptionPlansEnabled: false })
      : DEFAULT_SANDBOX_PLAN_LIMITS,
    ...(withoutPlans ? { subscriptionPlansEnabled: false } : {}),
    sandboxFleetLimits: fleet,
  });
}

async function refusal(attempt: Promise<unknown>): Promise<SandboxOrganizationBoxLimitError> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof SandboxOrganizationBoxLimitError) return error;
    throw error;
  }
  throw new Error("expected a fleet refusal");
}

async function unpaidRunning(): Promise<number> {
  resetSandboxFleetState();
  const counts = await readSandboxUnpaidFleet(db, { excludeLeaseId: null, withBoxSeconds: false });
  return counts!.runningBoxes;
}

async function warmBoxes(): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from sandbox_leases
    where liveness in ('warming', 'warm')`;
  return row!.n;
}

async function paidOrganizations(): Promise<Org[]> {
  const topUp = await organization({ plan: "free" });
  await admin`insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${topUp.accountId}::uuid, 'credit_topup', 5000000, ${crypto.randomUUID()})`;
  return [
    await organization({ plan: "pro" }),
    await organization({ plan: "enterprise" }),
    await organization({ source: "host:embedded-product" }),
    topUp,
  ];
}

describe("unpaid fleet limits (real PostgreSQL)", () => {
  test("unpaid organizations together share the fleet's running cap; paid ones never count", async () => {
    const fleet = { unpaidRunningBoxes: (await unpaidRunning()) + 2 };
    const before = await unpaidRunning();
    const first = await organization({ plan: "free" });
    const firstGroup = crypto.randomUUID();
    expect((await acquire(first, "direct", fleet, { group: firstGroup })).role).toBe("spawner");
    expect((await acquire(await organization(), "interaction", fleet)).role).toBe("spawner");
    expect(await unpaidRunning()).toBe(before + 2);
    // Each organization has room, the fleet does not: every holder kind is
    // refused with the retryable capacity code, and a turn fails rather than
    // waiting.
    const busy = await organization({ plan: "free" });
    for (const kind of ["direct", "viewer", "interaction", "turn"] as const) {
      resetSandboxFleetState();
      const refused = await refusal(acquire(busy, kind, fleet));
      expect([refused.reason, refused.code]).toEqual([
        "fleet_busy",
        "sandbox_capacity_unpaid_busy",
      ]);
      expect(refused.message).toContain("Try again in a few minutes");
    }
    // Joining a running unpaid box adds none and is admitted.
    expect((await acquire(first, "viewer", fleet, { group: firstGroup })).role).toBe("attached");
    // Paid, Enterprise, host-provisioned and credit-buying organizations
    // start boxes and are not counted.
    for (const org of await paidOrganizations()) {
      expect((await acquire(org, "direct", fleet)).role).toBe("spawner");
    }
    expect(await unpaidRunning()).toBe(before + 2);
  }, 120_000);

  test("a spent fleet day stops new unpaid boxes until the next UTC day", async () => {
    const org = await organization({ plan: "free" });
    expect((await acquire(org, "direct", {})).role).toBe("spawner");
    resetSandboxFleetState();
    const seconds = (await readSandboxUnpaidFleet(db, {
      excludeLeaseId: null,
      withBoxSeconds: true,
    }))!.boxSecondsToday!;
    const fleet = { unpaidBoxSecondsPerDay: seconds + 3600 };
    // Yesterday's box time does not count.
    await admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        idempotency_key, occurred_at)
      values (${org.accountId}, ${org.workspaceId}, 'sandbox.warm_seconds', 50000, 'seconds',
        ${crypto.randomUUID()}, now() - interval '1 day')`;
    resetSandboxFleetState();
    expect((await acquire(await organization({ plan: "free" }), "direct", fleet)).role).toBe(
      "spawner",
    );
    await admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
        idempotency_key, occurred_at)
      values (${org.accountId}, ${org.workspaceId}, 'sandbox.warm_seconds', 3600, 'seconds',
        ${crypto.randomUUID()}, now())`;
    resetSandboxFleetState();
    const spent = await refusal(acquire(await organization({ plan: "free" }), "turn", fleet));
    expect([spent.reason, spent.code]).toEqual([
      "fleet_daily_budget",
      "sandbox_capacity_unpaid_busy",
    ]);
    expect(spent.message).toContain("after midnight UTC");
    for (const paid of await paidOrganizations()) {
      expect((await acquire(paid, "direct", fleet)).role).toBe("spawner");
    }
  }, 120_000);

  test("a young unpaid organization runs one box; an older or paid one runs its plan's", async () => {
    const fleet = { youngOrganizationAgeMs: DAY_MS, youngOrganizationRunningBoxes: 1 };
    const young = await organization({ plan: "free", ageMs: 60_000 });
    const group = crypto.randomUUID();
    expect((await acquire(young, "turn", fleet, { group, holderId: "t1" })).role).toBe("spawner");
    // Chat, terminal and browser share that one box.
    expect((await acquire(young, "direct", fleet, { group })).role).toBe("attached");
    expect((await acquire(young, "interaction", fleet, { group })).role).toBe("attached");
    const second = await refusal(acquire(young, "direct", fleet));
    expect([second.reason, second.limit]).toEqual(["young_running", 1]);
    expect(second.message).toContain("first day");
    // A turn waits for the slot instead of failing.
    expect(await acquire(young, "turn", fleet)).toMatchObject({
      role: "fenced",
      reason: "organization_sandbox_capacity",
      organizationBoxLimit: 1,
    });
    // A box only viewers keep warm (an open desktop) is not counted, so the
    // first chat still gets its box.
    const watching = await organization({ plan: "free", ageMs: 60_000 });
    expect((await acquire(watching, "viewer", fleet)).role).toBe("spawner");
    expect((await acquire(watching, "turn", fleet, { holderId: "t2" })).role).toBe("spawner");
    // A plan-less young organization is bounded the same way.
    const noPlan = await organization({ ageMs: 60_000 });
    expect((await acquire(noPlan, "direct", fleet)).role).toBe("spawner");
    expect((await refusal(acquire(noPlan, "direct", fleet))).reason).toBe("young_running");
    // Older than the age: the plan's two.
    const older = await organization({ plan: "free", ageMs: 2 * DAY_MS });
    expect((await acquire(older, "direct", fleet)).role).toBe("spawner");
    expect((await acquire(older, "direct", fleet)).role).toBe("spawner");
    // A young paid organization is not limited.
    const paid = await organization({ plan: "pro", ageMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect((await acquire(paid, "direct", fleet)).role).toBe("spawner");
    }
  }, 120_000);

  test("without subscription plans a plan-less organization is outside the unpaid fleet", async () => {
    // No organization ever gets a plan row there, so a plan-less one is the
    // deployment's ordinary organization: never young-limited, never counted
    // toward or refused by the unpaid fleet's cap.
    const before = await unpaidRunning();
    const fleet = {
      youngOrganizationAgeMs: DAY_MS,
      youngOrganizationRunningBoxes: 1,
      unpaidRunningBoxes: before,
    };
    const young = await organization({ ageMs: 60_000 });
    for (const kind of ["direct", "turn", "interaction", "direct"] as const) {
      resetSandboxFleetState();
      expect((await acquire(young, kind, fleet, { subscriptionPlansEnabled: false })).role).toBe(
        "spawner",
      );
    }
    expect(await unpaidRunning()).toBe(before);
    // With plans on, the same organization is unpaid and refused.
    resetSandboxFleetState();
    expect(
      (await refusal(acquire(await organization({ ageMs: 60_000 }), "direct", fleet))).reason,
    ).toBe("fleet_busy");
  }, 120_000);

  test("a young unpaid organization gets its first day's box time, then no new box", async () => {
    const fleet = { youngOrganizationAgeMs: DAY_MS, youngOrganizationBoxSeconds: 6 * 3600 };
    const used = async (org: Org, seconds: number, ago: string) => {
      await admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit,
          idempotency_key, occurred_at)
        values (${org.accountId}, ${org.workspaceId}, 'sandbox.warm_seconds', ${seconds}, 'seconds',
          ${crypto.randomUUID()}, now() - ${ago}::interval)`;
    };
    const young = await organization({ plan: "free", ageMs: 2 * 3600_000 });
    await used(young, 6 * 3600 - 1, "1 hour");
    expect((await acquire(young, "direct", fleet)).role).toBe("spawner");
    await used(young, 1, "1 minute");
    for (const kind of ["direct", "viewer", "turn"] as const) {
      const spent = await refusal(acquire(young, kind, fleet));
      expect([spent.reason, spent.code, spent.limit]).toEqual([
        "young_box_time",
        "sandbox_compute_unavailable",
        6 * 3600,
      ]);
      expect(spent.message).toContain("6 sandbox hours");
    }
    // The same use by an older or a paid young organization is within its plan.
    const older = await organization({ plan: "free", ageMs: 2 * DAY_MS });
    await used(older, 6 * 3600, "1 hour");
    expect((await acquire(older, "direct", fleet)).role).toBe("spawner");
    const paidYoung = await organization({ plan: "pro", ageMs: 2 * 3600_000 });
    await used(paidYoung, 6 * 3600, "1 hour");
    expect((await acquire(paidYoung, "direct", fleet)).role).toBe("spawner");
  }, 120_000);

  test("fleet pressure stops new unpaid boxes and releases with hysteresis", async () => {
    const current = await warmBoxes();
    const fleet = {
      pressureEngageWarmBoxes: current + 1,
      pressureReleaseWarmBoxes: current,
      pressureReleaseAfterMs: 0,
      pressureUnpaidRunningBoxes: 0,
    };
    const unpaid = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    // At the threshold, not over it: admitted.
    expect((await acquire(unpaid, "direct", fleet, { group })).role).toBe("spawner");
    expect((await acquire(await organization({ plan: "pro" }), "direct", fleet)).role).toBe(
      "spawner",
    );
    resetSandboxFleetState();
    // Over it: no new unpaid box, while joins and paid organizations go on.
    const refused = await refusal(acquire(await organization({ plan: "free" }), "direct", fleet));
    expect(refused.reason).toBe("fleet_busy");
    expect((await acquire(unpaid, "viewer", fleet, { group })).role).toBe("attached");
    for (const paid of await paidOrganizations()) {
      expect((await acquire(paid, "direct", fleet)).role).toBe("spawner");
    }
  }, 120_000);

  test("until the fleet definer is granted, its cap and budget wait; pressure still applies", async () => {
    await grantFleet(false);
    try {
      const fleet = { unpaidRunningBoxes: 0, unpaidBoxSecondsPerDay: 0 };
      // A cap of 0 refuses without counting; a positive cap needs the count.
      expect(
        (await refusal(acquire(await organization({ plan: "free" }), "direct", fleet))).reason,
      ).toBe("fleet_busy");
      resetSandboxFleetState();
      expect(
        (await acquire(await organization({ plan: "free" }), "direct", { unpaidRunningBoxes: 1 }))
          .role,
      ).toBe("spawner");
      resetSandboxFleetState();
      expect(
        (
          await acquire(await organization({ plan: "free" }), "direct", {
            unpaidBoxSecondsPerDay: 1,
          })
        ).role,
      ).toBe("spawner");
      const current = await warmBoxes();
      resetSandboxFleetState();
      expect(
        (
          await refusal(
            acquire(await organization({ plan: "free" }), "direct", {
              pressureEngageWarmBoxes: Math.max(0, current - 1),
              pressureUnpaidRunningBoxes: 0,
            }),
          )
        ).reason,
      ).toBe("fleet_busy");
    } finally {
      await grantFleet(true);
    }
  }, 120_000);
});
