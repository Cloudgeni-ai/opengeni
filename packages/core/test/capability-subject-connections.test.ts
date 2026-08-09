import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { CapabilityCatalogItem, type AccessGrant } from "@opengeni/contracts";
import {
  createConnection,
  createDb,
  createSocialConnection,
  encryptEnvironmentValue,
  getCapabilityInstallation,
  listEnabledMcpCapabilityServers,
  upsertCapabilityCatalogItem,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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
  shared = await acquireSharedTestDatabase("core-capability-subject-connections");
  if (!shared) {
    available = false;
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
    endpointUrl: "https://mcp.slack.com/mcp",
    authModel: "credential_ref",
    metadata: { mcpServerId: `${id}-runtime` },
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

  test("does not mistake a browseable first-party social connector for a connection", () => {
    const item = CapabilityCatalogItem.parse({
      id: "api:x",
      kind: "api",
      source: "built_in",
      name: "X",
      category: "social-media",
      surfaceType: "first_party_social",
      enabled: false,
      enabledReason: null,
      metadata: { provider: "x", ownership: "workspace" },
    });
    expect(applyCapabilityEnablement(item, undefined, new Set())).toMatchObject({
      enabled: false,
      enabledReason: null,
      connectionRef: null,
    });
  });

  test("publishes X as a workspace-shared first-party connector with truthful state", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const disconnectedCatalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    expect(disconnectedCatalog.items.find((item) => item.id === "api:x")).toMatchObject({
      kind: "api",
      surfaceType: "first_party_social",
      enabled: false,
      metadata: { provider: "x", ownership: "workspace" },
      tools: [{ kind: "mcp", id: "opengeni" }],
    });

    await createSocialConnection(db, {
      ...workspace,
      provider: "x",
      accountHandle: "opengeni",
      status: "connected",
      scopes: ["tweet.read", "users.read"],
    });
    const connectedCatalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    expect(connectedCatalog.items.find((item) => item.id === "api:x")).toMatchObject({
      enabled: true,
      enabledReason: "workspace social account connected",
    });
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

  test("rejects cross-subject and workspace misuse while preserving shared app-install refs", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const personalCapabilityId = `mcp:subject-explicit-${crypto.randomUUID()}`;
    const sharedCapabilityId = `mcp:workspace-explicit-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, personalCapabilityId);
    await createMcpCapability(workspace, sharedCapabilityId);
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
