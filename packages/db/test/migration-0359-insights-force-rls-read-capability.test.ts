import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  nestedPostgresSqlState,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const hostilePassword = "insights_hostile_default_privileges";
const intruderPassword = "insights_hostile_function_defaults";
const reportingPassword = "insights_unconfigured_reporting_role";

setDefaultTimeout(900_000);

let owned: OwnerMigratedTestDatabase | null = null;
let appClient: DbClient | null = null;
let app: postgres.Sql | null = null;
let hostile: postgres.Sql | null = null;
let intruder: postgres.Sql | null = null;
let reporting: postgres.Sql | null = null;
let hostileRole: string | null = null;
let intruderRole: string | null = null;
let reportingRole: string | null = null;

type Fixture = {
  accountId: string;
  workspaceId: string;
  ownerSubjectId: string;
  privateSessionId: string;
  sharedSessionIds: string[];
  since: Date;
  until: Date;
};

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

async function setInsightsContext(
  tx: postgres.TransactionSql,
  input: Fixture,
  subjectId: string | null,
  initiatingHumanSubjectId: string | null = null,
): Promise<void> {
  await tx`select set_config('opengeni.account_id', ${input.accountId}, true)`;
  await tx`select set_config('opengeni.workspace_id', ${input.workspaceId}, true)`;
  await tx`select set_config('opengeni.subject_id', ${subjectId ?? ""}, true)`;
  await tx`select set_config(
    'opengeni.initiating_human_subject_id',
    ${initiatingHumanSubjectId ?? ""},
    true
  )`;
}

async function seedFixture(): Promise<Fixture> {
  if (!owned || !appClient) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `insights-force-rls-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(appClient.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Insights FORCE RLS owner",
  });
  const grant = access.workspaceGrants[0]!;

  await owned.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(appClient.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(appClient.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });

  const privateSession = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
    createSession(appClient!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "private Insights fact",
      resources: [],
      metadata: {},
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  await transitionSessionVisibility(appClient.db, {
    workspaceId: grant.workspaceId!,
    sessionId: privateSession.id,
    actorSubjectId: ownerSubjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `insights-force-rls-private-${suffix}`,
  });
  const sharedSessions = await Promise.all(
    ["shared alpha", "shared beta"].map((initialMessage) =>
      withSessionRlsActorContext({ subjectId: ownerSubjectId }, () =>
        createSession(appClient!.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          initialMessage,
          resources: [],
          metadata: {},
          model: "fixture-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      ),
    ),
  );

  const since = new Date(Date.now() - 60_000);
  const until = new Date(Date.now() + 60_000);
  await owned.admin`
    insert into model_call_facts (
      account_id, workspace_id, session_id, turn_id, source_key, provider,
      provider_api, model, billing_path, input_tokens, total_tokens,
      priced_cost_micros, occurred_at
    ) values
      (${grant.accountId}, ${grant.workspaceId}, ${privateSession.id}, ${crypto.randomUUID()},
       ${`private-${suffix}`}, 'alpha', 'responses', 'model-one', 'external', 1, 1, 0, now()),
      (${grant.accountId}, ${grant.workspaceId}, ${sharedSessions[0]!.id}, ${crypto.randomUUID()},
       ${`shared-alpha-${suffix}`}, 'alpha', 'responses', 'model-one', 'external', 1, 1, 0, now()),
      (${grant.accountId}, ${grant.workspaceId}, ${sharedSessions[1]!.id}, ${crypto.randomUUID()},
       ${`shared-beta-${suffix}`}, 'beta', 'responses', 'model-two', 'external', 1, 1, 0, now())`;
  await owned.admin`
    insert into usage_events (
      account_id, workspace_id, event_type, quantity, unit, session_id,
      idempotency_key, occurred_at
    ) values
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 1, 'micros',
       ${privateSession.id}, ${`private-${suffix}`}, now()),
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 2, 'micros',
       ${sharedSessions[0]!.id}, ${`shared-${suffix}`}, now()),
      (${grant.accountId}, ${grant.workspaceId}, 'model.cost', 4, 'micros',
       null, ${`workspace-${suffix}`}, now()),
      (${grant.accountId}, ${grant.workspaceId}, 'agent_run.created', 8, 'count',
       ${sharedSessions[1]!.id}, ${`created-${suffix}`}, now())`;

  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    ownerSubjectId,
    privateSessionId: privateSession.id,
    sharedSessionIds: sharedSessions.map((session) => session.id),
    since,
    until,
  };
}

async function visibleCounts(
  sql: postgres.Sql,
  input: Fixture,
  subjectId: string | null,
  initiatingHumanSubjectId: string | null = null,
) {
  return await sql.begin(async (tx) => {
    await setInsightsContext(tx, input, subjectId, initiatingHumanSubjectId);
    const [models] = await tx<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.visible_workspace_insights_model_call_facts(
        ${input.workspaceId}, ${input.since}, ${input.until}
      )`;
    const [usage] = await tx<Array<{ count: number; quantity: number }>>`
      select count(*)::int as count, coalesce(sum(quantity), 0)::int as quantity
      from opengeni_private.visible_workspace_insights_usage_events(
        ${input.workspaceId}, ${input.since}, ${input.until}
      )`;
    return { models: models!, usage: usage! };
  });
}

function executionTimeMs(plan: unknown): number {
  if (!Array.isArray(plan)) return Number.POSITIVE_INFINITY;
  const first = plan[0];
  if (!first || typeof first !== "object") return Number.POSITIVE_INFINITY;
  const value = (first as Record<string, unknown>)["Execution Time"];
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-0359-insights-force-rls");
  if (!owned) {
    if (requireRealDatabase) {
      throw new Error("Insights 0359 real PostgreSQL fixture is unavailable");
    }
    return;
  }

  hostileRole = `${owned.ownerRole}_hostile`.slice(0, 63);
  intruderRole = `${owned.ownerRole}_intruder`.slice(0, 63);
  reportingRole = `${owned.ownerRole}_reporting`.slice(0, 63);
  await owned.admin.unsafe(`
    CREATE ROLE "${hostileRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
      NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${hostilePassword}';
    CREATE ROLE "${intruderRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
      NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${intruderPassword}';
    CREATE ROLE "${reportingRole}" WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE
      NOCREATEDB NOREPLICATION NOINHERIT PASSWORD '${reportingPassword}'
  `);
  const owner = postgres(owned.ownerUrl, { max: 1, prepare: false });
  try {
    await owner.unsafe(`
      CREATE SCHEMA IF NOT EXISTS opengeni_private AUTHORIZATION CURRENT_USER;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION opengeni_private.test_enable_insights_hostile_defaults()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $body$
      BEGIN
        IF NEW.name = '0355_automatic_session_title_quarantine.sql' THEN
          EXECUTE 'GRANT SELECT ON TABLE public.model_call_facts, public.usage_events '
            || 'TO "${hostileRole}"';
          EXECUTE 'GRANT USAGE ON SCHEMA public, opengeni_private '
            || 'TO "${reportingRole}"';
          EXECUTE 'GRANT SELECT ON TABLE public.model_call_facts, public.usage_events, '
            || 'public.sessions TO "${reportingRole}"';
          -- Mirror an existing operator that can execute every helper needed by
          -- the already-installed scalar policies. The 0356/0359 analytical
          -- functions do not exist yet and the role is not an application role.
          EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, opengeni_private '
            || 'TO "${reportingRole}"';
          EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private '
            || 'GRANT ALL ON TABLES TO "${hostileRole}"';
          EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private '
            || 'GRANT EXECUTE ON FUNCTIONS TO "${intruderRole}"';
        END IF;
        RETURN NEW;
      END
      $body$;
      CREATE TRIGGER test_enable_insights_hostile_defaults
      AFTER INSERT ON schema_migrations
      FOR EACH ROW
      EXECUTE FUNCTION opengeni_private.test_enable_insights_hostile_defaults()
    `);
  } finally {
    await owner.end({ timeout: 5 });
  }

  await migrate(owned.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app", hostileRole],
  });
  await provisionRoles(owned.adminUrl, {
    appPassword: owned.appPassword,
    rlsStrategy: "force",
  });

  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  appClient = createDb(appUrl.toString(), { max: 8, rlsStrategy: "force" });
  app = postgres(appUrl.toString(), {
    max: 2,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    onnotice: () => undefined,
  });

  await owned.admin.unsafe(`
    GRANT USAGE ON SCHEMA public, opengeni_private TO "${hostileRole}";
    GRANT USAGE ON SCHEMA opengeni_private TO "${intruderRole}";
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${hostileRole}";
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${hostileRole}"
  `);
  const hostileUrl = new URL(owned.ownerUrl);
  hostileUrl.username = hostileRole;
  hostileUrl.password = hostilePassword;
  hostile = postgres(hostileUrl.toString(), {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    onnotice: () => undefined,
  });
  const intruderUrl = new URL(owned.ownerUrl);
  intruderUrl.username = intruderRole;
  intruderUrl.password = intruderPassword;
  intruder = postgres(intruderUrl.toString(), {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    onnotice: () => undefined,
  });
  const reportingUrl = new URL(owned.ownerUrl);
  reportingUrl.username = reportingRole;
  reportingUrl.password = reportingPassword;
  reporting = postgres(reportingUrl.toString(), {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    onnotice: () => undefined,
  });
}, 900_000);

afterAll(async () => {
  await reporting?.end({ timeout: 5 }).catch(() => undefined);
  await hostile?.end({ timeout: 5 }).catch(() => undefined);
  await intruder?.end({ timeout: 5 }).catch(() => undefined);
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await appClient?.close().catch(() => undefined);
  if (owned && hostileRole && intruderRole && reportingRole) {
    await owned.admin
      .unsafe(`
        DROP OWNED BY "${hostileRole}";
        DROP OWNED BY "${intruderRole}";
        DROP OWNED BY "${reportingRole}";
        DROP ROLE IF EXISTS "${hostileRole}";
        DROP ROLE IF EXISTS "${intruderRole}";
        DROP ROLE IF EXISTS "${reportingRole}"
      `)
      .catch(() => undefined);
  }
  await owned?.release();
}, 180_000);

describe("migration 0359 Insights FORCE-RLS read capability", () => {
  test("keeps the capability private under a production owner and hostile defaults", async () => {
    if (!owned || !hostileRole || !intruderRole || !reportingRole || !hostile || !intruder) return;

    const [identity] = await owned.admin<Array<{ superuser: boolean; bypassRls: boolean }>>`
      select rolsuper as superuser, rolbypassrls as "bypassRls"
      from pg_roles where rolname = ${owned.ownerRole}`;
    expect(identity).toEqual({ superuser: false, bypassRls: false });

    const [privileges] = await owned.admin<
      Array<{
        ownerSelect: boolean;
        appSelect: boolean;
        appInsert: boolean;
        appUpdate: boolean;
        appDelete: boolean;
        hostileSelect: boolean;
        hostileInsert: boolean;
        hostileDelete: boolean;
        hostileModel: boolean;
        hostileUsage: boolean;
        intruderModelReleased: boolean;
        intruderModel: boolean;
        intruderUsageReleased: boolean;
        intruderUsage: boolean;
        reportingPrivateSchema: boolean;
        reportingWorkspacePredicate: boolean;
        reportingScalarPredicate: boolean;
        reportingModel: boolean;
        reportingPolicyPredicate: boolean;
      }>
    >`
      select
        has_table_privilege(
          ${owned.ownerRole},
          'opengeni_private.insights_fact_read_runtime_capabilities', 'SELECT'
        ) as "ownerSelect",
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.insights_fact_read_runtime_capabilities', 'SELECT'
        ) as "appSelect",
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.insights_fact_read_runtime_capabilities', 'INSERT'
        ) as "appInsert",
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.insights_fact_read_runtime_capabilities', 'UPDATE'
        ) as "appUpdate",
        has_table_privilege(
          'opengeni_app',
          'opengeni_private.insights_fact_read_runtime_capabilities', 'DELETE'
        ) as "appDelete",
        has_table_privilege(
          ${hostileRole},
          'opengeni_private.insights_fact_read_runtime_capabilities', 'SELECT'
        ) as "hostileSelect",
        has_table_privilege(
          ${hostileRole},
          'opengeni_private.insights_fact_read_runtime_capabilities', 'INSERT'
        ) as "hostileInsert",
        has_table_privilege(
          ${hostileRole},
          'opengeni_private.insights_fact_read_runtime_capabilities', 'DELETE'
        ) as "hostileDelete",
        has_function_privilege(
          ${hostileRole},
          'opengeni_private.visible_workspace_insights_model_call_facts(uuid,timestamptz,timestamptz,text,text)',
          'EXECUTE'
        ) as "hostileModel",
        has_function_privilege(
          ${hostileRole},
          'opengeni_private.visible_workspace_insights_usage_events(uuid,timestamptz,timestamptz,text[])',
          'EXECUTE'
        ) as "hostileUsage",
        has_function_privilege(
          ${intruderRole},
          'opengeni_private.visible_workspace_insights_model_call_facts(uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) as "intruderModelReleased",
        has_function_privilege(
          ${intruderRole},
          'opengeni_private.visible_workspace_insights_model_call_facts(uuid,timestamptz,timestamptz,text,text)',
          'EXECUTE'
        ) as "intruderModel",
        has_function_privilege(
          ${intruderRole},
          'opengeni_private.visible_workspace_insights_usage_events(uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) as "intruderUsageReleased",
        has_function_privilege(
          ${intruderRole},
          'opengeni_private.visible_workspace_insights_usage_events(uuid,timestamptz,timestamptz,text[])',
          'EXECUTE'
        ) as "intruderUsage",
        has_schema_privilege(
          ${reportingRole}, 'opengeni_private', 'USAGE'
        ) as "reportingPrivateSchema",
        has_function_privilege(
          ${reportingRole},
          'opengeni_private.workspace_rls_visible(uuid,uuid)', 'EXECUTE'
        ) as "reportingWorkspacePredicate",
        has_function_privilege(
          ${reportingRole},
          'public.session_reference_visible(uuid,uuid,uuid)', 'EXECUTE'
        ) as "reportingScalarPredicate",
        has_function_privilege(
          ${reportingRole},
          'opengeni_private.visible_workspace_insights_model_call_facts(uuid,timestamptz,timestamptz)',
          'EXECUTE'
        ) as "reportingModel",
        has_function_privilege(
          ${reportingRole},
          'public.insights_fact_read_policy_capability_active(text,text,text)', 'EXECUTE'
        ) as "reportingPolicyPredicate"`;
    expect(privileges).toEqual({
      ownerSelect: true,
      appSelect: false,
      appInsert: false,
      appUpdate: false,
      appDelete: false,
      hostileSelect: false,
      hostileInsert: false,
      hostileDelete: false,
      hostileModel: true,
      hostileUsage: true,
      intruderModelReleased: false,
      intruderModel: false,
      intruderUsageReleased: false,
      intruderUsage: false,
      reportingPrivateSchema: true,
      reportingWorkspacePredicate: true,
      reportingScalarPredicate: true,
      reportingModel: false,
      reportingPolicyPredicate: true,
    });

    const defaultPrivilege = await owned.admin<Array<{ privilege: string }>>`
      select privilege.privilege_type as privilege
      from pg_default_acl default_acl
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      inner join pg_roles grantee on grantee.oid = privilege.grantee
      where default_acl.defaclrole = ${owned.ownerRole}::regrole
        and default_acl.defaclobjtype = 'r'
        and grantee.rolname = ${hostileRole}
      order by privilege.privilege_type`;
    expect(defaultPrivilege.map((row) => row.privilege)).toContain("INSERT");
    expect(defaultPrivilege.map((row) => row.privilege)).toContain("SELECT");
    const functionDefaultPrivilege = await owned.admin<Array<{ privilege: string }>>`
      select privilege.privilege_type as privilege
      from pg_default_acl default_acl
      cross join lateral aclexplode(default_acl.defaclacl) privilege
      inner join pg_roles grantee on grantee.oid = privilege.grantee
      where default_acl.defaclrole = ${owned.ownerRole}::regrole
        and default_acl.defaclobjtype = 'f'
        and grantee.rolname = ${intruderRole}`;
    expect(Array.from(functionDefaultPrivilege)).toEqual([{ privilege: "EXECUTE" }]);

    const functions = await owned.admin<
      Array<{
        name: string;
        arguments: string;
        securityDefiner: boolean;
        volatility: string;
        configuration: string[] | null;
        publicExecute: boolean;
      }>
    >`
      select
        procedure.proname as name,
        pg_get_function_identity_arguments(procedure.oid) as arguments,
        procedure.prosecdef as "securityDefiner",
        procedure.provolatile as volatility,
        procedure.proconfig as configuration,
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      inner join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname in (
          'visible_workspace_insights_model_call_facts',
          'visible_workspace_insights_usage_events'
        )
      order by procedure.proname, procedure.pronargs`;
    expect(functions).toHaveLength(4);
    for (const procedure of functions) {
      expect(procedure.securityDefiner).toBe(true);
      expect(procedure.publicExecute).toBe(false);
      expect(procedure.configuration).toEqual([
        "search_path=pg_catalog, public, opengeni_private, pg_temp",
      ]);
      expect(procedure.volatility).toBe("v");
    }

    const [policyPredicate] = await owned.admin<
      Array<{
        securityDefiner: boolean;
        volatility: string;
        configuration: string[] | null;
        publicExecute: boolean;
      }>
    >`
      select
        procedure.prosecdef as "securityDefiner",
        procedure.provolatile as volatility,
        procedure.proconfig as configuration,
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      inner join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname = 'insights_fact_read_policy_capability_active'
        and pg_get_function_identity_arguments(procedure.oid) =
          'p_actor text, p_expected_owner text, p_capability_kind text'`;
    expect(policyPredicate).toEqual({
      securityDefiner: true,
      volatility: "s",
      configuration: ["search_path=pg_catalog"],
      publicExecute: true,
    });

    const factPolicies = await owned.admin<
      Array<{
        tableName: string;
        policyName: string;
        command: string;
        usingExpression: string | null;
        checkExpression: string | null;
      }>
    >`
      select
        tablename as "tableName",
        policyname as "policyName",
        cmd as command,
        qual as "usingExpression",
        with_check as "checkExpression"
      from pg_policies
      where schemaname = current_schema()
        and tablename in ('model_call_facts', 'usage_events', 'sessions')
        and policyname like 'session_visibility%'
      order by tablename, cmd`;
    for (const tableName of ["model_call_facts", "usage_events"]) {
      const tablePolicies = factPolicies.filter((policy) => policy.tableName === tableName);
      expect(tablePolicies).toHaveLength(4);
      const selectPolicy = tablePolicies.find((policy) => policy.command === "SELECT");
      expect(selectPolicy?.policyName).toBe("session_visibility_isolation");
      expect(selectPolicy?.usingExpression).toContain(
        "insights_fact_read_policy_capability_active",
      );
      expect(selectPolicy?.usingExpression).toContain("session_reference_visible");
      expect(selectPolicy?.checkExpression).toBeNull();
      for (const policy of tablePolicies.filter((candidate) => candidate.command !== "SELECT")) {
        expect(`${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`).toContain(
          "session_reference_visible",
        );
        expect(`${policy.usingExpression ?? ""} ${policy.checkExpression ?? ""}`).not.toContain(
          "insights_fact_read_policy_capability_active",
        );
      }
    }
    const sessionPolicies = factPolicies.filter((policy) => policy.tableName === "sessions");
    expect(sessionPolicies).toHaveLength(1);
    expect(sessionPolicies[0]!.policyName).toBe("session_visibility_isolation");
    expect(sessionPolicies[0]!.command).toBe("ALL");
    expect(
      `${sessionPolicies[0]!.usingExpression ?? ""} ${sessionPolicies[0]!.checkExpression ?? ""}`,
    ).not.toContain("insights_fact_read_policy_capability_active");

    await expectSqlState(
      () =>
        hostile!.unsafe("select * from opengeni_private.insights_fact_read_runtime_capabilities"),
      "42501",
    );
    await expectSqlState(
      () =>
        hostile!.unsafe(`
          insert into opengeni_private.insights_fact_read_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id, workspace_id
          ) values (
            pg_backend_pid(), pg_current_xact_id(), 'model_call_facts',
            gen_random_uuid(), gen_random_uuid()
          )
        `),
      "42501",
    );
    await expectSqlState(
      () => hostile!.unsafe("delete from opengeni_private.insights_fact_read_runtime_capabilities"),
      "42501",
    );
  });

  test("preserves ordinary fact reads for an unconfigured reporting role", async () => {
    if (!owned || !reporting || !reportingRole) return;
    const input = await seedFixture();
    const unrelatedSubject = `user:${crypto.randomUUID()}`;

    const observed = await reporting.begin(async (tx) => {
      await setInsightsContext(tx, input, unrelatedSubject);
      const [policyCapability] = await tx<Array<{ active: boolean }>>`
        select insights_fact_read_policy_capability_active(
          ${owned!.ownerRole}, ${owned!.ownerRole}, 'model_call_facts'
        ) as active`;
      const [models] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from model_call_facts
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and occurred_at >= ${input.since}
          and occurred_at < ${input.until}`;
      const [usage] = await tx<Array<{ count: number; quantity: number }>>`
        select count(*)::int as count, coalesce(sum(quantity), 0)::int as quantity
        from usage_events
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and occurred_at >= ${input.since}
          and occurred_at < ${input.until}`;
      return { policyCapability, models, usage };
    });

    expect(observed).toEqual({
      policyCapability: { active: false },
      models: { count: 2 },
      usage: { count: 3, quantity: 14 },
    });
  });

  test("preserves private, shared, subjectless, filtered, and empty-window behavior", async () => {
    if (!owned || !app) return;
    const input = await seedFixture();

    expect(await visibleCounts(app, input, input.ownerSubjectId)).toEqual({
      models: { count: 3 },
      usage: { count: 4, quantity: 15 },
    });
    expect(await visibleCounts(app, input, `user:${crypto.randomUUID()}`)).toEqual({
      models: { count: 2 },
      usage: { count: 3, quantity: 14 },
    });
    expect(await visibleCounts(app, input, null)).toEqual({
      models: { count: 3 },
      usage: { count: 4, quantity: 15 },
    });
    expect(await visibleCounts(app, input, "agent:fixture", input.ownerSubjectId)).toEqual({
      models: { count: 3 },
      usage: { count: 4, quantity: 15 },
    });

    const filtered = await app.begin(async (tx) => {
      await setInsightsContext(tx, input, input.ownerSubjectId);
      const [model] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}, 'alpha', 'model-one'
        )`;
      const [providerOnly] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}, 'beta', null
        )`;
      const [modelOnly] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}, null, 'model-two'
        )`;
      const [usage] = await tx<Array<{ count: number; quantity: number }>>`
        select count(*)::int as count, coalesce(sum(quantity), 0)::int as quantity
        from opengeni_private.visible_workspace_insights_usage_events(
          ${input.workspaceId}, ${input.since}, ${input.until}, ${["model.cost"]}::text[]
        )`;
      const [emptyModel] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.since}
        )`;
      const [emptyUsage] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_usage_events(
          ${input.workspaceId}, ${input.since}, ${input.since}, ${["model.cost"]}::text[]
        )`;
      return { model, providerOnly, modelOnly, usage, emptyModel, emptyUsage };
    });
    expect(filtered).toEqual({
      model: { count: 2 },
      providerOnly: { count: 1 },
      modelOnly: { count: 1 },
      usage: { count: 3, quantity: 7 },
      emptyModel: { count: 0 },
      emptyUsage: { count: 0 },
    });

    const invalidUsageTypes: Array<string[] | null> = [
      null,
      [],
      ["model.cost", "model.cost"],
      ["model.cost", " "],
      Array.from({ length: 17 }, (_, index) => `event.${index}`),
      ["x".repeat(257)],
    ];
    for (const eventTypes of invalidUsageTypes) {
      await expect(
        app.begin(async (tx) => {
          await setInsightsContext(tx, input, input.ownerSubjectId);
          await tx`
            select count(*)
            from opengeni_private.visible_workspace_insights_usage_events(
              ${input.workspaceId}, ${input.since}, ${input.until}, ${eventTypes}::text[]
            )`;
        }),
      ).rejects.toThrow("1-16 unique bounded values");
    }
    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx`
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            null, ${input.since}, ${input.until}
          )`;
      }),
    ).rejects.toThrow("does not match the requested workspace");
    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx`
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            ${input.workspaceId}, ${input.until}, ${input.since}
          )`;
      }),
    ).rejects.toThrow("non-negative and at most 370 days");
    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx`
          select count(*)
          from opengeni_private.visible_workspace_insights_usage_events(
            ${input.workspaceId},
            ${new Date(input.until.getTime() - 371 * 24 * 60 * 60 * 1_000)},
            ${input.until}
          )`;
      }),
    ).rejects.toThrow("non-negative and at most 370 days");
    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx.unsafe(`
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            '${input.workspaceId}'::uuid, 'infinity'::timestamptz, 'infinity'::timestamptz
          )
        `);
      }),
    ).rejects.toThrow("non-negative and at most 370 days");
    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx`
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            ${input.workspaceId}, ${input.since}, ${input.until}, ${"x".repeat(257)}, null
          )`;
      }),
    ).rejects.toThrow("model filters are invalid");

    const [leftover] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.insights_fact_read_runtime_capabilities`;
    expect(leftover?.count).toBe(0);
  });

  test("cannot forge or retain the transaction capability", async () => {
    if (!owned || !hostile || !app) return;
    const input = await seedFixture();
    const unrelatedSubject = `user:${crypto.randomUUID()}`;

    const hostileObserved = await hostile.begin(async (tx) => {
      await setInsightsContext(tx, input, unrelatedSubject);
      await tx`select set_config('opengeni.insights_fact_read_capability', 'model_call_facts', true)`;
      const [before] = await tx<Array<{ active: boolean }>>`
        select insights_fact_read_policy_capability_active(
          ${owned!.ownerRole}, ${owned!.ownerRole}, 'model_call_facts'
        ) as active`;
      const [viaFunction] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}
        )`;
      const [after] = await tx<Array<{ active: boolean }>>`
        select insights_fact_read_policy_capability_active(
          ${owned!.ownerRole}, ${owned!.ownerRole}, 'model_call_facts'
        ) as active`;
      return { before, viaFunction, after };
    });
    expect(hostileObserved).toEqual({
      before: { active: false },
      viaFunction: { count: 2 },
      after: { active: false },
    });

    const appObserved = await app.begin(async (tx) => {
      await setInsightsContext(tx, input, unrelatedSubject);
      await tx`select set_config('opengeni.insights_fact_read_capability', 'model_call_facts', true)`;
      const [directBefore] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from model_call_facts
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and occurred_at >= ${input.since}
          and occurred_at < ${input.until}`;
      const [viaFunction] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from opengeni_private.visible_workspace_insights_model_call_facts(
          ${input.workspaceId}, ${input.since}, ${input.until}
        )`;
      const [activeAfter] = await tx<Array<{ active: boolean }>>`
        select insights_fact_read_policy_capability_active(
          ${owned!.ownerRole}, ${owned!.ownerRole}, 'model_call_facts'
        ) as active`;
      const [directAfter] = await tx<Array<{ count: number }>>`
        select count(*)::int as count
        from model_call_facts
        where account_id = ${input.accountId}
          and workspace_id = ${input.workspaceId}
          and occurred_at >= ${input.since}
          and occurred_at < ${input.until}`;
      return { directBefore, viaFunction, activeAfter, directAfter };
    });
    expect(appObserved).toEqual({
      directBefore: { count: 2 },
      viaFunction: { count: 2 },
      activeAfter: { active: false },
      directAfter: { count: 2 },
    });

    await expect(
      app.begin(async (tx) => {
        await setInsightsContext(tx, input, input.ownerSubjectId);
        await tx`set local statement_timeout = '1ms'`;
        await tx`
          select count(*)
          from generate_series(1, 1000) repetition(n)
          cross join lateral opengeni_private.visible_workspace_insights_model_call_facts(
            ${input.workspaceId}, ${input.since}, ${input.until},
            case when repetition.n > 0 then null::text end,
            null
          )`;
      }),
    ).rejects.toBeDefined();
    const [leftover] = await owned.admin<Array<{ count: number }>>`
      select count(*)::int as count
      from opengeni_private.insights_fact_read_runtime_capabilities`;
    expect(leftover?.count).toBe(0);
  });

  test("uses the selective index after generic-plan caching and materially avoids scalar RLS", async () => {
    if (!owned || !appClient || !app) return;
    const input = await seedFixture();
    const sessionCount = 256;
    const factsPerSession = 8;
    const sessionIds: string[] = [];
    for (let offset = 0; offset < sessionCount; offset += 16) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(16, sessionCount - offset) }, (_, index) =>
          createSession(appClient!.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            initialMessage: `Insights FORCE-RLS performance ${offset + index}`,
            resources: [],
            metadata: {},
            model: "fixture-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
          }),
        ),
      );
      sessionIds.push(...batch.map((session) => session.id));
    }
    await owned.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider,
        provider_api, model, billing_path, input_tokens, total_tokens,
        priced_cost_micros, occurred_at
      )
      select
        ${input.accountId}, ${input.workspaceId}, bulk_session.id,
        gen_random_uuid(), ${`perf-${crypto.randomUUID()}-`} || row_number() over ()::text,
        case when fact.n = 1 then 'needle' else 'noise' end,
        'responses',
        case when fact.n = 1 then 'needle-model' else 'noise-model' end,
        'external', 1, 1, 0, now()
      from unnest(${sessionIds}::uuid[]) bulk_session(id)
      cross join generate_series(1, ${factsPerSession}) fact(n)`;
    await owned.admin.unsafe("analyze model_call_facts; analyze sessions; select pg_stat_reset()");

    const plans = await app.begin(async (tx) => {
      await setInsightsContext(tx, input, null);
      await tx`set local plan_cache_mode = 'force_generic_plan'`;
      for (let index = 0; index < 8; index += 1) {
        await tx`
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            ${input.workspaceId}, ${input.since}, ${input.until}, 'needle', 'needle-model'
          )`;
      }
      const directTimes: number[] = [];
      const repairedTimes: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        const direct = await tx.unsafe<Array<Record<string, unknown>>>(`
          explain (analyze, format json)
          select count(*)
          from model_call_facts
          where account_id = '${input.accountId}'::uuid
            and workspace_id = '${input.workspaceId}'::uuid
            and occurred_at >= '${input.since.toISOString()}'::timestamptz
            and occurred_at < '${input.until.toISOString()}'::timestamptz
        `);
        const repaired = await tx.unsafe<Array<Record<string, unknown>>>(`
          explain (analyze, format json)
          select count(*)
          from opengeni_private.visible_workspace_insights_model_call_facts(
            '${input.workspaceId}'::uuid,
            '${input.since.toISOString()}'::timestamptz,
            '${input.until.toISOString()}'::timestamptz
          )
        `);
        directTimes.push(executionTimeMs(direct[0]?.["QUERY PLAN"]));
        repairedTimes.push(executionTimeMs(repaired[0]?.["QUERY PLAN"]));
      }
      return { directTimes, repairedTimes };
    });
    expect(median(plans.repairedTimes)).toBeLessThan(median(plans.directTimes) / 1.5);

    let selectiveIndexScans = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [indexStats] = await owned.admin<Array<{ scans: number }>>`
        select idx_scan::int as scans
        from pg_stat_user_indexes
        where indexrelname = 'model_call_facts_workspace_provider_model_occurred_idx'`;
      selectiveIndexScans = indexStats?.scans ?? 0;
      if (selectiveIndexScans > 0) break;
      await Bun.sleep(25);
    }
    expect(selectiveIndexScans).toBeGreaterThan(0);

    const owner = postgres(owned.ownerUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    });
    try {
      const plan = await owner.begin(async (tx) => {
        await setInsightsContext(tx, input, null);
        await tx`
          insert into opengeni_private.insights_fact_read_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id, workspace_id,
            subject_id, initiating_human_subject_id
          ) values (
            pg_backend_pid(), pg_current_xact_id(), 'model_call_facts',
            ${input.accountId}, ${input.workspaceId}, null, null
          )`;
        const explained = await tx.unsafe<Array<Record<string, unknown>>>(`
          explain (analyze, format json)
          select fact.*
          from model_call_facts fact
          inner join sessions session_row
            on session_row.account_id = fact.account_id
            and session_row.workspace_id = fact.workspace_id
            and session_row.id = fact.session_id
          where fact.account_id = '${input.accountId}'::uuid
            and fact.workspace_id = '${input.workspaceId}'::uuid
            and fact.provider = 'needle'
            and fact.model = 'needle-model'
            and fact.occurred_at >= '${input.since.toISOString()}'::timestamptz
            and fact.occurred_at < '${input.until.toISOString()}'::timestamptz
        `);
        await tx`
          delete from opengeni_private.insights_fact_read_runtime_capabilities
          where backend_pid = pg_backend_pid()
            and transaction_id = pg_current_xact_id_if_assigned()
            and capability_kind = 'model_call_facts'`;
        return explained[0]?.["QUERY PLAN"];
      });
      expect(JSON.stringify(plan)).toContain(
        "model_call_facts_workspace_provider_model_occurred_idx",
      );
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
