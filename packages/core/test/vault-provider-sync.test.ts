import { describe, expect, test } from "bun:test";
import { VAULT_LIMITS, type VaultProviderFreshness } from "@opengeni/contracts";
import {
  createProviderCallBudget,
  VaultProviderError,
  type ProviderItemMeta,
  type ProviderPage,
  type ProviderVault,
  type VaultProvider,
  type VaultProviderContext,
} from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import {
  aggregateProviderFreshness,
  PROVIDER_RATE_LIMIT_DEFAULT_BACKOFF_MS,
  planProviderMirror,
  providerPrimaryFieldId,
  providerSecretName,
  providerVaultFreshness,
  syncProviderVault,
  vaultRefreshScopeKey,
  type ProviderMirrorPlan,
  type ProviderMirrorStore,
  type ProviderSyncStatusUpdate,
} from "../src/domain/vaults/provider-sync";

function memoryStore() {
  const plans: ProviderMirrorPlan[] = [];
  const statuses: ProviderSyncStatusUpdate[] = [];
  const store: ProviderMirrorStore = {
    async replaceMirror(plan) {
      plans.push(plan);
    },
    async setSyncStatus(update) {
      statuses.push(update);
    },
  };
  return { store, plans, statuses };
}

const ctx = () => ({ connectionId: null, budget: createProviderCallBudget(50) });
const NOW = new Date("2026-10-12T12:00:00.000Z");

describe("provider mirror planning", () => {
  test("sanitizes and de-duplicates item names deterministically", () => {
    const field = { externalFieldId: "p", name: "password", kind: "concealed" as const };
    const items = [
      {
        externalItemId: "b",
        name: "GitHub",
        type: "login" as const,
        websites: [],
        fields: [field],
        version: "1",
        updatedAt: null,
      },
      {
        externalItemId: "a",
        name: "github",
        type: "login" as const,
        websites: [],
        fields: [field],
        version: "1",
        updatedAt: null,
      },
      {
        externalItemId: "c",
        name: "a/b {x}",
        type: "login" as const,
        websites: [],
        fields: [field],
        version: "1",
        updatedAt: null,
      },
      {
        externalItemId: "d",
        name: "  ",
        type: "note" as const,
        websites: [],
        fields: [],
        version: null,
        updatedAt: null,
      },
      {
        externalItemId: "e",
        name: "id:raw",
        type: "login" as const,
        websites: [],
        fields: [],
        version: null,
        updatedAt: null,
      },
    ];
    const first = planProviderMirror(items, "7");
    const second = planProviderMirror([...items].reverse(), "7");
    expect(first).toEqual(second);
    expect(first.items.map((item) => [item.externalItemId, item.name])).toEqual([
      ["d", "Untitled"],
      ["c", "a-b -x-"],
      ["a", "github"],
      ["b", "GitHub (2)"],
      ["e", "id-raw"],
    ]);
    expect(first.items.find((item) => item.externalItemId === "b")?.providerName).toBe("GitHub");
  });

  test("field names are unique per item and never the reserved otp", () => {
    const plan = planProviderMirror(
      [
        {
          externalItemId: "x",
          name: "X",
          type: "login",
          websites: [],
          version: null,
          updatedAt: null,
          fields: [
            { externalFieldId: "1", name: "password", kind: "concealed" },
            { externalFieldId: "2", name: "Password", kind: "concealed" },
            { externalFieldId: "3", name: "OTP", kind: "totp" },
          ],
        },
      ],
      null,
    );
    expect(plan.items[0]?.fields.map((field) => field.name)).toEqual([
      "password",
      "Password (2)",
      "otp code",
    ]);
    expect(plan.items[0]?.hasTotp).toBe(true);
  });

  test("primary field fallback: type default, then password, value, credential, note, first concealed", () => {
    const f = (
      externalFieldId: string,
      name: string,
      kind: "text" | "concealed" | "totp" = "concealed",
    ) => ({
      externalFieldId,
      name,
      kind,
    });
    expect(
      providerPrimaryFieldId({
        type: "login",
        fields: [f("u", "username", "text"), f("p", "password")],
      }),
    ).toBe("p");
    expect(
      providerPrimaryFieldId({ type: "api_key", fields: [f("c", "credential"), f("v", "value")] }),
    ).toBe("v");
    expect(
      providerPrimaryFieldId({ type: "api_key", fields: [f("x", "secret"), f("c", "credential")] }),
    ).toBe("c");
    expect(providerPrimaryFieldId({ type: "login", fields: [f("n", "note", "text")] })).toBe("n");
    expect(
      providerPrimaryFieldId({
        type: "login",
        fields: [f("t", "one-time", "totp"), f("k", "api secret")],
      }),
    ).toBe("k");
    expect(
      providerPrimaryFieldId({
        type: "login",
        fields: [f("t", "otp", "totp"), f("u", "username", "text")],
      }),
    ).toBeNull();
  });

  test("names stay valid at the 120 character limit", () => {
    const long = "n".repeat(200);
    expect([...providerSecretName(long)].length).toBe(120);
  });

  test("a vault above the native item limit is refused whole, never mirrored as its first items", () => {
    const item = (index: number): ProviderItemMeta => ({
      externalItemId: `item-${index}`,
      name: `Item ${index}`,
      type: "login",
      websites: [],
      fields: [],
      version: null,
      updatedAt: null,
    });
    const atLimit = Array.from({ length: VAULT_LIMITS.itemsPerVault }, (_, index) => item(index));
    const plan = planProviderMirror(atLimit, "7");
    expect(plan.items).toHaveLength(VAULT_LIMITS.itemsPerVault);
    expect(plan.truncated).toBe(0);
    expect(() => planProviderMirror([...atLimit, item(VAULT_LIMITS.itemsPerVault)], "8")).toThrow(
      expect.objectContaining({ code: "provider_inventory_incomplete" }),
    );
  });
});

describe("syncProviderVault", () => {
  test("mirrors items, then skips listItems while contentVersion is unchanged", async () => {
    const provider = createFakeVaultProvider({
      vaults: [
        {
          externalVaultId: "rw",
          name: "RW",
          items: [
            {
              name: "Test Login",
              fields: [
                { name: "username", value: "u" },
                { name: "password", value: "p" },
              ],
            },
          ],
        },
      ],
    });
    const { store, plans, statuses } = memoryStore();
    const first = await syncProviderVault({
      provider,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(first).toEqual({ status: "synced", contentVersion: "1", itemCount: 1, truncated: 0 });
    expect(plans[0]?.items[0]?.name).toBe("Test Login");
    expect(statuses.at(-1)).toMatchObject({ syncStatus: "ok", lastSyncedAt: NOW });

    provider.calls.length = 0;
    const second = await syncProviderVault({
      provider,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: "1", rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(second).toEqual({ status: "unchanged", contentVersion: "1" });
    expect(provider.calls.map((call) => call.op)).toEqual(["listVaults"]);
    expect(plans).toHaveLength(1);
  });

  test("rate limits persist rate_limited with rateLimitedUntil and suppress calls until then", async () => {
    const limited: VaultProvider = {
      ...createFakeVaultProvider({ vaults: [{ externalVaultId: "rw", name: "RW" }] }),
      async listVaults() {
        throw new VaultProviderError("provider_rate_limited", "429 too many requests", 120_000);
      },
    };
    const { store, statuses } = memoryStore();
    const result = await syncProviderVault({
      provider: limited,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    const until = new Date(NOW.getTime() + 120_000);
    expect(result).toEqual({
      status: "failed",
      syncStatus: "rate_limited",
      code: "provider_rate_limited",
      rateLimitedUntil: until,
    });
    expect(statuses.at(-1)).toMatchObject({ syncStatus: "rate_limited", rateLimitedUntil: until });

    const fake = createFakeVaultProvider({ vaults: [{ externalVaultId: "rw", name: "RW" }] });
    const skipped = await syncProviderVault({
      provider: fake,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: until },
      store,
      now: () => NOW,
    });
    expect(skipped).toEqual({ status: "skipped_rate_limited", rateLimitedUntil: until });
    expect(fake.calls).toHaveLength(0);
  });

  test("a rate limit without a hint backs off by the default", async () => {
    const provider = createFakeVaultProvider({ failWith: "provider_rate_limited" });
    const { store } = memoryStore();
    const result = await syncProviderVault({
      provider,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(result.status === "failed" && result.rateLimitedUntil?.getTime()).toBe(
      NOW.getTime() + PROVIDER_RATE_LIMIT_DEFAULT_BACKOFF_MS,
    );
  });

  test("auth failures map to auth_expired and missing vaults to error", async () => {
    const { store, statuses } = memoryStore();
    const expired = await syncProviderVault({
      provider: createFakeVaultProvider({ failWith: "provider_auth_invalid" }),
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(expired).toMatchObject({ status: "failed", syncStatus: "auth_expired" });
    const missing = await syncProviderVault({
      provider: createFakeVaultProvider({ vaults: [{ externalVaultId: "other", name: "Other" }] }),
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(missing).toMatchObject({
      status: "failed",
      syncStatus: "error",
      code: "provider_not_found",
    });
    expect(statuses.every((status) => status.lastSyncedAt === null)).toBe(true);
  });

  test("an active rate limit is respected even by a forced refresh", async () => {
    const fake = createFakeVaultProvider({ vaults: [{ externalVaultId: "rw", name: "RW" }] });
    const { store, statuses } = memoryStore();
    const until = new Date(NOW.getTime() + 60_000);
    const result = await syncProviderVault({
      provider: fake,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: until },
      store,
      now: () => NOW,
      force: true,
    });
    expect(result).toEqual({ status: "skipped_rate_limited", rateLimitedUntil: until });
    expect(fake.calls).toHaveLength(0);
    expect(statuses).toHaveLength(0);
  });

  test("every successful check records operations and the provider's freshness, even unchanged", async () => {
    const fake = createFakeVaultProvider({
      vaults: [{ externalVaultId: "rw", name: "RW", items: [] }],
      capabilities: { files: false },
    });
    const { store, plans, statuses } = memoryStore();
    const unchanged = await syncProviderVault({
      provider: fake,
      ctx: ctx(),
      target: { externalVaultId: "rw", mirroredContentVersion: "1", rateLimitedUntil: null },
      store,
      now: () => NOW,
    });
    expect(unchanged).toEqual({ status: "unchanged", contentVersion: "1" });
    expect(plans).toHaveLength(0);
    expect(statuses.at(-1)).toMatchObject({
      syncStatus: "ok",
      lastSyncedAt: NOW,
      // A legacy provider reports no freshness: Opengeni's check time never stands in for it.
      freshness: null,
      operations: {
        createItemTypes: ["login", "api_key", "note"],
        updateItem: true,
        archiveItem: true,
        archiveKind: "archive",
        deleteItem: false,
        readFiles: false,
        createTotp: true,
      },
    });
  });

  test("paged providers are traversed completely with the cache epoch, forced refresh and freshness", async () => {
    const fake = createFakeVaultProvider({
      vaults: [
        {
          externalVaultId: "rw",
          name: "RW",
          items: Array.from({ length: 150 }, (_, index) => ({
            name: `Item ${index}`,
            fields: [{ name: "password", value: "p" }],
          })),
        },
      ],
    });
    const seen: VaultProviderContext[] = [];
    const observed: VaultProviderFreshness[] = [];
    const pageOf = <T>(
      all: T[],
      cursor: string | undefined,
      limit: number,
      freshness: VaultProviderFreshness,
    ): ProviderPage<T> => {
      const start = cursor ? Number(cursor) : 0;
      const next = start + limit < all.length ? String(start + limit) : null;
      return {
        items: all.slice(start, start + limit),
        nextCursor: next,
        snapshot: "s1",
        freshness,
      };
    };
    const reported = (sourceSyncedAt: string): VaultProviderFreshness => ({
      state: "current",
      lastCheckedAt: NOW.toISOString(),
      sourceSyncedAt,
      source: "cache",
      errorCode: null,
      retryAt: null,
    });
    const paged: VaultProvider = {
      ...fake,
      async listVaultPage(pageCtx, page) {
        seen.push(pageCtx);
        return pageOf<ProviderVault>(
          await fake.listVaults(pageCtx),
          page.cursor,
          page.limit,
          reported("2026-10-12T11:58:00.000Z"),
        );
      },
      async listItemPage(pageCtx, externalVaultId, page) {
        seen.push(pageCtx);
        return pageOf(
          await fake.listItems(pageCtx, externalVaultId),
          page.cursor,
          page.limit,
          reported(page.cursor ? "2026-10-12T11:50:00.000Z" : "2026-10-12T11:55:00.000Z"),
        );
      },
    };
    const { store, plans, statuses } = memoryStore();
    const result = await syncProviderVault({
      provider: paged,
      ctx: { ...ctx(), onFreshness: (freshness) => observed.push(freshness) },
      target: {
        externalVaultId: "rw",
        mirroredContentVersion: "1",
        rateLimitedUntil: null,
        cacheEpoch: "41",
      },
      store,
      now: () => NOW,
      force: true,
    });
    expect(result).toMatchObject({ status: "synced", itemCount: 150 });
    expect(plans[0]!.items).toHaveLength(150);
    // One vault page and two item pages, each with the epoch and the forced refresh.
    expect(seen).toHaveLength(3);
    expect(seen.every((call) => call.cacheEpoch === "41" && call.forceRefresh === true)).toBe(true);
    expect(observed).toHaveLength(3);
    // The oldest upstream synchronization any page reported, never the check time.
    expect(statuses.at(-1)!.freshness).toEqual({
      source: "cache",
      sourceSyncedAt: "2026-10-12T11:50:00.000Z",
    });
  });

  test("an incomplete or invalid inventory keeps the previous mirror and records a safe failure", async () => {
    const fake = createFakeVaultProvider({
      vaults: [{ externalVaultId: "rw", name: "RW", items: [{ name: "A", fields: [] }] }],
    });
    const looping: VaultProvider = {
      ...fake,
      // The same cursor twice: the traversal can never be proven complete.
      listItemPage: async () => ({ items: [], nextCursor: "again", snapshot: null }),
    };
    const broken: VaultProvider = {
      ...fake,
      async listItems() {
        throw new TypeError("secret-bearing adapter detail");
      },
    };
    for (const provider of [looping, broken]) {
      const { store, plans, statuses } = memoryStore();
      const result = await syncProviderVault({
        provider,
        ctx: ctx(),
        target: { externalVaultId: "rw", mirroredContentVersion: null, rateLimitedUntil: null },
        store,
        now: () => NOW,
      });
      expect(result).toMatchObject({ status: "failed", syncStatus: "error" });
      expect(plans).toHaveLength(0);
      expect(statuses.at(-1)!.lastSyncedAt).toBeNull();
      expect(statuses.at(-1)!.syncErrorMessage).not.toContain("secret-bearing");
    }
  });
});

describe("provider freshness", () => {
  const observation = (
    source: "live" | "cache" | "unknown",
    sourceSyncedAt: string | null,
  ): VaultProviderFreshness => ({
    state: "current",
    lastCheckedAt: null,
    sourceSyncedAt,
    source,
    errorCode: null,
    retryAt: null,
  });

  test("aggregates one observation for a whole check", () => {
    expect(aggregateProviderFreshness([], NOW)).toBeNull();
    expect(
      aggregateProviderFreshness(
        [observation("live", null), observation("live", "2026-10-12T11:59:00.000Z")],
        NOW,
      ),
    ).toEqual({ source: "live", sourceSyncedAt: "2026-10-12T11:59:00.000Z" });
    expect(
      aggregateProviderFreshness(
        [observation("live", null), observation("cache", "2026-10-11T09:00:00.000Z")],
        NOW,
      ),
    ).toEqual({ source: "cache", sourceSyncedAt: "2026-10-11T09:00:00.000Z" });
    // A cached page that does not say how old it is makes the whole check's age unknown.
    expect(
      aggregateProviderFreshness(
        [observation("cache", "2026-10-11T09:00:00.000Z"), observation("cache", null)],
        NOW,
      ),
    ).toEqual({ source: "cache", sourceSyncedAt: null });
    // Never later than the check itself.
    expect(
      aggregateProviderFreshness([observation("unknown", "2030-01-01T00:00:00.000Z")], NOW),
    ).toEqual({ source: "unknown", sourceSyncedAt: NOW.toISOString() });
  });

  test("projects state, check time, provider observation, errors and retry time", () => {
    const vault = {
      id: "v",
      source: "keeper",
      syncStatus: "ok" as const,
      lastSyncedAt: "2026-10-12T11:58:00.000+00:00",
      rateLimitedUntil: null,
      updatedAt: "2026-10-12T11:58:00.000Z",
      syncErrorCode: null,
      providerFreshness: { source: "cache" as const, sourceSyncedAt: "2026-10-12T10:00:00Z" },
    };
    expect(providerVaultFreshness({ ...vault, source: "opengeni" }, NOW)).toBeUndefined();
    expect(providerVaultFreshness(vault, NOW)).toEqual({
      state: "current",
      lastCheckedAt: "2026-10-12T11:58:00.000Z",
      sourceSyncedAt: "2026-10-12T10:00:00.000Z",
      source: "cache",
      errorCode: null,
      retryAt: null,
    });
    expect(providerVaultFreshness(vault, NOW, { maxAgeMs: 60_000 })!.state).toBe("stale");
    expect(providerVaultFreshness(vault, NOW, { refreshing: true })!.state).toBe("refreshing");
    expect(
      providerVaultFreshness({ ...vault, lastSyncedAt: null, providerFreshness: null }, NOW),
    ).toMatchObject({ state: "stale", lastCheckedAt: null, source: "unknown" });
    expect(
      providerVaultFreshness(
        { ...vault, syncStatus: "auth_expired", syncErrorCode: "provider_auth_expired" },
        NOW,
      ),
    ).toMatchObject({
      state: "unavailable",
      errorCode: "provider_auth_expired",
      // The last successful check stays visible.
      lastCheckedAt: "2026-10-12T11:58:00.000Z",
    });
    const limited = {
      ...vault,
      syncStatus: "rate_limited" as const,
      syncErrorCode: "provider_rate_limited",
      rateLimitedUntil: "2026-10-12T12:05:00.000Z",
    };
    expect(providerVaultFreshness(limited, NOW)).toMatchObject({
      state: "unavailable",
      errorCode: "provider_rate_limited",
      retryAt: "2026-10-12T12:05:00.000Z",
    });
    expect(providerVaultFreshness(limited, new Date("2026-10-12T12:06:00.000Z"))).toMatchObject({
      state: "stale",
      retryAt: null,
    });
  });

  test("refreshes are de-duplicated only within one tenant, workspace and principal", () => {
    const human = (subjectId: string, viaApiKey = false) =>
      vaultRefreshScopeKey({
        kind: "principal",
        principal: {
          kind: "human",
          accountId: "a",
          workspaceId: "w",
          subjectId,
          verifiedHuman: !viaApiKey,
          viaApiKey,
        },
      });
    const attempt = (attemptId: string, workspaceId = "w") =>
      vaultRefreshScopeKey({
        kind: "principal",
        principal: {
          kind: "attempt",
          accountId: "a",
          workspaceId,
          sessionId: "s",
          turnId: "t",
          attemptId,
          executionGeneration: 1,
        },
      });
    const keys = [
      human("user:1"),
      human("user:2"),
      human("user:1", true),
      attempt("x"),
      attempt("y"),
      attempt("x", "w2"),
      vaultRefreshScopeKey({
        kind: "subject",
        accountId: "a",
        workspaceId: "w",
        subjectId: "user:1",
      }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(human("user:1")).toBe(human("user:1"));
  });
});
