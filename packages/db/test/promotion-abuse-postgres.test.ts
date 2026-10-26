import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  applyCreditDebitAfterUse,
  completeSelfServiceOrganizationSetup,
  createDb,
  expirePlanCreditPeriod,
  freePlanCreditEligible,
  grantPlanCreditPeriod,
  upsertOrganizationPlan,
  withRlsContext,
  type DbClient,
} from "../src";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("promotion-abuse");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function recipient() {
  const userId = crypto.randomUUID();
  await shared!.admin`insert into auth_users(id,name,email,email_verified)
    values (${userId},'Synthetic trial',${`${userId}@example.test`},true)`;
  const { organizationId } = await completeSelfServiceOrganizationSetup(client!.db, {
    authUserId: userId,
    actorSubjectId: `user:${userId}`,
    organizationName: "Synthetic trial",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    trialCreditsEnabled: true,
    trialCreditModelIds: ["model-a"],
  });
  const periodStart = new Date(Date.now() - 1000),
    periodEnd = new Date(Date.now() + 3600_000);
  await upsertOrganizationPlan(client!.db, {
    accountId: organizationId,
    planKey: "free",
    status: "active",
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await grantPlanCreditPeriod(client!.db, {
    accountId: organizationId,
    planKey: "free",
    periodStart,
    periodEnd,
  });
  return organizationId;
}
async function spend(accountId: string, amountMicros: number) {
  await applyCreditDebitAfterUse(client!.db, {
    accountId,
    type: "model_usage_debit",
    amountMicros,
    usage: "model-a",
    sourceType: "test",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
}

// The HTTP enrollment suite separately verifies signatures and rejects forgeries.
// Owner-seeded proofs here reproduce a real campaign without production accounts,
// external providers or charges, and exercise the actual SQL rule and grant seam.
test("proven machine rotation needs distinct recipients and depleted free allowances; observation, holds, release and isolation", async () => {
  if (!shared || !client) return;
  const ids = await Promise.all([recipient(), recipient(), recipient()]);
  const independent = await recipient();
  const keyHash = "b".repeat(64);
  for (const id of ids)
    await shared.admin`insert into promotion_machine_proofs(account_id,enrollment_id,credential_generation,key_hash)
    values(${id},${crypto.randomUUID()},1,${keyHash})`;
  await shared.admin`select opengeni_private.set_promotion_detector_mode('observe','operator:test')`;
  await spend(ids[0]!, 9_000_000);
  expect(await freePlanCreditEligible(client.db, ids[2]!)).toBe(true);
  expect(
    await shared.admin`select * from opengeni_private.promotion_detector_observations where data_schema=${shared.schema}`,
  ).toHaveLength(0);
  await spend(ids[1]!, 9_000_000);
  expect(await freePlanCreditEligible(client.db, ids[2]!)).toBe(true);
  expect(
    await shared.admin`select * from opengeni_private.promotion_detector_observations where data_schema=${shared.schema}`,
  ).toHaveLength(1);
  expect(await shared.admin`select * from promotion_decisions`).toHaveLength(0);
  await shared.admin`select opengeni_private.set_promotion_detector_mode('enforce','operator:test')`;
  await shared.admin`update promotion_enforcement set enabled=true`;
  expect(await freePlanCreditEligible(client.db, ids[2]!)).toBe(false);
  expect(await freePlanCreditEligible(client.db, independent)).toBe(true);
  const [held] = await shared.admin`select * from promotion_decisions where account_id=${ids[2]!}`;
  expect(held!.decision).toBe("held");
  await freePlanCreditEligible(client.db, ids[2]!);
  const [replayed] =
    await shared.admin`select * from promotion_decisions where account_id=${ids[2]!}`;
  expect(replayed!.revision).toBe(held!.revision);
  await shared.admin`select opengeni_private.set_promotion_decision(${ids[2]!},'eligible','operator-v1','reviewed', '{}'::jsonb,'operator:test',${held!.revision})`;
  expect(await freePlanCreditEligible(client.db, ids[2]!)).toBe(true);
  const visible = await withRlsContext(client.db, { accountId: independent }, (tx) =>
    tx.execute(sql`select * from promotion_machine_proofs`),
  );
  expect(Array.from(visible as Iterable<unknown>)).toHaveLength(0);
  await expect(
    (async () =>
      await client!.db.execute(
        sql`select * from opengeni_private.promotion_detector_observations`,
      ))(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await client!.db.execute(
        sql`select opengeni_private.set_promotion_detector_mode('off','operator:forged')`,
      ))(),
  ).rejects.toThrow();
}, 180_000);

test("expiry allocations are not spending evidence", async () => {
  if (!shared || !client) return;
  const ids = await Promise.all([recipient(), recipient(), recipient()]);
  for (const id of ids)
    await shared.admin`insert into promotion_machine_proofs(account_id,enrollment_id,credential_generation,key_hash)
    values(${id},${crypto.randomUUID()},1,${"c".repeat(64)})`;
  for (const id of ids.slice(0, 2)) {
    const [period] = await shared.admin`select id from plan_credit_periods where account_id=${id}`;
    await expirePlanCreditPeriod(client.db, { accountId: id, periodId: period!.id, force: true });
  }
  expect(await freePlanCreditEligible(client.db, ids[2]!)).toBe(true);
  expect(
    await shared.admin`select * from promotion_decisions where account_id=${ids[2]!}`,
  ).toHaveLength(0);
  expect(
    await shared.admin`select * from opengeni_private.promotion_detector_observations
    where data_schema=${shared.schema} and account_id=${ids[2]!}`,
  ).toHaveLength(0);
}, 180_000);

test("excess proven keys produce explicit review evidence instead of partial automatic inference", async () => {
  if (!shared || !client) return;
  const id = await recipient();
  for (let n = 0; n < 17; n++)
    await shared.admin`insert into promotion_machine_proofs(account_id,enrollment_id,credential_generation,key_hash)
    values(${id},${crypto.randomUUID()},1,${n.toString(16).padStart(64, "0")})`;
  expect(await freePlanCreditEligible(client.db, id)).toBe(true);
  const [observation] =
    await shared.admin`select evidence from opengeni_private.promotion_detector_observations
    where data_schema=${shared.schema} and account_id=${id} and policy_version='machine-key-overflow-v1'`;
  expect(observation!.evidence.requiresOperatorReview).toBe(true);
  expect(await shared.admin`select * from promotion_decisions where account_id=${id}`).toHaveLength(
    0,
  );
}, 180_000);
