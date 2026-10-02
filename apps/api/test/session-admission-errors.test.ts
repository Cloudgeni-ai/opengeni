import { describe, expect, test } from "bun:test";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { resolveTurnExecutionPolicyV1, UnsupportedLatencyModeError } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";
import { parseSessionEventAdmission, parseSteerSessionAdmission } from "../src/routes/sessions";

const workspaceId = "00000000-0000-4000-8000-000000000082";
const sessionId = "00000000-0000-4000-8000-000000000084";

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
      "x-opengeni-correlation-id": "session-admission-invalid-event",
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
    expect(invalidBody.error.requestId).toMatch(/^[0-9a-f-]{36}$/);

    const malformed = await server.request(path, {
      method: "POST",
      headers: { ...headers, "x-opengeni-correlation-id": "session-admission-malformed-json" },
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
    expect(malformedBody.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("returns typed 422 for a removed Steer tool override", async () => {
    const response = await parserApp().request("/v1/test/session-steer-admission", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opengeni-correlation-id": "session-admission-invalid-steer",
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
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
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
