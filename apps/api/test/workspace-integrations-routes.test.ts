import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createOrganizationWebhook,
  createSession,
  deleteOrganizationCredentialProvider,
  encryptEnvironmentValue,
  upsertOrganizationCredentialProvider,
  type DbClient,
} from "@opengeni/db";
import {
  verifyCredentialProviderRequest,
  verifyWebhookEvent,
} from "../../../packages/sdk/src/workspace-integrations";
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
  test("concurrent first provider PUT returns a secret only on the single create", async () => {
    await call("DELETE", "/credential-provider");
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        call("PUT", "/credential-provider", {
          url: `https://product.example/credentials/${index}`,
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.filter((body) => body.secret !== undefined)).toHaveLength(1);
    await call("DELETE", "/credential-provider");
  });
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
      timeoutMs: 10_000,
    });
    const rotated = await call("POST", "/credential-provider/rotate-secret");
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json();
    expect(rotatedBody.secret).not.toBe(createdBody.secret);
    expect(rotatedBody.provider).toMatchObject({
      url: updatedBody.provider.url,
      enabled: false,
      timeoutMs: 10_000,
      createdAt: updatedBody.provider.createdAt,
      workspaceId,
    });
    expect((await (await call("GET", "/credential-provider")).json()).secret).toBeUndefined();
    expect((await call("DELETE", "/credential-provider")).status).toBe(204);
    expect((await call("POST", "/credential-provider/rotate-secret")).status).toBe(404);
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
      const fetched = await call("GET", `/webhooks/${webhook.id}`);
      expect(fetched.status).toBe(200);
      expect((await fetched.json()).id).toBe(webhook.id);
      expect(fetched.headers.get("cache-control")).toBe("private, no-store");
      expect((await call("GET", `/webhooks/${crypto.randomUUID()}`)).status).toBe(404);
      expect(listed.webhooks.map((entry: { id: string }) => entry.id)).toEqual([
        webhook.id,
        flaky.id,
      ]);
      expect(JSON.stringify(listed)).not.toContain("whsec_");
      const rotated = await call("POST", `/webhooks/${webhook.id}/rotate-secret`);
      expect(rotated.status).toBe(200);
      const newSecret = (await rotated.json()).secret;
      expect(newSecret).not.toBe(secret);

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
        secret: newSecret,
      });
      expect(verified.event).toMatchObject({
        id: event!.id,
        type: "session.status.changed",
        lane: "workspace",
        workspaceId,
        sessionId,
        data: { status: "idle", reason: "done" },
      });
      await expect(
        verifyWebhookEvent({
          body: delivered!.body,
          headers: delivered!.headers,
          secret,
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

  test("Send test event and Test connection reach the endpoint now and never echo credentials", async () => {
    const received: Array<{ path: string; body: string; headers: Headers }> = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = await request.text();
        const path = new URL(request.url).pathname;
        received.push({ path, body, headers: request.headers });
        if (path === "/refuses") return new Response("bad signature", { status: 401 });
        if (path === "/credentials") {
          return Response.json({
            status: "ok",
            environment: { SECRET_TOKEN: "value-that-must-not-leak" },
            git: [{ host: "GitHub.com", password: "ghs_must_not_leak" }],
          });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      const base = `http://127.0.0.1:${receiver.port}`;
      const created = await (
        await call("POST", "/webhooks", { url: `${base}/hook`, eventTypes: ["turn.completed"] })
      ).json();
      const tested = await call("POST", `/webhooks/${created.webhook.id}/test`);
      expect(tested.status).toBe(200);
      expect(tested.headers.get("cache-control")).toBe("private, no-store");
      const { result } = await tested.json();
      expect(result).toMatchObject({ ok: true, status: 204, error: null, credentials: null });
      const delivered = received.find((entry) => entry.path === "/hook")!;
      const verified = await verifyWebhookEvent({
        body: delivered.body,
        headers: delivered.headers,
        secret: created.secret,
      });
      expect(verified.event).toMatchObject({
        type: "webhook.test",
        workspaceId,
        sessionId: null,
        data: { webhookId: created.webhook.id },
      });
      expect(delivered.headers.get("opengeni-event-id")).toBe(verified.event.id);
      expect(result.request).toBe(delivered.body);
      // Nothing is queued: a test is not a delivery.
      const deliveries = await (
        await call("GET", `/webhooks/${created.webhook.id}/deliveries`)
      ).json();
      expect(deliveries.deliveries).toEqual([]);

      const refusing = await (
        await call("POST", "/webhooks", { url: `${base}/refuses`, eventTypes: ["turn.failed"] })
      ).json();
      const refused = (await (await call("POST", `/webhooks/${refusing.webhook.id}/test`)).json())
        .result;
      expect(refused).toMatchObject({ ok: false, status: 401, responseBody: "bad signature" });
      expect(refused.error).toContain("signing secret");

      await call("DELETE", "/credential-provider");
      const provider = await (
        await call("PUT", "/credential-provider", { url: `${base}/credentials` })
      ).json();
      const providerTest = await call("POST", "/credential-provider/test");
      expect(providerTest.status).toBe(200);
      const providerText = await providerTest.text();
      expect(providerText).not.toContain("value-that-must-not-leak");
      expect(providerText).not.toContain("ghs_must_not_leak");
      const providerResult = JSON.parse(providerText);
      expect(providerResult).toMatchObject({
        lane: "workspace",
        url: `${base}/credentials`,
        result: {
          ok: true,
          status: 200,
          responseBody: null,
          credentials: {
            status: "ok",
            environment: ["SECRET_TOKEN"],
            git: ["github.com"],
            files: [],
            mcp: [],
          },
        },
      });
      const sent = received.find((entry) => entry.path === "/credentials")!;
      const request = await verifyCredentialProviderRequest({
        body: sent.body,
        headers: sent.headers,
        secret: provider.secret,
      });
      expect(request).toMatchObject({
        type: "credentials.request",
        purpose: "test",
        workspaceId,
        accountId,
        sessionId: "00000000-0000-0000-0000-000000000000",
        turnId: "00000000-0000-0000-0000-000000000000",
        initiatingHumanSubjectId: subjectId,
      });

      // A paused provider is still testable, so it can be checked before resuming.
      await call("PUT", "/credential-provider", { url: `${base}/credentials`, enabled: false });
      expect((await (await call("POST", "/credential-provider/test")).json()).result.ok).toBe(true);

      await call("PUT", "/credential-provider", { url: "http://127.0.0.1:1/credentials" });
      const unreachable = (await (await call("POST", "/credential-provider/test")).json()).result;
      expect(unreachable).toMatchObject({ ok: false, status: null });
      expect(unreachable.error).toContain("refused");

      for (const path of ["/credential-provider/test", `/webhooks/${created.webhook.id}/test`]) {
        expect((await call("POST", path, undefined, { kind: "agent_attempt" })).status).toBe(403);
        expect((await call("POST", path, undefined, { admin: false })).status).toBe(403);
      }
      await call("DELETE", "/credential-provider");
      expect((await call("POST", "/credential-provider/test")).status).toBe(404);
      await call("DELETE", `/webhooks/${created.webhook.id}`);
      await call("DELETE", `/webhooks/${refusing.webhook.id}`);
    } finally {
      receiver.stop(true);
    }
  });

  test("shows the organization registrations that reach this workspace, never secrets", async () => {
    const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
    expect((await (await call("GET", "/inherited-integrations")).json()).credentialProvider).toBe(
      null,
    );
    await upsertOrganizationCredentialProvider(client.db, {
      accountId,
      url: "https://org.example/credentials",
      enabled: true,
      timeoutMs: 5000,
      workspaceFilter: { externalSource: "test" },
      createdBySubjectId: subjectId,
      secretEncrypted: encryptEnvironmentValue(key, "ogcp_org_secret"),
    });
    const matching = await createOrganizationWebhook(client.db, {
      accountId,
      url: "https://org.example/events",
      secretEncrypted: encryptEnvironmentValue(key, "whsec_org_secret"),
      eventTypes: ["turn.completed"],
      enabled: true,
      description: null,
      workspaceFilter: null,
      createdBySubjectId: subjectId,
    });
    await createOrganizationWebhook(client.db, {
      accountId,
      url: "https://other.example/events",
      secretEncrypted: encryptEnvironmentValue(key, "whsec_other_secret"),
      eventTypes: ["turn.completed"],
      enabled: true,
      description: null,
      workspaceFilter: { externalSource: "another-product" },
      createdBySubjectId: subjectId,
    });
    try {
      const response = await call("GET", "/inherited-integrations");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("_secret");
      expect(JSON.parse(text)).toEqual({
        credentialProvider: {
          url: "https://org.example/credentials",
          timeoutMs: 5000,
          updatedAt: expect.any(String),
        },
        webhooks: [
          {
            id: matching.id,
            url: "https://org.example/events",
            eventTypes: ["turn.completed"],
            description: null,
          },
        ],
      });
      expect(
        (await call("GET", "/inherited-integrations", undefined, { kind: "agent_attempt" })).status,
      ).toBe(403);
    } finally {
      await deleteOrganizationCredentialProvider(client.db, { accountId });
      await shared!.admin`delete from organization_webhooks where account_id = ${accountId}`;
    }
  });
});
