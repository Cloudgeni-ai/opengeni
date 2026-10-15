import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  signDelegatedAccessToken,
  type Permission,
  type VaultProviderCredentials,
} from "@opengeni/contracts";
import {
  type ExternalVaultProviderFactories,
  externalVaultConnectionDetails,
  loadExternalVaultConnection,
} from "@opengeni/core";
import {
  createDb,
  decryptEnvironmentValue,
  getConnectionMetadata,
  type DbClient,
} from "@opengeni/db";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { VaultProviderError } from "@opengeni/vaults";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import {
  createExternalVaultReceiver,
  createInMemoryExternalVaultReceiverStore,
} from "../../../packages/sdk/src/external-vault-receiver";

const delegationSecret = randomBytes(32).toString("hex");
const encryptionKey = randomBytes(32).toString("base64");
const signingSecret = randomBytes(32).toString("hex");
let shared: SharedTestDatabase | null;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-external-vault-providers");
  if (!shared) return;
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret,
    environmentsEncryptionKey: encryptionKey,
    publicBaseUrl: "https://app.example.test",
  }) as Settings;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Scope = { accountId: string; workspaceId: string };
async function scope(): Promise<Scope> {
  const [account] = await shared!.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('vault test') returning id`;
  const [workspace] = await shared!.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${account!.id}, 'vault test') returning id`;
  await shared!
    .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${account!.id}, 'person-a', 'active', ${workspace!.id})`;
  for (const person of ["person-a", "person-b"]) {
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, subject_label, role, permissions)
      values (${account!.id}, ${workspace!.id}, ${person}, ${person}, 'member', ${shared!.admin.json(["connections:read", "connections:write", "secrets:list", "secrets:write"])})`;
  }
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function fixture(useDefaultProviders = false) {
  const calls: unknown[] = [];
  let accountId = "upstream-account-a";
  let keeperUnavailable = true;
  let bootstrapCount = 0;
  const boundConfig = { appKey: "bound-fixture-key", clientId: "keeper-fixture-client" };
  const factories: ExternalVaultProviderFactories = {
    external: async ({ credentials }) => {
      calls.push("factory");
      const fake = createFakeVaultProvider({
        vaults: [{ externalVaultId: "remote-vault", name: "Remote" }],
      });
      return {
        provider: {
          ...fake,
          id: "external" as const,
          validate: async () => ({ accountId, accountName: "Example" }),
        },
        credentials: credentials as Extract<VaultProviderCredentials, { provider: "external" }>,
      };
    },
    keeper: async ({ credentials, persistCredentials }) => {
      if (credentials.provider !== "keeper") throw new Error("fixture provider mismatch");
      if ("oneTimeToken" in credentials) {
        bootstrapCount++;
        await persistCredentials!({ provider: "keeper", configuration: boundConfig });
      }
      const fake = createFakeVaultProvider({
        vaults: [{ externalVaultId: "keeper-folder", name: "Keeper" }],
      });
      return {
        provider: {
          ...fake,
          id: "keeper" as const,
          validate: async () => {
            if (keeperUnavailable)
              throw new VaultProviderError(
                "provider_unavailable",
                "Provider temporarily unavailable",
              );
            return { accountId: "keeper-account", accountName: "Keeper" };
          },
        },
        credentials: { provider: "keeper" as const, configuration: boundConfig },
      };
    },
  };
  const app = createApp({
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    ...(useDefaultProviders ? {} : { externalVaultProviders: factories }),
  } as never);
  async function request(
    nativeScope: Scope,
    path: string,
    method = "GET",
    body?: unknown,
    options: { person?: string; permissions?: Permission[]; machine?: boolean } = {},
  ) {
    const token = await signDelegatedAccessToken(delegationSecret, {
      ...nativeScope,
      subjectId: options.person ?? "person-a",
      permissions: options.permissions ?? [
        "connections:read",
        "connections:write",
        "secrets:list",
        "secrets:write",
      ],
      principalKind: options.machine ? "service" : "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return app.request(`/v1/workspaces/${nativeScope.workspaceId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return {
    request,
    calls,
    switchAccount: () => {
      accountId = "upstream-account-b";
    },
    recoverKeeper: () => {
      keeperUnavailable = false;
    },
    bootstrapCount: () => bootstrapCount,
  };
}
const installBody = (ownership = "workspace") => ({
  ownership,
  credentials: {
    provider: "external",
    endpoint: "https://vault.example.test/resolve",
    signingSecret,
  },
});

describe("generic external vault connection lifecycle", () => {
  test("catalog reports deployment availability before the first connection", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture();
    const response = await f.request(native, "/vault-providers/connections");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connections: [],
      providers: [
        { provider: "onepassword", available: true, reason: null },
        { provider: "external", available: true, reason: null },
        { provider: "protonpass", available: false, reason: "not_enabled" },
        { provider: "keeper", available: true, reason: null },
        { provider: "bitwarden", available: false, reason: "not_enabled" },
      ],
    });
    expect(f.calls).toHaveLength(0);
  }, 30_000);
  test("default signed remote connection supports register, verify and metadata-only discovery", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture(true);
    let registeredId: string | null = null;
    let authorizedCalls = 0;
    const receiver = createExternalVaultReceiver({
      resolveConnection: async (id) =>
        id === registeredId
          ? {
              provider: "external",
              signingSecrets: [signingSecret],
              accountId: native.accountId,
              connectionWorkspaceId: native.workspaceId,
              context: { tenantId: "fixture-tenant" },
            }
          : null,
      authorize: async ({ authority, connection }) => {
        authorizedCalls++;
        expect(authority).toMatchObject({
          accountId: native.accountId,
          workspaceId: native.workspaceId,
        });
        expect(connection).toEqual({ tenantId: "fixture-tenant" });
        return authority.subjectId === "person-a" ? { id: "fixture-user" } : null;
      },
      store: createInMemoryExternalVaultReceiverStore(),
      handlers: {
        describe: async () => ({
          result: {
            accountId: "fixture-tenant",
            accountName: "Product vaults",
            inventoryScope: "connection",
            operations: {
              createItemTypes: [],
              updateItem: false,
              removeField: false,
              archiveItem: false,
              archiveKind: "none",
              deleteItem: false,
              restoreItem: false,
              readFiles: false,
              writeFiles: false,
              createTotp: false,
              updateTotp: false,
              createVault: false,
              restoreFieldHistory: false,
            },
            capabilities: { totp: false, files: false },
          },
        }),
        listVaults: async () => ({
          result: {
            items: [
              {
                externalVaultId: "product-vault",
                name: "Product",
                contentVersion: null,
                itemCount: 0,
                writeAccess: "read_only",
              },
            ],
            nextCursor: null,
            snapshot: "fixture-1",
          },
        }),
        listItems: async () => ({ result: { items: [], nextCursor: null, snapshot: "fixture-1" } }),
        readFields: async () => {
          throw new Error("Metadata discovery must not resolve values");
        },
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => receiver.fetch(req),
    });
    try {
      const installed = await f.request(native, "/vault-providers/connections", "POST", {
        ownership: "user",
        credentials: { provider: "external", endpoint: server.url.href, signingSecret },
      });
      expect(installed.status).toBe(202);
      const pending = (await installed.json()) as {
        connectionId: string;
        discoveryPending: boolean;
      };
      expect(pending.discoveryPending).toBe(true);
      expect(authorizedCalls).toBe(0);
      registeredId = pending.connectionId;
      const verified = await f.request(
        native,
        `/vault-providers/connections/${registeredId}/verify`,
        "POST",
        {},
      );
      expect(verified.status).toBe(200);
      expect(await verified.json()).toMatchObject({
        connectionId: registeredId,
        provider: "external",
        vaults: [{ externalVaultId: "product-vault", writeAccess: "read_only" }],
      });
      expect(authorizedCalls).toBe(2);
      const metadata = await f.request(native, "/vault-providers/connections");
      expect(metadata.status).toBe(200);
      const text = await metadata.text();
      expect(text).not.toContain(signingSecret);
      expect(text).toContain(registeredId!);
      expect(authorizedCalls).toBe(2);
      const catalog = await f.request(native, `/connections/${registeredId}/provider-vaults`);
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toMatchObject({
        vaults: [{ externalVaultId: "product-vault" }],
      });
      expect(authorizedCalls).toBe(3);
      expect(
        (
          await f.request(
            native,
            `/connections/${registeredId}/provider-vaults`,
            "GET",
            undefined,
            { person: "person-b" },
          )
        ).status,
      ).toBe(404);
      expect(authorizedCalls).toBe(3);
      expect(
        (await f.request(native, `/vault-providers/connections/${registeredId}`, "DELETE")).status,
      ).toBe(200);
      expect(authorizedCalls).toBe(3);
      expect((await f.request(native, `/connections/${registeredId}/provider-vaults`)).status).toBe(
        404,
      );
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("retains Keeper bound keys after partial setup and resumes without replaying the token", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture();
    const oneTimeToken = randomBytes(32).toString("hex");
    const response = await f.request(native, "/vault-providers/connections", "POST", {
      ownership: "workspace",
      credentials: { provider: "keeper", oneTimeToken },
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { connectionId: string; discoveryPending: boolean };
    expect(body.discoveryPending).toBe(true);
    expect(f.bootstrapCount()).toBe(1);
    const [row] = await shared.admin<
      { credential_encrypted: string }[]
    >`select credential_encrypted from connections where id = ${body.connectionId}`;
    const stored = decryptEnvironmentValue(
      Buffer.from(encryptionKey, "base64"),
      row!.credential_encrypted,
    );
    expect(stored).toContain("bound-fixture-key");
    expect(stored).not.toContain(oneTimeToken);
    const pending = await f.request(native, "/vault-providers/connections");
    expect(await pending.json()).toMatchObject({
      connections: [{ id: body.connectionId, verificationStatus: "pending" }],
    });
    expect(
      (await f.request(native, `/connections/${body.connectionId}/provider-vaults`)).status,
    ).toBe(401);
    f.recoverKeeper();
    const verified = await f.request(
      native,
      `/vault-providers/connections/${body.connectionId}/verify`,
      "POST",
      {},
    );
    expect(verified.status).toBe(200);
    expect(f.bootstrapCount()).toBe(1);
    expect(await verified.json()).toMatchObject({
      connectionId: body.connectionId,
      provider: "keeper",
      vaults: [{ externalVaultId: "keeper-folder" }],
    });
    expect(
      (await getConnectionMetadata(client.db, native.workspaceId, body.connectionId, "person-a"))
        ?.status,
    ).toBe("active");
  }, 30_000);

  test("stores credentials encrypted and lists metadata without resolving upstream", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture();
    const response = await f.request(native, "/vault-providers/connections", "POST", installBody());
    expect(response.status).toBe(201);
    const body = (await response.json()) as { connectionId: string };
    expect(JSON.stringify(body)).not.toContain(signingSecret);
    const connection = await getConnectionMetadata(
      client.db,
      native.workspaceId,
      body.connectionId,
      "person-a",
    );
    expect(externalVaultConnectionDetails(connection!.metadata)).toMatchObject({
      provider: "external",
      ownership: "workspace",
      accountId: "upstream-account-a",
    });
    expect(JSON.stringify(connection)).not.toContain(signingSecret);
    const [row] = await shared.admin<
      { credential_encrypted: string }[]
    >`select credential_encrypted from connections where id = ${body.connectionId}`;
    const stored = JSON.parse(
      decryptEnvironmentValue(Buffer.from(encryptionKey, "base64"), row!.credential_encrypted),
    );
    expect(stored).toEqual(installBody().credentials);
    expect(stored.headers).toBeUndefined();
    const calls = f.calls.length;
    const listed = await f.request(native, "/vault-providers/connections");
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).toContain(body.connectionId);
    expect(text).not.toContain(signingSecret);
    expect(f.calls).toHaveLength(calls);
    const forged = await f.request(native, "/connections", "POST", {
      providerDomain: "vault:external",
      kind: "api_key",
      ownership: "workspace",
      credential: { headers: { authorization: "fixture" } },
      metadata: connection!.metadata,
    });
    expect(forged.status).toBe(422);
    expect(
      (await f.request(native, `/connections/${body.connectionId}`, "PATCH", { status: "active" }))
        .status,
    ).toBe(422);
    expect((await f.request(native, `/connections/${body.connectionId}`, "DELETE")).status).toBe(
      422,
    );
  }, 30_000);

  test("personal inventory is invisible to another person and tenant", async () => {
    if (!shared) return;
    const native = await scope();
    const other = await scope();
    const f = fixture();
    const installed = await f.request(
      native,
      "/vault-providers/connections",
      "POST",
      installBody("user"),
    );
    expect(installed.status).toBe(201);
    const { connectionId } = (await installed.json()) as { connectionId: string };
    const calls = f.calls.length;
    expect(
      await (
        await f.request(native, "/vault-providers/connections", "GET", undefined, {
          person: "person-b",
        })
      ).json(),
    ).toMatchObject({ connections: [] });
    expect(
      (
        await f.request(native, `/connections/${connectionId}/provider-vaults`, "GET", undefined, {
          person: "person-b",
        })
      ).status,
    ).toBe(404);
    expect((await f.request(other, `/connections/${connectionId}/provider-vaults`)).status).toBe(
      404,
    );
    expect(f.calls).toHaveLength(calls);
  }, 30_000);

  test("permission and personal-owner failures happen before provider setup", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture();
    expect(
      (
        await f.request(native, "/vault-providers/connections", "POST", installBody(), {
          permissions: ["connections:write"],
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.request(native, "/vault-providers/connections", "POST", installBody("organization")))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request(native, "/vault-providers/connections", "POST", installBody("user"), {
          machine: true,
        })
      ).status,
    ).toBe(403);
    expect(f.calls).toHaveLength(0);
  }, 30_000);

  test("reconnect refuses an unexpected account; disconnect only revokes locally", async () => {
    if (!shared) return;
    const native = await scope();
    const f = fixture();
    const installed = await f.request(
      native,
      "/vault-providers/connections",
      "POST",
      installBody(),
    );
    const { connectionId } = (await installed.json()) as { connectionId: string };
    f.switchAccount();
    const replacementSecret = randomBytes(32).toString("hex");
    const replaced = await f.request(
      native,
      `/vault-providers/connections/${connectionId}/credentials`,
      "PUT",
      { credentials: { ...installBody().credentials, signingSecret: replacementSecret } },
    );
    expect(replaced.status).toBe(409);
    expect(
      externalVaultConnectionDetails(
        (await getConnectionMetadata(client.db, native.workspaceId, connectionId, "person-a"))!
          .metadata,
      )?.accountId,
    ).toBe("upstream-account-a");
    const stillWorking = await loadExternalVaultConnection(client.db, settings, {
      workspaceId: native.workspaceId,
      connectionId,
      subjectId: "person-a",
      provider: "external",
    });
    expect(stillWorking.credentials).toEqual(installBody().credentials);
    expect(stillWorking.pendingCredentials).toMatchObject({ signingSecret: replacementSecret });
    const calls = f.calls.length;
    const disconnected = await f.request(
      native,
      `/vault-providers/connections/${connectionId}`,
      "DELETE",
    );
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ unlinkedVaultIds: [] });
    expect(f.calls).toHaveLength(calls);
    expect(
      (await getConnectionMetadata(client.db, native.workspaceId, connectionId, "person-a"))
        ?.status,
    ).toBe("revoked");
  }, 30_000);
});
