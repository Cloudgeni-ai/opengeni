import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createApiKey,
  createDb,
  decryptEnvironmentValue,
  getOrganizationCredentialProvider,
  getOrganizationWebhook,
  type DbClient,
} from "@opengeni/db";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { registerOrganizationIntegrationRoutes } from "../src/routes/organization-integrations";
import { organizationApiKeyPermissionsForAccess } from "../src/routes/api-keys";

setDefaultTimeout(60_000);

let shared: SharedTestDatabase | null;
let client: DbClient;
let app: Hono;
let accountId: string;
let workspaceId: string;
let token: string;
const subjectId = `user:org-integration-admin:${crypto.randomUUID()}`;
const delegationSecret = "organization-integration-test-secret";
const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret,
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
});
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("organization-integration-routes");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "org-routes-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Org routes",
    workspaceExternalSource: "org-routes-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Org routes",
    subjectId,
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  token = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
  await createApiKey(client.db, {
    accountId,
    workspaceId: null,
    name: "Integration admin",
    prefix: token.slice(0, 14),
    keyHash: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    credentialKind: "organization",
    permissions: organizationApiKeyPermissionsForAccess("full"),
  });
  app = new Hono();
  registerOrganizationIntegrationRoutes(app, { db: client.db, settings } as ApiRouteDeps);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);
async function call(method: string, path: string, body?: unknown, bearer = token) {
  return app.request(`/v1/organizations/${accountId}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
describe("organization integration routes (PostgreSQL)", () => {
  test("organization usage subscriptions return a clear 422 without changing registrations", async () => {
    const created = await call("POST", "/webhooks", {
      url: "https://receiver.example/usage",
      workspaceFilter: null,
      eventTypes: ["usage.exhausted"],
    });
    expect(created.status).toBe(422);
    expect(await created.text()).toContain("workspace webhook");
    const accepted = await call("POST", "/webhooks", {
      url: "https://receiver.example/session",
      workspaceFilter: null,
      eventTypes: ["turn.completed"],
    });
    expect(accepted.status).toBe(201);
    const { webhook } = await accepted.json();
    const updated = await call("PATCH", `/webhooks/${webhook.id}`, {
      workspaceFilter: null,
      eventTypes: ["usage.period_reset"],
    });
    expect(updated.status).toBe(422);
    expect(await updated.text()).toContain("workspace webhook");
    expect((await (await call("GET", `/webhooks/${webhook.id}`)).json()).eventTypes).toEqual([
      "turn.completed",
    ]);
    await call("DELETE", `/webhooks/${webhook.id}`);
  });
  test("read-only organization keys cannot read or modify integration registrations", async () => {
    const readToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId,
      workspaceId: null,
      name: "Read-only integration",
      prefix: readToken.slice(0, 14),
      keyHash: new Bun.CryptoHasher("sha256").update(readToken).digest("hex"),
      credentialKind: "organization",
      permissions: organizationApiKeyPermissionsForAccess("read"),
    });
    expect((await call("GET", "/webhooks", undefined, readToken)).status).toBe(403);
    expect(
      (
        await call(
          "PUT",
          "/credential-provider",
          {
            url: "https://product.example/credentials",
          },
          readToken,
        )
      ).status,
    ).toBe(403);
  });
  test("concurrent first PUT returns exactly one stored signing secret", async () => {
    await call("DELETE", "/credential-provider");
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        call("PUT", "/credential-provider", {
          url: `https://product.example/credentials/${index}`,
          workspaceFilter: null,
        }),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const secrets = bodies.filter((body) => body.secret !== undefined).map((body) => body.secret);
    expect(secrets).toHaveLength(1);
    const row = await getOrganizationCredentialProvider(client.db, { accountId });
    expect(
      decryptEnvironmentValue(environmentsEncryptionKeyBytes(settings)!, row!.secretEncrypted),
    ).toBe(secrets[0]);
    await call("DELETE", "/credential-provider");
  });
  test("organization key CRUD preserves signing secrets and nullable filters", async () => {
    const created = await call("PUT", "/credential-provider", {
      url: "https://product.example/credentials",
      workspaceFilter: { externalSource: "product" },
      enabled: false,
      timeoutMs: 2000,
    });
    expect(created.status).toBe(201);
    const first = await created.json();
    expect(first.secret).toMatch(/^ogcp_/);
    expect(first.provider).toMatchObject({
      organizationId: accountId,
      workspaceFilter: { externalSource: "product" },
    });
    const updated = await call("PUT", "/credential-provider", {
      url: "https://product.example/new",
      workspaceFilter: null,
    });
    const second = await updated.json();
    expect(second.secret).toBeUndefined();
    expect(second.provider).toMatchObject({
      workspaceFilter: null,
      enabled: true,
      timeoutMs: 10_000,
    });
    expect(
      (
        await (
          await call("PUT", "/credential-provider", {
            url: "https://product.example/new",
            workspaceFilter: null,
          })
        ).json()
      ).provider.workspaceFilter,
    ).toBeNull();
    const response = await call("POST", "/webhooks", {
      url: "https://receiver.example/events",
      eventTypes: ["turn.completed"],
      workspaceFilter: null,
    });
    expect(response.status).toBe(201);
    const { webhook, secret } = await response.json();
    expect(secret).toMatch(/^whsec_/);
    expect(webhook.organizationId).toBe(accountId);
    const fetched = await call("GET", `/webhooks/${webhook.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(webhook);
    expect(fetched.headers.get("cache-control")).toBe("private, no-store");
    const rotatedProvider = await call("POST", "/credential-provider/rotate-secret");
    expect(rotatedProvider.status).toBe(200);
    const providerRotation = await rotatedProvider.json();
    expect(providerRotation.secret).not.toBe(first.secret);
    const providerRow = await getOrganizationCredentialProvider(client.db, { accountId });
    expect(
      decryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        providerRow!.secretEncrypted,
      ),
    ).toBe(providerRotation.secret);
    expect((await (await call("GET", "/credential-provider")).json()).secret).toBeUndefined();
    const rotatedWebhook = await call("POST", `/webhooks/${webhook.id}/rotate-secret`);
    expect(rotatedWebhook.status).toBe(200);
    const webhookRotation = await rotatedWebhook.json();
    expect(webhookRotation.secret).not.toBe(secret);
    const webhookRow = await getOrganizationWebhook(client.db, {
      accountId,
      webhookId: webhook.id,
    });
    expect(
      decryptEnvironmentValue(
        environmentsEncryptionKeyBytes(settings)!,
        webhookRow!.secretEncrypted,
      ),
    ).toBe(webhookRotation.secret);
    expect((await (await call("GET", `/webhooks/${webhook.id}`)).json()).secret).toBeUndefined();
    expect((await call("GET", `/webhooks/${crypto.randomUUID()}`)).status).toBe(404);
    expect(
      (
        await (
          await call("PATCH", `/webhooks/${webhook.id}`, { workspaceFilter: null, enabled: false })
        ).json()
      ).workspaceFilter,
    ).toBeNull();
    expect(
      (await (await call("GET", `/webhooks/${webhook.id}/deliveries`)).json()).deliveries,
    ).toEqual([]);
    expect((await call("DELETE", `/webhooks/${webhook.id}`)).status).toBe(204);
    expect((await call("GET", `/webhooks/${webhook.id}`)).status).toBe(404);
    expect((await call("DELETE", "/credential-provider")).status).toBe(204);
  });
  test("agent attempts cannot use account admin", async () => {
    const bearer = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId,
      principalKind: "agent_attempt",
      permissions: ["account:admin", "workspace:admin"],
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect((await call("GET", "/webhooks", undefined, bearer)).status).toBe(403);
  });
  test("delegated human account administrators cannot configure organization integrations", async () => {
    const bearer = await signDelegatedAccessToken(delegationSecret, {
      accountId,
      workspaceId,
      subjectId,
      principalKind: "human_session",
      permissions: ["account:admin"],
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(
      (
        await call(
          "PUT",
          "/credential-provider",
          {
            url: "https://product.example/human-credentials",
            workspaceFilter: null,
          },
          bearer,
        )
      ).status,
    ).toBe(403);
    expect((await call("DELETE", "/credential-provider", undefined, bearer)).status).toBe(403);
  });
  test("missing, empty and invalid filters return 422; PATCH cannot be empty", async () => {
    for (const workspaceFilter of [undefined, {}, { externalSource: "" }, { other: "product" }]) {
      const filter = workspaceFilter === undefined ? {} : { workspaceFilter };
      expect(
        (
          await call("PUT", "/credential-provider", {
            url: "https://provider.example",
            ...filter,
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await call("POST", "/webhooks", {
            url: "https://receiver.example",
            eventTypes: ["turn.completed"],
            ...filter,
          })
        ).status,
      ).toBe(422);
    }
    const created = await call("POST", "/webhooks", {
      url: "https://receiver.example",
      eventTypes: ["turn.completed"],
      workspaceFilter: null,
    });
    const { webhook } = await created.json();
    for (const request of [{}, { workspaceFilter: {} }])
      expect((await call("PATCH", `/webhooks/${webhook.id}`, request)).status).toBe(422);
    await call("DELETE", `/webhooks/${webhook.id}`);
    expect((await call("POST", `/webhooks/${webhook.id}/rotate-secret`)).status).toBe(404);
    expect((await call("POST", "/credential-provider/rotate-secret")).status).toBe(404);
  });
});
