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
  createRig,
  createSession,
  initializeSessionStartAtomically,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import { attachLegacyVariableSets } from "./helpers/legacy-variable-sets";

const migration = "1123_drop_retired_variable_set_tables.sql";
const tables = [
  "session_variable_set_attachments",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
  "variable_set_authority_capabilities",
];
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let owner: postgres.Sql | null = null;
let prefix: string | null = null;
let scope: { accountId: string; workspaceId: string };
let sessionId: string;
let setId: string;
let before: Awaited<ReturnType<typeof definitions>>;

async function definitions() {
  return Array.from(
    await owned!.admin`
    select p.oid, n.nspname, p.proname, p.prosrc, p.proowner, p.proacl,
      p.prosecdef, p.proconfig, p.prorettype
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'opengeni_private') and p.prokind in ('f', 'p')
    order by p.oid`,
  );
}

async function livePolicies() {
  return Array.from(
    await owned!.admin`
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname in ('public', 'opengeni_private')
      and tablename <> all(${tables}::text[])
      and policyname not like 'variable_set_authority_capability_%'
    order by schemaname, tablename, policyname`,
  );
}

function applyContract() {
  return migrate(owned!.ownerUrl, undefined, { migrationsDirectory: prefix! });
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("retired-variable-set-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for Variable Set contraction");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-variable-set-contract-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source))
    if (name.endsWith(".sql") && name < migration)
      await copyFile(join(source, name), join(prefix, name));
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  owner = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "variable-set-retirement-test",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "variable-set-retirement-test",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Variable Set retirement",
    workspaceName: "Variable Set retirement",
    subjectId: "variable-set-retirement-test",
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "current accepted work",
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
  const [row] = await owned.admin<{ id: string }[]>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${scope.accountId}, ${scope.workspaceId}, 'empty-retired-set') returning id`;
  setId = row!.id;
  await attachLegacyVariableSets(client.db, {
    workspaceId: scope.workspaceId,
    sessionId,
    variableSetIds: [setId],
  });
  before = await definitions();
  await copyFile(join(source, migration), join(prefix, migration));
}, 600_000);

afterAll(async () => {
  await client?.close();
  await owner?.end();
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

async function assertRolledBack() {
  expect(await definitions()).toEqual(before);
  const rows = await owned!.admin<{ name: string; forced: boolean }[]>`
    select c.relname as name, c.relforcerowsecurity as forced
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'opengeni_private') and c.relname = any(${tables}::text[])
    order by c.relname`;
  expect(Array.from(rows)).toEqual(
    [...tables]
      .sort()
      .map((name) => ({ name, forced: name !== "variable_set_authority_capabilities" })),
  );
}

describe.skipIf(!realDatabase)("retired Variable Set table contraction", () => {
  test("the owner cannot mistake FORCE-RLS-hidden secret values for an empty feature", async () => {
    await owned!.admin`
      insert into workspace_variable_set_variables
        (account_id, workspace_id, variable_set_id, name, value_encrypted)
      values (${scope.accountId}, ${scope.workspaceId}, ${setId}, 'TEST_ONLY', 'test-ciphertext')`;
    try {
      const [role] =
        await owner!`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      expect(await owner!`select id from workspace_variable_set_variables`).toHaveLength(0);
      await expect(applyContract()).rejects.toThrow("values must migrate to vaults");
      await assertRolledBack();
    } finally {
      await owned!
        .admin`delete from workspace_variable_set_variables where variable_set_id = ${setId}`;
    }
  }, 180_000);

  test("even an empty personal set refuses contraction instead of rewriting its authority", async () => {
    const id = crypto.randomUUID();
    await owned!.admin.begin(async (tx) => {
      // A hidden source shape is sufficient for this negative control; do not
      // manufacture authority receipts or weaken production FK constraints.
      await tx`set local session_replication_role = replica`;
      await tx`insert into workspace_variable_sets
        (id, account_id, workspace_id, name, authority_scope, authority_id, owner_organization_membership_id)
        values (${id}, ${scope.accountId}, ${scope.workspaceId}, 'personal-negative-control', 'user', ${crypto.randomUUID()}, ${crypto.randomUUID()})`;
    });
    try {
      await expect(applyContract()).rejects.toThrow("personal Variable Set authority");
      await assertRolledBack();
    } finally {
      await owned!.admin`delete from workspace_variable_sets where id = ${id}`;
    }
  }, 180_000);

  test("unexpected dependents roll back every SQL, policy, grant and RLS change", async () => {
    await owner!`create view unexpected_variable_set_reader as select id from workspace_variable_sets`;
    try {
      const policies = await livePolicies();
      await expect(applyContract()).rejects.toThrow();
      await assertRolledBack();
      expect(await livePolicies()).toEqual(policies);
    } finally {
      await owner!`drop view unexpected_variable_set_reader`;
    }
  }, 180_000);

  test("drops the closed legacy group while retaining exact accepted work and all current policies", async () => {
    const turnRows = await owned!
      .admin`select * from session_turns where session_id = ${sessionId} order by id`;
    const sessionRows = await owned!.admin`select * from sessions where id = ${sessionId}`;
    const policies = await livePolicies();
    await applyContract();
    expect(
      await owned!.admin`select * from session_turns where session_id = ${sessionId} order by id`,
    ).toEqual(turnRows);
    expect(await owned!.admin`select * from sessions where id = ${sessionId}`).toEqual(sessionRows);
    expect(await livePolicies()).toEqual(policies);
    const after = await definitions();
    const survivingOids = new Set(after.map((row) => row.oid));
    const identity = ({ prosrc: _body, ...row }: (typeof before)[number]) => row;
    expect(after.map(identity)).toEqual(
      before.filter((row) => survivingOids.has(row.oid)).map(identity),
    );
    const pattern = `\\m(${tables.join("|")})\\M`;
    expect(
      await owned!.admin`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'opengeni_private') and c.relname = any(${tables}::text[])`,
    ).toHaveLength(0);
    expect(
      await owned!.admin`
      select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'opengeni_private') and p.prokind in ('f', 'p') and p.prosrc ~ ${pattern}`,
    ).toHaveLength(0);
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    await provisionRoles(owned!.adminUrl, { appPassword: owned!.appPassword });
    await assertRuntimeDatabasePosture(client!.db, { rlsStrategy: "force" });
    const rig = await createRig(client!.db, {
      ...scope,
      name: "post-contract",
      description: null,
      initialVersion: { setupScript: "echo test" },
    });
    expect(rig.name).toBe("post-contract");
    await applyContract();
    expect(await definitions()).toEqual(after);
  }, 180_000);
});
