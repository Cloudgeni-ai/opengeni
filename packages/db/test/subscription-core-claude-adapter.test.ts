// The Claude adapter on the shared subscription core (design 5.3, Claude
// track C1a): the codec for OAuth and setup-token credentials, capabilities
// by credential format, the OAuth refresh and relogin classification against
// a scripted token endpoint, and Claude usage in the shared quota model. No
// network: the global fetch is denied for the whole file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CLAUDE_OAUTH_TOKEN_URL,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
} from "@opengeni/config";
import {
  quotaCapacity,
  modelCooldownUntil,
  subscriptionCoreCredentialRefresher,
} from "@opengeni/subscriptions";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import { ClaudeSubscriptionReconnectRequired } from "../src/claude-subscription-tokens";
import {
  decodeSubscriptionCoreClaudeCredential,
  decodeSubscriptionCoreClaudeQuota,
  encodeSubscriptionCoreClaudeCredential,
  SUBSCRIPTION_CORE_CLAUDE,
  SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT,
  SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT,
  subscriptionCoreClaudeProvider,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";

const realFetch = globalThis.fetch;
const denied: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    denied.push(String(input instanceof Request ? input.url : input));
    throw new Error("network access is denied in this suite");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(denied).toEqual([]);
});

const identity = {
  accountUuid: "8b0f8a46-6a55-4c49-8c3e-3d3c6bdb2f31",
  deviceId: "a".repeat(64),
};
const oauthCredential: SubscriptionCoreClaudeCredential = {
  version: 1,
  token: "sk-ant-oat01-access-one",
  identity,
  oauth: {
    refreshToken: "refresh-one",
    expiresAt: "2026-10-11T10:00:00.000Z",
    scopes: ["user:inference", "user:profile"],
  },
};
const setupCredential: SubscriptionCoreClaudeCredential = {
  version: 1,
  token: "sk-ant-oat01-setup-token",
  identity: { accountUuid: "", deviceId: "b".repeat(64) },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A scripted OAuth token endpoint; each call consumes the next reply. */
function scriptedTokenEndpoint(replies: Array<() => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const next = replies.shift();
    if (!next) throw new Error("unexpected token call");
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("Claude adapter", () => {
  test("is not registered on the core before its cutover", () => {
    expect(subscriptionCoreProviderIds()).not.toContain("claude");
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.provider).toBe("claude");
    expect(SUBSCRIPTION_CORE_CLAUDE.settings.primaryColumn).toBe("claude_primary_connection_id");
    expect(SUBSCRIPTION_CORE_CLAUDE.sessionCompactionLock).toBeNull();
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.cacheFacts).toEqual({
      kind: "exact_ttl",
      ttlMs: 5 * 60 * 1000,
    });
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.credentialKind).toBe("oauth");
  });

  test("round-trips OAuth and setup-token credentials in the legacy secret format", () => {
    const { credential } = SUBSCRIPTION_CORE_CLAUDE.adapter;
    for (const value of [oauthCredential, setupCredential]) {
      const encoded = encodeSubscriptionCoreClaudeCredential(value);
      expect(decodeSubscriptionCoreClaudeCredential(encoded)).toEqual(value);
      // The stored plaintext is the legacy object byte for byte.
      expect(encoded).toBe(JSON.stringify(value));
    }
    expect(credential.format(oauthCredential)).toBe(SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT);
    expect(credential.format(setupCredential)).toBe(SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT);
    expect(credential.expiry(oauthCredential)?.toISOString()).toBe(
      oauthCredential.oauth!.expiresAt,
    );
    expect(credential.expiry(setupCredential)).toBeNull();
  });

  test("decoding fails with fixed texts that never echo the plaintext", () => {
    const secret = "sk-ant-oat01-leaked-secret";
    for (const plaintext of [
      `{not json ${secret}`,
      JSON.stringify({ version: 2, token: secret, identity }),
      JSON.stringify({ version: 1, token: secret, identity, extra: true }),
      JSON.stringify({ version: 1, token: "not-a-claude-token", identity }),
      JSON.stringify(null),
    ]) {
      let message = "";
      try {
        decodeSubscriptionCoreClaudeCredential(plaintext);
      } catch (error) {
        message = String((error as Error).message) + String((error as Error).cause ?? "");
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("leaked");
      expect(message).not.toContain("not-a-claude-token");
    }
    expect(() =>
      encodeSubscriptionCoreClaudeCredential({ ...setupCredential, token: "plain" }),
    ).toThrow("A core Claude credential cannot be encoded");
  });

  test("only an OAuth credential renews; a setup token or unknown format never refreshes", () => {
    const { adapter } = SUBSCRIPTION_CORE_CLAUDE;
    expect(adapter.capabilitiesFor(SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT).autoRenews).toBe(true);
    expect(adapter.capabilitiesFor(SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT).autoRenews).toBe(
      false,
    );
    expect(adapter.capabilitiesFor("claude_future_v9").autoRenews).toBe(false);
    expect(subscriptionCoreCredentialRefresher(adapter, oauthCredential)).toBe(adapter.refresh);
    expect(subscriptionCoreCredentialRefresher(adapter, setupCredential)).toBeNull();
    // Claude has no Opengeni-managed extra credits, entitlements, media or Apps.
    expect(adapter.capabilities).toMatchObject({
      extraCredits: false,
      modelEntitlements: false,
      realtime: false,
      fundsMedia: false,
      apps: false,
      resetCredits: false,
      quotaWindows: true,
    });
  });

  test("the OAuth refresh rotates the token pair and keeps the identity", async () => {
    const endpoint = scriptedTokenEndpoint([
      () =>
        json(200, {
          access_token: "sk-ant-oat01-access-two",
          refresh_token: "refresh-two",
          expires_in: 3600,
          scope: "user:inference user:profile",
        }),
      // A response without a refresh token keeps the current one.
      () =>
        json(200, {
          access_token: "sk-ant-oat01-access-three",
          expires_in: 7200,
          scope: "user:profile user:inference",
        }),
    ]);
    const now = Date.parse("2026-10-11T09:59:30.000Z");
    const { adapter } = subscriptionCoreClaudeProvider({ fetch: endpoint.fetch, now: () => now });
    const first = await adapter.refresh!.rotate(oauthCredential);
    expect(first.planType).toBeNull();
    expect(first.expiresAt?.toISOString()).toBe(new Date(now + 3_600_000).toISOString());
    expect(first.credential).toEqual({
      version: 1,
      token: "sk-ant-oat01-access-two",
      identity,
      oauth: {
        refreshToken: "refresh-two",
        expiresAt: new Date(now + 3_600_000).toISOString(),
        scopes: ["user:inference", "user:profile"],
      },
    });
    const second = await adapter.refresh!.rotate(first.credential);
    expect(second.credential.oauth?.refreshToken).toBe("refresh-two");
    expect(second.credential.token).toBe("sk-ant-oat01-access-three");
    expect(endpoint.calls.map((call) => call.url)).toEqual([
      CLAUDE_OAUTH_TOKEN_URL,
      CLAUDE_OAUTH_TOKEN_URL,
    ]);
    expect(endpoint.calls[0]!.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-one",
    });
    expect(endpoint.calls[1]!.body).toMatchObject({ refresh_token: "refresh-two" });
  });

  test("a revoked grant is a relogin; other refresh failures are not", async () => {
    const endpoint = scriptedTokenEndpoint([
      () => json(400, { error: "invalid_grant" }),
      () => json(401, { error: "unauthorized" }),
      () => json(503, { error: "unavailable" }),
      // Missing required scopes after a refresh needs a new sign-in.
      () =>
        json(200, {
          access_token: "sk-ant-oat01-access-two",
          expires_in: 3600,
          scope: "user:inference",
        }),
    ]);
    const { adapter } = subscriptionCoreClaudeProvider({ fetch: endpoint.fetch });
    const refresh = adapter.refresh!;
    const outcomes: Array<string | null> = [];
    for (let index = 0; index < 4; index++) {
      const error = await refresh.rotate(oauthCredential).then(
        () => null,
        (caught: unknown) => caught,
      );
      outcomes.push(refresh.reloginMessage(error));
    }
    const relogin = new ClaudeSubscriptionReconnectRequired().message;
    expect(outcomes).toEqual([relogin, relogin, null, relogin]);
    // A setup token cannot be refreshed: a relogin, without any network call.
    const before = endpoint.calls.length;
    const error = await refresh.rotate(setupCredential).catch((caught: unknown) => caught);
    expect(refresh.reloginMessage(error)).toBe(relogin);
    expect(endpoint.calls.length).toBe(before);
    expect(adapter.reloginText("")).toBe(relogin);
    expect(adapter.reloginText("Custom")).toBe("Custom");
  });
});

describe("Claude usage in the shared quota model", () => {
  const now = new Date("2026-10-11T09:00:00.000Z");
  const at = (offsetSeconds: number) => Math.floor(now.getTime() / 1000) + offsetSeconds;
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  const decode = (observation: NonNullable<ReturnType<typeof parseClaudeUsageHeaders>>) =>
    decodeSubscriptionCoreClaudeQuota({
      observation,
      refreshGeneration: 4,
      upstreamModelIds: models,
    });
  const quota = (decoded: ReturnType<typeof decode>) => ({ ...decoded, revision: 1 });

  test("an allowed response reports the account windows as known capacity", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(at(3600)),
      "anthropic-ratelimit-unified-7d-utilization": "0.9",
      "anthropic-ratelimit-unified-7d-status": "allowed_warning",
      "anthropic-ratelimit-unified-7d-reset": String(at(86_400)),
    });
    const decoded = decode(parseClaudeUsageHeaders(headers, now, "claude-opus-5-5")!);
    expect(decoded).toMatchObject({
      exhaustedUntil: null,
      exhaustedKind: null,
      modelCooldowns: {},
      observedAt: now.getTime(),
      observedRefreshGeneration: 4,
      source: "response_headers",
    });
    expect(decoded.windows).toEqual([
      { id: "five_hour", usedPercent: 42, resetsAt: at(3600) * 1000, status: "ok" },
      { id: "seven_day", usedPercent: 90, resetsAt: at(86_400) * 1000, status: "warning" },
    ]);
    expect(quotaCapacity(quota(decoded), now.getTime())).toEqual({ kind: "available" });
  });

  test("a rejected account window exhausts the connection until its reset", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(at(1800)),
      "anthropic-ratelimit-unified-5h-utilization": "1",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
    });
    const decoded = decode(parseClaudeUsageHeaders(headers, now, "claude-sonnet-5-5")!);
    expect(quotaCapacity(quota(decoded), now.getTime())).toEqual({
      kind: "exhausted",
      resetsAt: at(1800) * 1000,
    });
    // The rejected request also cools the model it was made for.
    expect(
      modelCooldownUntil(
        quota(decoded),
        "organization-claude-subscription/claude-sonnet-5-5",
        now.getTime(),
      ),
    ).toBe(at(1800) * 1000);
    expect(quotaCapacity(quota(decoded), at(1801) * 1000)).toEqual({ kind: "available" });
  });

  test("a family window limits only that family's models", () => {
    const decoded = decode(
      parseClaudeUsageResponse(
        {
          five_hour: { utilization: 10, resets_at: new Date(at(3600) * 1000).toISOString() },
          seven_day_opus: {
            utilization: 100,
            resets_at: new Date(at(7200) * 1000).toISOString(),
          },
          seven_day_sonnet: { utilization: 50, resets_at: null },
        },
        now,
      )!,
    );
    expect(decoded.source).toBe("usage_endpoint");
    expect(quotaCapacity(quota(decoded), now.getTime())).toEqual({ kind: "available" });
    expect(decoded.modelCooldowns).toEqual({
      "organization-claude-subscription/claude-opus-5-5": at(7200) * 1000,
      "workspace-claude-subscription/claude-opus-5-5": at(7200) * 1000,
    });
    expect(decoded.windows.map((window) => [window.id, window.status])).toEqual([
      ["five_hour", "ok"],
      ["seven_day_opus", "unknown"],
      ["seven_day_sonnet", "unknown"],
    ]);
  });

  test("paid overage the provider allows keeps a rejected plan usable", () => {
    const base = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(at(3600)),
    };
    const allowed = decode(
      parseClaudeUsageHeaders(
        new Headers({ ...base, "anthropic-ratelimit-unified-overage-status": "allowed" }),
        now,
        "claude-opus-5-5",
      )!,
    );
    expect(allowed.modelCooldowns).toEqual({});
    expect(allowed.exhaustedUntil).toBeNull();
    // A rejected overage with an earlier reset is checked again at that reset.
    const rejected = decode(
      parseClaudeUsageHeaders(
        new Headers({
          ...base,
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-reset": String(at(600)),
        }),
        now,
        "claude-opus-5-5",
      )!,
    );
    expect(rejected.modelCooldowns["workspace-claude-subscription/claude-opus-5-5"]).toBe(
      at(600) * 1000,
    );
  });

  test("a rejection for an unknown model limits the whole connection; unknown resets recheck in a minute", () => {
    const decoded = decode(
      parseClaudeUsageHeaders(
        new Headers({ "anthropic-ratelimit-unified-status": "rejected" }),
        now,
      )!,
    );
    expect(decoded.exhaustedUntil).toBe(now.getTime() + 60_000);
    expect(decoded.exhaustedKind).toBe("quota");
    expect(decoded.modelCooldowns).toEqual({});
    const full = decode(
      parseClaudeUsageHeaders(
        new Headers({ "anthropic-ratelimit-unified-7d-utilization": "1.0" }),
        now,
        "claude-haiku-5-5",
      )!,
    );
    expect(full.windows).toEqual([
      { id: "seven_day", usedPercent: 100, resetsAt: now.getTime() + 60_000, status: "exhausted" },
    ]);
  });
});
