import { describe, expect, test } from "bun:test";
import { createRealtimeProviderConfigCache } from "../src/realtime-provider-config-cache";

const config = { architecture: "voice", model: "live", version: "v3", source: "remote" } as const;

describe("realtime provider configuration cache", () => {
  test("reuses successful config only within its account/version scope and TTL", async () => {
    let now = 0;
    let reads = 0;
    const cache = createRealtimeProviderConfigCache({ now: () => now, ttlMs: 100 });
    const load = async () => {
      reads++;
      return config;
    };
    await cache.get("account-a/version-a", load);
    await cache.get("account-a/version-a", load);
    expect(reads).toBe(1);
    await cache.get("account-b/version-a", load);
    await cache.get("account-a/version-b", load);
    expect(reads).toBe(3);
    now = 100;
    await cache.get("account-a/version-a", load);
    expect(reads).toBe(4);
    cache.invalidate("account-a/version-a");
    await cache.get("account-a/version-a", load);
    expect(reads).toBe(5);
  });

  test("does not retain unavailable config or an authentication failure", async () => {
    const cache = createRealtimeProviderConfigCache();
    await cache.get("a", async () => ({ ...config, source: "fallback" }));
    await expect(
      cache.get("a", async () => {
        throw Error("unauthorized");
      }),
    ).rejects.toThrow("unauthorized");
    expect(await cache.get("a", async () => config)).toEqual(config);
  });

  test("keeps a positively observed protocol fallback and bounds memory", async () => {
    const cache = createRealtimeProviderConfigCache({ maxEntries: 1 });
    const fallback = { ...config, source: "fallback" as const, advertisedVersion: "v4" };
    await cache.get("a", async () => fallback);
    expect(
      await cache.get("a", async () => {
        throw Error("cache miss");
      }),
    ).toEqual(fallback);
    await cache.get("b", async () => config);
    await expect(
      cache.get("a", async () => {
        throw Error("evicted");
      }),
    ).rejects.toThrow("evicted");
  });

  test("an in-flight caller never shares another caller's lease or cancellation", async () => {
    const cache = createRealtimeProviderConfigCache();
    let rejectFirst!: (error: Error) => void;
    const first = cache.get(
      "a",
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
    );
    expect(await cache.get("a", async () => config)).toEqual(config);
    rejectFirst(Error("cancelled"));
    await expect(first).rejects.toThrow("cancelled");
    expect(
      await cache.get("a", async () => {
        throw Error("cache miss");
      }),
    ).toEqual(config);
  });
});
