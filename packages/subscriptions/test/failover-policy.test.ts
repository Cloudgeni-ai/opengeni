import { describe, expect, test } from "bun:test";
import {
  decidePlacement,
  derivedFallbackOrder,
  effectiveSettings,
  failoverCandidateModels,
  fallbackOrderFor,
  hasFallbackOrderEntry,
  isModelTier,
  MODEL_TIERS,
  type ModelDescriptor,
  type ModelTier,
  type PlacementDecision,
  type PlacementInput,
  type SubscriptionConnection,
  type SubscriptionCoreAdapter,
  type SubscriptionQuota,
  type SubscriptionSettingValues,
} from "../src/index";
import { checkPlacementDecision, toReferenceDecision, toReferenceWorld } from "../src/reference";
import { decide as decideReference } from "../src/reference-model";

// The derived same-tier fallback order and its explicit-entry rule (D-35),
// pure and without network. Provider ids are opaque test keys.

const NOW = 20_000_000;

/**
 * Declaration order is deliberately not provider-id order (gamma before
 * beta), and each provider mixes tiers, so the derived order's provider
 * sort, declaration order and tier filter are each observable.
 */
const MODELS: readonly ModelDescriptor[] = [
  {
    id: "alpha/top",
    provider: "alpha",
    reasoningLevels: ["low", "medium", "high", "xhigh"],
    tier: "frontier",
  },
  { id: "alpha/mid", provider: "alpha", reasoningLevels: ["low", "high"], tier: "standard" },
  { id: "alpha/top-2", provider: "alpha", reasoningLevels: ["low", "high"], tier: "frontier" },
  { id: "alpha/plain", provider: "alpha", reasoningLevels: ["low", "high"] },
  {
    id: "gamma/top",
    provider: "gamma",
    reasoningLevels: ["low", "medium", "high"],
    tier: "frontier",
  },
  { id: "beta/plain", provider: "beta", reasoningLevels: ["low", "high"], tier: null },
  { id: "beta/top", provider: "beta", reasoningLevels: ["low", "high"], tier: "frontier" },
  { id: "beta/mid", provider: "beta", reasoningLevels: ["low", "high"], tier: "standard" },
  { id: "beta/top-2", provider: "beta", reasoningLevels: ["minimal", "max"], tier: "frontier" },
  { id: "gamma/fast", provider: "gamma", reasoningLevels: ["low"], tier: "fast" },
];

function quota(patch: Partial<SubscriptionQuota> = {}): SubscriptionQuota {
  return {
    windows: [{ id: "primary", usedPercent: 20, resetsAt: NOW + 3_600_000, status: "ok" }],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 1,
    observedAt: NOW - 1_000,
    observedRefreshGeneration: 1,
    source: "usage_endpoint",
    ...patch,
  };
}

const exhaustedUntil = (at: number): SubscriptionQuota =>
  quota({
    windows: [{ id: "primary", usedPercent: 100, resetsAt: at, status: "exhausted" }],
    exhaustedUntil: at,
    exhaustedKind: "quota",
  });

function connection(
  id: string,
  provider: string,
  patch: Partial<SubscriptionConnection> = {},
): SubscriptionConnection {
  return {
    id,
    provider,
    kind: "subscription",
    ownership: { kind: "shared", scope: { kind: "organization" }, managedByWorkspaceId: null },
    health: "healthy",
    allocatorEnabled: true,
    entitledModelIds: null,
    excludedModelIds: [],
    allowedModelIds: null,
    refreshGeneration: 1,
    quota: quota(),
    ...patch,
  };
}

const SETTINGS: SubscriptionSettingValues = {
  rotation: {},
  providers: {},
  crossProviderFailover: true,
  fallbackOrder: {},
  personalConnectionsAllowed: true,
  personalFallbackAllowed: true,
};

function input(
  patch: {
    settings?: Partial<SubscriptionSettingValues>;
    session?: Partial<PlacementInput["session"]>;
    workspace?: Partial<PlacementInput["workspace"]>;
    models?: readonly ModelDescriptor[];
    connections?: SubscriptionConnection[];
    personalFallbackOptIn?: boolean;
  } = {},
): PlacementInput {
  return {
    now: NOW,
    workspace: {
      id: "ws-team",
      kind: "shared",
      ownerMembershipId: null,
      allowedModelIds: null,
      ...patch.workspace,
    },
    session: {
      id: "session-1",
      workspaceId: "ws-team",
      visibility: "shared",
      ownerMembershipId: "member-a",
      preferredModelId: "alpha/top",
      reasoningLevel: "xhigh",
      binding: null,
      onlyThisModel: false,
      reselectionPoints: [],
      personalAuthority: [],
      compactionProviderLock: null,
      ...patch.session,
    },
    settings: { ...SETTINGS, ...patch.settings },
    people: [
      {
        membershipId: "member-a",
        active: true,
        personalFallbackOptIn: patch.personalFallbackOptIn ?? false,
      },
    ],
    models: patch.models ?? MODELS,
    connections: patch.connections ?? [
      connection("alpha-1", "alpha", { quota: exhaustedUntil(NOW + 600_000) }),
      connection("beta-1", "beta"),
      connection("gamma-1", "gamma"),
    ],
    cacheFacts: {
      alpha: { kind: "exact_ttl", ttlMs: 300_000 },
      beta: { kind: "exact_ttl", ttlMs: 300_000 },
      gamma: { kind: "measured_idle_cutoff", cutoffMs: 300_000 },
    },
  };
}

/** The production decision, also judged by the independent reference model. */
function decideChecked(placement: PlacementInput): PlacementDecision {
  const decision = decidePlacement(placement);
  expect(checkPlacementDecision(placement, decision)).toEqual([]);
  const { world, sessionId } = toReferenceWorld(placement);
  expect(toReferenceDecision(decision, placement)).toEqual(
    decideReference(world, sessionId, placement.now),
  );
  return decision;
}

/** The session was running on the preferred model's (now exhausted) account. */
const ON_PREFERRED: Partial<PlacementInput["session"]> = {
  binding: {
    connectionId: "alpha-1",
    provider: "alpha",
    modelId: "alpha/top",
    choice: "automatic",
    lastModelCallAt: NOW - 1_000,
  },
};

describe("hasFallbackOrderEntry", () => {
  test("SUB-FAIL-03: a missing entry is told apart from an explicit empty one (D-35)", () => {
    const settings: SubscriptionSettingValues = {
      ...SETTINGS,
      fallbackOrder: { "alpha/top": [], "alpha/mid": ["beta/mid"] },
    };
    expect(hasFallbackOrderEntry(settings, "alpha/top")).toBe(true);
    expect(hasFallbackOrderEntry(settings, "alpha/mid")).toBe(true);
    expect(hasFallbackOrderEntry(settings, "alpha/plain")).toBe(false);
    // fallbackOrderFor reads both the same; only the entry check differs.
    expect(fallbackOrderFor(settings, "alpha/top")).toEqual([]);
    expect(fallbackOrderFor(settings, "alpha/plain")).toEqual([]);
    expect(fallbackOrderFor(settings, "alpha/mid")).toEqual(["beta/mid"]);
  });

  test("SUB-FAIL-04: an inherited object property is never a fallback entry", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(hasFallbackOrderEntry(SETTINGS, key)).toBe(false);
      expect(fallbackOrderFor(SETTINGS, key)).toEqual([]);
      expect(failoverCandidateModels(input({ session: { preferredModelId: key } }))).toEqual([key]);
    }
  });

  test("SUB-FAIL-03: a workspace inherits the organization's explicit empty entry entry by entry (D-25, D-35)", () => {
    const effective = effectiveSettings(
      {
        organization: { ...SETTINGS, fallbackOrder: { "alpha/top": [] } },
        locked: [],
        workspaces: { "ws-team": { fallbackOrder: { "alpha/mid": ["beta/mid"] } } },
      },
      "ws-team",
    ).values;
    expect(hasFallbackOrderEntry(effective, "alpha/top")).toBe(true);
    expect(failoverCandidateModels(input({ settings: effective }))).toEqual(["alpha/top"]);
  });
});

describe("the explicit entry wins", () => {
  test("SUB-FAIL-03: an explicit entry is the order and nothing is derived beside it (D-35)", () => {
    const placement = input({
      session: ON_PREFERRED,
      settings: { fallbackOrder: { "alpha/top": ["gamma/top"] } },
    });
    expect(failoverCandidateModels(placement)).toEqual(["alpha/top", "gamma/top"]);
    expect(decideChecked(placement)).toMatchObject({
      kind: "run",
      connectionId: "gamma-1",
      modelId: "gamma/top",
      switch: "failover_cross_provider",
    });
  });

  test("SUB-FAIL-03: an explicit empty list derives nothing, and the work waits (D-35)", () => {
    const placement = input({ settings: { fallbackOrder: { "alpha/top": [] } } });
    expect(failoverCandidateModels(placement)).toEqual(["alpha/top"]);
    expect(decideChecked(placement)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: NOW + 600_000,
    });
  });

  test("SUB-FAIL-04: an explicit entry of unknown models is still explicit and derives nothing (D-34, D-35)", () => {
    const placement = input({ settings: { fallbackOrder: { "alpha/top": ["omega/unknown"] } } });
    expect(failoverCandidateModels(placement)).toEqual(["alpha/top"]);
  });

  test("SUB-FAIL-02: an explicit same-provider entry still applies without cross-provider failover", () => {
    const placement = input({
      settings: { crossProviderFailover: false, fallbackOrder: { "alpha/top": ["alpha/mid"] } },
    });
    expect(failoverCandidateModels(placement)).toEqual(["alpha/top", "alpha/mid"]);
  });
});

describe("the derived same-tier order", () => {
  test("SUB-FAIL-03: other providers' models of the same tier, providers in id order, models in declaration order (D-35)", () => {
    const placement = input();
    expect(derivedFallbackOrder(placement)).toEqual(["beta/top", "beta/top-2", "gamma/top"]);
    expect(failoverCandidateModels(placement)).toEqual([
      "alpha/top",
      "beta/top",
      "beta/top-2",
      "gamma/top",
    ]);
  });

  test("SUB-FAIL-04: never a higher or lower tier, never the preferred provider's own models, never an untiered model (D-35, Q-04)", () => {
    const derivedFor = (preferredModelId: string) =>
      derivedFallbackOrder(input({ session: { preferredModelId } }));
    expect(derivedFor("alpha/top")).not.toContain("alpha/top-2");
    expect(derivedFor("alpha/top")).not.toContain("beta/mid");
    expect(derivedFor("alpha/top")).not.toContain("gamma/fast");
    expect(derivedFor("alpha/mid")).toEqual(["beta/mid"]);
    expect(derivedFor("gamma/fast")).toEqual([]);
    expect(derivedFor("beta/top")).toEqual(["alpha/top", "alpha/top-2", "gamma/top"]);
    for (const preferredModelId of ["alpha/top", "alpha/mid", "beta/top", "gamma/top"]) {
      expect(derivedFor(preferredModelId)).not.toContain("beta/plain");
      expect(derivedFor(preferredModelId)).not.toContain("alpha/plain");
    }
  });

  test("SUB-FAIL-04: a preferred model without a declared tier, or an unknown one, derives nothing (D-35)", () => {
    for (const preferredModelId of ["alpha/plain", "beta/plain", "omega/unknown"]) {
      const placement = input({ session: { preferredModelId } });
      expect(derivedFallbackOrder(placement)).toEqual([]);
      expect(failoverCandidateModels(placement)).toEqual([preferredModelId]);
    }
    // An undeclared tier value never matches, even another one like it.
    const bogus = MODELS.map((model) =>
      model.id === "alpha/top" || model.id === "beta/top"
        ? { ...model, tier: "ultra" as unknown as ModelTier }
        : model,
    );
    expect(derivedFallbackOrder(input({ models: bogus }))).toEqual([]);
  });

  test("SUB-FAIL-03, SUB-FAIL-05: nothing is derived with cross-provider failover off, for 'only this model' or for an explicit binding (D-35, D-46)", () => {
    const off = input({ settings: { crossProviderFailover: false } });
    expect(derivedFallbackOrder(off)).toEqual([]);
    expect(failoverCandidateModels(off)).toEqual(["alpha/top"]);
    expect(decideChecked(off)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });

    const onlyThisModel = input({ session: { onlyThisModel: true } });
    expect(failoverCandidateModels(onlyThisModel)).toEqual(["alpha/top"]);
    expect(decideChecked(onlyThisModel)).toMatchObject({ kind: "wait" });

    const pinned = input({
      session: {
        binding: {
          connectionId: "alpha-1",
          provider: "alpha",
          modelId: "alpha/top",
          choice: "explicit",
          lastModelCallAt: NOW - 1_000,
        },
      },
    });
    expect(failoverCandidateModels(pinned)).toEqual(["alpha/top"]);
    expect(decideChecked(pinned)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: NOW + 600_000,
    });
  });

  test("SUB-FAIL-03: the derived order holds at most the fallback limit of models (D-35)", () => {
    const many: ModelDescriptor[] = [
      MODELS[0]!,
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `p${String(index).padStart(2, "0")}/top`,
        provider: `p${String(index).padStart(2, "0")}`,
        reasoningLevels: ["low"],
        tier: "frontier" as const,
      })).reverse(),
    ];
    expect(derivedFallbackOrder(input({ models: many }))).toEqual(
      Array.from({ length: 8 }, (_, index) => `p0${index}/top`),
    );
  });

  test("SUB-FAIL-03: models without any tier declaration keep today's single-model order", () => {
    const untiered = MODELS.map(({ tier: _tier, ...model }) => model);
    const placement = input({ models: untiered });
    expect(failoverCandidateModels(placement)).toEqual(["alpha/top"]);
    expect(decideChecked(placement)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });
  });
});

describe("placement over the derived order", () => {
  test("SUB-FAIL-03: work fails over to the first derived model at the D-16 reasoning level", () => {
    expect(decideChecked(input({ session: ON_PREFERRED }))).toEqual({
      kind: "run",
      connectionId: "beta-1",
      provider: "beta",
      modelId: "beta/top",
      reasoningLevel: "high",
      switch: "failover_cross_provider",
      personal: false,
    });
    // "medium" sits at one third of the preferred ladder: the nearest of
    // two target levels is the lower one.
    expect(decideChecked(input({ session: { reasoningLevel: "medium" } }))).toMatchObject({
      modelId: "beta/top",
      reasoningLevel: "low",
    });
    // No shared level name: the relative position maps (xhigh is the top).
    const placement = input({
      connections: [
        connection("alpha-1", "alpha", { quota: exhaustedUntil(NOW + 600_000) }),
        connection("beta-1", "beta", { entitledModelIds: ["beta/top-2"] }),
      ],
    });
    expect(decideChecked(placement)).toMatchObject({
      modelId: "beta/top-2",
      reasoningLevel: "max",
    });
  });

  test("SUB-FAIL-04: restrictions and provider switches filter derived candidates (D-17, D-26)", () => {
    expect(
      decideChecked(
        input({ workspace: { allowedModelIds: ["alpha/top", "beta/top-2", "gamma/top"] } }),
      ),
    ).toMatchObject({ modelId: "beta/top-2", connectionId: "beta-1" });
    expect(
      decideChecked(
        input({
          settings: {
            providers: { beta: { useOrganizationAccounts: true, enabled: false } },
          },
        }),
      ),
    ).toMatchObject({ modelId: "gamma/top", connectionId: "gamma-1" });
  });

  test("SUB-FAIL-04: a compaction lock keeps derived models of other providers away", () => {
    expect(decidePlacement(input({ session: { compactionProviderLock: "alpha" } }))).toEqual({
      kind: "wait",
      reason: "compaction_provider_locked",
      earliestResetAt: NOW + 600_000,
    });
  });

  test("SUB-FAIL-03: the same model on an opted-in personal account still comes before a derived model (D-12, D-42)", () => {
    const decision = decideChecked(
      input({
        personalFallbackOptIn: true,
        session: {
          visibility: "private",
          personalAuthority: [{ provider: "alpha", ownerMembershipId: "member-a" }],
        },
        connections: [
          connection("alpha-1", "alpha", { quota: exhaustedUntil(NOW + 600_000) }),
          connection("alpha-personal", "alpha", {
            ownership: { kind: "personal", ownerMembershipId: "member-a" },
          }),
          connection("beta-1", "beta"),
        ],
      }),
    );
    expect(decision).toMatchObject({
      kind: "run",
      connectionId: "alpha-personal",
      modelId: "alpha/top",
      personal: true,
    });
  });

  test("SUB-WAIT-01: the wait names the earliest reset across derived candidates (D-22)", () => {
    expect(
      decideChecked(
        input({
          connections: [
            connection("alpha-1", "alpha", { quota: exhaustedUntil(NOW + 600_000) }),
            connection("beta-1", "beta", { quota: exhaustedUntil(NOW + 120_000) }),
            connection("gamma-1", "gamma", { quota: exhaustedUntil(NOW + 900_000) }),
          ],
        }),
      ),
    ).toEqual({ kind: "wait", reason: "no_eligible_capacity", earliestResetAt: NOW + 120_000 });
  });

  test("SUB-FAIL-07: a warm session on a derived fallback stays there", () => {
    const placement = input({
      session: {
        binding: {
          connectionId: "beta-1",
          provider: "beta",
          modelId: "beta/top",
          choice: "automatic",
          lastModelCallAt: NOW - 10_000,
        },
      },
      connections: [connection("alpha-1", "alpha"), connection("beta-1", "beta")],
    });
    expect(decideChecked(placement)).toMatchObject({
      connectionId: "beta-1",
      modelId: "beta/top",
      switch: "sticky",
    });
  });
});

describe("the reference checker catches a wrong derived order", () => {
  const wrong = (modelId: string, connectionId: string, reasoningLevel = "high") =>
    ({
      kind: "run",
      connectionId,
      provider: connectionId.split("-")[0]!,
      modelId,
      reasoningLevel,
      switch: "failover_cross_provider",
      personal: false,
    }) satisfies PlacementDecision;

  test("SUB-FAIL-04: running a model of another tier is outside the candidates", () => {
    const placement = input();
    expect(
      checkPlacementDecision(placement, wrong("beta/mid", "beta-1")).map(
        (violation) => violation.requirement,
      ),
    ).toContain("SUB-FAIL-04");
  });

  test("SUB-FAIL-02: skipping the first derived candidate that can run is refused", () => {
    const placement = input();
    expect(
      checkPlacementDecision(placement, wrong("gamma/top", "gamma-1")).map(
        (violation) => violation.requirement,
      ),
    ).toContain("SUB-FAIL-02");
  });

  test("SUB-FAIL-04: a derived model with an explicit empty entry is outside the candidates", () => {
    const placement = input({ settings: { fallbackOrder: { "alpha/top": [] } } });
    expect(
      checkPlacementDecision(placement, wrong("beta/top", "beta-1")).map(
        (violation) => violation.requirement,
      ),
    ).toContain("SUB-FAIL-04");
  });
});

describe("the adapter capability", () => {
  test("SUB-PROV-02: the tier is an optional adapter member and a closed provider-neutral set", () => {
    const declare = (adapter: Pick<SubscriptionCoreAdapter, "modelTier">, modelId: string) =>
      adapter.modelTier?.(modelId) ?? null;
    expect(declare({}, "alpha/top")).toBeNull();
    expect(
      declare({ modelTier: (modelId) => (modelId === "alpha/top" ? "frontier" : null) }, "x"),
    ).toBeNull();
    expect(MODEL_TIERS).toEqual(["frontier", "standard", "fast"]);
    for (const tier of MODEL_TIERS) expect(isModelTier(tier)).toBe(true);
    for (const value of [null, undefined, "", "Frontier", "ultra", 1]) {
      expect(isModelTier(value)).toBe(false);
    }
  });
});
