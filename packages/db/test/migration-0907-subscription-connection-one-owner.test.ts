/**
 * Migration 0907 (docs/subscription-accounts.md D-50): every shared
 * subscription connection gets one owner and serves exactly where it reaches.
 * On a real database whose owner is NOSUPERUSER and NOBYPASSRLS, the
 * per-workspace own/organization pool rows and the per-workspace source
 * preference fold into each connection's reach, owner and switch, and every
 * workspace keeps exactly the connections it used before.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { executeMigrationFile, migrate } from "../src/migrate";

const FILE = "0907_subscription_connection_one_owner.sql";
const migration = await readFile(new URL(`../drizzle/${FILE}`, import.meta.url), "utf8");
let owned: OwnerMigratedTestDatabase;
let admin: postgres.Sql;
let owner: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("migration-0907-one-owner");
  if (!acquired) throw new Error("Real PostgreSQL required");
  owned = acquired;
  // Migrate to just before 0907, then replay it over the old shapes.
  const setup = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  await setup.unsafe(
    `CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
  );
  await setup`insert into schema_migrations (name) values (${FILE})`;
  await setup.end();
  await migrate(owned.ownerUrl);
  admin = owned.admin;
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);
afterAll(async () => {
  await owner?.end();
  await owned?.release();
}, 60_000);

type Pool = "workspace" | "organization";

test("folds pool rows and the source preference into one owner and reach per connection", async () => {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('org') returning id`;
  const accountId = account!.id;
  const fixture = async (run: (tx: postgres.TransactionSql) => Promise<void>) =>
    admin.begin(async (tx) => {
      // Rows exactly as the previous release stored them; no trigger rewrites them.
      await tx`set local session_replication_role = replica`;
      await run(tx);
    });
  const workspace = async (name: string) =>
    (
      await admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`
    )[0]!.id;
  const alpha = await workspace("alpha");
  const beta = await workspace("beta");
  const gamma = await workspace("gamma");
  const personal = await workspace("personal");
  await fixture(async (tx) => {
    await tx`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${accountId}, 'user:owner', 'active', ${personal})`;
  });

  const connection = async (input: {
    scope: "organization" | "workspaces";
    on?: boolean;
    personal?: boolean;
    manager?: string | null;
    reach?: string[];
    pools?: Array<[string, Pool, boolean, string[]?]>;
    models?: string[] | null;
  }) => {
    const id = crypto.randomUUID();
    await fixture(async (tx) => {
      await tx`insert into subscription_connections (id, account_id, provider, kind,
          credential_encrypted, credential_format, provider_account_id, plan_type, ownership,
          scope_kind, status, allocator_enabled, allow_personal_workspaces, managed_by_workspace_id,
          allowed_model_ids)
        values (${id}, ${accountId}, 'codex', 'subscription', 'fixture', 'v1', ${crypto.randomUUID()},
          'pro', 'shared', ${input.scope}, 'active', ${input.on ?? true}, ${input.personal ?? false},
          ${input.manager ?? null}, ${input.models ?? null})`;
      for (const workspaceId of input.reach ?? []) {
        await tx`insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
          values (${accountId}, ${id}, ${workspaceId})`;
      }
      for (const [workspaceId, pool, enabled, models] of input.pools ?? []) {
        await tx`insert into subscription_connection_assignment_policies (account_id, connection_id,
            workspace_id, inference_pool, allocator_enabled, allowed_model_ids, excluded_models,
            managed_by_workspace_id)
          values (${accountId}, ${id}, ${workspaceId}, ${pool}, ${enabled}, ${models ?? null}, '{}',
            ${pool === "workspace" ? workspaceId : null})`;
      }
    });
    return id;
  };

  // Beta serves only its own accounts; gamma only the organization's.
  await fixture(async (tx) => {
    await tx`insert into subscription_settings (account_id, workspace_id, providers) values
      (${accountId}, ${beta}, ${tx.json({ codex: { inferenceSource: "workspace", useOrganizationAccounts: false } })}),
      (${accountId}, ${gamma}, ${tx.json({ codex: { inferenceSource: "organization", useOrganizationAccounts: true, enabled: true } })})`;
  });

  // Organization-wide, no pool rows: everywhere but beta.
  const orgWide = await connection({ scope: "organization", personal: true });
  // Beta's own account, also offered to alpha by the organization but off there.
  const betaOwn = await connection({
    scope: "workspaces",
    manager: beta,
    reach: [alpha, beta],
    pools: [
      [beta, "workspace", true],
      [alpha, "organization", false],
    ],
  });
  // Managed by alpha but used by alpha and gamma: the organization's now.
  const sharedOut = await connection({
    scope: "workspaces",
    manager: alpha,
    reach: [alpha, gamma],
    pools: [
      [alpha, "workspace", true],
      [gamma, "organization", true],
    ],
  });
  // No manager, used only as alpha's own copy: alpha's.
  const alphaCopy = await connection({
    scope: "workspaces",
    reach: [alpha],
    pools: [[alpha, "workspace", true]],
  });
  // Listed in alpha and gamma, switched off in both: kept listed, switched off.
  const unused = await connection({
    scope: "workspaces",
    reach: [alpha, gamma],
    pools: [
      [alpha, "organization", false],
      [gamma, "organization", false],
    ],
  });
  // Narrowed by its policies wherever it was used: their union becomes its own
  // list, intersected with the connection's.
  const narrowed = await connection({
    scope: "workspaces",
    reach: [alpha, gamma],
    models: ["codex/a", "codex/b", "codex/c"],
    pools: [
      [alpha, "organization", true, ["codex/a"]],
      [gamma, "organization", true, ["codex/b", "codex/z"]],
    ],
  });
  // Unrestricted in one workspace that used it: its list stays.
  const partly = await connection({
    scope: "workspaces",
    reach: [alpha, gamma],
    pools: [
      [alpha, "organization", true, ["codex/a"]],
      [gamma, "organization", true],
    ],
  });
  await fixture(async (tx) => {
    await tx`insert into opengeni_private.subscription_core_auto_assignments (account_id, provider,
        connection_id, shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
      values (${accountId}, 'codex', ${unused}, true, false, false, null)`;
  });

  await owner.begin(async (tx) => {
    await executeMigrationFile(tx as unknown as postgres.Sql, FILE, migration);
  });

  const state = async (id: string) => {
    const [row] = await admin<
      Array<{
        scope_kind: string;
        allow_personal_workspaces: boolean;
        allocator_enabled: boolean;
        managed_by_workspace_id: string | null;
      }>
    >`select scope_kind, allow_personal_workspaces, allocator_enabled, managed_by_workspace_id
      from subscription_connections where id = ${id}`;
    const reach = await admin<Array<{ workspace_id: string }>>`
      select workspace_id from subscription_connection_workspaces where connection_id = ${id}
      order by workspace_id`;
    return {
      scope: row!.scope_kind,
      personal: row!.allow_personal_workspaces,
      on: row!.allocator_enabled,
      owner: row!.managed_by_workspace_id,
      reach: reach.map((entry) => entry.workspace_id),
    };
  };
  const sorted = (...ids: string[]) => [...ids].sort();

  expect(await state(orgWide)).toEqual({
    scope: "workspaces",
    personal: true,
    on: true,
    owner: null,
    reach: sorted(alpha, gamma),
  });
  expect(await state(betaOwn)).toEqual({
    scope: "workspaces",
    personal: false,
    on: true,
    owner: beta,
    reach: [beta],
  });
  expect(await state(sharedOut)).toEqual({
    scope: "workspaces",
    personal: false,
    on: true,
    owner: null,
    reach: sorted(alpha, gamma),
  });
  expect(await state(alphaCopy)).toEqual({
    scope: "workspaces",
    personal: false,
    on: true,
    owner: alpha,
    reach: [alpha],
  });
  expect(await state(unused)).toEqual({
    scope: "workspaces",
    personal: false,
    on: false,
    owner: null,
    reach: sorted(alpha, gamma),
  });

  const models = async (id: string) =>
    (
      await admin<Array<{ allowed_model_ids: string[] | null }>>`
        select allowed_model_ids from subscription_connections where id = ${id}`
    )[0]!.allowed_model_ids;
  expect(await models(narrowed)).toEqual(["codex/a", "codex/b"]);
  expect(await models(partly)).toBeNull();
  expect(await models(orgWide)).toBeNull();

  const [policies] = await admin<Array<{ count: number }>>`
    select count(*)::int as count from subscription_connection_assignment_policies`;
  expect(policies!.count).toBe(0);
  const settings = await admin<Array<{ workspace_id: string; providers: unknown }>>`
    select workspace_id, providers from subscription_settings
    where account_id = ${accountId} and workspace_id is not null order by workspace_id`;
  expect(Object.fromEntries(settings.map((row) => [row.workspace_id, row.providers]))).toEqual({
    [beta]: {},
    [gamma]: { codex: { enabled: true } },
  });
  // The organization-wide account keeps reaching shared workspaces added later.
  const [reach] = await admin<Array<{ shared_workspaces: boolean; personal_workspaces: boolean }>>`
    select shared_workspaces, personal_workspaces
    from opengeni_private.subscription_core_auto_assignments where connection_id = ${orgWide}`;
  expect(reach).toEqual({ shared_workspaces: true, personal_workspaces: true });

  // A workspace's own connection cannot reach anywhere else.
  const settle = (query: PromiseLike<unknown>) => Promise.resolve(query);
  await expect(
    settle(admin`insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
      values (${accountId}, ${betaOwn}, ${alpha})`),
  ).rejects.toThrow(/serves only that workspace/);
  await expect(
    settle(
      admin`update subscription_connections set managed_by_workspace_id = ${alpha} where id = ${unused}`,
    ),
  ).rejects.toThrow(/serves only that workspace/);
  await expect(
    fixture(async (tx) => {
      await tx`update subscription_connections set scope_kind = 'organization' where id = ${betaOwn}`;
    }),
  ).rejects.toThrow(/subscription_connections_workspace_owner_reach_chk/);

  // A new shared workspace joins the organization's reach without pool rows.
  const delta = await workspace("delta");
  const joined = await admin<Array<{ connection_id: string }>>`
    select connection_id from subscription_connection_workspaces
    where workspace_id = ${delta} order by connection_id`;
  expect(joined.map((row) => row.connection_id)).toEqual(sorted(orgWide, unused));
  const [after] = await admin<Array<{ count: number }>>`
    select count(*)::int as count from subscription_connection_assignment_policies`;
  expect(after!.count).toBe(0);

  const forced = await admin<Array<{ relname: string; force: boolean }>>`
    select relname, relforcerowsecurity as force from pg_class
    where relname in ('subscription_connections', 'subscription_connection_workspaces',
      'subscription_connection_assignment_policies', 'subscription_settings')`;
  expect(forced.every((row) => row.force)).toBe(true);
  const [guard] = await admin<Array<{ enabled: string }>>`
    select tgenabled as enabled from pg_trigger
    where tgname = 'subscription_connections_scope_guard'`;
  expect(guard!.enabled).toBe("O");
}, 120_000);
