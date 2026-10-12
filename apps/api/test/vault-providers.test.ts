import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
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
