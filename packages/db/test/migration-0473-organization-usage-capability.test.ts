import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  getOrganizationUsageSummary,
  type DbClient,
  nestedPostgresSqlState,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

const migrationPath = new URL(
  "../drizzle/0473_organization_usage_analytical_capability.sql",
  import.meta.url,
);
const signature =
  "opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let app: postgres.Sql | null = null;
let hostileRole: string | null = null;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("org-usage-cap");
  if (!owned) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Organization usage owner-RLS fixture unavailable");
    console.warn("SKIPPED 0473 real owner/FORCE-RLS capability assertions: PostgreSQL unavailable");
    return;
  }
  hostileRole = `${owned.ownerRole}_hostile`.slice(0, 63);
  await owned.admin.unsafe(`CREATE ROLE "${hostileRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  const owner = postgres(owned.ownerUrl, { max: 1 });
  try {
    await owner.unsafe(`
      CREATE SCHEMA IF NOT EXISTS opengeni_private AUTHORIZATION CURRENT_USER;
      CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION opengeni_private.test_org_usage_defaults() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.name = '0468_knowledge_relationship_projection.sql' THEN
          EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private GRANT ALL ON TABLES TO "${hostileRole}"';
          EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private GRANT EXECUTE ON FUNCTIONS TO "${hostileRole}"';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_org_usage_defaults AFTER INSERT ON schema_migrations
        FOR EACH ROW EXECUTE FUNCTION opengeni_private.test_org_usage_defaults();
    `);
  } finally {
    await owner.end();
  }
  await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  app = postgres(appUrl.toString(), {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
}, 900_000);

afterAll(async () => {
  await app?.end();
  await client?.close();
  if (owned && hostileRole) {
    await owned.admin.unsafe(`DROP OWNED BY "${hostileRole}"; DROP ROLE "${hostileRole}"`);
  }
  await owned?.release();
}, 180_000);

async function expectState(action: () => Promise<unknown>, code: string, label = "SQLSTATE") {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  const actual = nestedPostgresSqlState(failure);
  const detail =
    failure instanceof Error
      ? `${failure.name}: ${failure.message.slice(0, 240)}`
      : failure === undefined
        ? "No exception"
        : "Non-Error exception";
  expect(actual, `${label}: ${detail}; SQLSTATE=${actual ?? "none"}`).toBe(code);
}

describe("0473 organization usage analytical capability", () => {
  test("source keeps tenant/session RLS and account-only owner capability with initPlan first", async () => {
    const source = await readFile(migrationPath, "utf8");
    expect(source).toContain("-- deployment-mode: rolling");
    expect(source).toContain("SET plan_cache_mode = force_custom_plan");
    expect(source).toContain(
      "CASE WHEN (SELECT %I.organization_usage_policy_capability_active(current_user)) THEN true ELSE (%s) END",
    );
    expect(source).toContain("visible_sessions AS MATERIALIZED");
    expect(source).toContain("usage_row.session_id IS NULL OR session_row.id IS NOT NULL");
    expect(source).toContain("p_include_period OR usage_row.workspace_id = ANY(page_ids)");
    expect(source).toContain("context_account_id IS DISTINCT FROM p_account_id");
    const sharedInventory = source.indexOf(
      "id IN (SELECT workspace_id FROM %1$I.list_organization_workspace_ids(context_account_id))",
    );
    expect(sharedInventory).toBeGreaterThan(0);
    expect(sharedInventory).toBeLessThan(source.indexOf("ORDER BY id LIMIT 51"));
    expect(source).not.toMatch(
      /DISABLE ROW LEVEL SECURITY|NO FORCE ROW LEVEL SECURITY|row_security\s*=\s*off/i,
    );
    expect(source).not.toContain("CREATE POLICY session_visibility_insert");
  });

  test("owner is non-bypass; capability defaults/ACLs and app spoofing stay closed", async () => {
    if (!owned || !app || !hostileRole) return;
    const [owner] =
      await owned.admin`select rolsuper, rolbypassrls from pg_roles where rolname = ${owned.ownerRole}`;
    expect(owner).toMatchObject({ rolsuper: false, rolbypassrls: false });
    for (const role of ["opengeni_app", hostileRole]) {
      for (const privilege of [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ]) {
        const [row] =
          await owned.admin`select has_table_privilege(${role}, 'opengeni_private.organization_usage_read_capabilities', ${privilege}) as allowed`;
        expect(row!.allowed).toBe(false);
      }
    }
    const [grants] = await owned.admin`select
      has_function_privilege('opengeni_app', ${signature}, 'EXECUTE') as app,
      has_function_privilege(${hostileRole}, ${signature}, 'EXECUTE') as hostile`;
    expect(grants).toMatchObject({ app: true, hostile: false });
    await expectState(
      () => app!.unsafe("select * from opengeni_private.organization_usage_read_capabilities"),
      "42501",
    );
    await expectState(
      () =>
        app!.unsafe(
          "insert into opengeni_private.organization_usage_read_capabilities (backend_pid,transaction_id,account_id) values (pg_backend_pid(),pg_current_xact_id(),gen_random_uuid())",
        ),
      "42501",
    );
    const [closed] =
      await app`select public.organization_usage_policy_capability_active(${owned.ownerRole}) as active`;
    expect(closed!.active).toBe(false);
  });

  test("rejects missing/mismatched scope and invalid windows before capability minting", async () => {
    if (!owned || !app) return;
    const accountId = crypto.randomUUID();
    const call = (
      tx: postgres.TransactionSql,
      since = "2026-09-01T00:00:00Z",
      until = "2026-09-14T00:00:00Z",
    ) =>
      // Send text so the driver does not convert PostgreSQL infinities to invalid JS Dates.
      tx`select opengeni_private.organization_usage_summary(${accountId}::uuid, ${since}::text::timestamptz, ${until}::text::timestamptz, 'day', null, true)`;
    await expectState(
      () =>
        app!.begin(async (tx) => {
          await call(tx);
        }),
      "42501",
    );
    await expectState(
      () =>
        app!.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${crypto.randomUUID()}, true)`;
          await call(tx);
        }),
      "42501",
    );
    await expectState(
      () =>
        app!.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true), set_config('opengeni.workspace_id', ${crypto.randomUUID()}, true)`;
          await call(tx);
        }),
      "42501",
    );
    for (const [since, until] of [
      ["-infinity", "2026-09-14"],
      ["2026-09-01", "infinity"],
      ["2024-01-01", "2026-09-01"],
      ["2026-09-15", "2026-09-01"],
    ]) {
      await expectState(
        () =>
          app!.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${accountId}, true), set_config('opengeni.workspace_id', '', true)`;
            await call(tx, since, until);
          }),
        "22023",
        `Invalid window ${since} to ${until}`,
      );
    }
    const [count] =
      await owned.admin`select count(*)::int as count from opengeni_private.organization_usage_read_capabilities`;
    expect(count!.count).toBe(0);
  });

  test("aggregates under the non-bypass owner and removes capability before returning", async () => {
    if (!owned || !client || !app) return;
    const userId = `org-cap-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Org capability",
    });
    const grant = access.workspaceGrants[0]!;
    await owned.admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'model.cost', 100, 'usd_micros', gen_random_uuid()::text, '2026-09-01'::timestamptz from generate_series(1, 250)`;
    const summary = await getOrganizationUsageSummary(
      client.db,
      { accountId: grant.accountId, period: "month" },
      new Date("2026-09-14T00:00:00Z"),
    );
    expect(summary.totals).toContainEqual({
      eventType: "model.cost",
      unit: "usd_micros",
      quantity: "25000",
      eventCount: "250",
    });
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${grant.accountId}, true), set_config('opengeni.workspace_id', '', true)`;
      await tx`select opengeni_private.organization_usage_summary(${grant.accountId}::uuid, '2026-09-01'::timestamptz, '2026-09-14'::timestamptz, 'day', null, true)`;
      const [closed] =
        await tx`select public.organization_usage_policy_capability_active(${owned!.ownerRole}) as active`;
      expect(closed!.active).toBe(false);
    });
    const [count] =
      await owned.admin`select count(*)::int as count from opengeni_private.organization_usage_read_capabilities`;
    expect(count!.count).toBe(0);
    const [policies] =
      await owned.admin`select count(*)::int as count from pg_policy where polrelid = 'usage_events'::regclass
      and polname in ('session_visibility_insert_isolation','session_visibility_update_isolation','session_visibility_delete_isolation')`;
    expect(policies!.count).toBe(3);
  }, 180_000);
});
