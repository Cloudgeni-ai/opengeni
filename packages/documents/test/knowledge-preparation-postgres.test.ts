import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  getKnowledgeEntry,
  withCreditDebitAttribution,
  type KnowledgeContext,
} from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { addDocumentToBase, indexDocumentNow, type DocumentServices } from "../src";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("document-canonical-preparation");
  if (!acquired) throw new Error("Document preparation verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
test("the document adapter retains exact parsed source without hidden findings or a second embedding write", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    fileId = crypto.randomUUID(),
    baseId = crypto.randomUUID(),
    documentId = crypto.randomUUID();
  const bytes = new TextEncoder().encode("Contract source bytes");
  const exact = "Acme agreement  🚀\u0000\n\nRenewal: 1 December.  ";
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Preparation test')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Sources')`;
  await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${fileId},${accountId},${workspaceId},'ready','Acme.pdf','Acme.pdf','application/pdf',${bytes.length},'test',${fileId})`;
  await shared.admin`INSERT INTO document_bases(id,account_id,workspace_id,name) VALUES(${baseId},${accountId},${workspaceId},'Customer contracts')`;
  await shared.admin`INSERT INTO documents(id,account_id,workspace_id,origin_workspace_id,base_id,file_id,status,title,curation_status,
    authority_kind,authority_workspace_id) VALUES(${documentId},${accountId},${workspaceId},${workspaceId},${baseId},${fileId},
    'queued','Acme contract','pending','workspace',${workspaceId})`;
  let parsed = 0;
  const services = {
    parser: {
      name: "test-parser",
      parse: async (input: Uint8Array) => {
        expect(input).toEqual(bytes);
        parsed++;
        return { text: exact };
      },
    },
    chunker: {
      chunk: () => {
        throw new Error("Old chunk storage must not be used");
      },
    },
    embedder: {
      embedMany: () => {
        throw new Error("Embeddings belong to the canonical projection worker");
      },
    },
    curator: {
      curate: () => {
        throw new Error("Mechanical preparation must not create findings");
      },
    },
  } as unknown as DocumentServices;
  const storage = { getObjectBytes: async () => ({ bytes }) } as unknown as ObjectStorage;
  const document = await indexDocumentNow(client.db, storage, workspaceId, documentId, services);
  expect(document.status).toBe("ready");
  expect(document.curationStatus).toBe("none");
  expect(parsed).toBe(1);
  const [row] =
    await shared.admin`SELECT id,version FROM knowledge_entries WHERE legacy_document_id=${documentId}`;
  expect(row?.version).toBe(1);
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:reader",
      writeScopes: [],
      settingsScopes: [],
      review: false,
    },
  };
  const entry = await getKnowledgeEntry(client.db, context, row!.id);
  expect(entry?.revision.entry.content).toBe(exact);
  expect(entry?.revision.entry.kind).toBe("source");
  expect(entry?.revision.entry.evidence).toEqual([]);
  const retry = await indexDocumentNow(client.db, storage, workspaceId, documentId, services);
  expect(retry.status).toBe("ready");
  const [counts] =
    await shared.admin`SELECT (SELECT count(*)::int FROM knowledge_entry_revisions WHERE entry_id=${row!.id}) AS revisions,
    (SELECT count(*)::int FROM document_chunks WHERE document_id=${documentId}) AS chunks`;
  expect(counts).toEqual({ revisions: 1, chunks: 0 });
  const [legacyJob] = await shared.admin`
    SELECT billing_attribution FROM knowledge_index_jobs WHERE entry_id=${row!.id}`;
  expect(legacyJob?.billing_attribution).toEqual({ kind: "unknown" });
});

test("new direct uploads freeze verified human before async source preparation", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const baseId = crypto.randomUUID();
  const subjectId = "human:upload-initiator";
  const bytes = new TextEncoder().encode("Upload source");
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Upload attribution')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Upload workspace')`;
  await shared.admin`INSERT INTO files(id,account_id,workspace_id,status,filename,safe_filename,content_type,size_bytes,bucket,object_key)
    VALUES(${fileId},${accountId},${workspaceId},'ready','Upload.txt','Upload.txt','text/plain',${bytes.length},'test',${fileId})`;
  await shared.admin`INSERT INTO document_bases(id,account_id,workspace_id,name)
    VALUES(${baseId},${accountId},${workspaceId},'Uploads')`;
  const document = await withCreditDebitAttribution(
    { kind: "human", initiatingHumanSubjectId: subjectId },
    () =>
      addDocumentToBase(client.db, {
        accountId,
        workspaceId,
        baseId,
        fileId,
        authorityKind: "workspace",
        createdBy: subjectId,
        initiatingSubjectId: subjectId,
        access: { viewerSubjectId: subjectId },
      }),
  );
  const services = {
    parser: { name: "test", parse: async () => ({ text: "Upload source" }) },
  } as unknown as DocumentServices;
  const storage = { getObjectBytes: async () => ({ bytes }) } as unknown as ObjectStorage;
  // No initiating actor is ambient when the asynchronous worker runs.
  await indexDocumentNow(client.db, storage, workspaceId, document.id, services);
  const [job] = await shared.admin`
    SELECT j.billing_attribution FROM knowledge_index_jobs j
    JOIN knowledge_entries e ON e.id=j.entry_id AND e.account_id=j.account_id
    WHERE e.legacy_document_id=${document.id}`;
  expect(job?.billing_attribution).toEqual({
    kind: "human",
    initiatingHumanSubjectId: subjectId,
  });
  await expect(
    shared.admin`UPDATE documents SET billing_attribution='{"kind":"service"}'::jsonb
      WHERE id=${document.id}`.then((rows) => rows),
  ).rejects.toMatchObject({ code: "23514" });
});
