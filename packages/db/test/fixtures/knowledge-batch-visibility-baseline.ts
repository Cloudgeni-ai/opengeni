import { readFile } from "node:fs/promises";
import type postgres from "postgres";

/** Capture the real pre-batch reader in a rolled-back disposable-fixture repair. */
export async function installPreBatchKnowledgeBaseline(admin: postgres.Sql, appUrl: string, beforeParents = false) {
  const unified = await readFile(new URL("../../drizzle/0461_unified_knowledge.sql", import.meta.url), "utf8");
  const start = unified.indexOf("CREATE FUNCTION knowledge_entry_read(");
  const end = unified.indexOf("\nEND $$;", start);
  if (start < 0 || end < 0) throw new Error("Original Knowledge reader missing");
  const [metadata] = await admin`SELECT pg_get_userbyid(p.proowner) AS owner,n.nspname AS schema
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  const definitions: Array<{ name: string; signature: string; definition: string }> = [];
  const rollback = new Error("Restore current routines after capturing historical definitions");
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe(unified.slice(start, end + "\nEND $$;".length).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
      // Replay only the discovery reader rewrite, not its historical drain or
      // unrelated source-writer changes, in this rolled-back fixture repair.
      const discovery = await readFile(new URL("../../drizzle/0469_knowledge_source_discovery.sql", import.meta.url), "utf8");
      const discoveryStart = discovery.indexOf("DO $migration$");
      const discoveryEnd = discovery.indexOf("  definition := pg_get_functiondef('knowledge_validate_source(", discoveryStart);
      if (discoveryStart < 0 || discoveryEnd < 0) throw new Error("Historical discovery reader rewrite missing");
      await tx.unsafe(`${discovery.slice(discoveryStart, discoveryEnd)}\nEND $migration$;`);
      await tx.unsafe(await readFile(new URL("../../drizzle/0640_knowledge_entry_created_since.sql", import.meta.url), "utf8"));
      await tx.unsafe(await readFile(new URL("../../drizzle/0878_keyed_knowledge_visibility.sql", import.meta.url), "utf8"));
      if (beforeParents) {
        const batch = await readFile(new URL("../../drizzle/0902_batched_knowledge_visibility.sql", import.meta.url), "utf8");
        await tx.unsafe(batch.replace("CREATE FUNCTION knowledge_revisions_visible(", "CREATE OR REPLACE FUNCTION knowledge_revisions_visible("));
        await tx.unsafe(await readFile(new URL("../../drizzle/0914_knowledge_group_summary_projection.sql", import.meta.url), "utf8"));
      }
      for (const [name, signature] of [
        ["knowledge_revision_visible", "uuid,uuid,uuid,boolean"],
        ["knowledge_entry_visible_body", "uuid,jsonb,boolean"],
        ["knowledge_entry_read", "uuid,uuid,jsonb,jsonb"],
      ]) {
        const [row] = await tx`SELECT pg_get_functiondef(to_regprocedure(${`${name}(${signature})`})) AS definition`;
        definitions.push({ name: name!, signature: signature!, definition: row!.definition });
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  const schema = metadata!.schema as string;
  const quoted = `"${schema.replaceAll('"', '""')}"`;
  const appRole = decodeURIComponent(new URL(appUrl).username);
  for (const { name, signature, definition } of definitions) {
    const suffix = beforeParents ? "before_parents" : "before_batch";
    let copy = definition.replace(definition.slice(0, definition.indexOf("(")), `CREATE OR REPLACE FUNCTION ${quoted}.${name}_${suffix}`);
    if (name !== "knowledge_revision_visible") copy = copy.replaceAll("knowledge_revision_visible(", `knowledge_revision_visible_${suffix}(`);
    if (name === "knowledge_entry_read") copy = copy.replaceAll("knowledge_entry_visible_body(", `knowledge_entry_visible_body_${suffix}(`);
    await admin.unsafe(copy);
    const qualified = `${quoted}.${name}_${suffix}(${signature})`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} OWNER TO ${admin(metadata!.owner as string)}`;
    await admin`ALTER FUNCTION ${admin.unsafe(qualified)} SET search_path = ${admin(schema)},pg_catalog,pg_temp`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM PUBLIC`;
    await admin`REVOKE ALL ON FUNCTION ${admin.unsafe(qualified)} FROM ${admin(appRole)}`;
    if (name === "knowledge_entry_read") await admin`GRANT EXECUTE ON FUNCTION ${admin.unsafe(qualified)} TO ${admin(appRole)}`;
  }
}
