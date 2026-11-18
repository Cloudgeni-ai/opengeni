import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  listKnowledgeEntryHistory,
  saveKnowledgeEntry,
  type KnowledgeContext,
} from "../src";

/* A Knowledge entry's history says "You" for the versions you saved
   (migration 1498): it lists them by id, only for the person asking, and
   never names anyone else. */

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-history-authors");
  if (!acquired) throw new Error("Knowledge history verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function person(accountId: string, workspaceId: string, subjectId: string): KnowledgeContext {
  return {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
}

test("each person's history lists only the versions they saved", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Knowledge history')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'History workspace')`;
  await shared.admin`INSERT INTO workspace_inference_controls(workspace_id,account_id) VALUES(${workspaceId},${accountId})`;
  const maria = person(accountId, workspaceId, `user:${crypto.randomUUID()}`);
  const bendik = person(accountId, workspaceId, `user:${crypto.randomUUID()}`);

  const created = await saveKnowledgeEntry(client.db, maria, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Weekly sync", content: "Mondays at 10." },
  });
  const edited = await saveKnowledgeEntry(client.db, bendik, {
    operationId: crypto.randomUUID(),
    entryId: created.entryId,
    expectedVersion: created.version,
    entry: { kind: "fact", title: "Weekly sync", content: "Mondays at 11." },
  });

  const forMaria = await listKnowledgeEntryHistory(client.db, maria, created.entryId);
  expect(forMaria.entries.map((entry) => entry.revision.id)).toEqual([
    edited.revisionId,
    created.revisionId,
  ]);
  expect(forMaria.savedByYou).toEqual([created.revisionId]);
  expect((await listKnowledgeEntryHistory(client.db, bendik, created.entryId)).savedByYou).toEqual([
    edited.revisionId,
  ]);
  const someoneElse = person(accountId, workspaceId, `user:${crypto.randomUUID()}`);
  expect(
    (await listKnowledgeEntryHistory(client.db, someoneElse, created.entryId)).savedByYou,
  ).toEqual([]);
}, 120_000);
