/**
 * Generated worlds and scripted scenarios for the subscription reference model.
 * Shared by the reference model's own tests and by production conformance
 * tests, so both judge exactly the same inputs.
 */
import type {
  Connection,
  Decision,
  Session,
  SubscriptionSettings,
  World,
} from "./subscription-reference-model";

/** Deterministic PRNG (mulberry32) so every generated world is reproducible by seed. */
export function referenceRandom(seed: number) {
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

export type ReferenceRandom = ReturnType<typeof referenceRandom>;

export const REFERENCE_NOW = 1_000_000;
export const REFERENCE_MODELS = [
  { id: "codex/model-a", provider: "codex", reasoningLevels: ["low", "medium", "high", "xhigh"] },
  { id: "codex/model-b", provider: "codex", reasoningLevels: ["low", "medium", "high"] },
  {
    id: "claude/model-a",
    provider: "claude",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  { id: "supergrok/model-a", provider: "supergrok", reasoningLevels: ["low", "high"] },
] as const;
export const REFERENCE_MODEL_IDS: readonly string[] = REFERENCE_MODELS.map((model) => model.id);
export const REFERENCE_PROVIDERS: readonly string[] = ["codex", "claude", "supergrok"];
export const REFERENCE_PEOPLE: readonly string[] = ["person-a", "person-b"];
const SETTING_KEYS = [
  "rotation",
  "crossProviderFailover",
  "fallbackOrder",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
] as const;

function randomSettings(rng: ReferenceRandom, connections: Connection[]): SubscriptionSettings {
  const rotation: SubscriptionSettings["rotation"] = {};
  for (const provider of REFERENCE_PROVIDERS) {
    const own = connections.filter((connection) => connection.provider === provider);
    rotation[provider] = rng.bool()
      ? { mode: "spread" }
      : { mode: "primary_first", primaryConnectionId: own.length ? rng.pick(own).id : null };
  }
  const fallbackOrder: SubscriptionSettings["fallbackOrder"] = {};
  for (const modelId of REFERENCE_MODEL_IDS)
    fallbackOrder[modelId] = rng.subset(REFERENCE_MODEL_IDS);
  return {
    rotation,
    crossProviderFailover: rng.bool(),
    fallbackOrder,
    personalConnectionsAllowed: rng.bool(0.7),
    personalFallbackAllowed: rng.bool(),
  };
}

/** One generated world with a single session, reproducible from its seed. */
export function generateReferenceWorld(seed: number): { world: World; sessionId: string } {
  const now = REFERENCE_NOW;
  const rng = referenceRandom(seed);
  const workspaces = [
    {
      id: "ws-team",
      kind: "shared" as const,
      ownerId: null,
      allowedModels: rng.bool(0.8) ? null : rng.subset(REFERENCE_MODEL_IDS),
    },
    { id: "ws-personal-a", kind: "personal" as const, ownerId: "person-a", allowedModels: null },
  ];
  const connections: Connection[] = [];
  const count = Math.floor(rng.next() * 7);
  for (let index = 0; index < count; index += 1) {
    const provider = rng.pick(REFERENCE_PROVIDERS);
    const providerModels = REFERENCE_MODEL_IDS.filter((modelId) =>
      modelId.startsWith(provider + "/"),
    );
    const ownershipKind = rng.pick(["org", "workspaces", "people", "personal"] as const);
    connections.push({
      id: "conn-" + index,
      provider,
      ownership:
        ownershipKind === "personal"
          ? { kind: "personal", ownerId: rng.pick(REFERENCE_PEOPLE) }
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
                    : { kind: "people", personIds: rng.subset(REFERENCE_PEOPLE) },
            },
      healthy: rng.bool(0.85),
      allocatorEnabled: rng.bool(0.85),
      entitledModels: rng.bool(0.8) ? providerModels : rng.subset(providerModels),
      allowedModelIds: rng.bool(0.85) ? null : rng.subset(providerModels),
      modelCooldowns:
        rng.bool(0.8) || providerModels.length === 0
          ? {}
          : { [rng.pick(providerModels)]: now + rng.pick([-1, 1, 15_000, 30_000, 90_000]) },
      quota: rng.pick([
        { kind: "available" as const },
        { kind: "unknown" as const },
        {
          kind: "exhausted" as const,
          resetsAt: now + rng.pick([1, 20_000, 60_000, 45_000, 200_000]),
        },
        { kind: "exhausted" as const, resetsAt: now - rng.pick([1, 50_000]) },
      ]),
    });
  }
  const organization = randomSettings(rng, connections);
  const override = randomSettings(rng, connections);
  const workspaceOverride: Partial<SubscriptionSettings> = {};
  for (const key of rng.subset(SETTING_KEYS)) {
    const value = override[key];
    // Map-valued settings are often overridden for only some entries (D-25).
    (workspaceOverride as Record<string, unknown>)[key] =
      (key === "rotation" || key === "fallbackOrder") && rng.bool()
        ? Object.fromEntries(rng.subset(Object.entries(value as object)))
        : value;
  }
  const workspace = rng.pick(workspaces);
  const owner = workspace.kind === "personal" ? "person-a" : rng.pick(REFERENCE_PEOPLE);
  const bindingConnection = connections.length && rng.bool(0.7) ? rng.pick(connections) : null;
  const session: Session = {
    id: "session-1",
    workspaceId: workspace.id,
    visibility: workspace.kind === "personal" || rng.bool() ? "private" : "shared",
    ownerId: owner,
    preferredModelId: rng.pick(REFERENCE_MODEL_IDS),
    reasoningLevel: rng.pick(["low", "medium", "high", "xhigh", "max"]),
    binding: bindingConnection
      ? {
          connectionId: bindingConnection.id,
          modelId: rng.bool(0.8)
            ? (REFERENCE_MODEL_IDS.find((modelId) =>
                modelId.startsWith(bindingConnection.provider + "/"),
              ) ?? REFERENCE_MODEL_IDS[0]!)
            : rng.pick(REFERENCE_MODEL_IDS),
          lastUsedAt: now - rng.pick([10_000, 200_000, 4_000_000]),
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
        locked: rng.subset(SETTING_KEYS),
        workspaceOverrides: { [workspace.id]: workspaceOverride },
      },
      workspaces,
      people: REFERENCE_PEOPLE.map((id) => ({
        id,
        active: rng.bool(0.9),
        personalFallbackOptIn: rng.bool(),
      })),
      models: REFERENCE_MODELS,
      connections,
      sessions: [session],
      cacheTtlMs: { codex: 300_000, claude: 300_000, supergrok: 300_000 },
    },
  };
}

// Scripted scenarios

export function referenceSharedConnection(id: string, provider: string): Connection {
  return {
    id,
    provider,
    ownership: { kind: "shared", scope: { kind: "organization" } },
    healthy: true,
    allocatorEnabled: true,
    entitledModels: REFERENCE_MODEL_IDS.filter((modelId) => modelId.startsWith(provider + "/")),
    quota: { kind: "available" },
  };
}

/** A team workspace with two Claude accounts (primary first) and one Codex account. */
export function referenceScenarioWorld(): World {
  return {
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
    models: REFERENCE_MODELS,
    connections: [
      referenceSharedConnection("claude-a", "claude"),
      referenceSharedConnection("claude-b", "claude"),
      referenceSharedConnection("codex-a", "codex"),
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
  };
}

export function exhaustReferenceConnection(world: World, id: string, resetsAt: number): World {
  return {
    ...world,
    connections: world.connections.map((connection) =>
      connection.id === id ? { ...connection, quota: { kind: "exhausted", resetsAt } } : connection,
    ),
  };
}

export function updateReferenceSession(world: World, patch: Partial<Session>): World {
  return { ...world, sessions: world.sessions.map((session) => ({ ...session, ...patch })) };
}

/**
 * One checkpoint of a scripted scenario: the decision the contract requires
 * for this world at this time. `exact` checkpoints must equal `expected`;
 * others must contain it.
 */
export type ReferenceScenarioCheckpoint = {
  title: string;
  world: World;
  sessionId: string;
  now: number;
  expected: Partial<Decision> & Pick<Decision, "kind">;
  exact: boolean;
};

/** The contract's scripted scenarios, flattened into checkpoints. */
export function referenceScenarioCheckpoints(): ReferenceScenarioCheckpoint[] {
  const now = REFERENCE_NOW;
  const base = referenceScenarioWorld;
  const exhaust = exhaustReferenceConnection;
  const checkpoint = (
    title: string,
    world: World,
    at: number,
    expected: ReferenceScenarioCheckpoint["expected"],
    exact = false,
  ): ReferenceScenarioCheckpoint => ({
    title,
    world,
    sessionId: "session-1",
    now: at,
    expected,
    exact,
  });
  const boundTo = (world: World, connectionId: string, modelId: string, lastUsedAt: number) =>
    updateReferenceSession(world, { binding: { connectionId, modelId, lastUsedAt } });
  const withPersonal = (world: World): World => ({
    ...world,
    people: [{ id: "person-a", active: true, personalFallbackOptIn: true }],
    connections: [
      ...world.connections,
      {
        ...referenceSharedConnection("personal-claude", "claude"),
        ownership: { kind: "personal", ownerId: "person-a" },
      },
    ],
  });
  const cooled = (world: World, until: Record<string, number>): World => ({
    ...world,
    connections: world.connections.map((connection) =>
      until[connection.id] === undefined
        ? connection
        : { ...connection, modelCooldowns: { "claude/model-a": until[connection.id]! } },
    ),
  });
  const bothClaudeExhausted = (resetsAt: number, secondResetsAt = resetsAt) =>
    exhaust(exhaust(base(), "claude-a", resetsAt), "claude-b", secondResetsAt);

  const failoverTitle =
    "SUB-FAIL-02: when the primary is exhausted the same accepted work moves to the next account of the same provider";
  const crossTitle =
    "SUB-FAIL-03: with every Claude account exhausted the work fails over to the next provider at the nearest reasoning level";
  const returnTitle =
    "SUB-FAIL-07: after failover the session stays while warm and returns to the preferred model once cold";
  const pinTitle =
    "SUB-SEL-04, SUB-WAIT-02: a pinned session waits with the reset time and resumes on the same account after it";
  const personalTitle =
    "SUB-SEL-01, SUB-SEL-02: an opted-in personal account is used only after the organization accounts for the same model";
  const compactionTitle =
    "SUB-STICK-05: a completed compaction is a re-selection point even while warm";
  const failedOver = boundTo(bothClaudeExhausted(now + 60_000), "codex-a", "codex/model-a", now);
  return [
    checkpoint(failoverTitle + " (initial placement)", base(), now, {
      kind: "run",
      connectionId: "claude-a",
      switch: "initial",
    }),
    checkpoint(
      failoverTitle + " (after exhaustion)",
      exhaust(boundTo(base(), "claude-a", "claude/model-a", now), "claude-a", now + 3_600_000),
      now + 1_000,
      { kind: "run", connectionId: "claude-b", switch: "failover_same_provider" },
    ),
    checkpoint(
      crossTitle,
      boundTo(bothClaudeExhausted(now + 3_600_000), "claude-a", "claude/model-a", now),
      now + 1_000,
      {
        kind: "run",
        connectionId: "codex-a",
        modelId: "codex/model-a",
        reasoningLevel: "xhigh",
        switch: "failover_cross_provider",
      },
      true,
    ),
    checkpoint(returnTitle + " (failover)", bothClaudeExhausted(now + 60_000), now, {
      kind: "run",
      connectionId: "codex-a",
    }),
    checkpoint(returnTitle + " (still warm)", failedOver, now + 120_000, {
      kind: "run",
      connectionId: "codex-a",
      switch: "sticky",
    }),
    checkpoint(returnTitle + " (cold)", failedOver, now + 400_000, {
      kind: "run",
      connectionId: "claude-a",
      modelId: "claude/model-a",
      switch: "return_to_preferred",
    }),
    checkpoint(
      pinTitle + " (waiting)",
      updateReferenceSession(exhaust(base(), "claude-a", now + 60_000), {
        pinnedConnectionId: "claude-a",
      }),
      now,
      { kind: "wait", reason: "pinned_account_unavailable", earliestResetAt: now + 60_000 },
      true,
    ),
    checkpoint(
      pinTitle + " (resumed)",
      updateReferenceSession(exhaust(base(), "claude-a", now + 60_000), {
        pinnedConnectionId: "claude-a",
      }),
      now + 60_000,
      { kind: "run", connectionId: "claude-a" },
    ),
    checkpoint(
      "SUB-FAIL-05: 'only this model' never crosses providers and waits when its provider is exhausted",
      updateReferenceSession(bothClaudeExhausted(now + 60_000, now + 90_000), {
        onlyThisModel: true,
      }),
      now,
      { kind: "wait", reason: "no_eligible_capacity", earliestResetAt: now + 60_000 },
      true,
    ),
    checkpoint(
      personalTitle + " (organization first)",
      updateReferenceSession(withPersonal(base()), { visibility: "private" }),
      now,
      { kind: "run", connectionId: "claude-a" },
    ),
    checkpoint(
      personalTitle + " (same model on the personal account before another provider, D-12)",
      updateReferenceSession(withPersonal(bothClaudeExhausted(now + 60_000)), {
        visibility: "private",
      }),
      now,
      { kind: "run", connectionId: "personal-claude", modelId: "claude/model-a" },
    ),
    checkpoint(
      personalTitle + " (never automatically in a shared session)",
      withPersonal(bothClaudeExhausted(now + 60_000)),
      now,
      { kind: "run", connectionId: "codex-a" },
    ),
    checkpoint(
      "SUB-SEL-03: a primary with unknown quota still takes new work, so it is never starved",
      {
        ...base(),
        connections: base().connections.map((connection) =>
          connection.id === "claude-a" ? { ...connection, quota: { kind: "unknown" } } : connection,
        ),
      },
      now,
      { kind: "run", connectionId: "claude-a" },
    ),
    checkpoint(
      "SUB-STICK-07: a session that becomes shared leaves a personal account even while warm",
      boundTo(withPersonal(base()), "personal-claude", "claude/model-a", now - 1_000),
      now,
      { kind: "run", connectionId: "claude-a" },
    ),
    checkpoint(compactionTitle + " (warm without compaction)", failedOver, now + 61_000, {
      kind: "run",
      connectionId: "codex-a",
      switch: "sticky",
    }),
    checkpoint(
      compactionTitle + " (after compaction)",
      updateReferenceSession(failedOver, { reselectionPoint: true }),
      now + 61_000,
      { kind: "run", connectionId: "claude-a", switch: "return_to_preferred" },
    ),
    checkpoint(
      "SUB-ELIG-02, SUB-WAIT-01: a restricted preferred model runs on an allowed fallback (D-17)",
      {
        ...base(),
        workspaces: [
          { id: "ws-team", kind: "shared", ownerId: null, allowedModels: ["codex/model-a"] },
        ],
      },
      now,
      {
        kind: "run",
        connectionId: "codex-a",
        modelId: "codex/model-a",
        reasoningLevel: "xhigh",
        switch: "initial",
      },
      true,
    ),
    checkpoint(
      "SUB-ELIG-02: with no allowed candidate model the work waits on the restriction (D-17)",
      {
        ...base(),
        workspaces: [
          { id: "ws-team", kind: "shared", ownerId: null, allowedModels: ["supergrok/model-a"] },
        ],
      },
      now,
      { kind: "wait", reason: "model_not_allowed", earliestResetAt: null },
      true,
    ),
    checkpoint(
      "SUB-ELIG-03: a per-model cooldown moves work to another account of the provider",
      cooled(base(), { "claude-a": now + 60_000 }),
      now,
      { kind: "run", connectionId: "claude-b" },
    ),
    checkpoint(
      "SUB-WAIT-02: a cooldown-only wait reports the earliest usable cooldown end",
      updateReferenceSession(
        cooled(base(), { "claude-a": now + 60_000, "claude-b": now + 30_000 }),
        {
          onlyThisModel: true,
        },
      ),
      now,
      { kind: "wait", reason: "no_eligible_capacity", earliestResetAt: now + 30_000 },
      true,
    ),
    checkpoint(
      "SUB-WAIT-02, SUB-SEL-04: a pinned wait reports when the chosen account can serve again, counting its cooldown (D-22)",
      updateReferenceSession(
        cooled(exhaust(base(), "claude-a", now + 20_000), { "claude-a": now + 45_000 }),
        { pinnedConnectionId: "claude-a" },
      ),
      now,
      { kind: "wait", reason: "pinned_account_unavailable", earliestResetAt: now + 45_000 },
      true,
    ),
    checkpoint(
      "SUB-ACCESS-06: an explicit choice that can never serve the model says so (D-24)",
      updateReferenceSession(base(), { pinnedConnectionId: "codex-a" }),
      now,
      { kind: "wait", reason: "pinned_account_ineligible", earliestResetAt: null },
      true,
    ),
  ];
}
