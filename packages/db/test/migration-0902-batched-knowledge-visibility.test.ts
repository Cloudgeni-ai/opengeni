import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createSession,
  claimSessionWorkForAttempt,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import {
  listingDatabase,
  seedListingFixture,
  type ListingFixture,
} from "./fixtures/knowledge-collection-listing";
import { installPreBatchKnowledgeBaseline } from "./fixtures/knowledge-batch-visibility-baseline";

let shared: SharedTestDatabase;
let app: postgres.Sql;
let client: DbClient;
beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  client = createDb(shared.appUrl, { max: 2 });
  await installPreBatchKnowledgeBaseline(shared.admin, shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await app?.end();
  await shared?.release();
}, 60_000);

async function read(
  f: ListingFixture,
  request: Record<string, postgres.JSONValue>,
  baseline = false,
  actor: postgres.JSONValue = f.actor,
) {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
      set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
    const [row] = baseline
      ? await tx`SELECT knowledge_entry_read_before_batch(${f.accountId},${f.workspaceId},${tx.json(actor)},${tx.json(request)}) AS result`
      : await tx`SELECT knowledge_entry_read(${f.accountId},${f.workspaceId},${tx.json(actor)},${tx.json(request)}) AS result`;
    return row!.result as Array<{ id: string; score: number; revision: { id: string } }>;
  });
}
async function parity(f: ListingFixture, request: Record<string, postgres.JSONValue>) {
  const baseline = await read(f, request, true);
  const current = await read(f, request);
  expect(current).toEqual(baseline);
  return current;
}

test("batched ACLs preserve full responses, keyword eligibility, rank and pagination", async () => {
  const f = await seedListingFixture(shared.admin, 120);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await app.unsafe(`SET plan_cache_mode=${mode}`);
    for (const request of [
      { operation: "list", limit: 20 },
      { operation: "list", limit: 20, rootOnly: true },
      { operation: "list", limit: 20, groupId: f.groupId },
      { operation: "list", limit: 20, createdSince: "2000-01-01T00:00:00Z" },
      { operation: "list", limit: 20, query: "nonexistentterm", mode: "keyword" },
      { operation: "list", limit: 20, query: '"Member" OR Collection -Source', mode: "keyword" },
      { operation: "list", limit: 20, query: "Member", mode: "hybrid" },
      { operation: "list", limit: 20, query: "Member", mode: "vector" },
      { operation: "get", entryId: f.sourceId },
      { operation: "history", entryId: f.groupId },
    ])
      await parity(f, request);
    const ids: string[] = [];
    let cursor: { afterId: string; afterScore: number } | undefined;
    do {
      const rows = await parity(f, {
        operation: "list",
        query: "Member",
        mode: "keyword",
        limit: 25,
        ...cursor,
      });
      ids.push(...rows.slice(0, 25).map((row) => row.id));
      cursor =
        rows.length > 25 ? { afterId: rows[24]!.id, afterScore: rows[24]!.score } : undefined;
    } while (cursor);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
  }
}, 180_000);

test("evidence cycles terminate and shared dependencies keep root-specific archive rules", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  const [member] = await shared.admin`SELECT entry_id,revision_id FROM knowledge_entry_links
    WHERE account_id=${f.accountId} AND relation='evidence' LIMIT 1`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${f.sourceId},${f.sourceRevisionId},99,${member!.entry_id},${member!.revision_id},'evidence')`;
  expect(await parity(f, { operation: "get", entryId: member!.entry_id })).toHaveLength(1);
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.sourceId}`;
  expect(await parity(f, { operation: "get", entryId: member!.entry_id })).toEqual([]);
  expect(await parity(f, { operation: "get", entryId: f.sourceId, view: "archived" })).toHaveLength(
    1,
  );
  await shared.admin`UPDATE knowledge_entries SET archived=false,scope='personal',scope_workspace_id=NULL,
    scope_subject_id='user:other' WHERE id=${f.sourceId}`;
  expect(await parity(f, { operation: "get", entryId: member!.entry_id })).toEqual([]);
}, 180_000);

test("batching preserves incidental-source discovery without hiding their evidence dependents", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  await shared.admin`UPDATE knowledge_entries SET prepared_file_id=${f.sourceFileId} WHERE id=${f.sourceId}`;
  const listed = await parity(f, { operation: "list", limit: 50 });
  expect(listed).toHaveLength(9);
  expect(listed.some((row) => row.id === f.sourceId)).toBe(false);
  expect(await parity(f, { operation: "list", limit: 50, includeEvidence: true })).toHaveLength(10);
  expect(await parity(f, { operation: "get", entryId: f.sourceId })).toHaveLength(1);
}, 180_000);

test("revoked file visibility is rechecked on the next statement, including one open transaction", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  const request = { operation: "list", limit: 50 };
  await app.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
      set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
    const query = async () => {
      const [row] =
        await tx`SELECT knowledge_entry_read(${f.accountId},${f.workspaceId},${tx.json(f.actor)},${tx.json(request)}) AS result`;
      return row!.result as Array<{ id: string }>;
    };
    const before = await query();
    await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
    const revoked = await query();
    expect(revoked.length).toBe(before.length - 3);
    expect(revoked.some((row) => row.id === f.sourceId)).toBe(false);
    await shared.admin`UPDATE files SET status='ready' WHERE id=${f.sourceFileId}`;
    expect(await query()).toEqual(before);
  });
  await parity(f, request);
}, 180_000);

test("the canonical batch helper is private and retains hardened volatile metadata", async () => {
  for (const signature of [
    "knowledge_revision_visible(uuid,uuid,uuid,boolean)",
    "knowledge_revisions_visible(uuid,uuid[],uuid[],boolean)",
  ]) {
    const [row] = await shared.admin`SELECT p.prosecdef,p.provolatile,p.proconfig,
      format('search_path=%I, pg_catalog, pg_temp',n.nspname) expected,
      has_function_privilege(${decodeURIComponent(new URL(shared.appUrl).username)},p.oid,'EXECUTE') allowed
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=to_regprocedure(${signature})`;
    expect(row!.prosecdef).toBe(false);
    expect(row!.provolatile).toBe("v");
    expect(row!.proconfig).toEqual([row!.expected]);
    expect(row!.allowed).toBe(false);
  }
});

test("empty, duplicate, missing and cross-account identities retain scalar boolean semantics", async () => {
  const f = await seedListingFixture(shared.admin, 4);
  const other = await seedListingFixture(shared.admin, 0);
  const entries = [f.sourceId, f.sourceId, null, crypto.randomUUID(), f.groupId, other.sourceId];
  const revisions = [
    f.sourceRevisionId,
    f.sourceRevisionId,
    null,
    crypto.randomUUID(),
    f.sourceRevisionId,
    other.sourceRevisionId,
  ];
  await shared.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
      set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.knowledge_actor_kind','human',true)`;
    for (const pending of [true, false, null]) {
      const rows = await tx`WITH allowed AS MATERIALIZED (SELECT * FROM knowledge_revisions_visible(
        ${f.accountId},${entries}::uuid[],${revisions}::uuid[],${pending}::boolean))
        SELECT knowledge_revision_visible_before_batch(${f.accountId},x.entry_id,x.revision_id,${pending}::boolean) AS before,
          EXISTS(SELECT 1 FROM allowed a WHERE a.entry_id=x.entry_id AND a.revision_id=x.revision_id) AS after
        FROM unnest(${entries}::uuid[],${revisions}::uuid[]) x(entry_id,revision_id)`;
      expect(rows.map((row) => row.after)).toEqual(rows.map((row) => row.before));
    }
    expect(
      await tx`SELECT * FROM knowledge_revisions_visible(${f.accountId},ARRAY[]::uuid[],ARRAY[]::uuid[],false)`,
    ).toHaveLength(0);
  });
}, 180_000);

test("agent reads retain their session fence, and measure its post-acquisition lifetime", async () => {
  const f = await seedListingFixture(
    shared.admin,
    process.env.OPENGENI_BENCH_KNOWLEDGE_BATCH ? 1200 : 12,
  );
  const session = await withSessionRlsActorContext({ subjectId: f.subjectId }, () =>
    createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "Knowledge lock fixture",
      resources: [],
      metadata: {},
      memoryScope: "workspace",
      model: "fixture-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: f.subjectId },
      createdByContext: {},
    }),
  );
  await saveAgentLearningSettings(
    client.db,
    {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: f.subjectId,
        writeScopes: ["workspace", "personal", "organization"],
        settingsScopes: ["workspace", "personal"],
        review: true,
      },
    },
    {
      scope: "workspace",
      source: { kind: "chat", id: session.id },
      operationId: crypto.randomUUID(),
      expectedVersion: 0,
      settings: { knowledge: "automatic" },
    },
  );
  await initializeSessionStartAtomically(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: session.id,
    workflowId: `knowledge-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Expected claimed fixture attempt");
  const actor = {
    kind: "agent",
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
  const results: unknown[] = [];
  for (const baseline of [true, false]) {
    const routine = baseline ? "knowledge_entry_read_before_batch" : "knowledge_entry_read";
    const [source] =
      await shared.admin`SELECT pg_get_functiondef(to_regprocedure(${`${routine}(uuid,uuid,jsonb,jsonb)`})) definition`;
    const anchor = "actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);";
    const definition = source!.definition as string;
    expect(definition.split(anchor)).toHaveLength(2);
    // Fixture-only timestamp immediately after all accepted-attempt SHARE locks.
    // The measured interval ends just before COMMIT; no production instrumentation.
    await shared.admin.unsafe(
      definition.replace(
        anchor,
        `${anchor}\n  PERFORM set_config('opengeni.test_knowledge_lock_start',clock_timestamp()::text,true);`,
      ),
    );
    try {
      for (const request of [
        { operation: "list", limit: 20 },
        { operation: "list", limit: 20, query: "nonexistentterm", mode: "keyword" },
        ...(process.env.OPENGENI_BENCH_KNOWLEDGE_BATCH
          ? [
              { operation: "list", limit: 20, query: "Member", mode: "keyword" },
              { operation: "get", entryId: f.groupId },
            ]
          : []),
      ]) {
        const durations: number[] = [];
        for (let i = 0; i < (process.env.OPENGENI_BENCH_KNOWLEDGE_BATCH ? 8 : 2); i++) {
          await app.begin(async (tx) => {
            await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
              set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
            await tx`SELECT ${tx(routine)}(${f.accountId},${f.workspaceId},${tx.json(actor)},${tx.json(request)})`;
            if (i === 0) {
              await expect(
                Promise.resolve(
                  shared.admin`SELECT id FROM sessions WHERE id=${session.id} FOR NO KEY UPDATE NOWAIT`,
                ),
              ).rejects.toMatchObject({ code: "55P03" });
            }
            const [timing] =
              await tx`SELECT extract(epoch FROM clock_timestamp()-current_setting('opengeni.test_knowledge_lock_start')::timestamptz)*1000 AS ms`;
            if (i >= 2) durations.push(Number(timing!.ms));
          });
        }
        results.push({ baseline, request, postFenceToPreCommitMs: durations });
      }
    } finally {
      await shared.admin.unsafe(definition);
    }
  }
  if (process.env.OPENGENI_BENCH_KNOWLEDGE_BATCH)
    console.log(JSON.stringify({ knowledgeBatchLockBudget: results }));
}, 180_000);
