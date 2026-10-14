// Claude usage on the shared subscription core (design 5.3, Claude track
// C2a): the adapter's `fetchUsage` against a scripted usage endpoint, its
// `decodeQuota` with the caller's model catalog, and the projection of a
// stored core quota onto the legacy usage response. No network: the global
// fetch is denied for the whole file; every request goes through the
// connection read's scripted custody fetch.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import type { SubscriptionCoreConnectionRead } from "@opengeni/subscriptions";
import {
  SUBSCRIPTION_CORE_CLAUDE,
  type SubscriptionCoreClaudeCredential,
} from "../src/subscription-core-claude-adapter";
import {
  decodeSubscriptionCoreClaudeUsage,
  fetchSubscriptionCoreClaudeUsage,
  projectSubscriptionCoreClaudeUsage,
  SUBSCRIPTION_CORE_CLAUDE_USAGE_URL,
  SubscriptionCoreClaudeUsageVersionMissing,
  subscriptionCoreClaudeUpstreamModelIds,
  subscriptionCoreClaudeUsageScopeMissing,
  type SubscriptionCoreClaudeUsageReading,
  type SubscriptionCoreClaudeUsageRow,
} from "../src/subscription-core-claude-usage";

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
  token: "sk-ant-oat01-usage",
  identity,
  oauth: {
    refreshToken: "refresh-usage",
    expiresAt: "2026-10-12T10:00:00.000Z",
    scopes: ["user:inference", "user:profile"],
  },
};
const setupToken: SubscriptionCoreClaudeCredential = {
  version: 1,
  token: "sk-ant-oat01-setup",
  identity,
};
const inferenceOnly: SubscriptionCoreClaudeCredential = {
  ...oauth,
  oauth: { ...oauth.oauth!, scopes: ["user:inference"] },
};

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
        throw new Error("a usage read never forces a refresh");
      },
      fetch: async (input, init) => {
        const call = { url: String(input), init };
        calls.push(call);
        return await respond(call);
      },
    },
  };
}

const usageBody = {
  five_hour: { utilization: 42, resets_at: "2026-10-11T15:00:00.000Z" },
  seven_day: { utilization: 12.5, resets_at: "2026-10-15T00:00:00.000Z" },
  seven_day_opus: { utilization: 100, resets_at: "2026-10-14T00:00:00.000Z" },
};

describe("fetchUsage", () => {
  test("the adapter exposes the usage members", () => {
    expect(typeof SUBSCRIPTION_CORE_CLAUDE.adapter.fetchUsage).toBe("function");
    expect(typeof SUBSCRIPTION_CORE_CLAUDE.adapter.decodeQuota).toBe("function");
  });

  test("an available reading: the legacy request through the custody fetch", async () => {
    const { read, calls } = connectionRead(oauth, () => Response.json(usageBody));
    const reading = await SUBSCRIPTION_CORE_CLAUDE.adapter.fetchUsage!(read as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SUBSCRIPTION_CORE_CLAUDE_USAGE_URL);
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${oauth.token}`);
    expect(new Headers(calls[0]!.init?.headers).get("cache-control")).toBe("no-cache");
    const value = reading as SubscriptionCoreClaudeUsageReading;
    expect(value.status).toBe("available");
    expect(value.observation?.source).toBe("provider");
    expect(value.observation?.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ]);
  });

  test.each([
    ["a setup token", setupToken],
    ["an OAuth sign-in without user:profile", inferenceOnly],
  ])("%s is scope_required with no request", async (_label, credential) => {
    const { read, calls } = connectionRead(credential, () => {
      throw new Error("must not be sent");
    });
    const reading = await fetchSubscriptionCoreClaudeUsage(read);
    expect(reading.status).toBe("scope_required");
    expect(reading.observation).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["401", () => new Response("no", { status: 401 }), "reconnect"],
    [
      "403 naming the user:profile scope requirement",
      () =>
        Response.json(
          {
            error: {
              message: "OAuth token does not meet scope requirement user:profile",
            },
          },
          { status: 403 },
        ),
      "scope_required",
    ],
    [
      "another 403",
      () => Response.json({ error: { message: "forbidden" } }, { status: 403 }),
      "unavailable",
    ],
    ["500", () => new Response("down", { status: 500 }), "unavailable"],
    ["a 200 without windows", () => Response.json({}), "unavailable"],
    ["a malformed body", () => new Response("{", { status: 200 }), "unavailable"],
    [
      "an oversized body",
      () => new Response(JSON.stringify({ padding: "x".repeat(70 * 1024) }), { status: 200 }),
      "unavailable",
    ],
    [
      "a transport failure",
      () => {
        throw new TypeError("connection reset");
      },
      "unavailable",
    ],
  ] as const)("%s: the expected status, with no observation", async (_label, respond, status) => {
    const { read } = connectionRead(oauth, respond);
    const reading = await fetchSubscriptionCoreClaudeUsage(read);
    expect(reading.status).toBe(status);
    expect(reading.observation).toBeNull();
  });
});

describe("decodeQuota", () => {
  // The usage fixture has fixed reset dates; keep observations before those dates.
  beforeEach(() => setSystemTime(new Date("2026-10-11T12:00:00.000Z")));
  afterEach(() => setSystemTime());

  const available = async () =>
    await fetchSubscriptionCoreClaudeUsage(
      connectionRead(oauth, () => Response.json(usageBody)).read,
    );

  test("only an available reading decodes", () => {
    for (const response of [
      { status: "unavailable", observation: null, checkedAt: new Date().toISOString() },
      { status: "scope_required", observation: null, checkedAt: new Date().toISOString() },
      { status: "reconnect", observation: null, checkedAt: new Date().toISOString() },
      null,
      "not a reading",
    ]) {
      expect(
        decodeSubscriptionCoreClaudeUsage({
          response,
          observedAt: Date.now(),
          refreshGeneration: 3,
        }),
      ).toBeNull();
    }
  });

  test("a family window cools every listed model of the family, under both prefixes", async () => {
    const reading = await available();
    const quota = SUBSCRIPTION_CORE_CLAUDE.adapter.decodeQuota!({
      response: reading,
      observedAt: Date.now(),
      refreshGeneration: 7,
      modelIds: [
        "organization-claude-subscription/claude-opus-4-1",
        "workspace-claude-subscription/claude-opus-4-5",
        "organization-claude-subscription/claude-sonnet-4-5",
        "codex/gpt-5",
      ],
    })!;
    expect(quota.revision).toBe(0);
    expect(quota.observedRefreshGeneration).toBe(7);
    expect(quota.source).toBe("usage_endpoint");
    expect(quota.exhaustedUntil).toBeNull();
    const opusReset = Date.parse("2026-10-14T00:00:00.000Z");
    expect(quota.modelCooldowns).toEqual({
      "organization-claude-subscription/claude-opus-4-1": opusReset,
      "workspace-claude-subscription/claude-opus-4-1": opusReset,
      "organization-claude-subscription/claude-opus-4-5": opusReset,
      "workspace-claude-subscription/claude-opus-4-5": opusReset,
    });
    // Without a catalog no model is named, so the family window cools nothing.
    const bare = decodeSubscriptionCoreClaudeUsage({
      response: reading,
      observedAt: Date.now(),
      refreshGeneration: 7,
    })!;
    expect(bare.modelCooldowns).toEqual({});
  });

  test.each(["2026-10-14T00:00:00.000Z", "2027-01-01T00:00:00.000Z"])(
    "an expired family window does not cool models at %s",
    async (now) => {
      setSystemTime(new Date(now));
      const quota = SUBSCRIPTION_CORE_CLAUDE.adapter.decodeQuota!({
        response: await available(),
        observedAt: Date.now(),
        refreshGeneration: 7,
        modelIds: ["organization-claude-subscription/claude-opus-4-1"],
      })!;
      expect(quota.modelCooldowns).toEqual({});
      expect(quota.exhaustedUntil).toBeNull();
    },
  );

  test("upstream ids come only from Claude product ids", () => {
    expect(
      subscriptionCoreClaudeUpstreamModelIds([
        "workspace-claude-subscription/claude-b",
        "organization-claude-subscription/claude-a",
        "organization-claude-subscription/claude-b",
        "organization-claude-subscription/",
        "supergrok/grok-4",
        "claude-c",
      ]),
    ).toEqual(["claude-a", "claude-b"]);
  });
});

describe("projectSubscriptionCoreClaudeUsage", () => {
  const updatedAt = "2026-10-11T12:00:00.000Z";
  const row = (
    patch: Partial<SubscriptionCoreClaudeUsageRow> = {},
  ): SubscriptionCoreClaudeUsageRow => ({
    status: "active",
    provider_state: { oauthScopes: ["user:inference", "user:profile"] },
    quota: {
      windows: [
        {
          id: "five_hour",
          usedPercent: 100,
          resetsAt: Date.parse("2026-10-11T15:00:00Z"),
          status: "exhausted",
        },
        {
          id: "seven_day",
          usedPercent: 91,
          resetsAt: Date.parse("2026-10-15T00:00:00Z"),
          status: "warning",
        },
        { id: "seven_day_opus", usedPercent: 10, resetsAt: null, status: "unknown" },
        { id: "overage", usedPercent: null, resetsAt: null, status: "ok" },
        { id: "primary", usedPercent: 5, resetsAt: null, status: "ok" },
        { id: "five_hour", usedPercent: 1, resetsAt: null, status: "ok" },
      ],
      modelCooldowns: {},
      exhaustedUntil: Date.parse("2026-10-11T15:00:00Z"),
      exhaustedKind: "quota",
      source: "usage_endpoint",
    },
    quota_revision: 4,
    quota_observed_refresh_generation: 6,
    quota_updated_at: updatedAt,
    version: 3,
    ...patch,
  });

  test("maps core windows back to the legacy shape; the credential version is the row version", () => {
    const usage = ClaudeSubscriptionUsage.parse(projectSubscriptionCoreClaudeUsage(row()));
    expect(usage).toEqual({
      connected: true,
      // The row version (the account listing's), not the quota's generation.
      credentialVersion: 3,
      windows: [
        {
          id: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-10-11T15:00:00.000Z",
          // Exhausted is rejected whatever reading kept it.
          status: "rejected",
          observedAt: updatedAt,
          source: "provider",
        },
        {
          id: "seven_day",
          usedPercent: 91,
          resetsAt: "2026-10-15T00:00:00.000Z",
          // Legacy usage-endpoint windows carried no status.
          status: null,
          observedAt: updatedAt,
          source: "provider",
        },
        {
          id: "seven_day_opus",
          usedPercent: 10,
          resetsAt: null,
          status: null,
          observedAt: updatedAt,
          source: "provider",
        },
        {
          id: "overage",
          usedPercent: null,
          resetsAt: null,
          status: null,
          observedAt: updatedAt,
          source: "provider",
        },
      ],
      observedAt: updatedAt,
      source: "provider",
      refreshStatus: "available",
      refreshCheckedAt: updatedAt,
    });
  });

  test("after a header observation statuses map back, and family and overage rejections are derived", () => {
    const now = Date.now();
    const headerRow = (patch: Record<string, unknown>) =>
      row({
        quota: {
          windows: [
            { id: "five_hour", usedPercent: 40, resetsAt: now + 3_600_000, status: "ok" },
            { id: "seven_day", usedPercent: 91, resetsAt: now + 86_400_000, status: "warning" },
            {
              id: "seven_day_opus",
              usedPercent: 100,
              resetsAt: now + 86_400_000,
              status: "unknown",
            },
            {
              id: "seven_day_sonnet",
              usedPercent: 20,
              resetsAt: now + 86_400_000,
              status: "unknown",
            },
            { id: "overage", usedPercent: null, resetsAt: now + 86_400_000, status: "unknown" },
          ],
          modelCooldowns: {
            "organization-claude-subscription/claude-opus-4-5": now + 86_400_000,
            // An ended cooldown is not a running limit.
            "organization-claude-subscription/claude-sonnet-4-5": now - 1_000,
          },
          exhaustedUntil: null,
          exhaustedKind: null,
          source: "response_headers",
          ...patch,
        },
      });
    const statuses = (usage: ReturnType<typeof projectSubscriptionCoreClaudeUsage>) =>
      Object.fromEntries(usage.windows.map((window) => [window.id, window.status]));
    expect(statuses(projectSubscriptionCoreClaudeUsage(headerRow({})))).toEqual({
      five_hour: "allowed",
      seven_day: "allowed_warning",
      seven_day_opus: "rejected",
      seven_day_sonnet: null,
      // The connection still serves: its overage status is unknown here.
      overage: null,
    });
    // While the connection itself is exhausted, an overage would have covered
    // it had it been allowed: the overage window is rejected.
    expect(
      statuses(
        projectSubscriptionCoreClaudeUsage(
          headerRow({ exhaustedUntil: now + 3_600_000, exhaustedKind: "quota" }),
        ),
      ).overage,
    ).toBe("rejected");
    // A usage-endpoint reading keeps the legacy null statuses.
    expect(
      statuses(projectSubscriptionCoreClaudeUsage(headerRow({ source: "usage_endpoint" }))),
    ).toEqual({
      five_hour: null,
      seven_day: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      overage: null,
    });
    // Statuses are judged at the given instant: once the Opus cooldown and
    // window have ended, the family window is no longer rejected.
    expect(
      statuses(projectSubscriptionCoreClaudeUsage(headerRow({}), undefined, { now })),
    ).toMatchObject({ seven_day_opus: "rejected" });
    expect(
      statuses(
        projectSubscriptionCoreClaudeUsage(headerRow({}), undefined, { now: now + 2 * 86_400_000 }),
      ),
    ).toMatchObject({ seven_day_opus: null });
  });

  test("windows observed under an earlier credential generation stay visible", () => {
    // The quota was observed with refresh generation 1; the credential has
    // since refreshed (the row version does not move on a token refresh).
    const usage = projectSubscriptionCoreClaudeUsage(
      row({ quota_observed_refresh_generation: 1, version: 5 }),
    );
    expect(usage.credentialVersion).toBe(5);
    expect(usage.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "overage",
    ]);
  });

  test("a row without a usable version fails closed (never 0 or null)", () => {
    for (const version of [undefined, 0, -1, "x", 1.5])
      expect(() => projectSubscriptionCoreClaudeUsage(row({ version: version as never }))).toThrow(
        SubscriptionCoreClaudeUsageVersionMissing,
      );
    expect(projectSubscriptionCoreClaudeUsage(row({ version: "7" })).credentialVersion).toBe(7);
  });

  test("header and refusal observations are response_headers and not a usage read", () => {
    for (const source of ["response_headers", "refusal"]) {
      const base = row();
      const usage = projectSubscriptionCoreClaudeUsage({
        ...base,
        quota: { ...(base.quota as object), source },
      });
      expect(usage.source).toBe("response_headers");
      expect(usage.windows.every((window) => window.source === "response_headers")).toBe(true);
      expect(usage.refreshStatus).toBe("not_checked");
      expect(usage.refreshCheckedAt).toBeNull();
    }
  });

  test("no quota row: connected with its row version, no windows, not checked", () => {
    const usage = projectSubscriptionCoreClaudeUsage(
      row({
        quota: null,
        quota_revision: null,
        quota_observed_refresh_generation: null,
        quota_updated_at: null,
      }),
    );
    expect(ClaudeSubscriptionUsage.parse(usage)).toEqual({
      connected: true,
      credentialVersion: 3,
      windows: [],
      observedAt: null,
      source: null,
      refreshStatus: "not_checked",
      refreshCheckedAt: null,
    });
  });

  test("reconnect and scope_required are derived, never stored", () => {
    expect(projectSubscriptionCoreClaudeUsage(row({ status: "needs_relogin" })).refreshStatus).toBe(
      "reconnect",
    );
    // A live read cannot hide a connection that needs a new sign-in.
    expect(
      projectSubscriptionCoreClaudeUsage(row({ status: "needs_relogin" }), {
        status: "available",
        checkedAt: updatedAt,
      }).refreshStatus,
    ).toBe("reconnect");
    expect(
      projectSubscriptionCoreClaudeUsage(row({ provider_state: { oauthScopes: [] } }))
        .refreshStatus,
    ).toBe("scope_required");
    expect(
      projectSubscriptionCoreClaudeUsage(
        row({ provider_state: { oauthScopes: ["user:inference"] } }),
      ).refreshStatus,
    ).toBe("scope_required");
    // Unknown scopes (absent or malformed) are not reported as missing.
    for (const providerState of [{}, null, { oauthScopes: "user:profile" }, { oauthScopes: [1] }])
      expect(subscriptionCoreClaudeUsageScopeMissing(providerState as never)).toBe(false);
    // A live read decides by the credential it decoded.
    expect(
      projectSubscriptionCoreClaudeUsage(row({ provider_state: { oauthScopes: [] } }), {
        status: "available",
        checkedAt: updatedAt,
      }).refreshStatus,
    ).toBe("available");
  });

  test("a refresh outcome replaces the derived one", () => {
    const usage = projectSubscriptionCoreClaudeUsage(row(), {
      status: "unavailable",
      checkedAt: "2026-10-11T12:30:00.000Z",
    });
    expect(usage.refreshStatus).toBe("unavailable");
    expect(usage.refreshCheckedAt).toBe("2026-10-11T12:30:00.000Z");
    // The stored windows stay: an unavailable read never implies zero usage.
    expect(usage.windows).toHaveLength(4);
  });

  test("a malformed stored quota projects no windows", () => {
    const usage = projectSubscriptionCoreClaudeUsage(row({ quota: { windows: "nope" } }));
    expect(usage.windows).toEqual([]);
    expect(usage.source).toBeNull();
    expect(ClaudeSubscriptionUsage.safeParse(usage).success).toBe(true);
  });
});
