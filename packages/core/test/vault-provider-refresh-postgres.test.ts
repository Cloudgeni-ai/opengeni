// Linked vault mirrors stay current on their own: an item added straight in
// the provider (for example in 1Password) is found by agent search and by a
// reference once the mirror is stale enough to refresh, without anyone
// pressing Sync, and a fresh mirror costs no provider call.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseSecretReference, type SecretPrincipal } from "@opengeni/contracts";
import {
  createDb,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  getVaultItem,
  linkProviderVault,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { createProviderCallBudget, createVaultProviderRegistry } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createSecretResolver, createVaultService } from "../src/domain/vaults";
import { toVaultItemSummary } from "../src/domain/vaults/mapping";
import {
  LINKED_VAULT_MISS_MAX_AGE_MS,
  LINKED_VAULT_SEARCH_MAX_AGE_MS,
  linkedVaultNeedsRefresh,
  syncLinkedProviderVault,
} from "../src/domain/vaults/provider-sync";

setDefaultTimeout(180_000);

// Built at runtime so tooling never treats it as a live reference.
const CARD_REFERENCE = ["{{secret", "Company/Company card/number}}"].join(":");

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-provider-refresh");
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
}, 180_000);

async function world() {
  const db = client!.db;
  const userId = `vault-provider-refresh-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Refresher",
  });
  const grant = access.workspaceGrants[0]!;
  const actor = { grant, accountAdmin: false };
  const subjectId = `user:${userId}`;
  const context: VaultDbContext = {
    kind: "subject",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
  };
  const principal: SecretPrincipal = {
    kind: "human",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId,
    verifiedHuman: true,
    viaApiKey: false,
  };
  const host = createFakeVaultProvider({
    vaults: [
      {
        externalVaultId: "company",
        name: "Company",
        items: [{ name: "Existing", type: "api_key", fields: [{ name: "value", value: "old" }] }],
      },
    ],
  });
  const providers = createVaultProviderRegistry({ host: async () => host });
  const vault = await linkProviderVault(db, context, {
    ownerKind: "workspace",
    name: "Company",
    source: "host",
    providerVaultRef: "company",
    mode: "read_only",
  });
  await syncLinkedProviderVault({ db, context, vaultId: vault.id, providers, force: true });
  // Somebody adds an item straight in the provider, outside Opengeni.
  const addInProvider = async (name: string, value: string) =>
    await host.writeItem({ connectionId: null, budget: createProviderCallBudget(5) }, "company", {
      name,
      type: "note",
      websites: [],
      fields: [{ name: "number", kind: "concealed", value }],
    });
  const ageMirror = async (ms: number) => {
    await shared!.admin`
      update vaults set last_synced_at = now() - make_interval(secs => ${ms / 1000})
      where id = ${vault.id}`;
  };
  const listCalls = () => host.calls.filter((call) => call.op === "listVaults").length;
  return {
    db,
    context,
    host,
    principal,
    actor,
    workspaceId: grant.workspaceId,
    vaultId: vault.id,
    providers,
    addInProvider,
    ageMirror,
    listCalls,
  };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "linked vault mirrors refresh on their own",
  () => {
    test("provider usernames are encrypted, displayed, updated and cleared without storing field values", async () => {
      if (!client) throw new Error("Real PostgreSQL is required");
      const w = await world();
      const key = new Uint8Array(32).fill(7);
      let username: string | null | undefined = "alice@example.com";
      await w.host.writeItem(
        { connectionId: null, budget: createProviderCallBudget(5) },
        "company",
        {
          name: "Provider login",
          type: "login",
          websites: [],
          fields: [
            { name: "username", kind: "text", value: "live-username@example.com" },
            { name: "password", kind: "concealed", value: "provider-password-only" },
            { name: "notes", kind: "text", value: "private-provider-notes" },
          ],
        },
      );
      const list = w.host.listItems.bind(w.host);
      w.host.listItems = async (...args) =>
        (await list(...args)).map((item) =>
          item.type === "login"
            ? { ...item, ...(username !== undefined ? { username } : {}) }
            : item,
        );
      const service = createVaultService({ db: w.db, encryptionKey: key, providers: w.providers });
      const search = async () => {
        const result = await service.searchForAgent(w.principal, {
          query: "Provider login",
          limit: 20,
          refresh: true,
        });
        expect(result.items).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain("provider-password-only");
        expect(JSON.stringify(result)).not.toContain("private-provider-notes");
        return result.items[0]!.item;
      };
      const item = await search();
      expect(item.username).toBe(username);
      const row = await getVaultItem(w.db, w.context, { itemId: item.id });
      expect(row.usernameHintEncrypted).toBeString();
      expect(row.usernameHintEncrypted).not.toContain(username!);
      expect(decryptEnvironmentValue(key, row.usernameHintEncrypted!)).toBe(username!);
      expect(
        row.fields.every((field) => field.valueEncrypted === null && field.currentVersion === null),
      ).toBe(true);
      const [stored] = await shared!.admin`
        select username_hint_encrypted from vault_items where id = ${item.id}`;
      expect(stored!.username_hint_encrypted).toBe(row.usernameHintEncrypted);
      const [versions] = await shared!.admin`
        select count(*)::int as count from vault_field_versions v
        join vault_item_fields f on f.id = v.field_id where f.item_id = ${item.id}`;
      expect(versions!.count).toBe(0);
      expect(w.host.calls.filter((call) => call.op === "readFields")).toHaveLength(0);
      expect(toVaultItemSummary(row, null).username).toBeNull();
      expect(toVaultItemSummary({ ...row, vaultSource: "opengeni" }, key).username).toBeNull();
      const native = {
        ...row,
        vaultSource: "opengeni" as const,
        fields: row.fields.map((field) =>
          field.name === "username"
            ? { ...field, valueEncrypted: encryptEnvironmentValue(key, "native@example.com") }
            : field,
        ),
      };
      expect(toVaultItemSummary(native, key).username).toBe("native@example.com");
      expect(toVaultItemSummary({ ...native, vaultSource: "host" }, key).username).toBe(
        "native@example.com",
      );
      const ui = await service.listItems(w.actor, w.workspaceId, w.vaultId, {});
      expect(ui.items.find((entry) => entry.id === item.id)!.username).toBe(username);
      for (username of ["bob@example.com", "", null, "restored@example.com", undefined]) {
        expect((await search()).username).toBe(username || null);
        const updated = await getVaultItem(w.db, w.context, { itemId: item.id });
        if (!username) expect(updated.usernameHintEncrypted).toBeNull();
        else expect(decryptEnvironmentValue(key, updated.usernameHintEncrypted!)).toBe(username);
      }
    });

    test("agent search finds an item added in the provider once the mirror is stale", async () => {
      if (!client) return;
      const { db, principal, providers, addInProvider, ageMirror, listCalls } = await world();
      const service = createVaultService({ db, encryptionKey: null, providers });
      await addInProvider("Company card", "4111111111111111");

      const before = listCalls();
      const fresh = await service.searchForAgent(principal, { query: "Company card", limit: 20 });
      expect(fresh.items).toEqual([]);
      // A fresh mirror is trusted: no provider call.
      expect(listCalls()).toBe(before);

      await ageMirror(LINKED_VAULT_SEARCH_MAX_AGE_MS + 1_000);
      const stale = await service.searchForAgent(principal, { query: "Company card", limit: 20 });
      expect(stale.items.map((result) => result.item.name)).toEqual(["Company card"]);
      expect(listCalls()).toBe(before + 1);
    });

    test("opening a linked vault shows an item added in the provider once the mirror is stale", async () => {
      if (!client) return;
      const { db, actor, workspaceId, vaultId, providers, addInProvider, ageMirror, listCalls } =
        await world();
      const service = createVaultService({ db, encryptionKey: null, providers });
      await addInProvider("Company card", "4111111111111111");
      const names = async () =>
        (await service.listItems(actor, workspaceId, vaultId, {})).items.map((item) => item.name);

      const before = listCalls();
      expect(await names()).toEqual(["Existing"]);
      // A fresh mirror is trusted: no provider call.
      expect(listCalls()).toBe(before);

      await ageMirror(LINKED_VAULT_SEARCH_MAX_AGE_MS + 1_000);
      expect((await names()).toSorted()).toEqual(["Company card", "Existing"]);
      expect(listCalls()).toBe(before + 1);
    });

    test("a reference that finds nothing refreshes a stale mirror and resolves", async () => {
      if (!client) return;
      const { db, principal, providers, addInProvider, ageMirror } = await world();
      await addInProvider("Company card", "4111111111111111");
      const resolver = createSecretResolver({ db, encryptionKey: null, providers }, principal, {
        capabilityEnabled: true,
      });
      const reference = parseSecretReference(CARD_REFERENCE);
      const use = { surface: "browser", toolName: "browser_act" } as const;

      await expect(resolver.resolve([reference], use)).rejects.toMatchObject({
        failures: [expect.objectContaining({ code: "not_found" })],
      });

      await ageMirror(LINKED_VAULT_MISS_MAX_AGE_MS + 1_000);
      const resolved = await resolver.resolve([reference], use);
      expect([...resolved.values()][0]!.material).toEqual({
        type: "text",
        value: "4111111111111111",
      });
    });
  },
);

describe("linkedVaultNeedsRefresh", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  const base = {
    id: "v",
    source: "onepassword",
    syncStatus: "ok" as const,
    lastSyncedAt: "2026-01-01T11:55:00.000Z",
    rateLimitedUntil: null,
    updatedAt: "2026-01-01T11:59:00.000Z",
  };

  test("hosted vaults never refresh", () => {
    expect(linkedVaultNeedsRefresh({ ...base, source: "opengeni" }, 0, now)).toBe(false);
  });

  test("an ok mirror ages from its last sync", () => {
    expect(linkedVaultNeedsRefresh(base, 4 * 60_000, now)).toBe(true);
    expect(linkedVaultNeedsRefresh(base, 6 * 60_000, now)).toBe(false);
    expect(linkedVaultNeedsRefresh({ ...base, lastSyncedAt: null }, 6 * 60_000, now)).toBe(true);
  });

  test("a failed sync retries once per period, counted from the failure", () => {
    const failed = { ...base, syncStatus: "error" as const };
    expect(linkedVaultNeedsRefresh(failed, 4 * 60_000, now)).toBe(false);
    expect(linkedVaultNeedsRefresh(failed, 30_000, now)).toBe(true);
  });

  test("a provider rate limit is respected until it lifts", () => {
    const limited = { ...base, rateLimitedUntil: "2026-01-01T12:05:00.000Z" };
    expect(linkedVaultNeedsRefresh(limited, 0, now)).toBe(false);
  });
});
