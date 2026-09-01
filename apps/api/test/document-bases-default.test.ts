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
const backfillRunListInputs: unknown[] = [];
const backfillAuditInputs: unknown[] = [];
const organizationReclassificationInputs: unknown[] = [];
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
const realGetDocument = realDocuments.getDocument;
const realReclassifyDocumentAuthority = realDocuments.reclassifyDocumentAuthority;
const realListDocumentAuthorityReclassifications =
  realDocuments.listDocumentAuthorityReclassifications;
const realRunDocumentDefaultCollectionBackfill = realDocuments.runDocumentDefaultCollectionBackfill;
const realListDocumentDefaultCollectionBackfillRuns =
  realDocuments.listDocumentDefaultCollectionBackfillRuns;
const realGetDocumentDefaultCollectionBackfillAudit =
  realDocuments.getDocumentDefaultCollectionBackfillAudit;
const realListOrganizationDocumentAuthorityReclassifications =
  realDocuments.listOrganizationDocumentAuthorityReclassifications;
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
const backfillRunAudit = {
  runId: backfillResult.runId,
  actorSubjectId: SUBJECT_ID,
  status: backfillResult.status,
  lastWorkspaceId: backfillResult.lastWorkspaceId,
  processedCount: backfillResult.processedCount,
  createdCount: backfillResult.createdCount,
  adoptedCount: backfillResult.adoptedCount,
  startedAt: "2026-08-24T11:59:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
  completedAt: backfillResult.completedAt,
};
const backfillAudit = {
  run: backfillRunAudit,
  operations: [
    {
      operationId: backfillResult.operationId,
      result: backfillResult,
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  ],
  receipts: [
    {
      workspaceId: WORKSPACE_ID,
      baseId: defaultBase.id,
      outcome: "created" as const,
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  ],
  operationsHasMore: false,
  operationsNextCursor: null,
  receiptsHasMore: false,
  receiptsNextCursor: null,
};
const organizationAuthorityReceipt = {
  ...authorityReceipt,
  actorSubjectId: "user:other-document-admin",
  requestWorkspaceId: WORKSPACE_ID,
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
      return await realGetDocument(...args);
    }
    return { id: DOCUMENT_ID, authorityKind: "workspace" };
  }),
  reclassifyDocumentAuthority: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) return await realReclassifyDocumentAuthority(db as never, input as never);
    reclassificationInputs.push(input);
    return authorityReceipt;
  }),
  listDocumentAuthorityReclassifications: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realListDocumentAuthorityReclassifications(db as never, input as never);
    }
    reclassificationListInputs.push(input);
    return { receipts: [authorityReceipt], hasMore: false, nextCursor: null };
  }),
  runDocumentDefaultCollectionBackfill: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realRunDocumentDefaultCollectionBackfill(db as never, input as never);
    }
    backfillInputs.push(input);
    return backfillResult;
  }),
  listDocumentDefaultCollectionBackfillRuns: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realListDocumentDefaultCollectionBackfillRuns(db as never, input as never);
    }
    backfillRunListInputs.push(input);
    if ((input as { cursor?: string }).cursor === "domain-error") {
      throw new Error("Failed query: SELECT audit", {
        cause: new Error("invalid document migration audit cursor"),
      });
    }
    return { runs: [backfillRunAudit], hasMore: false, nextCursor: null };
  }),
  getDocumentDefaultCollectionBackfillAudit: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realGetDocumentDefaultCollectionBackfillAudit(db as never, input as never);
    }
    backfillAuditInputs.push(input);
    if ((input as { runId: string }).runId === "99999999-9999-4999-8999-999999999999") {
      throw new Error("document Default collection backfill audit run is unavailable");
    }
    return backfillAudit;
  }),
  listOrganizationDocumentAuthorityReclassifications: mock(async (db: unknown, input: unknown) => {
    if (db !== fakeDb) {
      return await realListOrganizationDocumentAuthorityReclassifications(
        db as never,
        input as never,
      );
    }
    organizationReclassificationInputs.push(input);
    return {
      receipts: [organizationAuthorityReceipt],
      hasMore: false,
      nextCursor: null,
    };
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

test("requires account administration and exposes typed migration audit pages", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const app = createApp({
    settings,
    db: fakeDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const denied = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills`,
    { headers: { authorization: await bearer(["documents:manage"]) } },
  );
  expect(denied.status).toBe(403);

  const adminAuthorization = await bearer(["documents:manage", "account:admin"]);
  const runList = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills?limit=1&cursor=run-cursor`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(runList.status).toBe(200);
  expect(await runList.json()).toEqual({
    runs: [backfillRunAudit],
    hasMore: false,
    nextCursor: null,
  });
  expect(backfillRunListInputs.at(-1)).toEqual({
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    actorSubjectId: SUBJECT_ID,
    accountAdminAuthorization: {
      authorizationId: expect.any(String),
      accountId: ACCOUNT_ID,
      actorSubjectId: SUBJECT_ID,
      permission: "account:admin",
    },
    limit: 1,
    cursor: "run-cursor",
  });

  const detail = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills/${backfillResult.runId}?limit=2&operationCursor=operation-cursor&receiptCursor=receipt-cursor`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toEqual(backfillAudit);
  expect(backfillAuditInputs.at(-1)).toEqual({
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    actorSubjectId: SUBJECT_ID,
    accountAdminAuthorization: {
      authorizationId: expect.any(String),
      accountId: ACCOUNT_ID,
      actorSubjectId: SUBJECT_ID,
      permission: "account:admin",
    },
    runId: backfillResult.runId,
    limit: 2,
    operationCursor: "operation-cursor",
    receiptCursor: "receipt-cursor",
  });

  const organizationReceipts = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-authority-reclassifications?limit=3`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(organizationReceipts.status).toBe(200);
  expect(await organizationReceipts.json()).toEqual({
    receipts: [organizationAuthorityReceipt],
    hasMore: false,
    nextCursor: null,
  });
  expect(organizationReclassificationInputs.at(-1)).toEqual({
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    actorSubjectId: SUBJECT_ID,
    accountAdminAuthorization: {
      authorizationId: expect.any(String),
      accountId: ACCOUNT_ID,
      actorSubjectId: SUBJECT_ID,
      permission: "account:admin",
    },
    limit: 3,
  });

  const malformedQuery = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills?limit=101`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(malformedQuery.status).toBe(400);
  expect(await malformedQuery.text()).toContain("invalid document migration audit query");
  const malformedRun = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills/not-a-uuid`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(malformedRun.status).toBe(400);

  const cursorError = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills?cursor=domain-error`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(cursorError.status).toBe(400);
  expect(await cursorError.text()).toContain("invalid document migration audit cursor");
  const missingRun = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/document-default-collection-backfills/99999999-9999-4999-8999-999999999999`,
    { headers: { authorization: adminAuthorization } },
  );
  expect(missingRun.status).toBe(404);
  expect(await missingRun.text()).toContain("audit run is unavailable");
});
