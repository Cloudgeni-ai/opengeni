import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, rawRows, withWorkspaceSubjectRls } from "../src/database";
import {
  listKnowledgeEntries,
  listKnowledgeReviewBatches,
  type KnowledgeContext,
} from "../src/knowledge-entries";

/* Knowledge lists come newest first: by latest change (the revision a reader
   sees; a collection changes when anything inside it that the reader can see
   changes), by creation inside an Added window, and by relevance first when
   there is a query. */

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-recent-order");
  if (!acquired) throw new Error("Knowledge order verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

interface Fixture {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}

async function fixture(): Promise<Fixture> {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Knowledge order')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Knowledge order')`;
  await shared.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
  return { accountId, workspaceId, subjectId: `user:${crypto.randomUUID()}` };
}

function context(f: Fixture, review = true): KnowledgeContext {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: f.subjectId,
      writeScopes: ["workspace", "personal", "organization"],
      settingsScopes: ["workspace", "personal"],
      review,
    },
  };
}

/** One published entry with exact dates; `search` overrides its keyword text.
 *  `updatedAt` is when its revision was made and published. */
async function entry(
  f: Fixture,
  options: {
    title: string;
    kind?: string;
    groupIds?: string[];
    createdAt?: string;
    updatedAt: string;
    archived?: boolean;
    owner?: string;
    search?: string;
    /** Exact evidence revisions this entry cites. */
    evidence?: { entryId: string; revisionId: string }[];
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const groupIds = options.groupIds ?? [];
  const personal = options.owner !== undefined;
  // Cast through text: the driver would round a timestamptz parameter to milliseconds.
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,
      scope_subject_id,version,archived,created_at,updated_at)
      VALUES(${id},${f.accountId},${f.workspaceId},${personal ? "personal" : "workspace"},
        ${personal ? null : f.workspaceId},${options.owner ?? null},1,${options.archived ?? false},
        ${options.createdAt ?? "2026-01-01T00:00:00Z"}::text::timestamptz,
        ${options.updatedAt}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
      VALUES(${revision},${f.accountId},${id},1,${tx.json({
        kind: options.kind ?? "note",
        title: options.title,
        content: options.title,
        groupIds,
        relationships: [],
        evidence: options.evidence ?? [],
      })},${options.title},'{}',${options.updatedAt}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      VALUES(${f.accountId},${id},${revision},1,'published','{}',${options.updatedAt}::text::timestamptz)`;
    await tx`UPDATE knowledge_entries SET published_revision_id=${revision},latest_revision_id=${revision}
      WHERE id=${id}`;
    for (const [ordinal, group] of groupIds.entries())
      await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
        VALUES(${f.accountId},${id},${revision},${ordinal},${group},'group')`;
    for (const [index, cited] of (options.evidence ?? []).entries())
      await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,
        target_revision_id,relation)
        VALUES(${f.accountId},${id},${revision},${groupIds.length + index},${cited.entryId},
          ${cited.revisionId},'evidence')`;
    await tx`INSERT INTO knowledge_entry_search(account_id,entry_id,revision_id,chunk_index,search_vector)
      VALUES(${f.accountId},${id},${revision},0,to_tsvector('simple',${options.search ?? options.title}))`;
  });
  return id;
}

/** A later proposal on an entry, as knowledge_entry_apply records it: a new
 *  latest revision and a touched entry row. Rejected ones stay unpublished. */
async function propose(
  f: Fixture,
  id: string,
  options: { at: string; outcome: "pending" | "rejected"; title: string; groupIds?: string[] },
): Promise<string> {
  const revision = crypto.randomUUID();
  const groupIds = options.groupIds ?? [];
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
      VALUES(${revision},${f.accountId},${id},2,${tx.json({
        kind: "note",
        title: options.title,
        content: options.title,
        groupIds,
        relationships: [],
        evidence: [],
      })},${options.title},'{}',${options.at}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      VALUES(${f.accountId},${id},${revision},2,${options.outcome},'{}',${options.at}::text::timestamptz)`;
    await tx`UPDATE knowledge_entries SET version=2,latest_revision_id=${revision},
      updated_at=${options.at}::text::timestamptz WHERE id=${id}`;
    for (const [ordinal, group] of groupIds.entries())
      await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
        VALUES(${f.accountId},${id},${revision},${ordinal},${group},'group')`;
  });
  return revision;
}

/** A reviewer approves a pending proposal: that revision becomes the published one. */
async function approve(f: Fixture, id: string, revision: string, at: string): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      VALUES(${f.accountId},${id},${revision},3,'published','{}',${at}::text::timestamptz)`;
    await tx`UPDATE knowledge_entries SET version=3,published_revision_id=${revision},
      updated_at=${at}::text::timestamptz WHERE id=${id}`;
  });
}

async function titles(
  f: Fixture,
  request: Parameters<typeof listKnowledgeEntries>[2],
  review = true,
): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listKnowledgeEntries(client.db, context(f, review), {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.entries.map((each) => each.revision.title));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return found;
}

test("lists without a query come newest change first, across pages and filters", async () => {
  const f = await fixture();
  // Created in the opposite order, so creation or id order cannot pass this test.
  for (const [index, title] of ["Oldest", "Older", "Middle", "Newer", "Newest"].entries())
    await entry(f, {
      title,
      kind: index % 2 ? "decision" : "fact",
      createdAt: `2026-0${9 - index}-01T00:00:00Z`,
      updatedAt: `2026-10-0${index + 1}T08:00:00.123456Z`,
    });
  const expected = ["Newest", "Newer", "Middle", "Older", "Oldest"];
  expect(await titles(f, { limit: 50 })).toEqual(expected);
  // Two-row pages follow the same order without repeats or gaps.
  expect(await titles(f, { limit: 2 })).toEqual(expected);
  expect(await titles(f, { limit: 1, kind: "decision" })).toEqual(["Newer", "Older"]);
  expect(await titles(f, { limit: 2, kind: "fact", scope: "workspace" })).toEqual([
    "Newest",
    "Middle",
    "Oldest",
  ]);
  // Readers without review rights see the same published order.
  expect(await titles(f, { limit: 2 }, false)).toEqual(expected);
  const [first] = (await listKnowledgeEntries(client.db, context(f), { limit: 1 })).entries;
  expect(first!.lastChangedAt).toBe("2026-10-05T08:00:00.123456+00:00");
}, 180_000);

test("equal change times keep a stable order across pages", async () => {
  const f = await fixture();
  for (const title of ["A", "B", "C", "D", "E", "F"])
    await entry(f, { title, updatedAt: "2026-10-01T00:00:00Z" });
  const all = await titles(f, { limit: 50 });
  expect(all).toHaveLength(6);
  expect(await titles(f, { limit: 4 })).toEqual(all);
  expect(await titles(f, { limit: 1 })).toEqual(all);
}, 180_000);

test("an Added window lists the newest entries first by creation", async () => {
  const f = await fixture();
  await entry(f, {
    title: "Added first, edited last",
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  });
  await entry(f, {
    title: "Added last",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  });
  await entry(f, {
    title: "Before the window",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
  });
  expect(await titles(f, { limit: 1, createdSince: "2026-10-01T00:00:00Z" })).toEqual([
    "Added last",
    "Added first, edited last",
  ]);
  const page = await listKnowledgeEntries(client.db, context(f), {
    createdSince: "2026-10-01T00:00:00Z",
  });
  expect(page.entries[0]!.lastChangedAt).toBeUndefined();
}, 180_000);

test("a query ranks by relevance first and breaks ties newest first", async () => {
  const f = await fixture();
  await entry(f, {
    title: "Best match, oldest",
    search: "deploy deploy deploy reviewer",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await entry(f, { title: "Tie, older", search: "deploy", updatedAt: "2026-10-01T00:00:00Z" });
  await entry(f, { title: "Tie, newer", search: "deploy", updatedAt: "2026-10-05T00:00:00Z" });
  await entry(f, { title: "No match", search: "billing", updatedAt: "2026-10-09T00:00:00Z" });
  for (const limit of [1, 50])
    expect(await titles(f, { query: "deploy", mode: "keyword", limit })).toEqual([
      "Best match, oldest",
      "Tie, newer",
      "Tie, older",
    ]);
}, 180_000);

test("a collection counts as changed when anything readable inside it changes", async () => {
  const f = await fixture();
  const other = "user:someone-else";
  // Recently edited itself, nothing newer inside.
  const edited = await entry(f, {
    title: "Edited collection",
    kind: "group",
    updatedAt: "2026-10-05T00:00:00Z",
  });
  // Old itself; a sub-collection's entry changed most recently of all.
  const parent = await entry(f, {
    title: "Parent collection",
    kind: "group",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const child = await entry(f, {
    title: "Child collection",
    kind: "group",
    groupIds: [parent],
    updatedAt: "2026-02-01T00:00:00Z",
  });
  await entry(f, {
    title: "Deep entry",
    groupIds: [child],
    updatedAt: "2026-10-08T00:00:00.5Z",
  });
  // Old; holds only changes this reader can't see or that agents don't use.
  const quiet = await entry(f, {
    title: "Quiet collection",
    kind: "group",
    updatedAt: "2026-03-01T00:00:00Z",
  });
  await entry(f, {
    title: "Someone else's entry",
    groupIds: [quiet],
    owner: other,
    updatedAt: "2026-10-09T00:00:00Z",
  });
  await entry(f, {
    title: "Archived entry",
    groupIds: [quiet],
    archived: true,
    updatedAt: "2026-10-09T00:00:00Z",
  });
  // Readable on its own scope, but its evidence is archived, so readers can't open it.
  const withdrawn = await entry(f, {
    title: "Withdrawn source",
    kind: "source",
    archived: true,
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const [withdrawnRevision] = await shared.admin<
    { id: string }[]
  >`SELECT published_revision_id AS id
    FROM knowledge_entries WHERE id=${withdrawn}`;
  await entry(f, {
    title: "Finding citing it",
    groupIds: [quiet],
    evidence: [{ entryId: withdrawn, revisionId: withdrawnRevision!.id }],
    updatedAt: "2026-10-09T00:00:00Z",
  });
  // Membership cycles end the walk.
  const loopA = await entry(f, {
    title: "Loop A",
    kind: "group",
    updatedAt: "2026-04-01T00:00:00Z",
  });
  const loopB = await entry(f, {
    title: "Loop B",
    kind: "group",
    groupIds: [loopA],
    updatedAt: "2026-04-02T00:00:00Z",
  });
  const [loopRevision] = await shared.admin<{ id: string }[]>`SELECT published_revision_id AS id
    FROM knowledge_entries WHERE id=${loopA}`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
    VALUES(${f.accountId},${loopA},${loopRevision!.id},0,${loopB},'group')`;

  expect(await titles(f, { kind: "group", rootOnly: true, limit: 1 })).toEqual([
    "Parent collection",
    "Edited collection",
    "Quiet collection",
  ]);
  const roots = await listKnowledgeEntries(client.db, context(f), {
    kind: "group",
    rootOnly: true,
  });
  expect(
    Object.fromEntries(roots.entries.map((each) => [each.revision.title, each.lastChangedAt])),
  ).toEqual({
    "Parent collection": "2026-10-08T00:00:00.5+00:00",
    "Edited collection": "2026-10-05T00:00:00+00:00",
    "Quiet collection": "2026-03-01T00:00:00+00:00",
  });
  // Every collection, nested ones included, by the same activity. Equal
  // activity (a parent and the child that changed it, the two loop members)
  // keeps a stable order between them.
  const all = await titles(f, { kind: "group", limit: 2 });
  expect(all).toHaveLength(6);
  expect(all.slice(0, 2).sort()).toEqual(["Child collection", "Parent collection"]);
  expect(all[2]).toBe("Edited collection");
  expect(all.slice(3, 5).sort()).toEqual(["Loop A", "Loop B"]);
  expect(all[5]).toBe("Quiet collection");
  expect(await titles(f, { kind: "group", limit: 50 })).toEqual(all);
  // Opening a collection lists its members by the same rule.
  expect(await titles(f, { groupId: parent })).toEqual(["Child collection"]);
  expect(await titles(f, { groupId: child })).toEqual(["Deep entry"]);
  void edited;
}, 180_000);

test("pending and rejected proposals never reorder the published Library", async () => {
  const f = await fixture();
  const a = await entry(f, { title: "A", kind: "group", updatedAt: "2026-01-01T00:00:00Z" });
  const b = await entry(f, { title: "B", kind: "group", updatedAt: "2026-01-02T00:00:00Z" });
  const inA = await entry(f, { title: "In A", groupIds: [a], updatedAt: "2026-02-01T00:00:00Z" });
  const inB = await entry(f, { title: "In B", groupIds: [b], updatedAt: "2026-03-01T00:00:00Z" });
  const loose = await entry(f, { title: "Loose", updatedAt: "2026-01-15T00:00:00Z" });
  const published = ["In B", "In A", "Loose"];
  expect(await titles(f, { kind: "group", rootOnly: true })).toEqual(["B", "A"]);
  expect(await titles(f, { kind: "note", limit: 2 })).toEqual(published);

  // Newer, unapproved or refused changes to old entries, inside and outside collections.
  await propose(f, inA, {
    at: "2026-10-01T00:00:00Z",
    outcome: "pending",
    title: "In A, proposed",
  });
  await propose(f, loose, {
    at: "2026-10-02T00:00:00Z",
    outcome: "pending",
    title: "Loose, proposed",
  });
  await propose(f, inB, {
    at: "2026-10-03T00:00:00Z",
    outcome: "rejected",
    title: "In B, refused",
  });
  for (const review of [true, false]) {
    expect(await titles(f, { kind: "group", rootOnly: true }, review)).toEqual(["B", "A"]);
    expect(await titles(f, { kind: "note", limit: 2 }, review)).toEqual(published);
  }
  const roots = await listKnowledgeEntries(client.db, context(f, false), {
    kind: "group",
    rootOnly: true,
  });
  expect(roots.entries.map((each) => each.lastChangedAt)).toEqual([
    "2026-03-01T00:00:00+00:00",
    "2026-02-01T00:00:00+00:00",
  ]);
  // Reviewers see the waiting proposals themselves newest first.
  expect(await titles(f, { view: "needs_review", limit: 1 })).toEqual([
    "Loose, proposed",
    "In A, proposed",
  ]);
  expect(await titles(f, { view: "rejected" })).toEqual(["In B, refused"]);
}, 180_000);

test("approving a proposal moves the entry and its collections up", async () => {
  const f = await fixture();
  const quiet = await entry(f, {
    title: "Quiet",
    kind: "group",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const busy = await entry(f, { title: "Busy", kind: "group", updatedAt: "2026-01-02T00:00:00Z" });
  const old = await entry(f, {
    title: "Old",
    groupIds: [quiet],
    updatedAt: "2026-02-01T00:00:00Z",
  });
  await entry(f, { title: "Edited", groupIds: [busy], updatedAt: "2026-10-10T00:00:00Z" });
  // Proposed before the other edit, approved after it.
  const revision = await propose(f, old, {
    at: "2026-10-01T00:00:00Z",
    outcome: "pending",
    title: "Old, improved",
    groupIds: [quiet],
  });
  expect(await titles(f, { kind: "note" })).toEqual(["Edited", "Old"]);
  await approve(f, old, revision, "2026-10-20T00:00:00Z");
  expect(await titles(f, { kind: "note" })).toEqual(["Old, improved", "Edited"]);
  expect(await titles(f, { kind: "group", rootOnly: true })).toEqual(["Quiet", "Busy"]);
  const [first] = (await listKnowledgeEntries(client.db, context(f), { kind: "note" })).entries;
  expect(first!.lastChangedAt).toBe("2026-10-20T00:00:00+00:00");
}, 180_000);

test("a collection's activity follows the chosen scope, and searches skip it", async () => {
  const f = await fixture();
  const runbooks = await entry(f, {
    title: "Shared collection",
    kind: "group",
    search: "runbooks",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  await entry(f, {
    title: "Workspace member",
    groupIds: [runbooks],
    updatedAt: "2026-02-01T00:00:00Z",
  });
  await entry(f, {
    title: "My private member",
    groupIds: [runbooks],
    owner: f.subjectId,
    updatedAt: "2026-10-01T00:00:00Z",
  });
  const changed = async (request: Parameters<typeof listKnowledgeEntries>[2]) =>
    (await listKnowledgeEntries(client.db, context(f), request)).entries.map(
      (each) => each.lastChangedAt,
    );
  expect(await changed({ kind: "group" })).toEqual(["2026-10-01T00:00:00+00:00"]);
  expect(await changed({ kind: "group", scope: "workspace" })).toEqual([
    "2026-02-01T00:00:00+00:00",
  ]);
  // A search ranks by relevance and breaks ties on each row's own change.
  expect(await changed({ kind: "group", query: "runbooks", mode: "keyword" })).toEqual([
    "2026-01-01T00:00:00+00:00",
  ]);
}, 180_000);

test("older cursors ask for a refresh or continue in their own order", async () => {
  const f = await fixture();
  for (const [index, title] of ["One", "Two", "Three"].entries())
    await entry(f, { title, updatedAt: `2026-10-0${index + 1}T00:00:00Z` });
  const first = await listKnowledgeEntries(client.db, context(f), { limit: 1 });
  const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // A cursor from before the order key existed.
  await expect(
    listKnowledgeEntries(client.db, context(f), { limit: 1, cursor: encode({ ...decoded, v: 2 }) }),
  ).rejects.toThrow("Refresh the results to continue.");
  // A first page read from a function without the order key ended on the
  // lowest id; its cursor has no order key and the next page continues by id.
  const ids = (
    await shared.admin<{ id: string }[]>`SELECT id FROM knowledge_entries
      WHERE account_id=${f.accountId} ORDER BY id`
  ).map((row) => row.id);
  const { afterOrderedAt: _dropped, ...unordered } = { ...decoded, afterId: ids[0] };
  const next = await listKnowledgeEntries(client.db, context(f), {
    limit: 1,
    cursor: encode(unordered),
  });
  expect(next.entries.map((each) => each.id)).toEqual([ids[1]!]);
  expect(next.entries[0]!.lastChangedAt).toBeUndefined();
}, 180_000);

test("review groups list the newest pending change first", async () => {
  const f = await fixture();
  const batches: string[] = [];
  for (const [index, at] of [
    "2026-10-03T00:00:00Z",
    "2026-10-01T00:00:00Z",
    "2026-10-05T00:00:00Z",
  ].entries()) {
    const batch = crypto.randomUUID();
    batches.push(batch);
    await shared.admin`INSERT INTO knowledge_review_batches(id,account_id,origin_workspace_id,owner_key,created_at)
      VALUES(${batch},${f.accountId},${f.workspaceId},${`workspace:${f.workspaceId}`},'2026-09-01T00:00:00Z')`;
    const id = await entry(f, { title: `Proposal ${index}`, updatedAt: at });
    const revision = crypto.randomUUID();
    await shared.admin`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,
      review_batch_id,created_at)
      VALUES(${revision},${f.accountId},${id},2,${shared.admin.json({
        kind: "note",
        title: `Proposal ${index}`,
        content: "Proposed",
        groupIds: [],
        relationships: [],
        evidence: [],
      })},'Proposed','{}',${batch},${at})`;
    await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
      VALUES(${f.accountId},${id},${revision},2,'pending','{}')`;
    await shared.admin`UPDATE knowledge_entries SET version=2,latest_revision_id=${revision} WHERE id=${id}`;
  }
  const order: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listKnowledgeReviewBatches(client.db, context(f), {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    order.push(...page.batches.map((batch) => batch.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(order).toEqual([batches[2]!, batches[0]!, batches[1]!]);
}, 180_000);

test("callers that send no order keep the previous results and projection", async () => {
  const f = await fixture();
  for (const [index, title] of ["One", "Two", "Three"].entries())
    await entry(f, { title, updatedAt: `2026-10-0${index + 1}T00:00:00Z` });
  const ids = (
    await shared.admin<{ id: string }[]>`SELECT id FROM knowledge_entries
      WHERE account_id=${f.accountId} ORDER BY id`
  ).map((row) => row.id);
  // The exact call an earlier binary makes, without `order`.
  const read = (request: Record<string, unknown>) =>
    withWorkspaceSubjectRls(client.db, f.workspaceId, f.subjectId, async (tx) => {
      await tx.execute(sql`SELECT set_config('opengeni.principal_kind','human_session',true)`);
      const [row] = await rawRows<{ result: Record<string, unknown>[] }>(
        tx,
        sql`SELECT knowledge_entry_read(${f.accountId}::uuid,${f.workspaceId}::uuid,
          ${JSON.stringify(context(f).actor)}::jsonb,${JSON.stringify(request)}::jsonb) AS result`,
      );
      return row!.result;
    });
  const unordered = await read({ operation: "list", view: "published", limit: 50 });
  expect(unordered.map((row) => row.id)).toEqual(ids);
  expect(unordered.every((row) => !("orderedAt" in row))).toBe(true);
  const ordered = await read({ operation: "list", view: "published", limit: 50, order: "updated" });
  expect(ordered.map((row) => (row.revision as { title: string }).title)).toEqual([
    "Three",
    "Two",
    "One",
  ]);
}, 180_000);

test("the migration keeps the read capability's security metadata", async () => {
  const [metadata] =
    await shared.admin`SELECT p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  expect(metadata!.prosecdef).toBe(true);
  expect((metadata!.proconfig as string[]).some((each) => each.startsWith("search_path="))).toBe(
    true,
  );
  // Collection activity counts only members that pass the batched visibility check.
  expect(metadata!.definition).toContain("member_allowed AS MATERIALIZED");
  expect(metadata!.definition).toContain(
    "CROSS JOIN LATERAL knowledge_revisions_visible(p_account,c.ids,c.revisions,",
  );
}, 60_000);
