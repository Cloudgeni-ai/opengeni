// Claude limit reset grants on the shared subscription core: the claim
// request against a scripted provider, the at-limit program read, reduced
// service (grace zone, slow tier) in the quota model, and the provider
// details' round trip from an observation to the usage projection. No
// network: the global fetch is denied; every request goes through the
// connection read's scripted custody fetch. No real grant is ever claimed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseClaudeUsageHeaders, parseClaudeUsageResponse } from "@opengeni/config";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import {
  quotaCapacity,
  storedQuotaDocument,
  type SubscriptionCoreConnectionRead,
} from "@opengeni/subscriptions";
import {
  decodeSubscriptionCoreClaudeQuota,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import { requestSubscriptionCoreClaudeLimitResetClaim } from "../src/subscription-core-claude-limit-resets";
import {
  fetchSubscriptionCoreClaudeUsage,
  projectSubscriptionCoreClaudeUsage,
  SUBSCRIPTION_CORE_CLAUDE_USAGE_URL,
  subscriptionCoreClaudeUsageEndsClaimedBlock,
} from "../src/subscription-core-claude-usage";
import { decodeSubscriptionQuota } from "../src/subscription-core-repository";

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

const identity = { accountUuid: "8b0f8a46-6a55-4c49-8c3e-3d3c6bdb2f31", deviceId: "a".repeat(64) };
const oauth: SubscriptionCoreClaudeCredential = {
  version: 1,
  token: "sk-ant-oat01-resets",
  identity,
  oauth: {
    refreshToken: "refresh-resets",
    expiresAt: "2026-12-12T10:00:00.000Z",
    scopes: ["user:inference", "user:profile"],
  },
};
const setupToken: SubscriptionCoreClaudeCredential = {
  version: 1,
  token: "sk-ant-oat01-setup",
  identity,
};
const ORGANIZATION = "00000000-0000-4000-8000-0000000000bb";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAIM_URL = `https://api.anthropic.com/api/organizations/${ORGANIZATION}/reset_rate_limits`;

type Call = { url: string; init: RequestInit | undefined };

function connectionRead(
  credential: SubscriptionCoreClaudeCredential,
  respond: (call: Call) => Response | Promise<Response>,
): { read: SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>; calls: Call[] } {
  const calls: Call[] = [];
  const bearer = { credential, providerAccountId: identity.accountUuid, providerState: {} };
  return {
    calls,
    read: {
      getToken: async () => bearer,
      refresh: async () => {
        throw new Error("a claim never forces a refresh");
      },
      fetch: async (input, init) => {
        const call = { url: String(input), init };
        calls.push(call);
        return await respond(call);
      },
    },
  };
}

/** The profile answers the organization; the claim endpoint answers `claim`. */
function provider(claim: (call: Call) => Response | Promise<Response>) {
  return (call: Call) => {
    if (call.url === PROFILE_URL) return Response.json({ organization: { uuid: ORGANIZATION } });
    if (call.url === CLAIM_URL) return claim(call);
    throw new Error(`unexpected request ${call.url}`);
  };
}

const input = { grantId: "full-reset-2611", requestId: "f7d5c0f2-0b7e-4d2b-9d55-6a1c2c1e0b11" };

describe("the claim request", () => {
  test("a reset: the organization from the profile, one POST as the CLI surface", async () => {
    const { read, calls } = connectionRead(
      oauth,
      provider(() =>
        Response.json({
          result: "reset",
          resets_left: 0,
          cleared: ["seven_day", "seven_day_overage_included"],
          weekly_resets_at: "2026-11-18T01:00:00+00:00",
        }),
      ),
    );
    const claim = await requestSubscriptionCoreClaudeLimitResetClaim(read, input);
    expect(claim).toEqual({
      result: "reset",
      reason: null,
      resetsLeft: 0,
      cleared: ["seven_day", "seven_day_overage_included"],
      weeklyResetsAt: "2026-11-18T01:00:00.000Z",
      cooldownUntil: null,
      retryable: false,
    });
    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      [PROFILE_URL, "GET"],
      [CLAIM_URL, "POST"],
    ]);
    const post = calls[1]!.init!;
    expect(JSON.parse(String(post.body))).toEqual({
      program: "cedar_ember",
      grant_id: input.grantId,
      request_id: input.requestId,
    });
    const headers = new Headers(post.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${oauth.token}`);
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.322 (external, cli)");
    expect(post.redirect).toBe("error");
    expect(post.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ["already_used", { result: "already_used", resets_left: 0 }, false],
    ["not_limited", { result: "not_limited", reason: "not_at_limit" }, false],
    ["cooldown", { result: "cooldown", cooldown_until: "2026-11-11T12:00:00Z" }, false],
    ["ineligible", { result: "ineligible", reason: "surface" }, false],
    // Unsettled: the same request id settles it.
    ["unavailable", { result: "unavailable" }, true],
  ] as const)("the provider's %s is reported as it answered", async (result, body, retryable) => {
    const { read } = connectionRead(
      oauth,
      provider(() => Response.json(body)),
    );
    const claim = await requestSubscriptionCoreClaudeLimitResetClaim(read, input);
    expect(claim.result).toBe(result);
    expect(claim.retryable).toBe(retryable);
  });

  test("an unknown result is unavailable and retryable", async () => {
    const { read } = connectionRead(
      oauth,
      provider(() => Response.json({ result: "queued" })),
    );
    expect(await requestSubscriptionCoreClaudeLimitResetClaim(read, input)).toMatchObject({
      result: "unavailable",
      retryable: true,
    });
  });

  test.each([
    ["429", () => new Response("{}", { status: 429 }), "rate_limited"],
    ["401", () => new Response("{}", { status: 401 }), "auth_error"],
    ["500", () => new Response("down", { status: 500 }), "error"],
    ["a malformed body", () => new Response("{", { status: 200 }), "error"],
    [
      "a transport failure",
      () => {
        throw new TypeError("connection reset");
      },
      "error",
    ],
  ] as const)("%s is unsettled and retryable", async (_label, respond, result) => {
    const { read } = connectionRead(oauth, provider(respond));
    expect(await requestSubscriptionCoreClaudeLimitResetClaim(read, input)).toMatchObject({
      result,
      retryable: true,
    });
  });

  test("a profile without a readable organization sends no claim", async () => {
    for (const profile of [
      () => new Response("down", { status: 503 }),
      () => Response.json({ organization: { uuid: "not-a-uuid" } }),
      () => Response.json({}),
    ]) {
      const { read, calls } = connectionRead(oauth, (call) => {
        if (call.url === PROFILE_URL) return profile();
        throw new Error("must not be sent");
      });
      expect(await requestSubscriptionCoreClaudeLimitResetClaim(read, input)).toMatchObject({
        result: "auth_error",
        retryable: true,
      });
      expect(calls).toHaveLength(1);
    }
  });

  test("nothing is sent for a setup token or a malformed id", async () => {
    for (const [credential, ids] of [
      [setupToken, input],
      [oauth, { ...input, grantId: "../full" }],
      [oauth, { ...input, grantId: "" }],
      [oauth, { ...input, requestId: "a b" }],
      [oauth, { ...input, requestId: "x".repeat(65) }],
    ] as const) {
      const { read, calls } = connectionRead(credential, () => {
        throw new Error("must not be sent");
      });
      const claim = await requestSubscriptionCoreClaudeLimitResetClaim(read, ids);
      expect(claim.retryable).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("the usage read", () => {
  const atLimitBody = {
    five_hour: null,
    seven_day: { utilization: 100, resets_at: "2026-11-13T00:59:59+00:00" },
    cedar_ember: {
      eligible: true,
      ineligible_reason: null,
      at_limit: true,
      exhausted: ["seven_day"],
      grants: [
        {
          id: "full-reset-2611",
          label: "One full limit reset (November 2026)",
          resets_total: 1,
          resets_left: 1,
          starts_at: "2026-11-10T21:30:00+00:00",
          ends_at: "2026-12-10T22:00:00+00:00",
          clears: ["seven_day", "seven_day_overage_included"],
          paused: false,
          usable_now: true,
          use_requires_limit: false,
          blocking: [],
          type: "weekly",
          unavailable_reason: null,
          gives_back_weekly: false,
        },
      ],
    },
  };

  test("at the limit, a second read adds the at-limit program; it never fails the reading", async () => {
    const wall = { juniper_tide: { eligible: false, ineligible_reason: "not_at_wall" } };
    for (const [second, expected] of [
      [() => Response.json(wall), { eligible: false, ineligibleReason: "not_at_wall" }],
      [() => new Response("down", { status: 500 }), undefined],
    ] as const) {
      const { read, calls } = connectionRead(oauth, (call) =>
        call.url.includes("at_wall=1") ? second() : Response.json(atLimitBody),
      );
      const reading = await fetchSubscriptionCoreClaudeUsage(read);
      expect(calls.map((call) => call.url)).toEqual([
        `${SUBSCRIPTION_CORE_CLAUDE_USAGE_URL}?cedar_ember=1&skip_spend=1`,
        `${SUBSCRIPTION_CORE_CLAUDE_USAGE_URL}?at_wall=1&skip_spend=1`,
      ]);
      expect(new Headers(calls[1]!.init?.headers).get("user-agent")).toBe(
        "claude-cli/2.1.322 (external, cli)",
      );
      expect(reading.status).toBe("available");
      expect(reading.observation?.details?.limitResets?.grants[0]?.id).toBe("full-reset-2611");
      if (expected) expect(reading.observation?.details?.wallReset).toMatchObject(expected);
      else expect(reading.observation?.details?.wallReset).toBeUndefined();
    }
  });

  test("below the limit there is one read", async () => {
    const { read, calls } = connectionRead(oauth, () =>
      Response.json({
        ...atLimitBody,
        seven_day: { utilization: 40, resets_at: "2026-11-13T00:59:59+00:00" },
        cedar_ember: { ...atLimitBody.cedar_ember, at_limit: false, exhausted: [] },
      }),
    );
    await fetchSubscriptionCoreClaudeUsage(read);
    expect(calls).toHaveLength(1);
  });

  test("the grants travel from the observation through storage to the usage projection", () => {
    const observedAt = new Date("2026-11-11T08:00:00.000Z");
    const observation = parseClaudeUsageResponse(atLimitBody, observedAt)!;
    const quota = {
      ...decodeSubscriptionCoreClaudeQuota({
        observation,
        refreshGeneration: 2,
        upstreamModelIds: [],
      }),
      revision: 3,
    };
    const stored = JSON.parse(JSON.stringify(storedQuotaDocument(quota)));
    expect(
      decodeSubscriptionQuota({
        quota: stored,
        quota_revision: 3,
        quota_observed_refresh_generation: 2,
        quota_updated_at: observedAt,
      })?.providerDetails,
    ).toEqual(quota.providerDetails);
    const usage = ClaudeSubscriptionUsage.parse(
      projectSubscriptionCoreClaudeUsage({
        status: "active",
        provider_state: { oauthScopes: ["user:inference", "user:profile"] },
        quota: stored,
        quota_revision: 3,
        quota_observed_refresh_generation: 2,
        quota_updated_at: observedAt.toISOString(),
        version: 4,
      }),
    );
    expect(usage.limitResets).toMatchObject({
      eligible: true,
      atLimit: true,
      grants: [
        {
          id: "full-reset-2611",
          kind: "weekly",
          resetsLeft: 1,
          usableNow: true,
          clears: ["seven_day", "seven_day_overage_included"],
          endsAt: "2026-12-10T22:00:00.000Z",
        },
      ],
    });
  });
});

describe("reduced service in the quota model", () => {
  const now = new Date("2026-11-11T08:00:00.000Z");
  const weeklyReset = Math.floor(Date.parse("2026-11-13T01:00:00.000Z") / 1000);
  const decode = (headers: Record<string, string>) =>
    decodeSubscriptionCoreClaudeQuota({
      observation: parseClaudeUsageHeaders(new Headers(headers), now, "claude-opus-4-5")!,
      refreshGeneration: 1,
      upstreamModelIds: ["claude-opus-4-5"],
    });
  const pastWeekly = {
    "anthropic-ratelimit-unified-7d-utilization": "1.0",
    "anthropic-ratelimit-unified-7d-reset": String(weeklyReset),
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-reset": String(weeklyReset),
  };

  test("a response served in the grace zone blocks nothing and is constrained", () => {
    const quota = decode({
      ...pastWeekly,
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-grace-7d-utilization": "0.2",
    });
    expect(quota.exhaustedUntil).toBeNull();
    expect(quota.modelCooldowns).toEqual({});
    expect(quota.windows.find((window) => window.id === "seven_day")?.status).toBe("warning");
    expect(quota.constrainedUntil).toBe(weeklyReset * 1000);
    expect(quotaCapacity({ ...quota, revision: 0 }, now.getTime()).kind).not.toBe("exhausted");
  });

  test("a response served by the slow tier blocks nothing and is constrained", () => {
    const quota = decode({
      ...pastWeekly,
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-slow-status": "active",
    });
    expect(quota.exhaustedUntil).toBeNull();
    expect(quota.constrainedUntil).toBe(weeklyReset * 1000);
    expect(quota.providerDetails?.serviceState?.value).toMatchObject({
      slow: { status: "active" },
    });
  });

  test("busy slow-tier slots rest the connection briefly as a rate limit, never as the weekly limit", () => {
    const quota = decode({
      ...pastWeekly,
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-slow-status": "slot_busy",
      "anthropic-ratelimit-unified-slow-retry-after": "30",
    });
    expect(quota.exhaustedKind).toBe("rate_limit");
    expect(quota.exhaustedUntil).toBe(now.getTime() + 30_000);
    expect(quota.exhaustedClaim).toBeUndefined();
    expect(quota.modelCooldowns).toEqual({});
    expect(quota.constrainedUntil).toBe(weeklyReset * 1000);
  });

  test("a refusal in the grace zone is still a refusal", () => {
    const quota = decode({
      ...pastWeekly,
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-grace-7d-utilization": "1.0",
    });
    expect(quota.constrainedUntil).toBeUndefined();
    expect(quota.modelCooldowns["claude/claude-opus-4-5"]).toBe(weeklyReset * 1000);
  });

  test("without opting in to either, a weekly refusal is unchanged", () => {
    const quota = decode({ ...pastWeekly, "anthropic-ratelimit-unified-status": "rejected" });
    expect(quota.constrainedUntil).toBeUndefined();
    expect(quota.modelCooldowns["claude/claude-opus-4-5"]).toBe(weeklyReset * 1000);
  });
});

describe("the Fable weekly limit under both names", () => {
  test("a block a refusal claimed as seven_day_overage_included ends on a seven_day_fable reading below the limit", () => {
    const requestedAt = "2026-11-11T08:00:00.000Z";
    const reading = {
      status: "available" as const,
      checkedAt: requestedAt,
      observation: parseClaudeUsageResponse(
        {
          five_hour: { utilization: 5, resets_at: "2026-11-11T12:00:00+00:00" },
          seven_day: { utilization: 30, resets_at: "2026-11-13T01:00:00+00:00" },
          seven_day_fable: { utilization: 0, resets_at: "2026-11-13T01:00:00+00:00" },
        },
        new Date(requestedAt),
      ),
    };
    const ends = subscriptionCoreClaudeUsageEndsClaimedBlock(reading);
    const claim = (windowIds: string[]) => ({
      modelId: null,
      until: Date.parse("2026-11-13T01:00:00Z"),
      claim: {
        until: Date.parse("2026-11-13T01:00:00Z"),
        observedAt: Date.parse(requestedAt) - 1_000,
        windowIds,
      },
    });
    expect(ends(claim(["seven_day_overage_included"]))).toBe(true);
    expect(ends(claim(["seven_day_fable"]))).toBe(true);
  });
});
