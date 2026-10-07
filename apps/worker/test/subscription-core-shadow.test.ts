import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  currentSessionRlsActorInitiatingHumanSubjectId,
  withSessionRlsActorContext,
  type Database,
  type LegacyPlacementInputs,
  type LegacyPlacementWorldResult,
} from "@opengeni/db";
import { createLogThrottle } from "@opengeni/observability";
import type { PlacementInput, SubscriptionConnection } from "@opengeni/subscriptions";
import {
  compareSubscriptionCoreShadow,
  createShadowLogRateCap,
  runSubscriptionCoreShadow,
  startSubscriptionCoreShadow,
  subscriptionCoreShadowInFlight,
  shadowConnectionAlias,
  type SubscriptionCoreShadowDeps,
} from "../src/activities/agent-turn/subscription-core-shadow";
import {
  SUBSCRIPTION_CORE_SHADOW_INPUTS,
  SUBSCRIPTION_CORE_SHADOW_PARITY,
  SUBSCRIPTION_CORE_SHADOW_PARITY_REASONS,
  SUBSCRIPTION_CORE_SHADOW_PLACEMENTS,
  SUBSCRIPTION_CORE_SHADOW_REQUIREMENTS,
  SUBSCRIPTION_CORE_SHADOW_SKIPS,
} from "../src/observability-metrics";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const LOCAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function connection(
  id: string,
  patch: Partial<SubscriptionConnection> = {},
): SubscriptionConnection {
  return {
    id,
    provider: "codex",
    kind: "subscription",
    ownership: {
      kind: "shared",
      managedByWorkspaceId: WORKSPACE,
      scope: { kind: "workspaces", workspaceIds: [WORKSPACE], allowPersonalWorkspaces: false },
    },
    health: "healthy",
    allocatorEnabled: true,
    entitledModelIds: null,
    excludedModelIds: [],
    allowedModelIds: null,
    refreshGeneration: 1,
    quota: null,
    ...patch,
  };
}

function world(patch: Partial<PlacementInput> = {}, legacy: Partial<LegacyPlacementInputs> = {}) {
  const input: PlacementInput = {
    now: NOW,
    workspace: { id: WORKSPACE, kind: "shared", ownerMembershipId: null, allowedModelIds: null },
    session: {
      id: SESSION,
      workspaceId: WORKSPACE,
      visibility: "shared",
      ownerMembershipId: "user:owner",
      preferredModelId: "codex/model",
      reasoningLevel: "high",
      binding: null,
      onlyThisModel: false,
      reselectionPoints: [],
      personalAuthority: [],
      compactionProviderLock: null,
    },
    settings: {
      rotation: { codex: { mode: "primary_first", primaryConnectionId: LOCAL_A } },
      providers: {},
      crossProviderFailover: false,
      fallbackOrder: {},
      personalConnectionsAllowed: true,
      personalFallbackAllowed: true,
    },
    people: [{ membershipId: "user:owner", active: true, personalFallbackOptIn: false }],
    models: [{ id: "codex/model", provider: "codex", reasoningLevels: ["high"] }],
    connections: [connection(LOCAL_A), connection(LOCAL_B)],
    cacheFacts: { codex: { kind: "measured_idle_cutoff", cutoffMs: null } },
    ...patch,
  };
  return {
    input,
    legacy: {
      source: "workspace" as const,
      codexMode: "automatic" as const,
      rotationEnabled: false,
      activeConnectionId: LOCAL_A,
      pin: null,
      lastConnectionId: null,
      poolOrder: [LOCAL_A, LOCAL_B],
      workspaceModelPolicy: "none" as const,
      lastModelCallAt: null,
      truncated: false,
      ...legacy,
    },
  };
}

type Recorded = {
  counters: { name: string; labels: Record<string, string> }[];
  histograms: { name: string; labels: Record<string, string> }[];
  logs: { message: string; attributes: Record<string, unknown> }[];
};

function observability(): Recorded & SubscriptionCoreShadowDeps["observability"] {
  const recorded: Recorded = { counters: [], histograms: [], logs: [] };
  return {
    ...recorded,
    incrementCounter: (metric: { name: string; labels?: Record<string, string> }) => {
      recorded.counters.push({ name: metric.name, labels: metric.labels ?? {} });
    },
    observeHistogram: (metric: { name: string; labels?: Record<string, string> }) => {
      recorded.histograms.push({ name: metric.name, labels: metric.labels ?? {} });
    },
    info: (message: string, attributes: Record<string, unknown> = {}) => {
      recorded.logs.push({ message, attributes });
    },
  } as unknown as Recorded & SubscriptionCoreShadowDeps["observability"];
}

function deps(
  load: (request: unknown) => Promise<LegacyPlacementWorldResult>,
  patch: Partial<SubscriptionCoreShadowDeps> = {},
) {
  const recorder = observability();
  const value: SubscriptionCoreShadowDeps = {
    enabled: true,
    timeoutMs: 200,
    db: {} as Database,
    observability: recorder,
    request: () => ({
      accountId: "33333333-3333-4333-8333-333333333333",
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      turnId: "44444444-4444-4444-8444-444444444444",
      provider: "codex",
      productModelId: "codex/model",
      upstreamModelId: "model",
      reasoningLevel: "high",
      modelPolicyProviderId: "codex-subscription",
      authorityScope: null,
    }),
    legacy: { selectedConnectionId: LOCAL_A, reusedLease: false },
    now: () => new Date(NOW),
    load: async (_db, request) => await load(request),
    logThrottle: createLogThrottle({ intervalMs: 60_000, maxKeys: 16 }),
    logRateCap: createShadowLogRateCap(100),
    // Never-settling test loads keep their slots; caps are tested explicitly.
    maxInFlight: 1_000,
    ...patch,
  };
  return { deps: value, recorder };
}

const counter = (recorded: Recorded, name: string) =>
  recorded.counters.filter((entry) => entry.name === name);

describe("subscription core shadow", () => {
  test("SUB-COMPAT-03: a disabled shadow does no work at all", async () => {
    let called = false;
    const { deps: input, recorder } = deps(async () => {
      called = true;
      return { status: "loaded", ...world() };
    });
    expect(await runSubscriptionCoreShadow({ ...input, enabled: false })).toEqual({
      outcome: "disabled",
    });
    expect(called).toBe(false);
    expect(recorder.counters).toEqual([]);
  });

  test("SUB-COMPAT-03: matching decisions record parity, agreement and the legacy inputs present", async () => {
    const { deps: input, recorder } = deps(async () => ({ status: "loaded", ...world() }));
    const result = await runSubscriptionCoreShadow(input);
    expect(result).toMatchObject({
      outcome: "compared",
      comparison: { parity: "eligible", placement: "same_account", violations: [] },
    });
    expect(counter(recorder, "opengeni_subscription_core_shadow_comparisons_total")).toEqual([
      {
        name: "opengeni_subscription_core_shadow_comparisons_total",
        labels: { provider: "codex", parity: "eligible", placement: "same_account" },
      },
    ]);
    expect(
      counter(recorder, "opengeni_subscription_core_shadow_inputs_total").map(
        (entry) => entry.labels.input,
      ),
    ).toEqual(["rotation_off", "unknown_quota"]);
    expect(counter(recorder, "opengeni_subscription_core_shadow_violations_total")).toEqual([]);
    expect(recorder.histograms).toHaveLength(1);
  });

  test("SUB-ELIG-01, SUB-ELIG-05: a legacy account outside the core's authorized set is a security parity failure", async () => {
    // The workspace-scoped account of another workspace, as legacy Codex user-scope rows were.
    const outsider = connection(LOCAL_B, {
      ownership: { kind: "personal", ownerMembershipId: "membership:someone-else" },
    });
    const loaded = world({ connections: [connection(LOCAL_A), outsider] });
    const { deps: input, recorder } = deps(async () => ({ status: "loaded", ...loaded }), {
      legacy: { selectedConnectionId: LOCAL_B, reusedLease: true },
    });
    const result = await runSubscriptionCoreShadow(input);
    expect(result).toMatchObject({
      outcome: "compared",
      comparison: { parity: "not_authorized", placement: "different_account" },
    });
    expect(
      counter(recorder, "opengeni_subscription_core_shadow_parity_failures_total")[0]?.labels,
      // The owner is not a known person of this organization; authorization
      // reasons are reported before serviceability reasons.
    ).toEqual({ provider: "codex", reason: "personal_owner_inactive" });
    expect(
      counter(recorder, "opengeni_subscription_core_shadow_inputs_total").map(
        (entry) => entry.labels.input,
      ),
    ).toContain("lease_reused");
    // The notable debug event names aliases, never connection ids.
    const log = recorder.logs[0]!;
    expect(log.message).toBe("Subscription core shadow comparison");
    expect(log.attributes.legacyConnection).toBe(shadowConnectionAlias(SESSION, LOCAL_B));
    expect(JSON.stringify(log.attributes)).not.toContain(LOCAL_A);
    expect(JSON.stringify(log.attributes)).not.toContain(LOCAL_B);
  });

  test("would-switch: the core waits, runs where legacy waits, or picks another account", () => {
    const exhausted = {
      windows: [],
      modelCooldowns: {},
      exhaustedUntil: NOW + 60_000,
      exhaustedKind: "quota" as const,
      revision: 1,
      observedAt: NOW,
      observedRefreshGeneration: 1,
      source: "refusal" as const,
    };
    const allExhausted = world({
      connections: [
        connection(LOCAL_A, { quota: exhausted }),
        connection(LOCAL_B, { quota: exhausted }),
      ],
    });
    expect(
      compareSubscriptionCoreShadow(allExhausted, {
        selectedConnectionId: LOCAL_A,
        reusedLease: false,
      }),
    ).toMatchObject({ parity: "not_servable", placement: "core_waits" });
    expect(
      compareSubscriptionCoreShadow(world(), { selectedConnectionId: null, reusedLease: false }),
    ).toMatchObject({ parity: "no_selection", placement: "core_runs_legacy_waits" });
    expect(
      compareSubscriptionCoreShadow(world(), { selectedConnectionId: LOCAL_B, reusedLease: false }),
    ).toMatchObject({ parity: "eligible", placement: "different_account" });
    expect(
      compareSubscriptionCoreShadow(world(), { selectedConnectionId: ORG, reusedLease: false }),
    ).toMatchObject({ parity: "unknown_connection" });
  });

  test("SUB-WAIT-02: the core's own decisions on legacy worlds pass the reference checker", () => {
    const comparisons = [
      world(),
      world({}, { pin: { connectionId: LOCAL_B, source: "manual" } }),
      world({
        session: {
          ...world().input.session,
          binding: {
            connectionId: LOCAL_B,
            provider: "codex",
            modelId: "codex/model",
            choice: "explicit",
            lastModelCallAt: NOW - 1_000,
          },
        },
      }),
    ].map((loaded) =>
      compareSubscriptionCoreShadow(loaded, { selectedConnectionId: LOCAL_A, reusedLease: false }),
    );
    for (const comparison of comparisons) expect(comparison.violations).toEqual([]);
  });

  test("SUB-COMPAT-03: a slow world load is abandoned at the deadline and placement continues", async () => {
    const { deps: input, recorder } = deps(() => new Promise(() => undefined), { timeoutMs: 20 });
    const startedAt = performance.now();
    expect(await runSubscriptionCoreShadow(input)).toEqual({
      outcome: "skipped",
      reason: "timeout",
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(counter(recorder, "opengeni_subscription_core_shadow_skips_total")[0]?.labels).toEqual({
      provider: "codex",
      reason: "timeout",
    });
  });

  test("SUB-COMPAT-03: load failures, invisible sessions, missing actors and cancellation fail open", async () => {
    const failing = deps(async () => {
      throw new Error("connection reset");
    });
    expect(await runSubscriptionCoreShadow(failing.deps)).toEqual({
      outcome: "skipped",
      reason: "error",
    });
    for (const reason of ["session_not_visible", "no_session_actor"] as const) {
      const skipped = deps(async () => ({ status: "skipped", reason }));
      expect(await runSubscriptionCoreShadow(skipped.deps)).toEqual({
        outcome: "skipped",
        reason,
      });
    }
    const controller = new AbortController();
    const pending = deps(() => new Promise(() => undefined), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    const running = runSubscriptionCoreShadow(pending.deps);
    controller.abort();
    expect(await running).toEqual({ outcome: "skipped", reason: "cancelled" });
    const aborted = new AbortController();
    aborted.abort();
    let loaded = false;
    const early = deps(
      async () => {
        loaded = true;
        return { status: "loaded", ...world() };
      },
      { signal: aborted.signal },
    );
    expect(await runSubscriptionCoreShadow(early.deps)).toEqual({
      outcome: "skipped",
      reason: "cancelled",
    });
    expect(loaded).toBe(false);
  });

  test("SUB-COMPAT-03: the turn never waits for the shadow, and the load is told to stop at the deadline", async () => {
    let seen: { signal?: AbortSignal; deadlineAt?: number; statementTimeoutMs?: number } = {};
    const { deps: input } = deps(
      (request) => {
        seen = request as typeof seen;
        return new Promise(() => undefined);
      },
      { timeoutMs: 20 },
    );
    const startedAt = performance.now();
    const running = startSubscriptionCoreShadow(input);
    // Returned synchronously: placement continues before the load settles.
    expect(performance.now() - startedAt).toBeLessThan(15);
    expect(seen.signal?.aborted).toBe(false);
    expect(seen.statementTimeoutMs).toBe(20);
    expect(seen.deadlineAt).toBeLessThanOrEqual(Date.now() + 20);
    expect(await running).toEqual({ outcome: "skipped", reason: "timeout" });
    expect(seen.signal?.aborted).toBe(true);
  });

  test("SUB-COMPAT-03: an abandoned load keeps its in-flight slot until it settles", async () => {
    let settle: () => void = () => undefined;
    const { deps: input } = deps(
      () =>
        new Promise<LegacyPlacementWorldResult>((_resolve, reject) => {
          settle = () => reject(new Error("statement timeout"));
        }),
      { timeoutMs: 10 },
    );
    const before = subscriptionCoreShadowInFlight();
    expect(await startSubscriptionCoreShadow(input)).toEqual({
      outcome: "skipped",
      reason: "timeout",
    });
    expect(subscriptionCoreShadowInFlight()).toBe(before + 1);
    settle();
    await Bun.sleep(0);
    expect(subscriptionCoreShadowInFlight()).toBe(before);
  });

  test("SUB-COMPAT-03: the background load still runs under the turn's session actor", async () => {
    const seen: (string | null | undefined)[] = [];
    const { deps: input } = deps(async () => {
      await Bun.sleep(1);
      seen.push(currentSessionRlsActorInitiatingHumanSubjectId());
      return { status: "loaded", ...world() };
    });
    const running = withSessionRlsActorContext(
      { subjectId: "service:agent-turn", initiatingHumanSubjectId: "user:owner" },
      async () => startSubscriptionCoreShadow(input),
    );
    expect((await running).outcome).toBe("compared");
    // Outside any actor the shadow's own load sees none (and the real load skips).
    await startSubscriptionCoreShadow(input);
    expect(seen).toEqual(["user:owner", undefined]);
  });

  test("SUB-COMPAT-03: at most the in-flight cap runs at once; the rest are skipped as busy", async () => {
    const releases: (() => void)[] = [];
    const slow = deps(
      () =>
        new Promise<LegacyPlacementWorldResult>((resolve) => {
          releases.push(() => resolve({ status: "loaded", ...world() }));
        }),
      { maxInFlight: subscriptionCoreShadowInFlight() + 2, timeoutMs: 5_000 },
    );
    const before = subscriptionCoreShadowInFlight();
    const first = startSubscriptionCoreShadow(slow.deps);
    const second = startSubscriptionCoreShadow(slow.deps);
    expect(subscriptionCoreShadowInFlight()).toBe(before + 2);
    expect(await startSubscriptionCoreShadow(slow.deps)).toEqual({
      outcome: "skipped",
      reason: "busy",
    });
    for (const release of releases) release();
    expect((await first).outcome).toBe("compared");
    expect((await second).outcome).toBe("compared");
    expect(subscriptionCoreShadowInFlight()).toBe(before);
    expect(releases).toHaveLength(2);
  });

  test("SUB-COMPAT-03: a request that cannot be built is counted, not thrown", async () => {
    const { deps: input, recorder } = deps(async () => ({ status: "loaded", ...world() }), {
      request: () => {
        throw new Error("missing execution policy");
      },
    });
    expect(await startSubscriptionCoreShadow(input)).toEqual({
      outcome: "skipped",
      reason: "error",
    });
    expect(counter(recorder, "opengeni_subscription_core_shadow_skips_total")).toHaveLength(1);
  });

  test("debug events are capped per process across all throttle keys", async () => {
    const cap = createShadowLogRateCap(1);
    const first = deps(async () => ({ status: "loaded", ...world() }), { logRateCap: cap });
    await runSubscriptionCoreShadow(first.deps);
    const other = deps(async () => ({ status: "loaded", ...world() }), {
      logRateCap: cap,
      legacy: { selectedConnectionId: null, reusedLease: false },
    });
    await runSubscriptionCoreShadow(other.deps);
    expect(first.recorder.logs).toHaveLength(1);
    expect(other.recorder.logs).toHaveLength(0);
  });

  test("the debug event is throttled per workspace and outcome", async () => {
    const throttle = createLogThrottle({ intervalMs: 60_000, maxKeys: 16 });
    const first = deps(async () => ({ status: "loaded", ...world() }), { logThrottle: throttle });
    await runSubscriptionCoreShadow(first.deps);
    await runSubscriptionCoreShadow(first.deps);
    expect(first.recorder.logs).toHaveLength(1);
    expect(
      counter(first.recorder, "opengeni_subscription_core_shadow_comparisons_total"),
    ).toHaveLength(2);
  });

  test("every metric label comes from a fixed set", async () => {
    const allowed: Record<string, readonly string[]> = {
      provider: ["codex", "xai", "claude"],
      parity: SUBSCRIPTION_CORE_SHADOW_PARITY,
      placement: SUBSCRIPTION_CORE_SHADOW_PLACEMENTS,
      requirement: SUBSCRIPTION_CORE_SHADOW_REQUIREMENTS,
      input: SUBSCRIPTION_CORE_SHADOW_INPUTS,
      reason: [
        ...SUBSCRIPTION_CORE_SHADOW_SKIPS,
        ...SUBSCRIPTION_CORE_SHADOW_PARITY_REASONS,
        "other",
      ],
    };
    const outsider = connection(LOCAL_B, {
      ownership: { kind: "personal", ownerMembershipId: "membership:other" },
      allowedModelIds: ["other"],
      excludedModelIds: ["codex/model"],
    });
    const { deps: input, recorder } = deps(
      async () => ({
        status: "loaded",
        ...world(
          { connections: [connection(LOCAL_A), outsider] },
          { pin: { connectionId: LOCAL_A, source: "manual" }, truncated: true },
        ),
      }),
      { legacy: { selectedConnectionId: LOCAL_B, reusedLease: true } },
    );
    await runSubscriptionCoreShadow(input);
    expect(recorder.counters.length).toBeGreaterThan(3);
    for (const entry of recorder.counters) {
      for (const [label, value] of Object.entries(entry.labels)) {
        expect(allowed[label]).toContain(value);
      }
    }
  });

  test("the requirement label set covers every requirement the reference checker reports", () => {
    const entry = Bun.resolveSync("@opengeni/subscriptions/reference", import.meta.dir);
    const source = readFileSync(join(dirname(entry), "reference-model.ts"), "utf8");
    const reported = new Set(source.match(/"SUB-[A-Z]+-\d{2}"/g)!.map((id) => id.slice(1, -1)));
    expect(reported.size).toBeGreaterThan(5);
    for (const requirement of reported) {
      expect(SUBSCRIPTION_CORE_SHADOW_REQUIREMENTS).toContain(requirement as never);
    }
  });
});
