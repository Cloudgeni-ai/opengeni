import { afterAll, expect, mock, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const BASE_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const SUBJECT_ID = "user:document-authority-owner";
const fakeDb = {};
const calls: unknown[] = [];

const realDocuments = await import("@opengeni/documents");
const realReclassifyDocumentAuthority = realDocuments.reclassifyDocumentAuthority;
mock.module("@opengeni/documents", () => ({
  ...realDocuments,
  reclassifyDocumentAuthority: mock(
    async (...args: Parameters<typeof realReclassifyDocumentAuthority>) => {
      if (args[0] !== fakeDb) {
        return await realReclassifyDocumentAuthority(...args);
      }
      calls.push(args[1]);
      return {
        id: RECEIPT_ID,
        operationId: OPERATION_ID,
        documentId: DOCUMENT_ID,
        baseIdSnapshot: BASE_ID,
        actorSubjectId: SUBJECT_ID,
        sourceAuthority: {
          kind: "workspace" as const,
          workspaceId: WORKSPACE_ID,
          subjectId: null,
        },
        targetAuthority: {
          kind: "organization" as const,
          workspaceId: null,
          subjectId: null,
        },
        createdAt: "2026-08-04T07:30:00.000Z",
      };
    },
  ),
}));

const { createApp } = await import("../src/app");

afterAll(() => {
  mock.restore();
});

test("document authority reclassification freezes the actor and exact account-admin grant", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    permissions: ["documents:manage", "account:admin"],
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

  const response = await app.request(
    `/v1/workspaces/${WORKSPACE_ID}/documents/${DOCUMENT_ID}/authority-reclassifications`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        operationId: OPERATION_ID,
        expectedAuthority: {
          kind: "workspace",
          workspaceId: WORKSPACE_ID,
          subjectId: null,
        },
        targetAuthorityKind: "organization",
      }),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    operationId: OPERATION_ID,
    documentId: DOCUMENT_ID,
    actorSubjectId: SUBJECT_ID,
    targetAuthority: { kind: "organization", workspaceId: null, subjectId: null },
  });
  expect(calls).toEqual([
    {
      operationId: OPERATION_ID,
      expectedAuthority: {
        kind: "workspace",
        workspaceId: WORKSPACE_ID,
        subjectId: null,
      },
      targetAuthorityKind: "organization",
      accountId: ACCOUNT_ID,
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      actorSubjectId: SUBJECT_ID,
      organizationAuthorityGranted: true,
    },
  ]);
});
