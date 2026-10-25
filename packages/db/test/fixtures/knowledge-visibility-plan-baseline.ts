import { readFile } from "node:fs/promises";
import type postgres from "postgres";

/** Clone the unchanged reader chain, using the exact preceding SQL graph helper. */
export async function installKnowledgeVisibilityPlanBaseline(admin: postgres.Sql, appUrl: string) {
  const migration = await readFile(new URL("../../drizzle/0902_batched_knowledge_visibility.sql", import.meta.url), "utf8");
  const begin = migration.indexOf("CREATE FUNCTION knowledge_revisions_visible(");
  const end = migration.indexOf("\n$$;", begin);
  if (begin < 0 || end < begin) throw Error("Original SQL visibility helper missing");
  const appRole = decodeURIComponent(new URL(appUrl).username);
  const names = ["knowledge_revisions_visible", "knowledge_revision_visible", "knowledge_entry_visible_body", "knowledge_entry_read"];
  for (const [name, signature] of [
    [names[0]!, "uuid,uuid[],uuid[],boolean"],
    [names[1]!, "uuid,uuid,uuid,boolean"],
    [names[2]!, "uuid,jsonb,boolean"],
    [names[3]!, "uuid,uuid,jsonb,jsonb"],
  ]) {
    const [row] = await admin`SELECT pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner,n.nspname schema
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=to_regprocedure(${`${name}(${signature})`})`;
    let definition: string = name === names[0] ? migration.slice(begin, end + 4) : row!.definition;
    const quoted = `"${row!.schema.replaceAll('"', '""')}"`;
    definition = definition.replace(definition.slice(0, definition.indexOf("(")), `CREATE OR REPLACE FUNCTION ${quoted}.${name}_before_plan`);
    for (const helper of names) definition = definition.replaceAll(`${helper}(`, `${helper}_before_plan(`);
    await admin.unsafe(definition);
    const identity = `${quoted}.${name}_before_plan(${signature})`;
    await admin`ALTER FUNCTION ${admin.unsafe(identity)} OWNER TO ${admin(row!.owner)}`;
    await admin`ALTER FUNCTION ${admin.unsafe(identity)} SET search_path = ${admin(row!.schema)},pg_catalog,pg_temp`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(identity)} FROM PUBLIC`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(identity)} FROM ${admin(appRole)}`;
    if (name === "knowledge_entry_read") await admin`GRANT EXECUTE ON FUNCTION ${admin.unsafe(identity)} TO ${admin(appRole)}`;
  }
}
