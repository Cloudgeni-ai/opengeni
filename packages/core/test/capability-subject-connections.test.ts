import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { CapabilityCatalogItem, type AccessGrant } from "@opengeni/contracts";
import {
  createConnection,
  beginConnectAttempt,
  createDb,
  createSocialConnection,
  enableCapabilityInstallation,
  disableCapabilityInstallation,
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
import { listSkillLibraryEntries, loadSkillLibrarySkill } from "@opengeni/runtime/skill-library";
import {
  applyCapabilityEnablement,
  buildCapabilityCatalog,
  codexAppsCatalogItem,
  enableCapability,
  prepareCapabilityEnable,
  executeConnectOperation,
  getConnectorToolPermissions,
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
  overrides: {
    endpointUrl?: string;
    metadata?: Record<string, unknown>;
    authModel?: string | null;
  } = {},
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
    authModel: overrides.authModel === undefined ? "credential_ref" : overrides.authModel,
    metadata: { mcpServerId: `${id}-runtime`, ...overrides.metadata },
  });
}

describe("subject-owned capability connection references", () => {
  test("deployment-managed personal selectors expose account choice without fixed identifiers", async () => {
    if (!available) throw new Error("Real PostgreSQL fixture required");
    const workspace = await freshWorkspace();
    const selector = {
      providerDomain: "mail.example.test",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    };
    const fixedId = crypto.randomUUID();
    const catalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings: {
        ...settings,
        mcpServers: [
          { id: "mail", url: "https://mail.example.test/mcp", connectionRef: selector },
          {
            id: "fixed-mail",
            url: "https://mail.example.test/mcp",
            connectionRef: { ...selector, connectionId: fixedId },
          },
        ],
      },
    });
    expect(catalog.items.find((item) => item.id === "mcp:mail")?.connectionRef).toEqual(selector);
    expect(catalog.items.find((item) => item.id === "mcp:fixed-mail")?.connectionRef).toBeNull();
    expect(JSON.stringify(catalog)).not.toContain(fixedId);
  });

  test("Connect completion composes MCP persistence and receipt replay under the policy fence", async () => {
    if (!available) throw new Error("Real PostgreSQL fixture required");
    const workspace = await freshWorkspace();
    const scope = { ...workspace, subjectId: "subject-alice" };
    const capabilityId = `mcp:connect-policy-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://public.example.test/mcp",
      authModel: null,
    });
    const attemptId = crypto.randomUUID();
    await beginConnectAttempt(db, scope, {
      idempotencyKey: attemptId,
      requestDigest: "a".repeat(64),
      returnUrl: "https://host.example.test/return",
      attempt: {
        id: attemptId,
        workspaceId: workspace.workspaceId,
        providerId: "mcp-install",
        ownership: "workspace",
        revision: 1,
        state: "requires_user_action",
        credentialsCommitted: false,
        integrationInstalled: false,
        completionRequirement: "integration",
        nextAction: { type: "authorize", url: "https://host.example.test/authorize" },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    let probes = 0;
    const operation = {
      db,
      scope,
      attemptId,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      inputDigest: "b".repeat(64),
      authorize: async () => {},
      execute: async () => {
        const prepared = await prepareCapabilityEnable({
          db,
          ...workspace,
          settings,
          capabilityId,
          grant: grant(workspace, scope.subjectId),
          payload: { config: {}, metadata: {}, headers: {} },
          probeMcpServer: async () => {
            probes++;
            return { toolCount: 1 };
          },
        });
        return {
          commit: async (
            tx: Database,
            current: import("@opengeni/contracts/connect").ConnectAttempt,
          ) => {
            await prepared.commit(tx);
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete" as const,
              integrationInstalled: true,
              nextAction: { type: "none" as const },
            };
          },
        };
      },
    };
    const completed = await executeConnectOperation(operation);
    expect(completed.state).toBe("complete");
    expect((await getCapabilityInstallation(db, workspace.workspaceId, capabilityId))?.status).toBe(
      "active",
    );
    await shared!.admin`insert into organization_integration_policies
      (account_id, mode, allowed_integration_keys, revision)
      values (${workspace.accountId}, 'restricted', ${shared!.admin.json([])}, 1)`;
    expect(await executeConnectOperation(operation)).toEqual(completed);
    expect(probes).toBe(1);
  });
  test("organization policy denies MCP probes and late enable commits without hiding installed results", async () => {
    if (!available) throw new Error("Real PostgreSQL fixture required");
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:policy-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://public.example.test/mcp",
      authModel: null,
    });
    const setAllowed = async (allowed: boolean) => {
      await shared!.admin`insert into organization_integration_policies
        (account_id, mode, allowed_integration_keys, revision)
        values (${workspace.accountId}, 'restricted', ${shared!.admin.json(allowed ? ["custom:mcp"] : [])}, 1)
        on conflict (account_id) do update set allowed_integration_keys = excluded.allowed_integration_keys`;
    };
    let probes = 0;
    const input = {
      db,
      ...workspace,
      settings,
      capabilityId,
      grant: grant(workspace, "subject-alice"),
      payload: { config: {}, metadata: {}, headers: {} },
      probeMcpServer: async () => {
        probes++;
        return { toolCount: 1 };
      },
    };
    await setAllowed(false);
    await expect(prepareCapabilityEnable(input)).rejects.toMatchObject({
      name: "OrganizationIntegrationDeniedError",
    });
    expect(probes).toBe(0);
    await setAllowed(true);
    const prepared = await prepareCapabilityEnable(input);
    expect(probes).toBe(1);
    await setAllowed(false);
    await expect(prepared.commit(db)).rejects.toMatchObject({
      name: "OrganizationIntegrationDeniedError",
    });
    expect(await getCapabilityInstallation(db, workspace.workspaceId, capabilityId)).toBeNull();
    await setAllowed(true);
    const installed = await enableCapability(input);
    await setAllowed(false);
    const probesBeforeReplay = probes;
    expect(await enableCapability(input)).toEqual(installed);
    expect(probes).toBe(probesBeforeReplay);
    await expect(
      enableCapability({
        ...input,
        payload: { ...input.payload, config: { allowedTools: ["new-tool"] } },
      }),
    ).rejects.toMatchObject({ name: "OrganizationIntegrationDeniedError" });
    expect((await getCapabilityInstallation(db, workspace.workspaceId, capabilityId))?.id).toBe(
      installed.id,
    );
    const unchanged = await prepareCapabilityEnable(input);
    await disableCapabilityInstallation(db, workspace.workspaceId, capabilityId);
    await expect(unchanged.commit(db)).rejects.toMatchObject({ status: 409 });
    expect((await getCapabilityInstallation(db, workspace.workspaceId, capabilityId))?.status).toBe(
      "disabled",
    );
    await expect(enableCapability(input)).rejects.toMatchObject({
      name: "OrganizationIntegrationDeniedError",
    });
  });
  test("restricted reconciliation compares explicit credentials and remains no-effect across a catalog edit", async () => {
    if (!available) throw new Error("Real PostgreSQL fixture required");
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:reconcile-headers-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://public.example.test/mcp",
      authModel: null,
    });
    let probes = 0;
    const input = {
      db,
      ...workspace,
      settings,
      capabilityId,
      grant: grant(workspace, "subject-alice"),
      payload: {
        config: {},
        metadata: {},
        headers: { Authorization: "Bearer synthetic-original" },
      },
      probeMcpServer: async () => {
        probes++;
        return { toolCount: 1 };
      },
    };
    const installed = await enableCapability(input);
    await shared!.admin`insert into organization_integration_policies
      (account_id, mode, allowed_integration_keys, revision)
      values (${workspace.accountId}, 'restricted', ${shared!.admin.json([])}, 1)`;
    expect(await enableCapability(input)).toEqual(installed);
    await expect(
      enableCapability({
        ...input,
        payload: { ...input.payload, headers: { Authorization: "Bearer synthetic-changed" } },
      }),
    ).rejects.toMatchObject({ name: "OrganizationIntegrationDeniedError" });
    const prepared = await prepareCapabilityEnable(input);
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://changed.example.test/mcp",
      authModel: null,
    });
    expect(await prepared.commit(db)).toEqual(installed);
    expect(await getCapabilityInstallation(db, workspace.workspaceId, capabilityId)).toEqual(
      installed,
    );
    expect(probes).toBe(1);
  });
  test("MCP preparation probes without publishing and commits without creating a credential", async () => {
    if (!available) throw new Error("Real PostgreSQL fixture required");
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:public-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://public.example.test/mcp",
      authModel: null,
    });
    let probes = 0;
    const prepared = await prepareCapabilityEnable({
      db,
      ...workspace,
      settings,
      capabilityId,
      grant: grant(workspace, "subject-alice"),
      payload: { config: {}, metadata: {}, headers: {} },
      probeMcpServer: async (input) => {
        probes++;
        expect(input.headers).toBeUndefined();
        return { toolCount: 2 };
      },
    });
    expect(await getCapabilityInstallation(db, workspace.workspaceId, capabilityId)).toBeNull();
    const installed = await prepared.commit(db);
    expect(installed.status).toBe("active");
    expect(installed.config.connectionRef).toBeUndefined();
    expect(installed.config.headersEncrypted).toBeUndefined();
    expect(probes).toBe(1);
  });
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

  test("keeps native and uninstalled library Skills out of the catalog and marks external config as managed", async () => {
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
    // The workspace catalog projects installed Skills, not the available
    // library. Discovery must retain these artifacts without implicitly
    // installing or enabling them in a fresh workspace.
    for (const libraryId of ["terraform-style-guide", "social-media-marketing"]) {
      expect(ids.has(`skill:${libraryId}`)).toBe(false);
      const entry = listSkillLibraryEntries().find((item) => item.id === libraryId);
      expect(entry).toBeDefined();
      const loaded = loadSkillLibrarySkill(libraryId, entry!.version);
      expect(loaded.entry.contentSha256).toBe(entry!.contentSha256);
      expect(
        loaded.skill.files.some((file) => file.path === "SKILL.md" && file.content.length > 0),
      ).toBe(true);
    }
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

  test("round-trips opaque and UUID-shaped host capability bindings without native lookup", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const activatedSettings = {
      ...settings,
      hostMcpAuthoritySourceAdmissionEnabled: true,
    };
    const cases = [
      {
        suffix: "opaque-workspace",
        connectionRef: {
          authoritySource: "host" as const,
          connectionId: "cloudgeni-capability",
          providerDomain: "cloudgeni.example",
          kind: "delegated" as const,
          subjectScope: "workspace" as const,
        },
      },
      {
        suffix: "uuid-subject",
        connectionRef: {
          authoritySource: "host" as const,
          connectionId: "11111111-1111-4111-8111-111111111111",
          providerDomain: "cloudgeni.example",
          kind: "delegated" as const,
          subjectScope: "subject" as const,
        },
      },
    ];

    for (const testCase of cases) {
      const capabilityId = `mcp:host-${testCase.suffix}-${crypto.randomUUID()}`;
      await createMcpCapability(workspace, capabilityId, {
        endpointUrl: `https://${testCase.suffix}.example.test/mcp`,
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
            connectionRef: testCase.connectionRef,
          },
        }),
      ).rejects.toThrow(/OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED=true/);
      await enableCapability({
        db,
        grant: grant(workspace, "subject-alice"),
        ...workspace,
        settings: activatedSettings,
        capabilityId,
        payload: {
          config: {},
          metadata: {},
          headers: {},
          connectionRef: testCase.connectionRef,
        },
      });

      const installation = await getCapabilityInstallation(db, workspace.workspaceId, capabilityId);
      expect(installation?.config.connectionRef).toEqual(testCase.connectionRef);
      const servers = await listEnabledMcpCapabilityServers(db, workspace.workspaceId);
      expect(servers.find((server) => server.capabilityId === capabilityId)?.connectionRef).toEqual(
        testCase.connectionRef,
      );
      const catalog = await buildCapabilityCatalog({
        db,
        workspaceId: workspace.workspaceId,
        settings: activatedSettings,
      });
      expect(catalog.items.find((item) => item.id === capabilityId)?.connectionRef).toBeNull();
    }
  });

  test("an explicitly workspace-scoped Slack MCP installation is runnable", async () => {
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

    const servers = await listEnabledMcpCapabilityServers(db, workspace.workspaceId);
    expect(
      servers.find((server) => server.capabilityId === capabilityId)?.connectionRef?.subjectScope,
    ).toBe("workspace");
    const catalog = await buildCapabilityCatalog({
      db,
      workspaceId: workspace.workspaceId,
      settings,
    });
    const entry = catalog.items.find((item) => item.id === capabilityId);
    expect(entry?.enabled).toBe(true);
    expect(entry?.runtime.available).toBe(true);
    expect(entry?.actions).toContain("disconnect");
  });

  test("Gmail preserves explicit workspace and personal ownership", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:gmail-personal-${crypto.randomUUID()}`;
    await createMcpCapability(workspace, capabilityId, {
      endpointUrl: "https://gmailmcp.googleapis.com/mcp/v1",
      metadata: { defaultConnectionOwnership: "personal" },
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
          connectionId: sharedConnection.id,
          providerDomain: "gmailmcp.googleapis.com",
          kind: "oauth2",
          subjectScope: "workspace",
        },
      },
    });

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
    // Tool discovery must use the same reviewed REST bridge as execution. The
    // fixture has no usable OAuth token and cannot probe Google's hosted MCP.
    const permissions = await getConnectorToolPermissions({
      db,
      settings,
      workspaceId: workspace.workspaceId,
      grant: grant(workspace, "subject-alice"),
      capabilityId,
      personalOwnerVerified: true,
    });
    expect(permissions.discoveryError).toBeNull();
    expect(permissions.connectionId).toBe(alice.id);
    expect(permissions.tools.map((tool) => tool.name)).toContain("search_threads");
    expect(permissions.tools.map((tool) => tool.name)).toContain("send_message");
    await expect(
      getConnectorToolPermissions({
        db,
        settings,
        workspaceId: workspace.workspaceId,
        grant: grant(workspace, "subject-bob"),
        capabilityId,
        personalOwnerVerified: true,
      }),
    ).rejects.toThrow("Reconnect this connector");
  });

  test("hosted Slack MCP respects explicit connection ownership", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const capabilityId = `mcp:slack-personal-${crypto.randomUUID()}`;
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
    ]) {
      await enableCapability({
        db,
        grant: grant(workspace, "subject-alice"),
        ...workspace,
        settings,
        capabilityId,
        payload: { config: {}, metadata: {}, headers: {}, connectionRef },
      });
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
    // Ownership checks apply independently of the provider endpoint.
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
