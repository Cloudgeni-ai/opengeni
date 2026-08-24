import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0336-tenancy-backfill-evidence");
  if (!shared && requireRealDatabase) throw new Error("migration 0336 requires PostgreSQL");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0336 tenancy backfill activation evidence", () => {
  test("is rolling, preserves the activation signature, and binds five receipt ids", async () => {
    const source = await readFile(
      new URL("../drizzle/0336_tenancy_backfill_activation_evidence.sql", import.meta.url),
      "utf8",
    );
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const reason of [
      "missing_login_identity",
      "organization_identity_mismatch",
      "missing_owner_workspace_membership",
      "membership_terminal_status",
    ]) {
      expect(source).toContain(`'${reason}'`);
    }
    expect(source).toContain("cardinality(backfill_receipt_ids) IN (0, 5)");
    expect(source).toContain("check_tenancy_backfill_activation_evidence(uuid)");
    expect(source).toContain("activate_session_tenancy_product(uuid, text, text, text, text[])");
    expect(source).toContain("tenancy_backfill_receipts, tenancy_backfill_unresolved_rows,");
    expect(source).not.toContain(
      "GRANT EXECUTE ON FUNCTION check_tenancy_backfill_activation_evidence",
    );
  });

  test("keeps the evidence projection owner-only and fails closed without receipts", async () => {
    if (!shared) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('0332 evidence') returning id`;
    const [acl] = await shared.admin<{ executable: boolean }[]>`
      select has_function_privilege(
        'opengeni_app', 'check_tenancy_backfill_activation_evidence(uuid)', 'EXECUTE'
      ) as executable`;
    expect(acl?.executable).toBe(false);

    const [report] = await shared.admin.begin(async (transaction) => {
      await transaction`select set_config('opengeni.account_id', ${account!.id}, true)`;
      return await transaction<{ evidence: Record<string, unknown> }[]>`
        select check_tenancy_backfill_activation_evidence(${account!.id}::uuid) as evidence`;
    });
    const evidence = report?.evidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      organizationId: account!.id,
      ready: false,
      receiptIds: [],
    });
    const blockers = evidence?.blockers;
    expect(Array.isArray(blockers) ? blockers.length : 0).toBe(5);
  }, 180_000);
});
