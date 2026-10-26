import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import type { SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  listingDatabase,
  readListing,
  seedListingFixture,
  type ListingFixture,
} from "./fixtures/knowledge-collection-listing";

let shared: SharedTestDatabase;
let app: postgres.Sql;
let fixture: ListingFixture;
const narrow =
  "'groupIds',knowledge_entry_visible_body(p_account,jsonb_build_object('groupIds',coalesce(c.body->'groupIds','[]'::jsonb)),pending)->'groupIds'";
const full = "'groupIds',knowledge_entry_visible_body(p_account,c.body,pending)->'groupIds'";

beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  // Compare to the exact immediately preceding implementation, not 0461's
  // older ranking/visibility code. Only reverse this migration's expression.
  const [routine] = await shared.admin`SELECT pg_get_functiondef(p.oid) AS definition,
    pg_get_userbyid(p.proowner) AS owner,n.nspname AS schema
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  expect(routine!.definition.split(narrow)).toHaveLength(2);
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(
      routine!.definition
        .replace(narrow, full)
        .replaceAll("knowledge_entry_read", "knowledge_entry_read_baseline"),
    );
    await tx`ALTER FUNCTION ${tx(routine!.schema)}.knowledge_entry_read_baseline(uuid,uuid,jsonb,jsonb) OWNER TO ${tx(routine!.owner)}`;
    await tx`REVOKE ALL ON FUNCTION ${tx(routine!.schema)}.knowledge_entry_read_baseline(uuid,uuid,jsonb,jsonb) FROM PUBLIC`;
    await tx`GRANT EXECUTE ON FUNCTION ${tx(routine!.schema)}.knowledge_entry_read_baseline(uuid,uuid,jsonb,jsonb) TO ${tx(decodeURIComponent(new URL(shared.appUrl).username))}`;
  });
  fixture = await seedListingFixture(shared.admin, 32);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 180_000);

async function parity(request: Record<string, postgres.JSONValue>, f = fixture) {
  const expected = await readListing(app, f, request, true);
  const actual = await readListing(app, f, request);
  expect(actual).toEqual(expected);
  return actual;
}

describe("Knowledge group-only summary", () => {
  test("rolling replacement preserves embedded-schema metadata and rejects a changed source", async () => {
    const migration = await readFile(
      new URL("../drizzle/0914_knowledge_group_summary_projection.sql", import.meta.url),
      "utf8",
    );
    const schema = `Knowledge_projection_${crypto.randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback embedded-schema fixture");
    try {
      await shared.admin.begin(async (tx) => {
        await tx`CREATE SCHEMA ${tx(schema)}`;
        await tx`SET LOCAL check_function_bodies = off`;
        const [source] =
          await tx`SELECT pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure) AS definition,
          format('%I',${schema}::text) AS quoted_schema`;
        await tx.unsafe(
          source!.definition
            .replace(
              "FUNCTION public.knowledge_entry_read(",
              `FUNCTION ${source!.quoted_schema}.knowledge_entry_read(`,
            )
            .replace(narrow, full),
        );
        await tx`ALTER FUNCTION ${tx(schema)}.knowledge_entry_read(uuid,uuid,jsonb,jsonb) SET search_path = ${tx(schema)}, pg_catalog, pg_temp`;
        await tx`REVOKE ALL ON FUNCTION ${tx(schema)}.knowledge_entry_read(uuid,uuid,jsonb,jsonb) FROM PUBLIC`;
        await tx`SET LOCAL search_path = ${tx(schema)}, public`;
        const before =
          await tx`SELECT p.proowner,p.proacl,p.proconfig,p.provolatile,p.prosecdef FROM pg_proc p
          WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
        await tx.unsafe(migration);
        expect(
          await tx`SELECT p.proowner,p.proacl,p.proconfig,p.provolatile,p.prosecdef FROM pg_proc p
          WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`,
        ).toEqual(before);
        const [after] =
          await tx`SELECT pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure) AS definition`;
        expect(after!.definition).toContain(narrow);
        // The ledger executes each migration once. An incompatible source must
        // fail visibly, not silently succeed without applying its replacement.
        await expect(
          tx.savepoint(async (nested) => {
            await nested.unsafe(migration);
          }),
        ).rejects.toMatchObject({ code: "P0001" });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 180_000);

  test("read capability retains owner, grants, volatility and hardened path", async () => {
    const rows = await shared.admin`SELECT p.prosecdef,p.provolatile,p.proconfig,p.proowner,p.proacl
      FROM pg_proc p WHERE p.oid IN ('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure,
      'knowledge_entry_read_baseline(uuid,uuid,jsonb,jsonb)'::regprocedure)`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.provolatile).toBe("v");
    expect(rows[0]!.proconfig).toEqual(["search_path=public, pg_catalog, pg_temp"]);
  });

  test("search, collection, detail, history and cursor responses remain identical", async () => {
    for (const request of [
      {},
      { rootOnly: true },
      { groupId: fixture.groupId },
      { query: "Member", mode: "keyword" },
      { query: "Member", mode: "hybrid" },
      { query: "missing", mode: "keyword" },
      { view: "archived" },
      { view: "needs_review" },
      { scope: "organization" },
      { scope: "personal" },
      { operation: "get", entryId: fixture.sourceId },
      { operation: "file", entryId: fixture.sourceId },
    ])
      await parity({ limit: 20, ...request });
    const [member] = await parity({ groupId: fixture.groupId, limit: 1 });
    expect(member).toBeDefined();
    for (const request of [
      { operation: "get", entryId: member!.id },
      { operation: "history", entryId: member!.id },
      { operation: "get", entryId: member!.id, revisionId: member!.revision.id },
      { afterId: member!.id, afterScore: 0, groupId: fixture.groupId },
    ])
      await parity(request);
  }, 180_000);

  test("revoked or archived collections disappear, without changing full relationship filtering", async () => {
    const f = await seedListingFixture(shared.admin, 8);
    const before = await parity({ limit: 20, groupId: f.groupId }, f);
    expect(before).toHaveLength(8);
    await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.groupId}`;
    const roots = await parity({ limit: 20, rootOnly: true }, f);
    expect(roots.every((r) => r.revision.groupIds.length === 0)).toBe(true);
    await shared.admin`UPDATE knowledge_entries SET archived=false,scope='personal',scope_workspace_id=NULL,scope_subject_id='user:other' WHERE id=${f.groupId}`;
    expect(await parity({ groupId: f.groupId }, f)).toEqual([]);
    await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
    for (const row of await parity({ limit: 20, kind: "note" }, f)) {
      const [details] = await parity({ operation: "get", entryId: row.id }, f);
      expect(
        (details!.revision as unknown as { entry: { relationships: unknown[] } }).entry
          .relationships,
      ).toEqual([]);
    }
  }, 180_000);

  test("group projection preserves absent fields, order, duplicates, pending fallback and foreign exclusion", async () => {
    const f = await seedListingFixture(shared.admin, 0);
    const foreign = await seedListingFixture(shared.admin, 0);
    const pendingId = crypto.randomUUID(),
      pendingRevision = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
      await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id)
        VALUES(${pendingId},${f.accountId},${f.workspaceId},'workspace',${f.workspaceId})`;
      await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,actor)
        VALUES(${pendingRevision},${f.accountId},${pendingId},1,'{}','{}')`;
      await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
        VALUES(${f.accountId},${pendingId},${pendingRevision},1,'pending','{}')`;
      await tx`UPDATE knowledge_entries SET latest_revision_id=${pendingRevision},version=1 WHERE id=${pendingId}`;
    });
    const [owner] =
      await shared.admin`SELECT pg_get_userbyid(proowner) AS name FROM pg_proc WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
    for (const pending of [false, true])
      for (const groupIds of [undefined, [], [pendingId, f.groupId, foreign.groupId, f.groupId]]) {
        const body = {
          content: "Retained 🧪 text".repeat(10000),
          relationships: [{ entryId: f.sourceId, relation: "related_to" }],
          ...(groupIds === undefined ? {} : { groupIds }),
        };
        await shared.admin.begin(async (tx) => {
          await tx`SET LOCAL ROLE ${tx(owner!.name)}`;
          await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
          set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.knowledge_actor_kind','human',true)`;
          const [row] = await tx`WITH input AS (SELECT ${tx.json(body)}::jsonb AS body)
          SELECT knowledge_entry_visible_body(${f.accountId},body,${pending})->'groupIds' AS full,
            knowledge_entry_visible_body(${f.accountId},jsonb_build_object('groupIds',coalesce(body->'groupIds','[]'::jsonb)),${pending})->'groupIds' AS narrow FROM input`;
          expect(row!.narrow).toEqual(row!.full);
          expect(row!.narrow).toEqual(
            !groupIds?.length
              ? []
              : pending
                ? [pendingId, f.groupId, f.groupId]
                : [f.groupId, f.groupId],
          );
        });
      }
  }, 180_000);
});
