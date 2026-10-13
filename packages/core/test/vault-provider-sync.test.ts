import { describe, expect, test } from "bun:test";
import { createProviderCallBudget, VaultProviderError, type VaultProvider } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import {
  PROVIDER_RATE_LIMIT_DEFAULT_BACKOFF_MS,
  planProviderMirror,
  providerPrimaryFieldId,
  providerSecretName,
  syncProviderVault,
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
});
