import { describe, expect, test } from "bun:test";
import {
  applyDecision,
  canServe,
  checkDecision,
  decide,
  effectiveSettings,
  nearestReasoningLevel,
  type Connection,
  type Decision,
  type InvariantViolation,
  type Session,
  type SubscriptionSettings,
  type World,
} from "../src/subscription-reference-model";

// Deterministic PRNG (mulberry32) so every generated world is reproducible by seed.
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    bool: (probability = 0.5) => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    subset: <T>(items: readonly T[]): T[] => items.filter(() => next() < 0.5),
  };
}

const NOW = 1_000_000;
const MODELS = [
  { id: "codex/model-a", provider: "codex", reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "codex/model-b", provider: "codex", reasoningLevels: ["low", "medium", "high"] },
  {
    id: "claude/model-a",
    provider: "claude",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "supergrok/model-a", provider: "supergrok", reasoningLevels: ["low", "high"] },
] as const;
const MODEL_IDS = MODELS.map((model) => model.id);
const PROVIDERS = ["codex", "claude", "supergrok"];
const PEOPLE = ["person-a", "person-b"];

function randomSettings(
  rng: ReturnType<typeof random>,
  connections: Connection[],
): SubscriptionSettings {
  const rotation: SubscriptionSettings["rotation"] = {};
  for (const provider of PROVIDERS) {
    const own = connections.filter((connection) => connection.provider === provider);
    rotation[provider] = rng.bool()
      ? { mode: "spread" }
      : { mode: "primary_first", primaryConnectionId: own.length ? rng.pick(own).id : null };
  }
  const fallbackOrder: SubscriptionSettings["fallbackOrder"] = {};
  for (const modelId of MODEL_IDS) fallbackOrder[modelId] = rng.subset(MODEL_IDS);
  return {
    rotation,
    crossProviderFailover: rng.bool(),
    fallbackOrder,
    personalConnectionsAllowed: rng.bool(0.7),
    personalFallbackAllowed: rng.bool(),
  };
}

function randomWorld(seed: number): { world: World; sessionId: string } {
  const rng = random(seed);
  const workspaces = [
    {
      id: "ws-team",
      kind: "shared" as const,
      ownerId: null,
      allowedModels: rng.bool(0.8) ? null : rng.subset(MODEL_IDS),
    },
    { id: "ws-personal-a", kind: "personal" as const, ownerId: "person-a", allowedModels: null },
  ];
  const connections: Connection[] = [];
  const count = Math.floor(rng.next() * 7);
  for (let index = 0; index < count; index += 1) {
    const provider = rng.pick(PROVIDERS);
    const providerModels = MODEL_IDS.filter((modelId) => modelId.startsWith(provider + "/"));
    const ownershipKind = rng.pick(["org", "workspaces", "people", "personal"] as const);
    connections.push({
      id: "conn-" + index,
      provider,
      ownership:
        ownershipKind === "personal"
          ? { kind: "personal", ownerId: rng.pick(PEOPLE) }
          : {
              kind: "shared",
              scope:
                ownershipKind === "org"
                  ? { kind: "organization" }
                  : ownershipKind === "workspaces"
                    ? {
                        kind: "workspaces",
                        workspaceIds: rng.subset(["ws-team"]),
                        personalWorkspaces: rng.bool(),
                      }
                    : { kind: "people", personIds: rng.subset(PEOPLE) },
            },
      healthy: rng.bool(0.85),
      allocatorEnabled: rng.bool(0.85),
      entitledModels: rng.bool(0.8) ? providerModels : rng.subset(providerModels),
      allowedModelIds: rng.bool(0.85) ? null : rng.subset(providerModels),
      modelCooldowns:
        rng.bool(0.8) || providerModels.length === 0
          ? {}
          : { [rng.pick(providerModels)]: rng.pick([NOW - 1, NOW + 30_000]) },
      quota: rng.pick([
        { kind: "available" as const },
        { kind: "unknown" as const },
        { kind: "exhausted" as const, resetsAt: NOW + 60_000 },
        { kind: "exhausted" as const, resetsAt: NOW - 1 },
      ]),
    });
  }
  const organization = randomSettings(rng, connections);
  const keys = [
    "rotation",
    "crossProviderFailover",
    "fallbackOrder",
    "personalConnectionsAllowed",
    "personalFallbackAllowed",
  ] as const;
  const override = randomSettings(rng, connections);
  const workspaceOverride: Partial<SubscriptionSettings> = {};
  for (const key of rng.subset(keys))
    (workspaceOverride as Record<string, unknown>)[key] = override[key];
  const workspace = rng.pick(workspaces);
  const owner = workspace.kind === "personal" ? "person-a" : rng.pick(PEOPLE);
  const bindingConnection = connections.length && rng.bool(0.7) ? rng.pick(connections) : null;
  const session: Session = {
    id: "session-1",
    workspaceId: workspace.id,
    visibility: workspace.kind === "personal" || rng.bool() ? "private" : "shared",
    ownerId: owner,
    preferredModelId: rng.pick(MODEL_IDS),
    reasoningLevel: rng.pick(["low", "medium", "high", "xhigh", "max"]),
    binding: bindingConnection
      ? {
          connectionId: bindingConnection.id,
          modelId: rng.bool(0.8)
            ? (MODEL_IDS.find((modelId) => modelId.startsWith(bindingConnection.provider + "/")) ??
              MODEL_IDS[0]!)
            : rng.pick(MODEL_IDS),
          lastUsedAt: NOW - rng.pick([10_000, 200_000, 4_000_000]),
        }
      : null,
    pinnedConnectionId: connections.length && rng.bool(0.2) ? rng.pick(connections).id : null,
    onlyThisModel: rng.bool(0.2),
    reselectionPoint: rng.bool(0.15),
  };
  return {
    sessionId: session.id,
    world: {
      settings: {
        organization,
        locked: rng.subset(keys),
        workspaceOverrides: { [workspace.id]: workspaceOverride },
      },
      workspaces,
      people: PEOPLE.map((id) => ({
        id,
        active: rng.bool(0.9),
        personalFallbackOptIn: rng.bool(),
      })),
      models: MODELS,
      connections,
      sessions: [session],
      cacheTtlMs: { codex: 300_000, claude: 300_000, supergrok: 300_000 },
    },
  };
}

const SEEDS = Array.from({ length: 4000 }, (_, index) => index + 1);

function violationsFor(decider: (world: World, sessionId: string, now: number) => Decision) {
  const found: InvariantViolation[] = [];
  for (const seed of SEEDS) {
    const { world, sessionId } = randomWorld(seed);
    found.push(...checkDecision(world, sessionId, NOW, decider(world, sessionId, NOW)));
  }
  return found;
}

describe("subscription reference model", () => {
  test("satisfies every checked invariant across 4000 generated worlds (model:SUB-ELIG-01, model:SUB-SEL-02, model:SUB-SEL-04, model:SUB-STICK-02, model:SUB-FAIL-02, model:SUB-FAIL-03, model:SUB-FAIL-04, model:SUB-WAIT-01)", () => {
    const violations = violationsFor(decide);
    expect(violations).toEqual([]);
  });

  test("generated worlds exercise running, waiting, stickiness and cross-provider failover", () => {
    const kinds = new Set<string>();
    for (const seed of SEEDS) {
      const { world, sessionId } = randomWorld(seed);
      const decision = decide(world, sessionId, NOW);
      kinds.add(decision.kind === "run" ? decision.switch : "wait:" + decision.reason);
    }
    for (const kind of [
      "initial",
      "sticky",
      "pinned",
      "reselected_cold",
      "failover_same_provider",
      "failover_cross_provider",
      "return_to_preferred",
      "wait:no_eligible_capacity",
      "wait:pinned_account_unavailable",
    ]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  describe("mutation gate: each deliberate mistake is caught", () => {
    const requirements = (violations: InvariantViolation[]) =>
      new Set(violations.map((violation) => violation.requirement));

    test("ignoring an explicit pin is caught (model:SUB-SEL-04)", () => {
      const ignorePin = (world: World, sessionId: string, now: number) =>
        decide(
          {
            ...world,
            sessions: world.sessions.map((session) => ({ ...session, pinnedConnectionId: null })),
          },
          sessionId,
          now,
        );
      expect(requirements(violationsFor(ignorePin)).has("SUB-SEL-04")).toBe(true);
    });

    test("switching account while the cache is warm is caught (model:SUB-STICK-02)", () => {
      const ignoreBinding = (world: World, sessionId: string, now: number) =>
        decide(
          { ...world, sessions: world.sessions.map((session) => ({ ...session, binding: null })) },
          sessionId,
          now,
        );
      expect(requirements(violationsFor(ignoreBinding)).has("SUB-STICK-02")).toBe(true);
    });

    test("using a personal account without an explicit choice is caught (model:SUB-SEL-02)", () => {
      const personalFirst = (world: World, sessionId: string, now: number): Decision => {
        const session = world.sessions.find((candidate) => candidate.id === sessionId)!;
        const personal = world.connections.find(
          (connection) =>
            connection.ownership.kind === "personal" &&
            canServe(world, session, connection, session.preferredModelId, now),
        );
        return personal
          ? {
              kind: "run",
              connectionId: personal.id,
              modelId: session.preferredModelId,
              reasoningLevel: session.reasoningLevel,
              switch: "initial",
            }
          : decide(world, sessionId, now);
      };
      expect(requirements(violationsFor(personalFirst)).has("SUB-SEL-02")).toBe(true);
    });

    test("waiting while an eligible account has capacity is caught (model:SUB-WAIT-01)", () => {
      const alwaysWait = (): Decision => ({
        kind: "wait",
        reason: "no_eligible_capacity",
        earliestResetAt: null,
      });
      expect(requirements(violationsFor(alwaysWait)).has("SUB-WAIT-01")).toBe(true);
    });

    test("claiming a model restriction that does not apply is caught (model:SUB-WAIT-01)", () => {
      const falseRestriction = (): Decision => ({
        kind: "wait",
        reason: "model_not_allowed",
        earliestResetAt: null,
      });
      expect(requirements(violationsFor(falseRestriction)).has("SUB-WAIT-01")).toBe(true);
    });

    test("failing over across providers when the setting forbids it is caught (model:SUB-FAIL-03)", () => {
      const forceCrossProvider = (world: World, sessionId: string, now: number) => {
        const forced = (settings: Partial<SubscriptionSettings>) => ({
          ...settings,
          crossProviderFailover: true,
        });
        return decide(
          {
            ...world,
            settings: {
              organization: forced(world.settings.organization) as SubscriptionSettings,
              locked: world.settings.locked,
              workspaceOverrides: Object.fromEntries(
                Object.entries(world.settings.workspaceOverrides).map(([id, value]) => [
                  id,
                  forced(value),
                ]),
              ),
            },
            sessions: world.sessions.map((session) => ({ ...session, onlyThisModel: false })),
          },
          sessionId,
          now,
        );
      };
      expect(requirements(violationsFor(forceCrossProvider)).has("SUB-FAIL-03")).toBe(true);
    });

    test("running at a reasoning level other than the nearest one is caught (model:SUB-FAIL-03)", () => {
      const lowestLevel = (world: World, sessionId: string, now: number): Decision => {
        const decision = decide(world, sessionId, now);
        if (decision.kind !== "run") return decision;
        const model = world.models.find((candidate) => candidate.id === decision.modelId)!;
        return { ...decision, reasoningLevel: model.reasoningLevels[0]! };
      };
      expect(requirements(violationsFor(lowestLevel)).has("SUB-FAIL-03")).toBe(true);
    });
  });
});

describe("reference model scenarios", () => {
  const base = (): World => ({
    settings: {
      organization: {
        rotation: { claude: { mode: "primary_first", primaryConnectionId: "claude-a" } },
        crossProviderFailover: true,
        fallbackOrder: { "claude/model-a": ["codex/model-a"] },
        personalConnectionsAllowed: true,
        personalFallbackAllowed: true,
      },
      locked: [],
      workspaceOverrides: {},
    },
    workspaces: [{ id: "ws-team", kind: "shared", ownerId: null, allowedModels: null }],
    people: [{ id: "person-a", active: true, personalFallbackOptIn: false }],
    models: MODELS,
    connections: [
      shared("claude-a", "claude"),
      shared("claude-b", "claude"),
      shared("codex-a", "codex"),
    ],
    sessions: [
      {
        id: "session-1",
        workspaceId: "ws-team",
        visibility: "shared",
        ownerId: "person-a",
        preferredModelId: "claude/model-a",
        reasoningLevel: "max",
        binding: null,
        pinnedConnectionId: null,
        onlyThisModel: false,
      },
    ],
    cacheTtlMs: { claude: 300_000, codex: 300_000 },
  });
  function shared(id: string, provider: string): Connection {
    return {
      id,
      provider,
      ownership: { kind: "shared", scope: { kind: "organization" } },
      healthy: true,
      allocatorEnabled: true,
      entitledModels: MODEL_IDS.filter((modelId) => modelId.startsWith(provider + "/")),
      quota: { kind: "available" },
    };
  }
  const exhaust = (world: World, id: string, resetsAt: number): World => ({
    ...world,
    connections: world.connections.map((connection) =>
      connection.id === id ? { ...connection, quota: { kind: "exhausted", resetsAt } } : connection,
    ),
  });

  test("model:SUB-FAIL-02: when the primary is exhausted the same accepted work moves to the next account of the same provider", () => {
    let world = base();
    const first = decide(world, "session-1", NOW);
    expect(first).toMatchObject({ kind: "run", connectionId: "claude-a", switch: "initial" });
    world = exhaust(applyDecision(world, "session-1", first, NOW), "claude-a", NOW + 3_600_000);
    expect(decide(world, "session-1", NOW + 1_000)).toMatchObject({
      kind: "run",
      connectionId: "claude-b",
      switch: "failover_same_provider",
    });
  });

  test("model:SUB-FAIL-03: with every Claude account exhausted the work fails over to the next provider at the nearest reasoning level", () => {
    let world = exhaust(exhaust(base(), "claude-a", NOW + 3_600_000), "claude-b", NOW + 3_600_000);
    world = {
      ...world,
      sessions: world.sessions.map((session) => ({
        ...session,
        binding: { connectionId: "claude-a", modelId: "claude/model-a", lastUsedAt: NOW },
      })),
    };
    expect(decide(world, "session-1", NOW + 1_000)).toEqual({
      kind: "run",
      connectionId: "codex-a",
      modelId: "codex/model-a",
      reasoningLevel: "xhigh",
      switch: "failover_cross_provider",
    });
  });

  test("model:SUB-FAIL-07: after failover the session stays while warm and returns to the preferred model once cold", () => {
    let world = exhaust(exhaust(base(), "claude-a", NOW + 60_000), "claude-b", NOW + 60_000);
    const failover = decide(world, "session-1", NOW);
    world = applyDecision(world, "session-1", failover, NOW);
    expect(failover).toMatchObject({ connectionId: "codex-a" });
    // Claude resets but the Codex cache is still warm: stay.
    expect(decide(world, "session-1", NOW + 120_000)).toMatchObject({
      connectionId: "codex-a",
      switch: "sticky",
    });
    // Codex cache is cold: return to Claude.
    expect(decide(world, "session-1", NOW + 400_000)).toMatchObject({
      connectionId: "claude-a",
      modelId: "claude/model-a",
      switch: "return_to_preferred",
    });
  });

  test("model:SUB-SEL-04, model:SUB-WAIT-02: a pinned session waits with the reset time and resumes on the same account after it", () => {
    let world = exhaust(base(), "claude-a", NOW + 60_000);
    world = {
      ...world,
      sessions: world.sessions.map((session) => ({ ...session, pinnedConnectionId: "claude-a" })),
    };
    expect(decide(world, "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: NOW + 60_000,
    });
    expect(decide(world, "session-1", NOW + 60_000)).toMatchObject({
      kind: "run",
      connectionId: "claude-a",
    });
  });

  test("model:SUB-FAIL-05: 'only this model' never crosses providers and waits when its provider is exhausted", () => {
    let world = exhaust(exhaust(base(), "claude-a", NOW + 60_000), "claude-b", NOW + 90_000);
    world = {
      ...world,
      sessions: world.sessions.map((session) => ({ ...session, onlyThisModel: true })),
    };
    expect(decide(world, "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: NOW + 60_000,
    });
  });

  test("model:SUB-SEL-01, model:SUB-SEL-02: an opted-in personal account is used only after the organization accounts for the same model", () => {
    let world: World = {
      ...base(),
      people: [{ id: "person-a", active: true, personalFallbackOptIn: true }],
      connections: [
        ...base().connections,
        {
          ...shared("personal-claude", "claude"),
          ownership: { kind: "personal", ownerId: "person-a" },
        },
      ],
      sessions: base().sessions.map((session) => ({ ...session, visibility: "private" as const })),
    };
    expect(decide(world, "session-1", NOW)).toMatchObject({ connectionId: "claude-a" });
    world = exhaust(exhaust(world, "claude-a", NOW + 60_000), "claude-b", NOW + 60_000);
    // Same model on the personal account comes before cross-provider failover (D-12).
    expect(decide(world, "session-1", NOW)).toMatchObject({
      connectionId: "personal-claude",
      modelId: "claude/model-a",
    });
    // In a shared session the personal account is never used automatically.
    const sharedSession = {
      ...world,
      sessions: world.sessions.map((session) => ({ ...session, visibility: "shared" as const })),
    };
    expect(decide(sharedSession, "session-1", NOW)).toMatchObject({ connectionId: "codex-a" });
  });

  test("model:SUB-SET-03: a locked organization setting ignores the workspace override", () => {
    const world = base();
    const policy = {
      ...world.settings,
      workspaceOverrides: {
        "ws-team": { crossProviderFailover: false, personalConnectionsAllowed: false },
      },
      locked: ["personalConnectionsAllowed" as const],
    };
    const effective = effectiveSettings(policy, "ws-team");
    expect(effective.values.crossProviderFailover).toBe(false);
    expect(effective.sources.crossProviderFailover).toBe("workspace");
    expect(effective.values.personalConnectionsAllowed).toBe(true);
    expect(effective.sources.personalConnectionsAllowed).toBe("organization");
  });

  test("model:SUB-SEL-03, model:SUB-ELIG-06: a Primary-first primary with unknown quota still takes new work; otherwise known capacity ranks first", () => {
    const unknownPrimary: World = {
      ...base(),
      connections: base().connections.map((connection) =>
        connection.id === "claude-a" ? { ...connection, quota: { kind: "unknown" } } : connection,
      ),
    };
    expect(decide(unknownPrimary, "session-1", NOW)).toMatchObject({
      kind: "run",
      connectionId: "claude-a",
      switch: "initial",
    });
    const spread: World = {
      ...unknownPrimary,
      settings: {
        ...unknownPrimary.settings,
        organization: { ...unknownPrimary.settings.organization, rotation: {} },
      },
    };
    expect(decide(spread, "session-1", NOW)).toMatchObject({ connectionId: "claude-b" });
  });

  test("model:SUB-FAIL-03: reasoning levels map by name, then by closest relative position with ties to the lower level", () => {
    const model = (id: string) => MODELS.find((candidate) => candidate.id === id)!;
    const claude = model("claude/model-a");
    const codexA = model("codex/model-a");
    const codexB = model("codex/model-b");
    const supergrok = model("supergrok/model-a");
    // Same name wins over position.
    expect(nearestReasoningLevel(codexA, "high", claude)).toBe("high");
    // Highest maps to highest.
    expect(nearestReasoningLevel(codexA, "max", claude)).toBe("xhigh");
    expect(nearestReasoningLevel(supergrok, "xhigh", claude)).toBe("high");
    // "medium" sits halfway on a three-level ladder: equally close to both, so the lower.
    expect(nearestReasoningLevel(supergrok, "medium", codexB)).toBe("low");
    // A level the preferred model does not list maps to the (lower) middle, not the lowest.
    expect(nearestReasoningLevel(codexA, "unlisted", codexA)).toBe("medium");
    expect(nearestReasoningLevel(codexB, "unlisted", codexB)).toBe("medium");
  });

  test("model:SUB-STICK-07, model:SUB-ELIG-05: a session shared while warm on a personal account leaves it at once", () => {
    const privateOnPersonal: World = {
      ...base(),
      connections: [
        ...base().connections,
        {
          ...shared("personal-claude", "claude"),
          ownership: { kind: "personal", ownerId: "person-a" },
        },
      ],
      sessions: base().sessions.map((session) => ({
        ...session,
        visibility: "private" as const,
        binding: { connectionId: "personal-claude", modelId: "claude/model-a", lastUsedAt: NOW },
      })),
    };
    // Private and warm: the personal account the session runs on is kept.
    expect(decide(privateOnPersonal, "session-1", NOW + 1_000)).toMatchObject({
      connectionId: "personal-claude",
      switch: "sticky",
    });
    const nowShared: World = {
      ...privateOnPersonal,
      sessions: privateOnPersonal.sessions.map((session) => ({
        ...session,
        visibility: "shared" as const,
      })),
    };
    // Shared while the cache is still warm: it moves to an organization account now.
    expect(decide(nowShared, "session-1", NOW + 1_000)).toMatchObject({
      kind: "run",
      connectionId: "claude-a",
      switch: "failover_same_provider",
    });
    // Staying on the personal account is reported as an eligibility violation.
    const stayed = checkDecision(nowShared, "session-1", NOW + 1_000, {
      kind: "run",
      connectionId: "personal-claude",
      modelId: "claude/model-a",
      reasoningLevel: "max",
      switch: "sticky",
    });
    expect(stayed.length).toBeGreaterThan(0);
  });

  test("model:SUB-WAIT-02, model:SUB-SEL-02: the expected reset ignores a personal account the person has not opted into", () => {
    const withPersonal = (optIn: boolean): World =>
      exhaust(
        exhaust(
          exhaust(
            {
              ...base(),
              people: [{ id: "person-a", active: true, personalFallbackOptIn: optIn }],
              connections: [
                ...base().connections,
                {
                  ...shared("personal-claude", "claude"),
                  ownership: { kind: "personal", ownerId: "person-a" },
                },
              ],
              sessions: base().sessions.map((session) => ({
                ...session,
                visibility: "private" as const,
                onlyThisModel: true,
              })),
            },
            "claude-a",
            NOW + 60_000,
          ),
          "claude-b",
          NOW + 90_000,
        ),
        "personal-claude",
        NOW + 10_000,
      );
    expect(decide(withPersonal(false), "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: NOW + 60_000,
    });
    expect(decide(withPersonal(true), "session-1", NOW)).toEqual({
      kind: "wait",
      reason: "no_eligible_capacity",
      earliestResetAt: NOW + 10_000,
    });
  });

  test("model:SUB-STICK-05: a completed compaction is a re-selection point even while the cache is warm", () => {
    let world = exhaust(exhaust(base(), "claude-a", NOW + 60_000), "claude-b", NOW + 60_000);
    world = applyDecision(world, "session-1", decide(world, "session-1", NOW), NOW);
    const later = NOW + 61_000;
    expect(decide(world, "session-1", later)).toMatchObject({
      connectionId: "codex-a",
      switch: "sticky",
    });
    const compacted: World = {
      ...world,
      sessions: world.sessions.map((session) => ({ ...session, reselectionPoint: true })),
    };
    expect(decide(compacted, "session-1", later)).toMatchObject({
      connectionId: "claude-a",
      switch: "return_to_preferred",
    });
  });

  test("model:SUB-ELIG-03: a per-model cooldown or the connection's access policy moves work to another account", () => {
    const cooled: World = {
      ...base(),
      connections: base().connections.map((connection) =>
        connection.id === "claude-a"
          ? { ...connection, modelCooldowns: { "claude/model-a": NOW + 60_000 } }
          : connection,
      ),
    };
    expect(decide(cooled, "session-1", NOW)).toMatchObject({ connectionId: "claude-b" });
    expect(decide(cooled, "session-1", NOW + 60_000)).toMatchObject({ connectionId: "claude-a" });
    const restricted: World = {
      ...base(),
      connections: base().connections.map((connection) =>
        connection.id === "claude-a" ? { ...connection, allowedModelIds: [] } : connection,
      ),
    };
    expect(decide(restricted, "session-1", NOW)).toMatchObject({ connectionId: "claude-b" });
  });

  test("model:SUB-SEL-03, model:SUB-SEL-05: Spread places each session deterministically and spreads sessions across accounts without a cross-session lock", () => {
    const spreadWorld = (sessionIds: string[]): World => ({
      ...base(),
      settings: {
        ...base().settings,
        organization: { ...base().settings.organization, rotation: {} },
      },
      sessions: sessionIds.map((id) => ({ ...base().sessions[0]!, id })),
    });
    const ids = Array.from({ length: 40 }, (_, index) => "session-" + index);
    const world = spreadWorld(ids);
    const placements = ids.map((id) => decide(world, id, NOW));
    // The same session always lands on the same account, whatever else is bound.
    expect(decide(spreadWorld([ids[3]!]), ids[3]!, NOW)).toEqual(placements[3]!);
    // Sessions are spread over both Claude accounts.
    const used = new Set(
      placements.map((decision) => (decision.kind === "run" ? decision.connectionId : "")),
    );
    expect(used).toEqual(new Set(["claude-a", "claude-b"]));
  });

  test("model:SUB-ELIG-02, model:SUB-WAIT-01: a restricted preferred model runs on an allowed fallback and waits only when none is allowed", () => {
    const restricted: World = {
      ...base(),
      workspaces: [
        { id: "ws-team", kind: "shared", ownerId: null, allowedModels: ["codex/model-a"] },
      ],
    };
    expect(decide(restricted, "session-1", NOW)).toMatchObject({
      kind: "run",
      connectionId: "codex-a",
      modelId: "codex/model-a",
      switch: "initial",
    });
    expect(
      checkDecision(restricted, "session-1", NOW, {
        kind: "wait",
        reason: "model_not_allowed",
        earliestResetAt: null,
      }).map((violation) => violation.requirement),
    ).toContain("SUB-WAIT-01");
    const onlyThis: World = {
      ...restricted,
      sessions: restricted.sessions.map((session) => ({ ...session, onlyThisModel: true })),
    };
    const wait = decide(onlyThis, "session-1", NOW);
    expect(wait).toEqual({ kind: "wait", reason: "model_not_allowed", earliestResetAt: null });
    expect(checkDecision(onlyThis, "session-1", NOW, wait)).toEqual([]);
  });

  test("model:SUB-ELIG-01, model:SUB-ELIG-02, model:SUB-ELIG-03, model:SUB-ELIG-04, model:SUB-ELIG-05: an ineligible placement names the precise requirement", () => {
    const runOn = (connectionId: string, modelId = "claude/model-a"): Decision => ({
      kind: "run",
      connectionId,
      modelId,
      reasoningLevel: "max",
      switch: "initial",
    });
    const labels = (world: World, decision: Decision) =>
      checkDecision(world, "session-1", NOW, decision).map((violation) => violation.requirement);
    const replace = (id: string, change: Partial<Connection>): World => ({
      ...base(),
      connections: base().connections.map((connection) =>
        connection.id === id ? { ...connection, ...change } : connection,
      ),
    });
    expect(
      labels(
        replace("claude-a", {
          ownership: { kind: "shared", scope: { kind: "people", personIds: [] } },
        }),
        runOn("claude-a"),
      ),
    ).toEqual(["SUB-ELIG-01"]);
    expect(
      labels(
        {
          ...base(),
          workspaces: [
            { id: "ws-team", kind: "shared", ownerId: null, allowedModels: ["codex/model-a"] },
          ],
        },
        runOn("claude-a"),
      ),
    ).toEqual(["SUB-ELIG-02"]);
    expect(labels(replace("claude-a", { entitledModels: [] }), runOn("claude-a"))).toEqual([
      "SUB-ELIG-03",
    ]);
    expect(labels(replace("claude-a", { healthy: false }), runOn("claude-a"))).toEqual([
      "SUB-ELIG-04",
    ]);
    expect(
      labels(
        replace("claude-a", { ownership: { kind: "personal", ownerId: "person-a" } }),
        runOn("claude-a"),
      ),
    ).toEqual(["SUB-ELIG-05"]);
  });
});
