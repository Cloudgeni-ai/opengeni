// Migration 0286: the tenancy backfill receipt and unresolved-row ledger.
// Phase D requires backfill to "record backfill receipts and unresolved rows
// without widening access" - so the ledger must be write-reachable ONLY through
// its lifecycle seam, must be append-only for unresolved evidence, and must be
// structurally incapable of carrying a proposed authority.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, migrate, type Database, type DbClient } from "../src";

const migrationUrl = new URL("../drizzle/0286_tenancy_backfill_ledger.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0286-tenancy-backfill-ledger");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

// postgres.js query objects are thenables rather than real Promises, and
// bun's `expect(...).rejects` hangs on them instead of settling. Await
// explicitly and assert on the captured error.
async function expectRejection(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let captured: unknown;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeDefined();
  expect(String((captured as Error)?.message ?? captured)).toMatch(pattern);
}

async function seedOrganization(label: string): Promise<string> {
  const rows = await admin<{ id: string }[]>`
    INSERT INTO managed_accounts (name) VALUES (${`ledger-${label}`}) RETURNING id
  `;
  return rows[0]!.id;
}

describe("migration 0286 tenancy backfill ledger", () => {
  test("declares a rolling lifecycle-only ledger that cannot carry proposed authority", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: rolling");

    // Both tables are FORCE RLS and gated by the existing 0263 lifecycle GUC
    // under one new, explicitly named operation.
    for (const table of ["tenancy_backfill_receipts", "tenancy_backfill_unresolved_rows"]) {
      expect(source).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(source).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(source).toContain(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC`);
      expect(source).toContain(`REVOKE ALL ON TABLE "${table}" FROM opengeni_app`);
    }
    expect(source).toContain("'tenancy_backfill_ledger'");

    // The append seam takes receipt/resource/reason ONLY. If it ever grew an
    // owner/subject/authority argument, this ledger would become a channel for
    // exactly the inference phase D forbids.
    const appendSignature = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION record_tenancy_backfill_unresolved("),
      source.indexOf(") RETURNS void", source.indexOf("record_tenancy_backfill_unresolved(")),
    );
    for (const forbidden of [
      "subject",
      "owner",
      "authority",
      "membership",
      "workspace",
      "created_by",
    ]) {
      expect(appendSignature.toLowerCase()).not.toContain(forbidden);
    }

    // Only the lifecycle functions are executable by the application role.
    for (const fn of [
      "open_tenancy_backfill_receipt(uuid,text,text)",
      "record_tenancy_backfill_unresolved(uuid,uuid,text)",
      "complete_tenancy_backfill_receipt(uuid,bigint,bigint,text)",
    ]) {
      expect(source).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      expect(source).toContain(`GRANT EXECUTE ON FUNCTION ${fn}`);
    }
  }, 180_000);

  test("the unresolved-row table has no column able to express an owner or authority", async () => {
    if (!available) return;
    const columns = await admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tenancy_backfill_unresolved_rows'
    `;
    const names = columns.map((row) => row.column_name).sort();
    // Exact column set. This is deliberately a whole-set assertion rather than
    // a "does not contain" check: a later slice adding an owner_subject_id
    // column would silently defeat the guarantee, and must be forced to come
    // back through this test and justify it.
    expect(names).toEqual([
      "account_id",
      "id",
      "observed_at",
      "reason_code",
      "receipt_id",
      "resource_family",
      "resource_id",
    ]);
  }, 180_000);

  test("opengeni_app holds no direct DML on either ledger table", async () => {
    if (!available) return;
    for (const table of ["tenancy_backfill_receipts", "tenancy_backfill_unresolved_rows"]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
        const [row] = await admin<{ granted: boolean }[]>`
          SELECT has_table_privilege('opengeni_app', ${table}, ${privilege}) AS granted
        `;
        expect({ table, privilege, granted: row!.granted }).toEqual({
          table,
          privilege,
          granted: false,
        });
      }
    }
  }, 180_000);

  test("a receipt opens idempotently and counts unresolved rows exactly once", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("idempotent");

    const [opened] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, 'sessions', 'run-a')
    `;
    const receiptId = opened!.open_tenancy_backfill_receipt;

    // Re-opening the same run adopts the same receipt rather than forking one.
    const [reopened] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, 'sessions', 'run-a')
    `;
    expect(reopened!.open_tenancy_backfill_receipt).toBe(receiptId);

    const resourceId = Bun.randomUUIDv7();
    await admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${resourceId}, 'no_deterministic_evidence')`;
    // A resumed sweep re-observing the same row must not inflate the count.
    await admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${resourceId}, 'no_deterministic_evidence')`;

    const [receipt] = await admin<{ unresolved_count: string; status: string }[]>`
      SELECT unresolved_count, status FROM tenancy_backfill_receipts WHERE id = ${receiptId}
    `;
    expect(Number(receipt!.unresolved_count)).toBe(1);
    expect(receipt!.status).toBe("open");

    const rows = await admin<{ count: string }[]>`
      SELECT count(*) AS count FROM tenancy_backfill_unresolved_rows WHERE receipt_id = ${receiptId}
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  }, 180_000);

  test("unresolved evidence is append-only and a settled receipt refuses new work", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("append-only");
    const [opened] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, 'rigs', 'run-b')
    `;
    const receiptId = opened!.open_tenancy_backfill_receipt;
    const resourceId = Bun.randomUUIDv7();
    await admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${resourceId}, 'ambiguous_candidate_authority')`;

    await expectRejection(() => admin`
        UPDATE tenancy_backfill_unresolved_rows SET reason_code = 'legacy_shape_unrecognized'
        WHERE receipt_id = ${receiptId}
      `, /immutable/u);
    await expectRejection(() => admin`DELETE FROM tenancy_backfill_unresolved_rows WHERE receipt_id = ${receiptId}`, /append-only/u);

    await admin`SELECT complete_tenancy_backfill_receipt(${receiptId}, 5, 2, 'completed')`;
    const [settled] = await admin<
      { status: string; classified_count: string; completed_at: Date | null }[]
    >`
      SELECT status, classified_count, completed_at
      FROM tenancy_backfill_receipts WHERE id = ${receiptId}
    `;
    expect(settled!.status).toBe("completed");
    expect(Number(settled!.classified_count)).toBe(5);
    expect(settled!.completed_at).not.toBeNull();

    // A settled receipt is evidence: it can neither absorb new unresolved
    // rows nor be re-opened nor be settled twice.
    await expectRejection(() => admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${Bun.randomUUIDv7()}, 'no_deterministic_evidence')`, /already settled/u);
    await expectRejection(() => admin`SELECT complete_tenancy_backfill_receipt(${receiptId}, 1, 1, 'completed')`, /already settled/u);
    await expectRejection(() => admin`SELECT open_tenancy_backfill_receipt(${organizationId}, 'rigs', 'run-b')`, /already settled/u);
  }, 180_000);

  test("the caller cannot understate its own outstanding obligations", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("obligations");
    const [opened] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, 'documents', 'run-c')
    `;
    const receiptId = opened!.open_tenancy_backfill_receipt;
    await admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${Bun.randomUUIDv7()}, 'external_lane_owns_row')`;
    await admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${Bun.randomUUIDv7()}, 'external_lane_owns_row')`;

    // completion takes classified/skipped only - unresolved_count is owned by
    // the append path, so settling cannot zero it out.
    await admin`SELECT complete_tenancy_backfill_receipt(${receiptId}, 0, 0, 'completed')`;
    const [receipt] = await admin<{ unresolved_count: string }[]>`
      SELECT unresolved_count FROM tenancy_backfill_receipts WHERE id = ${receiptId}
    `;
    expect(Number(receipt!.unresolved_count)).toBe(2);
  }, 180_000);

  test("invalid families, reasons, statuses, and null arguments fail closed", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("fail-closed");

    await expectRejection(() => admin`SELECT open_tenancy_backfill_receipt(NULL, 'sessions', 'run-d')`, /.*/u);
    await expectRejection(() => admin`SELECT open_tenancy_backfill_receipt(${organizationId}, 'not_a_family', 'run-d')`, /.*/u);

    const [opened] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, 'sessions', 'run-d')
    `;
    const receiptId = opened!.open_tenancy_backfill_receipt;
    await expectRejection(() => admin`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${Bun.randomUUIDv7()}, 'invented_reason')`, /.*/u);
    await expectRejection(() => admin`SELECT complete_tenancy_backfill_receipt(${receiptId}, 1, 1, 'half_done')`, /completed or failed/u);
    await expectRejection(() => admin`SELECT complete_tenancy_backfill_receipt(${receiptId}, -1, 0, 'completed')`, /non-negative/u);
    await expectRejection(() => admin`SELECT record_tenancy_backfill_unresolved(${Bun.randomUUIDv7()}, ${Bun.randomUUIDv7()}, 'no_deterministic_evidence')`, /does not exist/u);
  }, 180_000);

  test("the ledger is organization-scoped and one run key does not collide across organizations", async () => {
    if (!available) return;
    const first = await seedOrganization("org-one");
    const second = await seedOrganization("org-two");
    const [a] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${first}, 'machines', 'shared-run-key')
    `;
    const [b] = await admin<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${second}, 'machines', 'shared-run-key')
    `;
    expect(a!.open_tenancy_backfill_receipt).not.toBe(b!.open_tenancy_backfill_receipt);

    const rows = await admin<{ account_id: string }[]>`
      SELECT account_id FROM tenancy_backfill_receipts
      WHERE run_key = 'shared-run-key' ORDER BY account_id
    `;
    expect(new Set(rows.map((row) => row.account_id))).toEqual(new Set([first, second]));
  }, 180_000);

  test("the lifecycle seam is executable by opengeni_app under migrate() ALONE", async () => {
    // Mirrors the 0285 regression: acquireBlankTestDatabase + migrate() never
    // runs provisionRoles' blanket schema-wide EXECUTE sweep, so the
    // migration's own explicit grants must be sufficient on their own.
    const blank = await acquireBlankTestDatabase("migration-0286-no-provision-roles");
    if (!blank) return;
    try {
      await migrate(blank.databaseUrl);
      const probe = postgres(blank.databaseUrl, { max: 1 });
      try {
        for (const signature of [
          "open_tenancy_backfill_receipt(uuid,text,text)",
          "record_tenancy_backfill_unresolved(uuid,uuid,text)",
          "complete_tenancy_backfill_receipt(uuid,bigint,bigint,text)",
        ]) {
          const [row] = await probe<{ granted: boolean }[]>`
            SELECT has_function_privilege('opengeni_app', ${signature}, 'EXECUTE') AS granted
          `;
          expect({ signature, granted: row!.granted }).toEqual({ signature, granted: true });
        }
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await blank.release();
    }
  }, 300_000);
});
