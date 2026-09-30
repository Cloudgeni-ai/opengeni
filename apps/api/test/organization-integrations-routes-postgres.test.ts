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
    permissions: ["account:admin", "workspace:admin"],
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
  test("concurrent first PUT returns exactly one stored signing secret", async () => {
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
    });
    const second = await updated.json();
    expect(second.secret).toBeUndefined();
    expect(second.provider.workspaceFilter).toEqual({ externalSource: "product" });
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
      workspaceFilter: {},
    });
    expect(response.status).toBe(201);
    const { webhook, secret } = await response.json();
    expect(secret).toMatch(/^whsec_/);
    expect(webhook.organizationId).toBe(accountId);
    const fetched = await call("GET", `/webhooks/${webhook.id}`);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(webhook);
    expect(fetched.headers.get("cache-control")).toBe("private, no-store");
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
});
