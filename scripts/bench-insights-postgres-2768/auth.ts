import postgres from "postgres";

export const BENCH_CLUSTER_NAME = "opengeni-bench2768";
export function assertBenchmarkClusterName(name: unknown): void {
  if (name !== BENCH_CLUSTER_NAME) {
    throw new Error("Benchmark mutations require the dedicated opengeni-bench2768 cluster");
  }
}
export const BENCH_READ_FUNCTIONS = [
  "organization_usage_summary",
  "organization_model_usage_summary",
  "visible_workspace_insights_model_fact_rows",
  "visible_workspace_insights_usage_projection",
  "complete_workspace_insights_usage_projection",
  "workspace_insights_amount_fact_rows",
  "organization_private_chat_usage",
] as const;

export function classifyInsightsSql(query: string) {
  if (query.includes("organization_model_usage_summary")) return "organization_models";
  if (query.includes("organization_usage_summary")) return "organization_ledger";
  if (query.includes("organization_private_chat_usage")) return "organization_private_chats";
  if (
    query.includes("workspace_insights_amount_fact_rows") ||
    query.includes("visible_workspace_insights_model_fact_rows")
  )
    return "workspace_model_bundle";
  if (
    query.includes("complete_workspace_insights_usage_projection") ||
    query.includes("visible_workspace_insights_usage_projection")
  )
    return "workspace_usage_bundle";
  return null;
}

/** Retained exports preserve actual SQL/measurements, not reusable signed actor
 * material. The harness regenerates every auth setup through production helpers.
 * Never export the ambient environment or an actual connection URL. */
export function sanitizeEvidence(value: any, sensitiveValues: string[] = [], key = ""): any {
  if (key === "fixtureAdminRole") return "[REDACTED local maintenance identity]";
  if (/^(password|secret|apiKey|accessToken|refreshToken|authorization|signedContext)$/i.test(key))
    return "[REDACTED]";
  if (key === "setup" && Array.isArray(value))
    return value.map((row) => ({
      ...row,
      parameters: (row.parameters ?? []).map(
        () => "[REDACTED app-auth setup; regenerate via harness]",
      ),
    }));
  if (typeof value === "string") {
    let safe = value.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[REDACTED local connection URL]");
    for (const secret of sensitiveValues)
      if (secret.length >= 12) safe = safe.replaceAll(secret, "[REDACTED environment credential]");
    return safe;
  }
  if (Array.isArray(value)) return value.map((row) => sanitizeEvidence(row, sensitiveValues));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, row]) => [
        name,
        sanitizeEvidence(row, sensitiveValues, name),
      ]),
    );
  return value;
}

export function summarizeExplain(value: any) {
  const walk = (node: any): any[] => [node, ...(node.Plans ?? []).flatMap(walk)];
  const plan = value.explain?.[0]?.["QUERY PLAN"]?.[0];
  return {
    executionMs: plan?.["Execution Time"] ?? null,
    error: value.error ?? null,
    roleContext: value.roleContext,
    diagnosticOverrides: value.diagnosticOverrides,
    buffers: plan?.Plan
      ? {
          sharedHit: plan.Plan["Shared Hit Blocks"],
          sharedRead: plan.Plan["Shared Read Blocks"],
          tempRead: plan.Plan["Temp Read Blocks"],
          tempWritten: plan.Plan["Temp Written Blocks"],
        }
      : null,
    nested: (value.nestedPlans ?? []).map((notice: any) => {
      const match = notice.message?.match(/^duration: ([\d.]+) ms  plan:\n([\s\S]*)$/);
      if (!match) return { unparsedNotice: true };
      const nested = JSON.parse(match[2]);
      return {
        durationMs: Number(match[1]),
        queryText: nested["Query Text"],
        settings: nested.Settings,
        hotNodes: walk(nested.Plan)
          .filter((node) => node["Actual Rows"] > 10_000 || node["Sort Space Type"] === "Disk")
          .map((node) => ({
            type: node["Node Type"],
            relation: node["Relation Name"],
            cte: node["CTE Name"],
            subplan: node["Subplan Name"],
            rows: node["Actual Rows"],
            loops: node["Actual Loops"],
            removed: node["Rows Removed by Filter"],
            hashBatches: node["Hash Batches"],
            sortSpaceType: node["Sort Space Type"],
            sortSpaceKb: node["Sort Space Used"],
            sharedHit: node["Shared Hit Blocks"],
            sharedRead: node["Shared Read Blocks"],
            tempRead: node["Temp Read Blocks"],
            tempWritten: node["Temp Written Blocks"],
          })),
      };
    }),
  };
}

/** Dedicated local cluster only: preserve the migration-owner name captured by
 * audited policies, but remove its superuser/BYPASSRLS escape. PostgreSQL's
 * bootstrap identity cannot be demoted, so that one identity is renamed and its
 * objects in this fixture are reassigned to a restricted replacement with the
 * original name. No policy expression/function body is rewritten. */
export async function restrictedOwnerFixture(
  admin: postgres.Sql,
  maintenanceUrl: URL,
  database: string,
  prepareNestedPlans = false,
) {
  const [cluster] = await admin`select current_setting('cluster_name') as name`;
  assertBenchmarkClusterName(cluster?.name);
  if (
    cluster?.name !== BENCH_CLUSTER_NAME ||
    !/^og_bench_insights_2768_[a-f0-9]{12}$/.test(database)
  ) {
    throw new Error(
      "Restricted-owner fixture requires a dedicated local cluster started with -c cluster_name=opengeni-bench2768",
    );
  }
  const owners = await admin<
    { oid: number; rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`
    select distinct r.oid, r.rolname, r.rolsuper, r.rolbypassrls
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
    where n.nspname = 'opengeni_private' and p.proname = any(${[...BENCH_READ_FUNCTIONS]}::text[])`;
  if (owners.length !== 1)
    throw new Error("Expected one exact migration owner for the fact capabilities");
  const owner = owners[0]!;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(owner.rolname))
    throw new Error("Unsupported fixture owner identifier");
  const candidate = await admin<{ rolname: string }[]>`
    select rolname from pg_roles where rolname like 'bench2768_fixture_admin_%'
      and rolsuper and rolname <> ${owner.rolname} order by rolname limit 1`;
  let fixtureAdminRole = candidate[0]?.rolname;
  if (!fixtureAdminRole) {
    const [caller] = await admin`select rolsuper from pg_roles where rolname = current_user`;
    if (!caller?.rolsuper)
      throw new Error(
        "One-time restricted-owner provisioning needs the dedicated fixture maintenance login",
      );
    fixtureAdminRole = `bench2768_fixture_admin_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await admin.unsafe(`CREATE ROLE "${fixtureAdminRole}" LOGIN SUPERUSER BYPASSRLS NOINHERIT`);
  }
  const privileged = new URL(maintenanceUrl);
  privileged.pathname = `/${database}`;
  privileged.username = fixtureAdminRole;
  privileged.password = "";
  const fixtureAdmin = postgres(privileged.toString(), { max: 2, prepare: false });
  let objectOwner = owner.rolname;
  try {
    const [role] = await fixtureAdmin`select rolsuper from pg_roles where rolname = current_user`;
    if (!role?.rolsuper) throw new Error("Fixture maintenance role is not an administrator");
    if (owner.oid === 10) {
      const bootstrapName = "bench2768_bootstrap_admin";
      objectOwner = owner.rolname === bootstrapName ? "postgres" : owner.rolname;
      await fixtureAdmin.begin(async (tx) => {
        if (owner.rolname !== bootstrapName) {
          await tx.unsafe(`ALTER ROLE "${owner.rolname}" RENAME TO "${bootstrapName}"`);
          await tx.unsafe(
            `CREATE ROLE "${objectOwner}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
          );
        }
        // REASSIGN OWNED cannot target bootstrap-owned system objects. Move only
        // the migrated application objects; never alter pg_catalog/extension SQL.
        const commands = await tx<{ ddl: string }[]>`
          select format('ALTER SCHEMA %I OWNER TO %I', n.nspname, ${objectOwner}::text) as ddl
          from pg_namespace n where n.nspowner = 10 and n.nspname in ('public', 'opengeni_private')
          union all
          select format('ALTER %s %I.%I OWNER TO %I',
            case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW'
              when 'm' then 'MATERIALIZED VIEW' when 'f' then 'FOREIGN TABLE' else 'TABLE' end,
            n.nspname, c.relname, ${objectOwner}::text)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relowner = 10 and n.nspname in ('public', 'opengeni_private')
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
            and (c.relkind <> 'S' or not exists (select 1 from pg_depend d
              where d.classid = 'pg_class'::regclass and d.objid = c.oid
                and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')))
          union all
          select format('ALTER %s %I.%I(%s) OWNER TO %I',
            case p.prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end,
            n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), ${objectOwner}::text)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proowner = 10 and n.nspname in ('public', 'opengeni_private') and p.prokind <> 'a'
            and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
              and d.objid = p.oid and d.deptype = 'e')
          union all
          select format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, ${objectOwner}::text)
          from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typowner = 10 and n.nspname in ('public', 'opengeni_private')
            and t.typrelid = 0 and t.typelem = 0 and t.typtype in ('e', 'd')
            and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass
              and d.objid = t.oid and d.deptype = 'e')`;
        for (const command of commands) await tx.unsafe(command.ddl);
        // Preserve a TO-owner policy's intended identity after the bootstrap
        // rename; USING/WITH CHECK expressions are byte-for-byte unchanged.
        const policies = await tx<{ ddl: string }[]>`
          select format('ALTER POLICY %I ON %I.%I TO %s', p.polname, n.nspname, c.relname,
            (select string_agg(case when r = 10 then quote_ident(${objectOwner}::text)
              when r = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(r)) end, ', ')
              from unnest(p.polroles) r)) as ddl
          from pg_policy p join pg_class c on c.oid = p.polrelid
          join pg_namespace n on n.oid = c.relnamespace
          where 10 = any(p.polroles) and n.nspname in ('public', 'opengeni_private')`;
        for (const policy of policies) await tx.unsafe(policy.ddl);
      });
    } else if (owner.rolsuper || owner.rolbypassrls)
      await fixtureAdmin.unsafe(
        `ALTER ROLE "${owner.rolname}" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
      );
    const evidence =
      await fixtureAdmin`select p.proname, p.prosecdef, r.rolname, r.rolsuper, r.rolbypassrls
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
      where n.nspname = 'opengeni_private' and p.proname = any(${[...BENCH_READ_FUNCTIONS]}::text[])
      order by p.proname`;
    if (evidence.length < 4 || evidence.some((r) => r.rolsuper || r.rolbypassrls || !r.prosecdef)) {
      throw new Error("Restricted SECURITY DEFINER owner proof failed");
    }
    if (prepareNestedPlans) {
      // Fixture-only preload, disabled during ordinary measurements. Settings
      // privileges allow the restricted app to enable it only in diagnostic
      // transactions; the app is never granted SUPERUSER/BYPASSRLS.
      await fixtureAdmin.unsafe("LOAD 'auto_explain'");
      await fixtureAdmin.unsafe(
        "ALTER ROLE opengeni_app SET session_preload_libraries = 'auto_explain'",
      );
      for (const name of [
        "log_min_duration",
        "log_analyze",
        "log_buffers",
        "log_timing",
        "log_verbose",
        "log_settings",
        "log_format",
        "log_level",
        "log_nested_statements",
      ]) {
        await fixtureAdmin.unsafe(`GRANT SET ON PARAMETER "auto_explain.${name}" TO opengeni_app`);
      }
    }
    await admin.end();
    return { admin: fixtureAdmin, evidence, fixtureAdminRole, objectOwner };
  } catch (error) {
    await fixtureAdmin.end();
    throw error;
  }
}
