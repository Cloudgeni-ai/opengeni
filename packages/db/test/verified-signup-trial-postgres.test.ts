import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFileSync } from "node:fs";

import {
  applyCreditDebitAfterUse,
  applyCreditLedgerEntry,
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

async function setup(enabled: boolean) {
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
