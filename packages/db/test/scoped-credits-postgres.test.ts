import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawRows } from "../src/database";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";
import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  createDb,
  ensureManagedAccessForUser,
  getBillingBalance,
  getSpendableCreditBalance,
  readCreditPromotionPolicy,
  type DbClient,
  withRlsContext,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("scoped-credits");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function account() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Credit test",
  });
  return access.workspaceGrants[0]!.accountId;
}
const grant = (accountId: string, amountMicros: number, eligibleModelIds?: string[]) =>
  applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros,
    type: "grant",
    idempotencyKey: crypto.randomUUID(),
    ...(eligibleModelIds ? { eligibleModelIds } : {}),
  });
const debit = (
  accountId: string,
  amount: number,
  modelId?: string,
  idempotencyKey = crypto.randomUUID(),
) =>
  applyCreditDebitUpToBalance(client!.db, {
    accountId,
    requestedAmountMicros: amount,
    type: "test_model_debit",
    idempotencyKey,
    ...(modelId ? { modelId } : {}),
  });

test("the migrated application role passes runtime posture with read-only policy access", async () => {
  if (!client) return;
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: "public",
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
});

test("uses eligible grants first; other models and resources spend general credits only", async () => {
  if (!client) return;
  const id = await account();
  await grant(id, 100, ["model-a"]);
  await grant(id, 10);
  expect((await debit(id, 30, "model-a")).debitedMicros).toBe(30);
  expect((await getBillingBalance(client.db, id)).generalBalanceMicros).toBe(10);
  expect((await debit(id, 20, "model-b")).debitedMicros).toBe(10);
  expect((await getSpendableCreditBalance(client.db, id)).balanceMicros).toBe(0);
  expect((await getSpendableCreditBalance(client.db, id, "model-a")).balanceMicros).toBe(70);
  await applyCreditDebitAfterUse(client.db, {
    accountId: id,
    amountMicros: 5,
    type: "test_resource_debit",
    sourceType: "test_resource",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  });
  const balance = await getBillingBalance(client.db, id);
  expect(balance.generalBalanceMicros).toBe(-5);
  expect(balance.promotionalCredits?.[0]?.remainingMicros).toBe(70);
  expect((await debit(id, 80, "model-a")).debitedMicros).toBe(70);
  expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(-5);
}, 180_000);

test("concurrent charges cannot spend a grant twice, and retries preserve allocations", async () => {
  if (!client || !shared) return;
  const id = await account();
  await grant(id, 100, ["model-a"]);
  const keys = Array.from({ length: 10 }, () => crypto.randomUUID());
  const charged = await Promise.all(keys.map((key) => debit(id, 20, "model-a", key)));
  expect(charged.reduce((sum, item) => sum + item.debitedMicros, 0)).toBe(100);
  await grant(id, 100, ["model-a"]);
  const replayed = await Promise.all(keys.map((key) => debit(id, 20, "model-a", key)));
  expect(replayed.every((item) => item.debitedMicros === 0)).toBe(true);
  expect((await getBillingBalance(client.db, id)).balanceMicros).toBe(100);
  const [row] =
    await shared.admin`select sum(amount_micros)::int as total from credit_debit_allocations where account_id = ${id}`;
  expect(row?.total).toBe(100);
}, 180_000);

test("each grant keeps its own eligibility and cannot fund another organization", async () => {
  if (!client || !shared) return;
  const id = await account();
  const other = await account();
  await grant(id, 40, ["model-a"]);
  await grant(id, 60, ["model-b"]);
  expect((await debit(id, 50, "model-a")).debitedMicros).toBe(40);
  expect((await debit(other, 50, "model-b")).debitedMicros).toBe(0);
  expect((await getBillingBalance(client.db, other)).promotionalCredits).toEqual([]);
  expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(60);
}, 180_000);

test("issued terms cannot be edited, and failed allocation persistence rolls back the debit", async () => {
  if (!client || !shared) return;
  const id = await account();
  const balance = await grant(id, 100, ["model-a"]);
  const grantId = balance.promotionalCredits![0]!.grantId;
  await expect(
    withRlsContext(client.db, { accountId: id }, async (tx) => {
      await tx.execute(
        sql`update credit_ledger_entries set eligible_model_ids = array['model-b'] where id = ${grantId}::uuid`,
      );
    }),
  ).rejects.toThrow();
  // The helper must keep the debit and its allocations in the outer transaction.
  await expect(
    withRlsContext(client.db, { accountId: id }, async (tx) => {
      await applyCreditDebitUpToBalance(tx, {
        accountId: id,
        requestedAmountMicros: 50,
        type: "test_model_debit",
        modelId: "model-a",
        idempotencyKey: crypto.randomUUID(),
      });
      throw new Error("simulate caller rollback");
    }),
  ).rejects.toThrow("simulate caller rollback");
  expect((await getSpendableCreditBalance(client.db, id, "model-a")).balanceMicros).toBe(100);
}, 180_000);

test("operator changes live coverage, per-offer overrides, and in-flight settlement without rewriting grants", async () => {
  if (!client || !shared) return;
  const id = await account();
  await applyCreditLedgerEntry(client.db, {
    accountId: id,
    type: "grant",
    amountMicros: 100,
    eligibleModelIds: ["model-a"],
    sourceType: "verified_signup_trial",
    idempotencyKey: crypto.randomUUID(),
  });
  await applyCreditLedgerEntry(client.db, {
    accountId: id,
    type: "grant",
    amountMicros: 200,
    eligibleModelIds: ["model-a"],
    metadata: { creditOfferId: "coupon_example" },
    idempotencyKey: crypto.randomUUID(),
  });
  await grant(id, 25);
  const admitted = await getSpendableCreditBalance(client.db, id, "model-a");
  const policy = {
    defaultModelIds: ["model-b"],
    offers: { coupon_example: { label: "Launch credits", eligibleModelIds: ["model-c"] } },
  };
  const operator = createDb(shared.adminUrl, { max: 1 });
  let written: { revision: number } | undefined;
  try {
    [written] = await rawRows<{ revision: number }>(
      operator.db,
      sql`select set_credit_promotion_policy(${JSON.stringify(policy)}::jsonb, 'test operator', 'Switch available models') as revision`,
    );
  } finally {
    await operator.close();
  }
  expect((await readCreditPromotionPolicy(client.db))?.defaultModelIds).toEqual(["model-b"]);
  expect(Number(written!.revision)).toBeGreaterThan(0);
  expect((await getSpendableCreditBalance(client.db, id, "model-a")).balanceMicros).toBe(25);
  expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(125);
  expect((await getSpendableCreditBalance(client.db, id, "model-c")).balanceMicros).toBe(225);
  // A response admitted just before the switch still spends the free grant.
  await applyCreditDebitUpToBalance(client.db, {
    accountId: id,
    type: "test_model_debit",
    modelId: "model-a",
    requestedAmountMicros: 50,
    creditPolicyRevision: admitted.creditPolicyRevision,
    idempotencyKey: crypto.randomUUID(),
  });
  expect((await getBillingBalance(client.db, id)).generalBalanceMicros).toBe(25);
  expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(75);
  // Removing an override returns existing grants to the shared default.
  await shared.admin`select set_credit_promotion_policy(${shared.admin.json({ defaultModelIds: ["model-b"], signupModelIds: ["model-d"] })}::jsonb, 'test operator', 'Use shared offer list')`;
  expect((await getSpendableCreditBalance(client.db, id, "model-b")).balanceMicros).toBe(225);
  expect((await getSpendableCreditBalance(client.db, id, "model-d")).balanceMicros).toBe(75);
  expect((await getSpendableCreditBalance(client.db, id, "model-c")).balanceMicros).toBe(25);
  // Runtime accounts cannot edit coverage or append policy revisions.
  await expect(
    (async () =>
      await client!.db.execute(
        sql`select set_credit_promotion_policy(${JSON.stringify(policy)}::jsonb, 'test operator', 'Forbidden runtime update')`,
      ))(),
  ).rejects.toThrow();
  await expect(
    (async () =>
      await client!.db.execute(
        sql`insert into opengeni_private.credit_promotion_policy_revisions (policy, operator, reason) values (${JSON.stringify(policy)}::jsonb, 'test operator', 'Forbidden runtime update')`,
      ))(),
  ).rejects.toThrow();
  for (const invalid of [
    { defaultModelIds: [] },
    { defaultModelIds: null },
    { defaultModelIds: [42] },
    { defaultModelIds: ["model-b"], signupModelIds: [] },
  ]) {
    await expect(
      (async () =>
        await shared!
          .admin`select set_credit_promotion_policy(${shared.admin.json(invalid)}::jsonb, 'test operator', 'Reject invalid policy')`)(),
    ).rejects.toThrow();
  }
}, 180_000);

test("operator command validates catalog IDs, applies policy and reads it back", async () => {
  if (!client || !shared) return;
  const directory = await mkdtemp(join(tmpdir(), "credit-policy-test-"));
  const file = join(directory, "policy.json");
  const run = async (args: string[]) => {
    const process = Bun.spawn(
      ["bun", "--no-env-file", "scripts/operator/credit-promotion-policy.ts", ...args],
      {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: {
          PATH: globalThis.process.env.PATH!,
          OPENGENI_DATABASE_ADMIN_URL: shared!.adminUrl,
          OPENGENI_DATABASE_URL: shared!.appUrl,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  try {
    await Bun.write(file, JSON.stringify({ defaultModelIds: ["not-a-real-model"] }));
    const bad = await run([
      "--file",
      file,
      "--operator",
      "test operator",
      "--reason",
      "Test invalid model",
    ]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("must be a canonical credit-funded model");
    await Bun.write(file, JSON.stringify({ defaultModelIds: ["gpt-6-luna"] }));
    const applied = await run([
      "--file",
      file,
      "--operator",
      "test operator",
      "--reason",
      "Test live model switch",
    ]);
    expect(applied.stderr).toBe("");
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout).applied).toBe(true);
    const shown = await run(["--show"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout).policy.defaultModelIds).toEqual(["gpt-6-luna"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
