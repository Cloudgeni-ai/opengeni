import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createConnection,
  createDb,
  deleteWorkspace,
  encryptEnvironmentValue,
  upsertCapabilityCatalogItem,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerCapabilityRoutes } from "../src/routes/capabilities";
import { registerConnectionRoutes } from "../src/routes/connections";

// A person holding only connections:personal connects their own account and
// may turn a reviewed OAuth integration on for personal accounts, nothing more.

const DELEGATION_SECRET = "personal-integration-setup-route-secret";
const encryptionKey = Buffer.alloc(32, 41);
const settings = testSettings({
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: encryptionKey.toString("base64"),
});
const NARROW = ["workspace:read", "sessions:read", "sessions:control", "connections:personal"];

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let workspaceId = "";
let accountId = "";
let subjectId = "";
let ownConnectionId = "";
const reviewedId = `mcp:reviewed-mail-${crypto.randomUUID()}`;
const reviewedServerId = `reviewed_mail_${crypto.randomUUID().replaceAll("-", "")}`;
const reviewedUrl = `https://mail.example/${crypto.randomUUID()}/mcp`;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-personal-integration-setup");
  if (!shared) throw new Error("Real PostgreSQL fixture required");
  client = createDb(shared.appUrl);
  subjectId = `user:personal-setup-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `personal-setup-account-${crypto.randomUUID()}`,
    accountName: "Personal setup account",
    workspaceExternalSource: "test",
    workspaceExternalId: `personal-setup-workspace-${crypto.randomUUID()}`,
    workspaceName: "Personal setup workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  await setMembership(NARROW);
  // A reviewed registry integration: a real-MCP probe and OAuth sign-in.
  await shared.admin`insert into capability_catalog_items
    (id, kind, source, name, endpoint_url, mcp_url, provider_domain, auth_kind, metadata)
    values (${reviewedId}, 'mcp', 'registry', 'Reviewed mail', ${reviewedUrl}, ${reviewedUrl},
      'mail.example', 'oauth2',
      ${JSON.stringify({ mcpServerId: reviewedServerId, mcpProbe: { status: "real" } })}::jsonb)`;
  // The person signed in to their own account first (the card's first step).
  ownConnectionId = (await connection(subjectId, "own")).id;
  app = new Hono();
  const deps = { db: client.db, settings } as ApiRouteDeps;
  registerCapabilityRoutes(app, deps);
  registerConnectionRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  if (workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  if (shared) await shared.admin`delete from capability_catalog_items where id = ${reviewedId}`;
  await client?.close();
  await shared?.release();
}, 60_000);

const credential = (token: string) =>
  encryptEnvironmentValue(
    encryptionKey,
    JSON.stringify({ access_token: token, token_type: "Bearer" }),
  );
const connection = (owner: string | null, token: string) =>
  createConnection(client.db, {
    accountId,
    workspaceId,
    subjectId: owner,
    providerDomain: "mail.example",
    kind: "oauth2",
    credentialEncrypted: credential(token),
    metadata: { mcpUrl: reviewedUrl },
    createdBySubjectId: owner ?? subjectId,
  });

async function setMembership(permissions: string[]) {
  await shared!.admin`update workspace_memberships
    set permissions = ${JSON.stringify(permissions)}::jsonb
    where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
}

async function call(
  method: string,
  path: string,
  options: { permissions?: string[]; body?: unknown } = {},
): Promise<Response> {
  const permissions = options.permissions ?? NARROW;
  await setMembership(permissions);
  const bearer = await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: permissions as never,
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  });
  return await app.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const personalRef = { providerDomain: "mail.example", kind: "oauth2", subjectScope: "subject" };
const enablePath = (id: string) => `/capabilities/${encodeURIComponent(id)}/enable`;

async function installationStatus(id: string): Promise<string | null> {
  const [row] = await shared!.admin<
    { status: string }[]
  >`select status from capability_installations
    where workspace_id = ${workspaceId} and capability_id = ${id}`;
  return row?.status ?? null;
}

describe("enabling with connections:personal", () => {
  test("refuses shared accounts, credentials and anything but a personal binding", async () => {
    for (const body of [
      {},
      { connectionRef: { ...personalRef, subjectScope: "workspace" } },
      { connectionRef: { ...personalRef, connectionId: crypto.randomUUID() } },
      { connectionRef: personalRef, headers: { authorization: "Bearer shared" } },
      { connectionRef: personalRef, config: { region: "eu" } },
      { connectionRef: personalRef, metadata: { note: "x" } },
    ]) {
      const response = await call("POST", enablePath(reviewedId), { body });
      expect(response.status).toBe(403);
    }
    expect(await installationStatus(reviewedId)).toBeNull();
  });

  test("refuses a workspace's own custom MCP server", async () => {
    const customId = `mcp:custom-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(client.db, {
      accountId,
      workspaceId,
      id: customId,
      kind: "mcp",
      source: "manual",
      name: "Custom server",
      endpointUrl: "https://custom.example/mcp",
      metadata: { mcpServerId: `custom_${crypto.randomUUID().replaceAll("-", "")}` },
    });
    const response = await call("POST", enablePath(customId), {
      body: { connectionRef: { ...personalRef, providerDomain: "custom.example" } },
    });
    expect(response.status).toBe(403);
    expect(await installationStatus(customId)).toBeNull();
  });

  test("needs the permission and honours the organization's admins-only choice", async () => {
    const without = await call("POST", enablePath(reviewedId), {
      permissions: ["workspace:read", "sessions:control"],
      body: { connectionRef: personalRef },
    });
    expect(without.status).toBe(403);
    await shared!.admin`insert into organization_integration_policies
      (account_id, mode, allowed_integration_keys, personal_integration_setup, revision)
      values (${accountId}, 'unrestricted', '[]'::jsonb, 'admins', 1)
      on conflict (account_id) do update set personal_integration_setup = 'admins'`;
    try {
      const reserved = await call("POST", enablePath(reviewedId), {
        body: { connectionRef: personalRef },
      });
      expect(reserved.status).toBe(403);
      expect(await reserved.text()).toContain("only admins");
      expect(await installationStatus(reviewedId)).toBeNull();
    } finally {
      await shared!.admin`update organization_integration_policies
        set personal_integration_setup = 'members' where account_id = ${accountId}`;
    }
  });

  test("turns a reviewed OAuth integration on for personal accounts, once", async () => {
    const first = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef },
    });
    expect(first.status).toBe(201);
    const installed = (await first.json()) as { id: string; status: string; config: unknown };
    expect(installed.status).toBe("active");
    expect(installed.config).toMatchObject({ connectionRef: { subjectScope: "subject" } });
    const again = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef },
    });
    expect(again.status).toBeLessThan(300);
    expect(((await again.json()) as { id: string }).id).toBe(installed.id);
  });

  test("never removes, reconfigures or turns back on an installation", async () => {
    const disable = await call("POST", `/capabilities/${encodeURIComponent(reviewedId)}/disable`, {
      body: {},
    });
    expect(disable.status).toBe(403);
    expect(await installationStatus(reviewedId)).toBe("active");
    await shared!.admin`update capability_installations set status = 'disabled'
      where workspace_id = ${workspaceId} and capability_id = ${reviewedId}`;
    const reenable = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef },
    });
    expect(reenable.status).toBe(409);
    expect(await installationStatus(reviewedId)).toBe("disabled");
  });
});

describe("connections with connections:personal", () => {
  test("lists and removes only the caller's own accounts", async () => {
    const someoneElse = await connection(`user:someone-${crypto.randomUUID()}`, "theirs");
    const workspaceShared = await connection(null, "shared");

    for (const path of ["/connections", "/connections/accounts"]) {
      const response = await call("GET", path);
      expect(response.status).toBe(200);
      const ids = ((await response.json()) as { connections: { id: string }[] }).connections.map(
        (entry) => entry.id,
      );
      if (path === "/connections") expect(ids).toContain(ownConnectionId);
      expect(ids).not.toContain(someoneElse.id);
      expect(ids).not.toContain(workspaceShared.id);
    }
    const reader = await call("GET", "/connections", {
      permissions: ["workspace:read", "connections:read"],
    });
    const readerIds = ((await reader.json()) as { connections: { id: string }[] }).connections.map(
      (entry) => entry.id,
    );
    expect(readerIds).toContain(workspaceShared.id);
    expect((await call("GET", "/connections", { permissions: ["workspace:read"] })).status).toBe(
      403,
    );

    const removeShared = await call("DELETE", `/connections/${workspaceShared.id}`);
    expect(removeShared.status).toBe(403);
    const removeOwn = await call("DELETE", `/connections/${ownConnectionId}`);
    expect(removeOwn.status).toBeLessThan(300);
  });
});
