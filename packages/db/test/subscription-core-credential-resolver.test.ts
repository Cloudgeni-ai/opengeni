import { describe, expect, test } from "bun:test";
import {
  buildSubscriptionCoreCredentialResolver,
  type SubscriptionCoreLoadedCredentialBase,
  type SubscriptionCoreRefreshPolicy,
  subscriptionCoreRefreshPolicy,
} from "../src/subscription-core/credential-resolver";

type Loaded = SubscriptionCoreLoadedCredentialBase & { token: string };

class Relogin extends Error {}

function resolverFor(policy: SubscriptionCoreRefreshPolicy, loaded: Loaded) {
  const refreshed: string[] = [];
  const resolver = buildSubscriptionCoreCredentialResolver({
    flightNamespace: `resolver-test-${crypto.randomUUID()}`,
    connectionId: crypto.randomUUID(),
    holderKey: "holder",
    policy: () => policy,
    load: async () => ({ kind: "loaded", credential: loaded }),
    embeddedExpiry: () => null,
    refresh: async (current) => {
      refreshed.push(current.token);
      return policy === null
        ? { kind: "relogin", message: "sign in again", marked: true }
        : { kind: "refreshed", refreshGeneration: current.refreshGeneration + 1 };
    },
    snapshot: (current) => current.token,
    refreshedSnapshot: () => "rotated",
    errors: {
      relogin: (message) => new Relogin(message ?? "relogin"),
      leaseLost: () => new Error("lease lost"),
      accessLost: () => new Error("access lost"),
    },
  });
  return { resolver, refreshed };
}

function credential(expiresAt: Date | null, lastRefreshAt: Date | null = null): Loaded {
  return { token: "current", refreshGeneration: 1, planType: null, expiresAt, lastRefreshAt };
}

describe("shared credential resolver refresh policy", () => {
  test("the policy follows the adapter: none for a credential that never renews", () => {
    const capabilities = (autoRenews: boolean) => ({
      autoRenews,
      resetCredits: false,
      extraCredits: false,
      modelEntitlements: false,
      realtime: false,
      fundsMedia: false,
      apps: false,
      remoteCompaction: false,
      quotaWindows: true,
    });
    const refresher = {
      windowMs: 5,
      fallbackMs: 7,
      rotate: async () => ({}) as never,
      reloginMessage: () => null,
    };
    // Renewal is decided per credential format (OAuth renews, a setup token
    // does not), through the codec's format of the decoded credential.
    const adapter = (refresh: typeof refresher | null) => ({
      capabilitiesFor: (format: string) => capabilities(format === "oauth_v1"),
      credential: {
        decode: (plaintext: string) => plaintext,
        encode: (value: string) => value,
        expiry: () => null,
        format: (value: string) => value,
      },
      refresh,
    });
    expect(subscriptionCoreRefreshPolicy(adapter(null), "oauth_v1")).toBeNull();
    expect(subscriptionCoreRefreshPolicy(adapter(refresher), "oauth_v1")).toEqual({
      windowMs: 5,
      fallbackMs: 7,
    });
    expect(subscriptionCoreRefreshPolicy(adapter(refresher), "setup_token_v1")).toBeNull();
  });

  test("a renewing credential refreshes inside its window or when its age is unknown", async () => {
    const policy = { windowMs: 60_000, fallbackMs: 3_600_000 };
    for (const [loaded, expected] of [
      [credential(new Date(Date.now() + 30_000)), "rotated"],
      [credential(new Date(Date.now() + 600_000)), "current"],
      [credential(null), "rotated"],
      [credential(null, new Date()), "current"],
    ] as const) {
      const { resolver } = resolverFor(policy, loaded);
      expect(await resolver.getToken()).toBe(expected);
    }
  });

  test("a credential that never renews is used until its known expiry, then needs sign-in", async () => {
    for (const loaded of [credential(null), credential(new Date(Date.now() + 30_000))]) {
      const { resolver, refreshed } = resolverFor(null, loaded);
      expect(await resolver.getToken()).toBe("current");
      expect(refreshed).toEqual([]);
    }
    const expired = resolverFor(null, credential(new Date(Date.now() - 1_000)));
    await expect(expired.resolver.getToken()).rejects.toBeInstanceOf(Relogin);
    expect(expired.refreshed).toEqual(["current"]);
    // A forced refresh after the provider refused the credential also ends in sign-in.
    const forced = resolverFor(null, credential(null));
    await expect(forced.resolver.refresh()).rejects.toThrow("sign in again");
  });
});
