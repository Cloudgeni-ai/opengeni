import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyCreditLedgerEntry,
  completeSelfServiceOrganizationSetup,
  createDb,
  freePlanCreditEligible,
  listSubscriptionPlanMaintenanceAccounts,
  maintainSubscriptionPlans,
  recordCardVerification,
  resetCardVerificationGateCache,
  type DbClient,
} from "../src";

// Free credit under the card verification gate (migration 1494): while it is
// on, an organization that never paid gets Free monthly credit only with its
// own verified card, and one card and one person get it for one organization.
// Nothing already granted is touched and the Free amount is unchanged.

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const M = 1_000_000;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase(
    "card-verification-free-credit",
    "card_gate_credit_data",
  );
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

async function setGate(enabled: boolean) {
  await shared!.admin`insert into card_verification_gate_revisions (enabled, changed_by, reason)
    values (${enabled}, 'test', 'card verification credit test')`;
  resetCardVerificationGateCache();
}

/** A self-serve organization with its signup trial receipt (Free-eligible). */
async function organization() {
  const userId = crypto.randomUUID();
  await shared!
    .admin`insert into auth_users(id,name,email,email_verified) values (${userId},'Card owner',${`${userId}@example.test`},true)`;
  const accountId = (
    await completeSelfServiceOrganizationSetup(client!.db, {
      authUserId: userId,
      actorSubjectId: `user:${userId}`,
      organizationName: "Card gate organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "c".repeat(64),
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-a"],
    })
  ).organizationId;
  return { accountId, subjectId: `user:${userId}` };
}

function card(accountId: string, subjectId: string, fingerprint: string) {
  return recordCardVerification(client!.db, {
    accountId,
    subjectId,
    provider: "stripe:test",
    customerId: "cus_test",
    paymentMethodId: `pm_${crypto.randomUUID()}`,
    setupIntentId: `seti_${crypto.randomUUID()}`,
    fingerprint,
    brand: "visa",
    last4: "4242",
  });
}

async function freeReceipts(accountId: string) {
  return await shared!.admin<{ granted_micros: string }[]>`
    select granted_micros from plan_credit_periods where account_id = ${accountId}`;
}

test("while the gate is on, Free credit needs the organization's own unclaimed verified card", async () => {
  if (!shared || !client) return;
  await setGate(true);
  const first = await organization();
  expect(await freePlanCreditEligible(client.db, first.accountId)).toBe(false);
  // Enrolled on Free, without credit, and then no longer listed.
  expect((await maintainSubscriptionPlans(client.db)).failedAccounts).toBe(0);
  expect(await freeReceipts(first.accountId)).toHaveLength(0);
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).not.toContain(first.accountId);

  const fingerprint = `fp_${crypto.randomUUID()}`;
  await card(first.accountId, first.subjectId, fingerprint);
  expect(await listSubscriptionPlanMaintenanceAccounts(client.db)).toContain(first.accountId);
  expect((await maintainSubscriptionPlans(client.db)).failedAccounts).toBe(0);
  const receipts = await freeReceipts(first.accountId);
  expect(receipts).toHaveLength(1);
  // The Free amount is unchanged.
  expect(Number(receipts[0]!.granted_micros)).toBe(10 * M);
  expect(await freePlanCreditEligible(client.db, first.accountId)).toBe(true);

  // The same card in another person's organization gets no Free credit.
  const sameCard = await organization();
  await card(sameCard.accountId, sameCard.subjectId, fingerprint);
  expect(await freePlanCreditEligible(client.db, sameCard.accountId)).toBe(false);
  // Nor does another organization of the same person, with another card.
  const samePerson = await organization();
  await card(samePerson.accountId, first.subjectId, `fp_${crypto.randomUUID()}`);
  expect(await freePlanCreditEligible(client.db, samePerson.accountId)).toBe(false);
  expect((await maintainSubscriptionPlans(client.db)).failedAccounts).toBe(0);
  expect(await freeReceipts(sameCard.accountId)).toHaveLength(0);
  expect(await freeReceipts(samePerson.accountId)).toHaveLength(0);
  // The first organization keeps its claim.
  expect(await freePlanCreditEligible(client.db, first.accountId)).toBe(true);
}, 180_000);

test("an organization that bought credit, or any organization while the gate is off, is unaffected", async () => {
  if (!shared || !client) return;
  await setGate(true);
  const buyer = await organization();
  await applyCreditLedgerEntry(client.db, {
    accountId: buyer.accountId,
    type: "credit_topup",
    amountMicros: 5 * M,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(await freePlanCreditEligible(client.db, buyer.accountId)).toBe(true);

  const unverified = await organization();
  expect(await freePlanCreditEligible(client.db, unverified.accountId)).toBe(false);
  await setGate(false);
  expect(await freePlanCreditEligible(client.db, unverified.accountId)).toBe(true);
  expect((await maintainSubscriptionPlans(client.db)).failedAccounts).toBe(0);
  expect(await freeReceipts(unverified.accountId)).toHaveLength(1);
}, 180_000);
