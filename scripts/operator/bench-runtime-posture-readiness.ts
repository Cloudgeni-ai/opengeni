import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb } from "../../packages/db/src/index";
import { runtimeDatabaseReadyCheck } from "../../packages/db/src/runtime-posture";

// Disposable local diagnostic: what the API and worker readiness probe costs
// the database. It provisions the production posture (non-superuser migration
// owner, dedicated data schema, restricted runtime role), optionally adds
// OPENGENI_BENCH_FOREIGN_TABLES (default 0) unrelated tables in another
// schema, as a database shared with another application has, and runs
// OPENGENI_BENCH_PROBES (default 200) readiness probes through
// runtimeDatabaseReadyCheck, as a long-running process does. Server time,
// statements and shared blocks come from pg_stat_statements for the runtime
// role. Run it unchanged on two revisions to compare them.
const probes = Number(process.env.OPENGENI_BENCH_PROBES ?? "200");
const foreignTables = Number(process.env.OPENGENI_BENCH_FOREIGN_TABLES ?? "0");
if (
  !Number.isInteger(probes) ||
  probes < 1 ||
  !Number.isInteger(foreignTables) ||
  foreignTables < 0
)
  throw new Error("Invalid benchmark size");

const options = { rlsStrategy: "force" as const, targetSchema: "og_data" };
const fixture: RestrictedRuntimeTestDatabase | null = await acquireRestrictedRuntimeTestDatabase(
  "posture-readiness-benchmark",
  options.targetSchema,
);
if (!fixture) throw new Error("Local PostgreSQL required");
const client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 1 });
try {
  const admin = fixture.admin;
  await admin`create extension if not exists pg_stat_statements`;
  if (foreignTables > 0) {
    await admin`create schema if not exists bench_other_application`;
    for (let start = 0; start < foreignTables; start += 200) {
      const statements: string[] = [];
      for (let i = start; i < Math.min(foreignTables, start + 200); i++) {
        statements.push(
          `create table bench_other_application.t${i} (id bigint primary key, owner_id bigint not null, name text, payload jsonb, created_at timestamptz not null default now());
           create index on bench_other_application.t${i} (owner_id, created_at);`,
        );
      }
      await admin.unsafe(statements.join("\n"));
    }
  }
  const ready = runtimeDatabaseReadyCheck(client.db, options);
  // Warm the connection, plan cache and catalog caches, as a running pod is.
  for (let i = 0; i < 5; i++) await ready();
  await admin`select pg_stat_statements_reset()`;
  const started = performance.now();
  for (let i = 0; i < probes; i++) await ready();
  const wallMs = performance.now() - started;
  const [stats] = await admin<
    { statements: string; exec_ms: number; shared_blocks: string; top_ms: number; top: string }[]
  >`
    with app as (
      select s.* from pg_stat_statements s
      join pg_roles r on r.oid = s.userid
      where r.rolname = 'opengeni_app' and s.dbid = (select oid from pg_database where datname = current_database())
    )
    select
      coalesce(sum(calls), 0)::text as statements,
      coalesce(sum(total_exec_time), 0)::float8 as exec_ms,
      coalesce(sum(shared_blks_hit + shared_blks_read), 0)::text as shared_blocks,
      coalesce((select total_exec_time from app order by total_exec_time desc limit 1), 0)::float8 as top_ms,
      coalesce((select left(regexp_replace(query, '\\s+', ' ', 'g'), 80) from app order by total_exec_time desc limit 1), '') as top
    from app
  `;
  const [catalog] = await admin<{ relations: string; attributes: string }[]>`
    select (select count(*) from pg_class)::text as relations,
      (select count(*) from pg_attribute)::text as attributes
  `;
  console.log(
    JSON.stringify(
      {
        probes,
        foreignTables,
        catalogRelations: Number(catalog!.relations),
        catalogAttributes: Number(catalog!.attributes),
        statementsPerProbe: Number(stats!.statements) / probes,
        serverMsPerProbe: Number((stats!.exec_ms / probes).toFixed(3)),
        sharedBlocksPerProbe: Math.round(Number(stats!.shared_blocks) / probes),
        wallMsPerProbe: Number((wallMs / probes).toFixed(3)),
        costliestStatementMsPerProbe: Number((stats!.top_ms / probes).toFixed(3)),
        costliestStatement: stats!.top,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await fixture.release();
}
