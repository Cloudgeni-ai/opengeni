import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { signDelegatedAccessToken, type PluginPreview } from "@opengeni/contracts";
import type { ApiRouteDeps, GitHubSkillSourceClient } from "@opengeni/core";
import {
  bootstrapWorkspace,
  applySkillLifecycle,
  listSkillRecords,
  createDb,
  deleteWorkspace,
  listEnabledMcpCapabilityServers,
  listInstalledApiIntegrations,
  listInstalledPortableSkills,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import { registerPluginRoutes } from "../src/routes/plugins";

const DELEGATION_SECRET = "plugin-route-delegation";
let skillCommit = "a".repeat(40);
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: Hono;
let accountId = "";
let workspaceId = "";
let subjectId = "";
let pluginBVersion = 1;

const skillUrl = "https://github.com/example/capabilities/tree/main/skills/research";

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Plugin Inventory", version: "1.0.0" },
    servers: [{ url: "https://inventory.example.com/v1/" }],
    paths: {
      "/items": {
        get: {
          operationId: "inventory.list",
          responses: { "200": { description: "Items" } },
        },
      },
    },
  };
}

function pluginA() {
  return {
    schemaVersion: 1,
    pluginKey: "example/plugin-a",
    version: "1.0.0",
    name: "Plugin A",
    description: "Skill, API, and configured MCP.",
    components: [
      { key: "research", kind: "skill", url: skillUrl },
      {
        key: "inventory",
        kind: "integration",
        source: { kind: "openapi", url: "https://127.0.0.1/inventory.json" },
      },
      { key: "docs", kind: "mcp", serverId: "docs_mcp" },
    ],
  };
}

function pluginB() {
  return {
    schemaVersion: 1,
    pluginKey: "example/plugin-b",
    version: pluginBVersion === 1 ? "1.0.0" : "2.0.0",
    name: "Plugin B",
    description: "Shared Skill and configured MCP.",
    components:
      pluginBVersion === 1
        ? [
            { key: "research", kind: "skill", url: skillUrl },
            { key: "docs", kind: "mcp", serverId: "docs_mcp" },
          ]
        : [
            { key: "docs", kind: "mcp", serverId: "docs_mcp" },
            { key: "research", kind: "skill", url: skillUrl },
          ],
  };
}

function sharedSkillPlugin(pluginKey: string) {
  return {
    schemaVersion: 1,
    pluginKey,
    version: "1.0.0",
    name: pluginKey,
    description: "Concurrent shared Skill owner.",
    components: [{ key: "research", kind: "skill", url: skillUrl }],
  };
}

function mcpOnlyPlugin(pluginKey: string, serverId: string) {
  return {
    schemaVersion: 1,
    pluginKey,
    version: "1.0.0",
    name: pluginKey,
    description: "Configured MCP reference.",
    components: [{ key: "mcp", kind: "mcp", serverId }],
  };
}

const github: GitHubSkillSourceClient = {
  resolveCommit: async () => skillCommit,
  listTree: async () => [
    { path: "skills/research/SKILL.md", type: "blob", mode: "100644", sha: "skill-md", size: 96 },
    {
      path: "skills/research/references/guide.md",
      type: "blob",
      mode: "100644",
      sha: "guide",
      size: 20,
    },
  ],
  readBlob: async (_owner, _repository, sha) =>
    new TextEncoder().encode(
      sha === "skill-md"
        ? "---\nname: research\ndescription: Research safely.\n---\nUse cited primary sources.\n"
        : "# Guide\nStay bounded.\n",
    ),
};

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_PLUGIN_ROUTE_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_PLUGIN_ROUTE_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_PLUGIN_ROUTE_TEST_POSTGRES_ADMIN_URL and OPENGENI_PLUGIN_ROUTE_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end().catch(() => undefined),
    };
  } else {
    shared = await acquireSharedTestDatabase("plugin-routes");
  }
  if (!shared) {
    available = false;
    console.warn("[plugin-routes] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:plugin-route-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `plugin-route-account-${crypto.randomUUID()}`,
    accountName: "Plugin route account",
    workspaceExternalSource: "test",
    workspaceExternalId: `plugin-route-workspace-${crypto.randomUUID()}`,
    workspaceName: "Plugin route workspace",
    subjectId,
  });
  accountId = access.workspaceGrants[0]!.accountId;
  workspaceId = access.workspaceGrants[0]!.workspaceId;
  app = new Hono();
  registerPluginRoutes(
    app,
    {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret: DELEGATION_SECRET,
        mcpServers: [
          {
            id: "docs_mcp",
            name: "Docs MCP",
            url: "https://docs.example.com/mcp",
            allowedTools: ["search", "read"],
            cacheToolsList: true,
            requireApproval: false,
          },
          {
            id: "header_mcp",
            name: "Header MCP",
            url: "https://headers.example.com/mcp",
            headers: { Authorization: "Bearer never-copy-this" },
            cacheToolsList: false,
          },
          {
            id: "personal_mcp",
            name: "Personal MCP",
            url: "https://personal.example.com/mcp",
            cacheToolsList: false,
            connectionRef: {
              connectionId: "00000000-0000-4000-8000-000000000099",
              providerDomain: "personal.example.com",
              kind: "oauth2",
              subjectScope: "subject",
            },
          },
        ],
      }),
    } as ApiRouteDeps,
    {
      github,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === "https://127.0.0.1/plugin-a.json") return Response.json(pluginA());
        if (url === "https://127.0.0.1/plugin-b.json") return Response.json(pluginB());
        if (url === "https://127.0.0.1/plugin-c.json") {
          return Response.json(sharedSkillPlugin("example/plugin-c"));
        }
        if (url === "https://127.0.0.1/plugin-d.json") {
          return Response.json(sharedSkillPlugin("example/plugin-d"));
        }
        if (url === "https://127.0.0.1/plugin-drift.json") {
          return Response.json(sharedSkillPlugin("example/plugin-drift"));
        }
        if (url === "https://127.0.0.1/plugin-header-mcp.json") {
          return Response.json(mcpOnlyPlugin("example/plugin-header-mcp", "header_mcp"));
        }
        if (url === "https://127.0.0.1/plugin-personal-mcp.json") {
          return Response.json(mcpOnlyPlugin("example/plugin-personal-mcp", "personal_mcp"));
        }
        if (url === "https://127.0.0.1/plugin-missing-mcp.json") {
          return Response.json(mcpOnlyPlugin("example/plugin-missing-mcp", "missing_mcp"));
        }
        if (url === "https://127.0.0.1/inventory.json") {
          return Response.json(openApiDocument());
        }
        return new Response(null, { status: 404 });
      },
    },
  );
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function authorization(): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read", "capabilities:manage"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

async function request(path: string, init: RequestInit = {}) {
  return await app.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: {
      authorization: await authorization(),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function preview(url: string): Promise<PluginPreview> {
  const response = await request("/plugins/preview", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  if (response.status !== 200) {
    throw new Error(`Plugin preview failed: ${response.status} ${await response.text()}`);
  }
  expect(response.status).toBe(200);
  return (await response.json()) as PluginPreview;
}

async function installResponse(url: string, previewed: PluginPreview, idempotencyKey: string) {
  const expectedComponents = previewed.components.map(({ key, digest }) => ({ key, digest }));
  return await request("/plugins/install", {
    method: "POST",
    body: JSON.stringify({
      url,
      expectedManifestDigest: previewed.manifestDigest,
      expectedComponents,
      idempotencyKey,
      ...(previewed.installationVersion
        ? { expectedInstallationVersion: previewed.installationVersion }
        : {}),
    }),
  });
}

async function install(url: string, previewed: PluginPreview, idempotencyKey: string) {
  const response = await installResponse(url, previewed, idempotencyKey);
  if (response.status >= 400) {
    throw new Error(`Plugin install failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

describe("Plugin routes", () => {
  test("installs, shares, updates, resumes idempotently, and safely uninstalls a component BOM", async () => {
    if (!available) return;
    const previewA = await preview("https://127.0.0.1/plugin-a.json");
    expect(previewA).toMatchObject({
      installed: false,
      diff: { added: ["docs", "inventory", "research"], removed: [] },
    });
    expect(previewA.components.map(({ key, kind }) => ({ key, kind }))).toEqual([
      { key: "research", kind: "skill" },
      { key: "inventory", kind: "integration" },
      { key: "docs", kind: "mcp" },
    ]);
    const operationA = crypto.randomUUID();
    const installedA = await install("https://127.0.0.1/plugin-a.json", previewA, operationA);
    expect(installedA.status).toBe(201);
    const installedABody = await installedA.json();
    expect(installedABody).toMatchObject({
      pluginKey: "example/plugin-a",
      version: "1.0.0",
      componentCount: 3,
      status: "installed",
    });
    const listedA = await request("/plugins");
    expect(listedA.status).toBe(200);
    expect(await listedA.json()).toEqual({
      plugins: [
        expect.objectContaining({
          pluginKey: "example/plugin-a",
          version: "1.0.0",
          sourceUrl: "https://127.0.0.1/plugin-a.json",
          manifestDigest: previewA.manifestDigest,
          installationVersion: installedABody.installationVersion,
          componentCount: 3,
          status: "active",
        }),
      ],
    });
    const replayA = await install("https://127.0.0.1/plugin-a.json", previewA, operationA);
    expect(replayA.status).toBe(200);
    expect(await replayA.json()).toEqual(installedABody);
    const currentPreviewA = await preview("https://127.0.0.1/plugin-a.json");
    const missingUpdateFenceA = await request("/plugins/install", {
      method: "POST",
      body: JSON.stringify({
        url: "https://127.0.0.1/plugin-a.json",
        expectedManifestDigest: currentPreviewA.manifestDigest,
        expectedComponents: currentPreviewA.components.map(({ key, digest }) => ({ key, digest })),
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(missingUpdateFenceA.status).toBe(400);
    expect(await missingUpdateFenceA.text()).toBe(
      "Updating a Plugin requires the previewed installation version",
    );
    const reusedOperationA = await installResponse(
      "https://127.0.0.1/plugin-a.json",
      currentPreviewA,
      operationA,
    );
    expect(reusedOperationA.status).toBe(409);
    expect(await reusedOperationA.text()).toBe("Plugin idempotency key was already used");
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);
    expect(await listInstalledApiIntegrations(client.db, workspaceId)).toHaveLength(1);
    expect(
      (await listEnabledMcpCapabilityServers(client.db, workspaceId)).map((server) => server.id),
    ).toEqual(["docs_mcp"]);

    const previewB = await preview("https://127.0.0.1/plugin-b.json");
    const installedB = await install(
      "https://127.0.0.1/plugin-b.json",
      previewB,
      crypto.randomUUID(),
    );
    expect(installedB.status).toBe(201);
    const installedBBody = await installedB.json();

    pluginBVersion = 2;
    skillCommit = "b".repeat(40);
    const updatePreviewB = await preview("https://127.0.0.1/plugin-b.json");
    expect(updatePreviewB.diff).toMatchObject({
      changed: ["research"],
      removed: [],
      unchanged: ["docs"],
    });
    const updateOperationB = crypto.randomUUID();
    const conflictedUpdateB = await installResponse(
      "https://127.0.0.1/plugin-b.json",
      updatePreviewB,
      updateOperationB,
    );
    expect(conflictedUpdateB.status).toBe(409);
    expect(await conflictedUpdateB.text()).toBe(
      "Plugin component research is pinned to another version by an installed owner. Update or remove that owner before retrying with the same idempotency key.",
    );

    const uninstallAPreviewResponse = await request(
      "/plugins/example%2Fplugin-a/uninstall-preview",
    );
    const uninstallAPreview = await uninstallAPreviewResponse.json();
    expect(uninstallAPreview.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "skill", retainedByOtherOwners: true }),
        expect.objectContaining({ kind: "mcp", retainedByOtherOwners: true }),
        expect.objectContaining({ kind: "integration", retainedByOtherOwners: false }),
      ]),
    );
    expect(uninstallAPreview.previewToken).toMatch(/^[0-9a-f]{64}$/);
    expect(
      uninstallAPreview.components.find((item: { kind: string }) => item.kind === "skill"),
    ).toMatchObject({
      disposition: "retained",
      remainingOwners: [{ kind: "plugin", name: "Plugin B" }],
    });
    const uninstallA = await request("/plugins/example%2Fplugin-a", {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: installedABody.installationVersion,
        expectedPreviewToken: uninstallAPreview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(uninstallA.status).toBe(200);
    expect((await uninstallA.json()).retainedComponents).toHaveLength(2);
    expect(await listInstalledApiIntegrations(client.db, workspaceId)).toHaveLength(0);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(0);
    expect(await listEnabledMcpCapabilityServers(client.db, workspaceId)).toHaveLength(0);
    const updatedB = await install(
      "https://127.0.0.1/plugin-b.json",
      updatePreviewB,
      updateOperationB,
    );
    expect(updatedB.status).toBe(200);
    const updatedBBody = await updatedB.json();
    expect(updatedBBody.installationVersion).toBe(installedBBody.installationVersion + 1);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);
    expect(await listEnabledMcpCapabilityServers(client.db, workspaceId)).toHaveLength(1);

    const finalPreview = await (
      await request("/plugins/example%2Fplugin-b/uninstall-preview")
    ).json();
    const finalSkill = finalPreview.components.find(
      (item: { kind: string }) => item.kind === "skill",
    );
    // Keep the database input independent of subsequent receipt assertions.
    const finalSkillId = finalSkill.skillId;
    expect(typeof finalSkillId).toBe("string");
    expect(finalSkill).toMatchObject({
      disposition: "removed",
      retentionReasons: [],
      remainingOwners: [],
    });
    const uninstallB = await request("/plugins/example%2Fplugin-b", {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: updatedBBody.installationVersion,
        expectedPreviewToken: finalPreview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(uninstallB.status).toBe(200);
    expect((await uninstallB.json()).skillReleases).toEqual([
      expect.objectContaining({
        skillId: finalSkillId,
        disposition: "deactivated",
        eventId: expect.any(String),
      }),
    ]);
    expect(
      await listSkillRecords(
        client.db,
        { accountId, workspaceId, subjectId },
        { skillId: finalSkillId },
      ),
    ).toEqual([expect.objectContaining({ status: "inactive", activeRevisionId: null })]);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(0);
    expect(await listInstalledApiIntegrations(client.db, workspaceId)).toHaveLength(0);
    expect(await listEnabledMcpCapabilityServers(client.db, workspaceId)).toHaveLength(0);
    expect(await (await request("/plugins")).json()).toEqual({ plugins: [] });
  }, 120_000);

  test("serializes concurrent Plugins that install one shared component identity", async () => {
    if (!available) return;
    const [previewC, previewD] = await Promise.all([
      preview("https://127.0.0.1/plugin-c.json"),
      preview("https://127.0.0.1/plugin-d.json"),
    ]);
    const [installedCResponse, installedDResponse] = await Promise.all([
      install("https://127.0.0.1/plugin-c.json", previewC, crypto.randomUUID()),
      install("https://127.0.0.1/plugin-d.json", previewD, crypto.randomUUID()),
    ]);
    expect(installedCResponse.status).toBe(201);
    expect(installedDResponse.status).toBe(201);
    const installedC = await installedCResponse.json();
    const installedD = await installedDResponse.json();
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);
    const [sharedPreviewC, sharedPreviewD] = await Promise.all([
      request("/plugins/example%2Fplugin-c/uninstall-preview").then((response) => response.json()),
      request("/plugins/example%2Fplugin-d/uninstall-preview").then((response) => response.json()),
    ]);

    const sharedUninstallKey = crypto.randomUUID();
    const [uninstallC, uninstallD] = await Promise.all([
      request("/plugins/example%2Fplugin-c", {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: installedC.installationVersion,
          idempotencyKey: sharedUninstallKey,
        }),
      }),
      request("/plugins/example%2Fplugin-d", {
        method: "DELETE",
        body: JSON.stringify({
          expectedInstallationVersion: installedD.installationVersion,
          idempotencyKey: sharedUninstallKey,
        }),
      }),
    ]);
    expect([uninstallC.status, uninstallD.status].sort()).toEqual([200, 409]);
    const completedUninstall = uninstallC.status === 200 ? uninstallC : uninstallD;
    const rejectedUninstall = uninstallC.status === 409 ? uninstallC : uninstallD;
    expect((await completedUninstall.json()).retainedComponents).toHaveLength(1);
    expect(await rejectedUninstall.text()).toBe("Plugin idempotency key was already used");
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);

    const retainedPluginKey =
      uninstallC.status === 409 ? "example%2Fplugin-c" : "example%2Fplugin-d";
    const retainedInstallation = uninstallC.status === 409 ? installedC : installedD;
    const staleSharedPreview = uninstallC.status === 409 ? sharedPreviewC : sharedPreviewD;
    const staleOwnerRemoval = await request(`/plugins/${retainedPluginKey}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: retainedInstallation.installationVersion,
        expectedPreviewToken: staleSharedPreview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(staleOwnerRemoval.status).toBe(409);
    const refreshed = await staleOwnerRemoval.json();
    expect(refreshed.code).toBe("plugin_uninstall_preview_changed");
    expect(refreshed.preview.components[0]).toMatchObject({
      disposition: "removed",
      remainingOwners: [],
      retainedByOtherOwners: false,
    });
    const finalUninstall = await request(`/plugins/${retainedPluginKey}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: retainedInstallation.installationVersion,
        expectedPreviewToken: refreshed.preview.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(finalUninstall.status).toBe(200);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(0);
  }, 120_000);

  test("rejects source drift and unsafe configured MCP references before mutation", async () => {
    if (!available) return;
    skillCommit = "c".repeat(40);
    const driftPreview = await preview("https://127.0.0.1/plugin-drift.json");
    skillCommit = "d".repeat(40);
    const driftedInstall = await installResponse(
      "https://127.0.0.1/plugin-drift.json",
      driftPreview,
      crypto.randomUUID(),
    );
    expect(driftedInstall.status).toBe(409);
    expect(await driftedInstall.text()).toBe(
      "A Plugin component changed after preview. Review the updated bill of materials.",
    );
    const driftUninstallPreview = await request(
      "/plugins/example%2Fplugin-drift/uninstall-preview",
    );
    expect(await driftUninstallPreview.json()).toMatchObject({ installed: false, components: [] });
    skillCommit = "b".repeat(40);

    const headerMcp = await request("/plugins/preview", {
      method: "POST",
      body: JSON.stringify({ url: "https://127.0.0.1/plugin-header-mcp.json" }),
    });
    expect(headerMcp.status).toBe(422);
    expect(await headerMcp.text()).toBe(
      "Plugin MCP reference header_mcp cannot copy deployment header credentials",
    );
    const personalMcp = await request("/plugins/preview", {
      method: "POST",
      body: JSON.stringify({ url: "https://127.0.0.1/plugin-personal-mcp.json" }),
    });
    expect(personalMcp.status).toBe(422);
    expect(await personalMcp.text()).toBe(
      "Plugin MCP reference personal_mcp cannot auto-activate a Personal Connection",
    );
    const missingMcp = await request("/plugins/preview", {
      method: "POST",
      body: JSON.stringify({ url: "https://127.0.0.1/plugin-missing-mcp.json" }),
    });
    expect(missingMcp.status).toBe(422);
    expect(await missingMcp.text()).toBe(
      "Plugin references MCP server missing_mcp, which is not configured by this deployment",
    );
  }, 120_000);

  test("fences customization after preview and preserves the named Skill after refreshed confirmation", async () => {
    if (!available) return;
    const source = "https://127.0.0.1/plugin-drift.json";
    const installed = await (
      await install(source, await preview(source), crypto.randomUUID())
    ).json();
    const path = "/plugins/example%2Fplugin-drift";
    const before = await (await request(`${path}/uninstall-preview`)).json();
    const component = before.components[0];
    expect(component).toMatchObject({
      kind: "skill",
      disposition: "removed",
      retainedByOtherOwners: false,
    });
    const serviceAuthorization = `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId,
      workspaceId,
      subjectId,
      permissions: ["workspace:read", "capabilities:manage"],
      principalKind: "service",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}`;
    const forbidden = await request(path, {
      method: "DELETE",
      headers: { authorization: serviceAuthorization },
      body: JSON.stringify({
        expectedInstallationVersion: installed.installationVersion,
        expectedPreviewToken: before.previewToken,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(forbidden.status).toBe(403);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);
    const [record] = await listSkillRecords(
      client.db,
      { accountId, workspaceId, subjectId },
      { skillId: component.skillId },
    );
    expect(record).toBeDefined();
    const files = [
      {
        path: "SKILL.md",
        content:
          "---\nname: my-custom-research\ndescription: User-owned research guidance\n---\nKeep this customized guidance.\n",
      },
    ];
    const customized = await applySkillLifecycle(
      client.db,
      {
        accountId,
        workspaceId,
        actor: { kind: "human", principalKind: "human_session", subjectId },
      },
      {
        operation: "save",
        operationId: crypto.randomUUID(),
        skillId: component.skillId,
        expectedRevisionId: record!.revisionId,
        expectedScopeVersion: record!.scopeVersion,
        files,
        reason: "Customize before removal confirmation",
      },
    );
    const key = crypto.randomUUID();
    const stale = await request(path, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: installed.installationVersion,
        expectedPreviewToken: before.previewToken,
        idempotencyKey: key,
      }),
    });
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    expect(conflict.code).toBe("plugin_uninstall_preview_changed");
    expect(conflict.preview.previewToken).not.toBe(before.previewToken);
    expect(conflict.preview.components[0]).toMatchObject({
      name: "my-custom-research",
      skillId: component.skillId,
      disposition: "retained",
      retentionReasons: ["customized"],
      remainingOwners: [],
      retainedByOtherOwners: false,
    });
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(1);
    const confirmedRequest = {
      expectedInstallationVersion: installed.installationVersion,
      expectedPreviewToken: conflict.preview.previewToken,
      idempotencyKey: key,
    };
    const removed = await request(path, {
      method: "DELETE",
      body: JSON.stringify(confirmedRequest),
    });
    expect(removed.status).toBe(200);
    const receipt = await removed.json();
    expect(receipt.retainedComponents).toEqual([component.capabilityId]);
    expect(receipt.skillReleases).toEqual([
      expect.objectContaining({
        skillId: component.skillId,
        disposition: "preserved",
        revisionId: customized.revisionId,
      }),
    ]);
    expect(
      await listSkillRecords(
        client.db,
        { accountId, workspaceId, subjectId },
        { skillId: component.skillId },
      ),
    ).toEqual([expect.objectContaining({ files })]);
    expect(await listInstalledPortableSkills(client.db, workspaceId)).toHaveLength(0);
    // The failed comparison did not consume the key, and successful replay does
    // not compare against the now-disabled installation or remove the Skill.
    const replay = await request(path, {
      method: "DELETE",
      body: JSON.stringify(confirmedRequest),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
  }, 120_000);
});
