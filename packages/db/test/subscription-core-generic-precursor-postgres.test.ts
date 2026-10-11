// Migration 0712: the M4 generic precursor of the shared subscription core
// (design docs/design/subscription-core-2026-10-07.md, 5.3 "PR sequence" row
// 0). The database is migrated by the NOSUPERUSER, NOBYPASSRLS owner, so FORCE
// RLS binds the owner and owner-run routines; runtime calls run as the
// restricted application role. Fixtures that must exist before 0712 (a
// cross-provider primary, a pre-existing Claude switch row, a Codex owner with
// two current personal generations) are written before 0712 is applied.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  ensureManagedAccessForUser,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  withSubscriptionCoreAcceptedTurn,
  type DbClient,
} from "../src";
import { rawRows, withRlsContext } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { ownerlessRefreshFixture, ownerlessRefreshKey } from "./fixtures/ownerless-codex-refresh";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const PRECURSOR = "0712_subscription_core_generic_precursor.sql";
// 0714 builds on 0712's receipts and patches its helpers; it follows 0712.
const COMPAT = "0714_subscription_authority_compat.sql";
let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let appUrl = "";
/** Runtime posture right after applying 0712 to a provisioned database, before provisioning again. */
let unprovisionedPostureViolations: string[] | null = null;
// A deployment's own application role (not named opengeni_app), configured for
// the migration, and whether it could run the receipt reader before roles were
// provisioned again (the restrictive policies call the reader for every role).
const customApplicationRole = `og_pr0_custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let customRoleReaderBeforeProvision: boolean | null = null;

type Org = {
  accountId: string;
  subjectId: string;
  membershipId: string;
  personalWorkspaceId: string;
};

/** Fixtures written before 0712 is applied. */
let before: {
  org: Org;
  codexShared: string;
  xaiShared: string;
  personalOne: string;
  personalTwo: string;
  seeded: unknown;
} | null = null;

async function organization(db: DbClient, label: string): Promise<Org> {
  const userId = `generic-precursor-${label}-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(db.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Generic precursor fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await database!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships where account_id = ${accountId}::uuid
      and subject_id = ${subjectId} and status = 'active' and revoked_at is null limit 1`;
  return {
    accountId,
    subjectId,
    membershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
  };
}

function encrypted(label: string): string {
  return encryptEnvironmentValue(
    ownerlessRefreshKey,
    JSON.stringify({
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
    }),
  );
}

async function sharedConnection(org: Org, provider: string, label: string): Promise<string> {
  const [row] = await database!.admin<{ id: string }[]>`
    insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, ownership, scope_kind
    ) values (${org.accountId}::uuid, ${provider}, 'subscription', ${encrypted(label)},
      'shared', 'organization')
    returning id::text as id`;
  return row!.id;
}

async function personalCodexConnection(org: Org, generation: number): Promise<string> {
  const connectionId = crypto.randomUUID();
  const authorityId = crypto.randomUUID();
  await database!.admin`
    insert into organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
    ) values (
      ${authorityId}::uuid, ${org.accountId}::uuid, ${org.membershipId}::uuid,
      'subscription_connection', ${connectionId}::uuid, ${generation}, 'active'
    )`;
  await database!.admin`
    insert into subscription_connections (
      id, account_id, provider, credential_encrypted, ownership, scope_kind,
      owner_organization_membership_id, owner_subject_id, authority_id,
      authority_resource_kind, authority_generation
    ) values (
      ${connectionId}::uuid, ${org.accountId}::uuid, 'codex', ${encrypted(`personal-${generation}`)},
      'personal', 'people', ${org.membershipId}::uuid, ${org.subjectId}, ${authorityId}::uuid,
      'subscription_connection', ${generation}
    )`;
  return connectionId;
}

/** What the organization seed wrote, without generated identifiers. */
async function seededRows(accountId: string) {
  const cutovers = await database!.admin`
    select provider, enabled, updated_by_subject_id from subscription_provider_cutovers
    where account_id = ${accountId}::uuid order by provider`;
  const settings = await database!.admin`
    select rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed, updated_by_subject_id,
      codex_primary_connection_id, claude_primary_connection_id, xai_primary_connection_id
    from subscription_settings where account_id = ${accountId}::uuid and workspace_id is null`;
  return { cutovers: [...cutovers], settings: [...settings] };
}

/** Run as the application role in the organization owner's admin context. */
async function asOrganizationOwner<T>(
  org: Org,
  work: (db: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
): Promise<T> {
  return await withSessionRlsActorContext({ subjectId: org.subjectId }, () =>
    withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
      work,
    ),
  );
}

async function failure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    const code =
      (cause as { code?: string } | undefined)?.code ?? (error as { code?: string }).code;
    return `${code ?? "?"} ${String(cause ?? error)}`;
  }
  return "succeeded";
}

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("subscription-core-generic-precursor");
  if (!database) throw new Error("Real PostgreSQL is required");
  // Stage a provisioned database without 0712 (as a deployment is before it).
  const owner = postgres(database.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values (${PRECURSOR}), (${COMPAT})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, {
      appPassword: database.appPassword,
    });
  } finally {
    await owner.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  appUrl = url.toString();
  const staged = createDb(appUrl, { max: 2 });
  try {
    const org = await organization(staged, "before");
    const seeded = await seededRows(org.accountId);
    const codexShared = await sharedConnection(org, "codex", "codex-shared");
    const xaiShared = await sharedConnection(org, "xai", "xai-shared");
    // Before 0712 a primary could reference another provider's connection.
    await database.admin`
      update subscription_settings
      set codex_primary_connection_id = ${xaiShared}::uuid,
        claude_primary_connection_id = ${codexShared}::uuid,
        xai_primary_connection_id = ${xaiShared}::uuid
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    // ...and a Claude switch row could exist without any cutover.
    await database.admin`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${org.accountId}::uuid, 'claude', true)`;
    const personalOne = await personalCodexConnection(org, 1);
    const personalTwo = await personalCodexConnection(org, 2);
    before = { org, codexShared, xaiShared, personalOne, personalTwo, seeded };
  } finally {
    await staged.close();
  }
  // A rolling migration must leave the runtime posture intact until roles are
  // provisioned again: apply 0712 alone and evaluate as the runtime role.
  const ownerAgain = postgres(database.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await ownerAgain`delete from schema_migrations where name in (${PRECURSOR}, ${COMPAT})`;
    await database.admin.unsafe(
      `CREATE ROLE "${customApplicationRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    await migrate(database.ownerUrl, undefined, {
      applicationDatabaseRoles: ["opengeni_app", customApplicationRole],
    });
    const [customReader] = await database.admin<{ allowed: boolean }[]>`
      select has_function_privilege(${customApplicationRole},
        'opengeni_private.subscription_provider_cutover_committed(text)', 'EXECUTE') as allowed`;
    customRoleReaderBeforeProvision = customReader?.allowed ?? null;
    const [applied] = await ownerAgain<{ count: number }[]>`
      select count(*)::int as count from schema_migrations where name = ${PRECURSOR}`;
    if (applied?.count !== 1) throw new Error("0712 was not applied by the second migrate");
  } finally {
    await ownerAgain.end();
  }
  const unprovisioned = createDb(appUrl, { max: 1 });
  try {
    const options = {
      rlsStrategy: "force" as const,
      expectedRole: "opengeni_app",
      targetSchema: "public",
    };
    unprovisionedPostureViolations = evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(unprovisioned.db, options),
      options,
    );
  } finally {
    await unprovisioned.close();
  }
  await provisionRoles(database.adminUrl, {
    appPassword: database.appPassword,
  });
  client = createDb(appUrl, { max: 4 });
}, 600_000);

afterAll(async () => {
  await client?.close();
  if (database) {
    await database.admin.unsafe(`DROP OWNED BY "${customApplicationRole}"`).catch(() => undefined);
    await database.admin
      .unsafe(`DROP ROLE IF EXISTS "${customApplicationRole}"`)
      .catch(() => undefined);
  }
  await database?.release();
}, 180_000);

describe.skipIf(!realDb)("subscription-core generic precursor (migration 0712)", () => {
  test("runs as the restricted application role over a NOBYPASSRLS owner, with safe rolling posture", async () => {
    const [roles] = await database!.admin<
      {
        owner_super: boolean;
        owner_bypass: boolean;
        app_super: boolean;
        app_bypass: boolean;
      }[]
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
    expect(unprovisionedPostureViolations).toEqual([]);
    // A configured application role with another name can run the reader the
    // restrictive policies call, before provision-roles.
    expect(customRoleReaderBeforeProvision).toBe(true);
    const options = {
      rlsStrategy: "force" as const,
      expectedRole: "opengeni_app",
      targetSchema: "public",
    };
    const posture = await inspectRuntimeDatabasePosture(client!.db, options);
    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
    expect(posture.subscriptionProviderCutoverReceipts).toEqual(["codex"]);
    // Every new routine has a fixed search_path ending in pg_temp; only the
    // readiness function is executable by the runtime role.
    const routines = await database!.admin<
      {
        name: string;
        config: string[] | null;
        app_execute: boolean;
        public_execute: boolean;
      }[]
    >`select n.nspname || '.' || p.proname as name, p.proconfig as config,
        has_function_privilege('opengeni_app', p.oid, 'EXECUTE') as app_execute,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('subscription_provider_cutover_committed',
        'guard_subscription_provider_cutover_receipts', 'keep_subscription_cutover_identity')
      order by 1`;
    expect(
      routines.map(({ name, app_execute, public_execute }) => ({
        name,
        app_execute,
        public_execute,
      })),
    ).toEqual([
      {
        name: "opengeni_private.subscription_provider_cutover_committed",
        app_execute: true,
        public_execute: false,
      },
      {
        name: "opengeni_subscription_internal.guard_subscription_provider_cutover_receipts",
        app_execute: false,
        public_execute: false,
      },
      {
        name: "opengeni_subscription_internal.keep_subscription_cutover_identity",
        app_execute: false,
        public_execute: false,
      },
    ]);
    for (const routine of routines) {
      const searchPath = routine.config?.find((value) => value.startsWith("search_path="));
      expect(searchPath?.startsWith("search_path=pg_catalog, ")).toBe(true);
      expect(searchPath?.endsWith(", pg_temp")).toBe(true);
    }
  });

  test("receipts: Codex only, '-infinity', append-only, answered by one boolean function", async () => {
    const receipts = await database!.admin`
      select provider, migration, committed_at = '-infinity'::timestamptz as before_receipts,
        seed_rotation
      from opengeni_private.subscription_provider_cutover_receipts order by provider`;
    expect([...receipts]).toEqual([
      {
        provider: "codex",
        migration: "0689_subscription_core_codex_cutover.sql",
        before_receipts: true,
        seed_rotation: { mode: "spread" },
      },
    ]);
    const app = postgres(appUrl, { max: 1 });
    try {
      const [answers] = await app<
        {
          codex: boolean;
          xai: boolean;
          claude: boolean;
          unknown: boolean;
          absent: boolean;
        }[]
      >`select opengeni_private.subscription_provider_cutover_committed('codex') as codex,
          opengeni_private.subscription_provider_cutover_committed('xai') as xai,
          opengeni_private.subscription_provider_cutover_committed('claude') as claude,
          opengeni_private.subscription_provider_cutover_committed('openrouter') as unknown,
          opengeni_private.subscription_provider_cutover_committed(null) as absent`;
      expect(answers).toEqual({
        codex: true,
        xai: false,
        claude: false,
        unknown: false,
        absent: false,
      });
      // The runtime role never reads the receipt table itself.
      expect(
        await failure(
          () => app`select * from opengeni_private.subscription_provider_cutover_receipts`,
        ),
      ).toStartWith("42501");
    } finally {
      await app.end();
    }
    const owner = postgres(database!.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      for (const statement of [
        "update opengeni_private.subscription_provider_cutover_receipts set migration = '0001_x.sql'",
        "delete from opengeni_private.subscription_provider_cutover_receipts",
        "truncate opengeni_private.subscription_provider_cutover_receipts",
      ]) {
        expect(await failure(() => owner.unsafe(statement))).toContain(
          "subscription provider cutover receipts are append-only",
        );
      }
    } finally {
      await owner.end();
    }
  });

  test("no runtime role inserts or enables a switch row, or inserts a connection, for a provider without a receipt", async () => {
    const org = before!.org;
    // Codex has its receipt: the administrator still manages its row.
    expect(
      await failure(() =>
        asOrganizationOwner(org, (db) =>
          rawRows(
            db,
            sql`update subscription_provider_cutovers set enabled = false
            where account_id = ${org.accountId}::uuid and provider = 'codex'`,
          ),
        ),
      ),
    ).toBe("succeeded");
    await asOrganizationOwner(org, (db) =>
      rawRows(
        db,
        sql`update subscription_provider_cutovers set enabled = true
        where account_id = ${org.accountId}::uuid and provider = 'codex'`,
      ),
    );
    for (const provider of ["xai", "claude"]) {
      for (const enabled of [true, false]) {
        const fresh = await organization(client!, `switch-${provider}-${enabled}`);
        expect(
          await failure(() =>
            asOrganizationOwner(fresh, (db) =>
              rawRows(
                db,
                sql`insert into subscription_provider_cutovers (account_id, provider, enabled)
                values (${fresh.accountId}::uuid, ${provider}, ${enabled})`,
              ),
            ),
          ),
        ).toContain('"subscription_provider_cutovers_receipt_insert"');
      }
      expect(
        await failure(() =>
          asOrganizationOwner(org, (db) =>
            rawRows(
              db,
              sql`insert into subscription_connections (
                account_id, provider, kind, credential_encrypted, ownership, scope_kind
              ) values (${org.accountId}::uuid, ${provider}, 'subscription', 'v1:x', 'shared', 'organization')`,
            ),
          ),
        ),
      ).toContain('"subscription_connections_receipt_insert"');
    }
    // Nor can an administrator (whom 0702's scope guard lets change a
    // connection's scope) move a Codex connection to another provider or
    // organization: that would bypass the insert restriction.
    const [codexConnection] = await asOrganizationOwner(org, (db) =>
      rawRows<{ id: string }>(
        db,
        sql`insert into subscription_connections (
          account_id, provider, kind, credential_encrypted, ownership, scope_kind
        ) values (${org.accountId}::uuid, 'codex', 'subscription', 'v1:x', 'shared', 'organization')
        returning id::text as id`,
      ),
    );
    const otherOrganization = await organization(client!, "connection-identity-other");
    for (const change of [
      sql`provider = 'xai'`,
      sql`provider = 'claude'`,
      sql`account_id = ${otherOrganization.accountId}::uuid`,
    ]) {
      expect(
        await failure(() =>
          asOrganizationOwner(org, (db) =>
            rawRows(
              db,
              sql`update subscription_connections set ${change}
              where id = ${codexConnection!.id}::uuid`,
            ),
          ),
        ),
      ).toContain("a subscription connection keeps its organization and provider");
    }
    const [unchanged] = await database!.admin<{ provider: string; account_id: string }[]>`
      select provider, account_id::text as account_id from subscription_connections
      where id = ${codexConnection!.id}::uuid`;
    expect(unchanged).toEqual({ provider: "codex", account_id: org.accountId });
    // A pre-existing Claude row can be disabled (fail-closed maintenance) but
    // never enabled again before Claude's receipt.
    expect(
      await failure(() =>
        asOrganizationOwner(org, (db) =>
          rawRows(
            db,
            sql`update subscription_provider_cutovers set enabled = false
            where account_id = ${org.accountId}::uuid and provider = 'claude'`,
          ),
        ),
      ),
    ).toBe("succeeded");
    expect(
      await failure(() =>
        asOrganizationOwner(org, (db) =>
          rawRows(
            db,
            sql`update subscription_provider_cutovers set enabled = true
            where account_id = ${org.accountId}::uuid and provider = 'claude'`,
          ),
        ),
      ),
    ).toContain('"subscription_provider_cutovers_receipt_update"');
    // No row changes provider or organization, whatever its provider, and the
    // runtime role deletes none.
    for (const provider of ["codex", "claude"]) {
      expect(
        await failure(() =>
          asOrganizationOwner(org, (db) =>
            rawRows(
              db,
              sql`update subscription_provider_cutovers set provider = 'xai'
              where account_id = ${org.accountId}::uuid and provider = ${provider}`,
            ),
          ),
        ),
      ).toContain(
        // 0689's Codex trigger fires first on a Codex row; 0712's on every other.
        provider === "codex"
          ? "a Codex cutover row keeps its organization and provider"
          : "a subscription cutover row keeps its organization and provider",
      );
    }
    const deleted = await asOrganizationOwner(org, (db) =>
      rawRows(
        db,
        sql`delete from subscription_provider_cutovers
        where account_id = ${org.accountId}::uuid returning provider`,
      ),
    );
    expect(deleted).toEqual([]);
    const [kept] = await database!.admin<{ total: number }[]>`
      select count(*)::int as total from subscription_provider_cutovers
      where account_id = ${org.accountId}::uuid`;
    expect(kept!.total).toBe(2);
    // The owner (FORCE RLS) is bound by the same restrictive policies.
    const owner = postgres(database!.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      expect(
        await failure(() =>
          owner.begin(async (tx) => {
            // Satisfy the permissive seed and administrator paths as far as an
            // owner can, so only the restrictive receipt policy can refuse.
            await tx`select set_config('opengeni.subscription_cutover_seed', ${org.accountId}, true),
              set_config('opengeni.account_id', ${org.accountId}, true),
              set_config('opengeni.workspace_id', ${org.personalWorkspaceId}, true),
              set_config('opengeni.subject_id', ${org.subjectId}, true)`;
            await tx`insert into subscription_provider_cutovers (account_id, provider, enabled)
              values (${org.accountId}::uuid, 'xai', true)`;
          }),
        ),
      ).toContain('"subscription_provider_cutovers_receipt_insert"');
    } finally {
      await owner.end();
    }
  });

  test("an organization created after 0712 is seeded exactly as before it, and only for Codex", async () => {
    const after = await organization(client!, "after");
    const seeded = await seededRows(after.accountId);
    expect(seeded).toEqual(before!.seeded as typeof seeded);
    expect(seeded).toEqual({
      cutovers: [
        {
          provider: "codex",
          enabled: true,
          updated_by_subject_id: "service:subscription-core-cutover",
        },
      ],
      settings: [
        {
          rotation: { codex: { mode: "spread" } },
          providers: {},
          cross_provider_failover: false,
          fallback_order: {},
          personal_connections_allowed: true,
          personal_fallback_allowed: false,
          updated_by_subject_id: "service:subscription-core-cutover",
          codex_primary_connection_id: null,
          claude_primary_connection_id: null,
          xai_primary_connection_id: null,
        },
      ],
    });
  });

  test("primaries are provider-checked; cross-provider primaries were cleared and reported", async () => {
    const { org, codexShared, xaiShared } = before!;
    const [settings] = await database!.admin`
      select codex_primary_connection_id::text as codex, claude_primary_connection_id::text as claude,
        xai_primary_connection_id::text as xai
      from subscription_settings where account_id = ${org.accountId}::uuid and workspace_id is null`;
    expect(settings).toEqual({ codex: null, claude: null, xai: xaiShared });
    const cleared = await database!.admin`
      select provider, legacy_count::int, core_count::int from opengeni_private.subscription_cutover_report
      where metric = 'disposition:primary_of_other_provider_cleared'
        and account_id = ${org.accountId}::uuid
      order by provider`;
    expect([...cleared]).toEqual([
      { provider: "claude", legacy_count: 1, core_count: 0 },
      { provider: "codex", legacy_count: 1, core_count: 0 },
    ]);
    // Even the superuser fixture writer cannot point a primary at another
    // provider's connection now.
    for (const [column, connection] of [
      ["codex_primary_connection_id", xaiShared],
      ["claude_primary_connection_id", codexShared],
      ["xai_primary_connection_id", codexShared],
    ] as const) {
      expect(
        await failure(() =>
          database!.admin.unsafe(
            `update subscription_settings set ${column} = $1::uuid
             where account_id = $2::uuid and workspace_id is null`,
            [connection, org.accountId],
          ),
        ),
      ).toStartWith("23503");
    }
    await database!.admin`
      update subscription_settings set codex_primary_connection_id = ${codexShared}::uuid
      where account_id = ${org.accountId}::uuid and workspace_id is null`;
    // Deleting the connection clears only its primary column.
    await database!.admin`delete from subscription_connections where id = ${codexShared}::uuid`;
    const [afterDelete] = await database!.admin`
      select codex_primary_connection_id, codex_primary_provider,
        xai_primary_connection_id::text as xai
      from subscription_settings where account_id = ${org.accountId}::uuid and workspace_id is null`;
    expect(afterDelete).toEqual({
      codex_primary_connection_id: null,
      codex_primary_provider: "codex",
      xai: xaiShared,
    });
  });

  test("the provider-keyed report keeps 0689's Codex rows and counts owners with several current generations", async () => {
    const [copied] = await database!.admin<{ legacy: number; moved: number }[]>`
      select (select count(*)::int from opengeni_private.subscription_codex_cutover_report) as legacy,
        (select count(*)::int from opengeni_private.subscription_cutover_report
          where provider = 'codex' and metric not like 'readiness:%'
            and metric not like 'inventory:%'
            and metric <> 'disposition:primary_of_other_provider_cleared') as moved`;
    expect(copied!.moved).toBe(copied!.legacy);
    const readiness = await database!.admin`
      select account_id::text as account_id, legacy_count::int, core_count::int
      from opengeni_private.subscription_cutover_report
      where provider = 'codex'
        and metric = 'readiness:owners_with_multiple_current_personal_generations'
      order by account_id nulls last`;
    expect([...readiness]).toEqual([
      { account_id: before!.org.accountId, legacy_count: 0, core_count: 1 },
      { account_id: null, legacy_count: 0, core_count: 1 },
    ]);
    // The rows a provider without a receipt already had are inventoried, so an
    // operator sees them without a row-security bypass.
    const inventory = await database!.admin`
      select provider, metric, account_id::text as account_id, core_count::int
      from opengeni_private.subscription_cutover_report
      where metric like 'inventory:%'
      order by provider, metric`;
    expect([...inventory]).toEqual([
      {
        provider: "claude",
        metric: "inventory:switch_rows_without_receipt",
        account_id: before!.org.accountId,
        core_count: 1,
      },
      {
        provider: "xai",
        metric: "inventory:connections_without_receipt",
        account_id: before!.org.accountId,
        core_count: 1,
      },
    ]);
  });

  test("operation kinds: video, model and credential_request for every provider; apps and completion stay Codex-only", async () => {
    const org = before!.org;
    const attempt = (provider: string, kind: string, sessionful: boolean) =>
      failure(() =>
        database!.admin.begin(async (tx) => {
          // Fixture only: skip the reference triggers and foreign keys to
          // exercise the kind constraint alone.
          await tx`set local session_replication_role = replica`;
          await tx`insert into subscription_operation_leases (
              account_id, workspace_id, operation_id, attempt_id, operation_kind, session_id,
              turn_id, provider, connection_id, holder_id, generation, leased_until
            ) values (${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid, gen_random_uuid(),
              gen_random_uuid(), ${kind}, ${sessionful ? crypto.randomUUID() : null}::uuid,
              ${sessionful ? crypto.randomUUID() : null}::uuid, ${provider}, gen_random_uuid(),
              'kind-fixture', 1, now())`;
          throw new Error("rolled back");
        }),
      );
    for (const provider of ["codex", "claude", "xai"]) {
      expect(await attempt(provider, "video", true)).toContain("rolled back");
      expect(await attempt(provider, "model", true)).toContain("rolled back");
      expect(await attempt(provider, "credential_request", false)).toContain("rolled back");
      expect(await attempt(provider, "video", false)).toContain(
        "subscription_operation_leases_reference_chk",
      );
    }
    expect(await attempt("codex", "apps", false)).toContain("rolled back");
    expect(await attempt("codex", "completion", false)).toContain("rolled back");
    for (const provider of ["claude", "xai"]) {
      for (const kind of ["apps", "completion"]) {
        expect(await attempt(provider, kind, false)).toContain(
          "subscription_operation_leases_kind_chk",
        );
      }
    }
    expect(await attempt("codex", "audio", true)).toContain(
      "subscription_operation_leases_kind_chk",
    );
  });

  test("model.connected is recorded once per core connection insert, never by a cutover move", async () => {
    const org = await organization(client!, "lifecycle");
    await database!
      .admin`update host_export_config set lifecycle_facts_enabled = true where id = 1`;
    try {
      const facts = () => database!.admin<{ attribute: string; source_id: string }[]>`
        select payload->>'attribute' as attribute, source_id::text as source_id
        from host_export_outbox
        where export_kind = 'lifecycle_fact' and account_id = ${org.accountId}::uuid
          and payload->>'factType' = 'model.connected'
        order by 1`;
      const codex = await sharedConnection(org, "codex", "lifecycle-codex");
      // The fixture writer bypasses the receipt policy to show the mapping.
      await sharedConnection(org, "xai", "lifecycle-xai");
      await sharedConnection(org, "claude", "lifecycle-claude");
      expect((await facts()).map((fact) => fact.attribute)).toEqual([
        "claude_subscription",
        "codex",
        "supergrok",
      ]);
      // Updating a connection records nothing more.
      await database!
        .admin`update subscription_connections set label = 'renamed' where id = ${codex}::uuid`;
      expect(await facts()).toHaveLength(3);
      // A drained cutover marks its own moves; they are not new connections.
      await database!.admin.begin(async (tx) => {
        await tx`select set_config('opengeni.subscription_cutover_provider', 'xai', true)`;
        await tx`insert into subscription_connections (
            account_id, provider, kind, credential_encrypted, ownership, scope_kind
          ) values (${org.accountId}::uuid, 'xai', 'subscription', 'v1:moved', 'shared', 'organization')`;
      });
      expect(await facts()).toHaveLength(3);
    } finally {
      await database!
        .admin`update host_export_config set lifecycle_facts_enabled = false where id = 1`;
    }
  });

  test("both personal helpers gate on the provider receipt and never read a v1 snapshot", async () => {
    // Behaviour is covered with real turns in subscription-core-runtime-postgres
    // (placement) and subscription-core-codex-chat-postgres (access). The source
    // of both helpers no longer names a provider or reads v1.
    const [sources] = await database!.admin<{ access: string; placement: string }[]>`
      select pg_get_functiondef('opengeni_private.authorize_subscription_personal_access(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure) as access,
        pg_get_functiondef('opengeni_private.authorize_subscription_personal_placement_access(uuid,uuid,uuid,uuid,text,uuid,bigint,text,text)'::regprocedure) as placement`;
    for (const source of [sources!.access, sources!.placement]) {
      expect(source).not.toMatch(/'codex'|'claude'|'xai'/);
      expect(source).not.toContain("provider_account_authority_snapshot");
      expect(source).toContain("subscription_provider_cutover_committed(p_provider)");
    }
    expect(sources!.access).toContain(
      "session.owner_organization_membership_id = connection.owner_organization_membership_id",
    );
  });

  test("a refresh never changes the credential format an adapter stored", async () => {
    const state = await ownerlessRefreshFixture({ admin: database!.admin, client: client! }, false);
    await database!.admin`
      update subscription_connections set credential_format = 'adapter_format_v7'
      where id = ${state.connectionId}::uuid`;
    const persisted = await withSubscriptionCoreAcceptedTurn(
      client!.db,
      state.identity,
      async (tx) => {
        const [begun] = await rawRows<{ refresh_generation: string }>(
          tx,
          sql`select refresh_generation from opengeni_private.begin_subscription_core_refresh('codex',
          ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
          ${state.identity.turnId}::uuid, ${null}, ${null}, ${state.connectionId}::uuid,
          ${state.lease.holderId}, ${state.lease.generation}::bigint)`,
        );
        const [row] = await rawRows<{ ok: boolean }>(
          tx,
          sql`select opengeni_private.persist_subscription_core_refresh_with_plan('codex',
          ${state.accountId}::uuid, ${state.workspaceId}::uuid, ${state.identity.sessionId}::uuid,
          ${state.identity.turnId}::uuid, ${state.connectionId}::uuid,
          ${Number(begun!.refresh_generation)}::bigint, ${encrypted("rotated")},
          now() + interval '1 hour', now(), 'team') as ok`,
        );
        return row?.ok;
      },
    );
    expect(persisted).toEqual({ status: "completed", value: true });
    const [row] = await database!.admin`
      select credential_format, plan_type
      from subscription_connections where id = ${state.connectionId}::uuid`;
    expect(row).toMatchObject({
      credential_format: "adapter_format_v7",
      plan_type: "team",
    });
    for (const routine of [
      "persist_subscription_core_refresh(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)",
      "persist_subscription_core_refresh_with_plan(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text)",
      "persist_subscription_core_connection_refresh(text,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)",
    ]) {
      const [definition] = await database!.admin<{ source: string }[]>`
        select pg_get_functiondef(${`opengeni_private.${routine}`}::regprocedure) as source`;
      expect(definition!.source).not.toContain("credential_format");
    }
  });
});
