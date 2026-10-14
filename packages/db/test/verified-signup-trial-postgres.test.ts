import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";

import {
  applyCreditDebitAfterUse,
  applyCreditDebitUpToBalance,
  applyCreditLedgerEntry,
  applyCreditLedgerEntryOnce,
  completeSelfServiceOrganizationSetup,
  createManagedOrganization,
  createDb,
  getBillingBalance,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function setup(enabled: boolean, trialCreditModelIds?: string[]) {
  if (!owned || !client) throw new Error("test database unavailable");
  const authUserId = crypto.randomUUID();
  await owned.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${authUserId}, 'Trial owner', ${`${authUserId}@example.test`}, true)`;
  const command = {
    authUserId,
    actorSubjectId: `user:${authUserId}`,
    organizationName: "Trial organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
  };
  const result = await completeSelfServiceOrganizationSetup(client.db, {
    ...command,
    trialCreditsEnabled: enabled,
    trialCreditModelIds,
  });
  return { authUserId, command, result };
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("verified-signup-trial");
  if (!owned) {
    if (requireRealDatabase) throw new Error("trial PostgreSQL fixture is unavailable");
    return;
  }
  await migrate(owned.ownerUrl);
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });
  const url = new URL(owned.ownerUrl);
  url.username = "opengeni_app";
  url.password = owned.appPassword;
  client = createDb(url.toString(), { max: 4, rlsStrategy: "force" });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await owned?.release();
}, 180_000);

describe("verified signup trial and post-use credit settlement", () => {
  test("new signup records initial eligibility; replay cannot rewrite the grant", async () => {
    if (!owned || !client) return;
    const { command, result } = await setup(true, ["model-a"]);
    const before = await getBillingBalance(client.db, result.organizationId);
    expect(before.generalBalanceMicros).toBe(0);
    expect(before.promotionalCredits?.[0]?.eligibleModelIds).toEqual(["model-a"]);
    await completeSelfServiceOrganizationSetup(client.db, {
      ...command,
      trialCreditsEnabled: true,
      trialCreditModelIds: ["model-b"],
    });
    const after = await getBillingBalance(client.db, result.organizationId);
    expect(after.promotionalCredits).toEqual(before.promotionalCredits);
    expect(after.balanceMicros).toBe(10_000_000);
  }, 180_000);
  test("model debits report the trial-funded share and ledger inserts report replays", async () => {
    if (!owned || !client) return;
    const { result } = await setup(true, ["model-a"]);
    const accountId = result.organizationId;
    const topup = {
      accountId,
      type: "credit_topup",
      amountMicros: 5_000_000,
      idempotencyKey: `test-topup:${crypto.randomUUID()}`,
    };
    expect((await applyCreditLedgerEntryOnce(client.db, topup)).inserted).toBe(true);
    const replayedTopup = await applyCreditLedgerEntryOnce(client.db, topup);
    expect(replayedTopup.inserted).toBe(false);
    expect(replayedTopup.balance.balanceMicros).toBe(15_000_000);

    const debit = {
      accountId,
      type: "model_usage_debit",
      requestedAmountMicros: 12_000_000,
      modelId: "model-a",
      sourceType: "model_response",
      sourceId: "turn:response-1",
      idempotencyKey: `credit:model_usage_debit:${crypto.randomUUID()}`,
    };
    const first = await applyCreditDebitUpToBalance(client.db, debit);
    expect(first.debitedMicros).toBe(12_000_000);
    expect(first.grantDebitedMicros).toBe(10_000_000);
    const replay = await applyCreditDebitUpToBalance(client.db, debit);
    expect(replay).toMatchObject({ debitedMicros: 0, grantDebitedMicros: 0 });

    // A model the trial does not cover is paid from general credit only.
    const general = await applyCreditDebitUpToBalance(client.db, {
      ...debit,
      modelId: "model-b",
      requestedAmountMicros: 1_000_000,
      idempotencyKey: `credit:model_usage_debit:${crypto.randomUUID()}`,
    });
    expect(general).toMatchObject({ debitedMicros: 1_000_000, grantDebitedMicros: 0 });
  }, 180_000);

  test("launch flag and one-shot receipt trigger are the only grant authority", () => {
    const migration = readFileSync(
      new URL("../drizzle/0509_verified_signup_trial_credits.sql", import.meta.url),
      "utf8",
    );
    expect(migration.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(migration).toContain("IS DISTINCT FROM 'on'");
    expect(migration).toContain("AFTER INSERT ON self_service_organization_setup_receipts");
    expect(migration).toContain("'verified-signup-trial:v1:' || NEW.auth_user_id");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.grant_verified_signup_trial_credit() FROM PUBLIC",
    );
  });

  test("rejects an unverified user without creating an organization or trial ledger entry", async () => {
    if (!owned || !client) return;
    const authUserId = crypto.randomUUID();
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${authUserId}, 'Pending email', ${`${authUserId}@example.test`}, false)`;
    await expect(
      completeSelfServiceOrganizationSetup(client.db, {
        authUserId,
        actorSubjectId: `user:${authUserId}`,
        organizationName: "Pending organization",
        operationId: crypto.randomUUID(),
        requestFingerprint: "b".repeat(64),
        trialCreditsEnabled: true,
      }),
    ).rejects.toBeDefined();
    const [count] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from credit_ledger_entries
      where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
    expect(count?.count).toBe(0);
  });

  test("defaults off, and an existing setup cannot get a grant on replay after enablement", async () => {
    if (!owned || !client) return;
    const { authUserId, command, result } = await setup(false);
    expect((await getBillingBalance(client.db, result.organizationId)).balanceMicros).toBe(0);
    expect(
      await completeSelfServiceOrganizationSetup(client.db, {
        ...command,
        trialCreditsEnabled: true,
      }),
    ).toEqual(result);
    const [count] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from credit_ledger_entries
      where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
    expect(count?.count).toBe(0);
  });

  test("grants once to the canonical verified signup, and post-use charges net future top-ups", async () => {
    if (!owned || !client) return;
    const { authUserId, command, result } = await setup(true);
    const accountId = result.organizationId;
    expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(10_000_000);
    await completeSelfServiceOrganizationSetup(client.db, {
      ...command,
      trialCreditsEnabled: true,
    });
    const [grants] = await owned.admin<Array<{ count: number; total: number }>>`
      select count(*)::int as count, sum(amount_micros)::bigint as total
      from credit_ledger_entries
      where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
    expect(grants?.count).toBe(1);
    expect(Number(grants?.total)).toBe(10_000_000);

    const debit = {
      accountId,
      type: "sandbox_warm_debit",
      amountMicros: 12_000_000,
      sourceType: "sandbox_warm_meter",
      sourceId: "test-tick-1",
      idempotencyKey: `sandbox-warm-tick:${crypto.randomUUID()}`,
    };
    const first = await applyCreditDebitAfterUse(client.db, debit);
    expect(first.debitedMicros).toBe(12_000_000);
    expect(first.balance.balanceMicros).toBe(-2_000_000);
    const retry = await applyCreditDebitAfterUse(client.db, debit);
    expect(retry.debitedMicros).toBe(0);
    expect(retry.balance.balanceMicros).toBe(-2_000_000);
    expect(
      applyCreditDebitAfterUse(client.db, { ...debit, amountMicros: 12_000_001 }),
    ).rejects.toThrow("idempotency key conflicts");

    const toppedUp = await applyCreditLedgerEntry(client.db, {
      accountId,
      type: "test_topup",
      amountMicros: 5_000_000,
      idempotencyKey: `test-topup:${crypto.randomUUID()}`,
    });
    expect(toppedUp.balanceMicros).toBe(3_000_000);
  });

  test("serializes concurrent setup retries into one grant", async () => {
    if (!owned || !client) return;
    const authUserId = crypto.randomUUID();
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${authUserId}, 'Race owner', ${`${authUserId}@example.test`}, true)`;
    const command = {
      authUserId,
      actorSubjectId: `user:${authUserId}`,
      organizationName: "Race organization",
      operationId: crypto.randomUUID(),
      requestFingerprint: "c".repeat(64),
      trialCreditsEnabled: true,
    };
    const [first, second] = await Promise.all([
      completeSelfServiceOrganizationSetup(client.db, command),
      completeSelfServiceOrganizationSetup(client.db, command),
    ]);
    expect(first).toEqual(second);
    const [grants] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from credit_ledger_entries
      where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
    expect(grants?.count).toBe(1);
  });

  test("legacy first-organization endpoint uses the same one-time verified grant gate", async () => {
    if (!owned || !client) return;
    const authUserId = crypto.randomUUID();
    await owned.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${authUserId}, 'Legacy signup', ${`${authUserId}@example.test`}, true)`;
    const command = {
      subjectId: `user:${authUserId}`,
      subjectLabel: "Legacy signup",
      name: "Legacy signup organization",
      operationId: crypto.randomUUID(),
      trialCreditsEnabled: true,
    };
    const first = await createManagedOrganization(client.db, command);
    expect((await getBillingBalance(client.db, first.organization.id)).balanceMicros).toBe(
      10_000_000,
    );
    expect(await createManagedOrganization(client.db, command)).toEqual(first);
    const [grants] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count from credit_ledger_entries
      where source_type = 'verified_signup_trial' and source_id = ${authUserId}`;
    expect(grants?.count).toBe(1);
  });
});

test("runtime policy scopes new signups and updates their current coverage", async () => {
  if (!owned || !client) return;
  await owned.admin`select set_credit_promotion_policy(${owned.admin.json({ defaultModelIds: ["model-a"] })}::jsonb, 'test operator', 'Enable shared model list')`;
  const { result } = await setup(true);
  expect(
    (await getBillingBalance(client.db, result.organizationId)).promotionalCredits?.[0]
      ?.eligibleModelIds,
  ).toEqual(["model-a"]);
  await owned.admin`select set_credit_promotion_policy(${owned.admin.json({ defaultModelIds: ["model-b"], signupModelIds: ["model-c"] })}::jsonb, 'test operator', 'Change signup model list')`;
  expect(
    (await getBillingBalance(client.db, result.organizationId)).promotionalCredits?.[0]
      ?.eligibleModelIds,
  ).toEqual(["model-c"]);
  const next = await setup(true, ["old-deployment-default"]);
  expect(
    (await getBillingBalance(client.db, next.result.organizationId)).promotionalCredits?.[0]
      ?.eligibleModelIds,
  ).toEqual(["model-c"]);
}, 180_000);
