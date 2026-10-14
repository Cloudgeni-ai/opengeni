import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  buildCapabilityCatalog,
  createWorkspaceVaultProviderRegistry,
  ONEPASSWORD_CREDENTIAL_ROLE,
  ONEPASSWORD_PROVIDER_DOMAIN,
} from "@opengeni/core";
import {
  createDb,
  decryptEnvironmentValue,
  getConnectionMetadata,
  type DbClient,
} from "@opengeni/db";
import { createProviderCallBudget } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

const DELEGATION_SECRET = randomBytes(32).toString("hex");
const ENCRYPTION_KEY = randomBytes(32).toString("base64");
// Built at runtime so no token-shaped literal sits in the source.
const FAKE_HEALTHY = ["ops", "fake", "healthy"].join("_");
const FAKE_SYNC_ERROR = ["ops", "fake", "sync", "error"].join("_");

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-vault-providers");
  if (!shared) {
    available = false;
    console.warn("[vault-providers] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: ENCRYPTION_KEY,
    publicBaseUrl: "https://app.example.test",
    onePasswordFakeTokens: true,
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(): Promise<Workspace> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('1p acct') returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, '1p ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${account!.id}, 'subject-a', 'active', ${workspace!.id}
    )`;
  for (const subjectId of ["subject-a", "subject-b"]) {
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared!.admin.json(["connections:read", "connections:write", "secrets:list", "secrets:write"])}
      )`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id };
}

/** Another (non-personal) workspace in the same organization, with both subjects as members. */
async function siblingWorkspace(home: Workspace): Promise<Workspace> {
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${home.accountId}, '1p team ws') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${home.accountId})`;
  for (const subjectId of ["subject-a", "subject-b"]) {
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${home.accountId}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared!.admin.json(["connections:read", "connections:write", "secrets:list", "secrets:write"])}
      )`;
  }
  return { accountId: home.accountId, workspaceId: workspace!.id };
}

async function bearer(workspace: Workspace, subjectId: string, permissions: Permission[]) {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

function app(overrides: Partial<Settings> = {}) {
  return createApp({
    settings: { ...settings, ...overrides },
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
  } as never);
}

async function install(
  workspace: Workspace,
  body: Record<string, unknown>,
  options: { subjectId?: string; permissions?: Permission[]; settings?: Partial<Settings> } = {},
) {
  const response = await app(options.settings).request(
    `/v1/workspaces/${workspace.workspaceId}/connections/1password/install`,
    {
      method: "POST",
      headers: {
        authorization: await bearer(
          workspace,
          options.subjectId ?? "subject-a",
          options.permissions ?? ["connections:read", "connections:write"],
        ),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
}

describe("POST /connections/1password/install", () => {
  test("validates the token, lists vaults and stores a workspace connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await install(workspace, {
      token: FAKE_HEALTHY,
      ownership: "workspace",
      planTier: "family",
      label: "Engineering 1Password",
    });
    expect(installed.status).toBe(201);
    expect(installed.text).not.toContain(FAKE_HEALTHY);
    expect(installed.body.accountName).toBe("fake.1password.test");
    expect(installed.body.vaults).toEqual([
      expect.objectContaining({ name: "Engineering", itemCount: 6, linkedVaultId: null }),
    ]);
    const connection = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      installed.body.connectionId,
      null,
    );
    expect(connection).toMatchObject({
      subjectId: null,
      providerDomain: ONEPASSWORD_PROVIDER_DOMAIN,
      kind: "api_key",
      status: "active",
      metadata: expect.objectContaining({
        credentialRole: ONEPASSWORD_CREDENTIAL_ROLE,
        planTier: "family",
        ownership: "workspace",
        label: "Engineering 1Password",
      }),
    });
    expect(JSON.stringify(connection)).not.toContain(FAKE_HEALTHY);
    // The token is stored as `{ token }`: no broker `headers`, so egress never injects it.
    const [row] = await shared!.admin<Array<{ credential_encrypted: string }>>`
      select credential_encrypted from connections where id = ${installed.body.connectionId}`;
    const bundle = JSON.parse(
      decryptEnvironmentValue(Buffer.from(ENCRYPTION_KEY, "base64"), row!.credential_encrypted),
    );
    expect(bundle).toEqual({ token: FAKE_HEALTHY });
  });

  test("lists provider vaults for the stored connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const response = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${installed.body.connectionId}/provider-vaults`,
      { headers: { authorization: await bearer(workspace, "subject-a", ["secrets:list"]) } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { vaults: Array<Record<string, unknown>> };
    expect(body.vaults).toEqual([
      expect.objectContaining({ name: "Engineering", linkedVaultId: null }),
    ]);
  });

  test("a personal connection is stored for its owner and hidden from others", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_SYNC_ERROR, ownership: "user" });
    expect(installed.status).toBe(201);
    const own = await getConnectionMetadata(
      client.db,
      workspace.workspaceId,
      installed.body.connectionId,
      "subject-a",
    );
    expect(own?.subjectId).toBe("subject-a");
    const other = await app().request(
      `/v1/workspaces/${workspace.workspaceId}/connections/${installed.body.connectionId}/provider-vaults`,
      { headers: { authorization: await bearer(workspace, "subject-b", ["secrets:list"]) } },
    );
    expect(other.status).toBe(404);
  });

  test("rejects a malformed token as provider_auth_invalid without echoing it", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const bogus = `ops_${"not-base64-json".repeat(3)}`;
    const refused = await install(workspace, { token: bogus, ownership: "workspace" });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("provider_auth_invalid");
    expect(refused.text).not.toContain(bogus);
  });

  test("fake tokens are refused unless OPENGENI_ONEPASSWORD_FAKE_TOKENS is on", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const refused = await install(
      workspace,
      { token: FAKE_HEALTHY, ownership: "workspace" },
      { settings: { onePasswordFakeTokens: false } },
    );
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("provider_auth_invalid");
  });

  test("requires connections:write, and account:admin for organization ownership", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const denied = await install(
      workspace,
      { token: FAKE_HEALTHY, ownership: "workspace" },
      { permissions: ["connections:read"] },
    );
    expect(denied.status).toBe(403);
    const organization = await install(workspace, {
      token: FAKE_HEALTHY,
      ownership: "organization",
    });
    expect(organization.status).toBe(403);
  });

  test("the generic connection route cannot forge a 1Password connection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const response = await app().request(`/v1/workspaces/${workspace.workspaceId}/connections`, {
      method: "POST",
      headers: {
        authorization: await bearer(workspace, "subject-a", [
          "connections:read",
          "connections:write",
        ]),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        providerDomain: ONEPASSWORD_PROVIDER_DOMAIN,
        kind: "api_key",
        subjectId: null,
        credential: { token: FAKE_HEALTHY },
        metadata: { credentialRole: ONEPASSWORD_CREDENTIAL_ROLE },
      }),
    });
    expect(response.status).toBe(422);
  });
});

describe("api:1password capability tile", () => {
  test("is disabled until a workspace 1Password connection is active", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const tile = async () =>
      (
        await buildCapabilityCatalog({
          db: client.db,
          workspaceId: workspace.workspaceId,
          settings,
          accountId: workspace.accountId,
        })
      ).items.find((item) => item.id === "api:1password");
    expect(await tile()).toMatchObject({ enabled: false, surfaceType: "first_party_onepassword" });
    await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace", planTier: "business" });
    expect(await tile()).toMatchObject({
      enabled: true,
      enabledReason: "1Password connection active",
      metadata: expect.objectContaining({ planTiers: ["business"] }),
    });
  });
});

describe("workspace vault provider registry", () => {
  test("resolves 1Password vaults from the stored connection and host vaults from the embedder", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const host = createFakeVaultProvider({
      vaults: [{ externalVaultId: "host-vault", name: "Host" }],
    });
    const factoryCalls: Array<{ planTier: string; allowFakeTokens: boolean }> = [];
    const registry = createWorkspaceVaultProviderRegistry({
      db: client.db,
      settings,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      hostVaultProvider: host,
      onePasswordVaultProvider: async (input) => {
        factoryCalls.push({ planTier: input.planTier, allowFakeTokens: input.allowFakeTokens });
        expect(input.token).toBe(FAKE_HEALTHY);
        return createFakeVaultProvider();
      },
    });
    expect(await registry.forVault({ source: "host", providerConnectionId: null })).toBe(host);
    await registry.forVault({
      source: "onepassword",
      providerConnectionId: installed.body.connectionId,
    });
    expect(factoryCalls).toEqual([{ planTier: "teams", allowFakeTokens: true }]);
    await expect(
      registry.forVault({ source: "onepassword", providerConnectionId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "provider_auth_invalid" });
    const ctx = { connectionId: null, budget: createProviderCallBudget(5) };
    expect((await host.listVaults(ctx)).map((vault) => vault.name)).toEqual(["Host"]);
  });
});

/** The fake tokens are process-wide singletons; managed-vault creation mutates them. */
async function resetOnePasswordFakeProvidersForTests() {
  const onePassword = await import("@opengeni/vaults-onepassword");
  onePassword.resetOnePasswordFakeProvidersForTests();
}

async function call(
  workspace: Workspace,
  method: string,
  path: string,
  options: {
    body?: unknown;
    permissions?: Permission[];
    deps?: Record<string, unknown>;
  } = {},
) {
  const appDeps = {
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    ...options.deps,
  };
  const response = await createApp(appDeps as never).request(
    `/v1/workspaces/${workspace.workspaceId}${path}`,
    {
      method,
      headers: {
        authorization: await bearer(
          workspace,
          "subject-a",
          options.permissions ?? ["secrets:list", "secrets:write", "secrets:use"],
        ),
        "content-type": "application/json",
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
  };
}

describe("provider vault link, sync and managed vaults", () => {
  test("links a 1Password vault, mirrors it and reveals values live", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const connectionId = installed.body.connectionId as string;
    const engineering = installed.body.vaults[0].externalVaultId as string;

    const linked = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId,
        externalVaultId: engineering,
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      name: "Engineering",
      source: "onepassword",
      mode: "read_only",
      syncStatus: "ok",
      itemCount: 6,
      providerConnectionId: connectionId,
      canWrite: false,
    });

    const listed = await call(workspace, "GET", `/connections/${connectionId}/provider-vaults`);
    expect(listed.body.vaults[0].linkedVaultId).toBe(linked.body.id);

    const again = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId,
        externalVaultId: engineering,
        ownerKind: "workspace",
        mode: "read_only",
        name: "Engineering again",
      },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("vault_name_conflict");

    const items = await call(workspace, "GET", `/vaults/${linked.body.id}/items`);
    const github = items.body.items.find((item: { name: string }) => item.name === "GitHub");
    expect(github).toMatchObject({ type: "login", hasTotp: true });
    const item = await call(workspace, "GET", `/vaults/${linked.body.id}/items/${github.id}`);
    const password = item.body.fields.find((field: { name: string }) => field.name === "password");
    const otp = item.body.fields.find((field: { kind: string }) => field.kind === "totp");
    const revealed = await call(
      workspace,
      "POST",
      `/vaults/${linked.body.id}/items/${github.id}/fields/${password.id}/reveal`,
      { body: {} },
    );
    expect(revealed.status).toBe(200);
    expect(typeof revealed.body.value).toBe("string");
    expect(revealed.body.value.length).toBeGreaterThan(0);
    const code = await call(
      workspace,
      "POST",
      `/vaults/${linked.body.id}/items/${github.id}/fields/${otp.id}/reveal`,
      { body: {} },
    );
    expect(code.body.totp.code).toMatch(/^\d{6}$/);

    // Items in a connected vault change only through the provider.
    const direct = await call(workspace, "POST", `/vaults/${linked.body.id}/items`, {
      body: { name: "Direct", type: "api_key", fields: [{ name: "value", value: "x" }] },
    });
    expect(direct.status).toBe(403);
    expect(direct.body.error).toBe("vault_read_only");

    const synced = await call(workspace, "POST", `/vaults/${linked.body.id}/sync`);
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ syncStatus: "ok", itemCount: 6 });
  });

  test("a failing provider records the sync error and keeps the link", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, {
      token: FAKE_SYNC_ERROR,
      ownership: "workspace",
    });
    const linked = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId: installed.body.connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "workspace",
        mode: "read_write",
      },
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      name: "Shared",
      syncStatus: "error",
      syncErrorCode: "provider_unavailable",
      itemCount: 0,
    });
  });

  test("unknown provider vaults and missing permissions are refused", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const missing = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId: installed.body.connectionId,
        externalVaultId: "doesnotexist",
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("vault_not_found");
    const forbidden = await call(workspace, "POST", "/vaults/link", {
      permissions: ["secrets:list"],
      body: {
        provider: "onepassword",
        connectionId: installed.body.connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(forbidden.status).toBe(403);
    const organization = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId: installed.body.connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "organization",
        mode: "read_only",
      },
    });
    expect(organization.status).toBe(403);
  });

  test("creates a managed 1Password vault and links it read-write", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const created = await call(
      workspace,
      "POST",
      `/connections/${installed.body.connectionId}/managed-vaults`,
      { body: { name: "OpenGeni Agents", ownerKind: "workspace" } },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "OpenGeni Agents",
      source: "onepassword",
      mode: "read_write",
      syncStatus: "ok",
      itemCount: 0,
    });
    await resetOnePasswordFakeProvidersForTests();
  });

  test("edits in a read-write 1Password vault write through to the provider", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const linked = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId: installed.body.connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "workspace",
        mode: "read_write",
      },
    });
    expect(linked.body).toMatchObject({ mode: "read_write", canWrite: true, itemCount: 6 });
    const vaultPath = `/vaults/${linked.body.id}`;

    const created = await call(workspace, "POST", `${vaultPath}/items`, {
      body: {
        type: "login",
        name: "Deploy bot",
        websites: ["https://deploy.example.test"],
        fields: [
          { name: "username", value: "deploy-bot" },
          { name: "password", generate: { length: 24 } },
          {
            name: "one-time password",
            kind: "totp",
            value: "otpauth://totp/Deploy?secret=JBSWY3DPEHPK3PXP&period=30&digits=6",
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Deploy bot",
      vaultId: linked.body.id,
      hasTotp: true,
    });
    const password = created.body.fields.find(
      (field: { name: string }) => field.name === "password",
    );
    const revealed = await call(
      workspace,
      "POST",
      `${vaultPath}/items/${created.body.id}/fields/${password.id}/reveal`,
      { body: {} },
    );
    expect(revealed.body.value).toHaveLength(24);
    expect((await call(workspace, "GET", vaultPath)).body.itemCount).toBe(7);

    const stale = await call(workspace, "PATCH", `${vaultPath}/items/${created.body.id}`, {
      body: { name: "Deploy bot 2", expectedGeneration: 999 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("vault_generation_conflict");

    // A change made in 1Password after the mirror was taken is a provider conflict.
    const onePassword = await import("@opengeni/vaults-onepassword");
    const direct = onePassword.vaultProviderForOnePasswordConnection({
      token: FAKE_HEALTHY,
      allowFakeTokens: true,
    });
    const ctx = { connectionId: null, budget: createProviderCallBudget(10) };
    const [providerItem] = (
      await direct.listItems(ctx, installed.body.vaults[0].externalVaultId)
    ).filter((item) => item.name === "Deploy bot");
    await direct.writeItem(ctx, installed.body.vaults[0].externalVaultId, {
      externalItemId: providerItem!.externalItemId,
      name: "Deploy bot",
      type: "login",
      websites: [],
      fields: [{ name: "note", kind: "text", value: "changed in 1Password" }],
    });
    const conflict = await call(workspace, "PATCH", `${vaultPath}/items/${created.body.id}`, {
      body: { name: "Deploy bot renamed", expectedGeneration: created.body.generation },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("provider_conflict");

    await call(workspace, "POST", `${vaultPath}/sync`);
    const current = await call(workspace, "GET", `${vaultPath}/items/${created.body.id}`);
    const renamed = await call(workspace, "PATCH", `${vaultPath}/items/${created.body.id}`, {
      body: { name: "Deploy bot renamed", expectedGeneration: current.body.generation },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Deploy bot renamed");

    const archived = await call(workspace, "DELETE", `${vaultPath}/items/${created.body.id}`);
    expect(archived.status).toBeLessThan(300);
    const after = await call(workspace, "GET", `${vaultPath}/items`);
    expect(after.body.items.map((item: { name: string }) => item.name)).not.toContain(
      "Deploy bot renamed",
    );
    expect((await call(workspace, "GET", vaultPath)).body.itemCount).toBe(6);
  });

  test("links a host vault from the embedder's vaultProvider", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const host = createFakeVaultProvider({
      vaults: [
        {
          externalVaultId: "host-vault",
          name: "Host secrets",
          items: [{ name: "Deploy key", type: "api_key", fields: [{ name: "value", value: "v" }] }],
        },
      ],
    });
    const deps = { connectionCredentials: { vaultProvider: host } };
    const linked = await call(workspace, "POST", "/vaults/link", {
      deps,
      body: {
        provider: "host",
        externalVaultId: "host-vault",
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      name: "Host secrets",
      source: "host",
      providerConnectionId: null,
      itemCount: 1,
    });
    const noHost = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "host",
        externalVaultId: "host-vault",
        ownerKind: "workspace",
        mode: "read_only",
        name: "No host",
      },
    });
    expect(noHost.status).toBe(503);
    expect(noHost.body.error).toBe("provider_unavailable");
  });

  test("opening a stale linked vault lists items added in the provider", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const host = createFakeVaultProvider({
      vaults: [
        {
          externalVaultId: "host-vault",
          name: "Host secrets",
          items: [{ name: "Deploy key", type: "api_key", fields: [{ name: "value", value: "v" }] }],
        },
      ],
    });
    const deps = { connectionCredentials: { vaultProvider: host } };
    const linked = await call(workspace, "POST", "/vaults/link", {
      deps,
      body: {
        provider: "host",
        externalVaultId: "host-vault",
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(linked.status).toBe(201);
    // Somebody adds an item straight in the provider, and the mirror goes stale.
    await host.writeItem(
      { connectionId: null, budget: createProviderCallBudget(5) },
      "host-vault",
      {
        name: "Company card",
        type: "note",
        websites: [],
        fields: [{ name: "number", kind: "concealed", value: "4242" }],
      },
    );
    await shared!.admin`
      update vaults set last_synced_at = now() - interval '1 hour'
      where id = ${linked.body.id}`;

    const opened = await call(workspace, "GET", `/vaults/${linked.body.id}/items`, { deps });
    expect(opened.status).toBe(200);
    expect(opened.body.items.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining(["Deploy key", "Company card"]),
    );
  });
});

/** A structurally valid token for another 1Password account; no real key material. */
function otherAccountToken(): string {
  const body = {
    signInAddress: "other.1password.test",
    deviceUuid: "x",
    email: "x",
    srpX: "x",
    muk: {},
    secretKey: "x",
  };
  return `${["ops", ""].join("_")}${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
}

async function callAs(
  workspace: Workspace,
  subjectId: string,
  method: string,
  path: string,
  permissions: Permission[],
  body?: unknown,
) {
  const response = await app().request(`/v1/workspaces/${workspace.workspaceId}${path}`, {
    method,
    headers: {
      authorization: await bearer(workspace, subjectId, permissions),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: (text ? JSON.parse(text) : {}) as Record<string, any>,
  };
}

const MANAGE: Permission[] = [
  "connections:read",
  "connections:write",
  "secrets:list",
  "secrets:write",
];

describe("1Password connection management", () => {
  test("lists the connections each person can see, without tokens", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const forEveryone = await install(workspace, {
      token: FAKE_HEALTHY,
      ownership: "workspace",
      planTier: "family",
    });
    const personal = await install(workspace, { token: FAKE_SYNC_ERROR, ownership: "user" });

    const mine = await callAs(
      workspace,
      "subject-a",
      "GET",
      "/connections/1password/service-accounts",
      MANAGE,
    );
    expect(mine.status).toBe(200);
    expect(mine.text).not.toContain(FAKE_HEALTHY);
    expect(mine.text).not.toContain(FAKE_SYNC_ERROR);
    const byId = new Map(
      (mine.body.connections as Array<Record<string, any>>).map((each) => [each.id, each]),
    );
    expect(byId.get(forEveryone.body.connectionId)).toMatchObject({
      ownership: "workspace",
      accountName: "fake.1password.test",
      planTier: "family",
      createdBySubjectId: "subject-a",
      canManage: true,
    });
    expect(byId.get(personal.body.connectionId)).toMatchObject({
      ownership: "user",
      canManage: true,
    });

    const theirs = await callAs(
      workspace,
      "subject-b",
      "GET",
      "/connections/1password/service-accounts",
      MANAGE,
    );
    expect(theirs.body.connections.map((each: { id: string }) => each.id)).toEqual([
      forEveryone.body.connectionId,
    ]);
    const viewer = await callAs(
      workspace,
      "subject-b",
      "GET",
      "/connections/1password/service-accounts",
      ["secrets:list"],
    );
    expect(viewer.body.connections).toEqual([
      expect.objectContaining({ id: forEveryone.body.connectionId, canManage: false }),
    ]);
  });

  test("replaces the token on the same connection and keeps linked vaults", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const connectionId = installed.body.connectionId as string;
    const linked = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(linked.status).toBe(201);

    const path = `/connections/${connectionId}/1password/token`;
    const replaced = await callAs(workspace, "subject-a", "PUT", path, MANAGE, {
      token: FAKE_HEALTHY,
      planTier: "teams",
    });
    expect(replaced.status).toBe(200);
    expect(replaced.text).not.toContain(FAKE_HEALTHY);
    expect(replaced.body).toMatchObject({ connectionId, accountName: "fake.1password.test" });
    expect(replaced.body.vaults[0].linkedVaultId).toBe(linked.body.id);

    const listed = await callAs(
      workspace,
      "subject-a",
      "GET",
      "/connections/1password/service-accounts",
      MANAGE,
    );
    expect(listed.body.connections).toEqual([
      expect.objectContaining({ id: connectionId, planTier: "teams" }),
    ]);
    const vault = await call(workspace, "GET", `/vaults/${linked.body.id}`);
    expect(vault.status).toBe(200);
    expect(vault.body.providerConnectionId).toBe(connectionId);

    const other = otherAccountToken();
    const mismatch = await callAs(workspace, "subject-a", "PUT", path, MANAGE, { token: other });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error).toBe("provider_conflict");
    expect(mismatch.text).toContain("other.1password.test");
    expect(mismatch.text).not.toContain(other);

    const forbidden = await callAs(workspace, "subject-b", "PUT", path, ["connections:write"], {
      token: FAKE_HEALTHY,
    });
    expect(forbidden.status).toBe(403);
  });

  test("disconnecting unlinks its vaults and forgets the token", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const workspace = await freshWorkspace();
    const installed = await install(workspace, { token: FAKE_HEALTHY, ownership: "workspace" });
    const connectionId = installed.body.connectionId as string;
    const linked = await call(workspace, "POST", "/vaults/link", {
      body: {
        provider: "onepassword",
        connectionId,
        externalVaultId: installed.body.vaults[0].externalVaultId,
        ownerKind: "workspace",
        mode: "read_only",
      },
    });
    expect(linked.status).toBe(201);

    const personal = await install(workspace, { token: FAKE_HEALTHY, ownership: "user" });
    const notTheirs = await callAs(
      workspace,
      "subject-b",
      "DELETE",
      `/connections/${personal.body.connectionId}/1password`,
      MANAGE,
    );
    expect(notTheirs.status).toBe(404);

    const removed = await callAs(
      workspace,
      "subject-a",
      "DELETE",
      `/connections/${connectionId}/1password`,
      MANAGE,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ unlinkedVaultIds: [linked.body.id] });

    expect((await call(workspace, "GET", `/vaults/${linked.body.id}`)).status).toBe(404);
    const listed = await callAs(
      workspace,
      "subject-a",
      "GET",
      "/connections/1password/service-accounts",
      MANAGE,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.connections.map((each: { id: string }) => each.id)).toEqual([
      personal.body.connectionId,
    ]);
    const again = await callAs(
      workspace,
      "subject-a",
      "DELETE",
      `/connections/${connectionId}/1password`,
      MANAGE,
    );
    expect(again.status).toBe(404);
    const [row] = await shared!.admin<Array<{ status: string }>>`
      select status from connections where id = ${connectionId}`;
    expect(row!.status).toBe("revoked");
  });
});

describe("connected vaults reached from another workspace", () => {
  test("an Only-me vault syncs and reveals with its owner's token in every workspace it reaches", async () => {
    if (!available) return;
    await resetOnePasswordFakeProvidersForTests();
    const personal = await freshWorkspace();
    const team = await siblingWorkspace(personal);
    // The token is added in the team workspace; the Only-me vault follows its owner.
    const installed = await install(team, { token: FAKE_HEALTHY, ownership: "user" });
    expect(installed.status).toBe(201);
    const linked = await callAs(team, "subject-a", "POST", "/vaults/link", MANAGE, {
      provider: "onepassword",
      connectionId: installed.body.connectionId,
      externalVaultId: installed.body.vaults[0].externalVaultId,
      ownerKind: "user",
      mode: "read_only",
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ syncStatus: "ok", itemCount: 6 });

    const fromPersonal = await callAs(
      personal,
      "subject-a",
      "POST",
      `/vaults/${linked.body.id}/sync`,
      MANAGE,
    );
    expect(fromPersonal.status).toBe(200);
    expect(fromPersonal.body).toMatchObject({ syncStatus: "ok", syncErrorCode: null });

    const items = await callAs(
      personal,
      "subject-a",
      "GET",
      `/vaults/${linked.body.id}/items`,
      MANAGE,
    );
    const github = items.body.items.find((item: { name: string }) => item.name === "GitHub");
    const item = await callAs(
      personal,
      "subject-a",
      "GET",
      `/vaults/${linked.body.id}/items/${github.id}`,
      MANAGE,
    );
    const password = item.body.fields.find((field: { name: string }) => field.name === "password");
    const revealed = await callAs(
      personal,
      "subject-a",
      "POST",
      `/vaults/${linked.body.id}/items/${github.id}/fields/${password.id}/reveal`,
      [...MANAGE, "secrets:use"],
      {},
    );
    expect(revealed.status).toBe(200);
    expect(revealed.body.value.length).toBeGreaterThan(0);
  });

  test("another person can never load someone's personal token, in any workspace", async () => {
    if (!available) return;
    const personal = await freshWorkspace();
    const team = await siblingWorkspace(personal);
    const installed = await install(team, { token: FAKE_HEALTHY, ownership: "user" });
    for (const workspace of [personal, team]) {
      const registry = createWorkspaceVaultProviderRegistry({
        db: client.db,
        settings,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-b",
        onePasswordVaultProvider: async () => createFakeVaultProvider(),
      });
      await expect(
        registry.forVault({
          source: "onepassword",
          providerConnectionId: installed.body.connectionId,
        }),
      ).rejects.toMatchObject({ code: "provider_auth_invalid" });
    }
  });

  test("an organization vault loads its organization connection in every workspace it is available in", async () => {
    if (!available) return;
    const personal = await freshWorkspace();
    const team = await siblingWorkspace(personal);
    const installed = await install(team, { token: FAKE_HEALTHY, ownership: "workspace" });
    const connectionId = installed.body.connectionId as string;
    const registryIn = (workspace: Workspace) =>
      createWorkspaceVaultProviderRegistry({
        db: client.db,
        settings,
        workspaceId: workspace.workspaceId,
        subjectId: "subject-b",
        onePasswordVaultProvider: async () => createFakeVaultProvider(),
      });
    // A workspace connection stays in its workspace.
    await expect(
      registryIn(personal).forVault({ source: "onepassword", providerConnectionId: connectionId }),
    ).rejects.toMatchObject({ code: "provider_auth_invalid" });
    // Once an organization vault is linked through it, it serves that vault everywhere.
    await shared!.admin`
      insert into vaults (
        account_id, workspace_id, owner_kind, origin_workspace_id, name, source, mode,
        provider_connection_id, provider_vault_ref
      ) values (
        ${team.accountId}, ${team.workspaceId}, 'organization', ${team.workspaceId}, 'Org 1P',
        'onepassword', 'read_only', ${connectionId}, 'org-vault-ref'
      )`;
    await registryIn(personal).forVault({
      source: "onepassword",
      providerConnectionId: connectionId,
    });
  });
});
