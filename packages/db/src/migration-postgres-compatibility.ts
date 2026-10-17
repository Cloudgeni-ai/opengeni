import { createHash } from "node:crypto";
import type postgres from "postgres";
import { sessionHistoryCompatibilitySql } from "./migration-session-history-backfills";

// Published migration bytes are release identities. PostgreSQL 18 added NOT
// NULL rows to pg_constraint; adapt only the affected catalog reads at execution
// time, never the ledger source or its release-schema digest. These hashes are
// the deployed sources, before #4643 accidentally edited their history.
// 0807 also needs a stable policy deparse path on dedicated-schema deployments.
const migrations: Readonly<
  Record<
    string,
    {
      sha256: string;
      minVersion?: number;
      replacements: readonly { before: string; after: string; count: number }[];
    }
  >
> = {
  "0807_subscription_rls_admin_once_per_statement.sql": {
    sha256: "8324f591dbb4f0db717d0f72f272937dc2ab1db51997304cc4454bec12d59579",
    minVersion: 100000,
    replacements: [
      {
        before: "  data_schema text := current_schema();",
        after:
          "  data_schema text := current_schema();\n  caller_search_path text := pg_catalog.current_setting('search_path');",
        count: 1,
      },
      {
        before: "BEGIN\n  FOR policy IN",
        // pg_get_expr omits visible schemas. Dedicated deployments include
        // opengeni_private on their path, but this immutable migration matches
        // its exact qualified helper. Deparse and reparse under the same path;
        // retain the target schema and the original fail-closed call matcher.
        after:
          "BEGIN\n  PERFORM pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_catalog', data_schema), true);\n  FOR policy IN",
        count: 1,
      },
      {
        before: "END\n$subscription_admin_policies$;",
        after:
          "  PERFORM pg_catalog.set_config('search_path', caller_search_path, true);\nEND\n$subscription_admin_policies$;",
        count: 1,
      },
    ],
  },
  "0345_tenant_scoped_session_tenancy_fence.sql": {
    sha256: "6661f19636089871c25d6496d2baa14b502cc875b01c3e5a4ce2869e8c046f97",
    replacements: [
      {
        before: "WHERE constraint_value.conrelid = registry_table;",
        after:
          "WHERE constraint_value.conrelid = registry_table AND constraint_value.contype <> 'n';",
        count: 1,
      },
      {
        before: "WHERE constraint_value.conrelid = capability_table\n    ) <> 1",
        after:
          "WHERE constraint_value.conrelid = capability_table AND constraint_value.contype <> 'n'\n    ) <> 1",
        count: 2,
      },
    ],
  },
  "0598_claude_subscription_account_pools.sql": {
    sha256: "09b62695ae4ed1b64c780b7d970c819b1433cba1cdea31fb76b6b7b29793dde3",
    replacements: [
      {
        before: "FROM pg_constraint WHERE conrelid = source_oid\n      ORDER BY",
        after: "FROM pg_constraint WHERE conrelid = source_oid AND contype <> 'n'\n      ORDER BY",
        count: 1,
      },
    ],
  },
};

/** Closed compatibility adapter; unrelated migrations are always verbatim. */
export async function migrationSqlForServer(
  sql: postgres.Sql,
  file: string,
  source: string,
): Promise<string> {
  source = sessionHistoryCompatibilitySql(file, source);
  const migration = Object.hasOwn(migrations, file) ? migrations[file] : undefined;
  if (!migration) return source;
  const [server] = await sql<{ version: string }[]>`
    SELECT pg_catalog.current_setting('server_version_num') AS version`;
  const version = Number(server?.version);
  if (!Number.isSafeInteger(version) || version < 100000)
    throw new Error(`${file}: cannot determine PostgreSQL migration compatibility`);
  if (version < (migration.minVersion ?? 180000)) return source;
  if (createHash("sha256").update(source).digest("hex") !== migration.sha256)
    throw new Error(`${file}: PostgreSQL compatibility requires the immutable deployed source`);
  let executable = source;
  for (const { before, after, count } of migration.replacements) {
    if (executable.split(before).length - 1 !== count)
      throw new Error(`${file}: PostgreSQL compatibility anchor drift`);
    executable = executable.replaceAll(before, after);
  }
  return executable;
}
