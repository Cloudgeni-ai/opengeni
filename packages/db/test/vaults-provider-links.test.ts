// Provider vault links (W5, 0739 W5 section): link_provider_vault and
// provider_vault_sync_target as the application role, plus the mirror and
// sync-status routines they feed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createConnection,
  createDb,
  createVault,
  createWorkspace,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getProviderVaultSyncTarget,
  isVaultError,
  linkProviderVault,
  listVaultItems,
  setVaultSyncStatus,
  upsertProviderVaultItems,
  upsertVaultItem,
  type DbClient,
  type VaultDbContext,
} from "../src";

setDefaultTimeout(180_000);

const key = Buffer.alloc(32, 9);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vaults-provider-links");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function expectVaultError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    if (!isVaultError(error)) throw error;
    expect(error.code as string).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function world() {
  const db = client!.db;
  const user = `vault-links-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId: user,
    email: `${user}@example.test`,
    name: "Vault links",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const subjectId = `user:${user}`;
  const workspace = await createWorkspace(db, { accountId, name: "Vault links" });
  const context: VaultDbContext = {
    kind: "subject",
    accountId,
    workspaceId: workspace.id,
    subjectId,
  };
  const connection = async (personal: boolean) =>
    await createConnection(db, {
      accountId,
      workspaceId: workspace.id,
      subjectId: personal ? subjectId : null,
      providerDomain: "1password.com",
      kind: "api_key",
      credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify({ token: "redacted" })),
      grantedScopes: [],
      expiresAt: null,
      metadata: { credentialRole: "onepassword_service_account", planTier: "family" },
      createdBySubjectId: subjectId,
    });
  return { db, accountId, subjectId, workspaceId: workspace.id, context, connection };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "provider vault links",
  () => {
    test("links a 1Password vault, mirrors metadata and reports sync state", async () => {
      const w = await world();
      const sharedConnection = await w.connection(false);
      const linked = await linkProviderVault(w.db, w.context, {
        ownerKind: "workspace",
        name: "OpenGeni Test RW",
        source: "onepassword",
        providerConnectionId: sharedConnection.id,
        providerVaultRef: "vaultrw0001",
        mode: "read_write",
      });
      expect(linked).toMatchObject({
        source: "onepassword",
        mode: "read_write",
        providerConnectionId: sharedConnection.id,
        providerVaultRef: "vaultrw0001",
        syncStatus: "syncing",
        itemCount: 0,
      });
      expect(await getProviderVaultSyncTarget(w.db, w.context, linked.id)).toEqual({
        vaultId: linked.id,
        workspaceId: w.workspaceId,
        source: "onepassword",
        mode: "read_write",
        providerConnectionId: sharedConnection.id,
        providerVaultRef: "vaultrw0001",
        providerContentVersion: null,
        rateLimitedUntil: null,
      });

      await upsertProviderVaultItems(w.db, w.context, {
        vaultId: linked.id,
        contentVersion: "12",
        items: [
          {
            providerItemRef: "item0001",
            providerVersion: "3",
            type: "login",
            name: "Test Login",
            websites: ["https://example.test"],
            primaryFieldRef: "password",
            fields: [
              { providerFieldRef: "username", name: "username", kind: "text" },
              { providerFieldRef: "password", name: "password", kind: "concealed" },
              { providerFieldRef: "TOTP_1", name: "one-time password", kind: "totp" },
            ],
          },
        ],
      });
      const page = await listVaultItems(w.db, w.context, { vaultId: linked.id });
      expect(page.items.map((item) => item.name)).toEqual(["Test Login"]);
      const target = await getProviderVaultSyncTarget(w.db, w.context, linked.id);
      expect(target.providerContentVersion).toBe("12");

      const until = new Date(Date.now() + 60_000).toISOString();
      await setVaultSyncStatus(w.db, w.context, {
        vaultId: linked.id,
        status: "rate_limited",
        errorCode: "provider_rate_limited",
        errorMessage: "429",
        rateLimitedUntil: until,
      });
      const limited = await getProviderVaultSyncTarget(w.db, w.context, linked.id);
      expect(new Date(limited.rateLimitedUntil!).getTime()).toBe(new Date(until).getTime());

      // Items in a connected vault change only through the provider.
      await expectVaultError(
        upsertVaultItem(w.db, w.context, {
          vaultId: linked.id,
          name: "Direct",
          type: "api_key",
          fields: [],
        }),
        "vault_read_only",
      );
    });

    test("refuses duplicates, foreign connections and personal tokens for shared vaults", async () => {
      const w = await world();
      const sharedConnection = await w.connection(false);
      const personalConnection = await w.connection(true);
      await linkProviderVault(w.db, w.context, {
        ownerKind: "workspace",
        name: "RO",
        source: "onepassword",
        providerConnectionId: sharedConnection.id,
        providerVaultRef: "vaultro0001",
        mode: "read_only",
      });
      await expectVaultError(
        linkProviderVault(w.db, w.context, {
          ownerKind: "workspace",
          name: "RO again",
          source: "onepassword",
          providerConnectionId: sharedConnection.id,
          providerVaultRef: "vaultro0001",
          mode: "read_only",
        }),
        "vault_name_conflict",
      );
      await expectVaultError(
        linkProviderVault(w.db, w.context, {
          ownerKind: "workspace",
          name: "Unknown connection",
          source: "onepassword",
          providerConnectionId: crypto.randomUUID(),
          providerVaultRef: "vaultx",
          mode: "read_only",
        }),
        "vault_not_found",
      );
      await expectVaultError(
        linkProviderVault(w.db, w.context, {
          ownerKind: "workspace",
          name: "Personal token, shared vault",
          source: "onepassword",
          providerConnectionId: personalConnection.id,
          providerVaultRef: "vaultp0001",
          mode: "read_only",
        }),
        "vault_permission_denied",
      );
      const mine = await linkProviderVault(w.db, w.context, {
        ownerKind: "user",
        name: "My 1Password",
        source: "onepassword",
        providerConnectionId: personalConnection.id,
        providerVaultRef: "vaultp0001",
        mode: "read_write",
      });
      expect(mine.ownerKind).toBe("user");
      await expectVaultError(
        linkProviderVault(w.db, w.context, {
          ownerKind: "organization",
          name: "Org without admin",
          source: "host",
          providerVaultRef: "host-vault",
          mode: "read_only",
        }),
        "vault_permission_denied",
      );
    });

    test("links host vaults without a connection; hosted vaults have no sync target", async () => {
      const w = await world();
      const host = await linkProviderVault(w.db, w.context, {
        ownerKind: "workspace",
        name: "Host secrets",
        source: "host",
        providerConnectionId: crypto.randomUUID(),
        providerVaultRef: "host-vault",
        mode: "read_only",
      });
      expect(host).toMatchObject({ source: "host", providerConnectionId: null });
      const hosted = await createVault(w.db, w.context, { name: "Hosted", ownerKind: "workspace" });
      await expectVaultError(
        getProviderVaultSyncTarget(w.db, w.context, hosted.id),
        "vault_permission_denied",
      );
      await expectVaultError(
        getProviderVaultSyncTarget(w.db, w.context, crypto.randomUUID()),
        "vault_not_found",
      );
    });
  },
);
