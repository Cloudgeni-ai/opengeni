// Migration 0289: the tenancy backfill receipt and unresolved-row ledger.
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
import { createDb, migrate, type DbClient } from "../src";

const migrationUrl = new URL("../drizzle/0289_tenancy_backfill_ledger.sql", import.meta.url);

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0289-tenancy-backfill-ledger");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

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

// Every lifecycle seam is tenant-fenced on `opengeni.account_id`, so calls must
// carry the organization context the same way real callers do (withRlsContext).
// Deliberately one transaction per call so idempotency is proven ACROSS
// transactions rather than inside a single uncommitted one.
async function asOrg<T>(
  organizationId: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id', ${organizationId}, true)`;
    return run(tx as postgres.TransactionSql);
  })) as T;
}

async function openReceipt(
  organizationId: string,
  resourceFamily: string,
  runKey: string,
): Promise<string> {
  return asOrg(organizationId, async (tx) => {
    const [row] = await tx<{ open_tenancy_backfill_receipt: string }[]>`
      SELECT open_tenancy_backfill_receipt(${organizationId}, ${resourceFamily}, ${runKey})
    `;
    return row!.open_tenancy_backfill_receipt;
  });
}

async function recordUnresolved(
  organizationId: string,
  receiptId: string,
  resourceId: string,
  reasonCode: string,
): Promise<void> {
  await asOrg(organizationId, async (tx) => {
    await tx`SELECT record_tenancy_backfill_unresolved(${receiptId}, ${resourceId}, ${reasonCode})`;
  });
}

async function completeReceipt(
  organizationId: string,
  receiptId: string,
  classifiedCount: number,
  skippedCount: number,
  status: string,
): Promise<void> {
  await asOrg(organizationId, async (tx) => {
    await tx`SELECT complete_tenancy_backfill_receipt(
      ${receiptId}, ${classifiedCount}, ${skippedCount}, ${status})`;
  });
}

async function seedOrganization(label: string): Promise<string> {
  const rows = await admin<{ id: string }[]>`
    INSERT INTO managed_accounts (name) VALUES (${`ledger-${label}`}) RETURNING id
  `;
  return rows[0]!.id;
}

describe("migration 0289 tenancy backfill ledger", () => {
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

  // NOTE: the "opengeni_app holds no direct DML" assertion deliberately does NOT
  // live here, against the shared harness database. provisionRoles re-normalizes
  // the whole schema's ACLs (REVOKE ALL ON ALL TABLES, then GRANT to an explicit
  // allowlist) AFTER migrate(), so on that database the assertion is true no
  // matter what this migration does - adding a GRANT here still passes. That was
  // sabotage-confirmed. The privilege claim is therefore asserted below on a
  // migrate()-ONLY database, where the migration's own REVOKE/GRANT block is the
  // only thing that can decide the answer.

  test("a receipt opens idempotently and counts unresolved rows exactly once", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("idempotent");

    const receiptId = await openReceipt(organizationId, "sessions", "run-a");

    // Re-opening the same run adopts the same receipt rather than forking one.
    expect(await openReceipt(organizationId, "sessions", "run-a")).toBe(receiptId);

    // Two sweeps racing on the same run key must both adopt one receipt rather
    // than one of them surfacing a raw duplicate-key error.
    const raced = await Promise.all([
      openReceipt(organizationId, "sessions", "run-race"),
      openReceipt(organizationId, "sessions", "run-race"),
      openReceipt(organizationId, "sessions", "run-race"),
    ]);
    expect(new Set(raced).size).toBe(1);

    const resourceId = Bun.randomUUIDv7();
    await recordUnresolved(organizationId, receiptId, resourceId, "no_deterministic_evidence");
    // A resumed sweep re-observing the same row must not inflate the count.
    await recordUnresolved(organizationId, receiptId, resourceId, "no_deterministic_evidence");

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
    const receiptId = await openReceipt(organizationId, "rigs", "run-b");
    const resourceId = Bun.randomUUIDv7();
    await recordUnresolved(organizationId, receiptId, resourceId, "ambiguous_candidate_authority");

    await expectRejection(
      () => admin`
        UPDATE tenancy_backfill_unresolved_rows SET reason_code = 'legacy_shape_unrecognized'
        WHERE receipt_id = ${receiptId}
      `,
      /immutable/u,
    );
    await expectRejection(
      () => admin`DELETE FROM tenancy_backfill_unresolved_rows WHERE receipt_id = ${receiptId}`,
      /append-only/u,
    );

    await completeReceipt(organizationId, receiptId, 5, 2, "completed");
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
    await expectRejection(
      () =>
        recordUnresolved(
          organizationId,
          receiptId,
          Bun.randomUUIDv7(),
          "no_deterministic_evidence",
        ),
      /already settled/u,
    );
    await expectRejection(
      () => completeReceipt(organizationId, receiptId, 1, 1, "completed"),
      /already settled/u,
    );
    await expectRejection(() => openReceipt(organizationId, "rigs", "run-b"), /already settled/u);
  }, 180_000);

  test("the caller cannot understate its own outstanding obligations", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("obligations");
    const receiptId = await openReceipt(organizationId, "documents", "run-c");
    await recordUnresolved(organizationId, receiptId, Bun.randomUUIDv7(), "external_lane_owns_row");
    await recordUnresolved(organizationId, receiptId, Bun.randomUUIDv7(), "external_lane_owns_row");

    // completion takes classified/skipped only - unresolved_count is owned by
    // the append path, so settling cannot zero it out.
    await completeReceipt(organizationId, receiptId, 0, 0, "completed");
    const [receipt] = await admin<{ unresolved_count: string }[]>`
      SELECT unresolved_count FROM tenancy_backfill_receipts WHERE id = ${receiptId}
    `;
    expect(Number(receipt!.unresolved_count)).toBe(2);
  }, 180_000);

  test("invalid families, reasons, statuses, and null arguments fail closed", async () => {
    if (!available) return;
    const organizationId = await seedOrganization("fail-closed");

    await expectRejection(
      () =>
        asOrg(
          organizationId,
          (tx) => tx`SELECT open_tenancy_backfill_receipt(NULL, 'sessions', 'run-d')`,
        ),
      /requires organization, family, and run key/u,
    );
    await expectRejection(
      () => openReceipt(organizationId, "not_a_family", "run-d"),
      /tenancy_backfill_receipt_family_chk/u,
    );

    const receiptId = await openReceipt(organizationId, "sessions", "run-d");
    await expectRejection(
      () => recordUnresolved(organizationId, receiptId, Bun.randomUUIDv7(), "invented_reason"),
      /tenancy_backfill_unresolved_reason_chk/u,
    );
    await expectRejection(
      () => completeReceipt(organizationId, receiptId, 1, 1, "half_done"),
      /completed or failed/u,
    );
    await expectRejection(
      () => completeReceipt(organizationId, receiptId, -1, 0, "completed"),
      /non-negative/u,
    );
    await expectRejection(
      () =>
        recordUnresolved(
          organizationId,
          Bun.randomUUIDv7(),
          Bun.randomUUIDv7(),
          "no_deterministic_evidence",
        ),
      /does not exist/u,
    );
  }, 180_000);

  test("the ledger is organization-scoped and one run key does not collide across organizations", async () => {
    if (!available) return;
    const first = await seedOrganization("org-one");
    const second = await seedOrganization("org-two");
    const a = await openReceipt(first, "machines", "shared-run-key");
    const b = await openReceipt(second, "machines", "shared-run-key");
    expect(a).not.toBe(b);

    const rows = await admin<{ account_id: string }[]>`
      SELECT account_id FROM tenancy_backfill_receipts
      WHERE run_key = 'shared-run-key' ORDER BY account_id
    `;
    expect(new Set(rows.map((row) => row.account_id))).toEqual(new Set([first, second]));
  }, 180_000);

  test("under migrate() ALONE the seam is executable and neither table is directly writable", async () => {
    // Mirrors the 0285 regression: acquireBlankTestDatabase + migrate() never
    // runs provisionRoles' blanket schema-wide EXECUTE sweep, so the
    // migration's own explicit grants must be sufficient on their own. That
    // also makes this the only place where "no direct DML" is a real assertion
    // about THIS migration rather than about provisionRoles.
    const blank = await acquireBlankTestDatabase("migration-0289-no-provision-roles");
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

        for (const table of ["tenancy_backfill_receipts", "tenancy_backfill_unresolved_rows"]) {
          for (const privilege of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
            const [row] = await probe<{ granted: boolean }[]>`
              SELECT has_table_privilege('opengeni_app', ${table}, ${privilege}) AS granted
            `;
            expect({ table, privilege, granted: row!.granted }).toEqual({
              table,
              privilege,
              granted: false,
            });
          }
        }
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await blank.release();
    }
  }, 300_000);
  test("the append-only guard holds under a NON-SUPERUSER owner at trigger depth > 1", async () => {
    // The regression this pins is invisible to the ordinary harness: it
    // migrates as superuser `postgres`, for whom FORCE RLS never engages, so
    // the guard's own reads always see the parent rows. Under a real
    // non-superuser owner the SECURITY DEFINER reads run under FORCE RLS with
    // no lifecycle GUC set, and a naive "is the parent gone" probe answers
    // "gone" while the receipt is alive - letting any nested delete
    // (pg_trigger_depth() > 1) erase append-only evidence.
    const blank = await acquireBlankTestDatabase("migration-0289-nonsuperuser-owner");
    if (!blank) return;
    try {
      await migrate(blank.databaseUrl);
      const probe = postgres(blank.databaseUrl, { max: 1 });
      try {
        await probe.unsafe(`
          DROP ROLE IF EXISTS og_ledger_owner;
          CREATE ROLE og_ledger_owner NOSUPERUSER NOBYPASSRLS NOLOGIN;
          ALTER TABLE tenancy_backfill_receipts OWNER TO og_ledger_owner;
          ALTER TABLE tenancy_backfill_unresolved_rows OWNER TO og_ledger_owner;
          ALTER FUNCTION guard_tenancy_backfill_unresolved_row() OWNER TO og_ledger_owner;
          GRANT USAGE ON SCHEMA public TO og_ledger_owner;
          GRANT SELECT ON managed_accounts TO og_ledger_owner;
        `);

        const [org] = await probe<{ id: string }[]>`
          INSERT INTO managed_accounts (name) VALUES ('nonsuperuser-owner') RETURNING id`;
        // This probe drives the seams directly rather than through asOrg, so it
        // carries the same tenant fence on its own session.
        await probe`SELECT set_config('opengeni.account_id', ${org!.id}, false)`;
        const [opened] = await probe<{ open_tenancy_backfill_receipt: string }[]>`
          SELECT open_tenancy_backfill_receipt(${org!.id}, 'sessions', 'owner-run')`;
        const receiptId = opened!.open_tenancy_backfill_receipt;
        await probe`SELECT record_tenancy_backfill_unresolved(
          ${receiptId}, ${Bun.randomUUIDv7()}, 'no_deterministic_evidence')`;

        // Drive a delete from inside another trigger so pg_trigger_depth() > 1
        // while BOTH parents are demonstrably alive.
        await probe.unsafe(`
          CREATE TABLE ledger_depth_probe (id serial PRIMARY KEY);
          CREATE FUNCTION ledger_depth_probe_fn() RETURNS trigger
            LANGUAGE plpgsql AS $fn$
            BEGIN
              DELETE FROM tenancy_backfill_unresolved_rows;
              RETURN NEW;
            END;
            $fn$;
          CREATE TRIGGER ledger_depth_probe_tr AFTER INSERT ON ledger_depth_probe
            FOR EACH ROW EXECUTE FUNCTION ledger_depth_probe_fn();
        `);

        await expectRejection(
          () => probe`INSERT INTO ledger_depth_probe DEFAULT VALUES`,
          /append-only/u,
        );

        // The evidence must still be there.
        const [remaining] = await probe<{ count: string }[]>`
          SELECT count(*) AS count FROM tenancy_backfill_unresolved_rows
          WHERE receipt_id = ${receiptId}`;
        expect(Number(remaining!.count)).toBe(1);

        // A genuine parent cascade is still permitted.
        await probe`DELETE FROM tenancy_backfill_receipts WHERE id = ${receiptId}`;
        const [afterCascade] = await probe<{ count: string }[]>`
          SELECT count(*) AS count FROM tenancy_backfill_unresolved_rows
          WHERE receipt_id = ${receiptId}`;
        expect(Number(afterCascade!.count)).toBe(0);
      } finally {
        await probe.end().catch(() => undefined);
      }
    } finally {
      await blank.release();
    }
  }, 300_000);
  test("one organization cannot open, append to, or settle another organization's receipt", async () => {
    // Reproduced by review: without a tenant fence an opengeni_app session whose
    // opengeni.account_id was the attacker's org could open, append to and settle
    // a receipt owned by the victim's org - polluting phase-D evidence and, worse,
    // making the victim's in-flight backfill fail `already settled`.
    if (!available) return;
    const victim = await seedOrganization("victim");
    const attacker = await seedOrganization("attacker");

    const scoped = postgres(shared!.appUrl, { max: 1 });
    try {
      // Legitimate: victim's own context opens its own receipt.
      await scoped`SELECT set_config('opengeni.account_id', ${victim}, false)`;
      const [opened] = await scoped<{ open_tenancy_backfill_receipt: string }[]>`
        SELECT open_tenancy_backfill_receipt(${victim}, 'sessions', 'victim-run')`;
      const receiptId = opened!.open_tenancy_backfill_receipt;

      // Attacker context: every seam must refuse.
      await scoped`SELECT set_config('opengeni.account_id', ${attacker}, false)`;
      await expectRejection(
        () => scoped`SELECT open_tenancy_backfill_receipt(${victim}, 'sessions', 'x')`,
        /scope mismatch/u,
      );
      await expectRejection(
        () =>
          scoped`SELECT record_tenancy_backfill_unresolved(
            ${receiptId}, ${Bun.randomUUIDv7()}, 'no_deterministic_evidence')`,
        /scope mismatch/u,
      );
      await expectRejection(
        () => scoped`SELECT complete_tenancy_backfill_receipt(${receiptId}, 999, 0, 'completed')`,
        /scope mismatch/u,
      );

      // The victim's receipt is untouched and still open.
      const [row] = await admin<{ status: string; classified_count: string }[]>`
        SELECT status, classified_count FROM tenancy_backfill_receipts WHERE id = ${receiptId}`;
      expect(row!.status).toBe("open");
      expect(Number(row!.classified_count)).toBe(0);
    } finally {
      await scoped.end().catch(() => undefined);
    }
  }, 180_000);
});
