import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { AuxiliaryModelCallService } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

const SECRET = "inference-route-test";
const WORKSPACE = "00000000-0000-4000-8000-000000000011";
const ACCOUNT = "00000000-0000-4000-8000-000000000012";
const validDecision = {
  input: { text: "hello" },
  questions: { matches: { type: "predicate", instructions: "Does it match?" } },
};
function app(service: AuxiliaryModelCallService | null) {
  return createApp({
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      voiceInputProviderOrder: "",
    }),
    db: {} as never,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    transcription: null,
    modelCalls: null,
    auxiliaryModelCalls: service,
  });
}
async function bearer(permissions: Permission[] = ["sessions:create"], workspaceId = WORKSPACE) {
  return `Bearer ${await signDelegatedAccessToken(SECRET, { accountId: ACCOUNT, workspaceId, subjectId: "caller", permissions, principalKind: "service", exp: Math.floor(Date.now() / 1000) + 600 })}`;
}
function harness() {
  const calls: unknown[] = [];
  const service: AuxiliaryModelCallService = {
    decide: async (input) => {
      calls.push(input);
      return {
        id: input.requestId,
        object: "decision",
        model: "configured",
        answers: { matches: { type: "refusal", reason: "Unknown" } },
        usage: {
          model: "configured",
          provider: "test",
          requests: 1,
          inputTokens: 2,
          outputTokens: null,
          costUsd: null,
          costSource: "unknown",
        },
      };
    },
    embed: async (input) => {
      calls.push(input);
      return {
        id: input.requestId,
        object: "list",
        model: "configured",
        dimensions: 2,
        data: [{ object: "embedding", index: 0, embedding: [0, 1] }],
        usage: {
          inputTokens: 2,
          totalTokens: 2,
          requests: 1,
          costUsd: null,
          costSource: "unknown",
        },
      };
    },
  };
  return { application: app(service), calls };
}

describe("stateless inference HTTP authority and validation", () => {
  for (const endpoint of ["decisions", "embeddings"] as const) {
    const body = endpoint === "decisions" ? validDecision : { input: "hello" };
    const path = `/v1/workspaces/${WORKSPACE}/${endpoint}`;
    test(`${endpoint} requires the same authenticated sessions:create authority`, async () => {
      const h = harness();
      for (const [authorization, status] of [
        [undefined, 401],
        [await bearer(["sessions:read"]), 403],
      ] as const) {
        const result = await h.application.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify(body),
        });
        expect(result.status).toBe(status);
      }
      expect(h.calls).toHaveLength(0);
    });
    test(`${endpoint} forwards exact caller and cancellation, generates distinct settlement identities`, async () => {
      const h = harness();
      const signal = new AbortController().signal;
      for (let n = 0; n < 2; n++) {
        const result = await h.application.request(path, {
          method: "POST",
          headers: { authorization: await bearer(), "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        expect(result.status).toBe(200);
        const response = await result.json();
        expect(response).toMatchObject(
          endpoint === "decisions"
            ? { answers: { matches: { type: "refusal" } } }
            : { dimensions: 2, data: [{ embedding: [0, 1] }] },
        );
      }
      expect(h.calls[0]).toMatchObject({
        workspaceId: WORKSPACE,
        accountId: ACCOUNT,
        subjectId: "caller",
        grant: { principalKind: "service" },
        request: body,
      });
      const first = h.calls[0] as { requestId: string; signal: AbortSignal };
      expect(first.requestId).not.toBe((h.calls[1] as typeof first).requestId);
      expect(first.signal.aborted).toBe(false);
    });
    test(`${endpoint} cannot choose a model, credential, stream, dimensions or settlement key`, async () => {
      const h = harness();
      for (const extra of [
        { model: "other" },
        { apiKey: "other" },
        { stream: true },
        { requestId: "replay" },
        { dimensions: 1 },
      ]) {
        const result = await h.application.request(path, {
          method: "POST",
          headers: { authorization: await bearer(), "content-type": "application/json" },
          body: JSON.stringify({ ...body, ...extra }),
        });
        expect(result.status).toBe(400);
      }
      expect(h.calls).toHaveLength(0);
    });
    test(`${endpoint} handles missing service and malformed JSON`, async () => {
      const headers = { authorization: await bearer(), "content-type": "application/json" };
      expect(
        (await app(null).request(path, { method: "POST", headers, body: JSON.stringify(body) }))
          .status,
      ).toBe(503);
      expect(
        (await harness().application.request(path, { method: "POST", headers, body: "{" })).status,
      ).toBe(400);
    });
  }
  test("invalid question types, empty questions/criteria, missing input and empty embeddings are rejected", async () => {
    const h = harness();
    for (const body of [
      { questions: validDecision.questions },
      { input: "x", questions: {} },
      { input: "x", questions: { q: { type: "choice", instructions: "pick", criteria: {} } } },
      { input: "x", questions: { q: { type: "score", instructions: "score", criteria: [] } } },
      { input: "x", questions: { q: { type: "text", instructions: "write" } } },
    ]) {
      expect(
        (
          await h.application.request(`/v1/workspaces/${WORKSPACE}/decisions`, {
            method: "POST",
            headers: { authorization: await bearer(), "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    for (const input of [[], "", [""], [3]]) {
      expect(
        (
          await h.application.request(`/v1/workspaces/${WORKSPACE}/embeddings`, {
            method: "POST",
            headers: { authorization: await bearer(), "content-type": "application/json" },
            body: JSON.stringify({ input }),
          })
        ).status,
      ).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });
});
