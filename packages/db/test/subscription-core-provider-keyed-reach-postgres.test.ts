// Migration 0713: an organization connection's reach for workspaces created
// later, the auto-assignment that applies it, plan-change history and the
// organization workspace inventory are provider-keyed on the shared
// subscription core. Codex behaviour is unchanged: the database is staged
// as a deployment is before 0713 (provisioned, Codex reach written through
// the Codex-named routine an older binary calls), 0713 is applied, and the
// same workspace-creation scenario must leave the same rows before and
// after. A second registered provider then uses the same rows and routines
// with no routine of its own. Runs on a database migrated by the
// NOSUPERUSER, NOBYPASSRLS owner; runtime calls run as the restricted
// application role.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createOrganizationWorkspace,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  getSubscriptionCoreCodexModelConnectionAccess,
  inspectRuntimeDatabasePosture,
  wakeSubscriptionCoreCodexCapacityWaiters,
  withSessionRlsActorContext,
  type DbClient,
  type ModelConnectionTarget,
} from "../src";
import { rawRows, setSubjectRlsContext, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
// The provider-parameterized entry points are internal to the package.
import {
  getSubscriptionCoreModelConnectionAccess,
  updateSubscriptionCoreModelConnectionAccess,
} from "../src/subscription-core/access-editor";
import { wakeSubscriptionCoreCapacityWaiters } from "../src/subscription-core/waiters";

const REACH_MIGRATION = "0713_subscription_core_provider_keyed_reach.sql";
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const key = Buffer.alloc(32, 71);
const MODEL = "codex/gpt-5.5";
const POSTURE_OPTIONS = {
  rlsStrategy: "force" as const,
  expectedRole: "opengeni_app",
  targetSchema: "public",
};

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

type Catalog = Map<string, string>;
type ReachRow = {
  account_id: string;
  connection_id: string;
  shared_workspaces: boolean;
  personal_workspaces: boolean;
  allocator_enabled: boolean;
  allowed_model_ids: string[] | null;
};
type Staged = {
  catalogBefore: Catalog;
  catalogAfter: Catalog;
  /** Runtime posture right after 0713, before roles are provisioned again. */
  unprovisionedPosture: string[];
  /** Who may execute each routine 0713 adds, before roles are provisioned again. */
  unprovisionedAcl: Array<{ routine: string; execute: boolean; publicExecute: boolean }>;
  /** The Codex reach rows an older binary wrote, read before 0713. */
  legacyRows: ReachRow[];
  /** The workspace-creation scenario run on the Codex objects 0689 and 0702 shipped. */
  legacyScenario: Scenario;
};
let staged: Staged | null = null;

function appUrl(): string {
  const url = new URL(database!.ownerUrl);
  url.username = "opengeni_app";
  url.password = database!.appPassword;
  return url.toString();
}

/** Routines, policies, triggers and relations of the schemas 0713 touches. */
async function catalog(): Promise<Catalog> {
  const admin = database!.admin;
  const entries = new Map<string, string>();
  const add = (kind: string, rows: readonly { key: string; value: string }[]) => {
    for (const row of rows) entries.set(`${kind} ${row.key}`, row.value);
  };
  add(
    "routine",
    await admin<{ key: string; value: string }[]>`
      select proc.oid::regprocedure::text as key,
        concat_ws(' | ', proc.prosecdef::text, coalesce(proc.proconfig::text, '-'),
          coalesce(proc.proacl::text, '-'), md5(proc.prosrc)) as value
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
      select tgrelid::regclass::text || '.' || tgname as key, pg_get_triggerdef(oid) as value
      from pg_trigger where not tgisinternal`,
  );
  add(
    "relation",
    await admin<{ key: string; value: string }[]>`
      select relation.oid::regclass::text as key,
        concat_ws(' | ', relation.relkind::text, coalesce(relation.relacl::text, '-'),
          relation.relrowsecurity::text, relation.relforcerowsecurity::text) as value
      from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname in ('public', 'opengeni_private', 'opengeni_subscription_internal')
        and relation.relkind in ('r', 'p', 'v', 'i')`,
  );
  return entries;
}

type Org = {
  accountId: string;
  ownerSubjectId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function workspace(accountId: string, subjectId: string, name: string): Promise<string> {
  const admin = database!.admin;
  const [row] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${accountId}::uuid, ${name})
    returning id::text as id`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${row!.id}::uuid, ${subjectId}, 'owner')`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${row!.id}::uuid, ${accountId}::uuid)`;
  return row!.id;
}

async function organization(): Promise<Org> {
  const userId = `core-reach-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Provider-keyed reach",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await database!.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text as personal_workspace_id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  return {
    accountId,
    ownerSubjectId,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: await workspace(accountId, ownerSubjectId, "Shared"),
  };
}

/** An organization-managed shared connection (or one a workspace manages). */
async function connection(
  org: Org,
  provider: "codex" | "xai",
  label: string,
  options: {
    allowedModelIds?: string[] | null;
    allocatorEnabled?: boolean;
    managedByWorkspaceId?: string;
    planType?: string | null;
  } = {},
): Promise<string> {
  const [row] = await database!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind,
      allow_personal_workspaces, provider_account_id, plan_type, provider_state, expires_at,
      label, managed_by_workspace_id, allowed_model_ids, allocator_enabled
    ) values (
      ${org.accountId}::uuid, ${provider}, 'subscription',
      ${encryptEnvironmentValue(key, JSON.stringify({ access_token: label, refresh_token: label }))},
      'shared', 'workspaces', false, ${`${provider}-${label}`},
      ${options.planType === undefined ? "pro" : options.planType},
      ${database!.admin.json({ isFedramp: false })}::jsonb,
      ${new Date(Date.now() + 86_400_000).toISOString()}::timestamptz,
      ${label}, ${options.managedByWorkspaceId ?? null}::uuid,
      ${options.allowedModelIds ?? null}::text[], ${options.allocatorEnabled ?? true}
    ) returning id::text as id`;
  return row!.id;
}

/** Runs as the restricted application role, in the organization scope of `subjectId`. */
function asOrganizationSubject<T>(
  accountId: string,
  subjectId: string,
  work: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
): Promise<T> {
  return withRlsContext(client!.db, { accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, subjectId);
    return await work(tx);
  });
}

type Outcome = { value: unknown } | { code: string; message: string };

async function outcome(work: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { value: await work() };
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const source = cause?.code ? cause : (error as { code?: string; message?: string });
    return { code: String(source.code), message: String(source.message) };
  }
}

async function reachOf(
  org: Org,
  provider: string | null,
  connectionId: string,
  subjectId = org.ownerSubjectId,
): Promise<Outcome> {
  return await outcome(() =>
    asOrganizationSubject(org.accountId, subjectId, async (tx) => {
      const [row] = await rawRows<{ reach: unknown }>(
        tx,
        provider === "codex-named"
          ? sql`select opengeni_private.subscription_codex_reach(
              ${org.accountId}::uuid, ${connectionId}::uuid) as reach`
          : sql`select opengeni_private.subscription_core_reach(
              ${provider}, ${org.accountId}::uuid, ${connectionId}::uuid) as reach`,
      );
      return row?.reach ?? null;
    }),
  );
}

async function setReach(
  org: Org,
  provider: string | null,
  connectionId: string,
  reach: [boolean | null, boolean | null],
  subjectId = org.ownerSubjectId,
): Promise<Outcome> {
  return await outcome(() =>
    asOrganizationSubject(org.accountId, subjectId, async (tx) => {
      await tx.execute(
        provider === "codex-named"
          ? sql`select opengeni_private.set_subscription_codex_reach(
              ${org.accountId}::uuid, ${connectionId}::uuid,
              ${reach[0]}::boolean, ${reach[1]}::boolean)`
          : sql`select opengeni_private.set_subscription_core_reach(
              ${provider}, ${org.accountId}::uuid, ${connectionId}::uuid,
              ${reach[0]}::boolean, ${reach[1]}::boolean)`,
      );
      return "set";
    }),
  );
}

async function reachRows(accountId: string, table: string): Promise<ReachRow[]> {
  return [
    ...(await database!.admin<ReachRow[]>`
      select account_id::text as account_id, connection_id::text as connection_id,
        shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids
      from ${database!.admin(table)} where account_id = ${accountId}::uuid
      order by connection_id`),
  ];
}

type Scenario = {
  org: Org;
  connections: Record<"sharedOnly" | "personalOnly" | "both" | "none", string>;
  rows: unknown;
};

/**
 * Organization reach applied as workspaces are created: a shared workspace
 * through the product's organization-workspace command, a member's new
 * Personal workspace (first created as a shared workspace, then claimed),
 * and that member's Personal workspace moving to another new workspace.
 * Returns every assignment and organization-pool row, with generated
 * identifiers replaced by stable names.
 */
async function autoAssignScenario(writer: "codex-named" | "codex"): Promise<Scenario> {
  const admin = database!.admin;
  const org = await organization();
  const connections = {
    sharedOnly: await connection(org, "codex", "shared-only", {
      allowedModelIds: [MODEL],
      allocatorEnabled: false,
    }),
    personalOnly: await connection(org, "codex", "personal-only"),
    both: await connection(org, "codex", "both", { allowedModelIds: [MODEL] }),
    none: await connection(org, "codex", "none"),
  };
  for (const [id, reach] of [
    [connections.sharedOnly, [true, false]],
    [connections.personalOnly, [false, true]],
    [connections.both, [true, true]],
  ] as const) {
    const written = await setReach(org, writer, id, [reach[0], reach[1]]);
    if (!("value" in written)) throw new Error(`reach was refused: ${JSON.stringify(written)}`);
  }
  const names = new Map<string, string>([
    [org.accountId, "<account>"],
    [org.personalWorkspaceId, "<owner-personal>"],
    [org.sharedWorkspaceId, "<shared>"],
    [connections.sharedOnly, "<shared-only>"],
    [connections.personalOnly, "<personal-only>"],
    [connections.both, "<both>"],
    [connections.none, "<none>"],
  ]);
  const created = await createOrganizationWorkspace(client!.db, {
    organizationId: org.accountId,
    actorSubjectId: org.ownerSubjectId,
    name: "Created later",
    operationId: crypto.randomUUID(),
  });
  names.set(created.id, "<created>");
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Personal workspace')
    returning id::text as id`;
  names.set(personal!.id, "<member-personal>");
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
    values (${org.accountId}::uuid, ${`user:core-reach-member-${crypto.randomUUID()}`}, 'member',
      'active', ${personal!.id}::uuid)
    returning id::text as id`;
  const [moved] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Moved Personal')
    returning id::text as id`;
  names.set(moved!.id, "<moved-personal>");
  await admin`update organization_memberships set personal_workspace_id = ${moved!.id}::uuid
    where id = ${membership!.id}::uuid`;
  const name = (id: string) => names.get(id) ?? "<unnamed>";
  const assignments = (
    await admin<{ connection_id: string; workspace_id: string }[]>`
      select connection_id::text as connection_id, workspace_id::text as workspace_id
      from subscription_connection_workspaces where account_id = ${org.accountId}::uuid`
  )
    .map((row) => `${name(row.connection_id)} ${name(row.workspace_id)}`)
    .sort();
  const policies = (
    await admin<
      {
        connection_id: string;
        workspace_id: string;
        inference_pool: string;
        allocator_enabled: boolean;
        allowed_model_ids: string[] | null;
        excluded_models: string[];
        managed_by_workspace_id: string | null;
      }[]
    >`select connection_id::text as connection_id, workspace_id::text as workspace_id,
        inference_pool, allocator_enabled, allowed_model_ids, excluded_models,
        managed_by_workspace_id::text as managed_by_workspace_id
      from subscription_connection_assignment_policies where account_id = ${org.accountId}::uuid`
  )
    .map((row) =>
      JSON.stringify({
        ...row,
        connection_id: name(row.connection_id),
        workspace_id: name(row.workspace_id),
        managed_by_workspace_id:
          row.managed_by_workspace_id === null ? null : name(row.managed_by_workspace_id),
      }),
    )
    .sort();
  return { org, connections, rows: { assignments, policies } };
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-core-provider-keyed-reach");
  if (!database) throw new Error("Real PostgreSQL is required");
  // A provisioned database without 0713, as a deployment is before it.
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${REACH_MIGRATION})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  client = createDb(appUrl(), { max: 4 });
  // An older binary keeps Codex reach through the Codex-named routine.
  const legacyScenario = await autoAssignScenario("codex-named");
  const legacyRows = await reachRows(
    legacyScenario.org.accountId,
    "opengeni_private.subscription_codex_auto_assignments",
  );
  const catalogBefore = await catalog();

  const applying = postgres(database.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await applying`delete from schema_migrations where name = ${REACH_MIGRATION}`;
    await migrate(database.ownerUrl);
    const [applied] = await applying<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${REACH_MIGRATION}`;
    if (applied?.count !== 1) throw new Error("0713 was not applied by the second migrate");
  } finally {
    await applying.end();
  }
  const catalogAfter = await catalog();
  // A rolling migration must leave every binary's runtime posture intact
  // until roles are provisioned again.
  const unprovisioned = createDb(appUrl(), { max: 1 });
  let unprovisionedPosture: string[];
  try {
    unprovisionedPosture = evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(unprovisioned.db, POSTURE_OPTIONS),
      POSTURE_OPTIONS,
    );
  } finally {
    await unprovisioned.close();
  }
  const added = [...catalogAfter.keys()]
    .filter((entry) => entry.startsWith("routine ") && !catalogBefore.has(entry))
    .map((entry) => entry.slice("routine ".length));
  const unprovisionedAcl = [
    ...(await database.admin<{ routine: string; execute: boolean; publicExecute: boolean }[]>`
      select proc.oid::regprocedure::text as routine,
        has_function_privilege('opengeni_app', proc.oid, 'EXECUTE') as execute,
        exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
      from pg_proc proc
      where proc.oid::regprocedure::text = any(${added}::text[])`),
  ].sort((left, right) => (left.routine < right.routine ? -1 : 1));
  await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  staged = {
    catalogBefore,
    catalogAfter,
    unprovisionedPosture,
    unprovisionedAcl,
    legacyRows,
    legacyScenario,
  };
}, 600_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

describe("provider-keyed reach on the shared subscription core (migration 0713)", () => {
  test.skipIf(!realDb)(
    "applies to a provisioned database without breaking any binary's runtime posture",
    async () => {
      const [roles] = await database!.admin<
        { owner_super: boolean; owner_bypass: boolean; app_super: boolean; app_bypass: boolean }[]
      >`select owner_role.rolsuper as owner_super, owner_role.rolbypassrls as owner_bypass,
          app_role.rolsuper as app_super, app_role.rolbypassrls as app_bypass
        from pg_roles owner_role, pg_roles app_role
        where owner_role.rolname = ${database!.ownerRole} and app_role.rolname = 'opengeni_app'`;
      expect(roles).toEqual({
        owner_super: false,
        owner_bypass: false,
        app_super: false,
        app_bypass: false,
      });
      const [current] = await rawRows<{ role: string }>(
        client!.db,
        sql`select current_user as role`,
      );
      expect(current?.role).toBe("opengeni_app");
      expect(staged!.unprovisionedPosture).toEqual([]);
      // Every runtime routine 0713 adds is executable before provisioning,
      // which a previous binary's readiness requires of any opengeni_private
      // routine it does not know; its owner-only routines live outside
      // opengeni_private. Nobody else may execute any of them.
      expect(staged!.unprovisionedAcl).toEqual([
        {
          routine: "list_organization_subscription_workspace_ids(uuid)",
          execute: true,
          publicExecute: false,
        },
        {
          routine: "opengeni_private.set_subscription_core_reach(text,uuid,uuid,boolean,boolean)",
          execute: true,
          publicExecute: false,
        },
        {
          routine: "opengeni_private.subscription_core_reach(text,uuid,uuid)",
          execute: true,
          publicExecute: false,
        },
        {
          routine:
            "opengeni_subscription_internal.apply_subscription_core_auto_assignments(text,uuid,uuid,boolean)",
          execute: false,
          publicExecute: false,
        },
      ]);
      const posture = await inspectRuntimeDatabasePosture(client!.db, POSTURE_OPTIONS);
      expect(evaluateRuntimeDatabasePosture(posture, POSTURE_OPTIONS)).toEqual([]);
      // Provisioning again leaves those grants exactly as the migration set
      // them.
      const provisionedAcl = [
        ...(await database!.admin<{ routine: string; execute: boolean; publicExecute: boolean }[]>`
          select proc.oid::regprocedure::text as routine,
            has_function_privilege('opengeni_app', proc.oid, 'EXECUTE') as execute,
            exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
          from pg_proc proc
          where proc.oid::regprocedure::text = any(${staged!.unprovisionedAcl.map(
            (entry) => entry.routine,
          )}::text[])`),
      ].sort((left, right) => (left.routine < right.routine ? -1 : 1));
      expect(provisionedAcl).toEqual(staged!.unprovisionedAcl);
      // The registry, the plan-change providers and the reach rows (under
      // either name) stay owner data.
      for (const table of [
        "opengeni_private.subscription_core_providers",
        "opengeni_private.subscription_core_plan_change_providers",
        "opengeni_private.subscription_codex_auto_assignments",
        "opengeni_private.subscription_core_auto_assignments",
      ]) {
        await expect(rawRows(client!.db, sql.raw(`select * from ${table}`))).rejects.toThrow();
      }
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "adds and redefines routines only; no trigger, policy or relation is renamed or dropped",
    async () => {
      const before = staged!.catalogBefore;
      const after = staged!.catalogAfter;
      const added = [...after.keys()].filter((entry) => !before.has(entry)).sort();
      const removed = [...before.keys()].filter((entry) => !after.has(entry)).sort();
      const changed = [...after.keys()]
        .filter((entry) => before.has(entry) && before.get(entry) !== after.get(entry))
        .sort();
      expect(added).toEqual([
        "relation opengeni_private.subscription_core_auto_assignments",
        "relation opengeni_private.subscription_core_plan_change_providers",
        "relation opengeni_private.subscription_core_plan_change_providers_pkey",
        "routine list_organization_subscription_workspace_ids(uuid)",
        "routine opengeni_private.set_subscription_core_reach(text,uuid,uuid,boolean,boolean)",
        "routine opengeni_private.subscription_core_reach(text,uuid,uuid)",
        "routine opengeni_subscription_internal.apply_subscription_core_auto_assignments(text,uuid,uuid,boolean)",
      ]);
      // Every routine 0713 adds is SECURITY DEFINER with the data schema and
      // opengeni_private on its search path and pg_temp last.
      for (const entry of added.filter((name) => name.startsWith("routine "))) {
        const [definer, config] = after.get(entry)!.split(" | ");
        expect({ entry, definer, config }).toEqual({
          entry,
          definer: "true",
          config: '{"search_path=pg_catalog, public, opengeni_private, pg_temp"}',
        });
      }
      // Nothing is renamed, detached or dropped, and no trigger, policy or
      // relation changes: the triggers on workspaces, organization_memberships
      // and subscription_connections, and the assignment tables' policies,
      // are exactly 0689's.
      expect(removed).toEqual([]);
      expect(changed).toEqual([
        "routine opengeni_private.apply_subscription_codex_auto_assignments(uuid,uuid,boolean)",
        "routine opengeni_private.auto_assign_subscription_codex_personal_workspace()",
        "routine opengeni_private.auto_assign_subscription_codex_workspace()",
        "routine opengeni_private.record_subscription_codex_plan_change()",
        "routine opengeni_private.set_subscription_codex_reach(uuid,uuid,boolean,boolean)",
        "routine opengeni_private.subscription_codex_reach(uuid,uuid)",
      ]);
      // The Codex-named routines that act on the reach rows keep their
      // security mode, search path and grants; only their bodies change.
      const withoutBody = (value: string | undefined) => value?.split(" | ").slice(0, 3);
      const planChange = "routine opengeni_private.record_subscription_codex_plan_change()";
      for (const entry of changed.filter((name) => name !== planChange)) {
        expect(withoutBody(after.get(entry))).toEqual(withoutBody(before.get(entry)));
      }
      // The plan-change trigger function now reads owner data, so it runs as
      // its owner with a pinned search path (pg_temp last); its grants stay
      // owner-only.
      const planChangeBefore = withoutBody(before.get(planChange));
      const planChangeAfter = withoutBody(after.get(planChange));
      expect(planChangeBefore?.slice(0, 2)).toEqual(["false", "{search_path=pg_catalog}"]);
      expect(planChangeAfter?.slice(0, 2)).toEqual([
        "true",
        '{"search_path=pg_catalog, public, opengeni_private, pg_temp"}',
      ]);
      const planChangeGrants = planChangeAfter?.[2] ?? "";
      expect(planChangeGrants).toBe(planChangeBefore?.[2] ?? "");
      expect(planChangeGrants).not.toContain("opengeni_app");
      expect(planChangeGrants).not.toMatch(/(^|[{,])=/);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "keeps every existing Codex reach row exactly, now keyed by its provider",
    async () => {
      const accountId = staged!.legacyScenario.org.accountId;
      expect(staged!.legacyRows).toHaveLength(3);
      const kept = await database!.admin<(ReachRow & { provider: string })[]>`
        select account_id::text as account_id, connection_id::text as connection_id,
          shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids, provider
        from opengeni_private.subscription_codex_auto_assignments
        where account_id = ${accountId}::uuid order by connection_id`;
      expect([...kept]).toEqual(staged!.legacyRows.map((row) => ({ ...row, provider: "codex" })));
      // The provider-free view the routines use shows exactly these rows.
      const viewed = await database!.admin<(ReachRow & { provider: string })[]>`
        select account_id::text as account_id, connection_id::text as connection_id,
          shared_workspaces, personal_workspaces, allocator_enabled, allowed_model_ids, provider
        from opengeni_private.subscription_core_auto_assignments
        where account_id = ${accountId}::uuid order by connection_id`;
      expect([...viewed]).toEqual([...kept]);
      const constraints = await database!.admin<{ name: string; definition: string }[]>`
        select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid = 'opengeni_private.subscription_codex_auto_assignments'::regclass
        order by contype, conname`;
      // 0689's connection key, primary key and reach check stay; the
      // provider is keyed by the registry.
      expect([...constraints].map((row) => row.definition)).toEqual([
        "CHECK ((shared_workspaces OR personal_workspaces))",
        "FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE",
        "FOREIGN KEY (provider) REFERENCES opengeni_private.subscription_core_providers(provider)",
        "PRIMARY KEY (connection_id)",
      ]);
      expect(
        constraints.find((row) => row.definition.startsWith("FOREIGN KEY (provider)"))?.name,
      ).toBe("subscription_codex_auto_assignments_provider_fkey");
      const [column] = await database!.admin<
        { notNull: boolean; hasDefault: boolean; defaultValue: string | null }[]
      >`
        select column_row.attnotnull as "notNull", column_row.atthasdef as "hasDefault",
          pg_get_expr(column_default.adbin, column_default.adrelid) as "defaultValue"
        from pg_attribute column_row
        left join pg_attrdef column_default
          on column_default.adrelid = column_row.attrelid
          and column_default.adnum = column_row.attnum
        where column_row.attrelid = 'opengeni_private.subscription_codex_auto_assignments'::regclass
          and column_row.attname = 'provider'`;
      // Every routine names the provider. The Codex default serves only an
      // older binary's 0702 reach write (it names no provider) until the
      // retirement migration drops it.
      expect(column).toEqual({ notNull: true, hasDefault: true, defaultValue: "'codex'::text" });
      // The Codex-named readers an older binary calls and the neutral ones
      // see the same kept rows.
      const { org, connections } = staged!.legacyScenario;
      for (const [id, reach] of [
        [connections.sharedOnly, { sharedWorkspaces: true, personalWorkspaces: false }],
        [connections.personalOnly, { sharedWorkspaces: false, personalWorkspaces: true }],
        [connections.both, { sharedWorkspaces: true, personalWorkspaces: true }],
        [connections.none, null],
      ] as const) {
        expect(await reachOf(org, "codex-named", id)).toEqual({ value: reach });
        expect(await reachOf(org, "codex", id)).toEqual({ value: reach });
      }
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "workspace and Personal-workspace creation assign Codex connections exactly as before",
    async () => {
      const viaCodexNamed = await autoAssignScenario("codex-named");
      const viaNeutral = await autoAssignScenario("codex");
      expect(viaCodexNamed.rows).toEqual(staged!.legacyScenario.rows);
      expect(viaNeutral.rows).toEqual(staged!.legacyScenario.rows);
      // The scenario is not vacuous: each reach rule assigned something.
      const assignments = (staged!.legacyScenario.rows as { assignments: string[] }).assignments;
      for (const assigned of [
        "<shared-only> <created>",
        "<both> <created>",
        "<personal-only> <member-personal>",
        "<both> <member-personal>",
        "<personal-only> <moved-personal>",
        "<both> <moved-personal>",
      ]) {
        expect(assignments).toContain(assigned);
      }
      expect(assignments).not.toContain("<shared-only> <moved-personal>");
      expect(assignments).not.toContain("<personal-only> <created>");
      expect(assignments.some((entry) => entry.startsWith("<none> "))).toBe(false);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "the Codex-named and neutral reach routines act on the same rows, each with its own refusals",
    async () => {
      const org = await organization();
      const id = await connection(org, "codex", "editor", { allowedModelIds: [MODEL] });
      expect(await setReach(org, "codex-named", id, [true, false])).toEqual({ value: "set" });
      expect(await reachOf(org, "codex", id)).toEqual({
        value: { sharedWorkspaces: true, personalWorkspaces: false },
      });
      expect(await setReach(org, "codex", id, [false, true])).toEqual({ value: "set" });
      expect(await reachOf(org, "codex-named", id)).toEqual({
        value: { sharedWorkspaces: false, personalWorkspaces: true },
      });
      // A null pair refreshes the row's copy of the connection's policy.
      await asOrganizationSubject(org.accountId, org.ownerSubjectId, (tx) =>
        tx.execute(sql`update subscription_connections
          set allocator_enabled = false, allowed_model_ids = null where id = ${id}::uuid`),
      );
      expect(await setReach(org, "codex", id, [null, null])).toEqual({ value: "set" });
      expect(
        await reachRows(org.accountId, "opengeni_private.subscription_codex_auto_assignments"),
      ).toEqual([
        {
          account_id: org.accountId,
          connection_id: id,
          shared_workspaces: false,
          personal_workspaces: true,
          allocator_enabled: false,
          allowed_model_ids: null,
        },
      ]);
      // Neither reach removes the row, through either routine.
      expect(await setReach(org, "codex-named", id, [false, false])).toEqual({ value: "set" });
      expect(await reachOf(org, "codex", id)).toEqual({ value: null });
      expect(await setReach(org, "codex", id, [true, true])).toEqual({ value: "set" });
      expect(await setReach(org, "codex", id, [false, false])).toEqual({ value: "set" });
      expect(await reachOf(org, "codex-named", id)).toEqual({ value: null });
      // A null pair on a connection without a row adds none.
      expect(await setReach(org, "codex-named", id, [null, null])).toEqual({ value: "set" });
      expect(await reachOf(org, "codex", id)).toEqual({ value: null });

      const memberSubjectId = `user:core-reach-plain-member-${crypto.randomUUID()}`;
      const memberPersonal = await workspace(org.accountId, memberSubjectId, "Member Personal");
      await database!.admin`insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
        values (${org.accountId}::uuid, ${memberSubjectId}, 'member', 'active',
          ${memberPersonal}::uuid)`;
      const local = await connection(org, "codex", "workspace-managed", {
        managedByWorkspaceId: org.sharedWorkspaceId,
      });
      const missing = crypto.randomUUID();
      const refusals = {
        codexReadNotAdmin: await reachOf(org, "codex-named", id, memberSubjectId),
        coreReadNotAdmin: await reachOf(org, "codex", id, memberSubjectId),
        coreReadUnregisteredNotAdmin: await reachOf(org, "xai", id, memberSubjectId),
        codexSetNotAdmin: await setReach(org, "codex-named", id, [true, true], memberSubjectId),
        coreSetNotAdmin: await setReach(org, "codex", id, [true, true], memberSubjectId),
        codexSetHalfPair: await setReach(org, "codex-named", id, [true, null]),
        coreSetHalfPair: await setReach(org, "codex", id, [null, true]),
        coreSetHalfPairUnregistered: await setReach(org, "xai", id, [null, true]),
        coreReadUnregistered: await reachOf(org, "xai", id),
        coreReadNullProvider: await reachOf(org, null, id),
        coreSetUnregistered: await setReach(org, "xai", id, [true, true]),
        coreSetUnknownProvider: await setReach(org, "Not A Provider", id, [true, true]),
        codexSetMissing: await setReach(org, "codex-named", missing, [true, true]),
        coreSetMissing: await setReach(org, "codex", missing, [true, true]),
        codexSetWorkspaceManaged: await setReach(org, "codex-named", local, [true, true]),
        coreSetWorkspaceManaged: await setReach(org, "codex", local, [true, true]),
      };
      const readNotAdmin = (provider: string) => ({
        code: "42501",
        message: `only organization administrators may read ${provider} connection reach`,
      });
      const setNotAdmin = (provider: string) => ({
        code: "42501",
        message: `only organization administrators may change ${provider} connection reach`,
      });
      const unregistered = {
        code: "22023",
        message: "subscription provider is not registered on the shared core",
      };
      expect(refusals).toEqual({
        codexReadNotAdmin: readNotAdmin("Codex"),
        coreReadNotAdmin: readNotAdmin("subscription"),
        coreReadUnregisteredNotAdmin: readNotAdmin("subscription"),
        codexSetNotAdmin: setNotAdmin("Codex"),
        coreSetNotAdmin: setNotAdmin("subscription"),
        codexSetHalfPair: { code: "22023", message: "Codex connection reach is set as a pair" },
        coreSetHalfPair: {
          code: "22023",
          message: "subscription connection reach is set as a pair",
        },
        coreSetHalfPairUnregistered: {
          code: "22023",
          message: "subscription connection reach is set as a pair",
        },
        coreReadUnregistered: unregistered,
        coreReadNullProvider: unregistered,
        coreSetUnregistered: unregistered,
        coreSetUnknownProvider: unregistered,
        codexSetMissing: { code: "P0002", message: "organization Codex connection not found" },
        coreSetMissing: {
          code: "P0002",
          message: "organization subscription connection not found",
        },
        codexSetWorkspaceManaged: {
          code: "P0002",
          message: "organization Codex connection not found",
        },
        coreSetWorkspaceManaged: {
          code: "P0002",
          message: "organization subscription connection not found",
        },
      });
      expect(await reachOf(org, "codex", id)).toEqual({ value: null });
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "the shared access editor reads and writes reach through the provider-keyed routines",
    async () => {
      const org = await organization();
      const id = await connection(org, "codex", "access-editor");
      const target: ModelConnectionTarget = {
        kind: "codex",
        connectionId: id,
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
      };
      const saved = await updateSubscriptionCoreModelConnectionAccess(client!.db, "codex", target, {
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 1,
      });
      expect(saved).toEqual({
        allowedModels: [MODEL],
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: 2,
      });
      expect(await getSubscriptionCoreModelConnectionAccess(client!.db, "codex", target)).toEqual(
        saved,
      );
      expect(await getSubscriptionCoreCodexModelConnectionAccess(client!.db, target)).toEqual(
        saved,
      );
      const [row] = await database!.admin<{ provider: string; shared: boolean }[]>`
        select provider, shared_workspaces as shared
        from opengeni_private.subscription_codex_auto_assignments where connection_id = ${id}::uuid`;
      expect(row).toEqual({ provider: "codex", shared: true });
      // A provider the shared core has no binding for is refused before any read.
      for (const work of [
        () => getSubscriptionCoreModelConnectionAccess(client!.db, "xai", target),
        () =>
          updateSubscriptionCoreModelConnectionAccess(client!.db, "xai", target, {
            ...saved!,
            version: 2,
          }),
      ]) {
        await expect(work()).rejects.toThrow(
          "No subscription-core provider is registered for this id",
        );
      }
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "plan-change history is recorded for Codex connections only, as before",
    async () => {
      const org = await organization();
      const codex = await connection(org, "codex", "plan");
      const unplanned = await connection(org, "codex", "plan-unset", { planType: null });
      const xai = await connection(org, "xai", "plan");
      const state = async (id: string) => {
        const [row] = await database!.admin<{ state: Record<string, unknown> }[]>`
          select provider_state as state from subscription_connections where id = ${id}::uuid`;
        return row!.state;
      };
      const planChange = async (id: string, plan: string) => {
        await database!.admin`update subscription_connections set plan_type = ${plan}
          where id = ${id}::uuid`;
        return await state(id);
      };
      expect(await planChange(codex, "PRO")).toEqual({ isFedramp: false });
      expect(await planChange(codex, "plus")).toEqual({
        isFedramp: false,
        planPreviousType: "PRO",
        planChangedAt: expect.any(String),
        planCheckedAt: expect.any(String),
      });
      expect(await planChange(unplanned, "plus")).toEqual({ isFedramp: false });
      expect(await planChange(xai, "plus")).toEqual({ isFedramp: false });
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "the organization workspace inventory is content-free and needs organization authority",
    async () => {
      const org = await organization();
      const other = await organization();
      const later = await workspace(org.accountId, org.ownerSubjectId, "Inventory");
      const list = async (
        routine:
          | "list_organization_subscription_workspace_ids"
          | "list_organization_codex_workspace_ids",
        accountId: string | null,
        workspaceId: string | null = null,
      ) =>
        await outcome(() =>
          withRlsContext(client!.db, { accountId: org.accountId, workspaceId }, async (tx) =>
            (
              await rawRows<{ workspace_id: string }>(
                tx,
                sql`select workspace_id::text as workspace_id
                  from ${sql.raw(routine)}(${accountId}::uuid) order by workspace_id`,
              )
            ).map((row) => row.workspace_id),
          ),
        );
      const neutral = "list_organization_subscription_workspace_ids" as const;
      const listed = await list(neutral, org.accountId);
      expect(listed).toEqual({
        value: expect.arrayContaining([org.personalWorkspaceId, org.sharedWorkspaceId, later]),
      });
      expect(await list("list_organization_codex_workspace_ids", org.accountId)).toEqual(listed);
      const [count] = await database!.admin<{ count: number }[]>`
        select count(*)::int as count from workspaces where account_id = ${org.accountId}::uuid`;
      expect((listed as { value: string[] }).value).toHaveLength(count!.count);
      const refused = {
        code: "42501",
        message: "organization subscription workspace inventory authority required",
      };
      expect(await list(neutral, other.accountId)).toEqual(refused);
      expect(await list(neutral, null)).toEqual(refused);
      expect(await list(neutral, org.accountId, org.sharedWorkspaceId)).toEqual(refused);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "capacity wakes run through the provider-keyed wake with each entry point's own texts",
    async () => {
      const org = await organization();
      const enqueued: string[] = [];
      const enqueue = async (_tx: unknown, wake: { sessionId: string }) => {
        enqueued.push(wake.sessionId);
      };
      await expect(
        wakeSubscriptionCoreCapacityWaiters(
          client!.db,
          "xai",
          { accountId: org.accountId, reason: "quota_observed_available" },
          enqueue,
        ),
      ).rejects.toThrow("No subscription-core provider is registered for this id");
      await expect(
        wakeSubscriptionCoreCapacityWaiters(
          client!.db,
          "codex",
          { accountId: org.accountId, reason: "Not An Identifier" },
          enqueue,
        ),
      ).rejects.toThrow("A subscription-core wake reason must be a bounded identifier");
      await expect(
        wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
          accountId: org.accountId,
          reason: "Not An Identifier",
        }),
      ).rejects.toThrow("Core Codex wake reason must be a bounded identifier");
      await expect(
        wakeSubscriptionCoreCapacityWaiters(
          client!.db,
          "codex",
          { accountId: org.accountId, reason: "fixture_wake", sessionIds: [crypto.randomUUID()] },
          enqueue,
        ),
      ).rejects.toThrow("A session-scoped subscription-core wake names exactly one workspace");
      // One waiting turn of each of two providers in the same workspace.
      const waiter = async (provider: "codex" | "xai") => {
        const actor = { subjectId: org.ownerSubjectId };
        const session = await withSessionRlsActorContext(actor, () =>
          createSession(client!.db, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            initialMessage: "provider-keyed wake fixture",
            resources: [],
            metadata: {},
            model: MODEL,
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            subjectId: org.ownerSubjectId,
            createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
            createdByContext: {},
          }),
        );
        const turn = await withSessionRlsActorContext(actor, () =>
          enqueueSessionTurn(client!.db, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            sessionId: session.id,
            triggerEventId: crypto.randomUUID(),
            temporalWorkflowId: `session-${session.id}`,
            source: "user",
            prompt: "provider-keyed wake fixture",
            resources: [],
            tools: [],
            model: MODEL,
            reasoningEffort: "medium",
            sandboxBackend: "none",
            metadata: {},
            initiator: { kind: "subject", subjectId: org.ownerSubjectId },
          }),
        );
        const [row] = await database!.admin<{ waiter_id: string }[]>`
          insert into subscription_capacity_waiters
            (account_id, workspace_id, session_id, turn_id, provider, wait_reason)
          values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${session.id}::uuid,
            ${turn.id}::uuid, ${provider}, 'capacity')
          returning waiter_id::text as waiter_id`;
        return { sessionId: session.id, waiterId: row!.waiter_id };
      };
      const codexWaiter = await waiter("codex");
      const otherWaiter = await waiter("xai");
      // A waiter's wake revision, last wake reason and typed wake deliveries.
      const woken = async (waiterId: string) => {
        const [row] = await database!.admin<
          { wake_revision: string; last_wake_reason: string | null; deliveries: number }[]
        >`select waiter.wake_revision::text as wake_revision, waiter.last_wake_reason,
            (select count(*)::int from subscription_capacity_wake_outbox outbox
              where outbox.account_id = waiter.account_id
                and outbox.waiter_id = waiter.waiter_id) as deliveries
          from subscription_capacity_waiters waiter where waiter.waiter_id = ${waiterId}::uuid`;
        return {
          revision: Number(row!.wake_revision),
          reason: row!.last_wake_reason,
          deliveries: row!.deliveries,
        };
      };
      const unwoken = { revision: 1, reason: null, deliveries: 0 };
      // Without an enabled cutover nothing is woken; with one, the
      // organization's workspaces are listed through the provider-free
      // inventory in the trusted wake scope, and only the waking provider's
      // waiters advance.
      const cutover = (enabled: boolean) => database!.admin`
        insert into subscription_provider_cutovers (account_id, provider, enabled)
        values (${org.accountId}::uuid, 'codex', ${enabled})
        on conflict (account_id, provider) do update set enabled = excluded.enabled`;
      const wake = () =>
        wakeSubscriptionCoreCapacityWaiters(
          client!.db,
          "codex",
          { accountId: org.accountId, reason: "fixture_wake" },
          enqueue,
        );
      await cutover(false);
      expect(await wake()).toEqual([]);
      expect(await woken(codexWaiter.waiterId)).toEqual(unwoken);
      await cutover(true);
      const touched = [{ accountId: org.accountId, workspaceId: org.sharedWorkspaceId }];
      expect(await wake()).toEqual(touched);
      expect(await woken(codexWaiter.waiterId)).toEqual({
        revision: 2,
        reason: "fixture_wake",
        deliveries: 1,
      });
      expect(await woken(otherWaiter.waiterId)).toEqual(unwoken);
      expect(enqueued).toEqual([codexWaiter.sessionId]);
      expect(
        await wakeSubscriptionCoreCodexCapacityWaiters(client!.db, {
          accountId: org.accountId,
          reason: "fixture_wake",
        }),
      ).toEqual(touched);
      expect(await woken(codexWaiter.waiterId)).toEqual({
        revision: 3,
        reason: "fixture_wake",
        deliveries: 2,
      });
      expect(await woken(otherWaiter.waiterId)).toEqual(unwoken);
    },
    180_000,
  );

  test.skipIf(!realDb)(
    "the auto-assignment triggers and the Codex-named apply routine restore the caller's setting",
    async () => {
      const org = await organization();
      const sharedOnly = await connection(org, "codex", "restore-shared");
      const personalOnly = await connection(org, "codex", "restore-personal");
      expect(await setReach(org, "codex", sharedOnly, [true, false])).toEqual({ value: "set" });
      expect(await setReach(org, "codex", personalOnly, [false, true])).toEqual({ value: "set" });
      // 0689's setting admits the owner-only assignment writes for the
      // organization it names; a caller's own value of it, set earlier in the
      // same transaction, must be the value once each path returns.
      const setting = "opengeni.subscription_codex_auto_assign";
      const prior = crypto.randomUUID();
      const observed = await database!.admin.begin(async (tx) => {
        const after = async (workspaceId: string) => {
          const [row] = await tx<{ value: string | null }[]>`
            select current_setting(${setting}, true) as value`;
          const assignments = await tx<{ connection_id: string }[]>`
            select connection_id::text as connection_id from subscription_connection_workspaces
            where workspace_id = ${workspaceId}::uuid`;
          return {
            setting: row!.value,
            assigned: assignments.map((assignment) => assignment.connection_id).sort(),
          };
        };
        await tx`select pg_catalog.set_config(${setting}, ${prior}, true)`;
        const [created] = await tx<{ id: string }[]>`
          insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Restore')
          returning id::text as id`;
        const workspaceTrigger = await after(created!.id);
        await tx`insert into organization_memberships
          (account_id, subject_id, role, status, personal_workspace_id)
          values (${org.accountId}::uuid, ${`user:core-reach-restore-${crypto.randomUUID()}`},
            'member', 'active', ${created!.id}::uuid)`;
        const personalTrigger = await after(created!.id);
        await tx`select opengeni_private.apply_subscription_codex_auto_assignments(
          ${org.accountId}::uuid, ${created!.id}::uuid, false)`;
        const codexApply = await after(created!.id);
        return { workspaceTrigger, personalTrigger, codexApply };
      });
      // Each path applied its rule, so it ran, and left the caller's value.
      expect(observed).toEqual({
        workspaceTrigger: { setting: prior, assigned: [sharedOnly] },
        personalTrigger: { setting: prior, assigned: [personalOnly] },
        codexApply: { setting: prior, assigned: [sharedOnly] },
      });
    },
    180_000,
  );

  // Registers a second provider in this database's SQL registry, so it runs last.
  test.skipIf(!realDb)(
    "a second registered provider uses the same rows, apply path and routines",
    async () => {
      await database!.admin`insert into opengeni_private.subscription_core_providers
        (provider, primary_setting_column) values ('xai', 'xai_primary_connection_id')`;
      const org = await organization();
      const codex = await connection(org, "codex", "second-codex", { allowedModelIds: [MODEL] });
      const xai = await connection(org, "xai", "second-xai", { allocatorEnabled: false });
      // Reaches Personal workspaces only, so only the Personal rule assigns it.
      const xaiPersonal = await connection(org, "xai", "second-xai-personal");
      expect(await setReach(org, "codex", codex, [true, false])).toEqual({ value: "set" });
      expect(await setReach(org, "xai", xai, [true, true])).toEqual({ value: "set" });
      expect(await setReach(org, "xai", xaiPersonal, [false, true])).toEqual({ value: "set" });
      expect(await reachOf(org, "xai", xai)).toEqual({
        value: { sharedWorkspaces: true, personalWorkspaces: true },
      });
      // Each provider sees only its own rows; the Codex-named routines see
      // only Codex's.
      expect(await reachOf(org, "xai", codex)).toEqual({ value: null });
      expect(await reachOf(org, "codex", xai)).toEqual({ value: null });
      expect(await reachOf(org, "codex-named", xai)).toEqual({ value: null });
      expect(await setReach(org, "codex", xai, [true, true])).toEqual({
        code: "P0002",
        message: "organization subscription connection not found",
      });
      expect(await setReach(org, "codex-named", xai, [true, true])).toEqual({
        code: "P0002",
        message: "organization Codex connection not found",
      });
      expect(await setReach(org, "xai", codex, [true, true])).toEqual({
        code: "P0002",
        message: "organization subscription connection not found",
      });
      // The writer stored each row under its own connection's provider, and
      // a row of an unregistered provider cannot exist. (A postgres.js query
      // runs only once awaited, so it is awaited inside `outcome`.)
      const stored = await database!.admin<{ connection_id: string; provider: string }[]>`
        select auto.connection_id::text as connection_id, auto.provider
        from opengeni_private.subscription_codex_auto_assignments auto
        join subscription_connections connection on connection.id = auto.connection_id
        where auto.account_id = ${org.accountId}::uuid and connection.provider = auto.provider
        order by auto.connection_id`;
      expect(new Map(stored.map((row) => [row.connection_id, row.provider]))).toEqual(
        new Map([
          [codex, "codex"],
          [xai, "xai"],
          [xaiPersonal, "xai"],
        ]),
      );
      const unregisteredRow = await outcome(
        async () =>
          await database!.admin`update opengeni_private.subscription_codex_auto_assignments
            set provider = 'claude' where connection_id = ${xai}::uuid`,
      );
      expect(unregisteredRow).toMatchObject({ code: "23503" });
      expect("message" in unregisteredRow ? unregisteredRow.message : "").toContain(
        "subscription_codex_auto_assignments_provider_fkey",
      );

      // One workspace creation applies every provider's reach.
      const created = await createOrganizationWorkspace(client!.db, {
        organizationId: org.accountId,
        actorSubjectId: org.ownerSubjectId,
        name: "Created for both",
        operationId: crypto.randomUUID(),
      });
      const policies = await database!.admin<
        { connection_id: string; allocator_enabled: boolean; allowed_model_ids: string[] | null }[]
      >`select connection_id::text as connection_id, allocator_enabled, allowed_model_ids
        from subscription_connection_assignment_policies
        where workspace_id = ${created.id}::uuid and inference_pool = 'organization'
        order by connection_id`;
      expect(new Map(policies.map((row) => [row.connection_id, row]))).toEqual(
        new Map([
          [codex, { connection_id: codex, allocator_enabled: true, allowed_model_ids: [MODEL] }],
          [xai, { connection_id: xai, allocator_enabled: false, allowed_model_ids: null }],
        ]),
      );
      const assigned = await database!.admin<{ connection_id: string }[]>`
        select connection_id::text as connection_id from subscription_connection_workspaces
        where workspace_id = ${created.id}::uuid order by connection_id`;
      expect(assigned.map((row) => row.connection_id)).toEqual([codex, xai].sort());
      // A Personal workspace follows each provider's Personal rule: created
      // as a shared workspace it gets the shared rules; claimed as someone's
      // Personal workspace, the shared-only Codex connection leaves and the
      // Personal-only connection of the second provider arrives.
      const assignedTo = async (workspaceId: string) =>
        (
          await database!.admin<{ connection_id: string; inference_pool: string | null }[]>`
            select assignment.connection_id::text as connection_id, policy.inference_pool
            from subscription_connection_workspaces assignment
            left join subscription_connection_assignment_policies policy
              on policy.account_id = assignment.account_id
              and policy.connection_id = assignment.connection_id
              and policy.workspace_id = assignment.workspace_id
            where assignment.workspace_id = ${workspaceId}::uuid`
        )
          .map((row) => `${row.connection_id} ${row.inference_pool}`)
          .sort();
      const [personal] = await database!.admin<{ id: string }[]>`
        insert into workspaces (account_id, name) values (${org.accountId}::uuid, 'Personal for both')
        returning id::text as id`;
      expect(await assignedTo(personal!.id)).toEqual(
        [`${codex} organization`, `${xai} organization`].sort(),
      );
      await database!.admin`insert into organization_memberships
        (account_id, subject_id, role, status, personal_workspace_id)
        values (${org.accountId}::uuid, ${`user:core-reach-second-${crypto.randomUUID()}`},
          'member', 'active', ${personal!.id}::uuid)`;
      expect(await assignedTo(personal!.id)).toEqual(
        [`${xai} organization`, `${xaiPersonal} organization`].sort(),
      );

      // Plan-change history is registry data, not a provider name.
      const planState = async () => {
        const [row] = await database!.admin<{ state: Record<string, unknown> }[]>`
          select provider_state as state from subscription_connections where id = ${xai}::uuid`;
        return row!.state;
      };
      await database!.admin`update subscription_connections set plan_type = 'plus'
        where id = ${xai}::uuid`;
      expect(await planState()).toEqual({ isFedramp: false });
      await database!.admin`insert into opengeni_private.subscription_core_plan_change_providers
        (provider) values ('xai')`;
      await database!.admin`update subscription_connections set plan_type = 'heavy'
        where id = ${xai}::uuid`;
      expect(await planState()).toMatchObject({ planPreviousType: "plus" });
      // Only a registered provider can keep plan-change history.
      expect(
        await outcome(
          async () =>
            await database!
              .admin`insert into opengeni_private.subscription_core_plan_change_providers
              (provider) values ('claude')`,
        ),
      ).toMatchObject({ code: "23503" });

      // The TypeScript registry still has no binding for it, so the shared
      // core's TypeScript entry points refuse it.
      await expect(
        getSubscriptionCoreModelConnectionAccess(client!.db, "xai", {
          connectionId: xai,
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
        }),
      ).rejects.toThrow("No subscription-core provider is registered for this id");
    },
    180_000,
  );
});
