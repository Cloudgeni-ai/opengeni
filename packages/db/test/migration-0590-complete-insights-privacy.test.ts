import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  provisionRoles,
} from "../src/index";

setDefaultTimeout(180_000);
let shared: SharedTestDatabase | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("complete-insights-private-helper-acl");
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

test("0590 inline private amounts expose only the restricted runtime reader boundary", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const [installed] = await shared.admin<Array<{ helper: string | null; summary: string }>>`
    select to_regprocedure('opengeni_private.organization_private_chat_usage(uuid,timestamptz,timestamptz)')::text as helper,
      pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure) as summary`;
  expect(installed?.helper).toBeNull();
  expect(installed?.summary).toContain("'privateChatsTruncated'");
  expect(installed?.summary).not.toContain("organization_private_chat_usage");
  const applicationRole = new URL(shared.appUrl).username;
  const routines = await shared.admin<
    Array<{ name: string; execute: boolean; publicExecute: boolean }>
  >`
    select proname as name, has_function_privilege(${applicationRole}, procedure.oid, 'EXECUTE') as execute,
      exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
    from pg_proc procedure join pg_namespace namespace on namespace.oid = pronamespace
    where namespace.nspname = 'opengeni_private' and proname in
      ('complete_workspace_insights_usage_projection', 'workspace_insights_amount_fact_rows',
       'organization_model_usage_summary', 'visible_workspace_insights_model_fact_rows')`;
  expect(routines).toHaveLength(4);
  // Released readers remain callable by the restricted runtime, never PUBLIC.
  // The obsolete owner-only private-chat helper must not reappear.
  expect(routines.filter((routine) => !routine.execute)).toEqual([]);
  expect(routines.every((routine) => !routine.publicExecute)).toBe(true);
});

test("current provisioning repeatedly removes polluted PUBLIC grants on all four released amount readers", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const signatures = [
    "opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)",
    "opengeni_private.visible_workspace_insights_model_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)",
    "opengeni_private.complete_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[])",
    "opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)",
  ];
  const role = new URL(shared.appUrl).username;
  const roles = {
    appRole: role,
    appPassword: new URL(shared.appUrl).password,
    rlsStrategy: "force" as const,
  };
  try {
    for (const signature of signatures)
      await shared.admin.unsafe(`grant execute on function ${signature} to PUBLIC`);
    const [polluted] = await shared.admin<Array<{ readers: number }>>`
      select count(*)::int as readers from pg_proc procedure
      where procedure.oid = any(array(select signature::regprocedure::oid from unnest(${signatures}::text[]) signature))
        and exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE')`;
    expect(polluted?.readers).toBe(4);
    for (let pass = 0; pass < 2; pass += 1) {
      await provisionRoles(shared.adminUrl, roles);
      const readers = await shared.admin<Array<{ execute: boolean; publicExecute: boolean }>>`
        select has_function_privilege(${role}, procedure.oid, 'EXECUTE') as execute,
          exists (select 1 from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute"
        from pg_proc procedure
        where procedure.oid = any(array(select signature::regprocedure::oid from unnest(${signatures}::text[]) signature))`;
      expect(readers).toHaveLength(4);
      expect(readers.every((reader) => reader.execute && !reader.publicExecute)).toBe(true);
    }
  } finally {
    await provisionRoles(shared.adminUrl, roles);
  }
});

test("0590 scrubs polluted defaults without widening approved amount-reader grants", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const signature =
    "opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)";
  const migration = await Bun.file(
    new URL("../drizzle/0590_complete_insights_usage_amounts.sql", import.meta.url),
  ).text();
  const blocks = migration.match(/DO \$acl\$[\s\S]*?\$acl\$;/g);
  expect(blocks).toHaveLength(1);
  const rollback = new Error("Rollback fixture role, defaults and recreated amount reader");
  try {
    await shared.admin.begin(async (tx) => {
      const [routine] = await tx<Array<{ definition: string; owner: string; grantees: string[] }>>`
        select pg_get_functiondef(${signature}::regprocedure) as definition,
          pg_get_userbyid(proowner) as owner,
          array(select pg_get_userbyid(acl.grantee) from aclexplode(coalesce(proacl, acldefault('f', proowner))) acl
            where acl.grantee <> 0 and acl.grantee <> proowner and acl.privilege_type = 'EXECUTE') as grantees
          from pg_proc where oid = ${signature}::regprocedure`;
      if (!routine) throw new Error("Amount reader is missing");
      expect(routine.grantees.length).toBeGreaterThan(0);
      const reporter = `insights_reporter_${crypto.randomUUID().replaceAll("-", "")}`;
      await tx`create role ${tx(reporter)}`;
      await tx`grant usage on schema opengeni_private to ${tx(reporter)}`;
      await tx`alter default privileges for role ${tx(routine.owner)} in schema opengeni_private
        grant execute on functions to ${tx(reporter)}`;
      await tx`drop function opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)`;
      await tx`set local role ${tx(routine.owner)}`;
      await tx.unsafe(routine.definition);
      await tx`reset role`;
      const [polluted] = await tx<Array<{ execute: boolean }>>`
        select has_function_privilege(${reporter}, ${signature}, 'EXECUTE') as execute`;
      expect(polluted?.execute).toBe(true);
      await tx`select set_config('opengeni.migration_application_roles', ${JSON.stringify(routine.grantees)}, true)`;
      // Execute the actual migration ACL boundary, not a test copy.
      await tx.unsafe(blocks![0]!);
      const [clean] = await tx<Array<{ execute: boolean; ownerExecute: boolean; extra: string }>>`
        select has_function_privilege(${reporter}, ${signature}, 'EXECUTE') as execute,
          has_function_privilege(${routine.owner}, ${signature}, 'EXECUTE') as "ownerExecute",
          (select count(*)::text from pg_proc procedure
            cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
            where procedure.oid = ${signature}::regprocedure and acl.grantee <> procedure.proowner
              and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> ALL(${routine.grantees}::text[]))
              and acl.privilege_type = 'EXECUTE') as extra`;
      expect(clean).toEqual({ execute: false, ownerExecute: true, extra: "0" });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test("0592 repairs the applied draft payer expression idempotently without changing owner, grants or security settings", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const signature =
    "opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)";
  const migration = await Bun.file(
    new URL("../drizzle/0592_insights_claude_subscription_payers.sql", import.meta.url),
  ).text();
  const oldExpression =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription') THEN 'subscription'";
  const newExpression =
    "WHEN provider IN ('codex-subscription', 'supergrok-subscription',\n" +
    "            'workspace-claude-subscription', 'organization-claude-subscription') THEN 'subscription'";
  const rollback = new Error("Rollback previously applied payer expression fixture");
  try {
    await shared.admin.begin(async (tx) => {
      const [original] = await tx<
        Array<{
          definition: string;
          owner: number;
          acl: string | null;
          config: string[];
          definer: boolean;
        }>
      >`
        select pg_get_functiondef(oid) as definition, proowner as owner, proacl::text as acl,
          proconfig as config, prosecdef as definer from pg_proc where oid = ${signature}::regprocedure`;
      if (!original) throw new Error("Organization model reader is missing");
      expect(original.definition).toContain(newExpression);
      await tx.unsafe(original.definition.replace(newExpression, oldExpression));
      const [draft] = await tx<Array<{ definition: string }>>`
        select pg_get_functiondef(${signature}::regprocedure) as definition`;
      expect(draft!.definition).toContain(oldExpression);
      expect(draft!.definition).not.toContain(newExpression);
      for (let pass = 0; pass < 2; pass += 1) {
        await tx.unsafe(migration);
        const [repaired] = await tx<
          Array<{
            definition: string;
            owner: number;
            acl: string | null;
            config: string[];
            definer: boolean;
          }>
        >`
          select pg_get_functiondef(oid) as definition, proowner as owner, proacl::text as acl,
            proconfig as config, prosecdef as definer from pg_proc where oid = ${signature}::regprocedure`;
        expect(repaired).toEqual(original);
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test("current post-cutover runtime accepts the complete real PostgreSQL routine inventory", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  // 0598 is a maintenance cutover: pre-cutover binaries must never run against
  // this schema. Validate the matching current binary over the entire real
  // inventory instead of filtering old violations or padding old allowlists.
  const runtime = createDb(shared.appUrl, { max: 2 });
  const options = {
    expectedRole: new URL(shared.appUrl).username,
    rlsStrategy: "force" as const,
    targetSchema: "public",
    organizationTenancyCanonicalActivationEnabled: true,
  };
  const roles = {
    appRole: options.expectedRole,
    appPassword: new URL(shared.appUrl).password,
    rlsStrategy: "force" as const,
  };
  const verify = async () => {
    const posture = await inspectRuntimeDatabasePosture(runtime.db, options);
    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
    expect(posture.identity).toMatchObject({
      currentUser: options.expectedRole,
      sessionUser: options.expectedRole,
      superuser: false,
      bypassRls: false,
    });
    const routines = await shared!.admin<Array<{ name: string }>>`
      select (procedure.proname || '(' || pg_catalog.oidvectortypes(procedure.proargtypes) || ')')::text as name
      from pg_proc procedure join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private' and procedure.prokind in ('f', 'p')`;
    expect(posture.privateRoutines.map((routine) => routine.name).sort()).toEqual(
      routines.map((routine) => routine.name).sort(),
    );
  };
  try {
    await verify();
    for (let pass = 0; pass < 2; pass += 1) {
      await provisionRoles(shared.adminUrl, roles);
      await verify();
    }
  } finally {
    await provisionRoles(shared.adminUrl, roles);
    await runtime.close();
  }
}, 180_000);

test("current readiness rejects a revoked amount reader until canonical provisioning repairs it", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const runtime = createDb(shared.appUrl, { max: 2 });
  const options = {
    expectedRole: new URL(shared.appUrl).username,
    rlsStrategy: "force" as const,
    targetSchema: "public",
    organizationTenancyCanonicalActivationEnabled: true,
  };
  const roles = {
    appRole: options.expectedRole,
    appPassword: new URL(shared.appUrl).password,
    rlsStrategy: "force" as const,
  };
  try {
    const baseline = await inspectRuntimeDatabasePosture(runtime.db, options);
    expect(evaluateRuntimeDatabasePosture(baseline, options)).toEqual([]);
    const reader = baseline.privateRoutines.find((routine) =>
      routine.name.startsWith("workspace_insights_amount_fact_rows("),
    );
    expect(reader?.execute).toBe(true);
    await shared.admin`revoke execute on function
      opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)
      from ${shared.admin(options.expectedRole)}`;
    const revoked = await inspectRuntimeDatabasePosture(runtime.db, options);
    expect(revoked.privateRoutines.find((routine) => routine.name === reader!.name)?.execute).toBe(
      false,
    );
    expect(evaluateRuntimeDatabasePosture(revoked, options)).toContain(
      `runtime role lacks EXECUTE on private routine ${reader!.name}`,
    );
    await provisionRoles(shared.adminUrl, roles);
    expect(
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(runtime.db, options),
        options,
      ),
    ).toEqual([]);
  } finally {
    await provisionRoles(shared.adminUrl, roles);
    await runtime.close();
  }
}, 180_000);
