/** Real PostgreSQL, disposable shared fixture. Compare the current read with
 * only migration 0914 reversed; 5 warmups + 20 alternating measured samples.
 * bun scripts/operator/bench-knowledge-group-projection.ts
 */
import postgres from "postgres";
import { isDeepStrictEqual } from "node:util";
import {
  listingDatabase,
  seedListingFixture,
} from "../../packages/db/test/fixtures/knowledge-collection-listing";

const shared = await listingDatabase();
const app = postgres(shared.appUrl, { max: 1, prepare: false });
const anchor = "'groupIds',knowledge_entry_visible_body(p_account,c.body,pending)->'groupIds'";
const replacement =
  "'groupIds',knowledge_entry_visible_body(p_account,jsonb_build_object('groupIds',coalesce(c.body->'groupIds','[]'::jsonb)),pending)->'groupIds'";
try {
  const [routine] = await shared.admin`SELECT pg_get_functiondef(p.oid) AS definition,
    pg_get_userbyid(p.proowner) AS owner,n.nspname AS schema
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  if (routine!.definition.split(replacement).length !== 2) throw new Error("Source anchor changed");
  await shared.admin.begin(async (tx) => {
    for (const variant of ["baseline", "candidate"]) {
      const name = `knowledge_entry_read_${variant}`;
      const definition = (
        variant === "baseline"
          ? routine!.definition.replace(replacement, anchor)
          : routine!.definition
      ).replaceAll("knowledge_entry_read", name);
      await tx.unsafe(definition);
      await tx`ALTER FUNCTION ${tx(routine!.schema)}.${tx(name)}(uuid,uuid,jsonb,jsonb) OWNER TO ${tx(routine!.owner)}`;
      await tx`REVOKE ALL ON FUNCTION ${tx(routine!.schema)}.${tx(name)}(uuid,uuid,jsonb,jsonb) FROM PUBLIC`;
      await tx`GRANT EXECUTE ON FUNCTION ${tx(routine!.schema)}.${tx(name)}(uuid,uuid,jsonb,jsonb) TO ${tx(decodeURIComponent(new URL(shared.appUrl).username))}`;
    }
  });
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const size of [1200, 131072]) {
    const f = await seedListingFixture(shared.admin, 80);
    if (size > 1200) {
      await shared.admin.begin(async (tx) => {
        await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
        await tx`INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,preview,actor)
          SELECT account_id,entry_id,3,body||jsonb_build_object('content',repeat('retained detail ',${Math.ceil(size / 16)})),preview,actor
          FROM knowledge_entry_revisions WHERE account_id=${f.accountId} AND number=2`;
        await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
          SELECT l.account_id,l.entry_id,new.id,l.ordinal,l.target_entry_id,l.target_revision_id,l.relation
          FROM knowledge_entry_links l JOIN knowledge_entry_revisions old ON old.id=l.revision_id AND old.number=2
          JOIN knowledge_entry_revisions new ON new.entry_id=old.entry_id AND new.number=3 WHERE l.account_id=${f.accountId}`;
        await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
          SELECT account_id,entry_id,id,3,'published','{}' FROM knowledge_entry_revisions WHERE account_id=${f.accountId} AND number=3`;
        await tx`UPDATE knowledge_entries e SET version=3,published_revision_id=r.id,latest_revision_id=r.id
          FROM knowledge_entry_revisions r WHERE r.entry_id=e.id AND r.account_id=${f.accountId} AND r.number=3`;
      });
    }
    const [member] =
      await shared.admin`SELECT id FROM knowledge_entries WHERE account_id=${f.accountId} AND id NOT IN (${f.sourceId},${f.groupId}) LIMIT 1`;
    for (const request of [
      { limit: 20, groupId: f.groupId },
      { operation: "get", entryId: member!.id },
    ]) {
      const timings: Record<string, number[]> = { baseline: [], candidate: [] };
      let expected: unknown;
      for (let i = 0; i < 25; i++)
        for (const variant of i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          const start = performance.now();
          const rows = await app.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
            set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
            return tx`SELECT ${tx(`knowledge_entry_read_${variant}`)}(${f.accountId},${f.workspaceId},${tx.json(f.actor)},${tx.json(request)}) AS result`;
          });
          const elapsed = performance.now() - start;
          if (expected === undefined) expected = rows[0]!.result;
          if (!isDeepStrictEqual(rows[0]!.result, expected)) throw new Error("Output changed");
          if (i >= 5) timings[variant]!.push(elapsed);
        }
      console.log(
        JSON.stringify({
          size,
          request,
          baselineMedianMs: median(timings.baseline!),
          candidateMedianMs: median(timings.candidate!),
          timings,
        }),
      );
    }
  }
} finally {
  await app.end();
  await shared.release();
}
