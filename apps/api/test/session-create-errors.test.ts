import { describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerSessionRoutes, sessionCreateErrorResponse } from "../src/routes/sessions";

const delegationSecret = "session-create-errors-test-secret";
const workspaceId = "00000000-0000-4000-8000-000000000082";
const accountId = "00000000-0000-4000-8000-000000000083";

async function bearer() {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId: "session-create-error-tester",
    permissions: ["sessions:create", "sessions:read"],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function routeDeps(): ApiRouteDeps {
  return {
    settings: testSettings({ productAccessMode: "managed", delegationSecret }),
    // Schema rejection happens before createSessionForRequest touches storage.
    // Deliberately fail loud if that ordering regresses.
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("malformed create request touched the database");
        },
      },
    ),
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
  } as unknown as ApiRouteDeps;
}

describe("session create error envelope", () => {
  test("returns value-free actionable 422 JSON for malformed create schema", async () => {
    const app = new Hono();
    registerSessionRoutes(app, routeDeps());
    const privateValue = "do-not-reflect-this-private-draft";
    const response = await app.request(`http://x/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ initialMessage: { privateValue } }),
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
    const raw = await response.text();
    expect(raw).not.toContain(privateValue);
    expect(JSON.parse(raw)).toEqual({
      code: "INVALID_SESSION_CREATE_REQUEST",
      message: "Invalid session create request: initialMessage failed schema validation",
    });
  });

  test("returns the same stable 422 JSON contract for malformed JSON", async () => {
    const app = new Hono();
    registerSessionRoutes(app, routeDeps());
    const response = await app.request(`http://x/v1/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      headers: {
        authorization: await bearer(),
        "content-type": "application/json",
      },
      body: '{"initialMessage":',
    });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "INVALID_SESSION_CREATE_REQUEST",
      message: "Invalid session create request: request body must contain valid JSON",
    });
  });

  test("encodes a safe domain rejection and preserves non-422 HTTP behavior", async () => {
    const app = new Hono();
    app.get("/rejected", (c) =>
      sessionCreateErrorResponse(
        c,
        new HTTPException(422, {
          message:
            "workingDir requires targetSandboxId (it is the targeted machine's working directory)",
        }),
      ),
    );
    app.get("/forbidden", (c) =>
      sessionCreateErrorResponse(c, new HTTPException(403, { message: "still forbidden" })),
    );

    const rejected = await app.request("http://x/rejected");
    expect(rejected.status).toBe(422);
    expect(rejected.headers.get("content-type")).toContain("application/json");
    expect(await rejected.json()).toEqual({
      code: "SESSION_CREATE_REJECTED",
      message:
        "workingDir requires targetSandboxId (it is the targeted machine's working directory)",
    });

    const forbidden = await app.request("http://x/forbidden");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("still forbidden");
  });
});
