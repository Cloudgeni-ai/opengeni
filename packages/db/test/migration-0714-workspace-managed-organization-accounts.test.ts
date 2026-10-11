// Migration 0714 (design 5.4, decision 2): workspace-managed shared
// connections become organization accounts without any row moving. The
// database is staged as a deployment is before 0714 (every earlier migration
// applied by the NOSUPERUSER, NOBYPASSRLS owner, roles provisioned), a
// workspace-managed connection with an alias, an explicit pin, a capacity
// waiter, a live lease and an Apps designation is created next to a personal
// connection, and 0714 is then applied by the owner as production applies it.
// Every subscription row of the organization must be byte-for-byte identical,
// and only afterwards may an organization administrator choose its reach.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDb, ensureManagedAccessForUser, type DbClient } from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);
const MIGRATION = "0714_subscription_workspace_managed_organization_accounts.sql";
// 0715 rewrites routines 0714 creates, so a deployment before 0714 is also
// before it: held back and replayed after 0714.
const API_KEY_CONNECTIONS = "0715_subscription_core_api_key_connections.sql";
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 83);
const MODEL = "codex/gpt-5.5";

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let staged: {
  accountId: string;
  ownerSubjectId: string;
  connectionId: string;
  before: Record<string, unknown>;
  refusedBefore: string | null;
} | null = null;

function appUrl(): string {
  const url = new URL(database!.ownerUrl);
  url.username = "opengeni_app";
  url.password = database!.appPassword;
  return url.toString();
}

/** Every subscription row of the organization, read past row security. */
async function snapshot(accountId: string): Promise<Record<string, unknown>> {
  const tables = await database!.admin<{ schema: string; name: string }[]>`
    select table_schema as schema, table_name as name from information_schema.columns
    where column_name = 'account_id' and table_name like 'subscription%'
      and table_schema in ('public', 'opengeni_private')
    order by table_schema, table_name`;
  const rows: Record<string, unknown> = {};
  for (const table of tables) {
    const [row] = await database!.admin.unsafe<{ rows: unknown }[]>(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as rows
       from "${table.schema}"."${table.name}" t where t.account_id = $1::uuid`,
      [accountId],
    );
    rows[`${table.schema}.${table.name}`] = row!.rows;
  }
  return rows;
}

/** The organization reach setter as an organization administrator; the error code, if refused. */
async function setReach(accountId: string, subjectId: string, connectionId: string) {
  try {
    await withRlsContext(client!.db, { accountId, workspaceId: null }, async (tx) => {
      await setSubjectRlsContext(tx, subjectId);
      await rawRows(
        tx,
        sql`select opengeni_private.set_subscription_core_reach(
          'codex', ${accountId}::uuid, ${connectionId}::uuid, true, false)`,
      );
    });
    return null;
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code;
    return code ?? (error as { cause?: { code?: string } }).cause?.code ?? "error";
  }
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("migration-0714-workspace-managed");
  if (!database) throw new Error("Real PostgreSQL is required");
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${MIGRATION}), (${API_KEY_CONNECTIONS})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  client = createDb(appUrl(), { max: 2 });

  const admin = database.admin;
  const userId = `migration-0714-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "0714 fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Design')
    returning id::text as id`;
  const workspaceId = workspace!.id;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${ownerSubjectId}, 'owner')`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}::uuid, ${accountId}::uuid)`;
  // The former workspace account, as 0689 left it.
  const [connection] = await admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at,
      label, managed_by_workspace_id
    ) values (
      ${accountId}::uuid, 'codex', 'subscription',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: "a", refresh_token: "r" }))},
      'shared', 'workspaces', false, 'chatgpt-design', 'pro',
      ${admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      'Design team plan', ${workspaceId}::uuid
    ) returning id::text as id`;
  const connectionId = connection!.id;
  await admin`insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
    values (${accountId}::uuid, ${connectionId}::uuid, ${workspaceId}::uuid)`;
  await admin`insert into subscription_connection_assignment_policies (
      account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
    ) values (${accountId}::uuid, ${connectionId}::uuid, ${workspaceId}::uuid, 'workspace',
      ${workspaceId}::uuid)`;
  // A member's personal connection next to it.
  const memberSubject = `user:migration-0714-member-${crypto.randomUUID()}`;
  const [personalWorkspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal workspace')
    returning id::text as id`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${accountId}::uuid, ${memberSubject}, 'member', 'active', ${personalWorkspace!.id}::uuid)
    returning id::text as id`;
  const personalId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (${authorityId}::uuid, ${accountId}::uuid, ${membership!.id}::uuid,
      'subscription_connection', ${personalId}::uuid, 1, 'active')`;
  await admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation, provider_account_id, provider_state
    ) values (${personalId}::uuid, ${accountId}::uuid, 'codex',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: personalId }))},
      'personal', 'people', ${membership!.id}::uuid, ${memberSubject},
      ${authorityId}::uuid, 'subscription_connection', 1, ${`chatgpt-${personalId}`},
      ${admin.json({ isFedramp: false })}::jsonb)`;
  // Its alias, an explicit pin waiting for it, a live lease and its Apps designation.
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into subscription_connection_aliases
      (account_id, provider, alias_connection_id, connection_id)
      values (${accountId}::uuid, 'codex', ${crypto.randomUUID()}::uuid, ${connectionId}::uuid)`;
    await tx`insert into subscription_session_bindings (
        account_id, workspace_id, session_id, provider, connection_id, model_id, choice
      ) values (${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        'codex', ${connectionId}::uuid, ${MODEL}, 'explicit')`;
    await tx`insert into subscription_capacity_waiters
        (account_id, workspace_id, session_id, turn_id, provider, wait_reason)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        ${turnId}::uuid, 'codex', 'pinned_account_unavailable')`;
    await tx`insert into subscription_leases (account_id, workspace_id, session_id, turn_id,
        connection_id, provider, holder_id, generation, leased_until)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid,
        ${turnId}::uuid, ${connectionId}::uuid, 'codex', 'holder', 1, now() + interval '5 minutes')`;
    await tx`insert into subscription_apps_designations
        (account_id, workspace_id, connection_id, updated_by_subject_id)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${connectionId}::uuid, ${ownerSubjectId})`;
  });
  // Before 0714 the organization reach setter refuses a managed connection.
  const refusedBefore = await setReach(accountId, ownerSubjectId, connectionId);
  const before = await snapshot(accountId);

  const applying = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await applying`delete from schema_migrations where name in (${MIGRATION}, ${API_KEY_CONNECTIONS})`;
    await migrate(database.ownerUrl);
    const [applied] = await applying<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${MIGRATION}`;
    if (applied?.count !== 1) throw new Error("0714 was not applied by the second migrate");
  } finally {
    await applying.end();
  }
  staged = { accountId, ownerSubjectId, connectionId, before, refusedBefore };
}, 600_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("migration 0714 moves no row", () => {
  test("the runtime role is neither superuser nor able to bypass row-level security", async () => {
    const [role] = await client!.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test("applied by the owner, it leaves every subscription row identical, pins, waits and leases included", async () => {
    const after = await snapshot(staged!.accountId);
    expect(after).toEqual(staged!.before);
    // The fixture is really there: the comparison is not of empty tables.
    for (const table of [
      "public.subscription_connections",
      "public.subscription_connection_aliases",
      "public.subscription_session_bindings",
      "public.subscription_capacity_waiters",
      "public.subscription_leases",
      "public.subscription_apps_designations",
    ])
      expect((after[table] as unknown[]).length).toBeGreaterThan(0);
    expect(
      (after["public.subscription_connections"] as { ownership: string }[])
        .map((row) => row.ownership)
        .sort(),
    ).toEqual(["personal", "shared"]);
  });

  test("only then may an organization administrator choose its reach", async () => {
    expect(staged!.refusedBefore).toBe("P0002");
    expect(
      await setReach(staged!.accountId, staged!.ownerSubjectId, staged!.connectionId),
    ).toBeNull();
  });
});
