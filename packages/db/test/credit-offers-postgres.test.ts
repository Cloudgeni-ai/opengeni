import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  activateCreditOffer,
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
  assignCreditOffer,
  createDb,
  creditOfferSelfServeActivation,
  ensureManagedAccessForUser,
  getBillingBalance,
  getSpendableCreditBalance,
  grantPlanCreditPeriod,
  listCreditOffers,
  nestedPostgresSqlState,
  revokeCreditOffer,
  upsertOrganizationPlan,
  withRlsContext,
  type AssignCreditOfferInput,
  type DbClient,
} from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
let owner: DbClient | null = null;
const M = 1_000_000;
const GEMINI = ["google/gemini-3-pro", "google/gemini-3-flash"];

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("credit-offers");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  owner = createDb(shared.ownerUrl, { max: 2, searchPath: shared.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await owner?.close();
  await shared?.release();
}, 180_000);

async function account() {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Design partner",
  });
  return { accountId: access.defaultAccountId!, subject: `user:${userId}` };
}

const assign = (accountId: string, overrides: Partial<AssignCreditOfferInput> = {}) =>
  assignCreditOffer(owner!.db, {
    accountId,
    label: "Design partner credits",
    amountMicros: 2_000 * M,
    eligibleModelIds: GEMINI,
    validDays: 56,
    operator: "test operator",
    reason: "Design partner programme",
    ...overrides,
  });

const debit = (accountId: string, amountMicros: number, model?: string) =>
  applyCreditDebitAfterUse(client!.db, {
    accountId,
    amountMicros,
    type: "model_usage_debit",
    sourceType: "test_model_response",
    sourceId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    ...(model ? { usage: model } : {}),
  });

/** Move an activated offer's end into the past (and its activation before it). */
async function endOffer(offerId: string) {
  await shared!.admin`update credit_offers set activated_at = clock_timestamp() - interval '2 days',
    expires_at = clock_timestamp() - interval '1 second' where id = ${offerId}`;
}

async function sqlState(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return nestedPostgresSqlState(error);
  }
  throw new Error("expected a database refusal");
}

const ACTIVATE_ROUTINE = "opengeni_private.activate_credit_offer_v1(uuid,uuid,text)";

/** The grant a follow-up migration makes; 1563 withholds it for one release. */
async function allowRuntimeActivation(allowed: boolean) {
  if (allowed) {
    await shared!.admin.unsafe(`grant execute on function ${ACTIVATE_ROUTINE} to opengeni_app`);
  } else {
    await shared!.admin.unsafe(`revoke execute on function ${ACTIVATE_ROUTINE} from opengeni_app`);
  }
}

test("the runtime role passes posture, reads offers and activates only once granted", async () => {
  if (!client) return;
  await allowRuntimeActivation(false);
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: shared!.schema,
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
  const { accountId, subject } = await account();
  const offer = await assign(accountId);
  expect(offer.status).toBe("available");
  // Until the follow-up grant, only operators activate.
  expect(await creditOfferSelfServeActivation(client.db)).toBe(false);
  expect(
    await sqlState(
      activateCreditOffer(client.db, { accountId, offerId: offer.id, subjectId: subject }),
    ),
  ).toBe("42501");
  await allowRuntimeActivation(true);
  expect(await creditOfferSelfServeActivation(client.db)).toBe(true);
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
  // Assignment, withdrawal and direct writes are owner-only.
  const runtimeAssign = withRlsContext(client.db, { accountId, workspaceId: null }, (tx) =>
    tx.execute(
      sql`select assign_credit_offer(${accountId}::uuid, 'x', 1, array['m'], 1, null, 'runtime', 'not allowed')`,
    ),
  );
  expect(await sqlState(runtimeAssign)).toBe("42501");
  const runtimeInsert = withRlsContext(client.db, { accountId, workspaceId: null }, (tx) =>
    tx.execute(sql`insert into credit_offers(account_id, label, amount_micros, eligible_model_ids,
      valid_days, assigned_by, reason) values (${accountId}::uuid, 'x', 1, array['m'], 1, 'runtime', 'not allowed')`),
  );
  expect(await sqlState(runtimeInsert)).toBe("42501");
  const runtimeExpire = withRlsContext(client.db, { accountId, workspaceId: null }, (tx) =>
    tx.execute(sql`select expire_credit_offer(${accountId}::uuid, gen_random_uuid(), true)`),
  );
  expect(await sqlState(runtimeExpire)).toBe("42501");
});

test("activation grants model-scoped credit once with an expiry; other models need credits", async () => {
  if (!client) return;
  await allowRuntimeActivation(true);
  const { accountId, subject } = await account();
  const offer = await assign(accountId);
  expect(offer).toMatchObject({ status: "available", amountMicros: 2_000 * M, validDays: 56 });
  expect(offer.eligibleModelIds).toEqual([...GEMINI].sort());
  expect(await listCreditOffers(client.db, accountId)).toEqual([offer]);
  const before = await getBillingBalance(client.db, accountId);

  const activated = await activateCreditOffer(client.db, {
    accountId,
    offerId: offer.id,
    subjectId: subject,
  });
  expect(activated.status).toBe("active");
  const days = (Date.parse(activated.expiresAt!) - Date.parse(activated.activatedAt!)) / 86_400_000;
  expect(days).toBe(56);
  // A replay neither grants again nor moves the expiry.
  expect(
    await activateCreditOffer(client.db, { accountId, offerId: offer.id, subjectId: subject }),
  ).toEqual(activated);

  const balance = await getBillingBalance(client.db, accountId);
  expect(balance.balanceMicros).toBe(before.balanceMicros + 2_000 * M);
  expect(balance.generalBalanceMicros).toBe(before.generalBalanceMicros);
  const grant = balance.promotionalCredits!.find((entry) => entry.label === offer.label)!;
  expect(grant).toMatchObject({ remainingMicros: 2_000 * M, eligibleModelIds: [...GEMINI].sort() });
  expect(Date.parse(grant.expiresAt!)).toBe(Date.parse(activated.expiresAt!));

  expect((await getSpendableCreditBalance(client.db, accountId, GEMINI[0])).balanceMicros).toBe(
    Math.max(0, before.generalBalanceMicros ?? 0) + 2_000 * M,
  );
  expect(
    (await getSpendableCreditBalance(client.db, accountId, "openai/gpt-5")).balanceMicros,
  ).toBe(Math.max(0, before.generalBalanceMicros ?? 0));

  expect(await debit(accountId, 30 * M, GEMINI[1])).toMatchObject({
    grantDebitedMicros: 30 * M,
  });
  expect(await debit(accountId, 5 * M, "openai/gpt-5")).toMatchObject({ grantDebitedMicros: 0 });
  const after = await getBillingBalance(client.db, accountId);
  expect(after.promotionalCredits!.find((entry) => entry.grantId === grant.grantId)).toMatchObject({
    remainingMicros: 1_970 * M,
  });
  expect(after.generalBalanceMicros).toBe((before.generalBalanceMicros ?? 0) - 5 * M);
});

test("an ended offer stops counting at once and settles its remainder without touching other credit", async () => {
  if (!client) return;
  await allowRuntimeActivation(true);
  const { accountId, subject } = await account();
  await applyCreditLedgerEntry(client.db, {
    accountId,
    amountMicros: 50 * M,
    type: "manual_credit_grant",
    idempotencyKey: crypto.randomUUID(),
  });
  const offer = await assign(accountId, { amountMicros: 100 * M });
  await activateCreditOffer(client.db, { accountId, offerId: offer.id, subjectId: subject });
  await debit(accountId, 40 * M, GEMINI[0]);
  const live = await getBillingBalance(client.db, accountId);

  await endOffer(offer.id);
  // Lock-free read before settlement: the 60 left is gone, general is intact.
  const pending = await getBillingBalance(client.db, accountId);
  expect(pending.promotionalCredits!.some((entry) => entry.label === offer.label)).toBe(false);
  expect(pending.balanceMicros).toBe(live.balanceMicros - 60 * M);
  expect(pending.generalBalanceMicros).toBe(live.generalBalanceMicros);
  expect((await listCreditOffers(client.db, accountId))[0]!.status).toBe("ended");

  // The next debit settles the expiry under the account lock and pays from general credit.
  expect(await debit(accountId, 10 * M, GEMINI[0])).toMatchObject({ grantDebitedMicros: 0 });
  const expiries = await shared!.admin`select entry.amount_micros::text as amount,
      allocation.amount_micros::text as allocated
    from credit_ledger_entries entry
    join credit_debit_allocations allocation on allocation.debit_entry_id = entry.id
    where entry.account_id = ${accountId} and entry.type = 'credit_offer_expiry'`;
  expect([...expiries]).toEqual([{ amount: String(-60 * M), allocated: String(60 * M) }]);
  const settled = await getBillingBalance(client.db, accountId);
  expect(settled.balanceMicros).toBe(pending.balanceMicros - 10 * M);
  expect(settled.generalBalanceMicros).toBe((pending.generalBalanceMicros ?? 0) - 10 * M);
  const [row] = await shared!.admin`select expired_at is not null as expired from credit_offers
    where id = ${offer.id}`;
  expect(row!.expired).toBe(true);
});

test("expiry never consumes the monthly plan allowance", async () => {
  if (!client) return;
  await allowRuntimeActivation(true);
  const { accountId, subject } = await account();
  const periodStart = new Date(Date.now() - 1000);
  const periodEnd = new Date(Date.now() + 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await upsertOrganizationPlan(client.db, {
    accountId,
    planKey: "pro",
    status: "active",
    stripeSubscriptionId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await grantPlanCreditPeriod(client.db, {
    accountId,
    planKey: "pro",
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  const offer = await assign(accountId, { amountMicros: 70 * M });
  await activateCreditOffer(client.db, { accountId, offerId: offer.id, subjectId: subject });
  const before = await getBillingBalance(client.db, accountId);
  await endOffer(offer.id);
  await debit(accountId, 1, "openai/gpt-5");
  const after = await getBillingBalance(client.db, accountId);
  expect(after.plan!.creditRemainingMicros).toBe(before.plan!.creditRemainingMicros - 1);
  expect(after.creditsMicros).toBe(before.creditsMicros);
  expect(after.balanceMicros).toBe(before.balanceMicros - 70 * M - 1);
});

test("deadlines, withdrawal and other organizations' offers are refused", async () => {
  if (!client) return;
  await allowRuntimeActivation(true);
  const { accountId, subject } = await account();
  const other = await account();

  expect(await sqlState(assign(accountId, { activateBy: new Date(Date.now() - 1000) }))).toBe(
    "22023",
  );
  const late = await assign(accountId, { activateBy: new Date(Date.now() + 60_000) });
  await shared!.admin`update credit_offers set activate_by = clock_timestamp() - interval '1 second'
    where id = ${late.id}`;
  expect(
    await sqlState(
      activateCreditOffer(client.db, { accountId, offerId: late.id, subjectId: subject }),
    ),
  ).toBe("55000");

  const withdrawn = await assign(accountId);
  expect(
    await revokeCreditOffer(owner!.db, {
      accountId,
      offerId: withdrawn.id,
      operator: "test operator",
      reason: "Offer sent in error",
    }),
  ).toMatchObject({ status: "withdrawn" });
  expect(
    await sqlState(
      activateCreditOffer(client.db, { accountId, offerId: withdrawn.id, subjectId: subject }),
    ),
  ).toBe("55000");

  const foreign = await assign(other.accountId);
  expect(
    await sqlState(
      activateCreditOffer(client.db, { accountId, offerId: foreign.id, subjectId: subject }),
    ),
  ).toBe("P0002");
  expect((await listCreditOffers(client.db, accountId)).map((offer) => offer.id)).not.toContain(
    foreign.id,
  );

  const statuses = Object.fromEntries(
    (await listCreditOffers(client.db, accountId)).map((offer) => [offer.id, offer.status]),
  );
  expect(statuses).toEqual({ [late.id]: "lapsed", [withdrawn.id]: "withdrawn" });
});

test("withdrawing an active offer removes what is left now", async () => {
  if (!client) return;
  await allowRuntimeActivation(true);
  const { accountId, subject } = await account();
  const offer = await assign(accountId, { amountMicros: 20 * M });
  await activateCreditOffer(client.db, { accountId, offerId: offer.id, subjectId: subject });
  await debit(accountId, 5 * M, GEMINI[0]);
  const before = await getBillingBalance(client.db, accountId);
  const revoked = await revokeCreditOffer(owner!.db, {
    accountId,
    offerId: offer.id,
    operator: "test operator",
    reason: "Partner left the programme",
  });
  expect(revoked.status).toBe("ended");
  const after = await getBillingBalance(client.db, accountId);
  expect(after.balanceMicros).toBe(before.balanceMicros - 15 * M);
  expect(after.generalBalanceMicros).toBe(before.generalBalanceMicros);
  expect(after.promotionalCredits!.some((entry) => entry.label === offer.label)).toBe(false);
  // Withdrawing again is a no-op.
  await revokeCreditOffer(owner!.db, {
    accountId,
    offerId: offer.id,
    operator: "test operator",
    reason: "Partner left the programme",
  });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(after.balanceMicros);
});

test("operator command validates models, assigns a configurable grant, lists, activates and revokes", async () => {
  if (!client || !shared) return;
  const { accountId } = await account();
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      ["bun", "--no-env-file", "scripts/operator/credit-offers.ts", ...args],
      {
        cwd: new URL("../../../", import.meta.url).pathname,
        env: {
          PATH: process.env.PATH!,
          OPENGENI_DATABASE_ADMIN_URL: shared!.ownerUrl,
          OPENGENI_DATABASE_URL: shared!.appUrl,
          OPENGENI_DB_SCHEMA: shared!.schema,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const audit = ["--operator", "test operator", "--reason", "Design partner programme"];
  const bad = await run([
    "assign",
    "--account",
    accountId,
    "--amount-usd",
    "2000",
    "--models",
    "not-a-real-model",
    "--valid-days",
    "56",
    ...audit,
  ]);
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr).toContain("must be a canonical credit-funded model");

  const assigned = await run([
    "assign",
    "--account",
    accountId,
    "--amount-usd",
    "1250.50",
    "--models",
    "gpt-6-luna",
    "--valid-days",
    "30",
    "--activate-by",
    new Date(Date.now() + 86_400_000).toISOString(),
    "--label",
    "Pilot credits",
    ...audit,
  ]);
  expect(assigned.stderr).toBe("");
  expect(assigned.exitCode).toBe(0);
  const { offer } = JSON.parse(assigned.stdout);
  expect(offer).toMatchObject({
    label: "Pilot credits",
    amountMicros: 1_250_500_000,
    eligibleModelIds: ["gpt-6-luna"],
    validDays: 30,
    status: "available",
  });
  const listed = await run(["list", "--account", accountId]);
  expect(JSON.parse(listed.stdout).map((entry: { id: string }) => entry.id)).toEqual([offer.id]);
  const activated = await run([
    "activate",
    "--account",
    accountId,
    "--offer",
    offer.id,
    "--operator",
    "test operator",
  ]);
  expect(activated.stderr).toBe("");
  expect(JSON.parse(activated.stdout)).toMatchObject({ id: offer.id, status: "active" });
  expect((await getSpendableCreditBalance(client.db, accountId, "gpt-6-luna")).balanceMicros).toBe(
    1_250_500_000,
  );
  const revoked = await run(["revoke", "--account", accountId, "--offer", offer.id, ...audit]);
  expect(revoked.exitCode).toBe(0);
  expect(JSON.parse(revoked.stdout).status).toBe("ended");
}, 180_000);
