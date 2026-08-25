import { afterAll, expect, mock, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "user:document-default-list";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";
const fakeDb = {};
const listInputs: unknown[] = [];
const reclassificationInputs: unknown[] = [];
const reclassificationListInputs: unknown[] = [];
const backfillInputs: unknown[] = [];
const defaultBase = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: WORKSPACE_ID,
  name: "Default",
  description: "Default base for dropped files and notes.",
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
};

const realDocuments = await import("@opengeni/documents");
const realListDocumentBasesEnsuringDefault = realDocuments.listDocumentBasesEnsuringDefault;
const authorityReceipt = {
  operationId: "55555555-5555-4555-8555-555555555555",
  documentId: DOCUMENT_ID,
  previousAuthority: {
    kind: "workspace" as const,
    workspaceId: WORKSPACE_ID,
    subjectId: null,
    authorityId: null,
  },
  authority: {
    kind: "organization" as const,
    workspaceId: null,
    subjectId: null,
    authorityId: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};
const backfillResult = {
  runId: "66666666-6666-4666-8666-666666666666",
  operationId: "77777777-7777-4777-8777-777777777777",
  status: "completed" as const,
  lastWorkspaceId: WORKSPACE_ID,
  processedCount: 1,
  createdCount: 1,
  adoptedCount: 0,
  completedAt: "2026-08-24T12:00:00.000Z",
};
mock.module("@opengeni/documents", () => ({
  ...realDocuments,
  listDocumentBasesEnsuringDefault: mock(
    async (...args: Parameters<typeof realListDocumentBasesEnsuringDefault>) => {
      if (args[0] !== fakeDb) {
        return await realListDocumentBasesEnsuringDefault(...args);
      }
      listInputs.push(args[1]);
      return [defaultBase];
    },
  ),
  getDocument: mock(async (...args: Parameters<typeof realDocuments.getDocument>) => {
    if (args[0] !== fakeDb) {
      return await realDocuments.getDocument(...args);
    }
    return { id: DOCUMENT_ID, authorityKind: "workspace" };
  }),
  reclassifyDocumentAuthority: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb)
      return await realDocuments.reclassifyDocumentAuthority(db as never, input as never);
    reclassificationInputs.push(input);
    return authorityReceipt;
  }),
  listDocumentAuthorityReclassifications: mock(async (db: unknown, input: unknown) => {
    if (db === fakeDb) reclassificationListInputs.push(input);
    return db === fakeDb
      ? { receipts: [authorityReceipt], hasMore: false, nextCursor: null }
      : { receipts: [], hasMore: false, nextCursor: null };
  }),
  runDocumentDefaultCollectionBackfill: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realDocuments.runDocumentDefaultCollectionBackfill(db as never, input as never);
    }
    backfillInputs.push(input);
    return backfillResult;
  }),
}));

const { createApp } = await import("../src/app");

afterAll(() => {
  mock.restore();
});

async function bearer(permissions: Permission[]): Promise<string> {
  const settings = testSettings({ productAccessMode: "managed" });
  return `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

test("uses the metadata-only document fence before subject-bound indexing", async () => {
  const source = await readFile(new URL("../src/app.ts", import.meta.url), "utf8");
  const start = source.indexOf("const documentIndexer = deps.documentIndexer");
  const indexer = source.slice(start, source.indexOf("// The API process's own", start));
  expect(indexer).toContain("getDocumentForIndexing(deps.db, workspaceId, documentId)");
  expect(indexer).not.toContain("getDocument(deps.db");
  expect(indexer.indexOf("getDocumentForIndexing")).toBeLessThan(
    indexer.indexOf("const document = await indexDocumentNow"),
  );
});

test("listing document collections provisions Default with a search-only grant", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    permissions: ["documents:search"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
  const app = createApp({
    settings,
    db: fakeDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });

  const response = await app.request(`/v1/workspaces/${WORKSPACE_ID}/document-bases`, {
    headers: { authorization },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([defaultBase]);
  expect(listInputs).toEqual([{ accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID }]);
});

test("requires exact account administration for organization reclassification and backfill", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const app = createApp({
    settings,
    db: fakeDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const reclassificationBody = {
    operationId: authorityReceipt.operationId,
    expectedAuthority: authorityReceipt.previousAuthority,
    targetAuthorityKind: "organization",
  };
  const deniedReclassification = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/authority-reclassifications`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(["documents:manage"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(reclassificationBody),
    },
  );
  expect(deniedReclassification.status).toBe(403);

  const acceptedReclassification = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/authority-reclassifications`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(["documents:manage", "account:admin"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(reclassificationBody),
    },
  );
  expect(acceptedReclassification.status).toBe(200);
  expect(await acceptedReclassification.json()).toEqual(authorityReceipt);
  expect(reclassificationInputs).toEqual([
    {
      ...reclassificationBody,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      actorSubjectId: SUBJECT_ID,
      accountAdminAuthorization: {
        authorizationId: expect.any(String),
        accountId: ACCOUNT_ID,
        actorSubjectId: SUBJECT_ID,
        permission: "account:admin",
      },
    },
  ]);

  const receiptPage = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/authority-reclassifications?limit=1`,
    { headers: { authorization: await bearer(["documents:manage"]) } },
  );
  expect(receiptPage.status).toBe(200);
  expect(await receiptPage.json()).toEqual({
    receipts: [authorityReceipt],
    hasMore: false,
    nextCursor: null,
  });
  expect(reclassificationListInputs).toEqual([
    {
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      actorSubjectId: SUBJECT_ID,
      limit: 1,
    },
  ]);

  const backfillBody = {
    runId: backfillResult.runId,
    operationId: backfillResult.operationId,
    batchSize: 25,
  };
  const deniedBackfill = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(["documents:manage"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(backfillBody),
    },
  );
  expect(deniedBackfill.status).toBe(403);

  const acceptedBackfill = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(["documents:manage", "account:admin"]),
        "content-type": "application/json",
      },
      body: JSON.stringify(backfillBody),
    },
  );
  expect(acceptedBackfill.status).toBe(200);
  expect(await acceptedBackfill.json()).toEqual(backfillResult);
  expect(backfillInputs).toEqual([
    {
      ...backfillBody,
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      actorSubjectId: SUBJECT_ID,
      accountAdminAuthorization: {
        authorizationId: expect.any(String),
        accountId: ACCOUNT_ID,
        actorSubjectId: SUBJECT_ID,
        permission: "account:admin",
      },
    },
  ]);
});
