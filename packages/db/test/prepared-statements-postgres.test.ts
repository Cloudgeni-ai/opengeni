import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

import {
  createDb,
  defaultDatabasePreparedStatements,
  rawRows,
  withWorkspaceRls,
  type Database,
} from "../src/database";
import { bootstrapWorkspace } from "../src/index";

// Direct connections now use named prepared statements. The server then plans a
// statement once and, after five executions, may switch to one generic plan that
// every later execution reuses. Row-level security must still filter by the
// scope set for each transaction, never by the scope of the first execution.

describe("prepared statement default", () => {
  test.each([
    ["postgres://app:secret@db.internal:5432/opengeni", true],
    ["postgres://app:secret@db.internal/opengeni", true],
    ["postgresql://db.internal:5433/opengeni?sslmode=require", true],
    ["postgres://app:secret@pool.example.com:6432/opengeni", false],
    ["postgresql://app@pool.example.com:6432/opengeni?sslmode=require", false],
    ["postgres://app@a.internal:5432,b.internal:6432/opengeni", false],
    ["postgres://app:p%3A6432@db.internal:5432/opengeni", true],
    ["postgres://app@db.internal:5432/db6432", true],
  ])("%s → %p", (url, expected) => {
    expect(defaultDatabasePreparedStatements(url)).toBe(expected);
  });
});

let shared: SharedTestDatabase;
let prepared: ReturnType<typeof createDb>;
let unprepared: ReturnType<typeof createDb>;
type Tenant = { accountId: string; workspaceId: string };
let tenantA: Tenant;
let tenantB: Tenant;

async function tenant(db: Database, label: string): Promise<Tenant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: label,
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: label,
    subjectId: `subject-${label}-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId! };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("prepared-statements");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // One connection each, so the session-local prepared-statement catalog below
  // belongs to the connection that ran the scoped reads.
  prepared = createDb(shared.appUrl, { max: 1 });
  unprepared = createDb(shared.appUrl, { max: 1, preparedStatements: false });
  tenantA = await tenant(prepared.db, "a");
  tenantB = await tenant(prepared.db, "b");
  await shared.admin`
    create table prepared_rls_probe (workspace_id text not null, account_id text not null)`;
  await shared.admin`alter table prepared_rls_probe enable row level security`;
  await shared.admin`alter table prepared_rls_probe force row level security`;
  await shared.admin`
    create policy tenant_scope on prepared_rls_probe for select using (
      account_id = nullif(current_setting('opengeni.account_id', true), '')
      and workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')
    )`;
  await shared.admin`grant select on prepared_rls_probe to opengeni_app`;
  for (const seeded of [tenantA, tenantB]) {
    await shared.admin`
      insert into prepared_rls_probe values (${seeded.workspaceId}, ${seeded.accountId})`;
  }
}, 180_000);

afterAll(async () => {
  if (shared) await shared.admin`drop table if exists prepared_rls_probe`;
  await prepared?.close();
  await unprepared?.close();
  await shared?.release();
}, 60_000);

function visibleWorkspaces(scoped: Database, marker: string) {
  return rawRows<{ id: string }>(
    scoped,
    sql`select workspace_id as id from prepared_rls_probe where workspace_id <> ${marker}`,
  );
}

async function probeStatement(db: Database) {
  const rows = await rawRows<{ prepared: number; generic: number }>(
    db,
    sql`select count(*)::int as prepared, coalesce(sum(generic_plans), 0)::int as generic
      from pg_prepared_statements where statement like '%from prepared_rls_probe%'`,
  );
  return rows[0]!;
}

describe("prepared statements under row-level security", () => {
  test("a prepared pool still plans each execution with its bound values", async () => {
    const [preparedMode] = await rawRows<{ mode: string }>(
      prepared.db,
      sql`select current_setting('plan_cache_mode') as mode`,
    );
    const [unpreparedMode] = await rawRows<{ mode: string }>(
      unprepared.db,
      sql`select current_setting('plan_cache_mode') as mode`,
    );
    expect(preparedMode?.mode).toBe("force_custom_plan");
    expect(unpreparedMode?.mode).toBe("auto");
  });

  test("a reused generic plan still filters by each transaction's own scope", async () => {
    // Make the risky case certain: every execution reuses the one generic plan.
    await prepared.db.execute(sql`set plan_cache_mode = force_generic_plan`);
    for (let round = 0; round < 12; round += 1) {
      for (const current of [tenantA, tenantB]) {
        const rows = await withWorkspaceRls(prepared.db, current.workspaceId, (scoped) =>
          visibleWorkspaces(scoped, "probe"),
        );
        expect(rows.map((row) => row.id)).toEqual([current.workspaceId]);
      }
    }
    const statement = await probeStatement(prepared.db);
    expect(statement.prepared).toBe(1);
    expect(statement.generic).toBeGreaterThan(0);
  });

  test("an explicitly unprepared pool leaves nothing on the backend", async () => {
    for (const current of [tenantA, tenantB, tenantA]) {
      const rows = await withWorkspaceRls(unprepared.db, current.workspaceId, (scoped) =>
        visibleWorkspaces(scoped, "probe"),
      );
      expect(rows.map((row) => row.id)).toEqual([current.workspaceId]);
    }
    expect(await probeStatement(unprepared.db)).toEqual({ prepared: 0, generic: 0 });
  });
});
