import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  type DbClient,
} from "@opengeni/db";
import { verifyWebhookEvent } from "../../../packages/sdk/src/workspace-integrations";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerWorkspaceIntegrationRoutes } from "../src/routes/workspace-integrations";
import { drainWorkspaceWebhookDeliveries } from "../src/workspace-webhook-dispatch";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let productionApp: Hono;
let workspaceId: string;
let accountId: string;
let sessionId: string;
const subjectId = "user:integration-admin";
const delegationSecret = "workspace-integration-route-test-secret";
const settings = testSettings({
  delegationSecret,
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
  sandboxImageAllowlist: "ghcr.io/acme/sandbox@sha256:abc, ghcr.io/acme/other:1",
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-integration-routes");
  if (!shared) throw new Error("Real PostgreSQL is required for workspace integration routes");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Integrations",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Integrations",
    subjectId,
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "Webhook target",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  app = new Hono();
  registerWorkspaceIntegrationRoutes(app, { db: client.db, settings } as ApiRouteDeps);
  productionApp = new Hono();
  registerWorkspaceIntegrationRoutes(productionApp, {
    db: client.db,
    settings: { ...settings, environment: "production" },
  } as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { kind?: "human_session" | "agent_attempt"; admin?: boolean; target?: Hono } = {},
) {
  const bearer = await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: options.kind ?? "human_session",
    permissions:
      options.admin === false ? ["workspace:read"] : ["workspace:read", "workspace:admin"],
    ...(options.kind === "agent_attempt"
      ? {
          sessionId,
          turnId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          executionGeneration: 1,
        }
      : {}),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return await (options.target ?? app).request(`/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("workspace integration routes", () => {
  test("credential provider secret is shown once and survives updates", async () => {
    expect(await (await call("GET", "/credential-provider")).json()).toEqual({ provider: null });
    const created = await call("PUT", "/credential-provider", {
      url: "http://127.0.0.1:9/credentials",
      timeoutMs: 4000,
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.secret).toMatch(/^ogcp_[A-Za-z0-9_-]{43}$/);
    expect(createdBody.provider).toMatchObject({ enabled: true, timeoutMs: 4000 });
    const updated = await call("PUT", "/credential-provider", {
      url: "http://127.0.0.1:9/v2",
      enabled: false,
    });
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody.secret).toBeUndefined();
    expect(updatedBody.provider).toMatchObject({
      url: "http://127.0.0.1:9/v2",
      enabled: false,
      timeoutMs: 4000,
    });
    expect((await call("DELETE", "/credential-provider")).status).toBe(204);
    expect(await (await call("GET", "/credential-provider")).json()).toEqual({ provider: null });
  });

  test("agents and non-admins cannot manage integrations; production requires https", async () => {
    expect((await call("GET", "/webhooks", undefined, { kind: "agent_attempt" })).status).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/credential-provider",
          { url: "https://x.example/c" },
          { kind: "agent_attempt" },
        )
      ).status,
    ).toBe(403);
    expect((await call("GET", "/webhooks", undefined, { admin: false })).status).toBe(403);
    const insecure = await call(
      "POST",
      "/webhooks",
      { url: "http://receiver.example/hook", eventTypes: ["turn.completed"] },
      { target: productionApp },
    );
    expect(insecure.status).toBe(422);
    expect(
      (await call("POST", "/webhooks", { url: "ftp://x.example", eventTypes: ["turn.completed"] }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/webhooks", { url: "https://x.example", eventTypes: ["user.message"] }))
        .status,
    ).toBe(400);
  });

  test("lists only allowlisted sandbox images", async () => {
    const response = await call("GET", "/sandbox-images", undefined, { admin: false });
    expect(await response.json()).toEqual({
      images: ["ghcr.io/acme/sandbox@sha256:abc", "ghcr.io/acme/other:1"],
      selected: null,
    });
  });

  test("delivers a signed thin event and retries a failing endpoint", async () => {
    const received: Array<{ body: string; headers: Headers }> = [];
    let failNext = true;
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = await request.text();
        const path = new URL(request.url).pathname;
        if (path === "/flaky" && failNext) {
          failNext = false;
          return new Response("try later", { status: 503 });
        }
        received.push({ body, headers: request.headers });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const base = `http://127.0.0.1:${receiver.port}`;
      const created = await call("POST", "/webhooks", {
        url: `${base}/ok`,
        eventTypes: ["session.status.changed"],
        description: "status updates",
      });
      expect(created.status).toBe(201);
      const { webhook, secret } = await created.json();
      expect(secret).toMatch(/^whsec_/);
      const flakyResponse = await call("POST", "/webhooks", {
        url: `${base}/flaky`,
        eventTypes: ["session.status.changed"],
      });
      const flaky = (await flakyResponse.json()).webhook;
      const listed = await (await call("GET", "/webhooks")).json();
      expect(listed.webhooks.map((entry: { id: string }) => entry.id)).toEqual([
        webhook.id,
        flaky.id,
      ]);
      expect(JSON.stringify(listed)).not.toContain("whsec_");

      const [event] = await appendSessionEvents(client.db, workspaceId, sessionId, [
        { type: "session.status.changed", payload: { status: "idle", reason: "done" } },
      ]);
      const result = await drainWorkspaceWebhookDeliveries({ db: client.db, settings });
      expect(result.claimed).toBeGreaterThanOrEqual(2);

      const delivered = received.find(
        (entry) => entry.headers.get("opengeni-event-id") === event!.id,
      );
      expect(delivered).toBeDefined();
      const verified = await verifyWebhookEvent({
        body: delivered!.body,
        headers: delivered!.headers,
        secret,
      });
      expect(verified.event).toMatchObject({
        id: event!.id,
        type: "session.status.changed",
        workspaceId,
        sessionId,
        data: { status: "idle", reason: "done" },
      });
      await expect(
        verifyWebhookEvent({
          body: delivered!.body,
          headers: delivered!.headers,
          secret: "whsec_wrong",
        }),
      ).rejects.toThrow("signature verification failed");

      const okDeliveries = await (await call("GET", `/webhooks/${webhook.id}/deliveries`)).json();
      expect(okDeliveries.deliveries[0]).toMatchObject({ status: "delivered", lastStatus: 204 });
      const flakyDeliveries = await (await call("GET", `/webhooks/${flaky.id}/deliveries`)).json();
      expect(flakyDeliveries.deliveries[0]).toMatchObject({
        status: "pending",
        attempts: 1,
        lastStatus: 503,
        lastError: "HTTP 503",
      });
      await shared!.admin`update workspace_webhook_deliveries set next_attempt_at = now()
        where webhook_id = ${flaky.id}`;
      await drainWorkspaceWebhookDeliveries({ db: client.db, settings });
      const retried = await (await call("GET", `/webhooks/${flaky.id}/deliveries`)).json();
      expect(retried.deliveries[0]).toMatchObject({ status: "delivered", attempts: 2 });

      const redelivered = await call(
        "POST",
        `/webhooks/${flaky.id}/deliveries/${retried.deliveries[0].id}/redeliver`,
      );
      expect(await redelivered.json()).toMatchObject({ status: "pending", attempts: 0 });

      const patched = await call("PATCH", `/webhooks/${flaky.id}`, { enabled: false });
      expect(await patched.json()).toMatchObject({ enabled: false });
      expect((await call("DELETE", `/webhooks/${flaky.id}`)).status).toBe(204);
      expect((await call("DELETE", `/webhooks/${flaky.id}`)).status).toBe(404);
    } finally {
      receiver.stop(true);
    }
  });
});
