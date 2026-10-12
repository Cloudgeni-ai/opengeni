import { describe, expect, test } from "bun:test";
import { decide } from "@opengeni/testing/subscription-reference-model";
import {
  generateReferenceWorld,
  REFERENCE_NOW,
  referenceRandom,
  type ReferenceRandom,
} from "@opengeni/testing/subscription-reference-worlds";
import {
  decidePlacement,
  type PlacementInput,
  type ProviderSwitches,
  type RotationSetting,
  type SubscriptionConnection,
  type SubscriptionQuota,
} from "../src/index";
import { checkPlacementDecision, toReferenceDecision, toReferenceWorld } from "../src/reference";
import { toPlacementInput } from "./reference-mapping";

const NOW = REFERENCE_NOW;
const MODELS = [
  { id: "codex/a", provider: "codex", reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "codex/b", provider: "codex", reasoningLevels: ["low", "high"] },
  { id: "claude/a", provider: "claude", reasoningLevels: ["low", "medium", "high", "max"] },
  { id: "xai/a", provider: "xai", reasoningLevels: ["low", "high"] },
] as const;
const MODEL_IDS = MODELS.map((model) => model.id);
const PROVIDERS = ["codex", "claude", "xai"];
const PEOPLE = ["member-a", "member-b"];

function randomQuota(rng: ReferenceRandom, provider: string): SubscriptionQuota | null {
  const own = MODEL_IDS.filter((modelId) => modelId.startsWith(provider + "/"));
  const cooldowns = rng.bool(0.25) ? { [rng.pick(own)]: rng.pick([NOW - 1, NOW + 20_000]) } : {};
  const shape = rng.pick([
    "none",
    "ok",
    "warning",
    "unknown",
    "exhausted_window",
    "exhausted_unknown_reset",
    "deadline",
    "passed_quota",
    "passed_rate_limit",
  ] as const);
  if (shape === "none" && Object.keys(cooldowns).length === 0) return null;
  const window = (status: "ok" | "warning" | "exhausted" | "unknown", resetsAt: number | null) => ({
    id: "primary",
    usedPercent: status === "exhausted" ? 100 : status === "unknown" ? null : 50,
    resetsAt,
    status,
  });
  return {
    windows:
      shape === "ok"
        ? [window("ok", NOW + 3_600_000)]
        : shape === "warning"
          ? [window("warning", NOW + 3_600_000)]
          : shape === "unknown"
            ? [window("unknown", null)]
            : shape === "exhausted_window"
              ? [window("exhausted", rng.pick([NOW + 40_000, NOW - 5]))]
              : shape === "exhausted_unknown_reset"
                ? [window("exhausted", null)]
                : [],
    modelCooldowns: cooldowns,
    exhaustedUntil:
      shape === "deadline"
        ? NOW + 70_000
        : shape === "passed_quota" || shape === "passed_rate_limit"
          ? NOW - 10
          : null,
    exhaustedKind:
      shape === "deadline" || shape === "passed_quota"
        ? "quota"
        : shape === "passed_rate_limit"
          ? "rate_limit"
          : null,
    revision: 1,
    observedAt: rng.pick([NOW - 1_000, NOW - 1_000, NOW - 10 * 3_600_000, null]),
    observedRefreshGeneration: 1,
    source: "usage_endpoint",
  };
}

/** A production placement input using features the reference model does not have. */
function randomProductionInput(seed: number): PlacementInput {
  const rng = referenceRandom(seed);
  const workspace = rng.pick([
    { id: "ws-team", kind: "shared" as const, ownerMembershipId: null },
    { id: "ws-personal-a", kind: "personal" as const, ownerMembershipId: "member-a" },
  ]);
  const connections: SubscriptionConnection[] = [];
  const count = Math.floor(rng.next() * 7);
  for (let index = 0; index < count; index += 1) {
    const provider = rng.pick(PROVIDERS);
    const own = MODEL_IDS.filter((modelId) => modelId.startsWith(provider + "/"));
    const kind = rng.pick(["org", "workspaces", "people", "personal"] as const);
    connections.push({
      id: "conn-" + index,
      provider,
      kind: rng.bool(0.9) ? "subscription" : "api_key",
      ownership:
        kind === "personal"
          ? { kind: "personal", ownerMembershipId: rng.pick(PEOPLE) }
          : {
              kind: "shared",
              managedByWorkspaceId: rng.bool(0.4) ? workspace.id : null,
              scope:
                kind === "org"
                  ? { kind: "organization" }
                  : kind === "workspaces"
                    ? {
                        kind: "workspaces",
                        workspaceIds: rng.subset(["ws-team", "ws-other"]),
                        allowPersonalWorkspaces: rng.bool(),
                      }
                    : { kind: "people", membershipIds: rng.subset(PEOPLE) },
            },
      health: rng.pick(["healthy", "healthy", "healthy", "needs_reconnect", "error"] as const),
      allocatorEnabled: rng.bool(0.85),
      entitledModelIds: rng.bool(0.6) ? null : rng.subset(own),
      excludedModelIds: rng.bool(0.85) ? [] : rng.subset(own),
      allowedModelIds: rng.bool(0.85) ? null : rng.subset(own),
      refreshGeneration: 1,
      extraCreditsEnabled: rng.bool(),
      quota: randomQuota(rng, provider),
    });
  }
  const preferredModelId = rng.pick(MODEL_IDS);
  const preferredProvider = preferredModelId.split("/")[0]!;
  const sameProvider = connections.filter(
    (connection) => connection.provider === preferredProvider,
  );
  // Bind mostly to an account of the preferred model's provider, so explicit
  // choices and warm bindings are often servable.
  const bound =
    connections.length && rng.bool(0.6)
      ? sameProvider.length && rng.bool(0.75)
        ? rng.pick(sameProvider)
        : rng.pick(connections)
      : null;
  const fallbackOrder: Record<string, string[]> = {};
  for (const modelId of MODEL_IDS) fallbackOrder[modelId] = rng.subset(MODEL_IDS);
  const rotation: Record<string, RotationSetting> = {};
  for (const provider of PROVIDERS) {
    const own = connections.filter((connection) => connection.provider === provider);
    if (rng.bool(0.7))
      rotation[provider] = rng.bool()
        ? { mode: "spread" }
        : { mode: "primary_first", primaryConnectionId: own.length ? rng.pick(own).id : null };
  }
  const providers: Record<string, ProviderSwitches> = {};
  for (const provider of PROVIDERS) {
    if (rng.bool(0.3))
      providers[provider] = { useOrganizationAccounts: rng.bool(0.6), enabled: rng.bool(0.8) };
  }
  const owner = workspace.kind === "personal" ? "member-a" : rng.pick(PEOPLE);
  return {
    now: NOW + rng.pick([0, 25_000, 80_000]),
    workspace: {
      ...workspace,
      allowedModelIds: rng.bool(0.8) ? null : rng.subset(MODEL_IDS),
    },
    session: {
      id: "session-" + seed,
      workspaceId: workspace.id,
      visibility: workspace.kind === "personal" || rng.bool() ? "private" : "shared",
      ownerMembershipId: owner,
      preferredModelId,
      reasoningLevel: rng.pick(["low", "medium", "high", "xhigh", "max"]),
      binding: bound
        ? {
            connectionId: bound.id,
            provider: bound.provider,
            modelId: rng.bool(0.8)
              ? (MODEL_IDS.find((modelId) => modelId.startsWith(bound.provider + "/")) ??
                preferredModelId)
              : rng.pick(MODEL_IDS),
            choice: rng.bool(0.25) ? "explicit" : "automatic",
            lastModelCallAt: NOW - rng.pick([5_000, 200_000, 2_000_000, 5_000_000]),
            ...(rng.bool(0.3) ? { cacheTtlMs: rng.pick([300_000, 3_600_000]) } : {}),
          }
        : null,
      onlyThisModel: rng.bool(0.2),
      reselectionPoints: rng.bool(0.15)
        ? [rng.pick(["compaction_completed", "model_changed"] as const)]
        : [],
      personalAuthority: PROVIDERS.filter(() => rng.bool(0.6)).map((provider) => ({
        provider,
        ownerMembershipId: rng.bool(0.85) ? owner : rng.pick(PEOPLE),
      })),
      compactionProviderLock: rng.bool(0.15) ? "codex" : null,
    },
    settings: {
      rotation,
      providers,
      crossProviderFailover: rng.bool(),
      fallbackOrder,
      personalConnectionsAllowed: rng.bool(0.8),
      personalFallbackAllowed: rng.bool(),
    },
    people: PEOPLE.map((membershipId) => ({
      membershipId,
      active: rng.bool(0.9),
      personalFallbackOptIn: rng.bool(),
    })),
    models: MODELS,
    connections,
    cacheFacts: {
      codex: { kind: "measured_idle_cutoff", cutoffMs: rng.bool() ? null : 300_000 },
      claude: { kind: "exact_ttl", ttlMs: 300_000 },
      xai: { kind: "measured_idle_cutoff", cutoffMs: null },
    },
    ...(rng.bool(0.3)
      ? {
          quotaStaleAfterMs: Object.fromEntries(
            PROVIDERS.filter(() => rng.bool()).map((provider) => [provider, 3_600_000]),
          ),
        }
      : {}),
  };
}

describe("reference bridge", () => {
  test("bridging a generated reference world back reproduces the reference decision (SUB-SET-03, SUB-ELIG-01, SUB-STICK-02)", () => {
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const { world, sessionId } = generateReferenceWorld(seed);
      const input = toPlacementInput(world, sessionId, NOW);
      const bridged = toReferenceWorld(input);
      expect(decide(bridged.world, bridged.sessionId, NOW)).toEqual(decide(world, sessionId, NOW));
    }
  });

  test("production-only features agree with the reference model through the bridge across 6000 generated inputs (SUB-SET-06, SUB-ELIG-03, SUB-ELIG-05, SUB-ELIG-06, SUB-FAIL-09, SUB-SEL-04, SUB-WAIT-01, SUB-WAIT-02)", () => {
    const findings: unknown[] = [];
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 6_000; seed += 1) {
      const input = randomProductionInput(seed);
      const decision = decidePlacement(input);
      outcomes.add(
        decision.kind === "run" ? decision.switch : decision.kind + ":" + decision.reason,
      );
      const violations = checkPlacementDecision(input, decision);
      const { world, sessionId } = toReferenceWorld(input);
      const expected = decide(world, sessionId, input.now);
      const actual = toReferenceDecision(decision, input);
      if (violations.length > 0 || !Bun.deepEquals(actual, expected)) {
        findings.push({ seed, violations, production: actual, reference: expected });
      }
      // A compaction-lock wait is independently justified: without the lock
      // the session would run on another provider's model now, or it would
      // have an allowed candidate model at all.
      if (decision.kind === "wait" && decision.reason === "compaction_provider_locked") {
        const lock = input.session.compactionProviderLock!;
        const unlocked = toReferenceWorld({
          ...input,
          session: { ...input.session, compactionProviderLock: null },
        });
        const free = decide(unlocked.world, unlocked.sessionId, input.now);
        const ranElsewhere = free.kind === "run" && !free.modelId.startsWith(lock + "/");
        const restrictionLifted =
          expected.kind === "wait" &&
          expected.reason === "model_not_allowed" &&
          !(free.kind === "wait" && free.reason === "model_not_allowed");
        if (!ranElsewhere && !restrictionLifted) findings.push({ seed, unjustifiedLock: free });
      }
    }
    expect(findings.slice(0, 5)).toEqual([]);
    for (const outcome of [
      "initial",
      "sticky",
      "pinned",
      "failover_same_provider",
      "failover_cross_provider",
      "reselected_cold",
      "return_to_preferred",
      "wait:no_eligible_capacity",
      "wait:pinned_account_unavailable",
      "wait:pinned_account_ineligible",
      "wait:model_not_allowed",
      "wait:compaction_provider_locked",
    ]) {
      expect(outcomes.has(outcome)).toBe(true);
    }
  });

  test("the checker catches a production decision that ignores frozen personal authority (SUB-ELIG-05)", () => {
    const base = randomProductionInput(1);
    const input: PlacementInput = {
      ...base,
      workspace: { id: "ws-team", kind: "shared", ownerMembershipId: null, allowedModelIds: null },
      session: {
        ...base.session,
        workspaceId: "ws-team",
        visibility: "private",
        ownerMembershipId: "member-a",
        preferredModelId: "codex/a",
        binding: null,
        onlyThisModel: false,
        reselectionPoints: [],
        personalAuthority: [],
        compactionProviderLock: null,
      },
      settings: {
        rotation: {},
        providers: {},
        crossProviderFailover: false,
        fallbackOrder: {},
        personalConnectionsAllowed: true,
        personalFallbackAllowed: true,
      },
      people: [{ membershipId: "member-a", active: true, personalFallbackOptIn: true }],
      connections: [
        {
          id: "mine",
          provider: "codex",
          kind: "subscription",
          ownership: { kind: "personal", ownerMembershipId: "member-a" },
          health: "healthy",
          allocatorEnabled: true,
          entitledModelIds: null,
          excludedModelIds: [],
          allowedModelIds: null,
          refreshGeneration: 1,
          quota: null,
        },
      ],
    };
    expect(decidePlacement(input)).toMatchObject({ kind: "wait", reason: "no_eligible_capacity" });
    const ranAnyway = {
      kind: "run" as const,
      connectionId: "mine",
      provider: "codex",
      modelId: "codex/a",
      reasoningLevel: "high",
      switch: "initial" as const,
      personal: true,
    };
    expect(
      checkPlacementDecision(input, ranAnyway).map((violation) => violation.requirement),
    ).toContain("SUB-ELIG-01");
  });

  test("source assignment eligibility agrees for placement, pin classification, and reset reporting", () => {
    const base = randomProductionInput(7331);
    const makeInput = (
      assignmentPolicies: NonNullable<SubscriptionConnection["assignmentPolicies"]>,
      options: { pinned?: boolean; exhausted?: boolean } = {},
    ): PlacementInput => ({
      ...base,
      now: NOW,
      workspace: { id: "ws-team", kind: "shared", ownerMembershipId: null, allowedModelIds: null },
      session: {
        ...base.session,
        id: "assignment-policy-session",
        workspaceId: "ws-team",
        visibility: "shared",
        ownerMembershipId: "member-a",
        preferredModelId: "codex/b",
        binding: options.pinned
          ? {
              connectionId: "codex-assignment",
              provider: "codex",
              modelId: "codex/b",
              choice: "explicit",
              lastModelCallAt: NOW,
            }
          : null,
        onlyThisModel: options.pinned ?? false,
        reselectionPoints: [],
        personalAuthority: [],
        compactionProviderLock: null,
      },
      settings: {
        rotation: {},
        providers: {
          codex: { inferenceSource: "automatic", useOrganizationAccounts: true, enabled: true },
        },
        crossProviderFailover: false,
        fallbackOrder: {},
        personalConnectionsAllowed: true,
        personalFallbackAllowed: false,
      },
      people: [{ membershipId: "member-a", active: true, personalFallbackOptIn: false }],
      connections: [
        {
          id: "codex-assignment",
          provider: "codex",
          kind: "subscription",
          ownership: {
            kind: "shared",
            managedByWorkspaceId: null,
            scope: { kind: "organization" },
          },
          health: "healthy",
          allocatorEnabled: true,
          entitledModelIds: null,
          excludedModelIds: [],
          allowedModelIds: null,
          assignmentPolicies,
          refreshGeneration: 1,
          quota: options.exhausted
            ? {
                windows: [
                  {
                    id: "primary",
                    usedPercent: 100,
                    resetsAt: NOW + 60_000,
                    status: "exhausted",
                  },
                ],
                modelCooldowns: {},
                exhaustedUntil: null,
                exhaustedKind: null,
                revision: 1,
                observedAt: NOW - 1_000,
                observedRefreshGeneration: 1,
                source: "usage_endpoint",
              }
            : null,
        },
      ],
    });
    const compareWithReference = (input: PlacementInput) => {
      const decision = decidePlacement(input);
      const { world, sessionId } = toReferenceWorld(input);
      expect(toReferenceDecision(decision, input)).toEqual(decide(world, sessionId, NOW));
      expect(checkPlacementDecision(input, decision)).toEqual([]);
      return decision;
    };

    const mixedAssignment = makeInput([
      {
        workspaceId: "ws-team",
        inferencePool: "workspace",
        allowedModelIds: ["codex/a"],
        allocatorEnabled: true,
      },
      {
        workspaceId: "ws-team",
        inferencePool: "organization",
        allowedModelIds: ["codex/b"],
        allocatorEnabled: false,
      },
    ]);
    expect(compareWithReference(mixedAssignment)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
    });

    const modelExcludedPin = makeInput(
      [
        {
          workspaceId: "ws-team",
          inferencePool: "workspace",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: false,
        },
        {
          workspaceId: "ws-team",
          inferencePool: "organization",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: false,
        },
      ],
      { pinned: true },
    );
    expect(compareWithReference(modelExcludedPin)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_ineligible",
    });

    const recoverablyDisabledPin = makeInput(
      [
        {
          workspaceId: "ws-team",
          inferencePool: "workspace",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: true,
        },
        {
          workspaceId: "ws-team",
          inferencePool: "organization",
          allowedModelIds: ["codex/b"],
          allocatorEnabled: false,
        },
      ],
      { pinned: true },
    );
    expect(compareWithReference(recoverablyDisabledPin)).toMatchObject({
      kind: "wait",
      reason: "pinned_account_unavailable",
    });

    const permanentlyExcluded = makeInput(
      [
        {
          workspaceId: "ws-team",
          inferencePool: "workspace",
          allowedModelIds: ["codex/a"],
          allocatorEnabled: true,
        },
      ],
      { exhausted: true },
    );
    expect(compareWithReference(permanentlyExcluded)).toMatchObject({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: null,
    });
  });
});
