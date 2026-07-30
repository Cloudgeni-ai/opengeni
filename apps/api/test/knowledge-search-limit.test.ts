import { afterAll, expect, mock, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "user:knowledge-search-limit";
const fakeDb = {};
const searchInputs: unknown[] = [];

const realDocuments = await import("@opengeni/documents");
const realSearchDocuments = realDocuments.searchDocuments;
mock.module("@opengeni/documents", () => ({
  ...realDocuments,
  searchDocuments: mock(async (...args: Parameters<typeof realSearchDocuments>) => {
    if (args[0] !== fakeDb) {
      return await realSearchDocuments(...args);
    }
    searchInputs.push(args[1]);
    return [];
  }),
}));

const { createApp } = await import("../src/app");

afterAll(() => {
  mock.restore();
});

test("authenticated knowledge search rejects 51 with a typed envelope and accepts 50", async () => {
  const settings = testSettings({ productAccessMode: "managed" });
  const authorization = `Bearer ${await signDelegatedAccessToken(settings.delegationSecret!, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: SUBJECT_ID,
    permissions: ["documents:search"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
  const app = createApp({
    settings,
    db: fakeDb as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const path = `/v1/workspaces/${WORKSPACE_ID}/knowledge/search`;
  const headers = {
    authorization,
    "content-type": "application/json",
    "x-opengeni-correlation-id": "knowledge-limit-test",
  };

  const oversized = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "boundary", mode: "keyword", limit: 51 }),
  });
  expect(oversized.status).toBe(422);
  const oversizedBody = (await oversized.json()) as {
    error: { requestId: string };
  };
  expect(oversizedBody).toMatchObject({
    error: {
      status: 422,
      code: "validation_failed",
      message: "invalid knowledge search request",
      retryable: false,
    },
  });
  expect(oversizedBody.error.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  expect(oversized.headers.get("x-opengeni-correlation-id")).toBe(oversizedBody.error.requestId);
  expect(JSON.stringify(oversizedBody).length).toBeLessThan(1_024);
  expect(searchInputs).toHaveLength(0);

  const maximum = await app.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "boundary", mode: "keyword", limit: 50 }),
  });
  expect(maximum.status).toBe(200);
  expect(await maximum.json()).toEqual({ results: [] });
  expect(searchInputs).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      query: "boundary",
      baseIds: undefined,
      limit: 50,
      mode: "keyword",
      sourceKinds: undefined,
      aclTags: undefined,
      access: { viewerSubjectId: SUBJECT_ID },
    },
  ]);
});
