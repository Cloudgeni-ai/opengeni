import { afterAll, beforeAll, expect, test } from "bun:test";
import { parseSecretReference } from "@opengeni/contracts";
import {
  createDb,
  ensureManagedAccessForUser,
  getVault,
  getProviderVaultSyncTarget,
  linkProviderVault,
  listVaultItems,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createVaultProviderRegistry, VaultProviderError } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { syncLinkedProviderVault } from "../src/domain/vaults/provider-sync";
import { createSecretResolver } from "../src/domain/vaults/secret-resolver";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-refresh-order");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function world() {
  const db = client!.db;
  const userId = `refresh-order-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Refresher",
  });
  const { accountId, workspaceId } = access.workspaceGrants[0]!;
  const context: VaultDbContext = {
    kind: "subject",
    accountId,
    workspaceId,
    subjectId: `user:${userId}`,
  };
  const vault = await linkProviderVault(db, context, {
    ownerKind: "workspace",
    name: "Company",
    source: "host",
    providerVaultRef: "company",
    mode: "read_only",
  });
  const fake = createFakeVaultProvider({
    vaults: [{ externalVaultId: "company", name: "Company" }],
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registry = (version: string, paused = false, failure: boolean | "rate_limited" = false) =>
    createVaultProviderRegistry({
      host: async () => ({
        ...fake,
        async listVaults(ctx) {
          ctx.onFreshness?.({
            state: "current",
            lastCheckedAt: null,
            errorCode: null,
            retryAt: null,
            source: "live",
            sourceSyncedAt: version === "old" ? "2026-10-15T10:00:00Z" : "2026-10-15T11:00:00Z",
          });
          return [
            { externalVaultId: "company", name: "Company", itemCount: 1, contentVersion: version },
          ];
        },
        async listItems() {
          if (paused) {
            started.resolve();
            await release.promise;
          }
          if (failure)
            throw new VaultProviderError(
              failure === "rate_limited" ? "provider_rate_limited" : "provider_unavailable",
              "fixture unavailable",
              60_000,
            );
          return [
            {
              externalItemId: version,
              name: version,
              type: "api_key" as const,
              websites: [],
              fields: [{ externalFieldId: "value", name: "value", kind: "concealed" as const }],
              version,
              updatedAt: null,
            },
          ];
        },
        async readFields(_ctx, _vault, _item, fields) {
          return fields.map((externalFieldId) => ({
            externalFieldId,
            material: { type: "text" as const, value: "live value" },
          }));
        },
      }),
    });
  const sync = (providers: ReturnType<typeof registry>, force = true) =>
    syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force });
  return { db, context, vault, registry, sync, started, release };
}

for (const failure of [false, true]) {
  test(`a late ${failure ? "failure" : "complete inventory"} cannot overwrite a newer completed refresh`, async () => {
    if (!client) return;
    const w = await world();
    const older = w.sync(w.registry("old", true, failure));
    await w.started.promise;
    try {
      expect((await w.sync(w.registry("new"))).status).toBe("synced");
    } finally {
      w.release.resolve();
    }
    expect((await older).status).toBe("superseded");
    const row = await getVault(w.db, w.context, { vaultId: w.vault.id });
    expect(
      (await getProviderVaultSyncTarget(w.db, w.context, w.vault.id)).providerContentVersion,
    ).toBe("new");
    expect(row.syncStatus).toBe("ok");
    expect(row.providerFreshness?.sourceSyncedAt).toBe("2026-10-15T11:00:00.000Z");
    expect(
      (await listVaultItems(w.db, w.context, { vaultId: w.vault.id })).items.map(
        (item) => item.name,
      ),
    ).toEqual(["new"]);
    expect((await w.sync(w.registry("new"), false)).status).toBe("unchanged");
  }, 180_000);
}

test("an unchanged newer check also fences a late complete inventory", async () => {
  if (!client) return;
  const w = await world();
  await w.sync(w.registry("new"));
  const older = w.sync(w.registry("old", true));
  await w.started.promise;
  try {
    expect((await w.sync(w.registry("new"), false)).status).toBe("unchanged");
  } finally {
    w.release.resolve();
  }
  expect((await older).status).toBe("superseded");
  const row = await getVault(w.db, w.context, { vaultId: w.vault.id });
  expect(
    (await getProviderVaultSyncTarget(w.db, w.context, w.vault.id)).providerContentVersion,
  ).toBe("new");
  expect(row.providerFreshness?.sourceSyncedAt).toBe("2026-10-15T11:00:00.000Z");
}, 180_000);

test("a reference miss rereads candidates after another refresh supersedes its inventory", async () => {
  if (!client) return;
  const w = await world();
  const resolver = createSecretResolver(
    { db: w.db, encryptionKey: null, providers: w.registry("old", true) },
    {
      kind: "human",
      accountId: w.context.accountId,
      workspaceId: w.context.workspaceId,
      subjectId: w.context.subjectId,
      verifiedHuman: true,
      viaApiKey: false,
    },
    { capabilityEnabled: true },
  );
  const reference = parseSecretReference(["{{secret", "Company/new/value}}"].join(":"));
  const resolving = resolver.resolve([reference], { surface: "browser", toolName: "browser_act" });
  await w.started.promise;
  try {
    await w.sync(w.registry("new"));
  } finally {
    w.release.resolve();
  }
  expect([...(await resolving)].map(([, value]) => value.material)).toEqual([
    { type: "text", value: "live value" },
  ]);
}, 180_000);

test("an older inventory cannot clear the rate limit from a newer completed check", async () => {
  if (!client) return;
  const w = await world();
  const older = w.sync(w.registry("old", true));
  await w.started.promise;
  try {
    expect(await w.sync(w.registry("new", false, "rate_limited"))).toMatchObject({
      status: "failed",
      code: "provider_rate_limited",
    });
  } finally {
    w.release.resolve();
  }
  expect((await older).status).toBe("superseded");
  expect((await getVault(w.db, w.context, { vaultId: w.vault.id })).syncStatus).toBe(
    "rate_limited",
  );
  expect((await w.sync(w.registry("new"))).status).toBe("skipped_rate_limited");
}, 180_000);
