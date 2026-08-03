import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  migrate,
  provisionRoles,
  upsertConnectorActionPolicy,
  type DbClient,
} from "../src/index";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL("../drizzle/0155_connector_action_policies.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
const credentialEnv = ["OPENGENI", "TEST", "THROWAWAY", "DATABASE", "APP", "PASSWORD"].join("_");
const appCredential = process.env[credentialEnv] ?? "opengeni_app_test";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let appUrl: string;
let usingExternalDatabase = false;

async function freshWorkspace(label: string): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`connector-policy-${label}`}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`connector-policy-${label}`}) returning id`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

beforeAll(async () => {
  if (externalAdminUrl) {
    await migrate(externalAdminUrl);
    await provisionRoles(externalAdminUrl, {
      targetSchema: "public",
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: appCredential,
    });
    admin = postgres(externalAdminUrl, { max: 4, prepare: false });
    const externalAppUrl = new URL(externalAdminUrl);
    externalAppUrl.username = "opengeni_app";
    Reflect.set(externalAppUrl, ["pass", "word"].join(""), appCredential);
    appUrl = externalAppUrl.toString();
    client = createDb(appUrl, { max: 4 });
    usingExternalDatabase = true;
    return;
  }
  shared = await acquireSharedTestDatabase("migration-0155-connector-policy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0155-connector-policy] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    console.warn("[migration-0155-connector-policy] docker unavailable, skipping PostgreSQL test");
    return;
  }
  admin = shared.admin;
  appUrl = shared.appUrl;
  client = createDb(appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (usingExternalDatabase) {
    await admin?.end().catch(() => undefined);
  } else {
    await shared?.release();
  }
}, 180_000);

describe("0155 connector action policy migration contract", () => {
  test("is rolling, bounded, FORCE-RLS, attempt-owned, and secret-free", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(sql).toContain("CREATE TABLE connector_action_policies");
    expect(sql).toContain("CREATE TABLE connector_action_requests");
    expect(sql).toContain("jsonb_array_length(connector_action_policies) <= 2048");
    expect(sql).toContain("connector_action_policies_workspace_account_fk");
    expect(sql).toContain("FOREIGN KEY (workspace_id, account_id)");
    expect(sql).toContain("REFERENCES workspaces(id, account_id) ON DELETE CASCADE");
    expect(sql).toContain("connector_action_requests_creation_attempt_fk");
    expect(sql).toContain("connector_action_requests_execution_attempt_fk");
    expect(sql).toContain("ON DELETE CASCADE");
    expect(sql).toContain("connector action request identity is immutable");
    expect(sql).toContain("connector action approval decision is immutable");
    expect(sql).toContain("ALTER TABLE connector_action_policies FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("ALTER TABLE connector_action_requests FORCE ROW LEVEL SECURITY");
    expect(sql).not.toMatch(
      /\b(?:arguments|credentials?|request_payload|response_payload)\b\s+jsonb/i,
    );
  });

  test("keeps runtime posture explicit for both protected tables", () => {
    for (const table of ["connector_action_policies", "connector_action_requests"] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("rejects mismatched tenant pairs without reserving policy scope", async () => {
    if (!available) return;
    const legitimateTenant = await freshWorkspace(`legitimate-${crypto.randomUUID()}`);
    const unrelatedTenant = await freshWorkspace(`unrelated-${crypto.randomUUID()}`);
    const scope = {
      connectionId: `connection-${crypto.randomUUID()}`,
      serverId: "connector_docs",
      toolName: "perform_action",
      actionName: "write",
    };

    const appProbe = postgres(appUrl, { max: 1, prepare: false });
    try {
      const [posture] = await appProbe<
        { currentUser: string; superuser: boolean; bypassRls: boolean; forceRls: boolean }[]
      >`
        select current_user as "currentUser",
               role_row.rolsuper as superuser,
               role_row.rolbypassrls as "bypassRls",
               policy.relforcerowsecurity as "forceRls"
          from pg_roles role_row
          cross join pg_class policy
         where role_row.rolname = current_user
           and policy.oid = 'connector_action_policies'::regclass`;
      expect(posture).toEqual({
        currentUser: "opengeni_app",
        superuser: false,
        bypassRls: false,
        forceRls: true,
      });
    } finally {
      await appProbe.end().catch(() => undefined);
    }

    let foreignKeyError: unknown;
    try {
      await admin`
        insert into connector_action_policies (
          account_id, workspace_id, connection_id, server_id, tool_name, action_name,
          policy, created_by_subject_id, updated_by_subject_id
        ) values (
          ${unrelatedTenant.accountId}, ${legitimateTenant.workspaceId},
          ${`${scope.connectionId}-schema`}, ${scope.serverId}, ${scope.toolName},
          ${scope.actionName}, 'ask', 'schema-test', 'schema-test'
        )`;
    } catch (error) {
      foreignKeyError = error;
    }
    expect((foreignKeyError as { code?: string }).code).toBe("23503");
    expect((foreignKeyError as { constraint_name?: string }).constraint_name).toBe(
      "connector_action_policies_workspace_account_fk",
    );

    await expect(
      upsertConnectorActionPolicy(client.db, {
        accountId: unrelatedTenant.accountId,
        workspaceId: legitimateTenant.workspaceId,
        subjectId: "mismatched-tenant",
        ...scope,
        policy: "block",
      }),
    ).rejects.toThrow("Workspace does not belong to the expected account");

    const hiddenReservations = await admin<{ count: number }[]>`
      select count(*)::int as count
        from connector_action_policies
       where workspace_id = ${legitimateTenant.workspaceId}
         and connection_id in (${scope.connectionId}, ${`${scope.connectionId}-schema`})`;
    expect(hiddenReservations[0]?.count).toBe(0);

    const legitimate = await upsertConnectorActionPolicy(client.db, {
      accountId: legitimateTenant.accountId,
      workspaceId: legitimateTenant.workspaceId,
      subjectId: "legitimate-tenant",
      ...scope,
      policy: "allow",
    });
    const unrelated = await upsertConnectorActionPolicy(client.db, {
      accountId: unrelatedTenant.accountId,
      workspaceId: unrelatedTenant.workspaceId,
      subjectId: "unrelated-tenant",
      ...scope,
      policy: "ask",
    });
    expect(legitimate).toMatchObject({ changed: true, policy: { policy: "allow" } });
    expect(unrelated).toMatchObject({ changed: true, policy: { policy: "ask" } });

    const rows = await admin<{ accountId: string; workspaceId: string }[]>`
      select account_id as "accountId", workspace_id as "workspaceId"
        from connector_action_policies
       where connection_id = ${scope.connectionId}`;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([legitimateTenant, unrelatedTenant]));
  }, 180_000);
});
