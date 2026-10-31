import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

const migration = "1143_drop_retired_provider_waiters.sql";
const providers = ["claude", "codex", "xai"] as const;
const names = [
  "list_continuable_sessions",
  "assert_session_tenancy_quiescent",
  "activate_session_tenancy_product",
  "organization_membership_command_0263",
  "workspace_membership_removal_command",
];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let owner: postgres.Sql | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string };
let sessionId: string;
let turnId: string;
let before: Array<{ name: string; body: string }>;

async function definitions() {
  return Array.from(
    await owned!.admin<{ name: string; body: string }[]>`
      select p.proname as name, p.prosrc as body
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'opengeni_private')
        and p.proname = any(${names}::text[])
      order by p.proname`,
  );
}

function applyContract() {
  return migrate(owned!.ownerUrl, undefined, { migrationsDirectory: prefix! });
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("retired-provider-waiter-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for waiter contraction");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-waiter-contract-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "waiter-retirement-test",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "waiter-retirement-test",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Waiter retirement",
    workspaceName: "Waiter retirement",
    subjectId: "waiter-retirement-test",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "current queued work",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  await initializeSessionStartAtomically(client.db, {
    ...scope,
    sessionId,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const [turn] = await owned.admin<{ id: string }[]>`
    select id from session_turns where session_id = ${sessionId} order by position limit 1`;
  if (!turn) throw new Error("Current session admission did not enqueue its turn");
  turnId = turn.id;
  before = await definitions();
  expect(before).toHaveLength(5);
  expect(before.every((routine) => /(?:codex|xai)_capacity_waiters/.test(routine.body))).toBe(true);
  await copyFile(join(source, migration), join(prefix, migration));
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function seedOldWaiter(provider: (typeof providers)[number], status: string) {
  const id = crypto.randomUUID();
  const extra = provider === "codex" ? "reset_kind" : "authority_scope";
  const value = provider === "codex" ? "bounded_refresh" : "workspace";
  await owned!.admin.unsafe(
    `insert into ${provider}_capacity_waiters (
      id, account_id, workspace_id, session_id, blocked_turn_id,
      blocked_turn_generation, workflow_id, status, next_check_at, ${extra}
    ) values ($1, $2, $3, $4, $5, 1, $6, $7, now(), $8)`,
    [
      id,
      scope.accountId,
      scope.workspaceId,
      sessionId,
      turnId,
      `retirement-${sessionId}`,
      status,
      value,
    ],
  );
  return id;
}

async function assertRolledBack() {
  expect(await definitions()).toEqual(before);
  const tables = await owned!.admin<{ name: string; forced: boolean }[]>`
    select c.relname as name, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(${providers.map((provider) => `${provider}_capacity_waiters`)}::text[])
    order by c.relname`;
  expect(Array.from(tables)).toEqual(
    providers.map((provider) => ({ name: `${provider}_capacity_waiters`, forced: true })),
  );
  const [state] = await owned!.admin<{ applied: boolean }[]>`
    select exists(select 1 from schema_migrations where name = ${migration}) as applied`;
  expect(state?.applied).toBe(false);
  await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
}

describe.skipIf(!realDatabase)("retired provider capacity-waiter contraction", () => {
  test("runs as the actual non-superuser, non-bypass migration owner", async () => {
    const [role] = await owner!<{ superuser: boolean; bypass: boolean }[]>`
      select rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`;
    expect(role).toEqual({ superuser: false, bypass: false });
    await assertRolledBack();
  }, 180_000);

  for (const provider of providers) {
    test(`${provider}: a waiting row hidden by FORCE RLS refuses the whole contraction`, async () => {
      const id = await seedOldWaiter(provider, "waiting");
      try {
        expect(await owner!.unsafe(`select id from ${provider}_capacity_waiters`)).toHaveLength(0);
        await expect(applyContract()).rejects.toThrow(
          "retired provider capacity waiters must be settled",
        );
        await assertRolledBack();
      } finally {
        await owned!.admin.unsafe(`delete from ${provider}_capacity_waiters where id = $1`, [id]);
      }
    }, 180_000);
  }

  test("an unexpected view blocks RESTRICT and rolls back every caller replacement", async () => {
    await owner!.unsafe(
      "create view unexpected_old_waiter_reader as select id from codex_capacity_waiters",
    );
    try {
      await expect(applyContract()).rejects.toThrow("depend");
      await assertRolledBack();
    } finally {
      await owner!.unsafe("drop view unexpected_old_waiter_reader");
    }
  }, 180_000);

  test("drops only settled old waits and retains current work, caller identities and readiness", async () => {
    for (const provider of providers) await seedOldWaiter(provider, "superseded");
    await owned!.admin`
      insert into subscription_capacity_waiters
        (account_id, workspace_id, session_id, turn_id, provider, wait_reason)
      values (${scope.accountId}, ${scope.workspaceId}, ${sessionId}, ${turnId}, 'codex', 'capacity')`;
    const current = await owned!
      .admin`select * from subscription_capacity_waiters where turn_id = ${turnId}`;
    const turn = await owned!.admin`select * from session_turns where id = ${turnId}`;
    const identities = await owned!.admin`
      select p.oid, p.proowner, p.proacl, p.prosecdef, p.prorettype
      from pg_proc p where p.proname = any(${names}::text[]) order by p.oid`;
    await applyContract();
    expect(
      await owned!.admin`select * from subscription_capacity_waiters where turn_id = ${turnId}`,
    ).toEqual(current);
    expect(await owned!.admin`select * from session_turns where id = ${turnId}`).toEqual(turn);
    expect(
      await owned!.admin`
      select p.oid, p.proowner, p.proacl, p.prosecdef, p.prorettype
      from pg_proc p where p.proname = any(${names}::text[]) order by p.oid`,
    ).toEqual(identities);
    for (const provider of providers) {
      const [table] = await owned!.admin<{ present: boolean }[]>`
        select to_regclass(${`public.${provider}_capacity_waiters`}) is not null as present`;
      expect(table?.present).toBe(false);
    }
    const after = await definitions();
    expect(after).toHaveLength(5);
    for (const routine of after)
      expect(routine.body).not.toMatch(/(?:codex|xai|claude)_capacity_waiters/);
    const remaining = await owned!.admin`
      select p.oid::regprocedure::text as routine
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'opengeni_private')
        and p.prokind in ('f', 'p')
        and p.prosrc ~ '(codex|xai|claude)_capacity_waiters'`;
    expect(remaining).toHaveLength(0);
    expect(after.find((routine) => routine.name === "list_continuable_sessions")?.body).toContain(
      "subscription_capacity_waiters",
    );
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await applyContract();
    expect(await definitions()).toEqual(after);
  }, 180_000);
});
