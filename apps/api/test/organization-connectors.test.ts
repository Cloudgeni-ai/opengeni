import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  completeSelfServiceOrganizationSetup,
  createDb,
  createOrganizationApiKey,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { registerOrganizationConnectorRoutes } from "../src/routes/organization-connectors";

// Organization connectors (OR-11) are managed by signed-in organization owners
// and admins only: members, other organizations, organization API keys and
// cross-site writes are refused, and stale or duplicate saves conflict.

let shared: SharedTestDatabase;
let client: DbClient;
const origin = "http://opengeni.test";
const users: string[] = [];
const accounts: string[] = [];
const identities: string[] = [];
type Human = {
  userId: string;
  subjectId: string;
  sessionId: string;
  email: string;
  accountId: string;
};
let owner: Human;
let outsider: Human;

// An API whose key goes in a query parameter, served to the source transport.
const ledgerSourceUrl = "https://127.0.0.1/org-ledger-openapi.json";
const ledgerDocument = {
  openapi: "3.1.0",
  info: { title: "Ledger API", description: "Read and post ledger entries.", version: "1.0.0" },
  servers: [{ url: "https://127.0.0.1/v1/" }],
  components: { securitySchemes: { queryKey: { type: "apiKey", in: "query", name: "api_key" } } },
  security: [{ queryKey: [] }],
  paths: {
    "/entries": {
      get: { operationId: "ledger.listEntries", responses: { "200": { description: "Entries" } } },
      post: {
        operationId: "ledger.postEntry",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "Posted" } },
      },
    },
  },
};
const sourceFetch = async (request: RequestInfo | URL) =>
  String(request) === ledgerSourceUrl
    ? new Response(JSON.stringify(ledgerDocument), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    : new Response(null, { status: 404 });

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-connectors-routes");
  if (!acquired) throw new Error("Organization connector route tests require real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
  owner = await human();
  outsider = await human();
}, 180_000);

afterAll(async () => {
  if (shared) {
    for (const accountId of accounts) {
      await shared.admin`delete from session_tenancy_greenfield_activation_evidence where account_id = ${accountId}`;
      await shared.admin`delete from session_tenancy_activations where account_id = ${accountId}`;
      await shared.admin`delete from self_service_organization_setup_receipts where account_id = ${accountId}`;
      await shared.admin`delete from managed_accounts where id = ${accountId}`;
    }
    for (const userId of users) {
      await shared.admin`delete from canonical_human_identity_operations where actor_auth_user_id = ${userId}`;
      await shared.admin`delete from canonical_human_identity_subjects where auth_user_id = ${userId}`;
      await shared.admin`delete from auth_users where id = ${userId}`;
    }
    for (const identityId of identities) {
      await shared.admin`update canonical_human_identities set active_login_binding_id = null where id = ${identityId}`;
      await shared.admin`delete from canonical_human_login_bindings where identity_id = ${identityId}`;
      await shared.admin`delete from canonical_human_identities where id = ${identityId}`;
    }
  }
  await client?.close();
  await shared?.release();
}, 60_000);

async function human(): Promise<Human> {
  const userId = `org-connectors-${crypto.randomUUID()}`;
  users.push(userId);
  const subjectId = `user:${userId}`;
  const email = `${userId}@example.test`;
  await shared.admin`insert into auth_users (id, name, email, email_verified) values (${userId}, 'Connector fixture', ${email}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: subjectId,
    organizationName: "Connector fixture",
    operationId: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
  });
  accounts.push(setup.organizationId);
  await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id) values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  identities.push(identity.identityId);
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared.admin`insert into auth_sessions (id, user_id, token, expires_at, identity_id, identity_revision, auth_revision)
    values (${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour', ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
  return { userId, subjectId, email, sessionId, accountId: setup.organizationId };
}

function app(actor = owner): Hono {
  const application = new Hono();
  application.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
    throw error;
  });
  const deps = {
    db: client.db,
    settings: testSettings({
      productAccessMode: "managed",
      publicBaseUrl: origin,
      betterAuthSecret: "organization-connectors-cookie-secret-at-least-32-bytes",
      delegationSecret: "organization-connectors-delegation",
      environmentsEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
    }),
    managedAuth: {
      api: {
        getSession: async () => ({
          headers: new Headers(),
          response: {
            session: { id: actor.sessionId },
            user: {
              id: actor.userId,
              email: actor.email,
              name: "Connector fixture",
              emailVerified: true,
            },
          },
        }),
      },
    } as never,
    apiIntegrationSourceFetch: sourceFetch as typeof fetch,
  } as ApiRouteDeps;
  registerOrganizationConnectorRoutes(application, deps);
  return application;
}

const path = (accountId = owner.accountId) => `${origin}/v1/organizations/${accountId}/connectors`;
const browser = () => ({
  cookie: "session=present",
  host: "opengeni.test",
  "content-type": "application/json",
  origin,
  "sec-fetch-site": "same-origin",
});
const create = (name = `Docs ${crypto.randomUUID().slice(0, 8)}`) => ({
  custom: {
    name,
    endpointUrl: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example.test/mcp`,
  },
  login: "each_person",
  availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
});
async function setRole(role: "owner" | "admin" | "member") {
  await shared.admin`update organization_memberships set role = ${role}
    where account_id = ${owner.accountId} and subject_id = ${owner.subjectId}`;
}
async function connectorCount(accountId = owner.accountId) {
  const [row] =
    await shared.admin`select count(*)::int as count from organization_connectors where account_id = ${accountId}`;
  return Number(row!.count);
}

test("an owner or admin adds, lists, changes and removes a connector", async () => {
  const application = app();
  const empty = await application.request(path(), { headers: browser() });
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("private, no-store");

  const body = create("Team docs");
  const created = await application.request(path(), {
    method: "POST",
    headers: browser(),
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(201);
  const connector = await created.json();
  expect(connector).toMatchObject({
    organizationId: owner.accountId,
    name: "Team docs",
    source: "custom",
    login: "each_person",
    headerNames: [],
    status: "active",
    available: true,
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
  });
  // The same connector once per organization.
  expect(
    (
      await application.request(path(), {
        method: "POST",
        headers: browser(),
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(409);

  const listed = await (await application.request(path(), { headers: browser() })).json();
  expect(listed.connectors.map((row: { id: string }) => row.id)).toContain(connector.id);

  const patch = (payload: Record<string, unknown>) =>
    application.request(`${path()}/${connector.id}`, {
      method: "PATCH",
      headers: browser(),
      body: JSON.stringify(payload),
    });
  expect(
    (await patch({ expectedGeneration: connector.generation + 1, status: "disabled" })).status,
  ).toBe(409);
  // Only an organization-key connector has headers to replace.
  expect(
    (
      await patch({
        expectedGeneration: connector.generation,
        headers: { Authorization: "Bearer x" },
      })
    ).status,
  ).toBe(422);
  await setRole("admin");
  try {
    const changed = await patch({
      expectedGeneration: connector.generation,
      availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
      allowedTools: ["search"],
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      generation: connector.generation + 1,
      allowedTools: ["search"],
      availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    });
  } finally {
    await setRole("owner");
  }

  const remove = () =>
    application.request(`${path()}/${connector.id}`, { method: "DELETE", headers: browser() });
  expect((await remove()).status).toBe(204);
  expect((await remove()).status).toBe(404);
});

test("an invalid connector or a workspace from elsewhere is refused before saving", async () => {
  const application = app();
  const before = await connectorCount();
  for (const body of [
    {
      login: "each_person",
      availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
    },
    { ...create(), login: "each_person", headers: { Authorization: "Bearer x" } },
  ])
    expect(
      (
        await application.request(path(), {
          method: "POST",
          headers: browser(),
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(422);
  const elsewhere = await application.request(path(), {
    method: "POST",
    headers: browser(),
    body: JSON.stringify({
      ...create(),
      availability: { allowedWorkspaceIds: [crypto.randomUUID()], allowPersonalWorkspaces: false },
    }),
  });
  expect(elsewhere.status).toBe(422);
  expect(await connectorCount()).toBe(before);
});

test("members, other organizations and cross-site writes are refused", async () => {
  const before = await connectorCount();
  await setRole("member");
  try {
    expect((await app().request(path(), { headers: browser() })).status).toBe(403);
    expect(
      (
        await app().request(path(), {
          method: "POST",
          headers: browser(),
          body: JSON.stringify(create()),
        })
      ).status,
    ).toBe(403);
  } finally {
    await setRole("owner");
  }
  expect((await app(outsider).request(path(), { headers: browser() })).status).toBe(403);
  for (const replacement of [
    { origin: "https://attacker.example" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
  ])
    expect(
      (
        await app().request(path(), {
          method: "POST",
          headers: { ...browser(), ...replacement },
          body: JSON.stringify(create()),
        })
      ).status,
    ).toBe(403);
  expect(await connectorCount()).toBe(before);
});

test("organization API keys don't manage organization connectors", async () => {
  const token = crypto.randomUUID();
  await createOrganizationApiKey(client.db, {
    accountId: owner.accountId,
    name: "Connector service",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: ["workspace:admin"],
  });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  expect((await app().request(path(), { headers })).status).toBe(403);
  expect(
    (await app().request(path(), { method: "POST", headers, body: JSON.stringify(create()) }))
      .status,
  ).toBe(403);
});

test("an owner previews an API integration and adds it with an organization key", async () => {
  const application = app();
  const source = { kind: "openapi", url: ledgerSourceUrl };
  const previewed = await application.request(`${path()}/api-integrations/preview`, {
    method: "POST",
    headers: browser(),
    body: JSON.stringify({ source }),
  });
  expect(previewed.status).toBe(200);
  const preview = await previewed.json();
  expect(preview).toMatchObject({
    protocol: "openapi",
    auth: { kind: "api_key", carrier: "query", name: "api_key" },
    connectionId: null,
  });
  expect(preview.tools.length).toBe(2);
  const body = (overrides: Record<string, unknown> = {}) => ({
    apiIntegration: {
      source,
      expectedRevisionId: preview.revisionId,
      expectedContentSha256: preview.contentSha256,
    },
    login: "organization_key",
    apiKey: [{ carrier: "query", name: "api_key", value: "org-secret-1" }],
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: false },
    ...overrides,
  });
  const post = (payload: Record<string, unknown>) =>
    application.request(path(), {
      method: "POST",
      headers: browser(),
      body: JSON.stringify(payload),
    });

  // A stale preview, a sign-in the API can't use or an unknown tool is refused before saving.
  const before = await connectorCount();
  const stale = {
    apiIntegration: {
      source,
      expectedRevisionId: "openapi:stale",
      expectedContentSha256: "0".repeat(64),
    },
  };
  expect((await post(body(stale))).status).toBe(409);
  expect((await post(body({ login: "none", apiKey: undefined }))).status).toBe(422);
  expect((await post(body({ allowedTools: ["not_a_tool"] }))).status).toBe(422);
  // The key is never sent somewhere the protocol forbids.
  expect(
    (await post(body({ apiKey: [{ carrier: "header", name: "Host", value: "x" }] }))).status,
  ).toBe(422);
  expect(await connectorCount()).toBe(before);

  const created = await post(body());
  expect(created.status).toBe(201);
  const connector = await created.json();
  expect(connector).toMatchObject({
    kind: "api",
    capabilityId: preview.capabilityId,
    name: preview.name,
    endpointUrl: preview.baseUrl,
    source: "custom",
    login: "organization_key",
    headerNames: ["api_key"],
    allowedTools: null,
    available: true,
    apiIntegration: {
      definitionId: preview.definitionId,
      protocol: "openapi",
      auth: { kind: "api_key", carrier: "query", name: "api_key" },
      revisionId: preview.revisionId,
      contentSha256: preview.contentSha256,
    },
  });
  expect(JSON.stringify(connector)).not.toContain("org-secret-1");
  const [stored] = await shared.admin<{ kind: string; config: unknown }[]>`
    select kind, config from organization_connectors where id = ${connector.id}`;
  expect(stored!.kind).toBe("api");
  expect(JSON.stringify(stored!.config)).not.toContain("org-secret-1");
  const listed = await (await application.request(path(), { headers: browser() })).json();
  expect(listed.connectors.find((row: { id: string }) => row.id === connector.id)).toMatchObject({
    kind: "api",
    login: "organization_key",
  });

  const patch = (payload: Record<string, unknown>) =>
    application.request(`${path()}/${connector.id}`, {
      method: "PATCH",
      headers: browser(),
      body: JSON.stringify(payload),
    });
  // An API integration's key replaces as a key, never as MCP headers.
  expect(
    (await patch({ expectedGeneration: connector.generation, headers: { Authorization: "x" } }))
      .status,
  ).toBe(422);
  expect(
    (await patch({ expectedGeneration: connector.generation, allowedTools: ["not_a_tool"] }))
      .status,
  ).toBe(422);
  const replaced = await patch({
    expectedGeneration: connector.generation,
    apiKey: [{ carrier: "query", name: "api_key", value: "org-secret-2" }],
  });
  expect(replaced.status).toBe(200);
  expect(await replaced.json()).toMatchObject({
    generation: connector.generation + 1,
    headerNames: ["api_key"],
  });
  const [rekeyed] = await shared.admin<{ config: unknown }[]>`
    select config from organization_connectors where id = ${connector.id}`;
  expect(JSON.stringify(rekeyed!.config)).not.toContain("org-secret-2");
  expect(
    (
      await application.request(`${path()}/${connector.id}`, {
        method: "DELETE",
        headers: browser(),
      })
    ).status,
  ).toBe(204);
});

test("members can't preview an API integration for the organization", async () => {
  await setRole("member");
  try {
    const previewed = await app().request(`${path()}/api-integrations/preview`, {
      method: "POST",
      headers: browser(),
      body: JSON.stringify({ source: { kind: "openapi", url: ledgerSourceUrl } }),
    });
    expect(previewed.status).toBe(403);
  } finally {
    await setRole("owner");
  }
});
