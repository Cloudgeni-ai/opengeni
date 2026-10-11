// The Claude adapter on the shared subscription core (design 5.3, Claude
// track C1a): the codec for OAuth and setup-token credentials, capabilities
// by credential format, the OAuth refresh and relogin classification against
// a scripted token endpoint, and Claude usage in the shared quota model. No
// network: the global fetch is denied for the whole file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CLAUDE_OAUTH_TOKEN_URL,
  claudeSubscriptionCapacity,
  emptyClaudeUsage,
  mergeClaudeUsage,
  parseClaudeUsageHeaders,
  parseClaudeUsageResponse,
} from "@opengeni/config";
import {
  applyQuotaObservation,
  quotaCapacity,
  modelCooldownUntil,
  subscriptionCoreCredentialRefresher,
  subscriptionCoreModelPolicyProviderId,
} from "@opengeni/subscriptions";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import { ClaudeSubscriptionReconnectRequired } from "../src/claude-subscription-tokens";
import { LEGACY_CLAUDE_CACHE_TTL_MS } from "../src/legacy-subscription-world";
import {
  decodeSubscriptionCoreClaudeCredential,
  decodeSubscriptionCoreClaudeQuota,
  encodeSubscriptionCoreClaudeCredential,
  SUBSCRIPTION_CORE_CLAUDE,
  SUBSCRIPTION_CORE_CLAUDE_OAUTH_FORMAT,
  SUBSCRIPTION_CORE_CLAUDE_SETUP_TOKEN_FORMAT,
  subscriptionCoreClaudeModelPolicyProviderId,
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
  test("is registered on the core with its cutover (0720)", () => {
    expect(subscriptionCoreProviderIds()).toContain("claude");
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.provider).toBe("claude");
    expect(SUBSCRIPTION_CORE_CLAUDE.settings.primaryColumn).toBe("claude_primary_connection_id");
    expect(SUBSCRIPTION_CORE_CLAUDE.sessionCompactionLock).toBeNull();
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.cacheFacts).toEqual({
      kind: "exact_ttl",
      ttlMs: 5 * 60 * 1000,
    });
    expect(SUBSCRIPTION_CORE_CLAUDE.adapter.credentialKind).toBe("oauth");
  });

  test("declares today's Claude timings, labels and limits", () => {
    const { adapter, errors } = SUBSCRIPTION_CORE_CLAUDE;
    expect(adapter.displayName).toBe("Claude");
    // The legacy resolver refreshes once the token is within a minute of
    // expiry (`resolveClaudeSubscriptionCredential`).
    expect(adapter.refresh?.windowMs).toBe(60_000);
    expect(adapter.refresh?.fallbackMs).toBe(60 * 60_000);
    // The prompt-cache lifetime the legacy path sends (`cacheTtl: "5m"`).
    expect(adapter.cacheFacts).toEqual({ kind: "exact_ttl", ttlMs: LEGACY_CLAUDE_CACHE_TTL_MS });
    expect(adapter.health).toEqual({
      // Claude's 403 never rotates accounts; this only bounds a forbidden
      // outcome another path reports.
      forbiddenQuarantineMs: 60 * 60_000,
      entitlementCooldownMs: 24 * 60 * 60_000,
      // A 429 without a retry time, and a limit without a known reset, are
      // checked again after a minute (the legacy capacity recheck).
      rateLimitFallbackMs: 60_000,
      exhaustedFallbackMs: 60_000,
    });
    expect(adapter.modelPolicyProviderId).toBe("organization-claude-subscription");
    for (const error of [
      errors.leaseLost(),
      errors.accessLost(),
      errors.sourceDisconnected(),
      errors.requestOutcomeUnknown(),
    ])
      expect(error.message).toContain("Claude");
  });

  test("workspace model policy names each Claude model by its own scope's provider id", () => {
    const { adapter } = SUBSCRIPTION_CORE_CLAUDE;
    for (const prefix of ["organization-claude-subscription", "workspace-claude-subscription"]) {
      expect(subscriptionCoreClaudeModelPolicyProviderId(`${prefix}/claude-sonnet-5`)).toBe(prefix);
      expect(subscriptionCoreModelPolicyProviderId(adapter, `${prefix}/claude-sonnet-5`)).toBe(
        prefix,
      );
    }
    // Any other id keeps the provider's declared identity.
    for (const modelId of ["claude-sonnet-5", "anthropic/claude-sonnet-5", "/claude-sonnet-5"])
      expect(subscriptionCoreModelPolicyProviderId(adapter, modelId)).toBe(
        adapter.modelPolicyProviderId,
      );
    // A provider with a single identity declares no per-model mapping.
    expect(
      subscriptionCoreModelPolicyProviderId(
        { modelPolicyProviderId: "codex-subscription" },
        "codex/gpt-6",
      ),
    ).toBe("codex-subscription");
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
    // The granted scopes are recorded as the token endpoint reports them.
    expect(second.credential.oauth?.scopes).toEqual(["user:profile", "user:inference"]);
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

  // Today's capacity rule for one model at one instant, over the same
  // observation (`mergeClaudeUsage` into an empty reading, as the legacy
  // observer stores it).
  const legacyAvailable = (
    observation: NonNullable<ReturnType<typeof parseClaudeUsageHeaders>>,
    model: string,
    time: number,
  ) =>
    claudeSubscriptionCapacity(
      mergeClaudeUsage(emptyClaudeUsage(1), observation),
      model,
      new Date(time),
    ).available;
  const coreAvailable = (decoded: ReturnType<typeof decode>, model: string, time: number) =>
    quotaCapacity(quota(decoded), time).kind !== "exhausted" &&
    ["organization-claude-subscription", "workspace-claude-subscription"].every(
      (prefix) => modelCooldownUntil(quota(decoded), `${prefix}/${model}`, time) === null,
    );
  const offsets = [0, 300, 660, 1801, 3601, 7201, 90_000];
  /** Same answer as today's rule for each model and instant. */
  const expectParity = (
    observation: NonNullable<ReturnType<typeof parseClaudeUsageHeaders>>,
    compared: readonly string[] = models,
  ) => {
    const decoded = decode(observation);
    for (const model of compared)
      for (const offset of offsets) {
        const time = now.getTime() + offset * 1000;
        expect({ model, offset, available: coreAvailable(decoded, model, time) }).toEqual({
          model,
          offset,
          available: legacyAvailable(observation, model, time),
        });
      }
    return decoded;
  };

  test("decodes realistic responses as today's capacity rule judges them", () => {
    const rejected5h = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(at(1800)),
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
      "anthropic-ratelimit-unified-7d-utilization": "0.4",
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "anthropic-ratelimit-unified-7d-reset": String(at(86_400)),
    };
    // The 5-hour plan limit with no overage: every model waits for its reset.
    expectParity(parseClaudeUsageHeaders(new Headers(rejected5h), now, "claude-sonnet-5-5")!);
    // The overage was refused with a reset ten minutes out: checked again then.
    const refused = expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          ...rejected5h,
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-reset": String(at(600)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
      ["claude-sonnet-5-5"],
    );
    expect(coreAvailable(refused, "claude-sonnet-5-5", now.getTime() + 660_000)).toBe(true);
    // The Opus 7-day limit: Opus waits, the other families dispatch.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
          "anthropic-ratelimit-unified-reset": String(at(7200)),
          "anthropic-ratelimit-unified-7d-opus-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-opus-status": "rejected",
          "anthropic-ratelimit-unified-7d-opus-reset": String(at(7200)),
          "anthropic-ratelimit-unified-5h-utilization": "0.2",
          "anthropic-ratelimit-unified-5h-status": "allowed",
        }),
        now,
        "claude-opus-5-5",
      )!,
    );
    // Sonnet was allowed while the Opus window is full: only Opus waits.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "0.3",
          "anthropic-ratelimit-unified-7d-opus-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-opus-status": "rejected",
          "anthropic-ratelimit-unified-7d-opus-reset": String(at(7200)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
    );
    // A rejection without a model whose limit is the Sonnet window: only Sonnet waits.
    const sonnetOnly = expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day_sonnet",
          "anthropic-ratelimit-unified-reset": String(at(3600)),
        }),
        now,
      )!,
    );
    expect(sonnetOnly.exhaustedUntil).toBeNull();
  });

  test("paid overage the provider allows keeps a rejected plan usable", () => {
    const fiveHour = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(at(1800)),
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
      "anthropic-ratelimit-unified-overage-status": "allowed",
    };
    const allowed = expectParity(
      parseClaudeUsageHeaders(new Headers(fiveHour), now, "claude-sonnet-5-5")!,
      ["claude-sonnet-5-5"],
    );
    expect(allowed.modelCooldowns).toEqual({});
    expect(allowed.exhaustedUntil).toBeNull();
    expect(allowed.windows[0]).toMatchObject({ id: "five_hour", status: "warning" });
    // Overage is the account's own setting, so it covers every model of the
    // account (today's rule judges only the model the response was for).
    expect(coreAvailable(allowed, "claude-opus-5-5", now.getTime())).toBe(true);
    const opus = expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
          "anthropic-ratelimit-unified-reset": String(at(7200)),
          "anthropic-ratelimit-unified-7d-opus-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-opus-status": "rejected",
          "anthropic-ratelimit-unified-7d-opus-reset": String(at(7200)),
          "anthropic-ratelimit-unified-overage-status": "allowed",
        }),
        now,
        "claude-opus-5-5",
      )!,
      ["claude-opus-5-5"],
    );
    expect(opus.modelCooldowns).toEqual({});
    // The 7-day plan limit served from an allowed (warning) overage.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-reset": String(at(5 * 86_400)),
          "anthropic-ratelimit-unified-7d-utilization": "1.0",
          "anthropic-ratelimit-unified-overage-status": "allowed_warning",
          "anthropic-ratelimit-unified-overage-reset": String(at(20 * 86_400)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
      ["claude-sonnet-5-5"],
    );
    // An overage allowance whose reset has already passed covers nothing.
    const lapsed = expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          ...fiveHour,
          "anthropic-ratelimit-unified-overage-reset": String(at(-10)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
    );
    expect(lapsed.windows[0]).toMatchObject({ id: "five_hour", status: "exhausted" });
  });

  test("the model a response was allowed for dispatches; the others wait for the account limit", () => {
    // Allowed for Sonnet while the 5-hour window reads full without a status.
    const fullWindow = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": String(at(1800)),
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
    };
    const decoded = expectParity(
      parseClaudeUsageHeaders(new Headers(fullWindow), now, "claude-sonnet-5-5")!,
    );
    expect(decoded.exhaustedUntil).toBeNull();
    expect(decoded.windows[0]).toMatchObject({ id: "five_hour", status: "warning" });
    // An allowance that ends before the limit (here, unknown: a minute) does
    // not spare its model: it waits from now, where today's rule still
    // dispatches it for that minute (a recorded difference toward waiting).
    const { "anthropic-ratelimit-unified-reset": _reset, ...shortAllowance } = fullWindow;
    const short = parseClaudeUsageHeaders(new Headers(shortAllowance), now, "claude-sonnet-5-5")!;
    expect(legacyAvailable(short, "claude-sonnet-5-5", now.getTime())).toBe(true);
    expect(coreAvailable(decode(short), "claude-sonnet-5-5", now.getTime())).toBe(false);
    for (const offset of offsets.filter((value) => value >= 60))
      for (const model of models)
        expect(coreAvailable(decode(short), model, now.getTime() + offset * 1000)).toBe(
          legacyAvailable(short, model, now.getTime() + offset * 1000),
        );
    // A window that reports `allowed` at its limit is not a limit.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
        }),
        now,
      )!,
    );
  });

  test("a refused or full paid-overage window never blocks the plan", () => {
    const ordinary = {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "0.3",
      "anthropic-ratelimit-unified-7d-utilization": "0.2",
      "anthropic-ratelimit-unified-overage-status": "rejected",
    };
    const cases = [
      parseClaudeUsageHeaders(new Headers(ordinary), now, "claude-sonnet-5-5")!,
      parseClaudeUsageHeaders(
        new Headers({
          ...ordinary,
          "anthropic-ratelimit-unified-overage-reset": String(at(20 * 86_400)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
      parseClaudeUsageHeaders(
        new Headers({
          ...ordinary,
          "anthropic-ratelimit-unified-overage-reset": String(at(20 * 86_400)),
        }),
        now,
      )!,
      parseClaudeUsageResponse(
        {
          five_hour: { utilization: 10, resets_at: null },
          overage: { utilization: 120, resets_at: new Date(at(86_400) * 1000).toISOString() },
          seven_day_overage_included: {
            utilization: 100,
            resets_at: new Date(at(86_400) * 1000).toISOString(),
          },
        },
        now,
      )!,
    ];
    for (const observation of cases) {
      const decoded = expectParity(observation);
      expect(decoded.modelCooldowns).toEqual({});
      expect(decoded.exhaustedUntil).toBeNull();
    }
  });

  test("a refused overage's recheck frees only the models that response concerns", () => {
    const sevenDay = {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-reset": String(at(5 * 86_400)),
      "anthropic-ratelimit-unified-7d-utilization": "1.0",
      "anthropic-ratelimit-unified-7d-reset": String(at(5 * 86_400)),
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-reset": String(at(600)),
    };
    // For Sonnet: Sonnet is checked again at the overage reset; Opus and
    // Haiku wait for the seven-day reset.
    const decoded = expectParity(
      parseClaudeUsageHeaders(new Headers(sevenDay), now, "claude-sonnet-5-5")!,
    );
    expect(decoded.exhaustedUntil).toBeNull();
    expect(decoded.modelCooldowns["organization-claude-subscription/claude-sonnet-5-5"]).toBe(
      at(600) * 1000,
    );
    expect(decoded.modelCooldowns["organization-claude-subscription/claude-opus-5-5"]).toBe(
      at(5 * 86_400) * 1000,
    );
    // A request whose own plan limit has already reset decides nothing, so
    // its refused overage caps no other limit the response reports.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "seven_day",
          "anthropic-ratelimit-unified-reset": String(at(0)),
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-reset": String(at(0)),
          "anthropic-ratelimit-unified-7d-sonnet-status": "rejected",
          "anthropic-ratelimit-unified-7d-sonnet-reset": String(at(3600)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
    );
    // Without a model and with an account limit: every model, the connection.
    const modelless = expectParity(parseClaudeUsageHeaders(new Headers(sevenDay), now)!);
    expect(modelless.exhaustedUntil).toBe(at(600) * 1000);
    // An overage that resets after the request's own plan reset ends no
    // other limit: Sonnet's own family limit still runs to its reset.
    const lateOverage = expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-reset": String(at(1800)),
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": String(at(1800)),
          "anthropic-ratelimit-unified-7d-sonnet-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-sonnet-status": "rejected",
          "anthropic-ratelimit-unified-7d-sonnet-reset": String(at(7200)),
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-reset": String(at(3600)),
        }),
        now,
        "claude-sonnet-5-5",
      )!,
    );
    expect(lateOverage.modelCooldowns["organization-claude-subscription/claude-sonnet-5-5"]).toBe(
      at(7200) * 1000,
    );
    // Without a model and with the Sonnet limit: Sonnet is rechecked, the
    // others still wait for the account window.
    expectParity(
      parseClaudeUsageHeaders(
        new Headers({
          ...sevenDay,
          "anthropic-ratelimit-unified-representative-claim": "seven_day_sonnet",
          "anthropic-ratelimit-unified-7d-sonnet-utilization": "1.0",
          "anthropic-ratelimit-unified-7d-sonnet-reset": String(at(5 * 86_400)),
        }),
        now,
      )!,
    );
  });

  test("a family limit reaches the response's own model even when the list misses it", () => {
    const observation = parseClaudeUsageHeaders(
      new Headers({
        "anthropic-ratelimit-unified-7d-opus-utilization": "1.0",
        "anthropic-ratelimit-unified-7d-opus-reset": String(at(7200)),
      }),
      now,
      "claude-opus-4-1",
    )!;
    expectParity(observation, ["claude-opus-4-1", ...models]);
  });

  test("request restrictions limit their model unless a later allowance lifts it", () => {
    const restriction = (
      upstreamModelId: string | null,
      status: "rejected" | "allowed",
      offset: number,
      claim: "five_hour" | "seven_day_opus" | null = null,
      resetSeconds = 3600,
    ) => ({
      status,
      resetsAt: status === "rejected" ? new Date(at(resetSeconds) * 1000).toISOString() : null,
      representativeClaim: claim,
      overageStatus: null,
      overageResetsAt: null,
      upstreamModelId,
      observedAt: new Date(now.getTime() + offset).toISOString(),
    });
    const observation = {
      windows: [],
      observedAt: new Date(now.getTime() + 10).toISOString(),
      source: "response_headers" as const,
      requestRestrictions: [
        restriction("claude-opus-5-5", "rejected", 0),
        restriction("claude-haiku-5-5", "rejected", 0),
        restriction("claude-haiku-5-5", "allowed", 5),
      ],
    };
    const decoded = decode(observation);
    expect(Object.keys(decoded.modelCooldowns).sort()).toEqual([
      "organization-claude-subscription/claude-opus-5-5",
      "workspace-claude-subscription/claude-opus-5-5",
    ]);
    expect(decoded.exhaustedUntil).toBeNull();
    // An account-wide restriction without a model limits the connection.
    const account = decode({
      ...observation,
      requestRestrictions: [restriction(null, "rejected", 0, "five_hour")],
    });
    expect(account.exhaustedUntil).toBe(at(3600) * 1000);
    // Several account-wide restrictions: the longest wins, in any order.
    for (const order of [
      [7200, 3600],
      [3600, 7200],
    ]) {
      const longest = decode({
        ...observation,
        requestRestrictions: order.map((reset) =>
          restriction(null, "rejected", 0, "five_hour", reset),
        ),
      });
      expect(longest.exhaustedUntil).toBe(at(7200) * 1000);
    }
    // An allowance observed in the same millisecond does not lift a
    // restriction (timestamps do not order concurrent responses).
    const tied = decode({
      ...observation,
      requestRestrictions: [
        restriction("claude-haiku-5-5", "rejected", 0),
        restriction("claude-haiku-5-5", "allowed", 0),
      ],
    });
    expect(Object.keys(tied.modelCooldowns)).toContain(
      "organization-claude-subscription/claude-haiku-5-5",
    );
    // A response's allowed overage covers the restrictions it postdates,
    // not a restriction observed after it.
    const overage = {
      status: "rejected" as const,
      resetsAt: new Date(at(1800) * 1000).toISOString(),
      representativeClaim: "five_hour" as const,
      overageStatus: "allowed" as const,
      overageResetsAt: null,
      upstreamModelId: "claude-sonnet-5-5",
      observedAt: new Date(now.getTime() + 5).toISOString(),
    };
    const covered = decode({
      ...observation,
      requestStatus: overage,
      requestRestrictions: [
        restriction("claude-opus-5-5", "rejected", 0),
        restriction("claude-haiku-5-5", "rejected", 8),
      ],
    });
    expect(Object.keys(covered.modelCooldowns).sort()).toEqual([
      "organization-claude-subscription/claude-haiku-5-5",
      "workspace-claude-subscription/claude-haiku-5-5",
    ]);
  });

  test("a limit whose reset has passed leaves no cooldown", () => {
    const decoded = decode(
      parseClaudeUsageResponse(
        {
          seven_day_opus: {
            utilization: 100,
            resets_at: new Date(now.getTime() - 1000).toISOString(),
          },
        },
        now,
      )!,
    );
    expect(decoded.modelCooldowns).toEqual({});
    // Just under the full threshold is not a limit.
    const nearly = decode(
      parseClaudeUsageHeaders(
        new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.999" }),
        now,
      )!,
    );
    expect(nearly.windows[0]).toMatchObject({ id: "five_hour", status: "ok" });
  });

  // The shared `applyQuotaObservation` keeps a stored exhausted window that a
  // newer reading omits until its reset, as today's merged reading does
  // (design 5.3, Claude track); C3 registers Claude only with this passing.
  test("a reading that omits an exhausted window keeps its block", () => {
    const first = decode(
      parseClaudeUsageResponse(
        {
          five_hour: { utilization: 20, resets_at: null },
          seven_day: {
            utilization: 100,
            resets_at: new Date(at(3 * 86_400) * 1000).toISOString(),
          },
        },
        now,
      )!,
    );
    const later = new Date(now.getTime() + 600_000);
    const second = decode(
      parseClaudeUsageHeaders(
        new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.25" }),
        later,
        "claude-sonnet-5-5",
      )!,
    );
    const stored = applyQuotaObservation(
      { refreshGeneration: 4, quota: quota(first) },
      quota(second),
    );
    expect(quotaCapacity(stored, later.getTime() + 1_000)).toEqual({
      kind: "exhausted",
      resetsAt: at(3 * 86_400) * 1000,
    });
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
