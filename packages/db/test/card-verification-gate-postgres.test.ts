import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import {
  acquireLease as acquireLeaseUnscoped,
  commitWarmingToWarm,
  createAdditionalManagedOrganization,
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  readCardVerification,
  readCardVerificationGate,
  recordCardVerification,
  resetCardVerificationGateCache,
  resetOrganizationSuspensionCache,
  resetSandboxPersonStandingCache,
  resolveSandboxComputeStanding,
  SandboxOrganizationBoxLimitError,
  withCreditDebitAttribution,
  type AcquireLeaseInput,
  type Database,
  type DbClient,
} from "../src/index";

// The card verification gate (migration 1494, docs/signup-abuse-protection.md,
// "Card verification") through the real admission path: while it is on, an
// unpaid organization without a verified card cannot start a sandbox box;
// joining a running box, paid, Enterprise, host-provisioned and credit-buying
// organizations, and a Connected Machine are unaffected; another organization
// of the same owner inherits the owner's verified card.

const acquireLease: typeof acquireLeaseUnscoped = (db, input) =>
  withCreditDebitAttribution({ kind: "service" }, () => acquireLeaseUnscoped(db, input));

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("card-verification-gate");
  if (!shared) throw new Error("Real PostgreSQL required for the card verification gate");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  await admin.unsafe(
    "grant execute on function opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid) to opengeni_app",
  );
}, 180_000);

afterAll(async () => {
  await setGate(false);
  await client?.close();
  await shared?.release();
}, 60_000);

function forgetCaches(): void {
  resetSandboxPersonStandingCache();
  resetOrganizationSuspensionCache();
  resetCardVerificationGateCache();
}

async function setGate(enabled: boolean): Promise<void> {
  await admin`insert into card_verification_gate_revisions (enabled, changed_by, reason)
    values (${enabled}, 'test', 'card verification gate test')`;
  forgetCaches();
}

type Org = { accountId: string; workspaceId: string };

async function organization(options: { plan?: string; source?: string } = {}): Promise<Org> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name, external_source)
    values ('acct', ${options.source ?? null}) returning id`;
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

function card(accountId: string, subjectId: string, fingerprint = crypto.randomUUID()) {
  return recordCardVerification(db, {
    accountId,
    subjectId,
    provider: "stripe:test",
    customerId: "cus_test",
    paymentMethodId: `pm_${crypto.randomUUID()}`,
    setupIntentId: `seti_${crypto.randomUUID()}`,
    setupIntentCreatedAt: new Date(),
    fingerprint,
    brand: "visa",
    last4: "4242",
  });
}

function acquire(
  org: Org,
  kind: AcquireLeaseInput["kind"],
  options: { group?: string; subjectId?: string; backend?: string } = {},
) {
  return acquireLease(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: options.group ?? crypto.randomUUID(),
    kind,
    holderId: `${kind}-${crypto.randomUUID()}`,
    backend: options.backend ?? "modal",
    leaseTtlMs: 90_000,
    sandboxPlanLimits: DEFAULT_SANDBOX_PLAN_LIMITS,
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

describe("card verification gate (real PostgreSQL)", () => {
  test("off by default: an unverified Free organization starts a box", async () => {
    forgetCaches();
    expect(await readCardVerificationGate(db)).toBe(false);
    const org = await organization({ plan: "free" });
    expect((await acquire(org, "direct")).role).toBe("spawner");
  }, 120_000);

  test("on: an unverified Free or plan-less organization starts no box until a card is verified", async () => {
    await setGate(true);
    expect(await readCardVerificationGate(db)).toBe(true);
    for (const planKey of ["free", undefined]) {
      const org = await organization(planKey ? { plan: planKey } : {});
      for (const kind of ["viewer", "direct", "interaction", "turn"] as const) {
        const refused = await refusal(acquire(org, kind));
        expect(refused.reason).toBe("card_required");
        expect(refused.code).toBe("sandbox_card_required");
        expect(refused.limit).toBe(0);
        expect(refused.message).toContain("Add a card");
      }
      // A Connected Machine is the person's own computer and never counts.
      expect((await acquire(org, "turn", { backend: "selfhosted" })).role).toBe("spawner");
      expect(await readCardVerification(db, org.accountId)).toBeNull();
      const verified = await card(org.accountId, `user:${crypto.randomUUID()}`);
      expect(verified).toMatchObject({ brand: "visa", last4: "4242", provider: "stripe:test" });
      forgetCaches();
      expect((await acquire(org, "direct")).role).toBe("spawner");
    }
  }, 120_000);

  test("on: paid, Enterprise, host-provisioned and credit-buying organizations are unaffected", async () => {
    await setGate(true);
    const toppedUp = await organization({ plan: "free" });
    await admin`insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values (${toppedUp.accountId}::uuid, 'credit_topup', 5000000, ${crypto.randomUUID()})`;
    for (const org of [
      await organization({ plan: "pro" }),
      await organization({ plan: "enterprise" }),
      await organization({ source: "host:embedded-product" }),
      toppedUp,
    ]) {
      forgetCaches();
      expect((await acquire(org, "direct")).role).toBe("spawner");
    }
  }, 120_000);

  test("on: joining a box that is already running is admitted", async () => {
    await setGate(false);
    const org = await organization({ plan: "free" });
    const group = crypto.randomUUID();
    expect((await acquire(org, "turn", { group })).role).toBe("spawner");
    await commitWarmingToWarm(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sandboxGroupId: group,
      expectedEpoch: 0,
      instanceId: `box-${group}`,
      leaseTtlMs: 90_000,
    });
    await setGate(true);
    expect((await acquire(org, "viewer", { group })).role).not.toBe("spawner");
    // A new box is still refused.
    expect((await refusal(acquire(org, "direct"))).reason).toBe("card_required");
  }, 120_000);

  test("another organization of the same owner inherits their verified card for sandboxes", async () => {
    await setGate(true);
    const userId = `card-gate-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUserWithOrganizationMemberships(db, {
      userId,
      email: `${userId}@example.test`,
      name: "Card person",
    });
    await admin`insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Card person', ${`${userId}@example.test`}, true)
      on conflict (id) do update set email_verified = true`;
    const first = access.organizationMemberships[0]!;
    const second = await createAdditionalManagedOrganization(db, {
      subjectId,
      subjectLabel: "Card person",
      name: `Second ${crypto.randomUUID().slice(0, 8)}`,
      workspaceName: "Team",
      operationId: crypto.randomUUID(),
    });
    const one = { accountId: first.organizationId, workspaceId: first.personalWorkspaceId! };
    const two = { accountId: second.organization.id, workspaceId: second.workspaceId };
    for (const org of [one, two]) {
      await admin`insert into workspace_inference_controls (workspace_id, account_id)
        values (${org.workspaceId}, ${org.accountId}) on conflict do nothing`;
      await admin`insert into organization_plans (account_id, plan_key, status)
        values (${org.accountId}, 'free', 'active')
        on conflict (account_id) do update set plan_key = 'free', status = 'active'`;
    }
    forgetCaches();
    expect((await refusal(acquire(two, "direct", { subjectId }))).reason).toBe("card_required");
    await card(one.accountId, subjectId);
    forgetCaches();
    const standing = await resolveSandboxComputeStanding(db, {
      accountId: two.accountId,
      limits: DEFAULT_SANDBOX_PLAN_LIMITS,
      actingSubjectId: subjectId,
    });
    expect(standing.cardRequired).toBe(false);
    expect((await acquire(two, "direct", { subjectId })).role).toBe("spawner");
    // Work no person acts for needs the organization's own card.
    expect((await refusal(acquire(two, "direct"))).reason).toBe("card_required");
  }, 120_000);

  test("the audited setter switches the gate and validates its value", async () => {
    const [before] = await admin<
      { settings: { revision: number; cardVerificationMode: string } }[]
    >`
      select opengeni_private.signup_network_velocity_settings(current_schema()::text) as settings`;
    const target = before!.settings.cardVerificationMode === "enforce" ? "off" : "enforce";
    const [changed] = await admin<{ result: { current: { cardVerificationMode: string } } }[]>`
      select opengeni_private.set_signup_network_velocity(
        ${JSON.stringify({ cardVerificationMode: target })}::text::jsonb, 'tester', 'card gate test',
        ${before!.settings.revision}) as result`;
    expect(changed!.result.current.cardVerificationMode).toBe(target);
    forgetCaches();
    expect(await readCardVerificationGate(db)).toBe(target === "enforce");
    await expect(
      admin`select opengeni_private.set_signup_network_velocity(
        ${JSON.stringify({ cardVerificationMode: "maybe" })}::text::jsonb, 'tester', 'card gate test',
        ${before!.settings.revision + 1})`,
    ).rejects.toThrow("cardVerificationMode must be off or enforce");
    // Runtime roles read the switch but never write it.
    await expect(
      Promise.resolve(
        db.execute(
          (await import("drizzle-orm"))
            .sql`insert into card_verification_gate_revisions (enabled, changed_by, reason) values (false, 'x', 'forged change')`,
        ),
      ),
    ).rejects.toThrow();
  }, 120_000);
});
