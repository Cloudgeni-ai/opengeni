// The sweep's closed-organization drain: a box of an organization that review
// held or denied, or of an unpaid organization whose owner or viewer runs one,
// is drained without the reconnect grace so the same sweep dispatches it.
// Boxes a turn holds, Free organizations in good standing and paying ones are
// left alone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireLease as acquireLeaseUnscoped,
  commitWarmingToWarm,
  createDb,
  resetOrganizationSuspensionCache,
  resetSandboxPersonStandingCache,
  withCreditDebitAttribution,
  type AcquireLeaseInput,
  type Database,
  type DbClient,
  type MeterableWarmLease,
} from "@opengeni/db";
import { DEFAULT_SANDBOX_PLAN_LIMITS } from "@opengeni/config";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { drainClosedComputeOrganizations } from "../src/activities/sandbox-compute-bounds";

const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxIdleGraceMs: 15 * 60_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-closed-compute-drain");
  if (!shared) throw new Error("Real PostgreSQL required for the closed compute drain");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
  await admin.unsafe(
    "grant execute on function opengeni_private.organization_warm_sandbox_counts_v1(uuid, text, uuid) to opengeni_app",
  );
  await admin`insert into promotion_enforcement (singleton, enabled) values (true, true)
    on conflict (singleton) do update set enabled = excluded.enabled`;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Org = { accountId: string; workspaceId: string };

async function organization(planKey: string): Promise<Org> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await admin`insert into organization_plans (account_id, plan_key, status)
    values (${account!.id}, ${planKey}, 'active')`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function member(org: Org, subjectId: string, role: "owner" | "admin"): Promise<void> {
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${org.accountId}, 'Personal') returning id`;
  await admin`insert into organization_memberships
      (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}, ${subjectId}, ${role}, 'active', ${personal!.id})`;
}

async function decide(org: Org, decision: "held" | "denied"): Promise<void> {
  await admin`insert into promotion_decisions (account_id, decision, revision, actor)
    values (${org.accountId}, ${decision}, 1, 'test')
    on conflict (account_id) do update set decision = excluded.decision`;
  resetSandboxPersonStandingCache();
  resetOrganizationSuspensionCache();
}

/** A warm box held by `kind`; returns it as the sweep lists it. */
async function box(
  org: Org,
  kind: AcquireLeaseInput["kind"],
  subjectId?: string,
): Promise<MeterableWarmLease> {
  const group = crypto.randomUUID();
  await withCreditDebitAttribution({ kind: "service" }, () =>
    acquireLeaseUnscoped(db, {
      accountId: org.accountId,
      workspaceId: org.workspaceId,
      sandboxGroupId: group,
      kind,
      holderId: `${kind}-${crypto.randomUUID()}`,
      backend: "modal",
      leaseTtlMs: 90_000,
      sandboxPlanLimits: DEFAULT_SANDBOX_PLAN_LIMITS,
      ...(subjectId
        ? {
            actingSubjectId: subjectId,
            ...(kind === "viewer" ? { viewerSubjectId: subjectId } : {}),
          }
        : {}),
    }),
  );
  const committed = await commitWarmingToWarm(db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: group,
    expectedEpoch: 0,
    instanceId: `box-${group}`,
    leaseTtlMs: 90_000,
  });
  return {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sandboxGroupId: group,
    leaseEpoch: committed.lease!.leaseEpoch,
    backend: "modal",
  };
}

async function state(lease: MeterableWarmLease) {
  const [row] = await admin<{ liveness: string; expired: boolean }[]>`
    select liveness, expires_at <= now() as expired from sandbox_leases
    where workspace_id = ${lease.workspaceId} and sandbox_group_id = ${lease.sandboxGroupId}`;
  return row!;
}

const services = () => ({
  db,
  settings: SETTINGS,
  observability: createObservability(SETTINGS, { component: "worker-test" }),
});

describe("closed compute drain (real PostgreSQL)", () => {
  test("a held organization's boxes drain at once; a turn's box and a Free organization's stay", async () => {
    const free = await organization("free");
    const freeBox = await box(free, "viewer");
    const org = await organization("free");
    const viewerBox = await box(org, "viewer");
    const turnBox = await box(org, "turn");
    await decide(org, "held");
    const result = await drainClosedComputeOrganizations(services(), [freeBox, viewerBox, turnBox]);
    expect(result).toEqual({ inspected: 1, drained: 1 });
    // No reconnect grace: the sweep's inventory dispatches it right away.
    expect(await state(viewerBox)).toEqual({ liveness: "draining", expired: true });
    expect((await state(turnBox)).liveness).toBe("warm");
    expect((await state(freeBox)).liveness).toBe("warm");
  }, 120_000);

  test("a person denied in one organization loses the boxes of the unpaid ones they run, not of paying ones", async () => {
    const person = `user:${crypto.randomUUID()}`;
    const denied = await organization("free");
    await member(denied, person, "owner");
    const other = await organization("free");
    await member(other, person, "owner");
    const paying = await organization("pro");
    await member(paying, person, "admin");
    const otherBox = await box(other, "viewer", person);
    const payingBox = await box(paying, "viewer", person);
    const before = await drainClosedComputeOrganizations(services(), [otherBox, payingBox]);
    expect(before.drained).toBe(0);
    await decide(denied, "denied");
    const after = await drainClosedComputeOrganizations(services(), [otherBox, payingBox]);
    expect(after.drained).toBe(1);
    expect((await state(otherBox)).liveness).toBe("draining");
    expect((await state(payingBox)).liveness).toBe("warm");
  }, 120_000);
});
