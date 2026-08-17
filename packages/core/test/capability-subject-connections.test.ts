import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { CapabilityCatalogItem, type AccessGrant } from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createSocialConnection,
  enableCapabilityInstallation,
  encryptEnvironmentValue,
  getCapabilityInstallation,
  listEnabledMcpCapabilityServers,
  upsertCapabilityCatalogItem,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  applyCapabilityEnablement,
  buildCapabilityCatalog,
  codexAppsCatalogItem,
  enableCapability,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let db: Database;
let settings: Settings;
let encryptionKey: Uint8Array;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_CORE_CAPABILITIES_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_CORE_CAPABILITIES_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_CORE_CAPABILITIES_TEST_POSTGRES_ADMIN_URL and OPENGENI_CORE_CAPABILITIES_TEST_POSTGRES_APP_URL must be set together",
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
    shared = await acquireSharedTestDatabase("core-capability-subject-connections");
  }
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("[capability-subject-connections] PostgreSQL is required but unavailable");
    }
    console.warn("[capability-subject-connections] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
  settings = testSettings({
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
  }) as Settings;
  encryptionKey = environmentsEncryptionKeyBytes(settings)!;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('capability subject acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'capability subject ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function grant(
  workspace: { accountId: string; workspaceId: string },
  subjectId: string,
): AccessGrant {
  return {
    ...workspace,
    subjectId,
    permissions: ["capabilities:read", "capabilities:write"],
    metadata: {},
  };
}

function encryptedFixture(): string {
  return encryptEnvironmentValue(encryptionKey, JSON.stringify({ fixture: true }));
}

async function createMcpCapability(
  workspace: { accountId: string; workspaceId: string },
  id: string,
  overrides: { endpointUrl?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  await upsertCapabilityCatalogItem(db, {
    ...workspace,
    id,
    kind: "mcp",
    source: "manual",
    name: id,
    description: "Subject-isolation fixture",
    category: "integrations",
    tags: ["fixture"],
    endpointUrl: overrides.endpointUrl ?? "https://mcp.slack.com/mcp",
    authModel: "credential_ref",
    metadata: { mcpServerId: `${id}-runtime`, ...overrides.metadata },
  });
}

describe("subject-owned capability connection references", () => {
  test("projects Codex Apps with truthful designation state without generic built-in widening", () => {
    const availableItem = codexAppsCatalogItem(true);
    expect(availableItem).toMatchObject({
      id: "mcp:codex_apps",
      surfaceType: "codex_apps",
      enabled: true,
      runtime: { available: true, mcpServerId: "codex_apps" },
      enabledReason: "designated Apps credential",
    });
    expect(applyCapabilityEnablement(availableItem, undefined, new Set())).toMatchObject({
      enabled: true,
      enabledReason: "designated Apps credential",
    });

    const unavailableItem = codexAppsCatalogItem(false);
    expect(unavailableItem).toMatchObject({
      enabled: false,
      enabledReason: "no active Apps designation",
      runtime: { available: false, notes: expect.stringContaining("active Codex Apps credential") },
    });
    expect(unavailableItem.runtime.mcpServerId).toBeUndefined();
    expect(applyCapabilityEnablement(unavailableItem, undefined, new Set())).toMatchObject({
      enabled: false,
      enabledReason: "no active Apps designation",
    });
  });

  test("does not publish Personal Slack as a built-in catalog capability", async () => {
    const source = await Bun.file(new URL("../src/domain/capabilities.ts", import.meta.url)).text();
    expect(source).not.toContain('id: "mcp:personal-slack"');
    expect(source).not.toContain("personalSlackMcpCatalogItem");
  });

  test("does not mistake a browseable social provider integration for a connection", () => {
    const item = CapabilityCatalogItem.parse({
      id: "api:x",
      kind: "api",
      source: "built_in",
      name: "X",
      category: "social-media",
      surfaceType: "provider_integration",
      enabled: false,
      enabledReason: null,
      metadata: {
        providerAdapter: "social",
        provider: "x",
        connectionCounts: { connected: 0, needsReauth: 0, disabled: 0, total: 0 },
      },
    });
    expect(applyCapabilityEnablement(item, undefined, new Set())).toMatchObject({
      enabled: false,
      enabledReason: null,
      connectionRef: null,
    });
  });

  test("does not treat built-in provenance as lifecycle enablement", () => {
    const item = CapabilityCatalogItem.parse({
      id: "plugin:platform-example",
      kind: "plugin",
      source: "built_in",
      name: "Platform example",
      category: "examples",
      runtime: { available: true },
    });
    expect(applyCapabilityEnablement(item, undefined, new Set())).toMatchObject({
      enabled: false,
      enabledReason: null,
      connectionRef: null,
    });
  });

  test("keeps native runtime surfaces out of the catalog and marks external config as managed", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const catalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings: {
        ...settings,
        mcpServers: [
          { id: "opengeni", name: "OpenGeni", url: "http://localhost:8000/mcp" },
          { id: "files", name: "Files", url: "http://localhost:8000/mcp/files" },
          { id: "docs", name: "Document Search", url: "http://localhost:8000/mcp/docs" },
          {
            id: "team-search",
            name: "Team Search",
            url: "https://search.example.test/mcp",
          },
        ],
      },
    });

    const ids = new Set(catalog.items.map((item) => item.id));
    for (const nativeId of [
      "mcp:opengeni",
      "mcp:files",
      "mcp:docs",
      "api:github-app",
      "api:documents",
      "api:social",
      "api:scheduled-tasks",
    ]) {
      expect(ids.has(nativeId)).toBe(false);
    }
    expect(catalog.items.find((item) => item.id === "skill:terraform-style-guide")).toMatchObject({
      source: "library",
      enabled: false,
      lifecycle: { status: "available", readiness: "setup_required" },
      actions: ["install", "inspect"],
    });
    expect(catalog.items.find((item) => item.id === "skill:social-media-marketing")).toMatchObject({
      source: "library",
      enabled: false,
      lifecycle: { status: "available", readiness: "setup_required" },
      actions: ["install", "inspect"],
    });
    expect(catalog.items.find((item) => item.id === "mcp:team-search")).toMatchObject({
      source: "configured",
      enabled: true,
      enabledReason: "managed by deployment",
      lifecycle: {
        status: "managed",
        readiness: "ready",
        managedBy: "deployment",
      },
      actions: ["inspect"],
    });
  });

  test("publishes X and Reddit as multi-account provider integrations with truthful state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const disconnectedCatalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    expect(disconnectedCatalog.items.find((item) => item.id === "api:x")).toMatchObject({
      kind: "api",
      surfaceType: "provider_integration",
      enabled: false,
      lifecycle: { status: "available", readiness: "setup_required", managedBy: null },
      metadata: {
        providerAdapter: "social",
        provider: "x",
        connectionCounts: { connected: 0, needsReauth: 0, disabled: 0, total: 0 },
      },
      tools: [{ kind: "mcp", id: "opengeni" }],
    });
    expect(disconnectedCatalog.items.find((item) => item.id === "api:reddit")).toMatchObject({
      surfaceType: "provider_integration",
      enabled: false,
      metadata: { providerAdapter: "social", provider: "reddit" },
    });

    const connected = await createSocialConnection(db, {
      ...workspace,
      provider: "x",
      accountHandle: "opengeni",
      externalAccountId: "x-opengeni",
      status: "connected",
      scopes: ["tweet.read", "users.read"],
    });
    const needsReauth = await createSocialConnection(db, {
      ...workspace,
      provider: "x",
      accountHandle: "opengeni_support",
      externalAccountId: "x-opengeni-support",
      status: "needs_reauth",
      scopes: ["tweet.read", "users.read"],
    });
    const disabled = await createSocialConnection(db, {
      ...workspace,
      provider: "x",
      accountHandle: "opengeni_archive",
      externalAccountId: "x-opengeni-archive",
      status: "disabled",
      scopes: ["tweet.read", "users.read"],
    });
    const connectedCatalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    expect(connectedCatalog.items.find((item) => item.id === "api:x")).toMatchObject({
      // Connections own account state. The browseable Integration Definition
      // must not become a second, generic enablement authority.
      enabled: false,
      enabledReason: null,
      lifecycle: { status: "needs_attention", readiness: "attention", managedBy: null },
      actions: ["repair", "connect", "disconnect", "inspect"],
      metadata: {
        connectionCounts: { connected: 1, needsReauth: 1, disabled: 1, total: 3 },
      },
    });
    const projected = JSON.stringify(connectedCatalog);
    expect(projected).not.toContain(connected.id);
    expect(projected).not.toContain(needsReauth.id);
    expect(projected).not.toContain(disabled.id);
  });

  test("resolves Alice's generic ref and never persists or projects a personal UUID", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:subject-generic-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId);
    const alice = await createConnection(db, {
      ...workspace,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });
    const bob = await createConnection(db, {
      ...workspace,
      subjectId: "subject-bob",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });

    await enableCapability({
      db,
      grant: grant(workspace, "subject-alice"),
      ...workspace,
      settings,
      capabilityId,
      payload: {
        config: {},
        metadata: {},
        headers: {},
        connectionRef: {
          providerDomain: "slack.com",
          subjectScope: "subject",
        },
      },
    });

    const installation = await getCapabilityInstallation(db, workspace.workspaceId, capabilityId);
    expect(installation?.config.connectionRef).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    const servers = await listEnabledMcpCapabilityServers(db, workspace.workspaceId);
    expect(servers.find((server) => server.capabilityId === capabilityId)?.connectionRef).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    const catalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    expect(catalog.items.find((item) => item.id === "mcp:personal-slack")).toBeUndefined();
    expect(catalog.items.find((item) => item.id === capabilityId)?.connectionRef).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    const projected = JSON.stringify({ installation, servers, catalog });
    expect(projected).not.toContain(alice.id);
    expect(projected).not.toContain(bob.id);
  });

  test("a legacy workspace-scoped Slack MCP installation is not runnable at runtime", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:legacy-workspace-slack-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId);
    const legacy = await createConnection(db, {
      ...workspace,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });
    // enableCapability now rejects this shape, so write the installation the
    // way an earlier release did: directly, with a workspace-scoped ref.
    await enableCapabilityInstallation(db, {
      ...workspace,
      capabilityId,
      kind: "mcp",
      config: {
        connectionRef: {
          providerDomain: "slack.com",
          kind: "oauth2",
          subjectScope: "workspace",
          connectionId: legacy.id,
        },
      },
      metadata: { mcpConnectivity: { status: "ok" } },
    });

    const installation = await getCapabilityInstallation(db, workspace.workspaceId, capabilityId);
    expect(installation?.status).toBe("active");

    // The row exists and is active, but the runtime fence omits it: no shared
    // human token executes for the hosted Slack MCP.
    const servers = await listEnabledMcpCapabilityServers(db, workspace.workspaceId);
    expect(servers.find((server) => server.capabilityId === capabilityId)).toBeUndefined();
  });

  test("keeps Gmail personal even when a workspace-owned mailbox row exists", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:gmail-personal-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      metadata: { connectionOwnership: "personal_only" },
    });
    const alice = await createConnection(db, {
      ...workspace,
      subjectId: "subject-alice",
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });
    const sharedConnection = await createConnection(db, {
      ...workspace,
      subjectId: null,
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });

    await expect(
      enableCapability({
        db,
        grant: grant(workspace, "subject-alice"),
        ...workspace,
        settings,
        capabilityId,
        payload: {
          config: {},
          metadata: {},
          headers: {},
          connectionRef: {
            connectionId: sharedConnection.id,
            providerDomain: "gmailmcp.googleapis.com",
            kind: "oauth2",
            subjectScope: "workspace",
          },
        },
      }),
    ).rejects.toThrow("requires a personal connection");

    await expect(
      enableCapability({
        db,
        grant: grant(workspace, "subject-bob"),
        ...workspace,
        settings,
        capabilityId,
        payload: {
          config: {},
          metadata: {},
          headers: {},
          connectionRef: {
            providerDomain: "gmailmcp.googleapis.com",
            kind: "oauth2",
            subjectScope: "subject",
          },
        },
      }),
    ).rejects.toThrow("visible active connection");

    await enableCapability({
      db,
      grant: grant(workspace, "subject-alice"),
      ...workspace,
      settings,
      capabilityId,
      payload: {
        config: {},
        metadata: {},
        headers: {},
        connectionRef: {
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "subject",
        },
      },
    });
    const installation = await getCapabilityInstallation(db, workspace.workspaceId, capabilityId);
    expect(installation?.config.connectionRef).toEqual({
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    expect(JSON.stringify(installation)).not.toContain(alice.id);
    expect(JSON.stringify(installation)).not.toContain(sharedConnection.id);
  });

  test("keeps the hosted Slack MCP personal even when a legacy workspace-owned row exists", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:slack-personal-${crypto.randomUUID()}`;
    // The catalog row carries no personal_only marker: the exact official
    // resource alone must fail closed, exactly like Gmail.
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://mcp.slack.com/mcp",
    });
    const legacyShared = await createConnection(db, {
      ...workspace,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
      metadata: { mcpUrl: "https://mcp.slack.com/mcp" },
    });
    await createConnection(db, {
      ...workspace,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
      metadata: { mcpUrl: "https://mcp.slack.com/mcp" },
    });

    for (const connectionRef of [
      {
        connectionId: legacyShared.id,
        providerDomain: "slack.com",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
      { providerDomain: "slack.com", kind: "oauth2" as const },
    ]) {
      await expect(
        enableCapability({
          db,
          grant: grant(workspace, "subject-alice"),
          ...workspace,
          settings,
          capabilityId,
          payload: { config: {}, metadata: {}, headers: {}, connectionRef },
        }),
      ).rejects.toThrow("requires a personal connection");
    }

    await enableCapability({
      db,
      grant: grant(workspace, "subject-alice"),
      ...workspace,
      settings,
      capabilityId,
      payload: {
        config: {},
        metadata: {},
        headers: {},
        connectionRef: { providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" },
      },
    });
    expect(
      (await getCapabilityInstallation(db, workspace.workspaceId, capabilityId))?.config
        .connectionRef,
    ).toEqual({ providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" });
  });

  test("rejects cross-subject and workspace misuse while preserving shared app-install refs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const personalCapabilityId = `mcp:subject-explicit-${crypto.randomUUID()}`;
    const sharedCapabilityId = `mcp:workspace-explicit-${crypto.randomUUID()}`;
    // The hosted Slack MCP resource is personal-only by itself (covered above);
    // exercise the generic subject/workspace ownership checks on ordinary
    // endpoints so this test proves the generic rule, not the Slack fence.
    await createMcpCapability(workspace, personalCapabilityId, {
      endpointUrl: "https://mcp.example.test/personal",
    });
    await createMcpCapability(workspace, sharedCapabilityId, {
      endpointUrl: "https://mcp.example.test/shared",
    });
    const alice = await createConnection(db, {
      ...workspace,
      subjectId: "subject-alice",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedFixture(),
    });
    const sharedBot = await createConnection(db, {
      ...workspace,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: encryptedFixture(),
    });

    const personalPayload = {
      config: {},
      metadata: {},
      headers: {},
      connectionRef: {
        connectionId: alice.id,
        providerDomain: "slack.com",
        kind: "oauth2" as const,
        subjectScope: "subject" as const,
      },
    };
    await expect(
      enableCapability({
        db,
        grant: grant(workspace, "subject-bob"),
        ...workspace,
        settings,
        capabilityId: personalCapabilityId,
        payload: personalPayload,
      }),
    ).rejects.toThrow("visible active connection");
    await expect(
      enableCapability({
        db,
        grant: grant(workspace, "subject-alice"),
        ...workspace,
        settings,
        capabilityId: personalCapabilityId,
        payload: {
          ...personalPayload,
          connectionRef: { ...personalPayload.connectionRef, subjectScope: "workspace" },
        },
      }),
    ).rejects.toThrow("workspace-owned connection");

    await enableCapability({
      db,
      grant: grant(workspace, "subject-alice"),
      ...workspace,
      settings,
      capabilityId: personalCapabilityId,
      payload: personalPayload,
    });
    expect(
      (await getCapabilityInstallation(db, workspace.workspaceId, personalCapabilityId))?.config
        .connectionRef,
    ).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });

    await enableCapability({
      db,
      grant: grant(workspace, "subject-alice"),
      ...workspace,
      settings,
      capabilityId: sharedCapabilityId,
      payload: {
        config: {},
        metadata: {},
        headers: {},
        connectionRef: {
          connectionId: sharedBot.id,
          providerDomain: "slack.com",
          kind: "app_install",
          subjectScope: "workspace",
        },
      },
    });
    expect(
      (await getCapabilityInstallation(db, workspace.workspaceId, sharedCapabilityId))?.config
        .connectionRef,
    ).toEqual({
      connectionId: sharedBot.id,
      providerDomain: "slack.com",
      kind: "app_install",
      subjectScope: "workspace",
    });
  });
});
