import { describe, expect, test } from "bun:test";
import { MemoryEventBus, testSettings } from "../../../packages/testing/src/index";
import {
  resolveTurnExecutionPolicyV1,
  UnsupportedLatencyModeError,
} from "../../../packages/config/src/index";
import { OPENGENI_CORRELATION_HEADER } from "../../../packages/contracts/src/index";
import { HTTPException } from "hono/http-exception";
import {
  canonicalConfiguredModel,
  modelUnavailableHttpException,
} from "../../../packages/core/src/domain/sessions";
import { createApp } from "../src/app";
import { parseSessionEventAdmission, parseSteerSessionAdmission } from "../src/routes/sessions";

const workspaceId = "00000000-0000-4000-8000-000000000082";
const sessionId = "00000000-0000-4000-8000-000000000084";
const generatedRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectRequestId(
  response: Response,
  body: { error: { requestId: string } },
  admittedId: string,
) {
  expect(body.error.requestId).toBe(admittedId);
  expect(response.headers.get(OPENGENI_CORRELATION_HEADER)).toBe(admittedId);
}

function app() {
  const poisonDb = new Proxy(
    {},
    {
      get() {
        throw new Error("invalid session admission touched the database");
      },
    },
  );
  return createApp({
    settings: testSettings({ productAccessMode: "managed" }),
    db: poisonDb as never,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    managedAuth: null,
    objectStorage: null,
  });
}

function parserApp() {
  const server = app();
  server.post("/v1/test/session-event-admission", async (c) =>
    c.json(parseSessionEventAdmission(await c.req.json().catch(() => null))),
  );
  server.post("/v1/test/session-steer-admission", async (c) =>
    c.json(parseSteerSessionAdmission(await c.req.json().catch(() => null))),
  );
  return server;
}

describe("session admission error envelope", () => {
  test("unsupported user.message latency is typed 422 and unrelated faults remain 500", async () => {
    const server = app();
    server.post("/v1/test/unsupported-latency", () => {
      resolveTurnExecutionPolicyV1(testSettings(), {
        modelId: "scripted-model",
        requestedModelId: "scripted-model",
        modelSource: "explicit",
        reasoningEffort: "medium",
        reasoningSource: "explicit",
        latencyMode: "fast",
        latencyModeSource: "explicit",
      });
      throw new Error("unsupported latency unexpectedly accepted");
    });
    server.post("/v1/test/unsupported-priority", () => {
      throw new UnsupportedLatencyModeError("scripted-model", "priority", ["standard"]);
    });
    server.post("/v1/test/unrelated-failure", () => {
      throw new Error("private-server-fault");
    });
    for (const mode of ["latency", "priority"]) {
      const response = await server.request(`/v1/test/unsupported-${mode}`, { method: "POST" });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: {
          status: 422,
          code: "validation_failed",
          retryable: false,
          details: { code: "UNSUPPORTED_LATENCY_MODE", allowedLatencyModes: ["standard"] },
        },
      });
    }
    const unrelated = await server.request("/v1/test/unrelated-failure", { method: "POST" });
    expect(unrelated.status).toBe(500);
    expect(await unrelated.text()).not.toContain("private-server-fault");
  });
  test("a model missing from the live catalog is a typed, nonretryable model_unavailable 422", async () => {
    const server = app();
    const removedModel = "openrouter/vendor/retired-model:free";
    server.post("/v1/test/removed-session-model", () => {
      // The follow-up choke point: the session's stored model is resolved
      // against the live catalog, which no longer lists it.
      canonicalConfiguredModel(testSettings(), removedModel);
      throw new Error("removed model unexpectedly accepted");
    });
    server.post("/v1/test/inactive-custom-model", () => {
      throw modelUnavailableHttpException("workspace-custom/retired");
    });
    server.post("/v1/test/other-validation", () => {
      throw new HTTPException(422, { message: "model is not available: hand-written" });
    });
    const removed = await server.request("/v1/test/removed-session-model", { method: "POST" });
    expect(removed.status).toBe(422);
    expect(await removed.json()).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: `model is not available: ${removedModel}`,
        retryable: false,
        details: { code: "model_unavailable", modelId: removedModel },
      },
    });
    const custom = await server.request("/v1/test/inactive-custom-model", { method: "POST" });
    expect(custom.status).toBe(422);
    expect((await custom.json()).error.details).toEqual({
      code: "model_unavailable",
      modelId: "workspace-custom/retired",
    });
    // Only the typed cause carries the code; untyped 422s keep their old shape.
    const other = await server.request("/v1/test/other-validation", { method: "POST" });
    expect(other.status).toBe(422);
    expect((await other.json()).error.details).toBeUndefined();
  });

  test("retains allowance scope, subject and reset in a nonretryable HTTP 402", async () => {
    for (const scope of ["workspace", "member"] as const) {
      const server = app();
      server.post(`/v1/test/allowance-${scope}`, () => {
        throw new HTTPException(402, {
          message: "Usage allowance exhausted.",
          cause: {
            allowed: false,
            code: "allowance_exhausted",
            scope,
            resetsAt: "2026-10-01T00:00:00.000Z",
            ...(scope === "member" ? { subjectId: "external_user:initiator" } : {}),
            message: "Usage allowance exhausted.",
          },
        });
      });
      const response = await server.request(`/v1/test/allowance-${scope}`, { method: "POST" });
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({
        error: {
          status: 402,
          code: "allowance_exhausted",
          message: "Usage allowance exhausted.",
          retryable: false,
          details: {
            scope,
            resetsAt: "2026-10-01T00:00:00.000Z",
            ...(scope === "member" ? { subjectId: "external_user:initiator" } : {}),
          },
        },
      });
    }
  });

  test("returns typed 422 for invalid and malformed user-message events", async () => {
    const server = parserApp();
    const privateValue = "PRIVATE-REMOVED-TOOL-OVERRIDE";
    const path = "/v1/test/session-event-admission";
    const headers = {
      "content-type": "application/json",
      [OPENGENI_CORRELATION_HEADER]: "session-admission-invalid-event",
    };
    const invalid = await server.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "user.message",
        payload: { text: "hello", tools: [{ kind: "mcp", id: privateValue }] },
      }),
    });
    expect(invalid.status).toBe(422);
    const rawInvalid = await invalid.text();
    expect(rawInvalid).not.toContain(privateValue);
    const invalidBody = JSON.parse(rawInvalid) as { error: { requestId: string } };
    expect(invalidBody).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: "invalid session event",
        retryable: false,
      },
    });
    expectRequestId(invalid, invalidBody, headers[OPENGENI_CORRELATION_HEADER]);

    const malformedId = "session-admission-malformed-json";
    const malformed = await server.request(path, {
      method: "POST",
      headers: { ...headers, [OPENGENI_CORRELATION_HEADER]: malformedId },
      body: '{"type":"user.message",',
    });
    expect(malformed.status).toBe(422);
    const malformedBody = (await malformed.json()) as { error: { requestId: string } };
    expect(malformedBody).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: "invalid session event",
        retryable: false,
      },
    });
    expectRequestId(malformed, malformedBody, malformedId);
  });

  test("returns typed 422 for a removed Steer tool override", async () => {
    const correlationId = "session-admission-invalid-steer";
    const response = await parserApp().request("/v1/test/session-steer-admission", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OPENGENI_CORRELATION_HEADER]: correlationId,
      },
      body: JSON.stringify({ text: "steer", tools: [] }),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { requestId: string } };
    expect(body).toMatchObject({
      error: {
        status: 422,
        code: "validation_failed",
        message: "invalid steer request",
        retryable: false,
      },
    });
    expectRequestId(response, body, correlationId);
  });

  test("retains safe correlation ids through the 128-character admission boundary", async () => {
    const prefix = "Session.admission:invalid_";
    const correlationId = prefix + "x".repeat(128 - prefix.length);
    const response = await parserApp().request("/v1/test/session-steer-admission", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OPENGENI_CORRELATION_HEADER]: correlationId,
      },
      body: JSON.stringify({ text: "steer", tools: [] }),
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "validation_failed", message: "invalid steer request", retryable: false },
    });
    expectRequestId(response, body, correlationId);
  });

  test("invalid and oversized correlation ids get fresh, consistent ids without exposing private input", async () => {
    const server = parserApp();
    const privateValue = "PRIVATE-ADMISSION-INPUT";
    const requestIds = new Set<string>();
    for (const correlationId of [`<${privateValue}>`, "x".repeat(129)]) {
      for (const [path, payload, message] of [
        [
          "/v1/test/session-event-admission",
          {
            type: "user.message",
            payload: { text: "hello", tools: [{ kind: "mcp", id: privateValue }] },
          },
          "invalid session event",
        ],
        [
          "/v1/test/session-steer-admission",
          { text: "steer", tools: [{ kind: "mcp", id: privateValue }] },
          "invalid steer request",
        ],
      ] as const) {
        const response = await server.request(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [OPENGENI_CORRELATION_HEADER]: correlationId,
          },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(422);
        const raw = await response.text();
        expect(raw).not.toContain(privateValue);
        expect(raw).not.toContain(correlationId);
        const body = JSON.parse(raw) as { error: { requestId: string } };
        expect(body).toMatchObject({
          error: { status: 422, code: "validation_failed", message, retryable: false },
        });
        expect(body.error.requestId).toMatch(generatedRequestId);
        expectRequestId(response, body, body.error.requestId);
        requestIds.add(body.error.requestId);
      }
    }
    expect(requestIds.size).toBe(4);
  });

  test("keeps authorization ahead of admission parsing", async () => {
    const response = await app().request(
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"user.message",',
      },
    );
    expect(response.status).toBe(401);
  });
});
