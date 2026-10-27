import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, saveKnowledgeEntry } from "../src";
import type { KnowledgeActor } from "../src/knowledge-entries";

/* Newest-first lists keep each collection's newest change (migration 1008)
   instead of walking every member on every read. The kept time must always
   equal a full rebuild, and a read that uses it must return exactly what the
   walk returns, for every reader, scope, view and page. */

let shared: SharedTestDatabase;
let appRole: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-collection-activity");
  if (!acquired) throw new Error("Knowledge collection activity verification requires PostgreSQL");
  shared = acquired;
  appRole = decodeURIComponent(new URL(shared.appUrl).username);
}, 900_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

interface Fixture {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  otherSubjectId: string;
}

async function fixture(): Promise<Fixture> {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Collection activity')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Collection activity')`;
  await shared.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
  return {
    accountId,
    workspaceId,
    subjectId: `user:${crypto.randomUUID()}`,
    otherSubjectId: `user:${crypto.randomUUID()}`,
  };
}

function actor(subjectId: string, review: boolean) {
  return {
    kind: "human",
    principalKind: "human_session",
    subjectId,
    writeScopes: ["workspace", "personal", "organization"],
    settingsScopes: ["workspace", "personal"],
    review,
  };
}

/** A deterministic pseudo-random sequence, so a failure replays. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Microsecond times; some steps reuse a time so ties are covered. */
function clock(start = Date.parse("2026-03-01T00:00:00Z")) {
  let micros = 0;
  return (tie = false) => {
    if (!tie) micros += 1_000_123;
    const whole = new Date(start + Math.floor(micros / 1000)).toISOString().slice(0, 19);
    return `${whole}.${String(micros % 1_000_000).padStart(6, "0")}Z`;
  };
}

type Tx = postgres.Sql | postgres.TransactionSql;

function body(kind: string, title: string, groupIds: string[]): Record<string, postgres.JSONValue> {
  return { kind, title, content: title, groupIds, relationships: [], evidence: [] };
}

async function links(tx: Tx, f: Fixture, id: string, revision: string, groupIds: string[]) {
  for (const [ordinal, group] of groupIds.entries())
    await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
      VALUES(${f.accountId},${id},${revision},${ordinal},${group},'group')`;
}

/** A published entry, recorded as knowledge_entry_apply records one. */
async function create(
  f: Fixture,
  options: { kind: string; title: string; groupIds?: string[]; at: string; owner?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const personal = options.owner !== undefined;
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,
      scope_subject_id,version,created_at,updated_at)
      VALUES(${id},${f.accountId},${f.workspaceId},${personal ? "personal" : "workspace"},
        ${personal ? null : f.workspaceId},${options.owner ?? null},1,
        ${options.at}::text::timestamptz,${options.at}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
      VALUES(${revision},${f.accountId},${id},1,${tx.json(body(options.kind, options.title, options.groupIds ?? []))},
        ${options.title},'{}',${options.at}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      VALUES(${f.accountId},${id},${revision},1,'published','{}',${options.at}::text::timestamptz)`;
    await tx`UPDATE knowledge_entries SET published_revision_id=${revision},latest_revision_id=${revision} WHERE id=${id}`;
    await links(tx, f, id, revision, options.groupIds ?? []);
    await tx`INSERT INTO knowledge_entry_search(account_id,entry_id,revision_id,chunk_index,search_vector)
      VALUES(${f.accountId},${id},${revision},0,to_tsvector('simple',${options.title}))`;
  });
  return id;
}

/** A new revision: published at once, or a pending/rejected proposal. */
async function revise(
  f: Fixture,
  id: string,
  options: {
    kind: string;
    groupIds: string[];
    at: string;
    outcome: "published" | "pending" | "rejected";
  },
  tx: Tx = shared.admin,
): Promise<string> {
  const revision = crypto.randomUUID();
  const [current] = await tx`SELECT version FROM knowledge_entries WHERE id=${id}`;
  const version = Number(current!.version) + 1;
  await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
    VALUES(${revision},${f.accountId},${id},${version},${tx.json(body(options.kind, `Revision ${version}`, options.groupIds))},
      'Revision','{}',${options.at}::text::timestamptz)`;
  await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
    VALUES(${f.accountId},${id},${revision},${version},${options.outcome},'{}',${options.at}::text::timestamptz)`;
  await links(tx, f, id, revision, options.groupIds);
  if (options.outcome === "published")
    await tx`UPDATE knowledge_entries SET version=${version},published_revision_id=${revision},
      latest_revision_id=${revision},updated_at=${options.at}::text::timestamptz WHERE id=${id}`;
  else
    await tx`UPDATE knowledge_entries SET version=${version},latest_revision_id=${revision},
      updated_at=${options.at}::text::timestamptz WHERE id=${id}`;
  return revision;
}

/** A later decision on a revision, such as approving the pending one. */
async function decide(f: Fixture, id: string, revision: string, at: string) {
  await shared.admin.begin(async (tx) => {
    const [current] = await tx`SELECT version FROM knowledge_entries WHERE id=${id}`;
    const version = Number(current!.version) + 1;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      VALUES(${f.accountId},${id},${revision},${version},'published','{}',${at}::text::timestamptz)`;
    await tx`UPDATE knowledge_entries SET version=${version},published_revision_id=${revision},
      updated_at=${at}::text::timestamptz WHERE id=${id}`;
  });
}

/** Kept activity, and what a full rebuild from the same data produces. */
async function kept(f: Fixture) {
  const rows = await shared.admin`SELECT entry_id::text AS id,changed_at::text AS at
    FROM knowledge_collection_activity WHERE account_id=${f.accountId} ORDER BY entry_id`;
  return rows.map((row) => `${row.id}=${row.at}`);
}
async function states(f: Fixture) {
  const rows =
    await shared.admin`SELECT state FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId} ORDER BY state`;
  return rows.map((row) => String(row.state));
}
async function expectKeptMatchesRebuild(f: Fixture) {
  expect(await states(f)).toEqual(["built"]);
  const actual = await kept(f);
  const rebuilt = await shared.admin
    .begin(async (tx) => {
      await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
      await tx`SELECT knowledge_collection_activity_rebuild(${f.accountId})`;
      const rows = await tx`SELECT entry_id::text AS id,changed_at::text AS at
        FROM knowledge_collection_activity WHERE account_id=${f.accountId} ORDER BY entry_id`;
      throw Object.assign(new Error("rollback"), { rows });
    })
    .catch((error: { rows?: postgres.Row[] }) => {
      if (!error.rows) throw error;
      return error.rows.map((row) => `${row.id}=${row.at}`);
    });
  expect(actual).toEqual(rebuilt);
}

type Row = {
  id: string;
  score: number;
  orderedAt?: string;
  revision: { title: string; number: number };
};

/** Every page of a list as the restricted application role would read it. */
async function readAll(
  tx: postgres.TransactionSql,
  f: Fixture,
  reader: ReturnType<typeof actor>,
  request: Record<string, postgres.JSONValue>,
  limit: number,
  ordered = true,
): Promise<Row[]> {
  await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
    set_config('opengeni.subject_id',${reader.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
  await tx`SET LOCAL ROLE ${tx(appRole)}`;
  const found: Row[] = [];
  let after: Record<string, postgres.JSONValue> = {};
  for (;;) {
    const [row] =
      await tx`SELECT knowledge_entry_read(${f.accountId},${f.workspaceId},${tx.json(reader)},
      ${tx.json({ operation: "list", ...(ordered ? { order: "updated" } : {}), limit, ...request, ...after })}) AS result`;
    const page = row!.result as Row[];
    found.push(...page.slice(0, limit));
    if (page.length <= limit) break;
    const last = page[limit - 1]!;
    // History pages by revision number, lists by keyset.
    after =
      request.operation === "history"
        ? { beforeRevision: last.revision.number }
        : { afterId: last.id, afterScore: last.score, afterOrderedAt: last.orderedAt ?? null };
  }
  await tx`RESET ROLE`;
  return found;
}

/** The kept-activity read and the walk-only read return identical pages. */
async function expectParity(
  f: Fixture,
  reader: ReturnType<typeof actor>,
  request: Record<string, postgres.JSONValue>,
  limit = 50,
) {
  const results = await shared.admin
    .begin(async (tx) => {
      const fast = await readAll(tx, f, reader, request, limit);
      await tx`DELETE FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId}`;
      const walked = await readAll(tx, f, reader, request, limit);
      throw Object.assign(new Error("rollback"), { results: [fast, walked] });
    })
    .catch((error: { results?: [Row[], Row[]] }) => {
      if (!error.results) throw error;
      return error.results;
    });
  expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[1]));
  return results[0];
}

async function expectAllReadsMatch(f: Fixture, groups: string[]) {
  const readers = [
    actor(f.subjectId, true),
    actor(f.subjectId, false),
    actor(f.otherSubjectId, false),
  ];
  for (const reader of readers) {
    await expectParity(f, reader, { rootOnly: true }, 4);
    await expectParity(f, reader, { kind: "group" });
    await expectParity(f, reader, {}, 7);
    await expectParity(f, reader, { scope: "workspace", rootOnly: true });
    await expectParity(f, reader, { scope: "personal" });
    await expectParity(f, reader, { view: "archived" });
  }
  for (const group of groups.slice(0, 3)) await expectParity(f, readers[0]!, { groupId: group });
  // History has one row per revision; an order key must not change it.
  for (const group of groups.slice(0, 2))
    await expectParity(f, readers[0]!, { operation: "history", entryId: group }, 3);
}

test("random changes keep activity equal to a rebuild and reads equal to the walk", async () => {
  for (const seed of [6217, 80_458, 1008, 6412, 4_242, 77, 31_337, 2026]) {
    const next = random(seed);
    const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
    const at = clock();
    const f = await fixture();
    const groups: string[] = [];
    const notes: string[] = [];
    const kinds = new Map<string, string>();
    const pending = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const id = await create(f, {
        kind: "group",
        title: `Collection ${i}`,
        groupIds: i > 1 && next() < 0.7 ? [pick(groups)] : [],
        at: at(),
      });
      groups.push(id);
      kinds.set(id, "group");
    }
    for (let i = 0; i < 18; i++) {
      const id = await create(f, {
        kind: "note",
        title: `Note ${i}`,
        groupIds: next() < 0.85 ? [pick(groups)] : [],
        at: at(next() < 0.2),
        ...(next() < 0.2 ? { owner: next() < 0.5 ? f.subjectId : f.otherSubjectId } : {}),
      });
      notes.push(id);
      kinds.set(id, "note");
    }
    await expectKeptMatchesRebuild(f);
    await expectAllReadsMatch(f, groups);
    for (let step = 0; step < 60; step++) {
      const id = pick(next() < 0.4 ? groups : notes);
      const choice = next();
      // Membership may name any other collection, so cycles form too.
      const groupIds = [...new Set([pick(groups), ...(next() < 0.3 ? [pick(groups)] : [])])].filter(
        (group) => group !== id,
      );
      if (choice < 0.3) {
        // A kind change turns a collection into a plain entry or back.
        const kind =
          next() < 0.08 ? (kinds.get(id) === "group" ? "note" : "group") : kinds.get(id)!;
        kinds.set(id, kind);
        await shared.admin.begin((tx) =>
          revise(f, id, { kind, groupIds, at: at(next() < 0.2), outcome: "published" }, tx),
        );
      } else if (choice < 0.45) {
        const outcome = next() < 0.5 ? "pending" : "rejected";
        const revision = await shared.admin.begin((tx) =>
          revise(f, id, { kind: kinds.get(id)!, groupIds, at: at(), outcome }, tx),
        );
        if (outcome === "pending") pending.set(id, revision);
      } else if (choice < 0.55 && pending.size > 0) {
        const [entry, revision] = pick([...pending.entries()]);
        pending.delete(entry);
        await decide(f, entry, revision, at(next() < 0.2));
      } else if (choice < 0.65) {
        await shared.admin`UPDATE knowledge_entries SET archived=NOT archived WHERE id=${id}`;
      } else if (choice < 0.72) {
        const owner = pick([null, f.subjectId, f.otherSubjectId]);
        await shared.admin`UPDATE knowledge_entries SET scope=${owner ? "personal" : "workspace"},
          scope_workspace_id=${owner ? null : f.workspaceId},scope_subject_id=${owner} WHERE id=${id}`;
      } else if (choice < 0.8) {
        // A further decision on the published revision changes its time.
        const [row] =
          await shared.admin`SELECT published_revision_id AS revision FROM knowledge_entries WHERE id=${id}`;
        await decide(f, id, row!.revision, at());
      } else if (choice < 0.85 && notes.length > 4) {
        const note = pick(notes);
        notes.splice(notes.indexOf(note), 1);
        pending.delete(note);
        await shared.admin`DELETE FROM knowledge_entries WHERE id=${note}`;
      } else {
        const note = await create(f, {
          kind: "note",
          title: `Added ${step}`,
          groupIds,
          at: at(next() < 0.2),
        });
        notes.push(note);
        kinds.set(note, "note");
      }
      await expectKeptMatchesRebuild(f);
      if (step % 6 === 5) await expectAllReadsMatch(f, groups);
    }
    await expectAllReadsMatch(f, groups);
  }
}, 900_000);

test("proposals keep published order while their reviewer queue walks", async () => {
  const at = clock();
  const f = await fixture();
  const root = await create(f, { kind: "group", title: "Root", at: at() });
  const sub = await create(f, { kind: "group", title: "Sub", groupIds: [root], at: at() });
  const other = await create(f, { kind: "group", title: "Other", at: at() });
  const note = await create(f, { kind: "note", title: "Deep", groupIds: [sub], at: at() });
  const before = await kept(f);
  const proposal = await shared.admin.begin((tx) =>
    revise(f, note, { kind: "note", groupIds: [other], at: at(), outcome: "pending" }, tx),
  );
  await shared.admin.begin((tx) =>
    revise(f, sub, { kind: "group", groupIds: [other], at: at(), outcome: "rejected" }, tx),
  );
  // Neither proposal is published: the kept activity does not move.
  expect(await kept(f)).toEqual(before);
  const reader = actor(f.subjectId, true);
  const library = await expectParity(f, reader, { rootOnly: true });
  expect(library.map((row) => row.revision.title)).toEqual(["Root", "Other"]);
  await expectParity(f, reader, { rootOnly: true, view: "needs_review" });
  // Approval publishes the move: Other gains the entry, Root falls back to Sub.
  await decide(f, note, proposal, at());
  await expectKeptMatchesRebuild(f);
  const moved = await expectParity(f, reader, { rootOnly: true });
  expect(moved.map((row) => row.revision.title)).toEqual(["Other", "Root"]);
  expect(moved[0]!.id).toBe(other);
}, 180_000);

test("members a reader cannot use fall back to the walk", async () => {
  const at = clock();
  const f = await fixture();
  const fileId = crypto.randomUUID();
  await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${fileId},${f.accountId},${f.workspaceId},'ready','source.txt','source.txt','text/plain',10,'fixture',${fileId})`;
  const sourceId = crypto.randomUUID();
  const sourceRevision = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,version)
      VALUES(${sourceId},${f.accountId},${f.workspaceId},'workspace',${f.workspaceId},1)`;
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
      VALUES(${sourceRevision},${f.accountId},${sourceId},1,${tx.json({
        ...body("source", "Source", []),
        source: { kind: "file", fileId },
      })},'Source','{}',${at()}::text::timestamptz)`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
      VALUES(${f.accountId},${sourceId},${sourceRevision},1,'published','{}')`;
    await tx`UPDATE knowledge_entries SET published_revision_id=${sourceRevision},latest_revision_id=${sourceRevision}
      WHERE id=${sourceId}`;
  });
  const first = await create(f, { kind: "group", title: "First", at: at() });
  const second = await create(f, { kind: "group", title: "Second", at: at() });
  await create(f, { kind: "note", title: "Older visible", groupIds: [first], at: at() });
  await create(f, { kind: "note", title: "Second's member", groupIds: [second], at: at() });
  // The newest change in First cites a source; it is private to another person next.
  const cited = await create(f, { kind: "note", title: "Newest", groupIds: [first], at: at() });
  const [revision] =
    await shared.admin`SELECT published_revision_id AS id FROM knowledge_entries WHERE id=${cited}`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${cited},${revision!.id},9,${sourceId},${sourceRevision},'evidence')`;
  const reader = actor(f.subjectId, false);
  const titles = async () =>
    (await expectParity(f, reader, { rootOnly: true, kind: "group" })).map(
      (row) => row.revision.title,
    );
  expect(await titles()).toEqual(["First", "Second"]);
  // Revoked evidence hides the newest member: First falls back to its older one.
  await shared.admin`UPDATE files SET status='pending' WHERE id=${fileId}`;
  expect(await titles()).toEqual(["Second", "First"]);
  await shared.admin`UPDATE files SET status='ready' WHERE id=${fileId}`;
  expect(await titles()).toEqual(["First", "Second"]);
  // Another person's private entry: the same for its owner and others.
  await shared.admin`UPDATE knowledge_entries SET scope='personal',scope_workspace_id=NULL,
    scope_subject_id=${f.otherSubjectId} WHERE id=${cited}`;
  expect(await titles()).toEqual(["Second", "First"]);
  const owner = await expectParity(f, actor(f.otherSubjectId, false), {
    rootOnly: true,
    kind: "group",
  });
  expect(owner.map((row) => row.revision.title)).toEqual(["First", "Second"]);
  // A scope filter that excludes the newest member also falls back.
  const scoped = await expectParity(f, actor(f.otherSubjectId, false), {
    rootOnly: true,
    scope: "workspace",
  });
  expect(scoped.map((row) => row.revision.title).filter((t) => t !== "Source")).toEqual([
    "Second",
    "First",
  ]);
  // Kept rows that no longer describe the data are never trusted.
  await shared.admin`UPDATE knowledge_collection_activity SET changed_at='2030-01-01T00:00:00Z'
    WHERE account_id=${f.accountId} AND entry_id=${first}`;
  expect(await titles()).toEqual(["Second", "First"]);
}, 180_000);

test("unbuilt organizations walk, and their next write builds them", async () => {
  const at = clock();
  const f = await fixture();
  const root = await create(f, { kind: "group", title: "Root", at: at() });
  await create(f, { kind: "note", title: "Member", groupIds: [root], at: at() });
  await shared.admin`DELETE FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId}`;
  await shared.admin`DELETE FROM knowledge_collection_activity WHERE account_id=${f.accountId}`;
  const reader = actor(f.subjectId, true);
  const [row] = await shared.admin.begin((tx) => readAll(tx, f, reader, { rootOnly: true }, 10));
  expect(row!.revision.title).toBe("Root");
  await create(f, { kind: "note", title: "Later", groupIds: [root], at: at() });
  await expectKeptMatchesRebuild(f);
  expect(await kept(f)).toHaveLength(1);

  // A write under an older snapshot cannot trust the kept rows: reads walk
  // until the next ordinary write rebuilds them.
  await shared.admin.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    await revise(f, root, { kind: "group", groupIds: [], at: at(), outcome: "published" }, tx);
  });
  expect(await states(f)).toEqual(["built", "stale"]);
  await expectParity(f, reader, { rootOnly: true });
  await create(f, { kind: "note", title: "Rebuilt", groupIds: [root], at: at() });
  await expectKeptMatchesRebuild(f);
  await expectAllReadsMatch(f, [root]);
}, 180_000);

test("a write under a snapshot older than the build leaves the organization stale", async () => {
  const at = clock();
  const f = await fixture();
  const root = await create(f, { kind: "group", title: "Root", at: at() });
  const other = await create(f, { kind: "group", title: "Other", at: at() });
  const member = await create(f, { kind: "note", title: "Member", groupIds: [root], at: at() });
  await shared.admin`DELETE FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId}`;
  await shared.admin`DELETE FROM knowledge_collection_activity WHERE account_id=${f.accountId}`;
  const older = await shared.admin.reserve();
  try {
    // The repeatable-read writer takes its snapshot while the organization is unbuilt.
    await older.unsafe("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await older`SELECT count(*) FROM knowledge_entries WHERE account_id=${f.accountId}`;
    // An ordinary write builds the organization and commits.
    await create(f, { kind: "note", title: "In Other", groupIds: [other], at: at() });
    expect(await states(f)).toEqual(["built"]);
    // The older snapshot cannot see that build; its newer change into Root
    // must still stop reads from trusting the kept times.
    await revise(
      f,
      member,
      { kind: "note", groupIds: [root], at: at(), outcome: "published" },
      older,
    );
    await older.unsafe("COMMIT");
  } finally {
    older.release();
  }
  expect(await states(f)).toEqual(["built", "stale"]);
  const reader = actor(f.subjectId, true);
  const titles = (await expectParity(f, reader, { rootOnly: true })).map(
    (row) => row.revision.title,
  );
  expect(titles).toEqual(["Root", "Other"]);
  // The next ordinary write rebuilds it.
  await create(f, { kind: "note", title: "Later", groupIds: [other], at: at() });
  await expectKeptMatchesRebuild(f);
  await expectAllReadsMatch(f, [root, other]);
}, 180_000);

test("a membership cycle forgets a change that left it", async () => {
  const at = clock();
  const f = await fixture();
  const a = await create(f, { kind: "group", title: "A", at: at() });
  const b = await create(f, { kind: "group", title: "B", groupIds: [a], at: at() });
  await shared.admin.begin((tx) =>
    revise(f, a, { kind: "group", groupIds: [b], at: at(), outcome: "published" }, tx),
  );
  const x = await create(f, { kind: "note", title: "X", groupIds: [a], at: at() });
  await expectKeptMatchesRebuild(f);
  // X was the newest change in both A and B; once archived, neither keeps it.
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${x}`;
  await expectKeptMatchesRebuild(f);
  const [stuck] =
    await shared.admin`SELECT count(*)::int AS n FROM knowledge_collection_activity WHERE account_id=${f.accountId}
      AND changed_at>=(SELECT created_at FROM knowledge_entry_revisions WHERE entry_id=${x})`;
  expect(stuck!.n).toBe(0);
  await expectAllReadsMatch(f, [a, b]);
  // A deeper cycle losing its newest member through a membership change.
  const c = await create(f, { kind: "group", title: "C", groupIds: [b], at: at() });
  const y = await create(f, { kind: "note", title: "Y", groupIds: [c], at: at() });
  await shared.admin.begin((tx) =>
    revise(f, a, { kind: "group", groupIds: [c], at: at(true), outcome: "published" }, tx),
  );
  await expectKeptMatchesRebuild(f);
  await shared.admin.begin((tx) =>
    revise(f, y, { kind: "note", groupIds: [], at: at(), outcome: "published" }, tx),
  );
  await expectKeptMatchesRebuild(f);
  await expectAllReadsMatch(f, [a, b, c]);
}, 180_000);

test("concurrent writes through the real writer keep activity exact", async () => {
  const f = await fixture();
  const client = createDb(shared.appUrl, { max: 6 });
  const context = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    actor: actor(f.subjectId, true) as KnowledgeActor,
  };
  const save = (
    entryId: string,
    expectedVersion: number,
    kind: "group" | "note",
    title: string,
    groupIds: string[],
  ) =>
    saveKnowledgeEntry(client.db, context, {
      operationId: crypto.randomUUID(),
      entryId,
      expectedVersion,
      entry: { kind, title, content: title, groupIds },
    });
  try {
    const [a, b, sub] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await save(a, 0, "group", "A", []);
    await save(b, 0, "group", "B", []);
    await save(sub, 0, "group", "Sub", [a]);
    // Members land in Sub while Sub moves from A to B and back.
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        save(crypto.randomUUID(), 0, "note", `Member ${i}`, [sub]),
      ),
      save(sub, 1, "group", "Sub", [b]).then(() => save(sub, 2, "group", "Sub", [a, b])),
    ]);
    await expectKeptMatchesRebuild(f);
    // B contains Sub, so it is at least as new as everything inside Sub.
    const [row] =
      await shared.admin`SELECT changed_at>=(SELECT changed_at FROM knowledge_collection_activity
      WHERE account_id=${f.accountId} AND entry_id=${sub}) AS newer FROM knowledge_collection_activity
      WHERE account_id=${f.accountId} AND entry_id=${b}`;
    expect(row!.newer).toBe(true);
    await expectAllReadsMatch(f, [a, b, sub]);
  } finally {
    await client.close();
  }
}, 300_000);

test("a built library answers Collections without walking members", async () => {
  const f = await fixture();
  // 12 collections, 3 sub-collections each, 8 entries in every sub-collection.
  await shared.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
    await tx`CREATE TEMP TABLE shape ON COMMIT DROP AS
      SELECT gen_random_uuid() AS id,gen_random_uuid() AS revision,r AS root,NULL::int AS sub,NULL::int AS note
      FROM generate_series(1,12) r
      UNION ALL SELECT gen_random_uuid(),gen_random_uuid(),r,s,NULL FROM generate_series(1,12) r,generate_series(1,3) s
      UNION ALL SELECT gen_random_uuid(),gen_random_uuid(),r,s,n FROM generate_series(1,12) r,generate_series(1,3) s,
        generate_series(1,8) n`;
    await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,version)
      SELECT id,${f.accountId},${f.workspaceId},'workspace',${f.workspaceId},1 FROM shape`;
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
      SELECT revision,${f.accountId},id,1,jsonb_build_object('kind',CASE WHEN note IS NULL THEN 'group' ELSE 'note' END,
        'title','Entry '||id,'content','Entry','groupIds','[]'::jsonb,'relationships','[]'::jsonb,'evidence','[]'::jsonb),
        'Entry','{}',timestamptz '2026-01-01' + (random()*1000000)*interval '1 second' FROM shape`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
      SELECT ${f.accountId},s.id,s.revision,1,'published','{}',r.created_at FROM shape s
      JOIN knowledge_entry_revisions r ON r.id=s.revision`;
    await tx`UPDATE knowledge_entries e SET published_revision_id=s.revision,latest_revision_id=s.revision
      FROM shape s WHERE e.id=s.id`;
    await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
      SELECT ${f.accountId},c.id,c.revision,0,p.id,'group' FROM shape c JOIN shape p ON p.root=c.root
        AND ((c.sub IS NOT NULL AND c.note IS NULL AND p.sub IS NULL) OR (c.note IS NOT NULL AND p.sub=c.sub AND p.note IS NULL))`;
  });
  for (const table of [
    "knowledge_entries",
    "knowledge_entry_revisions",
    "knowledge_entry_links",
    "knowledge_entry_decisions",
    "knowledge_collection_activity",
  ])
    await shared.admin.unsafe(`ANALYZE ${table}`);
  await expectKeptMatchesRebuild(f);
  const reader = actor(f.subjectId, true);
  await expectParity(f, reader, { rootOnly: true }, 20);
  const notices: string[] = [];
  const instrument = postgres(shared.adminUrl, {
    max: 1,
    onnotice: (n) => {
      if (n.message?.includes("plan:\n")) notices.push(n.message);
    },
  });
  try {
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      const measured: { walked: number; buffers: number }[] = [];
      // A read without the order key, the same read with kept activity, and with the walk.
      for (const variant of ["unordered", "kept", "walk"]) {
        notices.length = 0;
        await instrument
          .begin(async (tx) => {
            if (variant === "walk")
              await tx`DELETE FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId}`;
            await tx`LOAD 'auto_explain'`;
            await tx`SET LOCAL auto_explain.log_min_duration=0`;
            await tx`SET LOCAL auto_explain.log_analyze=true`;
            await tx`SET LOCAL auto_explain.log_buffers=true`;
            await tx`SET LOCAL auto_explain.log_nested_statements=true`;
            await tx`SET LOCAL auto_explain.log_format='json'`;
            await tx`SET LOCAL client_min_messages='log'`;
            await tx.unsafe(`SET LOCAL plan_cache_mode=${mode}`);
            const rows = await readAll(
              tx,
              f,
              reader,
              { rootOnly: true },
              20,
              variant !== "unordered",
            );
            expect(rows).toHaveLength(12);
            throw new Error("rollback");
          })
          .catch((error: Error) => {
            if (error.message !== "rollback") throw error;
          });
        const plans = notices.map((n) => JSON.parse(n.slice(n.indexOf("plan:\n") + 6)));
        const main = plans.find((p) =>
          p["Query Text"].includes("WITH candidate_rows AS MATERIALIZED"),
        );
        expect(main).toBeDefined();
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
            visit(child);
        };
        visit(main.Plan);
        const walkNode = nodes.find((node) => node["Subplan Name"] === "CTE member_rows");
        expect(walkNode).toBeDefined();
        measured.push({
          walked: Number(walkNode!["Actual Rows"]),
          buffers: Number(main.Plan["Shared Hit Blocks"]) + Number(main.Plan["Shared Read Blocks"]),
        });
      }
      const [unordered, fast, walked] = measured;
      // Kept activity: no member is walked. The walk visits all 324 below the roots.
      expect(unordered!.walked).toBe(0);
      expect(fast!.walked).toBe(0);
      expect(walked!.walked).toBeGreaterThanOrEqual(324);
      // Relative budgets: ordering costs about what the unordered read costs,
      // and clearly less than walking the members.
      expect(fast!.buffers).toBeLessThanOrEqual(unordered!.buffers * 1.3);
      expect(fast!.buffers).toBeLessThan(walked!.buffers * 0.75);
    }
  } finally {
    await instrument.end();
  }
  // One statement changing many members keeps activity exact too.
  await shared.admin`UPDATE knowledge_entries e SET archived=true FROM knowledge_entry_revisions r
    WHERE e.account_id=${f.accountId} AND r.id=e.published_revision_id AND r.body->>'kind'='note'
      AND get_byte(uuid_send(e.id),15)%3=0`;
  await expectKeptMatchesRebuild(f);
  await expectParity(f, reader, { rootOnly: true }, 5);
  await shared.admin`UPDATE knowledge_entries SET archived=false WHERE account_id=${f.accountId} AND archived`;
  await expectKeptMatchesRebuild(f);
  await expectParity(f, reader, { kind: "group" }, 10);
}, 300_000);

test("organization removal and security metadata", async () => {
  const at = clock();
  const f = await fixture();
  const root = await create(f, { kind: "group", title: "Root", at: at() });
  const note = await create(f, { kind: "note", title: "Member", groupIds: [root], at: at() });
  await shared.admin`DELETE FROM knowledge_entries WHERE id=${note}`;
  await expectKeptMatchesRebuild(f);
  expect(await kept(f)).toEqual([]);
  await create(f, { kind: "note", title: "Member", groupIds: [root], at: at() });
  // Membership links check their target at commit, as for any organization removal.
  await shared.admin.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM managed_accounts WHERE id=${f.accountId}`;
  });
  const [left] = await shared.admin`SELECT
    (SELECT count(*)::int FROM knowledge_collection_activity WHERE account_id=${f.accountId}) AS activity,
    (SELECT count(*)::int FROM knowledge_collection_activity_accounts WHERE account_id=${f.accountId}) AS built`;
  expect(left).toEqual({ activity: 0, built: 0 });

  const tables = await shared.admin`SELECT relname,relrowsecurity,relforcerowsecurity,
    has_table_privilege(${appRole},oid,'SELECT') AS readable,has_table_privilege(${appRole},oid,'INSERT') AS writable
    FROM pg_class WHERE relname IN ('knowledge_collection_activity','knowledge_collection_activity_accounts')
    AND relnamespace=current_schema()::regnamespace ORDER BY relname`;
  expect(tables.map((row) => ({ ...row }))).toEqual([
    {
      relname: "knowledge_collection_activity",
      relrowsecurity: true,
      relforcerowsecurity: true,
      readable: false,
      writable: false,
    },
    {
      relname: "knowledge_collection_activity_accounts",
      relrowsecurity: true,
      relforcerowsecurity: true,
      readable: false,
      writable: false,
    },
  ]);
  const routines =
    await shared.admin`SELECT p.proname,p.prosecdef,has_function_privilege(${appRole},p.oid,'EXECUTE') AS callable,
    pg_get_userbyid(p.proowner)=(SELECT pg_get_userbyid(proowner) FROM pg_proc
      WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure) AS same_owner,
    array_to_string(p.proconfig,',') LIKE 'search_path=%' AS pinned
    FROM pg_proc p WHERE p.proname LIKE 'knowledge_collection_activity_%' ORDER BY p.proname`;
  expect(routines.map((row) => ({ ...row }))).toEqual(
    ["entries_changed", "members_changed", "rebuild", "refresh"].map((name) => ({
      proname: `knowledge_collection_activity_${name}`,
      // Triggers run as the writer; only the maintainers act as the owner.
      prosecdef: !name.endsWith("_changed"),
      callable: false,
      same_owner: true,
      pinned: true,
    })),
  );
}, 180_000);

/** Plans of every statement run by `work`, nested ones included, with buffers. */
async function explained(work: (tx: postgres.TransactionSql) => Promise<unknown>) {
  const notices: string[] = [];
  const instrument = postgres(shared.adminUrl, {
    max: 1,
    onnotice: (n) => {
      if (n.message?.includes("plan:\n")) notices.push(n.message);
    },
  });
  try {
    await instrument
      .begin(async (tx) => {
        await tx`LOAD 'auto_explain'`;
        await tx`SET LOCAL auto_explain.log_min_duration=0`;
        await tx`SET LOCAL auto_explain.log_analyze=true`;
        await tx`SET LOCAL auto_explain.log_buffers=true`;
        await tx`SET LOCAL auto_explain.log_nested_statements=true`;
        await tx`SET LOCAL auto_explain.log_format='json'`;
        await tx`SET LOCAL client_min_messages='log'`;
        await work(tx);
        throw new Error("rollback");
      })
      .catch((error: Error) => {
        if (error.message !== "rollback") throw error;
      });
  } finally {
    await instrument.end();
  }
  return notices.map(
    (n) =>
      JSON.parse(n.slice(n.indexOf("plan:\n") + 6)) as {
        "Query Text": string;
        Plan: Record<string, unknown>;
      },
  );
}
const buffers = (plan: { Plan: Record<string, unknown> }) =>
  Number(plan.Plan["Shared Hit Blocks"]) + Number(plan.Plan["Shared Read Blocks"]);
/** Buffers of the activity maintenance a write's triggers ran, after `SELECT 'measure'`. */
function maintenance(
  plans: { "Query Text": string; Plan: Record<string, unknown> }[],
  write: string,
) {
  const end = plans.findIndex((p) => p["Query Text"].trimStart().startsWith(write));
  const start = plans.findIndex((p) => p["Query Text"].includes("SELECT 'measure'"));
  const calls = plans
    .slice(start, end)
    .filter((p) =>
      p["Query Text"].trimStart().startsWith("SELECT knowledge_collection_activity_refresh"),
    );
  expect(start >= 0 && end > start && calls.length > 0).toBe(true);
  return calls.reduce((sum, plan) => sum + buffers(plan), 0);
}

/** Collections in one statement: `parents[i]` is the parent of collection i. */
async function bulkLibrary(
  tx: postgres.TransactionSql,
  f: Fixture,
  parents: (number | null)[],
  notesEach: number[],
) {
  await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
  await tx`CREATE TEMP TABLE shape ON COMMIT DROP AS
    WITH c AS (SELECT i-1 AS i,p.parent,gen_random_uuid() AS id,gen_random_uuid() AS revision
      FROM unnest(${parents}::int[],${notesEach}::int[]) WITH ORDINALITY AS p(parent,notes,i))
    SELECT c.id,c.revision,'group' AS kind,c.i,c.parent FROM c
    UNION ALL SELECT gen_random_uuid(),gen_random_uuid(),'note',NULL,c.i FROM c,
      generate_series(1,(${notesEach}::int[])[c.i+1]) n`;
  await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id,version)
    SELECT id,${f.accountId},${f.workspaceId},'workspace',${f.workspaceId},1 FROM shape`;
  await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor,created_at)
    SELECT revision,${f.accountId},id,1,jsonb_build_object('kind',kind,'title','Entry '||id,'content','Entry',
      'groupIds','[]'::jsonb,'relationships','[]'::jsonb,'evidence','[]'::jsonb),
      'Entry','{}',timestamptz '2026-01-01' + (random()*1000000)*interval '1 second' FROM shape`;
  await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor,created_at)
    SELECT ${f.accountId},s.id,s.revision,1,'published','{}',r.created_at FROM shape s
    JOIN knowledge_entry_revisions r ON r.id=s.revision`;
  await tx`UPDATE knowledge_entries e SET published_revision_id=s.revision,latest_revision_id=s.revision
    FROM shape s WHERE e.id=s.id`;
  await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
    SELECT ${f.accountId},c.id,c.revision,0,p.id,'group' FROM shape c
    JOIN shape p ON p.kind='group' AND p.i=c.parent`;
}

test("maintenance and reads stay keyed for an organization new to the table statistics", async () => {
  const f = await fixture();
  const reader = actor(f.subjectId, true);
  // Statistics that do not know this organization: it looks like one row.
  for (const table of [
    "knowledge_entries",
    "knowledge_entry_revisions",
    "knowledge_entry_links",
    "knowledge_entry_decisions",
  ])
    await shared.admin.unsafe(`ANALYZE ${table}`);
  // 120 top-level collections with 10 entries each, loaded in one transaction.
  const parents = Array.from({ length: 120 }, () => null);
  const plans = await explained(async (tx) => {
    await bulkLibrary(
      tx,
      f,
      parents,
      parents.map(() => 10),
    );
    await tx`SELECT knowledge_collection_activity_rebuild(${f.accountId})`;
    // Archive the newest entry: its collection is recomputed from its members.
    const [newest] = await tx`SELECT e.id FROM knowledge_entries e
      JOIN knowledge_entry_revisions r ON r.id=e.published_revision_id
      WHERE e.account_id=${f.accountId} AND r.body->>'kind'='note' ORDER BY r.created_at DESC LIMIT 1`;
    await tx`SELECT 'measure'`;
    await tx`UPDATE knowledge_entries SET archived=true WHERE id=${newest!.id}`;
    expect(await readAll(tx, f, reader, { rootOnly: true }, 50)).toHaveLength(120);
    expect(await readAll(tx, f, reader, { rootOnly: true }, 50, false)).toHaveLength(120);
  });
  const top = (text: string) => plans.find((p) => p["Query Text"].trimStart().startsWith(text));
  const rebuild = top("SELECT knowledge_collection_activity_rebuild");
  const write = maintenance(plans, "UPDATE knowledge_entries SET archived=true WHERE id=");
  const reads = plans.filter((p) =>
    p["Query Text"].includes("WITH candidate_rows AS MATERIALIZED"),
  );
  expect(rebuild).toBeTruthy();
  // Three pages ordered by activity, then the same three pages unordered.
  expect(reads).toHaveLength(6);
  const ordered = reads.slice(0, 3).reduce((sum, plan) => sum + buffers(plan), 0);
  const unordered = reads.slice(3).reduce((sum, plan) => sum + buffers(plan), 0);
  // 1,320 entries: the rebuild reads each a few times, not once per collection.
  expect(buffers(rebuild!)).toBeLessThan(1_320 * 10);
  // Its whole-organization joins never become per-row scans, whatever the estimates.
  const [config] = await shared.admin`SELECT proconfig FROM pg_proc
    WHERE oid='knowledge_collection_activity_rebuild(uuid)'::regprocedure`;
  expect(config!.proconfig).toContain("enable_nestloop=off");
  // One archived entry touches its collection's members, not the organization.
  expect(write).toBeLessThan(2_000);
  // Ordering costs about what the unordered list costs.
  expect(ordered).toBeLessThan(unordered * 1.2);
}, 300_000);

test("a deep chain of collections forgets a change in one pass", async () => {
  const f = await fixture();
  // 150 nested collections, entries in the deepest one.
  const parents = Array.from({ length: 150 }, (_, i) => (i === 0 ? null : i - 1));
  await shared.admin.begin((tx) =>
    bulkLibrary(
      tx,
      f,
      parents,
      parents.map((_, i) => (i === 149 ? 20 : 0)),
    ),
  );
  await shared.admin.begin(async (tx) => {
    await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
    await tx`SELECT knowledge_collection_activity_rebuild(${f.accountId})`;
  });
  await expectKeptMatchesRebuild(f);
  const [newest] = await shared.admin`SELECT e.id FROM knowledge_entries e
    JOIN knowledge_entry_revisions r ON r.id=e.published_revision_id
    WHERE e.account_id=${f.accountId} AND r.body->>'kind'='note' ORDER BY r.created_at DESC LIMIT 1`;
  const plans = await explained(async (tx) => {
    await tx`SELECT 'measure'`;
    await tx`UPDATE knowledge_entries SET archived=true WHERE id=${newest!.id}`;
  });
  const write = maintenance(plans, "UPDATE knowledge_entries");
  // Recomputed nearest first, the cost grows with the depth, not its square
  // (a round per level read about 350,000 buffers here).
  expect(write).toBeLessThan(150 * 300);
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${newest!.id}`;
  await expectKeptMatchesRebuild(f);
  await expectParity(f, actor(f.subjectId, true), { kind: "group" }, 50);
}, 300_000);
