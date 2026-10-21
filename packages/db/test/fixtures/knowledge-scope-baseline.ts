import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import type { ListingFixture } from "./knowledge-collection-listing";

/** Current read and graph semantics, with only the historical scope evaluator restored. */
export async function installScopeBaseline(admin: postgres.Sql, appUrl: string) {
  const source = await readFile(new URL("../../drizzle/0461_unified_knowledge.sql", import.meta.url), "utf8");
  const start = source.indexOf("CREATE FUNCTION knowledge_scope_visible(");
  const end = source.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("Historical scope predicate missing");
  const [owner] = await admin`SELECT pg_get_userbyid(p.proowner) AS name,n.nspname AS schema
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  const schema = owner!.schema as string;
  const appRole = decodeURIComponent(new URL(appUrl).username);
  const functions = [
    ["knowledge_scope_visible", `${schema}.knowledge_entries`],
    ["knowledge_revision_visible", "uuid,uuid,uuid,boolean"],
    ["knowledge_entry_visible_body", "uuid,jsonb,boolean"],
    ["knowledge_entry_read", "uuid,uuid,jsonb,jsonb"],
  ] as const;
  for (const [name, signature] of functions) {
    const [row] = await admin`SELECT pg_get_functiondef(to_regprocedure(${`${schema}.${name}(${signature})`})) AS definition`;
    let definition = name === "knowledge_scope_visible" ? source.slice(start, end + 4) : row!.definition as string;
    const header = definition.slice(0, definition.indexOf("("));
    const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
    definition = definition.replace(header, `CREATE OR REPLACE FUNCTION ${quotedSchema}.${name}_before_scope`);
    for (const [dependency] of functions) {
      if (dependency !== name) definition = definition.replaceAll(`${dependency}(`, `${dependency}_before_scope(`);
    }
    await admin.unsafe(definition);
    const qualified = `${quotedSchema}.${name}_before_scope(${signature})`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} OWNER TO ${admin(owner!.name as string)}`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} SET search_path = ${admin(schema)}, pg_catalog, pg_temp`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM PUBLIC`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM ${admin(appRole)}`;
    if (name === "knowledge_entry_read") await admin`GRANT EXECUTE ON FUNCTION ${admin.unsafe(qualified)} TO ${admin(appRole)}`;
  }
}

export async function readScopeBaseline(app: postgres.Sql, fixture: ListingFixture, request: Record<string, postgres.JSONValue>) {
  return app.begin(async tx => {
    await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true),
      set_config('opengeni.subject_id',${fixture.actor.subjectId},true),set_config('opengeni.principal_kind',${fixture.actor.principalKind},true)`;
    const [row] = await tx`SELECT knowledge_entry_read_before_scope(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`;
    return row!.result;
  });
}
