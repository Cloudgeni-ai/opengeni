import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  mcpServerIdForCapability,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import { Hono } from "hono";
import { registerApiIntegrationRoutes } from "../src/routes/api-integrations";
import { registerCapabilityRoutes } from "../src/routes/capabilities";
import { registerIntegrationFacetRoutes } from "../src/routes/integration-facets";
import { registerPluginRoutes } from "../src/routes/plugins";

// A member (connections:write, no capabilities:manage) adds integrations:
// custom MCP servers, catalog integrations that are not on yet, plugins and
// API integrations. Tool approval, changing what is already on and turning an
// integration off for everyone stay with integration admins.

const DELEGATION_SECRET = "member-integration-setup-route-secret";
const settings = testSettings({
  delegationSecret: DELEGATION_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 43).toString("base64"),
});
const MEMBER = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
  "connections:read",
  "connections:write",
];
const READER = ["workspace:read", "sessions:read", "connections:read"];

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let workspaceId = "";
let accountId = "";
let subjectId = "";
const reviewedId = `mcp:member-reviewed-${crypto.randomUUID()}`;
const reviewedServerId = `member_reviewed_${crypto.randomUUID().replaceAll("-", "")}`;
const reviewedUrl = `https://reviewed.example/${crypto.randomUUID()}/mcp`;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-member-integration-setup");
  if (!shared) throw new Error("Real PostgreSQL fixture required");
  client = createDb(shared.appUrl);
  subjectId = `user:member-setup-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `member-setup-account-${crypto.randomUUID()}`,
    accountName: "Member setup account",
    workspaceExternalSource: "test",
    workspaceExternalId: `member-setup-workspace-${crypto.randomUUID()}`,
    workspaceName: "Member setup workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  accountId = grant.accountId;
  // A reviewed OAuth integration whose catalog entry asks before every tool.
  await shared.admin`insert into capability_catalog_items
    (id, kind, source, name, endpoint_url, mcp_url, provider_domain, auth_kind, metadata)
    values (${reviewedId}, 'mcp', 'registry', 'Reviewed tools', ${reviewedUrl}, ${reviewedUrl},
      'reviewed.example', 'oauth2',
      ${JSON.stringify({ mcpServerId: reviewedServerId, mcpProbe: { status: "real" }, requireApproval: true })}::jsonb)`;
  app = new Hono();
  const deps = { db: client.db, settings } as ApiRouteDeps;
  registerCapabilityRoutes(app, deps);
  registerApiIntegrationRoutes(app, deps);
  registerIntegrationFacetRoutes(app, deps);
  registerPluginRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  if (workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  if (shared) await shared.admin`delete from capability_catalog_items where id = ${reviewedId}`;
  await client?.close();
  await shared?.release();
}, 60_000);

async function call(
  method: string,
  path: string,
  options: { permissions?: string[]; body?: unknown } = {},
): Promise<Response> {
  const permissions = options.permissions ?? MEMBER;
  await shared!.admin`update workspace_memberships
    set permissions = ${JSON.stringify(permissions)}::jsonb
    where workspace_id = ${workspaceId} and subject_id = ${subjectId}`;
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

async function withAdminsOnlyPolicy(run: () => Promise<void>): Promise<void> {
  await shared!.admin`insert into organization_integration_policies
    (account_id, mode, allowed_integration_keys, personal_integration_setup, revision)
    values (${accountId}, 'unrestricted', '[]'::jsonb, 'admins', 1)
    on conflict (account_id) do update set personal_integration_setup = 'admins'`;
  try {
    await run();
  } finally {
    await shared!.admin`update organization_integration_policies
      set personal_integration_setup = 'members' where account_id = ${accountId}`;
  }
}

async function catalogRow(id: string) {
  const [row] = await shared!.admin<{ endpoint_url: string | null; name: string }[]>`
    select endpoint_url, name from capability_catalog_items
    where workspace_id = ${workspaceId} and id = ${id}`;
  return row ?? null;
}

async function installationStatus(id: string): Promise<string | null> {
  const [row] = await shared!.admin<{ status: string }[]>`
    select status from capability_installations
    where workspace_id = ${workspaceId} and capability_id = ${id}`;
  return row?.status ?? null;
}

const enablePath = (id: string) => `/capabilities/${encodeURIComponent(id)}/enable`;
const personalRef = { providerDomain: "reviewed.example", kind: "oauth2", subjectScope: "subject" };

describe("members add custom MCP servers", () => {
  test("a member adds a new server; a reader can't", async () => {
    const id = `mcp:member-custom-${crypto.randomUUID()}`;
    const body = { id, kind: "mcp", name: "Team tools", endpointUrl: "https://tools.example/mcp" };
    expect((await call("POST", "/capabilities", { permissions: READER, body })).status).toBe(403);
    expect(await catalogRow(id)).toBeNull();
    const created = await call("POST", "/capabilities", { body });
    expect(created.status).toBe(201);
    expect(await catalogRow(id)).toMatchObject({ endpoint_url: "https://tools.example/mcp" });
    // Adding the same server again is harmless and changes nothing.
    const again = await call("POST", "/capabilities", { body: { ...body, name: "Renamed" } });
    expect(again.status).toBe(201);
    expect(await catalogRow(id)).toMatchObject({ name: "Team tools" });
  });

  test("a member never rewrites or shadows an existing connection", async () => {
    const id = `mcp:member-owned-${crypto.randomUUID()}`;
    const body = { id, kind: "mcp", name: "Owned", endpointUrl: "https://owned.example/mcp" };
    expect((await call("POST", "/capabilities", { body })).status).toBe(201);
    const moved = await call("POST", "/capabilities", {
      body: { ...body, endpointUrl: "https://attacker.example/mcp" },
    });
    expect(moved.status).toBe(409);
    expect(await catalogRow(id)).toMatchObject({ endpoint_url: "https://owned.example/mcp" });
    // A reviewed catalog entry can't be replaced by a workspace copy.
    const shadow = await call("POST", "/capabilities", {
      body: {
        id: reviewedId,
        kind: "mcp",
        name: "Shadow",
        endpointUrl: "https://attacker.example/mcp",
      },
    });
    expect(shadow.status).toBe(409);
    expect(await catalogRow(reviewedId)).toBeNull();
    // Nor take the tool ID another connection runs under.
    const takenId = `mcp:member-taken-${crypto.randomUUID()}`;
    const adminServer = await call("POST", "/capabilities", {
      permissions: [...MEMBER, "capabilities:manage"],
      body: {
        id: `mcp:admin-${crypto.randomUUID()}`,
        kind: "mcp",
        name: "Admin tools",
        endpointUrl: "https://admin.example/mcp",
        metadata: { mcpServerId: mcpServerIdForCapability(takenId, {}) },
      },
    });
    expect(adminServer.status).toBe(201);
    const sameServer = await call("POST", "/capabilities", {
      body: {
        id: takenId,
        kind: "mcp",
        name: "Same tools",
        endpointUrl: "https://attacker.example/mcp",
      },
    });
    expect(sameServer.status).toBe(409);
    expect(await catalogRow(takenId)).toBeNull();
    const chosenServer = await call("POST", "/capabilities", {
      body: {
        id: `mcp:member-chosen-${crypto.randomUUID()}`,
        kind: "mcp",
        name: "Chosen",
        endpointUrl: "https://attacker.example/mcp",
        metadata: { mcpServerId: reviewedServerId },
      },
    });
    expect(chosenServer.status).toBe(403);
    // An admin still changes it.
    const admin = await call("POST", "/capabilities", {
      permissions: [...MEMBER, "capabilities:manage"],
      body: { ...body, endpointUrl: "https://moved.example/mcp" },
    });
    expect(admin.status).toBe(201);
    expect(await catalogRow(id)).toMatchObject({ endpoint_url: "https://moved.example/mcp" });
  });
});

describe("members turn on integrations that are not on yet", () => {
  test("tool approval stays with admins", async () => {
    for (const requireApproval of [false, ["only-this-tool"]]) {
      const response = await call("POST", enablePath(reviewedId), {
        body: { connectionRef: personalRef, config: { requireApproval } },
      });
      expect(response.status).toBe(403);
    }
    expect(await installationStatus(reviewedId)).toBeNull();
  });

  test("the organization can keep turning integrations on for admins", async () => {
    await withAdminsOnlyPolicy(async () => {
      const enable = await call("POST", enablePath(reviewedId), {
        body: { connectionRef: personalRef },
      });
      expect(enable.status).toBe(403);
      expect(await installationStatus(reviewedId)).toBeNull();
      const id = `mcp:member-blocked-${crypto.randomUUID()}`;
      const create = await call("POST", "/capabilities", {
        body: { id, kind: "mcp", name: "Blocked", endpointUrl: "https://blocked.example/mcp" },
      });
      expect(create.status).toBe(403);
      expect(await catalogRow(id)).toBeNull();
      const install = await call("POST", "/integrations/install", {
        body: {
          source: { kind: "definition", definitionId: "google-drive" },
          expectedRevisionId: "rev",
          expectedContentSha256: "a".repeat(64),
        },
      });
      expect(install.status).toBe(403);
      expect(await install.text()).toContain("only admins");
    });
  });

  test("a member turns one on, once, and can't turn it off or back on", async () => {
    const first = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef },
    });
    expect(first.status).toBe(201);
    const installed = (await first.json()) as { id: string; status: string; config: unknown };
    expect(installed.status).toBe("active");
    // Already on: the member's request changes nothing.
    const again = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef, metadata: { note: "changed" } },
    });
    expect(again.status).toBeLessThan(300);
    const unchanged = (await again.json()) as { id: string; config: unknown; metadata: unknown };
    expect(unchanged.id).toBe(installed.id);
    expect(unchanged.config).toEqual(installed.config);
    expect(unchanged.metadata).not.toMatchObject({ note: "changed" });

    const disable = await call("POST", `/capabilities/${encodeURIComponent(reviewedId)}/disable`, {
      body: {},
    });
    expect(disable.status).toBe(403);
    expect(await installationStatus(reviewedId)).toBe("active");
    const permissions = await call(
      "PATCH",
      `/capabilities/${encodeURIComponent(reviewedId)}/tool-permissions`,
      { body: {} },
    );
    expect(permissions.status).toBe(403);

    await shared!.admin`update capability_installations set status = 'disabled'
      where workspace_id = ${workspaceId} and capability_id = ${reviewedId}`;
    const reenable = await call("POST", enablePath(reviewedId), {
      body: { connectionRef: personalRef },
    });
    expect(reenable.status).toBe(409);
    expect(await installationStatus(reviewedId)).toBe("disabled");
  });
});

describe("members reach plugin, API integration and source routes", () => {
  // An invalid body gets past the access check to validation (400); a reader
  // is refused first (403).
  const routes: [string, string][] = [
    ["POST", "/plugins/install"],
    ["DELETE", "/plugins/example%2Fplugin"],
    ["POST", "/integrations/install"],
    ["DELETE", "/integrations/api%3Aintegration%3Ax/instances/default"],
    ["PUT", "/integrations/api%3Aintegration%3Ax/instances/default/facets/files"],
    ["DELETE", "/integrations/api%3Aintegration%3Ax/instances/default/facets/files"],
  ];
  test.each(routes)("%s %s", async (method, path) => {
    const reader = await call(method, path, { permissions: READER, body: { invalid: true } });
    expect(reader.status).toBe(403);
    const member = await call(method, path, { body: { invalid: true } });
    expect(member.status).not.toBe(403);
    expect(member.status).toBeGreaterThanOrEqual(400);
  });
});
