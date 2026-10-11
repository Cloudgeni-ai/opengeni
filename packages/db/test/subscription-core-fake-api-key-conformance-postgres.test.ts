/**
 * The shared subscription-core conformance suite for a test-only API-key
 * connector (design docs/design/subscription-core-2026-10-07.md, 2.1 and 5.3
 * step F): a static key, no refresh, a spend budget and rate limits instead of
 * quota windows, and models of several vendors behind one key, driven through
 * the same placement, lease, failover, health and wait paths as the
 * subscription providers, on real PostgreSQL as the application role.
 *
 * The connector is registered only in this process and this test database;
 * production gains no provider, table or route (asserted below).
 *
 * Run this file in its own process: the registration below replaces module
 * bindings for the whole process (the CI shard classifier isolates files that
 * call mock.module).
 */
import { describe, expect, mock, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import {
  decidePlacement,
  type PlacementInput,
  type SubscriptionConnection,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";
import { checkPlacementDecision } from "@opengeni/subscriptions/reference";
import { acquireSharedTestDatabase } from "@opengeni/testing";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import {
  classifyFakeApiKeyError,
  FAKE_API_KEY_MODELS,
  FAKE_API_KEY_PROVIDER,
  fakeApiKeyAdapter,
  fakeApiKeyFingerprint,
  FakeApiKeyUpstreamError,
  fakeApiKeyProvider,
  fakeApiKeySignIn,
  installNetworkDenialGuard,
  ScriptedApiKeyUpstream,
} from "./fixtures/subscription-core-fake-api-key";
import {
  admitTestSubscriptionCoreProvider,
  testSubscriptionCoreProviderModules,
} from "./helpers/subscription-core-test-provider";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
// Read before the test registration: what production registers.
const productionProviderIds = subscriptionCoreProviderIds();

for (const [specifier, factory] of testSubscriptionCoreProviderModules(fakeApiKeyProvider))
  mock.module(specifier, factory);
const { describeSubscriptionCoreConformance } =
  await import("./helpers/subscription-core-conformance");

const upstream = new ScriptedApiKeyUpstream();

describeSubscriptionCoreConformance({
  name: "fake API-key connector",
  databaseLabel: "subscription-core-fake-api-key-conformance",
  provider: fakeApiKeyProvider,
  models: FAKE_API_KEY_MODELS,
  credential: (label) => ({ apiKey: `sk-conformance-${label}` }),
  async identity(_label, credential) {
    const signedIn = await fakeApiKeySignIn(upstream.origin, credential.apiKey);
    if (signedIn.kind !== "connected") throw new Error("the scripted upstream refused the key");
    return signedIn;
  },
  providerState: {},
  // A gateway key is an organization's own upstream account.
  executionPolicy: {
    wireApi: "chat",
    credentialSource: { kind: "organization_connection", mechanism: "api_key" },
    billing: { upstreamPayer: "organization", metering: "external" },
  },
  foreignProvider: "codex",
  expiresAt: () => null,
  async prepareDatabase(shared) {
    await admitTestSubscriptionCoreProvider(shared.admin, fakeApiKeyProvider);
  },
  upstream,
  denyNetwork: installNetworkDenialGuard,
});

describe("fake API-key connector: adapter shape", () => {
  test("is a static API key with a spend budget and no refresh, primary or quota windows", async () => {
    expect(fakeApiKeyAdapter).toMatchObject({
      credentialKind: "api_key",
      quotaKind: "spend_budget",
      refresh: null,
      capabilities: { quotaWindows: false, autoRenews: false, extraCredits: false },
    });
    // Its rows are `api_key` rows (the suite seeds and asserts this kind).
    const { subscriptionCoreConnectionKind } = await import("../src/subscription-core/provider");
    expect(subscriptionCoreConnectionKind(fakeApiKeyProvider)).toBe("api_key");
    expect(fakeApiKeyProvider.settings.primaryColumn).toBeNull();
    expect(fakeApiKeyAdapter.credential.expiry({ apiKey: "sk-x" })).toBeNull();
    const vendors = new Set(
      FAKE_API_KEY_MODELS.map((model) => model.upstreamModelId.split("/")[0]),
    );
    expect(vendors.size).toBeGreaterThanOrEqual(3);
  });

  test("classifies a 402 or 403 from its body: a spent limit waits, a blocked request is not a key refusal", () => {
    const model = FAKE_API_KEY_MODELS[0]!.productModelId;
    const resetsAt = Date.UTC(2026, 9, 12);
    const classify = (
      status: number,
      error: NonNullable<FakeApiKeyUpstreamError["body"]["error"]>,
      retryAfterSeconds: number | null = null,
    ) =>
      classifyFakeApiKeyError(
        new FakeApiKeyUpstreamError(status, retryAfterSeconds, { error }),
        0,
        model,
      );
    // OpenRouter's budget 403s (key limit, workspace or guardrail budget):
    // exhausted until the ISO reset, or with no known reset for a lifetime one.
    expect(
      classify(403, {
        code: 403,
        metadata: {
          limit_source: "openrouter_key_limit",
          resets_at: new Date(resetsAt).toISOString(),
        },
      }),
    ).toEqual({ kind: "exhausted", resetAt: resetsAt });
    expect(
      classify(403, {
        code: 403,
        metadata: { limit_source: "openrouter_workspace_budget", resets_at: null },
      }),
    ).toEqual({ kind: "exhausted", resetAt: null });
    // A block of this one request changes no health: a guardrail's patterns,
    // a moderation flag's reasons, a provider's content policy or refusal.
    for (const metadata of [
      { patterns: ["ignore all previous instructions"] },
      { reasons: ["violence"] },
      { error_type: "content_policy_violation" },
      { error_type: "refusal" },
    ]) {
      expect(classify(403, { code: 403, message: "Request blocked", metadata })).toEqual({
        kind: "fatal",
      });
    }
    // Only a refusal of the key itself quarantines it.
    expect(classify(403, { code: 403, message: "Forbidden" })).toEqual({ kind: "forbidden" });
    // A full in-flight budget is transient and says when to retry.
    expect(
      classify(
        402,
        {
          code: 402,
          metadata: {
            reason: "in_flight_budget_exhausted",
            limit_source: "openrouter_in_flight_budget",
          },
        },
        7,
      ),
    ).toEqual({ kind: "rate_limited", retryAfterMs: 7_000 });
    // One request too expensive for the whole budget fails alone.
    expect(
      classify(402, {
        code: 402,
        metadata: { reason: "weight_exceeds_budget", limit_source: "openrouter_credits" },
      }),
    ).toEqual({ kind: "fatal" });
    // Spent credit or a spent key limit: exhausted with no known reset.
    expect(
      classify(402, { code: 402, metadata: { limit_source: "openrouter_key_limit" } }),
    ).toEqual({
      kind: "exhausted",
      resetAt: null,
    });
    expect(classify(402, { code: 402, message: "Insufficient credits" })).toEqual({
      kind: "exhausted",
      resetAt: null,
    });
  });

  test("sign-in derives a stable synthetic identity from the key and refuses a bad key", async () => {
    const local = new ScriptedApiKeyUpstream();
    local.start();
    try {
      local.issue("sk-good");
      const first = await fakeApiKeySignIn(local.origin, "sk-good");
      expect(first).toEqual({
        kind: "connected",
        providerAccountId: fakeApiKeyFingerprint("sk-good"),
        providerSubjectId: fakeApiKeyFingerprint("sk-good"),
      });
      expect(await fakeApiKeySignIn(local.origin, "sk-good")).toEqual(first);
      expect(JSON.stringify(first)).not.toContain("sk-good");
      // Keyed: another deployment's secret gives another identity, and the
      // value is not the unkeyed digest of the key.
      expect(fakeApiKeyFingerprint("sk-good", "another-deployment")).not.toBe(
        fakeApiKeyFingerprint("sk-good"),
      );
      expect(fakeApiKeyFingerprint("sk-good")).toStartWith("key-hmac:");
      expect(fakeApiKeyFingerprint("sk-good")).not.toContain(
        new Bun.CryptoHasher("sha256").update("sk-good").digest("hex").slice(0, 32),
      );
      expect(await fakeApiKeySignIn(local.origin, "sk-unknown")).toEqual({ kind: "refused" });
    } finally {
      await local.stop();
    }
  });

  test("the network-denial guard refuses every origin but the scripted upstream", async () => {
    const local = new ScriptedApiKeyUpstream();
    local.start();
    const guard = installNetworkDenialGuard(() => [local.origin]);
    try {
      local.issue("sk-guard");
      await expect(fakeApiKeySignIn(local.origin, "sk-guard")).resolves.toMatchObject({
        kind: "connected",
      });
      await expect(fetch("https://openrouter.ai/api/v1/key")).rejects.toThrow(/denied/);
      await expect(fetch("http://127.0.0.1:9/")).rejects.toThrow(/denied/);
      // node:http and node:https through their module objects.
      expect(() => https.get("https://openrouter.ai/api/v1/key")).toThrow(/denied/);
      expect(() => http.request({ hostname: "203.0.113.7", port: 8080, path: "/" })).toThrow(
        /denied/,
      );
      expect(guard.escapes).toEqual([
        "https://openrouter.ai",
        "http://127.0.0.1:9",
        "https://openrouter.ai",
        "http://203.0.113.7:8080",
      ]);
      expect(() => guard.assertNoEscapes()).toThrow(/unexpected network access/);
    } finally {
      guard.restore();
      await local.stop();
    }
  });

  test("production registers no test provider", () => {
    expect(productionProviderIds).not.toContain(FAKE_API_KEY_PROVIDER);
    expect(productionProviderIds.every((id) => !id.includes("api_key"))).toBe(true);
  });
});

describe("fake API-key connector: cross-provider failover in the shared policy", () => {
  // Core placement leases from one provider per turn (design 5.1.3); the
  // shared policy owns cross-provider failover. An API-key connection is an
  // ordinary candidate there, compared with the reference model.
  const NOW = 10_000_000;
  const quota = (patch: Partial<SubscriptionQuota> = {}): SubscriptionQuota => ({
    windows: [],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 1,
    observedAt: NOW - 1_000,
    observedRefreshGeneration: 1,
    source: "usage_endpoint",
    ...patch,
  });
  const connection = (
    id: string,
    provider: string,
    kind: SubscriptionConnection["kind"],
    patch: Partial<SubscriptionConnection> = {},
  ): SubscriptionConnection => ({
    id,
    provider,
    kind,
    ownership: { kind: "shared", scope: { kind: "organization" }, managedByWorkspaceId: null },
    health: "healthy",
    allocatorEnabled: true,
    entitledModelIds: null,
    excludedModelIds: [],
    allowedModelIds: null,
    refreshGeneration: 1,
    quota: quota(),
    ...patch,
  });
  const [gatewayModel] = FAKE_API_KEY_MODELS;
  const world = (
    preferredModelId: string,
    connections: SubscriptionConnection[],
    crossProviderFailover = true,
  ): PlacementInput => ({
    now: NOW,
    workspace: { id: "ws", kind: "shared", ownerMembershipId: null, allowedModelIds: null },
    session: {
      id: "session",
      workspaceId: "ws",
      visibility: "shared",
      ownerMembershipId: "member",
      preferredModelId,
      reasoningLevel: "medium",
      binding: null,
      onlyThisModel: false,
      reselectionPoints: [],
      personalAuthority: [],
      compactionProviderLock: null,
    },
    settings: {
      rotation: {},
      providers: {},
      crossProviderFailover,
      fallbackOrder: {
        "codex/a": [gatewayModel.productModelId],
        [gatewayModel.productModelId]: ["codex/a"],
      },
      personalConnectionsAllowed: true,
      personalFallbackAllowed: true,
    },
    people: [{ membershipId: "member", active: true, personalFallbackOptIn: false }],
    models: [
      { id: "codex/a", provider: "codex", reasoningLevels: ["medium"] },
      {
        id: gatewayModel.productModelId,
        provider: FAKE_API_KEY_PROVIDER,
        reasoningLevels: ["medium"],
      },
    ],
    connections,
    cacheFacts: {
      codex: { kind: "measured_idle_cutoff", cutoffMs: null },
      [FAKE_API_KEY_PROVIDER]: fakeApiKeyAdapter.cacheFacts,
    },
  });
  const checked = (input: PlacementInput) => {
    const decision = decidePlacement(input);
    expect(checkPlacementDecision(input, decision)).toEqual([]);
    return decision;
  };
  const exhausted = quota({ exhaustedUntil: NOW + 60_000, exhaustedKind: "rate_limit" });

  test("a rate-limited subscription fails over to an API-key connection, and back", () => {
    expect(
      checked(
        world("codex/a", [
          connection("sub", "codex", "subscription", { quota: exhausted }),
          connection("key", FAKE_API_KEY_PROVIDER, "api_key"),
        ]),
      ),
    ).toMatchObject({ kind: "run", connectionId: "key", modelId: gatewayModel.productModelId });
    expect(
      checked(
        world(gatewayModel.productModelId, [
          connection("sub", "codex", "subscription"),
          connection("key", FAKE_API_KEY_PROVIDER, "api_key", { quota: exhausted }),
        ]),
      ),
    ).toMatchObject({ kind: "run", connectionId: "sub", modelId: "codex/a" });
  });

  test("without cross-provider failover the turn waits for the earliest reset", () => {
    expect(
      checked(
        world(
          "codex/a",
          [
            connection("sub", "codex", "subscription", { quota: exhausted }),
            connection("key", FAKE_API_KEY_PROVIDER, "api_key"),
          ],
          false,
        ),
      ),
    ).toMatchObject({ kind: "wait", earliestResetAt: NOW + 60_000 });
  });
});

describe.skipIf(!realDb)("fake API-key connector: production schema is unchanged", () => {
  test("a migrated database registers no API-key provider and admits no test provider", async () => {
    const shared = await acquireSharedTestDatabase("subscription-core-fake-api-key-production");
    if (!shared) throw new Error("Real PostgreSQL is required");
    try {
      const providers = await shared.admin<{ provider: string; connection_kind: string }[]>`
        select provider, connection_kind from opengeni_private.subscription_core_providers
        order by provider`;
      expect(providers.every((row) => row.connection_kind === "subscription")).toBe(true);
      expect(providers.map((row) => row.provider)).toEqual([...productionProviderIds].sort());
      expect(providers.map((row) => row.provider)).not.toContain(FAKE_API_KEY_PROVIDER);
      // The kind lookup answers only owner-run callers: not SECURITY DEFINER,
      // no PUBLIC EXECUTE, and the runtime role cannot read the registry.
      const routines = await shared.admin<
        { name: string; definer: boolean; app: boolean; anyone: boolean }[]
      >`
        select procedure.oid::regprocedure::text as name, procedure.prosecdef as definer,
          has_function_privilege('opengeni_app', procedure.oid, 'EXECUTE') as app,
          exists (select 1 from aclexplode(coalesce(procedure.proacl,
            acldefault('f', procedure.proowner))) acl
            where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as anyone
        from pg_catalog.pg_proc procedure
        where procedure.proname in ('subscription_core_connection_kind',
          'guard_subscription_provider_connection_kind')
        order by 1`;
      expect([...routines]).toEqual([
        {
          name: "opengeni_private.guard_subscription_provider_connection_kind()",
          definer: false,
          app: true,
          anyone: false,
        },
        {
          name: "opengeni_private.subscription_core_connection_kind(text)",
          definer: false,
          app: true,
          anyone: false,
        },
      ]);
      const [registryRead] = await shared.admin<{ allowed: boolean }[]>`
        select has_table_privilege('opengeni_app',
          'opengeni_private.subscription_core_providers', 'SELECT') as allowed`;
      expect(registryRead!.allowed).toBe(false);
      // The shared tables refuse an unregistered provider id.
      // (postgres.js queries run when awaited, so each is wrapped.)
      const refused = async (run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (error) {
          return (error as { code?: string }).code ?? "error";
        }
        return null;
      };
      expect(
        await refused(
          async () =>
            await shared.admin`
              insert into subscription_provider_cutovers (account_id, provider, enabled)
              values (gen_random_uuid(), ${FAKE_API_KEY_PROVIDER}, true)`,
        ),
      ).toBe("23514");
      // A registered provider's kind cannot be changed after the fact.
      expect(
        await refused(
          async () =>
            await shared.admin`
              update opengeni_private.subscription_core_providers
              set connection_kind = 'api_key' where provider = 'codex'`,
        ),
      ).toBe("55000");
    } finally {
      await shared.release();
    }
  }, 180_000);
});
