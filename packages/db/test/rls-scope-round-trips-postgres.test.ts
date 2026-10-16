import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  createDb,
  rawRows,
  withAccountRls,
  withRlsContext,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  withWorkspaceUsageLock,
  type Database,
} from "../src/database";
import { bootstrapWorkspace } from "../src/index";
import * as schema from "../src/schema";

// Every scoped transaction used to spend about nine sequential round trips on
// bookkeeping (account lookup, BEGIN, three set_config calls, two read-backs, a
// lock, the query, COMMIT). The scope is now established by one statement, so a
// standalone scoped read is BEGIN, setup, query, COMMIT.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let traced: ReturnType<typeof postgres>;
let db: Database;
const statements: string[] = [];

type Tenant = { accountId: string; workspaceId: string; subjectId: string };
let tenantA: Tenant;
let tenantB: Tenant;

async function tenant(label: string): Promise<Tenant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: label,
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: label,
    subjectId: `subject-${label}-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("rls-scope-round-trips");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
  traced = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    debug: (_connection, query) => {
      statements.push(query.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase());
    },
  });
  db = drizzle(traced, { schema }) as unknown as Database;
  // Open the connection first: postgres.js reads array types once per connection.
  await traced`select 1`;
  tenantA = await tenant("a");
  tenantB = await tenant("b");
  // A tenant-scoped probe table under FORCE RLS, one row per workspace.
  await shared.admin`
    create table rls_scope_probe (workspace_id text not null, account_id text not null)`;
  await shared.admin`alter table rls_scope_probe enable row level security`;
  await shared.admin`alter table rls_scope_probe force row level security`;
  await shared.admin`
    create policy tenant_scope on rls_scope_probe for select using (
      account_id = nullif(current_setting('opengeni.account_id', true), '')
      and (
        nullif(current_setting('opengeni.workspace_id', true), '') is null
        or workspace_id = current_setting('opengeni.workspace_id', true)
      )
    )`;
  await shared.admin`grant select on rls_scope_probe to opengeni_app`;
  for (const seeded of [tenantA, tenantB]) {
    await shared.admin`
      insert into rls_scope_probe values (${seeded.workspaceId}, ${seeded.accountId})`;
  }
}, 180_000);

afterAll(async () => {
  await traced?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

async function trace<T>(work: () => Promise<T>): Promise<{ value: T; statements: string[] }> {
  statements.length = 0;
  const value = await work();
  return { value, statements: [...statements] };
}

function visibleWorkspaces(scoped: Database) {
  return rawRows<{ id: string }>(
    scoped,
    sql`select workspace_id as id from rls_scope_probe order by workspace_id`,
  );
}

async function lockHeldElsewhere(lock: string): Promise<boolean> {
  // An autocommit try-lock from another backend; the lock is released at once.
  const [row] = await shared.admin.unsafe<{ acquired: boolean }[]>(`select ${lock} as acquired`);
  return !row!.acquired;
}

describe("one-statement RLS scope", () => {
  test("a standalone workspace read costs BEGIN, setup, query and COMMIT", async () => {
    for (const run of [
      () => withWorkspaceRls(db, tenantA.workspaceId, visibleWorkspaces),
      () => withWorkspaceSubjectRls(db, tenantA.workspaceId, tenantA.subjectId, visibleWorkspaces),
      () =>
        withRlsContext(
          db,
          { accountId: tenantA.accountId, workspaceId: tenantA.workspaceId },
          visibleWorkspaces,
        ),
      () => withWorkspaceUsageLock(db, tenantA.workspaceId, visibleWorkspaces),
    ]) {
      const { value, statements: sent } = await trace(run);
      expect(value.map((row) => row.id)).toEqual([tenantA.workspaceId]);
      expect(sent.map((statement) => statement.split(" ")[0])).toEqual([
        "begin",
        "with",
        "select",
        "commit",
      ]);
      expect(sent[1]).toStartWith("with parent as");
    }
  });

  test("an account-wide scope also sets up in one statement", async () => {
    const { value, statements: sent } = await trace(() =>
      withAccountRls(db, tenantB.accountId, visibleWorkspaces),
    );
    expect(value.map((row) => row.id)).toEqual([tenantB.workspaceId]);
    expect(sent).toHaveLength(4);
  });

  test("tenant isolation still holds for the SQL-resolved account", async () => {
    const seen = await withWorkspaceRls(db, tenantB.workspaceId, visibleWorkspaces);
    expect(seen.map((row) => row.id)).toEqual([tenantB.workspaceId]);
    const applied = await withWorkspaceSubjectRls(
      db,
      tenantB.workspaceId,
      tenantB.subjectId,
      async (scoped) =>
        (
          await rawRows<{ account: string; workspace: string; subject: string }>(
            scoped,
            sql`select current_setting('opengeni.account_id', true) as account,
              current_setting('opengeni.workspace_id', true) as workspace,
              current_setting('opengeni.subject_id', true) as subject`,
          )
        )[0],
    );
    expect(applied).toEqual({
      account: tenantB.accountId,
      workspace: tenantB.workspaceId,
      subject: tenantB.subjectId,
    });
  });

  test("a missing workspace fails loud and never runs the callback", async () => {
    const missing = crypto.randomUUID();
    let ran = false;
    await expect(
      withWorkspaceRls(db, missing, async () => {
        ran = true;
      }),
    ).rejects.toThrow(`Workspace not found: ${missing}`);
    expect(ran).toBe(false);
  });

  test("a blank account is refused before any statement", async () => {
    const { statements: sent } = await trace(async () => {
      await expect(
        withRlsContext(db, { accountId: " ", workspaceId: tenantA.workspaceId }, async () => 1),
      ).rejects.toThrow("non-empty accountId");
    });
    expect(sent).toEqual([]);
  });

  test("the setup statement takes the scope's advisory locks", async () => {
    const tenancy = `pg_try_advisory_xact_lock(hashtextextended('session-tenancy:${tenantA.workspaceId}', 0))`;
    const usage = `pg_try_advisory_xact_lock(hashtext('usage:${tenantA.workspaceId}'))`;
    const sharedUsage = `pg_try_advisory_xact_lock_shared(hashtext('usage:${tenantA.workspaceId}'))`;
    const membership = `pg_try_advisory_xact_lock_shared(hashtextextended('organization-membership:${tenantA.accountId}', 0))`;
    expect(await lockHeldElsewhere(tenancy)).toBe(false);

    await withWorkspaceRls(db, tenantA.workspaceId, async () => {
      // Shared tenancy fence: an exclusive tenancy waiter is blocked.
      expect(await lockHeldElsewhere(tenancy)).toBe(true);
      expect(await lockHeldElsewhere(usage)).toBe(false);
    });
    await withWorkspaceUsageLock(db, tenantA.workspaceId, async () => {
      expect(await lockHeldElsewhere(tenancy)).toBe(true);
      expect(await lockHeldElsewhere(sharedUsage)).toBe(true);
    });
    await withWorkspaceSessionActivityRls(
      db,
      tenantA.workspaceId,
      async () => {
        expect(await lockHeldElsewhere(membership)).toBe(true);
        expect(await lockHeldElsewhere(tenancy)).toBe(true);
      },
      undefined,
      true,
    );
    expect(await lockHeldElsewhere(tenancy)).toBe(false);
    expect(await lockHeldElsewhere(membership)).toBe(false);
  });

  test("the membership fence is taken before the tenancy fence", async () => {
    // Hold the tenancy fence exclusively elsewhere: the scope must already own
    // the membership lock while it waits for tenancy.
    const tenancyKey = `session-tenancy:${tenantA.workspaceId}`;
    const membership = `pg_try_advisory_xact_lock_shared(hashtextextended('organization-membership:${tenantA.accountId}', 0))`;
    let scoped: Promise<number> | undefined;
    let membershipTaken = false;
    await shared.admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${tenancyKey}, 0))`;
      scoped = withWorkspaceSessionActivityRls(
        db,
        tenantA.workspaceId,
        async () => 1,
        undefined,
        true,
      );
      scoped.catch(() => {});
      for (let attempt = 0; attempt < 100 && !membershipTaken; attempt += 1) {
        await Bun.sleep(20);
        membershipTaken = await lockHeldElsewhere(membership);
      }
    });
    // Committing released tenancy, so the waiting scope finishes.
    expect(membershipTaken).toBe(true);
    expect(await scoped).toBe(1);
  });

  test("a nested scope restores the enclosing tenant and subject", async () => {
    await withWorkspaceSubjectRls(db, tenantA.workspaceId, tenantA.subjectId, async (outer) => {
      const inner = await withWorkspaceRls(outer, tenantB.workspaceId, visibleWorkspaces);
      expect(inner.map((row) => row.id)).toEqual([tenantB.workspaceId]);
      const [after] = await rawRows<{ account: string; workspace: string; subject: string }>(
        outer,
        sql`select current_setting('opengeni.account_id', true) as account,
          current_setting('opengeni.workspace_id', true) as workspace,
          current_setting('opengeni.subject_id', true) as subject`,
      );
      expect(after).toEqual({
        account: tenantA.accountId,
        workspace: tenantA.workspaceId,
        subject: tenantA.subjectId,
      });
      expect((await visibleWorkspaces(outer)).map((row) => row.id)).toEqual([tenantA.workspaceId]);
    });
  });
});
