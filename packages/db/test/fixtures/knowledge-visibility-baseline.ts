import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import type { ListingFixture } from "./knowledge-collection-listing";

/** Compare the actual current read/projection with only the visibility plan reverted. */
export async function installVisibilityBaseline(admin: postgres.Sql, appUrl: string) {
  const source = await readFile(new URL("../../drizzle/0461_unified_knowledge.sql", import.meta.url), "utf8");
  const start = source.indexOf("CREATE FUNCTION knowledge_revision_visible(");
  const end = source.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error("Historical visibility function missing");
  const [owner] = await admin`SELECT pg_get_userbyid(p.proowner) AS name,n.nspname AS schema
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  const schema = owner!.schema as string;
  const appRole = decodeURIComponent(new URL(appUrl).username);
  for (const [name, signature] of [
    ["knowledge_revision_visible", "uuid,uuid,uuid,boolean"],
    ["knowledge_entry_visible_body", "uuid,jsonb,boolean"],
    ["knowledge_entry_read", "uuid,uuid,jsonb,jsonb"],
  ] as const) {
    const [row] = await admin`SELECT pg_get_functiondef(to_regprocedure(${`${schema}.${name}(${signature})`})) AS definition`;
    let definition = name === "knowledge_revision_visible" ? source.slice(start, end + 4) : row!.definition as string;
    // pg_get_functiondef qualifies the function name; historical source does not.
    const header = definition.slice(0, definition.indexOf("("));
    const quotedSchema = `"${schema.replaceAll('"', '""')}"`;
    definition = definition.replace(header, `CREATE OR REPLACE FUNCTION ${quotedSchema}.${name}_before_keyed`);
    if (name !== "knowledge_revision_visible") definition = definition.replaceAll("knowledge_revision_visible(", "knowledge_revision_visible_before_keyed(");
    if (name === "knowledge_entry_read") definition = definition
      .replaceAll("knowledge_entry_visible_body(", "knowledge_entry_visible_body_before_keyed(")
      .replaceAll("knowledge_revisions_visible(", "knowledge_revisions_visible_before_keyed(");
    await admin.unsafe(definition);
    const qualified = `${quotedSchema}.${name}_before_keyed(${signature})`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} OWNER TO ${admin(owner!.name as string)}`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} SET search_path = ${admin(schema)}, pg_catalog, pg_temp`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM PUBLIC`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM ${admin(appRole)}`;
    if (name === "knowledge_entry_read") await admin`GRANT EXECUTE ON FUNCTION ${admin.unsafe(qualified)} TO ${admin(appRole)}`;
  }
  // The current reader batches candidates. Its historical comparison must still
  // run the old scalar graph evaluator for every root, not the current helper.
  await admin.unsafe(`CREATE FUNCTION knowledge_revisions_visible_before_keyed(p_account uuid,p_entries uuid[],p_revisions uuid[],p_pending boolean)
    RETURNS TABLE(entry_id uuid,revision_id uuid) LANGUAGE sql VOLATILE SET search_path FROM CURRENT AS $$
    SELECT DISTINCT x.entry_id,x.revision_id FROM unnest(p_entries,p_revisions) x(entry_id,revision_id)
    WHERE knowledge_revision_visible_before_keyed(p_account,x.entry_id,x.revision_id,p_pending)
    $$`);
  await admin`ALTER FUNCTION knowledge_revisions_visible_before_keyed(uuid,uuid[],uuid[],boolean) OWNER TO ${admin(owner!.name as string)}`;
  await admin`ALTER FUNCTION knowledge_revisions_visible_before_keyed(uuid,uuid[],uuid[],boolean) SET search_path = ${admin(schema)},pg_catalog,pg_temp`;
  await admin`REVOKE ALL ON FUNCTION knowledge_revisions_visible_before_keyed(uuid,uuid[],uuid[],boolean) FROM PUBLIC`;
}

export async function readVisibilityBaseline(app: postgres.Sql, fixture: ListingFixture, request: Record<string, postgres.JSONValue>) {
  return app.begin(async tx => {
    await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true),
      set_config('opengeni.subject_id',${fixture.actor.subjectId},true),set_config('opengeni.principal_kind',${fixture.actor.principalKind},true)`;
    const [row] = await tx`SELECT knowledge_entry_read_before_keyed(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`;
    return row!.result as any[];
  });
}
