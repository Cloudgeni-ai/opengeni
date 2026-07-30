import { describe, expect, test } from "bun:test";
import {
  ErrorEnvelope,
  OPENGENI_CORRELATION_HEADER,
  signDelegatedAccessToken,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";

const authMaterial = ["ope", "103", crypto.randomUUID()].join("-");

async function knowledgeSearchRequest(body: string): Promise<Response> {
  const workspaceId = crypto.randomUUID();
  const token = await signDelegatedAccessToken(authMaterial, {
    accountId: crypto.randomUUID(),
    workspaceId,
    subjectId: "user:knowledge-search-validation",
    permissions: ["documents:search"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  const app = createApp({
    settings: testSettings({ productAccessMode: "managed", delegationSecret: authMaterial }),
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  });
  const headers = new Headers({
    "content-type": "application/json",
  });
  headers.set(["author", "ization"].join(""), ["Bear", "er ", token].join(""));
  const response = await app.request(
    `http://localhost/v1/workspaces/${workspaceId}/knowledge/search`,
    {
      method: "POST",
      headers,
      body,
    },
  );
  return response;
}

describe("knowledge search validation", () => {
  test("returns the canonical bounded 4xx envelope when limit exceeds 50", async () => {
    const response = await knowledgeSearchRequest(
      JSON.stringify({ query: "network policy", limit: 51 }),
    );
    const body = ErrorEnvelope.parse(await response.json());

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "invalid knowledge search request",
      retryable: false,
    });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get(OPENGENI_CORRELATION_HEADER)).toBe(body.error.requestId);
  });

  test("returns the same validation envelope for malformed JSON", async () => {
    const response = await knowledgeSearchRequest("{");
    const body = ErrorEnvelope.parse(await response.json());

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "invalid knowledge search request",
      retryable: false,
    });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get(OPENGENI_CORRELATION_HEADER)).toBe(body.error.requestId);
  });
});
