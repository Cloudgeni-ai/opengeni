import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { OrganizationIntegrationDeniedError, signDelegatedAccessToken } from "@opengeni/contracts";
import {
  WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
  WORKSPACE_OPENROUTER_CONNECTION_ROLE,
} from "@opengeni/config";
import { createDb, installApiIntegration, type DbClient } from "@opengeni/db";
import { updateOrganizationIntegrationPolicy } from "@opengeni/db/organization-integration-policy";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerSocialRoutes } from "../src/routes/social";
import { registerIntegrationFacetRoutes } from "../src/routes/integration-facets";

let shared: SharedTestDatabase;
let client: DbClient;
const secret = "direct-policy-delegation-fixture";
const subjectId = "direct-policy-human";
const permissions = [
  "connections:read",
  "connections:write",
  "workspace:read",
  "workspace:admin",
  "capabilities:manage",
] as const;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_INTEGRATION_POLICY_TEST_APP_URL;
  const acquired =
    adminUrl && appUrl
      ? {
          admin: postgres(adminUrl),
          adminUrl,
          appUrl,
          release: async () => {
            await shared.admin.end();
          },
        }
      : await acquireSharedTestDatabase("organization-integration-direct-policy");
  if (!acquired) throw new Error("Direct integration policy tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function fixture(overrides: Partial<ApiRouteDeps> = {}) {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const keyId = crypto.randomUUID();
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Direct policy fixture')`;
  await shared.admin`insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, 'Direct fixture')`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspaceId}, ${accountId})`;
  await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
    values (${accountId}, ${workspaceId}, ${subjectId}, ${subjectId}, 'admin', ${shared.admin.json([...permissions])})`;
  await shared.admin`insert into api_keys (id, account_id, name, credential_kind, prefix, key_hash, permissions)
    values (${keyId}, ${accountId}, 'Policy fixture key', 'organization', 'fixture', ${createHash("sha256").update(crypto.randomUUID()).digest("hex")}, '["workspace:admin"]'::jsonb)`;
  const token = await signDelegatedAccessToken(secret, {
    accountId,
    workspaceId,
    subjectId,
    permissions: [...permissions],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof OrganizationIntegrationDeniedError)
      return c.json({ message: error.message }, 403);
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  const deps = {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: secret,
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      integrationsEnabled: true,
      integrationsStateSecret: "direct-policy-state-fixture",
      slackClientId: "slack-client-fixture",
      slackClientSecret: "slack-secret-fixture",
      slackSigningSecret: "slack-signing-fixture",
    }),
    bus: new MemoryEventBus(),
    ...overrides,
  } as unknown as ApiRouteDeps;
  registerConnectionRoutes(app, deps);
  registerSocialRoutes(app, deps);
  registerIntegrationFacetRoutes(app, deps);
  let revision = 0;
  return {
    accountId,
    workspaceId,
    async restrict(keys: string[] = []) {
      const result = await updateOrganizationIntegrationPolicy(
        client.db,
        { accountId },
        {
          mode: "restricted",
          allowedIntegrationKeys: keys,
          expectedRevision: revision,
          operationId: crypto.randomUUID(),
        },
        async () => ({ accountId, subjectId: `api_key:${keyId}` }),
      );
      revision = result.revision;
    },
    request(path: string, method: string, body?: unknown) {
      return app.request(`/v1/workspaces/${workspaceId}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  };
}

const credential = {
  providerDomain: "service.example",
  kind: "api_key",
  subjectId: null,
  credential: { apiKey: "fixture-only" },
  grantedScopes: ["read"],
  metadata: {},
};

test("unconfigured permits manual acquisition; restricted unknown denies even forged curated/custom metadata", async () => {
  const f = await fixture();
  const created = await f.request("connections", "POST", credential);
  expect(created.status, await created.clone().text()).toBe(201);
  await f.restrict(["gmail", "custom:mcp", "custom:openapi", "custom:graphql"]);
  for (const metadata of [
    {},
    { integrationId: "gmail" },
    { protocol: "mcp", providerId: "mcp-headers" },
    { credentialRole: WORKSPACE_OPENROUTER_CONNECTION_ROLE },
  ]) {
    const denied = await f.request("connections", "POST", { ...credential, metadata });
    expect(denied.status, await denied.text()).toBe(403);
  }
  const rows = await shared.admin`select id from connections where workspace_id = ${f.workspaceId}`;
  expect(rows).toHaveLength(1);
});

test("restricted policy preserves unchanged/reducing edits and revoke, but blocks replacement and added authority", async () => {
  const f = await fixture();
  const created = await f.request("connections", "POST", credential);
  expect(created.status, await created.clone().text()).toBe(201);
  const { connection } = await created.json();
  await f.restrict();
  for (const body of [
    {
      providerDomain: credential.providerDomain,
      kind: credential.kind,
      subjectId: null,
      grantedScopes: ["read"],
    },
    { metadata: { displayName: "Renamed" } },
    { grantedScopes: [] },
  ]) {
    const response = await f.request(`connections/${connection.id}`, "PATCH", body);
    expect(response.status, await response.text()).toBe(200);
  }
  for (const body of [
    { credential: { apiKey: "replacement" } },
    { providerDomain: "replacement.example" },
    { kind: "delegated" },
    { grantedScopes: ["write"] },
    { metadata: { mcpUrl: "https://other.example/mcp" } },
    { metadata: { resource: "https://other.example/" } },
    { subjectId },
    { status: "active", credential: { apiKey: "replacement" } },
  ]) {
    const response = await f.request(`connections/${connection.id}`, "PATCH", body);
    expect(response.status, await response.text()).toBe(403);
  }
  const revoked = await f.request(`connections/${connection.id}`, "DELETE");
  expect(revoked.status, await revoked.text()).toBe(200);
  const [row] =
    await shared.admin`select status, provider_domain, granted_scopes from connections where id = ${connection.id}`;
  expect(row).toMatchObject({
    status: "revoked",
    provider_domain: credential.providerDomain,
    granted_scopes: [],
  });
});

test("canonical workspace model key remains exempt, including exact create receipt replay", async () => {
  const f = await fixture();
  await f.restrict();
  const body = {
    ...credential,
    providerDomain: WORKSPACE_OPENROUTER_CONNECTION_DOMAIN,
    operationId: crypto.randomUUID(),
    metadata: { credentialRole: WORKSPACE_OPENROUTER_CONNECTION_ROLE },
  };
  const created = await f.request("connections", "POST", body);
  expect(created.status, await created.clone().text()).toBe(201);
  const original = await created.json();
  const replay = await f.request("connections", "POST", body);
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect((await replay.json()).connection.id).toBe(original.connection.id);
  const rotation = {
    credential: { apiKey: "fixture-rotated" },
    expectedVersion: original.connection.version,
    operationId: crypto.randomUUID(),
  };
  const rotated = await f.request(`connections/${original.connection.id}`, "PATCH", rotation);
  expect(rotated.status, await rotated.text()).toBe(200);
  const rotationReplay = await f.request(
    `connections/${original.connection.id}`,
    "PATCH",
    rotation,
  );
  expect(rotationReplay.status, await rotationReplay.text()).toBe(200);
  const forged = await f.request("connections", "POST", { ...body, subjectId });
  expect(forged.status, await forged.text()).toBe(403);
});

test("restricted credential edits cannot remove destination binding or extend finite authority", async () => {
  const f = await fixture();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const metadata = { mcpUrl: "https://service.example/mcp", resource: "https://service.example/" };
  const created = await f.request("connections", "POST", { ...credential, metadata, expiresAt });
  expect(created.status, await created.clone().text()).toBe(201);
  const { connection } = await created.json();
  await f.restrict();
  const unchanged = await f.request(`connections/${connection.id}`, "PATCH", {
    metadata,
    expiresAt,
  });
  expect(unchanged.status, await unchanged.text()).toBe(200);
  for (const body of [
    { metadata: {} },
    { expiresAt: null },
    { expiresAt: new Date(Date.now() + 7200_000).toISOString() },
  ]) {
    const denied = await f.request(`connections/${connection.id}`, "PATCH", body);
    expect(denied.status, await denied.text()).toBe(403);
  }
  const reduced = await f.request(`connections/${connection.id}`, "PATCH", {
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  });
  expect(reduced.status, await reduced.text()).toBe(200);
});

test("social acquisition honors exact supported provider keys and cleanup remains available", async () => {
  const f = await fixture();
  await f.restrict(["x"]);
  for (const provider of ["reddit", "custom", "linkedin"]) {
    const denied = await f.request("social/connections", "POST", {
      provider,
      accountHandle: "fixture",
    });
    expect(denied.status, await denied.text()).toBe(403);
  }
  const created = await f.request("social/connections", "POST", {
    provider: "x",
    accountHandle: "fixture",
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const connection = await created.json();
  await f.restrict();
  const denied = await f.request("social/connections", "POST", {
    provider: "x",
    accountHandle: "new",
  });
  expect(denied.status, await denied.text()).toBe(403);
  const removed = await f.request(`social/connections/${connection.id}`, "DELETE");
  expect(removed.status, await removed.text()).toBe(200);
});

test("Fiken direct install rechecks policy after provider verification before credential commit", async () => {
  let tighten = async () => {};
  let exchanges = 0;
  const f = await fixture({
    fikenFetch: (async () => {
      exchanges++;
      await tighten();
      return Response.json([{ slug: "fixture-company", name: "Fixture company" }]);
    }) as typeof fetch,
  });
  tighten = () => f.restrict();
  const response = await f.request("connections/fiken/install", "POST", {
    apiToken: "fixture-only-fiken-token",
  });
  expect(response.status, await response.text()).toBe(403);
  expect(exchanges).toBe(1);
  const rows = await shared.admin`select id from connections where workspace_id = ${f.workspaceId}`;
  expect(rows).toHaveLength(0);
});

test("Slack bot setup uses its dedicated key, never the personal Slack permission", async () => {
  const f = await fixture();
  await f.restrict(["slack-personal"]);
  const denied = await f.request("connections/slack-bot/install", "POST", {});
  expect(denied.status, await denied.text()).toBe(403);
  await f.restrict(["slack-bot"]);
  const allowed = await f.request("connections/slack-bot/install", "POST", {});
  expect(allowed.status, await allowed.text()).toBe(200);
});

async function installFacetFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { definitionId?: string; provenance?: "workspace" | "curated" } = {},
) {
  const definitionId = options.definitionId ?? `direct-facet-${crypto.randomUUID()}`;
  const capabilityId = `api:${definitionId}`;
  const installed = await installApiIntegration(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId,
    capabilityId,
    pluginKey: `integration/${definitionId}`,
    serverId: definitionId.replaceAll("-", "_"),
    name: "Facet fixture",
    description: "Facet policy fixture",
    category: "operations",
    tags: [],
    definitionId,
    definitionProvenance: options.provenance ?? "workspace",
    providerDomain: "facet.example",
    protocol: "openapi",
    baseUrl: "https://facet.example/v1/",
    sourceUrl: "https://facet.example/openapi.json",
    authScheme: { kind: "none" },
    requiredScopes: [],
    ownership: "workspace",
    facetDefinitions: [
      {
        facetKey: "source",
        kind: "knowledge_source",
        configSchema: {
          type: "object",
          properties: { source: { type: "string" } },
          additionalProperties: false,
        },
        capabilities: {},
      },
    ],
    revision: {
      id: `openapi:${"1".repeat(24)}`,
      protocol: "openapi",
      definitionId,
      contentSha256: "1".repeat(64),
      source: { url: "https://facet.example/openapi.json" },
      title: "Facet fixture",
      tools: [
        {
          id: "list_items",
          operationKey: "listItems",
          name: "List items",
          description: "List items",
          inputSchema: { type: "object", properties: {} },
          safety: "read",
          approvalMode: "never",
          deprecated: false,
        },
      ],
      bindings: {
        list_items: {
          method: "get",
          pathTemplate: "/items",
          serverUrl: "https://facet.example/v1/",
          parameters: [],
        },
      },
    },
  });
  return `integrations/${encodeURIComponent(capabilityId)}/instances/${encodeURIComponent(installed.instanceKey)}/facets/source`;
}

test("facet policy admits exact receipts and unchanged bindings, denies new authority and resume, preserves pause/remove", async () => {
  const f = await fixture();
  const path = await installFacetFixture(f);
  const original = {
    displayName: "Fixture source",
    config: { source: "first" },
    idempotencyKey: crypto.randomUUID(),
  };
  const created = await f.request(path, "PUT", original);
  expect(created.status, await created.clone().text()).toBe(201);
  const configured = await created.json();
  await f.restrict();
  const replay = await f.request(path, "PUT", original);
  expect(replay.status, await replay.clone().text()).toBe(201);
  expect((await replay.json()).binding.id).toBe(configured.binding.id);
  const unchanged = await f.request(path, "PUT", {
    ...original,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(unchanged.status, await unchanged.text()).toBe(201);
  // A byte-identical binding without this direct owner is still new authority.
  const directOwner = configured.binding.owners.find(
    (owner: { kind: string }) => owner.kind === "direct",
  );
  await shared.admin`update integration_facet_binding_owners set owner_id = 'other-fixture-owner'
    where binding_id = ${configured.binding.id} and owner_id = ${directOwner.id}`;
  const addedOwner = await f.request(path, "PUT", {
    ...original,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(addedOwner.status, await addedOwner.text()).toBe(403);
  await shared.admin`update integration_facet_binding_owners set owner_id = ${directOwner.id}
    where binding_id = ${configured.binding.id} and owner_id = 'other-fixture-owner'`;
  const changed = await f.request(path, "PUT", {
    ...original,
    config: { source: "second" },
    expectedVersion: configured.binding.version,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(changed.status, await changed.text()).toBe(403);
  const alreadyActive = await f.request(`${path}/resume`, "POST", {
    expectedVersion: configured.binding.version,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(alreadyActive.status, await alreadyActive.text()).toBe(200);
  const pausePayload = {
    expectedVersion: configured.binding.version,
    idempotencyKey: crypto.randomUUID(),
  };
  const paused = await f.request(`${path}/pause`, "POST", pausePayload);
  expect(paused.status, await paused.clone().text()).toBe(200);
  const pausedResult = await paused.json();
  const resume = await f.request(`${path}/resume`, "POST", {
    expectedVersion: pausedResult.binding.version,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(resume.status, await resume.text()).toBe(403);
  const pauseReplay = await f.request(`${path}/pause`, "POST", pausePayload);
  expect(pauseReplay.status, await pauseReplay.text()).toBe(200);
  const removed = await f.request(path, "DELETE", {
    expectedVersion: pausedResult.binding.version,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(removed.status, await removed.text()).toBe(200);
  const reactivated = await f.request(path, "PUT", {
    ...original,
    expectedVersion: pausedResult.binding.version + 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(reactivated.status, await reactivated.text()).toBe(403);
});

test("facet acquisition uses stored API protocol and catalog-validated immutable provenance", async () => {
  const f = await fixture();
  const customPath = await installFacetFixture(f);
  const unknownDefinition = `unknown-curated-${crypto.randomUUID()}`;
  const unknownPath = await installFacetFixture(f, {
    definitionId: unknownDefinition,
    provenance: "curated",
  });
  const curatedPath = await installFacetFixture(f, {
    definitionId: "microsoft-outlook-mail",
    provenance: "curated",
  });
  const payload = () => ({
    displayName: "Protocol fixture",
    config: { source: "one" },
    idempotencyKey: crypto.randomUUID(),
  });
  await f.restrict(["custom:graphql", "custom:mcp", "microsoft-outlook-mail", unknownDefinition]);
  const wrongProtocol = await f.request(customPath, "PUT", payload());
  expect(wrongProtocol.status, await wrongProtocol.text()).toBe(403);
  const knownCurated = await f.request(curatedPath, "PUT", payload());
  expect(knownCurated.status, await knownCurated.text()).toBe(201);
  await f.restrict(["custom:openapi", unknownDefinition]);
  const allowedCustom = await f.request(customPath, "PUT", payload());
  expect(allowedCustom.status, await allowedCustom.text()).toBe(201);
  const forgedCurated = await f.request(unknownPath, "PUT", payload());
  expect(forgedCurated.status, await forgedCurated.text()).toBe(403);
});
