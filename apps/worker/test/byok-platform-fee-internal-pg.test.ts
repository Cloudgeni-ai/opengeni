import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_BILLING_LEGACY_ACCOUNT_IDS,
  withOrganizationAzureOpenAICredential,
} from "@opengeni/config";
import { BYOK_PAID_CREDIT_REQUIRED_CODE } from "@opengeni/contracts";
import { admitModelCall, checkLimit } from "@opengeni/core";
import * as opengeniDb from "@opengeni/db";
import { applyCreditLedgerEntry, bootstrapWorkspace, createDb, type DbClient } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { recordModelUsageAndDebitCredits } from "../src/activities/agent-turn";
import { ensureRunAllowedBetweenModelCalls } from "../src/activities/agent-turn/admission";

// Real PostgreSQL: our own team's organizations are internal accounts, listed
// by default like CloudGeni's, so their heavy use of the team's own
// subscriptions and keys never pays the own-key platform fee or meets its
// paid-credit refusal. Any other account still does.
const INTERNAL = "67435f59-7f73-4996-8845-cd7baa2b7268"; // production "Cloudgeni Internal"
const OWN_KEY_MODEL = "organization-azure-openai/gpt-6.1-sol";
const SUBSCRIPTION_MODEL = "gpt-6-luna"; // served on the person's own subscription
const M = 1_000_000;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-byok-fee-internal");
  if (!shared && process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
    throw new Error("PostgreSQL required");
  }
  if (shared) client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** Billing on, a 5% fee, the built-in internal list, and an own Azure key. */
const settings = withOrganizationAzureOpenAICredential(
  testSettings({
    billingMode: "stripe",
    usageLimitsMode: "managed",
    byokPlatformFeeBps: 500,
    billingLegacyAccountIds: [...DEFAULT_BILLING_LEGACY_ACCOUNT_IDS],
  }),
  "azure-org-key",
  {
    endpoint: "https://contoso.openai.azure.com/openai/v1",
    models: [{ upstreamModelId: "gpt-6.1-sol" }],
  },
);

async function workspace(externalId: string) {
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test:byok-fee-internal",
    accountExternalId: externalId,
    accountName: externalId,
    workspaceExternalSource: "test:byok-fee-internal",
    workspaceExternalId: externalId,
    workspaceName: externalId,
    subjectId: `user:${externalId}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId };
}

/** Each own-key admission path, with no paid credit on the account. */
async function admissions(ids: { accountId: string; workspaceId: string }) {
  const services = { db: client!.db, settings, entitlements: null };
  const run = await checkLimit(services, {
    ...ids,
    action: "agent_run:create",
    model: OWN_KEY_MODEL,
    requestedAgentRuns: 1,
  });
  const call = await admitModelCall(services, {
    ...ids,
    chargesOpenGeniCredits: false,
    countsTowardTokenCap: false,
    subjectId: null,
    billingOrigin: "api",
    byok: true,
  });
  let between: unknown = null;
  try {
    await ensureRunAllowedBetweenModelCalls({
      ...services,
      ...ids,
      modelId: SUBSCRIPTION_MODEL,
      isExternallyBilledTurn: true,
      chargesOpenGeniCredits: false,
      countsTowardTokenCap: false,
      initiatingHumanSubjectId: null,
      billingOrigin: "app",
      byok: true,
    });
  } catch (error) {
    between = error;
  }
  return { run, call, between };
}

/** One response on the account's own key and one on its own subscription. */
async function settleOwnKeyResponses(ids: { accountId: string; workspaceId: string }) {
  const turnId = crypto.randomUUID();
  // The usage event needs a real chat; the fee debit and balances stay real.
  const recorded = spyOn(opengeniDb, "recordUsageEvent").mockResolvedValue(undefined as never);
  try {
    for (const [model, sourceKey] of [
      [OWN_KEY_MODEL, "own-key"],
      [SUBSCRIPTION_MODEL, "subscription"],
    ] as const) {
      await recordModelUsageAndDebitCredits(settings, client!.db, {
        ...ids,
        sessionId: crypto.randomUUID(),
        turnId,
        turnAttemptId: crypto.randomUUID(),
        model,
        externallyBilled: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: false,
        byok: true,
        usage: { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
        sourceKey,
      });
    }
  } finally {
    recorded.mockRestore();
  }
  return await shared!.admin<{ amountMicros: string }[]>`
    select amount_micros::text as "amountMicros" from credit_ledger_entries
    where account_id = ${ids.accountId}::uuid and type = 'byok_platform_fee'`;
}

test("our team's internal organization pays no own-key fee and is never refused without paid credit; a normal account is", async () => {
  if (!client || !shared) return;
  await shared.admin`
    insert into managed_accounts (id, name, external_source, external_id)
    values (${INTERNAL}::uuid, 'Cloudgeni Internal', 'test:byok-fee-internal', 'team')
    on conflict do nothing`;
  const internal = await workspace("team");
  expect(internal.accountId).toBe(INTERNAL);
  const normal = await workspace(crypto.randomUUID());

  // No paid credit at all: the internal account is admitted on every path.
  const inside = await admissions(internal);
  expect(inside.run.allowed).toBe(true);
  expect(inside.call.allowed).toBe(true);
  expect(inside.between).toBeNull();
  // The normal account is refused with byok_paid_credit_required.
  const outside = await admissions(normal);
  expect(outside.run).toMatchObject({ allowed: false, code: BYOK_PAID_CREDIT_REQUIRED_CODE });
  expect(outside.call).toMatchObject({ allowed: false, byokPaidCreditRequired: true });
  expect(String(outside.between)).toContain("Add credits to use your own key");

  // Settling own-key and subscription responses: no fee for the internal
  // account even with no credit; the normal account pays it from paid credit.
  expect(await settleOwnKeyResponses(internal)).toEqual([]);
  await applyCreditLedgerEntry(client.db, {
    accountId: normal.accountId,
    type: "credit_topup",
    amountMicros: 5 * M,
    idempotencyKey: crypto.randomUUID(),
  });
  const fees = await settleOwnKeyResponses(normal);
  expect(fees).toHaveLength(2);
  for (const fee of fees) expect(Number(fee.amountMicros)).toBeLessThan(0);
}, 180_000);
