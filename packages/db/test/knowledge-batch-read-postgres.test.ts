import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getKnowledgeEntries,
  getKnowledgeEntry,
  initializeSessionStartAtomically,
  nestedPostgresSqlState,
  saveAgentLearningSettings,
  saveKnowledgeEntry,
  withSessionRlsActorContext,
  type DbClient,
  type KnowledgeContext,
} from "../src";
import { seedListingFixture, type ListingFixture } from "./fixtures/knowledge-collection-listing";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("knowledge-current-batch");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl, { searchPath: shared.schema, max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
function context(f: ListingFixture): KnowledgeContext {
  return {
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
  };
}
async function parity(
  ctx: KnowledgeContext,
  ids: string[],
  view: "published" | "needs_review" | "archived" | "rejected" = "published",
) {
  const batch = await getKnowledgeEntries(client.db, ctx, ids, { view });
  expect(batch).toEqual(
    await Promise.all(ids.map((id) => getKnowledgeEntry(client.db, ctx, id, { view }))),
  );
  return batch;
}

async function denied(work: Promise<unknown>) {
  let state: string | null | undefined;
  try {
    await work;
  } catch (error) {
    state = nestedPostgresSqlState(error);
  }
  expect(state).toBe("42501");
}

test("current batch preserves ordered nulls, duplicates, tenant/private scope, source status and evidence revocation", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  const other = await seedListingFixture(shared.admin, 0);
  const members = await shared.admin<{ id: string }[]>`SELECT id FROM knowledge_entries
    WHERE account_id=${f.accountId} AND id NOT IN (${f.groupId},${f.sourceId}) ORDER BY id`;
  const personalId = members[0]!.id;
  await shared.admin`UPDATE knowledge_entries SET scope='personal',scope_workspace_id=NULL,
    scope_subject_id=${f.subjectId} WHERE id=${personalId}`;
  const ids = [f.sourceId, personalId, other.groupId, crypto.randomUUID(), f.groupId, f.sourceId];
  const records = await parity(context(f), ids);
  expect(records.map((entry) => entry?.id ?? null)).toEqual([
    f.sourceId,
    personalId,
    null,
    null,
    f.groupId,
    f.sourceId,
  ]);
  expect(records[0]?.indexStatus).toBeDefined();
  const viewer = context(f);
  if (viewer.actor.kind !== "human") throw new Error("Human fixture required");
  viewer.actor.subjectId = "user:other";
  expect((await parity(viewer, ids))[1]).toBeNull();
  const wrongWorkspace = { ...context(f), workspaceId: other.workspaceId };
  await denied(getKnowledgeEntries(client.db, wrongWorkspace, ids));
  const dependencies = await shared.admin<{ entry_id: string }[]>`SELECT DISTINCT entry_id
    FROM knowledge_entry_links WHERE account_id=${f.accountId} AND target_entry_id=${f.sourceId} AND relation='evidence'`;
  const dependentIds = dependencies.map((row) => row.entry_id);
  expect((await parity(context(f), dependentIds)).every((entry) => entry !== null)).toBe(true);
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.sourceId}`;
  expect(await parity(context(f), dependentIds)).toEqual(dependentIds.map(() => null));
  expect((await parity(context(f), [f.sourceId], "archived"))[0]?.archived).toBe(true);
}, 180_000);

test("batch rechecks the current view and refuses review or stale-attempt authority", async () => {
  const f = await seedListingFixture(shared.admin, 0);
  const ctx = context(f);
  const original = await getKnowledgeEntry(client.db, ctx, f.groupId);
  const revisionId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,preview,actor)
      SELECT ${revisionId},account_id,entry_id,2,jsonb_set(body,'{title}','"Proposed name"'),preview,actor
      FROM knowledge_entry_revisions WHERE id=${original!.revision.id}`;
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
      VALUES(${f.accountId},${f.groupId},${revisionId},2,'pending','{}')`;
    await tx`UPDATE knowledge_entries SET version=2,latest_revision_id=${revisionId} WHERE id=${f.groupId}`;
  });
  expect((await parity(ctx, [f.groupId]))[0]?.revision.id).toBe(original!.revision.id);
  const pending = (await parity(ctx, [f.groupId], "needs_review"))[0]!;
  expect(pending.revision.id).toBe(revisionId);
  expect(pending.revision.outcome).toBe("pending");
  expect(pending.revision.entry.title).toBe("Proposed name");
  await shared.admin.begin(async (tx) => {
    await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
      VALUES(${f.accountId},${f.groupId},${revisionId},3,'published','{}')`;
    await tx`UPDATE knowledge_entries SET version=3,published_revision_id=${revisionId} WHERE id=${f.groupId}`;
  });
  expect((await parity(ctx, [f.groupId]))[0]?.revision.id).toBe(revisionId);
  expect(await parity(ctx, [f.groupId], "needs_review")).toEqual([null]);
  expect(
    (await getKnowledgeEntry(client.db, ctx, f.groupId, { revisionId: original!.revision.id }))
      ?.revision.id,
  ).toBe(original!.revision.id);
  if (ctx.actor.kind !== "human") throw new Error("Human fixture required");
  const reader = { ...ctx, actor: { ...ctx.actor, review: false } };
  await denied(getKnowledgeEntries(client.db, reader, [f.groupId], { view: "needs_review" }));
  const agent: KnowledgeContext = {
    ...ctx,
    actor: {
      kind: "agent",
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
    },
  };
  await denied(getKnowledgeEntries(client.db, agent, [f.groupId]));
  expect(await getKnowledgeEntries(client.db, ctx, [])).toEqual([]);
  await expect(
    getKnowledgeEntries(
      client.db,
      ctx,
      Array.from({ length: 51 }, () => f.groupId),
    ),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(getKnowledgeEntries(client.db, ctx, ["invalid"])).rejects.toMatchObject({
    name: "ZodError",
  });
}, 180_000);

test("batch retains accepted agent learning and rejects a closed attempt", async () => {
  const f = await seedListingFixture(shared.admin, 0);
  const session = await withSessionRlsActorContext({ subjectId: f.subjectId }, () =>
    createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "Prepare Knowledge",
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
  await saveAgentLearningSettings(client.db, context(f), {
    scope: "workspace",
    source: { kind: "chat", id: session.id },
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    settings: { knowledge: "review_first" },
  });
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
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed")
    throw new Error(`Expected claimed attempt, got ${claimed.action}`);
  const agent: KnowledgeContext = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    actor: {
      kind: "agent",
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    },
  };
  const pending = await saveKnowledgeEntry(client.db, agent, {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    entry: { kind: "group", title: "Proposed collection", content: "Proposed description" },
  });
  expect(pending.outcome).toBe("pending");
  expect(
    (await parity(agent, [pending.entryId, f.groupId])).map((entry) => entry?.id ?? null),
  ).toEqual([null, f.groupId]);
  expect(
    (await parity(agent, [pending.entryId, f.groupId], "needs_review")).map(
      (entry) => entry?.id ?? null,
    ),
  ).toEqual([pending.entryId, null]);
  const settled = await applySessionTurnSettlement(client.db, f.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  expect(settled.action).toBe("settled");
  await denied(getKnowledgeEntries(client.db, agent, [f.groupId, pending.entryId]));
}, 180_000);
