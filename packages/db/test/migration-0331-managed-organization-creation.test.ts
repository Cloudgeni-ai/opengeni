import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDb, createManagedOrganization, type DbClient } from "../src";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const migration = readFileSync(
  new URL("../drizzle/0331_managed_organization_creation.sql", import.meta.url),
  "utf8",
);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0331-managed-organization-creation");
  if (shared) client = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("migration 0331 managed organization creation", () => {
  test("pins the SECURITY DEFINER search path to pg_catalog, the target schema, then pg_temp", () => {
    expect(migration).toContain(
      "ALTER FUNCTION %I.create_managed_organization(text,text,text,uuid) SET search_path = pg_catalog, %I, pg_temp",
    );
    expect(migration).toContain("managed-organization-creation:");
    expect(migration.indexOf("ALTER FUNCTION %I.create_managed_organization")).toBeLessThan(
      migration.indexOf("GRANT EXECUTE ON FUNCTION %I.create_managed_organization"),
    );
  });

  test("ignores a pg_temp auth_users shadow when resolving the authenticated user", async () => {
    if (!shared || !client) return;
    const userId = `managed-org-shadow-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    let organizationId = "";
    await shared.admin`
      insert into auth_users (id, name, email, email_verified)
      values (${userId}, 'Shadow-safe owner', ${`${userId}@example.test`}, true)`;
    try {
      await client.db.execute(sql`create temporary table auth_users (id text primary key)`);
      const created = await createManagedOrganization(client.db, {
        subjectId,
        subjectLabel: "Shadow-safe owner",
        name: "Shadow-safe organization",
        operationId: crypto.randomUUID(),
      });
      organizationId = created.organization.id;
      expect(created.organization.name).toBe("Shadow-safe organization");
    } finally {
      if (organizationId) {
        await shared.admin`
          delete from self_service_organization_setup_receipts
          where account_id = ${organizationId}`;
        await shared.admin`delete from managed_accounts where id = ${organizationId}`;
      }
      await shared.admin`delete from auth_users where id = ${userId}`;
    }
  }, 180_000);
});
