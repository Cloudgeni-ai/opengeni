import { afterAll, expect, mock, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "user:document-default-list";
const fakeDb = {};
const listInputs: unknown[] = [];
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
}));

const { createApp } = await import("../src/app");

afterAll(() => {
  mock.restore();
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
