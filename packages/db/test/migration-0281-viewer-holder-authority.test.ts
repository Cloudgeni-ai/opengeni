// Migration 0281: viewer lease holders record the authenticated viewer
// subject and the session authority epoch observed at attach, so stream-token
// authority can be audited and revocation-swept. The live recording behavior
// (record, coalesce, monotone raise, CHECK rejection) is exercised in
// sandbox-leases.test.ts "(0281)"; this file pins the migration contract.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const migrationUrl = new URL("../drizzle/0281_viewer_holder_authority_claims.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0281-viewer-holder-authority");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
});

afterAll(async () => {
  await shared?.release();
});

describe("migration 0281 viewer holder authority claims", () => {
  test("declares one rolling two-column protocol with a guarded validated check", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(source).toContain('"viewer_subject_id" text');
    expect(source).toContain('"viewer_authority_epoch" integer');
    // The claims are nullable identities/epochs: no FK may block holder
    // reaping or membership lifecycle, and no default backfills fake authority.
    expect(source).not.toContain("REFERENCES");
    expect(source).not.toMatch(/\bDEFAULT\b/iu);
    expect(source).not.toMatch(/\bNOT NULL\b/u);
    // Guarded add + full validation (the rolling re-apply window).
    expect(source).toContain("conrelid = 'sandbox_lease_holders'::regclass");
    expect(source).toContain("NOT VALID");
    expect(source).toContain('VALIDATE CONSTRAINT "sandbox_lease_holders_viewer_authority_check"');
    expect(source).not.toMatch(/\bDROP\b/u);
  });

  test("re-applying the migration is a no-op (rolling window replay)", async () => {
    if (!available) return;
    const source = await readFile(migrationUrl, "utf8");
    // The shared database has already applied 0281 once; a second apply must
    // succeed without duplicating the constraint or failing on the columns.
    await admin.begin(async (tx) => {
      await tx.unsafe(source);
    });
    const constraints = await admin<Array<{ count: number }>>`
      select count(*)::int as count from pg_constraint
      where conname = 'sandbox_lease_holders_viewer_authority_check'
        and conrelid = 'sandbox_lease_holders'::regclass`;
    expect(constraints[0]?.count).toBe(1);
    const validated = await admin<Array<{ convalidated: boolean }>>`
      select convalidated from pg_constraint
      where conname = 'sandbox_lease_holders_viewer_authority_check'
        and conrelid = 'sandbox_lease_holders'::regclass`;
    expect(validated[0]?.convalidated).toBe(true);
  });
});
