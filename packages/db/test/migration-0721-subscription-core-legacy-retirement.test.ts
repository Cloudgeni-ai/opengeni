/**
 * Migration 0721: the drained M4 retirement (design
 * docs/design/subscription-core-2026-10-07.md, 5.3 "R. Retirement" and the
 * 0713 note "Kept until retirement"). On a real database whose owner is
 * NOSUPERUSER and NOBYPASSRLS, migrated through the SuperGrok (0719) and
 * Claude (0720) cutovers, the retirement refuses with a content-free error
 * and changes nothing unless the application sessions are drained, every
 * provider's cutover receipt is committed, every retired object exists
 * exactly as listed and nothing that stays depends on one. It then drops
 * exactly the listed objects, gives the reach objects their provider-free
 * names and keeps everything else; the runtime posture of this release is
 * clean afterwards as the restricted application role `opengeni_app`, and a
 * fresh install migrates through it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  retiredSubscriptionObjectDescriptions,
  retiredSubscriptionObjectViolation,
  SUBSCRIPTION_AUTO_ASSIGN_SETTING,
  SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES,
  SUBSCRIPTION_M3_OWNER_ONLY_PRIVATE_ROUTINES,
  SUBSCRIPTION_M3_PRECURSOR_PRIVATE_ROUTINES,
  SUBSCRIPTION_RENAMED_POLICIES,
  SUBSCRIPTION_RENAMED_RELATIONS,
  SUBSCRIPTION_RENAMED_ROUTINES,
  SUBSCRIPTION_RENAMED_TRIGGERS,
  SUBSCRIPTION_RETIRED_POLICIES,
  SUBSCRIPTION_RETIRED_ROUTINE_NAMES,
  SUBSCRIPTION_RETIRED_ROUTINES,
  SUBSCRIPTION_RETIRED_TRIGGERS,
  SUBSCRIPTION_RETIREMENT_MIGRATION,
  SUBSCRIPTION_SNAPSHOT_VALIDATOR_ROUTINES,
} from "../src/runtime-posture";
import { connectSubscriptionCoreConnection } from "../src/subscription-core/connections";
import { subscriptionCoreProvider } from "../src/subscription-core-providers";

const MIGRATION = SUBSCRIPTION_RETIREMENT_MIGRATION;
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const POSTURE = {
  rlsStrategy: "force" as const,
  expectedRole: "opengeni_app",
  targetSchema: "public",
};
const key = Buffer.alloc(32, 83);
/** What this release's posture reports on a database the retirement has not reached. */
const PENDING_RETIREMENT = retiredSubscriptionObjectDescriptions().map(
  retiredSubscriptionObjectViolation,
);
/** The setting 0689's owner-only auto-assignment policies read before 0721. */
const CODEX_AUTO_ASSIGN_SETTING = "opengeni.subscription_codex_auto_assign";
const CODEX_REACH = "opengeni_private.subscription_codex_auto_assignments";
const CORE_REACH = "opengeni_private.subscription_core_auto_assignments";
/** The reach table's constraints, which move with it under their names. */
const REACH_CONSTRAINTS = [
  "subscription_codex_auto_assignmen_account_id_connection_id_fkey",
  "subscription_codex_auto_assignments_check",
  "subscription_codex_auto_assignments_pkey",
  "subscription_codex_auto_assignments_provider_fkey",
];
const REACH_PROVIDER_KEY = "subscription_core_auto_assignments_connection_provider_fkey";
const FACTORY_TABLES = Object.values(SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES).flat().sort();
/**
 * The X3/C3 restrictive policies the retirement keeps: 0719 closes each
 * SuperGrok table with one policy, 0720 each Claude table with one per write
 * command, and both close their personal authority kind.
 */
const CLOSED_POLICIES = [
  ...SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES.xai!.map((table) => `policy ${table}.${table}_closed`),
  ...SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES.claude!.flatMap((table) => [
    `policy ${table}.${table}_closed_insert`,
    `policy ${table}.${table}_closed_update`,
  ]),
  "policy organization_user_resource_authorities.claude_subscription_authority_closed",
  "policy organization_user_resource_authorities.xai_subscription_authority_closed",
].sort();
/** The factory tables the retirement leaves without any permissive policy. */
const POLICYLESS_FACTORY_TABLES = [
  "claude_capacity_waiters",
  "claude_session_account_pins",
  "claude_subscription_account_usage",
  "xai_capacity_waiters",
  "xai_session_account_pins",
];
const NO_CHANGE = { removed: [], added: [], changed: [] };
/** Stored v1 SuperGrok and Claude authority values, which X4 and C4 keep deciding on. */
const V1_VALUES = "(xai|claude)_provider_account_authority_snapshot";

/** A posture signature (`oidvectortypes` form) as `regprocedure` prints it to the admin. */
const regprocedure = (schema: string, signature: string) =>
  `${schema === "target" ? "" : `${schema}.`}${signature.replaceAll(", ", ",")}`;

/**
 * Whether SQL text names one of the objects, literally or as a name built at
 * run time around its provider token: a format() pattern
 * (`'resolve_%s_authority_pool'`) or the literals of a concatenation
 * (`'resolve_' || provider || '_authority_pool'`), the shapes the
 * migration's preflight refuses.
 */
function namesAny(body: string, names: readonly string[]): boolean {
  if (new RegExp(`(?<![A-Za-z0-9_])(?:${names.join("|")})(?![A-Za-z0-9_])`, "i").test(body))
    return true;
  const boundary = String.raw`(?:'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$|%[-0-9$*]*[sIL])`;
  return names.some((name) => {
    const [, head, , tail] = /^(.*?)(xai|claude|codex)(.*)$/.exec(name)!;
    return (
      new RegExp(`${boundary}${tail}(?![A-Za-z0-9_])`, "i").test(body) &&
      (head === "" || new RegExp(`(?<![A-Za-z0-9_])${head}${boundary}`, "i").test(body))
    );
  });
}

type Catalog = Map<string, string>;
type Org = { accountId: string; ownerSubjectId: string };
type SqlText = { object: string; digest: string; body: string };

let database: OwnerMigratedTestDatabase | null = null;
let owner: postgres.Sql | null = null;
let org: Org;
let connections: Record<"reach" | "mismatch" | "keyed", string>;
let pending: Catalog;
let retired: Catalog;
let v1Pending: SqlText[];

/** Every routine, policy, trigger, relation and constraint the retirement could touch. */
async function catalog(db = database!): Promise<Catalog> {
  const admin = db.admin;
  const entries: Catalog = new Map();
  const add = (kind: string, rows: readonly { key: string; value: string }[]) => {
    for (const row of rows) entries.set(`${kind} ${row.key}`, row.value);
  };
  add(
    "routine",
    await admin<{ key: string; value: string }[]>`
      select proc.oid::regprocedure::text as key,
        concat_ws(' | ', proc.prosecdef::text, coalesce(proc.proconfig::text, '-'),
          coalesce(proc.proacl::text, '-'), pg_get_userbyid(proc.proowner),
          md5(coalesce(proc.prosrc, '') || coalesce(pg_get_function_sqlbody(proc.oid), ''))) as value
      from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname in ('public', 'opengeni_private', 'opengeni_subscription_internal')`,
  );
  add(
    "policy",
    await admin<{ key: string; value: string }[]>`
      select polrelid::regclass::text || '.' || polname as key,
        concat_ws(' | ', polcmd, polpermissive::text, array_to_string(polroles, ','),
          coalesce(pg_get_expr(polqual, polrelid), '-'),
          coalesce(pg_get_expr(polwithcheck, polrelid), '-')) as value
      from pg_policy`,
  );
  add(
    "trigger",
    await admin<{ key: string; value: string }[]>`
      select tgrelid::regclass::text || '.' || tgname as key,
        pg_get_triggerdef(oid) || ' | ' || tgenabled::text as value
      from pg_trigger where not tgisinternal`,
  );
  add(
    "relation",
    await admin<{ key: string; value: string }[]>`
      select relation.oid::regclass::text as key,
        concat_ws(' | ', relation.relkind::text, coalesce(relation.relacl::text, '-'),
          relation.relrowsecurity::text, relation.relforcerowsecurity::text,
          pg_get_userbyid(relation.relowner)) as value
      from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'opengeni_private', 'opengeni_subscription_internal')
        and relation.relkind in ('r', 'p', 'v', 'm', 'i')`,
  );
  add(
    "constraint",
    await admin<{ key: string; value: string }[]>`
      select constraint_row.conrelid::regclass::text || '.' || constraint_row.conname as key,
        pg_get_constraintdef(constraint_row.oid) || ' | ' || constraint_row.convalidated::text
          as value
      from pg_constraint constraint_row
      join pg_namespace namespace on namespace.oid = constraint_row.connamespace
      where namespace.nspname in ('public', 'opengeni_private', 'opengeni_subscription_internal')
        and constraint_row.conrelid <> 0`,
  );
  return entries;
}

/** Every SQL text through which an object could name another, by object. */
async function sqlTexts(db = database!): Promise<SqlText[]> {
  return db.admin<SqlText[]>`
    select object, md5(body) as digest, body from (
      select 'routine ' || routine.oid::regprocedure::text as object,
        coalesce(routine.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(routine.oid), '') as body
      from pg_proc routine join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname not in ('pg_catalog', 'information_schema')
      union all
      select 'policy ' || policy.polrelid::regclass::text || '.' || policy.polname,
        coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') || ' '
          || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
      from pg_policy policy
      union all
      select 'trigger ' || trigger_row.tgrelid::regclass::text || '.' || trigger_row.tgname,
        pg_get_triggerdef(trigger_row.oid)
      from pg_trigger trigger_row where not trigger_row.tgisinternal
      union all
      select 'view ' || relation.oid::regclass::text, pg_get_viewdef(relation.oid)
      from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      where relation.relkind in ('v', 'm') and namespace.nspname not in ('pg_catalog', 'information_schema')
      union all
      select 'default ' || attribute_default.adrelid::regclass::text || '.' || attribute.attname,
        pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
      from pg_attrdef attribute_default join pg_attribute attribute
        on attribute.attrelid = attribute_default.adrelid and attribute.attnum = attribute_default.adnum
      union all
      select 'constraint ' || constraint_row.conname, pg_get_constraintdef(constraint_row.oid)
      from pg_constraint constraint_row
      join pg_namespace namespace on namespace.oid = constraint_row.connamespace
      where constraint_row.contype = 'c' and namespace.nspname not in ('pg_catalog', 'information_schema')
    ) texts
    order by object`;
}

/** The routines and policies whose SQL reads stored v1 SuperGrok or Claude authority values. */
async function v1Readers(db = database!): Promise<SqlText[]> {
  return (await sqlTexts(db)).filter(
    ({ object, body }) =>
      (object.startsWith("routine ") || object.startsWith("policy ")) &&
      new RegExp(V1_VALUES).test(body),
  );
}

function diff(before: Catalog, after: Catalog) {
  return {
    removed: [...before.keys()].filter((entry) => !after.has(entry)).sort(),
    added: [...after.keys()].filter((entry) => !before.has(entry)).sort(),
    changed: [...after.keys()]
      .filter((entry) => before.has(entry) && before.get(entry) !== after.get(entry))
      .sort(),
  };
}

function appUrl(db = database!): string {
  const url = new URL(db.ownerUrl);
  url.username = "opengeni_app";
  url.password = db.appPassword;
  return url.toString();
}

/** Waits until no application session is connected (a closed pool's backends exit asynchronously). */
async function drained(db = database!): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await db.admin<{ sessions: number }[]>`
      select count(*)::int as sessions from pg_stat_activity
      where datname = current_database() and usename = 'opengeni_app'`;
    if (row!.sessions === 0) return;
    await Bun.sleep(50);
  }
  throw new Error("application sessions did not drain");
}

/** The posture of this release, evaluated as the restricted application role. */
async function appPosture(db = database!): Promise<string[]> {
  const app = postgres(appUrl(db), { max: 1, onnotice: () => undefined });
  const client = createDb(appUrl(db), { max: 1 });
  try {
    const [identity] = await app<
      { role: string; superuser: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`select current_user as role, current_setting('is_superuser') as superuser,
        login.rolsuper, login.rolbypassrls
      from pg_roles login where login.rolname = current_user`;
    expect(identity).toEqual({
      role: "opengeni_app",
      superuser: "off",
      rolsuper: false,
      rolbypassrls: false,
    });
    return evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, POSTURE),
      POSTURE,
    );
  } finally {
    await client.close();
    await app.end();
    await drained(db);
  }
}

const applyRetirement = (db = database!) =>
  migrate(db.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });

async function ledger(db = database!): Promise<number> {
  const [row] = await db.admin<{ count: number }[]>`
    select count(*)::int as count from schema_migrations where name = ${MIGRATION}`;
  return row!.count;
}

async function receipts(db = database!): Promise<string[]> {
  const rows = await db.admin<{ provider: string }[]>`
    select provider from unnest(array['claude', 'codex', 'xai']) provider
    where opengeni_private.subscription_provider_cutover_committed(provider)
    order by provider`;
  return rows.map((row) => row.provider);
}

/** The retirement refuses with exactly this error and changes nothing. */
async function refused(code: string, message: string | RegExp): Promise<void> {
  const before = await catalog();
  const error = await applyRetirement().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect({ code: (error as { code?: string }).code, message: (error as Error).message }).toEqual({
    code,
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });
  expect(diff(before, await catalog())).toEqual(NO_CHANGE);
  expect(await ledger()).toBe(0);
}

async function workspace(
  sql: postgres.Sql | postgres.TransactionSql,
  accountId: string,
  subjectId: string,
  name: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, ${name})
    returning id::text as id`;
  await sql`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${row!.id}::uuid, ${subjectId}, 'owner')`;
  await sql`insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}::uuid, ${accountId}::uuid)`;
  return row!.id;
}

async function organization(client: DbClient): Promise<Org> {
  const userId = `core-retirement-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Subscription retirement",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  await database!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', true)
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
  return { accountId, ownerSubjectId: `user:${userId}` };
}

/** An organization-managed Codex connection on the shared core. */
async function codexConnection(client: DbClient, label: string): Promise<string> {
  const connected = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    connectSubscriptionCoreConnection(client.db, subscriptionCoreProvider("codex"), {
      accountId: org.accountId,
      workspaceId: null,
      subjectId: org.ownerSubjectId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: `a-${label}`, refresh_token: `r-${label}`, id_token: "i" }),
      ),
      providerAccountId: `upstream-${label}`,
      providerSubjectId: `person-${label}`,
      planType: "pro",
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: `${label}@example.test`,
      label,
      providerState: {},
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect failed: ${connected.kind}`);
  return connected.id;
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-core-legacy-retirement");
  if (!database) throw new Error("Real PostgreSQL is required");
  owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  // Through the SuperGrok and Claude cutovers, with the retirement withheld.
  await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  await owner`INSERT INTO schema_migrations(name) VALUES (${MIGRATION})`;
  await migrate(database.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await owner`DELETE FROM schema_migrations WHERE name = ${MIGRATION}`;
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  const client = createDb(appUrl(), { max: 2 });
  try {
    org = await organization(client);
    connections = {
      reach: await codexConnection(client, "retirement-reach"),
      mismatch: await codexConnection(client, "retirement-mismatch"),
      keyed: await codexConnection(client, "retirement-keyed"),
    };
  } finally {
    await client.close();
  }
  // A populated upgrade, not merely an empty reach-table validation. The
  // restricted migration owner must validate this row and preserve it.
  await database.admin`insert into ${database.admin(CODEX_REACH)}
      (account_id, provider, connection_id, shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
    values (${org.accountId}::uuid, 'codex', ${connections.reach}::uuid, true, false, true, null)`;
  // Forensic rows in two factory tables the runtime must never read again.
  await database.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const table of ["xai_session_account_pins", "claude_session_account_pins"]) {
      await tx`insert into ${tx(table)} (account_id, workspace_id, session_id)
        values (${org.accountId}::uuid, gen_random_uuid(), gen_random_uuid())`;
    }
  });
  await drained();
  pending = await catalog();
  v1Pending = await v1Readers();
}, 600_000);

afterAll(async () => {
  await owner?.end().catch(() => undefined);
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("migration 0721: the drained subscription legacy retirement", () => {
  test("the posture of this release reports exactly the pending retirement, as the application role", async () => {
    expect(await receipts()).toEqual(["claude", "codex", "xai"]);
    expect(await appPosture()).toEqual(PENDING_RETIREMENT);
  }, 180_000);

  test("plain SQL without the application role list refuses and changes nothing", async () => {
    const source = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
    const before = await catalog();
    await expect(Promise.resolve(owner!.unsafe(source))).rejects.toMatchObject({
      code: "55000",
      message: "0721 requires explicit application database roles",
    });
    expect(diff(before, await catalog())).toEqual(NO_CHANGE);
    expect(await ledger()).toBe(0);
  }, 180_000);

  test("provisioning before retirement never exposes the retired owner-only helpers", async () => {
    const ownerOnly = [
      "opengeni_private.subscription_codex_connection_target(uuid, uuid, uuid, uuid, uuid, text, bigint)",
      "opengeni_private.apply_subscription_codex_auto_assignments(uuid, uuid, boolean)",
      "opengeni_subscription_internal.subscription_codex_writer_context(uuid, uuid, text)",
      ...SUBSCRIPTION_RENAMED_ROUTINES.map(({ schema, from }) => `${schema}.${from}`),
    ];
    // Start with the previous release's owner-only ACL, then reprovision
    // with this release while the retired routines still exist.
    for (const routine of ownerOnly) {
      await database!.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${routine} FROM opengeni_app`);
    }
    const before = await catalog();
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    try {
      for (const routine of ownerOnly) {
        // Resolve as owner: the application cannot even name routines in
        // the internal schema, but its EXECUTE ACL must still be absent.
        const [target] = await owner!`select ${routine}::regprocedure::oid as oid`;
        const [access] =
          await app`select has_function_privilege(${target!.oid}::oid, 'EXECUTE') as executable`;
        expect({ routine, executable: access!.executable }).toEqual({ routine, executable: false });
      }
      await expect(
        Promise.resolve(app`select opengeni_private.subscription_codex_connection_target(
        NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::bigint)`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        Promise.resolve(app`select opengeni_private.apply_subscription_codex_auto_assignments(
        ${org.accountId}::uuid, gen_random_uuid(), false)`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
      await drained();
    }
    expect(diff(before, await catalog())).toEqual(NO_CHANGE);
  }, 180_000);

  test("a connected application session refuses (the window is not drained)", async () => {
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    try {
      await app`select 1`;
      await refused("55000", "0721 requires drained application sessions");
    } finally {
      await app.end();
      await drained();
    }
  }, 180_000);

  test("a connected login outside the role list that can use a retired object refuses", async () => {
    const role = `r0721_unlisted_${crypto.randomUUID().slice(0, 8)}`;
    const password = crypto.randomUUID().replaceAll("-", "");
    const name = new URL(database!.ownerUrl).pathname.slice(1);
    await database!.admin.unsafe(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    );
    await database!.admin.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    await database!.admin.unsafe(
      `GRANT EXECUTE ON FUNCTION xai_subscription_pool_visible(uuid, uuid, text, text, uuid) TO "${role}"`,
    );
    const url = new URL(database!.ownerUrl);
    url.username = role;
    url.password = password;
    const unlisted = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      await unlisted`select 1`;
      await refused(
        "55000",
        "0721 requires drained application sessions (a connected role outside the listed application roles can use a retired object)",
      );
    } finally {
      await unlisted.end();
      await database!.admin.unsafe(`DROP OWNED BY "${role}"`);
      await database!.admin.unsafe(`DROP ROLE "${role}"`);
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 180_000);

  test("connected NOINHERIT logins with transitive SET ROLE access refuse before and after switching", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const login = `r0721_login_${suffix}`;
    const bridge = `r0721_bridge_${suffix}`;
    const executor = `r0721_executor_${suffix}`;
    const password = crypto.randomUUID().replaceAll("-", "");
    const url = new URL(database!.ownerUrl);
    const name = url.pathname.slice(1);
    url.username = login;
    url.password = password;
    await database!.admin.unsafe(`CREATE ROLE "${executor}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await database!.admin.unsafe(
      `CREATE ROLE "${bridge}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`,
    );
    await database!.admin.unsafe(
      `CREATE ROLE "${login}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
    );
    const client = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      await database!.admin.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${login}"`);
      await database!.admin.unsafe(
        `GRANT "${executor}" TO "${bridge}" WITH INHERIT FALSE, SET TRUE`,
      );
      await database!.admin.unsafe(`GRANT "${bridge}" TO "${login}" WITH INHERIT FALSE, SET TRUE`);
      for (const access of ["routine", "table"] as const) {
        const object =
          access === "routine"
            ? "FUNCTION xai_subscription_pool_visible(uuid, uuid, text, text, uuid)"
            : "TABLE xai_rotation_settings";
        const privilege = access === "routine" ? "EXECUTE" : "UPDATE";
        await database!.admin.unsafe(`GRANT ${privilege} ON ${object} TO "${executor}"`);
        for (const switched of [false, true]) {
          await client.unsafe(switched ? `SET ROLE "${executor}"` : "RESET ROLE");
          const [authority] = await client`
            select current_user as effective_role, session_user as login_role,
              pg_has_role(session_user, ${executor}, 'SET') as can_set,
              has_function_privilege(session_user,
                'xai_subscription_pool_visible(uuid,uuid,text,text,uuid)', 'EXECUTE') as login_execute,
              has_table_privilege(session_user, 'xai_rotation_settings', 'UPDATE') as login_update`;
          expect(authority).toEqual({
            effective_role: switched ? executor : login,
            login_role: login,
            can_set: true,
            login_execute: false,
            login_update: false,
          });
          if (switched && access === "routine") {
            await client`select xai_subscription_pool_visible(NULL::uuid, NULL::uuid,
              NULL::text, NULL::text, NULL::uuid)`;
          }
          await refused(
            "55000",
            "0721 requires drained application sessions (a connected role outside the listed application roles can use a retired object)",
          );
        }
        await client`RESET ROLE`;
        await database!.admin.unsafe(`REVOKE ${privilege} ON ${object} FROM "${executor}"`);
      }
    } finally {
      await client.end();
      for (const role of [login, bridge, executor]) {
        await database!.admin.unsafe(`DROP OWNED BY "${role}"`);
        await database!.admin.unsafe(`DROP ROLE "${role}"`);
      }
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 180_000);

  test("a missing provider cutover receipt refuses, for Codex, SuperGrok and Claude", async () => {
    for (const provider of ["codex", "xai", "claude"]) {
      const [saved] = await database!.admin<
        { migration: string; committed_at: string; seed_rotation: string }[]
      >`select migration, committed_at::text as committed_at, seed_rotation::text as seed_rotation
        from opengeni_private.subscription_provider_cutover_receipts where provider = ${provider}`;
      expect(saved).toBeDefined();
      await database!.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`delete from opengeni_private.subscription_provider_cutover_receipts
          where provider = ${provider}`;
      });
      try {
        await refused(
          "55000",
          `0721 requires the committed cutover receipt of every provider; missing: ${provider}`,
        );
      } finally {
        // Bound as text: the Codex receipt's committed_at is '-infinity',
        // which the driver cannot carry as a Date.
        await database!.admin`
          insert into opengeni_private.subscription_provider_cutover_receipts
            (provider, migration, committed_at, seed_rotation)
          values (${provider}, ${saved!.migration}, ${saved!.committed_at}::text::timestamptz,
            ${saved!.seed_rotation}::text::jsonb)`;
      }
    }
    expect(await receipts()).toEqual(["claude", "codex", "xai"]);
  }, 300_000);

  test("a missing, renamed or extra retired object refuses (exact posture)", async () => {
    const cases = [
      {
        change: `ALTER FUNCTION resolve_xai_authority_pool(uuid, uuid, text, jsonb) RENAME TO resolve_xai_authority_pool_moved`,
        restore: `ALTER FUNCTION resolve_xai_authority_pool_moved(uuid, uuid, text, jsonb) RENAME TO resolve_xai_authority_pool`,
        message:
          /^0721 found a retired routine missing or changed: public\.resolve_xai_authority_pool\(/,
      },
      {
        change: `ALTER FUNCTION opengeni_subscription_internal.subscription_codex_writer_context(uuid, uuid, text) RENAME TO subscription_codex_writer_context_moved`,
        restore: `ALTER FUNCTION opengeni_subscription_internal.subscription_codex_writer_context_moved(uuid, uuid, text) RENAME TO subscription_codex_writer_context`,
        message:
          /^0721 found a retired routine missing or changed: opengeni_subscription_internal\./,
      },
      {
        change: `CREATE FUNCTION opengeni_private.subscription_codex_reach(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false'`,
        restore: `DROP FUNCTION opengeni_private.subscription_codex_reach(uuid)`,
        message:
          "0721 found an unexpected overload of a retired routine: opengeni_private.subscription_codex_reach(uuid); see the runbook",
      },
      {
        change: `ALTER POLICY claude_usage_account_scope ON claude_subscription_account_usage RENAME TO claude_usage_account_scope_moved`,
        restore: `ALTER POLICY claude_usage_account_scope_moved ON claude_subscription_account_usage RENAME TO claude_usage_account_scope`,
        message:
          "0721 found a retired policy missing: claude_subscription_account_usage.claude_usage_account_scope; see the runbook",
      },
      {
        change: `ALTER TRIGGER xai_pin_credential_pool_guard ON xai_session_account_pins RENAME TO xai_pin_credential_pool_guard_moved`,
        restore: `ALTER TRIGGER xai_pin_credential_pool_guard_moved ON xai_session_account_pins RENAME TO xai_pin_credential_pool_guard`,
        message:
          "0721 found a retired trigger missing or changed: xai_session_account_pins.xai_pin_credential_pool_guard.enforce_xai_credential_pool_reference; see the runbook",
      },
      {
        change: `ALTER TABLE ${CODEX_REACH} ALTER COLUMN provider DROP DEFAULT`,
        restore: `ALTER TABLE ${CODEX_REACH} ALTER COLUMN provider SET DEFAULT 'codex'`,
        message:
          "0721 found the reach table, its view, its default or the connection key changed; see the runbook",
      },
      {
        change: `ALTER TRIGGER workspaces_subscription_codex_auto_assign ON workspaces RENAME TO workspaces_subscription_codex_auto_assign_moved`,
        restore: `ALTER TRIGGER workspaces_subscription_codex_auto_assign_moved ON workspaces RENAME TO workspaces_subscription_codex_auto_assign`,
        message:
          "0721 found a reach trigger missing, changed or already renamed: workspaces.workspaces_subscription_codex_auto_assign; see the runbook",
      },
      {
        change: `ALTER POLICY subscription_connection_workspaces_codex_auto_assign ON subscription_connection_workspaces RENAME TO subscription_connection_workspaces_core_auto_assign`,
        restore: `ALTER POLICY subscription_connection_workspaces_core_auto_assign ON subscription_connection_workspaces RENAME TO subscription_connection_workspaces_codex_auto_assign`,
        message:
          "0721 found a reach policy missing, changed or already renamed: subscription_connection_workspaces.subscription_connection_workspaces_codex_auto_assign; see the runbook",
      },
    ];
    for (const { change, restore, message } of cases) {
      await database!.admin.unsafe(change);
      try {
        await refused("55000", message);
      } finally {
        await database!.admin.unsafe(restore);
      }
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 300_000);

  test("a kept object that depends on or names a retired object refuses", async () => {
    const cases = [
      {
        // A SQL-standard body records its dependency in pg_depend.
        change: `CREATE FUNCTION public.r0721_atomic_dependent() RETURNS boolean LANGUAGE sql
          BEGIN ATOMIC SELECT xai_subscription_pool_visible(NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid); END`,
        restore: `DROP FUNCTION public.r0721_atomic_dependent()`,
        code: "2BP01",
        message:
          /^0721 found a kept object that depends on a retired routine: function r0721_atomic_dependent\(\)/,
      },
      {
        change: `CREATE VIEW public.r0721_view_dependent AS
          SELECT claude_subscription_pool_visible(NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid) AS visible`,
        restore: `DROP VIEW public.r0721_view_dependent`,
        code: "2BP01",
        message:
          /^0721 found a kept object that depends on a retired routine: rule _RETURN on view r0721_view_dependent/,
      },
      {
        // A PL/pgSQL body is found by name.
        change: `CREATE FUNCTION public.r0721_plpgsql_dependent() RETURNS boolean LANGUAGE plpgsql AS
          $body$ BEGIN RETURN resolve_claude_authority_pool(NULL, NULL, NULL, NULL) IS NULL; END $body$`,
        restore: `DROP FUNCTION public.r0721_plpgsql_dependent()`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: routine r0721_plpgsql_dependent()",
      },
      {
        change: `CREATE POLICY r0721_policy_dependent ON xai_rotation_settings AS RESTRICTIVE
          USING (xai_subscription_pool_visible(NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid))`,
        restore: `DROP POLICY r0721_policy_dependent ON xai_rotation_settings`,
        code: "2BP01",
        message:
          /^0721 found a kept object that depends on a retired routine: policy r0721_policy_dependent on table xai_rotation_settings/,
      },
      {
        // Dynamic SQL in a kept routine could reach a retired trigger by name.
        change: `CREATE FUNCTION public.r0721_trigger_dependent() RETURNS void LANGUAGE plpgsql AS
          $body$ BEGIN EXECUTE 'ALTER TABLE xai_credential_leases DISABLE TRIGGER xai_lease_credential_pool_guard'; END $body$`,
        restore: `DROP FUNCTION public.r0721_trigger_dependent()`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: routine r0721_trigger_dependent()",
      },
      {
        // A string in a SQL-standard body has no catalog dependency.
        change: `CREATE FUNCTION public.r0721_atomic_named() RETURNS text LANGUAGE sql
          BEGIN ATOMIC SELECT 'revalidate_xai_subscription_authority'; END`,
        restore: `DROP FUNCTION public.r0721_atomic_named()`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: routine r0721_atomic_named()",
      },
      {
        // A name built at run time: a format() pattern, a concatenation
        // around the provider and a name that starts with the provider.
        change: `CREATE FUNCTION public.r0721_built_format(provider text) RETURNS void LANGUAGE plpgsql AS
            $body$ BEGIN EXECUTE format('SELECT resolve_%s_authority_pool(NULL, NULL, NULL, NULL)', provider); END $body$;
          CREATE FUNCTION public.r0721_built_concat(provider text) RETURNS void LANGUAGE plpgsql AS
            $body$ BEGIN EXECUTE 'SELECT opengeni_private.subscription_' || provider || '_reach(NULL, NULL)'; END $body$;
          CREATE FUNCTION public.r0721_built_leading(provider text) RETURNS void LANGUAGE plpgsql AS
            $body$ BEGIN EXECUTE 'SELECT ' || quote_ident(provider || '_subscription_pool_visible')
              || '(NULL, NULL, NULL, NULL, NULL)'; END $body$`,
        restore: `DROP FUNCTION public.r0721_built_format(text);
          DROP FUNCTION public.r0721_built_concat(text);
          DROP FUNCTION public.r0721_built_leading(text)`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: routine r0721_built_concat(text), routine r0721_built_format(text), routine r0721_built_leading(text)",
      },
      {
        // A CHECK constraint, a default, a trigger's arguments and a view.
        change: `CREATE FUNCTION public.r0721_pass_through() RETURNS trigger LANGUAGE plpgsql AS
            $body$ BEGIN RETURN NEW; END $body$;
          CREATE TABLE public.r0721_named (
            routine text DEFAULT format('%s_subscription_pool_visible', 'claude'),
            CONSTRAINT r0721_named_check CHECK (routine <> 'revalidate_' || 'xai' || '_subscription_authority'));
          CREATE TRIGGER r0721_named_trigger BEFORE INSERT ON public.r0721_named FOR EACH ROW
            EXECUTE FUNCTION public.r0721_pass_through('disconnect_claude_subscription_credential');
          CREATE VIEW public.r0721_named_view AS SELECT 'xai_subscription_scope'::text AS policy`,
        restore: `DROP VIEW public.r0721_named_view;
          DROP TABLE public.r0721_named;
          DROP FUNCTION public.r0721_pass_through()`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: constraint r0721_named_check, default r0721_named.routine, trigger r0721_named.r0721_named_trigger, view r0721_named_view",
      },
      {
        change: `CREATE POLICY r0721_policy_named ON xai_rotation_settings AS RESTRICTIVE
          USING (format('%s_subscription_authority_live', 'claude') IS NOT NULL)`,
        restore: `DROP POLICY r0721_policy_named ON xai_rotation_settings`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a retired object: policy xai_rotation_settings.r0721_policy_named",
      },
      {
        change: `CREATE FUNCTION public.r0721_reach_dependent() RETURNS bigint LANGUAGE plpgsql AS
          $body$ BEGIN RETURN (SELECT count(*) FROM ${CODEX_REACH}); END $body$`,
        restore: `DROP FUNCTION public.r0721_reach_dependent()`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a Codex-named reach object: routine r0721_reach_dependent()",
      },
      {
        change: `CREATE FUNCTION public.r0721_reach_built(provider text) RETURNS void LANGUAGE plpgsql AS
          $body$ BEGIN EXECUTE format('TRUNCATE opengeni_private.subscription_%s_auto_assignments', provider); END $body$`,
        restore: `DROP FUNCTION public.r0721_reach_built(text)`,
        code: "2BP01",
        message:
          "0721 found a kept object that names a Codex-named reach object: routine r0721_reach_built(text)",
      },
    ];
    for (const { change, restore, code, message } of cases) {
      await database!.admin.unsafe(change);
      try {
        await refused(code, message);
      } finally {
        await database!.admin.unsafe(restore);
      }
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 300_000);

  test("uppercase kept calls refuse without changing catalogs or the ledger", async () => {
    await database!.admin.unsafe(`CREATE FUNCTION public.r0721_uppercase() RETURNS boolean
      LANGUAGE plpgsql AS $body$ BEGIN
        RETURN XAI_SUBSCRIPTION_POOL_VISIBLE(NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::uuid);
      END $body$`);
    try {
      await database!.admin`select public.r0721_uppercase()`;
      await refused(
        "2BP01",
        "0721 found a kept object that names a retired object: routine r0721_uppercase()",
      );
    } finally {
      await database!.admin`DROP FUNCTION public.r0721_uppercase()`;
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 180_000);

  test("dollar-quoted kept calls refuse without changing catalogs or the ledger", async () => {
    // Exercise actual callers, independently of the namesAny audit helper.
    for (const expression of [
      `$prefix$SELECT $prefix$ || provider || $suffix$_subscription_pool_visible(NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid)$suffix$`,
      `$$SELECT $$ || provider || $$_SUBSCRIPTION_POOL_VISIBLE(NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::uuid)$$`,
      `$prefix$SELECT * FROM resolve_$prefix$ || provider || $suffix$_authority_pool(NULL::uuid,NULL::uuid,NULL::text,NULL::jsonb) LIMIT 0$suffix$`,
    ]) {
      await database!.admin.unsafe(`CREATE FUNCTION public.r0721_dollar_quoted() RETURNS void
        LANGUAGE plpgsql AS $body$ DECLARE provider text := 'xai'; BEGIN
          EXECUTE ${expression};
        END $body$`);
      try {
        await database!.admin`select public.r0721_dollar_quoted()`;
        await refused(
          "2BP01",
          "0721 found a kept object that names a retired object: routine r0721_dollar_quoted()",
        );
      } finally {
        await database!.admin`DROP FUNCTION public.r0721_dollar_quoted()`;
      }
      expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
    }
  }, 180_000);

  test("a reach row whose provider is not its connection's refuses without naming it", async () => {
    await database!.admin`
      insert into ${database!.admin(CODEX_REACH)} (account_id, provider, connection_id,
        shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
      values (${org.accountId}::uuid, 'xai', ${connections.mismatch}::uuid, true, false, true, null)`;
    try {
      await refused(
        "23503",
        "0721 found a reach row whose provider is not its connection's; see the runbook",
      );
    } finally {
      await database!.admin`
        delete from ${database!.admin(CODEX_REACH)} where connection_id = ${connections.mismatch}::uuid`;
    }
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
  }, 180_000);

  test("drops exactly the listed objects, renames the reach objects and keeps everything else", async () => {
    expect(diff(pending, await catalog())).toEqual(NO_CHANGE);
    await drained();
    await applyRetirement();
    expect(await ledger()).toBe(1);
    retired = await catalog();
    const moved = (table: string) => REACH_CONSTRAINTS.map((name) => `constraint ${table}.${name}`);
    const { removed, added, changed } = diff(pending, retired);
    expect(removed).toEqual(
      [
        ...SUBSCRIPTION_RETIRED_ROUTINES.map(
          ({ schema, signature }) => `routine ${regprocedure(schema, signature)}`,
        ),
        ...SUBSCRIPTION_RENAMED_ROUTINES.map(
          ({ schema, from }) => `routine ${regprocedure(schema, from)}`,
        ),
        ...SUBSCRIPTION_RETIRED_POLICIES.map(({ table, policy }) => `policy ${table}.${policy}`),
        ...SUBSCRIPTION_RENAMED_POLICIES.map(({ table, from }) => `policy ${table}.${from}`),
        ...SUBSCRIPTION_RETIRED_TRIGGERS.map(({ table, trigger }) => `trigger ${table}.${trigger}`),
        ...SUBSCRIPTION_RENAMED_TRIGGERS.map(({ table, from }) => `trigger ${table}.${from}`),
        ...SUBSCRIPTION_RENAMED_RELATIONS.map(({ schema, from }) => `relation ${schema}.${from}`),
        ...moved(CODEX_REACH),
      ].sort(),
    );
    expect(removed).toHaveLength(42 + 3 + 21 + 2 + 14 + 3 + 1 + 4);
    expect(added).toEqual(
      [
        ...SUBSCRIPTION_RENAMED_ROUTINES.map(
          ({ schema, to }) => `routine ${regprocedure(schema, to)}`,
        ),
        ...SUBSCRIPTION_RENAMED_POLICIES.map(({ table, to }) => `policy ${table}.${to}`),
        ...SUBSCRIPTION_RENAMED_TRIGGERS.map(({ table, to }) => `trigger ${table}.${to}`),
        ...moved(CORE_REACH),
        `constraint ${CORE_REACH}.${REACH_PROVIDER_KEY}`,
      ].sort(),
    );
    // The table takes the view's name: its kind, grants, RLS mode and owner.
    expect(changed).toEqual([`relation ${CORE_REACH}`]);
    expect(retired.get(`relation ${CORE_REACH}`)).toBe(pending.get(`relation ${CODEX_REACH}`));
    for (const name of REACH_CONSTRAINTS) {
      expect(retired.get(`constraint ${CORE_REACH}.${name}`)).toBe(
        pending.get(`constraint ${CODEX_REACH}.${name}`),
      );
    }
    expect(retired.get(`constraint ${CORE_REACH}.${REACH_PROVIDER_KEY}`)).toBe(
      "FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE | true",
    );
    // Renamed triggers keep their table, timing, events and function (now
    // provider-free); renamed policies keep their command, mode, roles and
    // expressions, now reading the provider-free setting.
    for (const { table, from, to } of SUBSCRIPTION_RENAMED_TRIGGERS) {
      let expected = pending.get(`trigger ${table}.${from}`)!.replace(from, to);
      for (const routine of SUBSCRIPTION_RENAMED_ROUTINES)
        expected = expected.replace(routine.from.slice(0, -2), routine.to.slice(0, -2));
      expect(retired.get(`trigger ${table}.${to}`)).toBe(expected);
    }
    for (const { table, from, to } of SUBSCRIPTION_RENAMED_POLICIES) {
      const before = pending.get(`policy ${table}.${from}`)!;
      expect(before).toContain(CODEX_AUTO_ASSIGN_SETTING);
      expect(retired.get(`policy ${table}.${to}`)).toBe(
        before.replaceAll(CODEX_AUTO_ASSIGN_SETTING, SUBSCRIPTION_AUTO_ASSIGN_SETTING),
      );
    }
    // Renamed routines keep their security mode, search path and owner and
    // remain owner-only before and after the rename; only the
    // auto-assignment bodies change, to the new setting.
    for (const { schema, from, to } of SUBSCRIPTION_RENAMED_ROUTINES) {
      const before = pending.get(`routine ${regprocedure(schema, from)}`)!.split(" | ");
      const after = retired.get(`routine ${regprocedure(schema, to)}`)!.split(" | ");
      expect([after[0], after[1], after[3]]).toEqual([before[0], before[1], before[3]]);
      expect(before[2]).toBe(`{${before[3]}=X/${before[3]}}`);
      expect(after[2]).toBe(`{${after[3]}=X/${after[3]}}`);
      expect(after[4] === before[4]).toBe(from === "record_subscription_codex_plan_change()");
    }
  }, 300_000);

  test("the auto-assignment bodies differ from 0713's only in the provider-free setting", async () => {
    const bodies = await database!.admin<{ name: string; body: string }[]>`
      select proname as name, prosrc as body from pg_proc
      where pronamespace = 'opengeni_private'::regnamespace
        and proname in ('auto_assign_subscription_core_workspace',
          'auto_assign_subscription_core_personal_workspace')
      order by proname`;
    const migration0713 = await readFile(
      new URL("../drizzle/0713_subscription_core_provider_keyed_reach.sql", import.meta.url),
      "utf8",
    );
    const squash = (value: string) => value.replace(/\s+/g, " ").trim();
    expect(bodies).toHaveLength(2);
    for (const { name, body } of bodies) {
      expect(body).toContain(SUBSCRIPTION_AUTO_ASSIGN_SETTING);
      expect(body).not.toContain(CODEX_AUTO_ASSIGN_SETTING);
      const codexName = name.replace("_core_", "_codex_");
      const start = migration0713.indexOf(`FUNCTION opengeni_private.${codexName}()`);
      const original = migration0713.slice(
        migration0713.indexOf("$body$", start) + "$body$".length,
        migration0713.indexOf("$body$", migration0713.indexOf("$body$", start) + 1),
      );
      expect(squash(body)).toBe(
        squash(original.replaceAll(CODEX_AUTO_ASSIGN_SETTING, SUBSCRIPTION_AUTO_ASSIGN_SETTING)),
      );
    }
  }, 180_000);

  test("keeps every object the design keeps", async () => {
    const present = (entry: string) =>
      expect({ entry, present: retired.has(entry) }).toEqual({
        entry,
        present: true,
      });
    // The v1 CHECK validators, the column-immutability functions, the
    // legacy Claude credential guard and the receipts.
    for (const validator of SUBSCRIPTION_SNAPSHOT_VALIDATOR_ROUTINES)
      present(`routine ${regprocedure("target", validator)}`);
    for (const routine of [
      "prevent_xai_snapshot_mutation()",
      "prevent_claude_snapshot_mutation()",
      "prevent_codex_provider_account_authority_snapshot_mutation()",
      "reject_legacy_claude_subscription_credentials()",
    ])
      present(`routine ${routine}`);
    for (const receipt of [
      "subscription_provider_cutover_committed(text)",
      "subscription_codex_cutover_v1_active()",
      "claude_subscription_pool_protocol_v1_active()",
    ])
      present(`routine opengeni_private.${receipt}`);
    // Their triggers, unchanged.
    const guards = [...pending.entries()].filter(
      ([entry, definition]) =>
        entry.startsWith("trigger ") &&
        /EXECUTE FUNCTION (prevent_(xai|claude|codex_provider_account_authority)_snapshot_mutation|reject_legacy_claude_subscription_credentials)\(\)/.test(
          definition,
        ),
    );
    expect(guards.map(([entry]) => entry.split(".")[0]).sort()).toEqual(
      [
        "trigger connections",
        "trigger organization_model_provider_connections",
        ...["scheduled_task_revision_authorities", "scheduled_tasks", "scheduled_tasks"],
        ...["scheduled_tasks"],
        ...Array(3).fill("trigger session_system_update_outbox"),
        ...Array(3).fill("trigger session_system_updates"),
        ...Array(3).fill("trigger session_turns"),
        ...Array(2).fill("trigger sessions"),
      ]
        .map((entry) => (entry.startsWith("trigger ") ? entry : `trigger ${entry}`))
        .sort(),
    );
    for (const [entry, definition] of guards) expect(retired.get(entry)).toBe(definition);
    // The X3/C3 restrictive policies, unchanged.
    const closed = [...pending.entries()].filter(
      ([entry]) => entry.startsWith("policy ") && /_closed(?:_insert|_update)?$/.test(entry),
    );
    expect(closed.map(([entry]) => entry).sort()).toEqual(CLOSED_POLICIES);
    for (const [entry, definition] of closed) expect(retired.get(entry)).toBe(definition);
    // The live Codex routines and the neutral core, the owner-only helpers
    // (provider-free names where 0721 renamed them), the organization wake
    // inventory the legacy wake still calls, and the runtime-capability tables.
    for (const routine of SUBSCRIPTION_M3_PRECURSOR_PRIVATE_ROUTINES)
      present(`routine ${regprocedure("opengeni_private", routine)}`);
    for (const routine of SUBSCRIPTION_M3_OWNER_ONLY_PRIVATE_ROUTINES) {
      const signature = routine.replaceAll(", ", ",");
      expect({
        routine,
        present: [...retired.keys()].some(
          (entry) =>
            entry === `routine opengeni_private.${signature}` ||
            entry === `routine opengeni_subscription_internal.${signature}`,
        ),
      }).toEqual({ routine, present: true });
    }
    present("routine list_organization_codex_workspace_ids(uuid)");
    present("relation opengeni_private.xai_subscription_runtime_capabilities");
    present("relation opengeni_private.claude_subscription_runtime_capabilities");
  }, 180_000);

  test("leaves nothing that names a retired or renamed-from object, literally or built at run time", async () => {
    const names = [
      ...SUBSCRIPTION_RETIRED_ROUTINE_NAMES,
      ...SUBSCRIPTION_RETIRED_POLICIES.map(({ policy }) => policy),
      ...SUBSCRIPTION_RETIRED_TRIGGERS.map(({ trigger }) => trigger),
      ...SUBSCRIPTION_RENAMED_ROUTINES.map(({ from }) => from.slice(0, -2)),
      ...SUBSCRIPTION_RENAMED_POLICIES.map(({ from }) => from),
      ...SUBSCRIPTION_RENAMED_TRIGGERS.map(({ from }) => from),
      ...SUBSCRIPTION_RENAMED_RELATIONS.map(({ from }) => from),
      CODEX_AUTO_ASSIGN_SETTING.slice("opengeni.".length),
    ];
    // Routine bodies (SQL-standard ones too), policies, whole trigger
    // definitions, views, defaults and CHECK constraints.
    const texts = await sqlTexts();
    expect(texts.length).toBeGreaterThan(1000);
    expect(texts.filter(({ body }) => namesAny(body, names)).map(({ object }) => object)).toEqual(
      [],
    );
    const admin = database!.admin;
    // And none of the dropped or renamed-from names survives anywhere.
    const [left] = await admin<{ routines: number; policies: number; triggers: number }[]>`
      select
        (select count(*)::int from pg_proc where proname = any(${[...SUBSCRIPTION_RETIRED_ROUTINE_NAMES]}::text[])) as routines,
        (select count(*)::int from pg_policy where polname = any(${[
          ...SUBSCRIPTION_RETIRED_POLICIES.map(({ policy }) => policy),
          ...SUBSCRIPTION_RENAMED_POLICIES.map(({ from }) => from),
        ]}::text[])) as policies,
        (select count(*)::int from pg_trigger where tgname = any(${[
          ...SUBSCRIPTION_RETIRED_TRIGGERS.map(({ trigger }) => trigger),
          ...SUBSCRIPTION_RENAMED_TRIGGERS.map(({ from }) => from),
        ]}::text[])) as triggers`;
    expect(left).toEqual({ routines: 0, policies: 0, triggers: 0 });
  }, 180_000);

  test("the SQL that still decides on stored v1 SuperGrok or Claude values is unchanged and reaches no retired routine", async () => {
    // X4 and C4 keep stored v1 values deciding (scheduled dispatch and the
    // revision authority among them). No such routine or policy may call,
    // name or build the name of a routine this migration drops, and the
    // migration changes none of them.
    const objects = (rows: readonly SqlText[]) => rows.map(({ object }) => object);
    const dropped = new Set(
      SUBSCRIPTION_RETIRED_ROUTINES.map(
        ({ schema, signature }) => `routine ${regprocedure(schema, signature)}`,
      ),
    );
    const after = await v1Readers();
    for (const scheduled of [
      "routine admit_scheduled_agent_run_execution()",
      "routine record_scheduled_task_revision_authority(uuid,uuid,uuid,bigint)",
    ]) {
      expect(objects(v1Pending)).toContain(scheduled);
      expect(objects(after)).toContain(scheduled);
    }
    // Only the dropped pool routines stop reading them.
    expect(objects(v1Pending).filter((object) => dropped.has(object))).toEqual([
      "routine resolve_claude_authority_pool(uuid,uuid,text,jsonb)",
      "routine resolve_xai_authority_pool(uuid,uuid,text,jsonb)",
      "routine revalidate_claude_subscription_authority(uuid,text,uuid,jsonb)",
      "routine revalidate_xai_subscription_authority(uuid,text,uuid,jsonb)",
    ]);
    expect(after).toEqual(v1Pending.filter(({ object }) => !dropped.has(object)));
    const names = [
      ...SUBSCRIPTION_RETIRED_ROUTINE_NAMES,
      ...SUBSCRIPTION_RETIRED_POLICIES.map(({ policy }) => policy),
      ...SUBSCRIPTION_RETIRED_TRIGGERS.map(({ trigger }) => trigger),
    ];
    expect(
      v1Pending
        .filter(({ object, body }) => !dropped.has(object) && namesAny(body, names))
        .map(({ object }) => object),
    ).toEqual([]);
  }, 180_000);

  test("the factory tables keep FORCE RLS and deny the application role", async () => {
    const admin = database!.admin;
    const tables = await admin<
      { table: string; rls: boolean; forced: boolean; permissive: string[] | null }[]
    >`
      select relation.relname as table, relation.relrowsecurity as rls,
        relation.relforcerowsecurity as forced,
        array_agg(policy.polname order by policy.polname)
          filter (where policy.polpermissive) as permissive
      from pg_class relation left join pg_policy policy on policy.polrelid = relation.oid
      where relation.relnamespace = 'public'::regnamespace and relation.relname = any(${FACTORY_TABLES}::text[])
      group by relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
      order by relation.relname`;
    expect(tables.map(({ table, rls, forced }) => ({ table, rls, forced }))).toEqual(
      FACTORY_TABLES.map((table) => ({ table, rls: true, forced: true })),
    );
    expect(tables.filter((row) => row.permissive === null).map((row) => row.table)).toEqual(
      POLICYLESS_FACTORY_TABLES,
    );
    const [forensic] = await admin<{ xai: number; claude: number }[]>`
      select (select count(*)::int from xai_session_account_pins) as xai,
        (select count(*)::int from claude_session_account_pins) as claude`;
    expect(forensic).toEqual({ xai: 1, claude: 1 });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    try {
      for (const table of FACTORY_TABLES) {
        const [privileges] = await app<
          {
            select: boolean;
            insert: boolean;
            update: boolean;
            delete: boolean;
            truncate: boolean;
          }[]
        >`
          select has_table_privilege(${table}, 'SELECT') as select,
            has_table_privilege(${table}, 'INSERT') as insert,
            has_table_privilege(${table}, 'UPDATE') as update,
            has_table_privilege(${table}, 'DELETE') as delete,
            has_table_privilege(${table}, 'TRUNCATE') as truncate`;
        expect({ table, ...privileges! }).toEqual({
          table,
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
        });
        const [visible] = await app<{ count: number }[]>`
          select count(*)::int as count from ${app(table)}`;
        expect({ table, rows: visible!.count }).toEqual({ table, rows: 0 });
        // Promise.resolve sends the lazy query (expect().rejects alone never does).
        await expect(
          Promise.resolve(app`insert into ${app(table)} default values`),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(Promise.resolve(app`delete from ${app(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
    } finally {
      await app.end();
      await drained();
    }
  }, 180_000);

  test("the reach rows are keyed by their connection's provider and have no default", async () => {
    const admin = database!.admin;
    const [column] = await admin<{ notNull: boolean; hasDefault: boolean }[]>`
      select attnotnull as "notNull", atthasdef as "hasDefault" from pg_attribute
      where attrelid = ${CORE_REACH}::regclass and attname = 'provider'`;
    expect(column).toEqual({ notNull: true, hasDefault: false });
    await expect(
      Promise.resolve(admin`insert into ${admin(CORE_REACH)} (account_id, provider, connection_id,
          shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
        values (${org.accountId}::uuid, 'xai', ${connections.keyed}::uuid, true, false, true, null)`),
    ).rejects.toMatchObject({ code: "23503", constraint_name: REACH_PROVIDER_KEY });
    await expect(
      Promise.resolve(admin`insert into ${admin(CORE_REACH)} (account_id, connection_id,
          shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
        values (${org.accountId}::uuid, ${connections.keyed}::uuid, true, false, true, null)`),
    ).rejects.toMatchObject({ code: "23502" });
    await admin`insert into ${admin(CORE_REACH)} (account_id, provider, connection_id,
        shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids)
      values (${org.accountId}::uuid, 'codex', ${connections.keyed}::uuid, true, false, true, null)`;
    // A reach row goes with its connection.
    await admin`delete from subscription_connections where id = ${connections.keyed}::uuid`;
    const rows = await admin`
      select 1 from ${admin(CORE_REACH)} where connection_id = ${connections.keyed}::uuid`;
    expect(rows).toHaveLength(0);
  }, 180_000);

  test("auto-assignment runs through the provider-free trigger, function, policy and setting", async () => {
    const admin = database!.admin;
    const existing = await admin`select provider, shared_workspaces, personal_workspaces,
        allocator_enabled, allowed_model_ids from ${admin(CORE_REACH)}
      where account_id = ${org.accountId}::uuid and connection_id = ${connections.reach}::uuid`;
    expect([...existing]).toEqual([
      {
        provider: "codex",
        shared_workspaces: true,
        personal_workspaces: false,
        allocator_enabled: true,
        allowed_model_ids: null,
      },
    ]);
    // The trigger functions run as the NOBYPASSRLS owner, so only the
    // renamed owner-only policies, reading the provider-free setting, admit
    // their writes. The caller's value of the setting is restored.
    const later = await admin.begin(async (tx) => {
      await tx`select set_config(${SUBSCRIPTION_AUTO_ASSIGN_SETTING}, 'caller', true)`;
      const id = await workspace(tx, org.accountId, org.ownerSubjectId, "Retirement reach");
      const [settings] = await tx<{ core: string | null; codex: string | null }[]>`
        select current_setting(${SUBSCRIPTION_AUTO_ASSIGN_SETTING}, true) as core,
          current_setting(${CODEX_AUTO_ASSIGN_SETTING}, true) as codex`;
      expect({ core: settings!.core, codex: settings!.codex ?? "" }).toEqual({
        core: "caller",
        codex: "",
      });
      return id;
    });
    const [assigned] = await admin<{ workspaces: number; policies: number }[]>`
      select
        (select count(*)::int from subscription_connection_workspaces
          where connection_id = ${connections.reach}::uuid and workspace_id = ${later}::uuid)
          as workspaces,
        (select count(*)::int from subscription_connection_assignment_policies
          where connection_id = ${connections.reach}::uuid and workspace_id = ${later}::uuid
            and inference_pool = 'organization' and allocator_enabled) as policies`;
    expect(assigned).toEqual({ workspaces: 1, policies: 1 });
  }, 180_000);

  test("the posture is clean as the application role, before and after provisioning again", async () => {
    expect(await appPosture()).toEqual([]);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
    expect(await appPosture()).toEqual([]);
    // Applying the migrations again is a no-op: the retirement is recorded.
    await applyRetirement();
    expect(await ledger()).toBe(1);
  }, 300_000);
});

describe.skipIf(!realDb)("migration 0721 on a fresh install", () => {
  let fresh: OwnerMigratedTestDatabase | null = null;

  beforeAll(async () => {
    fresh = await acquireOwnerMigratedTestDatabase("subscription-core-retirement-fresh");
    if (!fresh) throw new Error("Real PostgreSQL is required");
    await migrate(fresh.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  }, 600_000);

  afterAll(async () => {
    await fresh?.release();
  }, 180_000);

  test("an empty database migrates through every cutover and the retirement", async () => {
    // 0689 seeds the Codex receipt and 0719 and 0720 write theirs on an
    // empty database, so the retirement's receipt check passes unchanged.
    expect(await receipts(fresh!)).toEqual(["claude", "codex", "xai"]);
    expect(await ledger(fresh!)).toBe(1);
    const after = await catalog(fresh!);
    for (const object of retiredSubscriptionObjectDescriptions()) {
      const [kind, name] = object.split(" ");
      const entry =
        kind === "routine"
          ? `routine ${name!.replace(/^public\./, "").replaceAll(", ", ",")}`
          : object;
      expect({ object, present: after.has(entry) }).toEqual({ object, present: false });
    }
    expect(after.get(`relation ${CORE_REACH}`)?.split(" | ")[0]).toBe("r");
    expect(after.has(`constraint ${CORE_REACH}.${REACH_PROVIDER_KEY}`)).toBe(true);
    await provisionRoles(fresh!.adminUrl, { appPassword: fresh!.appPassword });
    expect(await appPosture(fresh!)).toEqual([]);
  }, 300_000);
});
