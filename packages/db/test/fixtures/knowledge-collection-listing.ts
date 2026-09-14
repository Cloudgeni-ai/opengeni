import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

/** Optional pre-migrated, disposable native PostgreSQL fixture; CI uses the shared harness. */
export async function listingDatabase(): Promise<SharedTestDatabase> {
  const adminUrl = process.env.OPENGENI_KNOWLEDGE_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_KNOWLEDGE_TEST_APP_URL;
  if (adminUrl || appUrl) {
    if (!adminUrl || !appUrl) throw new Error("Both Knowledge test URLs are required");
    for (const value of [adminUrl, appUrl]) {
      const url = new URL(value);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("Knowledge fixtures require disposable loopback PostgreSQL");
    }
    const admin = postgres(adminUrl, { max: 2 });
    return { admin, adminUrl, appUrl, release: () => admin.end() };
  }
  const database = await acquireSharedTestDatabase("knowledge-collection-listing");
  if (!database) throw new Error("Knowledge collection verification requires PostgreSQL");
  return database;
}

export async function seedListingFixture(connection: postgres.Sql, count = 240) {
  return connection.begin(async (admin) => {
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `user:${crypto.randomUUID()}`;
    const groupId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const sourceRevisionId = crypto.randomUUID();
    const sourceFileId = crypto.randomUUID();
    await admin`SELECT set_config('opengeni.account_id',${accountId},true),
    set_config('opengeni.workspace_id',${workspaceId},true)`;
    await admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Collection listing benchmark')`;
    await admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Disposable collection fixture')`;
    await admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
    await admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${sourceFileId},${accountId},${workspaceId},'ready','source.txt','source.txt','text/plain',96000,'fixture',${sourceFileId})`;
    await admin`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id)
    SELECT id,${accountId},${workspaceId},'workspace',${workspaceId}
    FROM unnest(ARRAY[${groupId}::uuid,${sourceId}::uuid]) id`;
    await admin`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor)
    VALUES(gen_random_uuid(),${accountId},${groupId},1,
      ${admin.json({ kind: "group", title: "Collection", content: "Collection", groupIds: [], relationships: [], evidence: [] })},'Collection','{}'),
      (${sourceRevisionId},${accountId},${sourceId},1,
      ${admin.json({ kind: "source", title: "Source", content: "Retained source ".repeat(6000), source: { kind: "file", fileId: sourceFileId }, groupIds: [], relationships: [], evidence: [] })},'Retained source','{}')`;
    // Two revisions per member. Membership belongs to the exact current revision,
    // not any historical link. Every fourth member depends on retained source text.
    await admin`INSERT INTO knowledge_entries(account_id,origin_workspace_id,scope,scope_workspace_id)
    SELECT ${accountId},${workspaceId},'workspace',${workspaceId} FROM generate_series(1,${count})`;
    await admin`INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,preview,actor)
    SELECT ${accountId},e.id,n,jsonb_build_object('kind','note','title','Member '||e.id,
      'content',repeat('Representative retained detail ',40),'groupIds',jsonb_build_array(${groupId}::text),
      'relationships',jsonb_build_array(jsonb_build_object('entryId',${sourceId}::text,'relation','related_to')),
      'evidence',CASE WHEN dense_rank() OVER (ORDER BY e.id) % 4 = 0 THEN
        jsonb_build_array(jsonb_build_object('entryId',${sourceId}::text,'revisionId',${sourceRevisionId}::text)) ELSE '[]'::jsonb END),
      'Representative retained detail','{}'
    FROM knowledge_entries e CROSS JOIN generate_series(1,2) n
    WHERE e.account_id=${accountId} AND e.id NOT IN (${groupId},${sourceId})`;
    await admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
    SELECT account_id,entry_id,id,number,'published','{}' FROM knowledge_entry_revisions WHERE account_id=${accountId}`;
    await admin`UPDATE knowledge_entries e SET version=r.number,published_revision_id=r.id,latest_revision_id=r.id
    FROM knowledge_entry_revisions r WHERE r.account_id=${accountId} AND r.entry_id=e.id
      AND r.number=CASE WHEN e.id IN (${groupId},${sourceId}) THEN 1 ELSE 2 END`;
    await admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
    SELECT account_id,entry_id,id,0,${groupId},'group' FROM knowledge_entry_revisions
    WHERE account_id=${accountId} AND entry_id NOT IN (${groupId},${sourceId})`;
    await admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    SELECT account_id,entry_id,id,1,${sourceId},${sourceRevisionId},'evidence' FROM knowledge_entry_revisions
    WHERE account_id=${accountId} AND jsonb_array_length(body->'evidence')>0`;
    await admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
    SELECT account_id,entry_id,id,2,${sourceId},'related_to' FROM knowledge_entry_revisions
    WHERE account_id=${accountId} AND entry_id NOT IN (${groupId},${sourceId})`;
    await admin`INSERT INTO knowledge_entry_search(account_id,entry_id,revision_id,chunk_index,search_vector)
    SELECT account_id,entry_id,id,0,to_tsvector('simple',body->>'title') FROM knowledge_entry_revisions WHERE account_id=${accountId}`;
    for (const table of [
      "knowledge_entries",
      "knowledge_entry_revisions",
      "knowledge_entry_links",
      "knowledge_entry_decisions",
      "knowledge_entry_search",
    ])
      await admin.unsafe(`ANALYZE ${table}`);
    const actor = {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal", "organization"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    };
    return {
      accountId,
      workspaceId,
      subjectId,
      groupId,
      sourceId,
      sourceRevisionId,
      sourceFileId,
      actor,
    };
  });
}

export type ListingFixture = Awaited<ReturnType<typeof seedListingFixture>>;

/** Install historical comparison functions only in the disposable test database. */
export async function installListingBaseline(admin: postgres.Sql, appUrl: string) {
  const source = await readFile(
    new URL("../../drizzle/0461_unified_knowledge.sql", import.meta.url),
    "utf8",
  );
  const [ownerRow] = await admin`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
    WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  if (!ownerRow) throw new Error("Knowledge read capability is missing");
  const owner = ownerRow.owner as string;
  const appRole = decodeURIComponent(new URL(appUrl).username);
  for (const name of ["knowledge_entry_visible_body", "knowledge_entry_read"]) {
    const start = source.indexOf(`CREATE FUNCTION ${name}(`);
    const end = source.indexOf("\n$$;", start);
    const plpgsqlEnd = source.indexOf("\nEND $$;", start);
    const finish =
      name === "knowledge_entry_read" ? plpgsqlEnd + "\nEND $$;".length : end + "\n$$;".length;
    if (start < 0 || finish <= start) throw new Error(`Missing historical function ${name}`);
    let definition = source
      .slice(start, finish)
      .replace(`CREATE FUNCTION ${name}(`, `CREATE OR REPLACE FUNCTION ${name}_baseline(`);
    if (name === "knowledge_entry_read")
      definition = definition.replaceAll(
        "knowledge_entry_visible_body(",
        "knowledge_entry_visible_body_baseline(",
      );
    await admin.unsafe(definition);
    const signature =
      name === "knowledge_entry_read" ? "uuid,uuid,jsonb,jsonb" : "uuid,jsonb,boolean";
    await admin`ALTER FUNCTION ${admin(name + "_baseline")}(${admin.unsafe(signature)}) OWNER TO ${admin(owner)}`;
    await admin.unsafe(`REVOKE ALL ON FUNCTION ${name}_baseline(${signature}) FROM PUBLIC`);
    await admin`GRANT EXECUTE ON FUNCTION ${admin(name + "_baseline")}(${admin.unsafe(signature)}) TO ${admin(appRole)}`;
  }
}

export async function readListing(
  sql: postgres.Sql,
  fixture: ListingFixture,
  request: Record<string, postgres.JSONValue>,
  baseline = false,
) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),
      set_config('opengeni.workspace_id',${fixture.workspaceId},true),
      set_config('opengeni.subject_id',${fixture.actor.subjectId},true),
      set_config('opengeni.principal_kind',${fixture.actor.principalKind},true)`;
    const [row] = baseline
      ? await tx`SELECT knowledge_entry_read_baseline(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`
      : await tx`SELECT knowledge_entry_read(${fixture.accountId},${fixture.workspaceId},${tx.json(fixture.actor)},${tx.json(request)}) AS result`;
    return row!.result as Array<{
      id: string;
      score: number;
      revision: { id: string; number: number; groupIds: string[] };
    }>;
  });
}
