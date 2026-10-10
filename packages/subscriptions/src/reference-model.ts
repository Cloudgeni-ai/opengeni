/**
 * Independent executable reference model of the subscription account contract
 * (docs/subscription-accounts.md). It is written from the contract, not from
 * the production selection code, so conformance tests can compare production
 * decisions against it. Everything here is pure and deterministic: no clock,
 * database or randomness.
 *
 * It ships in `@opengeni/subscriptions` only so the worker's shadow comparison
 * can run `checkDecision` in production; it is published through the separate
 * `@opengeni/subscriptions/reference` entry point, and the placement modules of
 * this package never import it (a test enforces both directions).
 *
 * The model answers one question: given the world and a session that wants to
 * run a turn now, which account and model must it run on, or why must it wait?
 */

export type ProviderId = string;
export type ModelId = string;

export type Rotation =
  | { mode: "primary_first"; primaryConnectionId: string | null }
  | { mode: "spread" };

export type SubscriptionSettings = {
  /** Per provider; a provider without an entry spreads work. */
  rotation: Record<ProviderId, Rotation>;
  /** `automatic` admits both classified shared pools; missing entries retain legacy behavior. */
  inferenceSource?: Record<ProviderId, "automatic" | "workspace" | "organization">;
  crossProviderFailover: boolean;
  /** Ordered fallback models for a preferred model, possibly on other providers. */
  fallbackOrder: Record<ModelId, ModelId[]>;
  personalConnectionsAllowed: boolean;
  personalFallbackAllowed: boolean;
};
export type SettingKey = keyof SubscriptionSettings;

export type SettingsPolicy = {
  organization: SubscriptionSettings;
  locked: readonly SettingKey[];
  workspaceOverrides: Record<string, Partial<SubscriptionSettings>>;
};

export type ConnectionScope =
  | { kind: "organization" }
  | { kind: "workspaces"; workspaceIds: readonly string[]; personalWorkspaces: boolean }
  | { kind: "people"; personIds: readonly string[] };

export type Quota =
  | { kind: "available" }
  | { kind: "unknown" }
  | { kind: "exhausted"; resetsAt: number | null };

export type Connection = {
  id: string;
  provider: ProviderId;
  ownership: { kind: "shared"; scope: ConnectionScope } | { kind: "personal"; ownerId: string };
  healthy: boolean;
  allocatorEnabled: boolean;
  entitledModels: readonly ModelId[];
  /** Administrator access policy on the connection; null or absent allows every entitled model. */
  allowedModelIds?: readonly ModelId[] | null;
  assignmentPolicies?: readonly {
    workspaceId: string;
    inferencePool: "workspace" | "organization";
    allowedModelIds: readonly ModelId[] | null;
    excludedModelIds?: readonly ModelId[];
    allocatorEnabled: boolean;
    managedByWorkspaceId?: string | null;
  }[];
  /** Per-model cooldowns (some providers report model-specific limits). */
  modelCooldowns?: Readonly<Record<ModelId, number>>;
  quota: Quota;
  /** Explicit consent to spend credits after the included allowance (extra-credits providers only). */
  extraCreditsEnabled?: boolean;
  /** A provider refusal blocks even paid credits until this deadline. */
  refusalUntil?: number | null;
};

export type Workspace = {
  id: string;
  kind: "shared" | "personal";
  /** Owner of a Personal workspace. */
  ownerId: string | null;
  /** Workspace model restriction; null allows every model. */
  allowedModels: readonly ModelId[] | null;
};

export type Person = { id: string; active: boolean; personalFallbackOptIn: boolean };

export type Model = { id: ModelId; provider: ProviderId; reasoningLevels: readonly string[] };

export type SessionBinding = { connectionId: string; modelId: ModelId; lastUsedAt: number };

export type Session = {
  id: string;
  workspaceId: string;
  visibility: "private" | "shared";
  /** Null only for a deliberately ownerless service session; it can use shared pools only. */
  ownerId: string | null;
  /** The model the session asked for. */
  preferredModelId: ModelId;
  reasoningLevel: string;
  binding: SessionBinding | null;
  /** An explicit account choice is a pin: the session waits for it rather than moving. */
  pinnedConnectionId: string | null;
  /** "Only this model": no cross-provider failover. Same-model account failover still applies. */
  onlyThisModel: boolean;
  /** A compaction completed or the model changed since the last placement (SUB-STICK-05). */
  reselectionPoint?: boolean;
};

export type World = {
  settings: SettingsPolicy;
  workspaces: readonly Workspace[];
  people: readonly Person[];
  models: readonly Model[];
  connections: readonly Connection[];
  sessions: readonly Session[];
  /** Prompt-cache lifetime after the last use, per provider. */
  cacheTtlMs: Record<ProviderId, number>;
};

export type SwitchKind =
  | "initial"
  | "sticky"
  | "pinned"
  | "reselected_cold"
  | "failover_same_provider"
  | "failover_cross_provider"
  | "return_to_preferred";

export type WaitReason =
  | "pinned_account_unavailable"
  /** The explicit choice can never serve this work until a person changes something (D-24). */
  | "pinned_account_ineligible"
  | "no_eligible_capacity"
  | "model_not_allowed";

export type Decision =
  | {
      kind: "run";
      connectionId: string;
      modelId: ModelId;
      reasoningLevel: string;
      switch: SwitchKind;
    }
  | { kind: "wait"; reason: WaitReason; earliestResetAt: number | null };

// Effective settings

export type EffectiveSettings = {
  values: SubscriptionSettings;
  sources: Record<SettingKey, "organization" | "workspace">;
};

const SETTING_KEYS: readonly SettingKey[] = [
  "rotation",
  "inferenceSource",
  "crossProviderFailover",
  "fallbackOrder",
  "personalConnectionsAllowed",
  "personalFallbackAllowed",
];

/**
 * SUB-SET-01..03: organization default, unless a workspace overrides an
 * unlocked setting. Per-provider and per-model maps are overridden entry by
 * entry, so a workspace that sets one provider's rotation keeps the others
 * (D-25); the source is "workspace" when the workspace overrides any entry.
 */
export function effectiveSettings(policy: SettingsPolicy, workspaceId: string): EffectiveSettings {
  const override = policy.workspaceOverrides[workspaceId] ?? {};
  const values = { ...policy.organization } as SubscriptionSettings;
  const sources = {} as Record<SettingKey, "organization" | "workspace">;
  for (const key of SETTING_KEYS) {
    const overridden = override[key] !== undefined && !policy.locked.includes(key);
    if (overridden) {
      (values as Record<SettingKey, unknown>)[key] =
        key === "rotation" || key === "inferenceSource" || key === "fallbackOrder"
          ? { ...policy.organization[key], ...(override[key] as object) }
          : override[key];
    }
    sources[key] = overridden ? "workspace" : "organization";
  }
  return { values, sources };
}

// Eligibility

function byId<T extends { id: string }>(items: readonly T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

export function isCacheWarm(world: World, binding: SessionBinding, now: number): boolean {
  const connection = byId(world.connections, binding.connectionId);
  if (!connection) return false;
  const ttl = world.cacheTtlMs[connection.provider] ?? 0;
  return now - binding.lastUsedAt <= ttl;
}

function hasCapacity(connection: Connection, now: number): boolean {
  // Unknown quota stays unknown: it is neither availability nor exhaustion (SUB-ELIG-06).
  return (
    connection.quota.kind !== "exhausted" ||
    (connection.quota.resetsAt !== null && connection.quota.resetsAt <= now) ||
    spendsCredits(connection, now)
  );
}

function spendsCredits(connection: Connection, now: number): boolean {
  return (
    connection.extraCreditsEnabled === true &&
    (connection.refusalUntil == null || connection.refusalUntil <= now) &&
    connection.quota.kind === "exhausted" &&
    (connection.quota.resetsAt === null || connection.quota.resetsAt > now)
  );
}

function modelAllowed(world: World, session: Session, modelId: ModelId): boolean {
  const workspace = byId(world.workspaces, session.workspaceId);
  return (
    !!workspace && (workspace.allowedModels === null || workspace.allowedModels.includes(modelId))
  );
}

/**
 * Why this connection may not serve this session's work at all, ignoring the
 * model, capacity and the explicit-choice rule for personal accounts, labelled
 * with the requirement that forbids it; null when it may.
 */
export function authorizationFailure(
  world: World,
  session: Session,
  connection: Connection,
): InvariantViolation | null {
  const failure = (requirement: string, message: string) => ({ requirement, message });
  const workspace = byId(world.workspaces, session.workspaceId);
  if (!workspace) return failure("SUB-ELIG-01", "the session's workspace is unknown");
  if (!connection.healthy || !connection.allocatorEnabled) {
    return failure("SUB-ELIG-04", "the account is unhealthy or excluded from allocation");
  }
  if (connection.ownership.kind === "personal") {
    const settings = effectiveSettings(world.settings, workspace.id).values;
    const owner = byId(world.people, connection.ownership.ownerId);
    const ownersOwnWork =
      session.ownerId === connection.ownership.ownerId &&
      (session.visibility === "private" ||
        (workspace.kind === "personal" && workspace.ownerId === connection.ownership.ownerId));
    if (!settings.personalConnectionsAllowed) {
      return failure("SUB-OWN-05", "personal connections are disabled here");
    }
    if (!owner?.active) return failure("SUB-ACCESS-06", "the personal account's owner left");
    if (!ownersOwnWork) {
      return failure("SUB-ELIG-05", "a personal account served work other than its owner's own");
    }
    return null;
  }
  if (connection.assignmentPolicies !== undefined) {
    const source =
      effectiveSettings(world.settings, workspace.id).values.inferenceSource?.[
        connection.provider
      ] ?? "automatic";
    const matching = connection.assignmentPolicies.filter(
      (policy) =>
        policy.workspaceId === workspace.id &&
        (source === "automatic" || policy.inferencePool === source),
    );
    if (matching.length === 0) {
      return failure("SUB-SET-06", "the effective inference source excludes this assignment");
    }
  }
  const scope = connection.ownership.scope;
  const inScope =
    scope.kind === "organization" ||
    (scope.kind === "workspaces"
      ? scope.workspaceIds.includes(workspace.id) ||
        (workspace.kind === "personal" && scope.personalWorkspaces)
      : session.ownerId !== null && scope.personIds.includes(session.ownerId));
  return inScope ? null : failure("SUB-ELIG-01", "the account's scope excludes this work");
}

/** May this connection serve this session's work at all? SUB-ELIG-01, 04, 05. */
export function isAuthorized(world: World, session: Session, connection: Connection): boolean {
  return authorizationFailure(world, session, connection) === null;
}

/**
 * Why this connection cannot serve this session on this model now, labelled
 * with the requirement that forbids it; null when it can.
 */
export function servingFailure(
  world: World,
  session: Session,
  connection: Connection,
  modelId: ModelId,
  now: number,
): InvariantViolation | null {
  const model = byId(world.models, modelId);
  if (
    !model ||
    model.provider !== connection.provider ||
    !connection.entitledModels.includes(modelId)
  ) {
    return { requirement: "SUB-ELIG-03", message: "the account's plan does not include the model" };
  }
  if (connection.allowedModelIds != null && !connection.allowedModelIds.includes(modelId)) {
    return {
      requirement: "SUB-ELIG-03",
      message: "the account's access policy excludes the model",
    };
  }
  if (connection.assignmentPolicies !== undefined) {
    const workspace = byId(world.workspaces, session.workspaceId)!;
    const source =
      effectiveSettings(world.settings, workspace.id).values.inferenceSource?.[
        connection.provider
      ] ?? "automatic";
    const matching = connection.assignmentPolicies.filter(
      (policy) =>
        policy.workspaceId === workspace.id &&
        (source === "automatic" || policy.inferencePool === source),
    );
    const hasAllocatableAssignment = matching.some((policy) => policy.allocatorEnabled);
    if (!hasAllocatableAssignment) {
      return {
        requirement: "SUB-ELIG-04",
        message: "the source assignment is excluded from allocation",
      };
    }
    if (
      !matching.some(
        (policy) =>
          policy.allocatorEnabled &&
          (policy.allowedModelIds === null || policy.allowedModelIds.includes(modelId)) &&
          !policy.excludedModelIds?.includes(modelId),
      )
    ) {
      const hasModelAssignment = matching.some(
        (policy) =>
          (policy.allowedModelIds === null || policy.allowedModelIds.includes(modelId)) &&
          !policy.excludedModelIds?.includes(modelId),
      );
      return {
        requirement: hasModelAssignment ? "SUB-ELIG-04" : "SUB-ELIG-03",
        message: hasModelAssignment
          ? "model access exists only on a source assignment excluded from allocation"
          : "no source assignment allows the model",
      };
    }
  }
  if ((connection.modelCooldowns?.[modelId] ?? -Infinity) > now) {
    return { requirement: "SUB-ELIG-03", message: "the account is cooling down for the model" };
  }
  if (!modelAllowed(world, session, modelId)) {
    return { requirement: "SUB-ELIG-02", message: "the workspace does not allow the model" };
  }
  const authorization = authorizationFailure(world, session, connection);
  if (authorization) return authorization;
  if (!hasCapacity(connection, now)) {
    return { requirement: "SUB-FAIL-02", message: "the account has no capacity now" };
  }
  return null;
}

export function canServe(
  world: World,
  session: Session,
  connection: Connection,
  modelId: ModelId,
  now: number,
): boolean {
  return servingFailure(world, session, connection, modelId, now) === null;
}

// Selection

/**
 * Deterministic hash used to spread sessions across accounts (D-21): FNV-1a
 * over the UTF-16 code units, finished with the murmur3 finalizer, because raw
 * FNV-1a orders similar keys unevenly and so spreads unfairly (SUB-SEL-03, D-23).
 */
export function spreadHash(sessionId: string, connectionId: string): number {
  let hash = 0x811c9dc5;
  const key = sessionId + "|" + connectionId;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // murmur3 fmix32
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Rank servable connections for one model. In Primary first the primary takes
 * new work whenever it can serve it, and unknown quota counts as able to serve
 * (D-13, D-14, D-15). Every other choice ranks known capacity before unknown
 * quota (D-14), then a deterministic per-session hash spreads sessions (D-21),
 * then the connection id breaks ties.
 */
function pick(world: World, session: Session, candidates: Connection[]): Connection | null {
  if (candidates.length === 0) return null;
  const provider = candidates[0]!.provider;
  const rotation =
    effectiveSettings(world.settings, session.workspaceId).values.rotation[provider] ??
    ({ mode: "spread" } as Rotation);
  if (rotation.mode === "primary_first") {
    const primary = candidates.find((candidate) => candidate.id === rotation.primaryConnectionId);
    if (primary) return primary;
  }
  const ranked = [...candidates].sort((left, right) => {
    const spread = spreadHash(session.id, left.id) - spreadHash(session.id, right.id);
    if (spread !== 0) return spread;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return ranked[0]!;
}

/**
 * SUB-FAIL-03 and D-16: the reasoning level to run `model` at when the session
 * asked for `requested` on its preferred model `from`.
 *
 * 1. The same level name when the model supports it.
 * 2. Otherwise the model's level whose relative position on its own ladder
 *    (lowest 0, highest 1) is closest to the requested level's relative
 *    position on the preferred model's ladder. A tie goes to the lower level.
 * 3. A level the preferred model does not list has no position and maps to
 *    the middle of the ladder (the lower middle when there are two).
 */
export function nearestReasoningLevel(
  model: Model,
  requested: string,
  from: Model | undefined,
): string {
  const levels = model.reasoningLevels;
  if (levels.includes(requested)) return requested;
  if (levels.length <= 1) return levels[0] ?? "";
  const source = from?.reasoningLevels ?? [];
  const sourceIndex = source.indexOf(requested);
  // The requested position as an exact fraction, so ties are exact.
  const [numerator, denominator] =
    sourceIndex < 0 || source.length <= 1 ? [1, 2] : [sourceIndex, source.length - 1];
  // |index / (levels - 1) - numerator / denominator|, scaled by both denominators.
  const distance = (index: number) =>
    Math.abs(index * denominator - numerator * (levels.length - 1));
  let best = 0;
  for (let index = 1; index < levels.length; index += 1) {
    if (distance(index) < distance(best)) best = index;
  }
  return levels[best]!;
}

/** Candidate models in failover order: the preferred model, then (if allowed) its fallbacks. */
export function candidateModels(world: World, session: Session): ModelId[] {
  const settings = effectiveSettings(world.settings, session.workspaceId).values;
  const preferred = session.preferredModelId;
  if (session.onlyThisModel || session.pinnedConnectionId) return [preferred];
  const preferredProvider = byId(world.models, preferred)?.provider;
  // Same-provider fallback models are always allowed; other providers only
  // when cross-provider failover is on (SUB-FAIL-02, SUB-FAIL-03).
  const fallbacks = (settings.fallbackOrder[preferred] ?? []).filter(
    (modelId, index, all) =>
      modelId !== preferred &&
      all.indexOf(modelId) === index &&
      (byId(world.models, modelId)?.provider === preferredProvider ||
        settings.crossProviderFailover),
  );
  return [preferred, ...fallbacks];
}

/**
 * D-24: an explicit choice that can never serve this session's model: gone,
 * no longer authorized for this work, another provider's account, or not
 * entitled or allowed for the model. Health, allocation, capacity and
 * cooldowns recover, so they never make an explicit choice permanently unusable.
 */
export function pinnedNeverServes(
  world: World,
  session: Session,
  pinned: Connection | undefined,
): boolean {
  if (!pinned) return true;
  const model = byId(world.models, session.preferredModelId);
  if (!model || model.provider !== pinned.provider) return true;
  if (!pinned.entitledModels.includes(model.id)) return true;
  if (pinned.allowedModelIds != null && !pinned.allowedModelIds.includes(model.id)) return true;
  if (pinned.assignmentPolicies !== undefined) {
    const source =
      effectiveSettings(world.settings, session.workspaceId).values.inferenceSource?.[
        pinned.provider
      ] ?? "automatic";
    const assignments = pinned.assignmentPolicies.filter(
      (policy) =>
        policy.workspaceId === session.workspaceId &&
        (source === "automatic" || policy.inferencePool === source),
    );
    if (
      !assignments.some(
        (policy) =>
          (policy.allowedModelIds === null || policy.allowedModelIds.includes(model.id)) &&
          !policy.excludedModelIds?.includes(model.id),
      )
    ) {
      return true;
    }
  }
  return !isAuthorized(world, session, { ...pinned, healthy: true, allocatorEnabled: true });
}

/** Future times at which some quota or model cooldown in the world resets, ascending. */
function futureResetTimes(world: World, now: number): number[] {
  const times = new Set<number>();
  for (const connection of world.connections) {
    if (
      connection.quota.kind === "exhausted" &&
      connection.quota.resetsAt !== null &&
      connection.quota.resetsAt > now
    ) {
      times.add(connection.quota.resetsAt);
    }
    if (connection.refusalUntil != null && connection.refusalUntil > now)
      times.add(connection.refusalUntil);
    for (const until of Object.values(connection.modelCooldowns ?? {})) {
      if (until > now) times.add(until);
    }
  }
  return [...times].sort((left, right) => left - right);
}

/**
 * SUB-WAIT-02, D-22: the earliest future time at which the session could run,
 * assuming nothing else changes; null when no known reset makes it runnable.
 */
export function earliestRunnableAt(
  world: World,
  now: number,
  runnableAt: (at: number) => boolean,
): number | null {
  return futureResetTimes(world, now).find(runnableAt) ?? null;
}

function personalFallbackFor(world: World, session: Session): boolean {
  if (session.ownerId === null) return false;
  const settings = effectiveSettings(world.settings, session.workspaceId).values;
  return (
    (byId(world.workspaces, session.workspaceId)?.kind === "personal" &&
      byId(world.workspaces, session.workspaceId)?.ownerId === session.ownerId) ||
    (settings.personalFallbackAllowed &&
      !!byId(world.people, session.ownerId)?.personalFallbackOptIn)
  );
}

/**
 * The contract's decision for a session that wants to run a turn now. The
 * sender is deliberately not an input: the account belongs to the session
 * (SUB-STICK-01).
 */
export function decide(world: World, sessionId: string, now: number): Decision {
  const session = byId(world.sessions, sessionId);
  if (!session) throw new Error("unknown session " + sessionId);
  const preferredModel = byId(world.models, session.preferredModelId);
  const level = (model: ModelId) =>
    nearestReasoningLevel(byId(world.models, model)!, session.reasoningLevel, preferredModel);
  const run = (connectionId: string, modelId: ModelId, kind: SwitchKind): Decision => ({
    kind: "run",
    connectionId,
    modelId,
    reasoningLevel: level(modelId),
    switch: kind,
  });

  // A restricted preferred model falls through to its allowed failover
  // candidates (SUB-ELIG-02, SUB-WAIT-01, D-17); waiting on the restriction is
  // right only when no candidate is allowed.
  const models = candidateModels(world, session);
  const allowedModels = models.filter((modelId) => modelAllowed(world, session, modelId));
  if (allowedModels.length === 0) {
    return { kind: "wait", reason: "model_not_allowed", earliestResetAt: null };
  }

  // Explicit choice is a pin (SUB-SEL-04, SUB-FAIL-05, SUB-STICK-06).
  if (session.pinnedConnectionId) {
    const pinned = byId(world.connections, session.pinnedConnectionId);
    if (pinned && canServe(world, session, pinned, session.preferredModelId, now)) {
      return run(pinned.id, session.preferredModelId, "pinned");
    }
    // It can never serve this work: explain that instead of waiting silently (D-24).
    if (pinnedNeverServes(world, session, pinned)) {
      return { kind: "wait", reason: "pinned_account_ineligible", earliestResetAt: null };
    }
    // Otherwise the earliest future time the chosen account can serve (D-22).
    return {
      kind: "wait",
      reason: "pinned_account_unavailable",
      earliestResetAt: earliestRunnableAt(world, now, (at) =>
        canServe(world, session, pinned!, session.preferredModelId, at),
      ),
    };
  }

  const binding = session.binding;
  const bound = binding ? byId(world.connections, binding.connectionId) : undefined;
  const personalFallback = personalFallbackFor(world, session);
  const bindingServable =
    !!binding &&
    !!bound &&
    models.includes(binding.modelId) &&
    canServe(world, session, bound, binding.modelId, now);

  // Stickiness while the cache is warm (SUB-STICK-02, SUB-STICK-03, SUB-FAIL-07).
  const includedAlternative = (modelId: string) =>
    world.connections.some(
      (connection) =>
        (connection.ownership.kind === "shared" || personalFallback) &&
        !spendsCredits(connection, now) &&
        canServe(world, session, connection, modelId, now),
    );
  if (
    binding &&
    bound &&
    bindingServable &&
    !session.reselectionPoint &&
    isCacheWarm(world, binding, now) &&
    (!spendsCredits(bound, now) || !includedAlternative(binding.modelId))
  ) {
    return run(binding.connectionId, binding.modelId, "sticky");
  }

  // Order: each candidate model on shared accounts, then (opt-in) on the
  // owner's personal accounts, before moving to the next model (D-12).
  for (const [index, modelId] of models.entries()) {
    const eligible = world.connections.filter(
      (connection) =>
        (connection.ownership.kind === "shared" || personalFallback) &&
        canServe(world, session, connection, modelId, now),
    );
    const included = eligible.filter((connection) => !spendsCredits(connection, now));
    const servable = included.length ? included : eligible;
    const shared = servable.filter((connection) => connection.ownership.kind === "shared");
    const personal = servable.filter((connection) => connection.ownership.kind === "personal");
    const chosen =
      pick(world, session, shared) ?? (personalFallback ? pick(world, session, personal) : null);
    if (!chosen) continue;
    let kind: SwitchKind;
    if (!binding) kind = "initial";
    else if (binding.connectionId === chosen.id && binding.modelId === modelId) kind = "sticky";
    else if (index === 0 && binding.modelId !== modelId) kind = "return_to_preferred";
    else if (index > 0)
      kind =
        byId(world.models, modelId)?.provider ===
        byId(world.models, session.preferredModelId)?.provider
          ? "failover_same_provider"
          : "failover_cross_provider";
    else if (bindingServable) kind = "reselected_cold";
    else kind = "failover_same_provider";
    return run(chosen.id, modelId, kind);
  }
  return {
    kind: "wait",
    reason: "no_eligible_capacity",
    earliestResetAt: earliestRunnableAt(world, now, (at) =>
      allowedModels.some((modelId) =>
        world.connections.some(
          (connection) =>
            (connection.ownership.kind === "shared" || personalFallback) &&
            canServe(world, session, connection, modelId, at),
        ),
      ),
    ),
  };
}

/** Record that a decision ran: the session binds to the chosen account. */
export function applyDecision(
  world: World,
  sessionId: string,
  decision: Decision,
  now: number,
): World {
  if (decision.kind !== "run") return world;
  return {
    ...world,
    sessions: world.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            binding: {
              connectionId: decision.connectionId,
              modelId: decision.modelId,
              lastUsedAt: now,
            },
          }
        : session,
    ),
  };
}

// Invariants

export type InvariantViolation = { requirement: string; message: string };

/**
 * Check any decision (from this model or from production) against the
 * contract's invariants for this world. An empty result means the decision is
 * acceptable; it does not require the decision to equal the model's own.
 */
export function checkDecision(
  world: World,
  sessionId: string,
  now: number,
  decision: Decision,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const session = byId(world.sessions, sessionId)!;
  const settings = effectiveSettings(world.settings, session.workspaceId).values;
  const models = candidateModels(world, session);
  const fail = (requirement: string, message: string) => violations.push({ requirement, message });

  const personalFallback = personalFallbackFor(world, session);
  const servableShared = (modelId: ModelId, credits: boolean) =>
    world.connections.some(
      (connection) =>
        connection.ownership.kind === "shared" &&
        (credits || !spendsCredits(connection, now)) &&
        canServe(world, session, connection, modelId, now),
    );
  const servableAutomatically = (modelId: ModelId) =>
    world.connections.some(
      (connection) =>
        canServe(world, session, connection, modelId, now) &&
        (connection.ownership.kind === "shared" || personalFallback),
    );
  const anyServable = models.some(servableAutomatically);
  const binding = session.binding;
  const bindingWarm = !!binding && !session.reselectionPoint && isCacheWarm(world, binding, now);

  if (decision.kind === "run") {
    const connection = byId(world.connections, decision.connectionId);
    if (!connection) {
      fail("SUB-ELIG-01", "the chosen account does not exist");
      return violations;
    }
    const ineligible = servingFailure(world, session, connection, decision.modelId, now);
    if (ineligible) {
      violations.push(ineligible);
      return violations;
    }
    if (session.pinnedConnectionId && decision.connectionId !== session.pinnedConnectionId) {
      fail("SUB-SEL-04", "a pinned session ran on another account");
    }
    if (!models.includes(decision.modelId)) {
      fail("SUB-FAIL-04", "ran a model outside the allowed failover candidates");
    }
    const crossProvider =
      byId(world.models, decision.modelId)?.provider !==
      byId(world.models, session.preferredModelId)?.provider;
    if (crossProvider && (!settings.crossProviderFailover || session.onlyThisModel)) {
      fail("SUB-FAIL-03", "moved across providers although that is not allowed");
    }
    const expectedLevel = nearestReasoningLevel(
      byId(world.models, decision.modelId)!,
      session.reasoningLevel,
      byId(world.models, session.preferredModelId),
    );
    if (decision.reasoningLevel !== expectedLevel) {
      fail("SUB-FAIL-03", "ran at a reasoning level other than the nearest supported level");
    }
    // Staying on the current account while its cache is warm is always allowed
    // (SUB-STICK-02); every other placement must respect the failover order.
    const stayingWarm =
      !!binding &&
      bindingWarm &&
      binding.connectionId === decision.connectionId &&
      binding.modelId === decision.modelId;
    if (!stayingWarm && !session.pinnedConnectionId) {
      const index = models.indexOf(decision.modelId);
      if (models.slice(0, Math.max(index, 0)).some(servableAutomatically)) {
        fail("SUB-FAIL-02", "skipped an earlier failover candidate that could still run");
      }
      if (
        connection.ownership.kind === "personal" &&
        (!personalFallback || servableShared(decision.modelId, spendsCredits(connection, now)))
      ) {
        fail("SUB-SEL-02", "used a personal account without an explicit choice or opt-in fallback");
      }
    }
    const includedAlternative = (modelId: string) =>
      world.connections.some(
        (candidate) =>
          (candidate.ownership.kind === "shared" || personalFallback) &&
          !spendsCredits(candidate, now) &&
          canServe(world, session, candidate, modelId, now),
      );
    if (
      !session.pinnedConnectionId &&
      spendsCredits(connection, now) &&
      includedAlternative(decision.modelId)
    ) {
      fail("SUB-CREDITS-01", "spent extra credits while an eligible account had included capacity");
    }
    if (binding && bindingWarm && !session.pinnedConnectionId) {
      const bound = byId(world.connections, binding.connectionId);
      const stillServable =
        !!bound &&
        (!spendsCredits(bound, now) || !includedAlternative(binding.modelId)) &&
        models.includes(binding.modelId) &&
        canServe(world, session, bound, binding.modelId, now);
      if (
        stillServable &&
        (decision.connectionId !== binding.connectionId || decision.modelId !== binding.modelId)
      ) {
        fail(
          "SUB-STICK-02",
          "switched account or model while the cache was warm and nothing forced it",
        );
      }
    }
  } else {
    // Only a real workspace model restriction justifies this reason: no
    // candidate model, the preferred one or an allowed fallback, is allowed.
    if (
      decision.reason === "model_not_allowed" &&
      models.some((modelId) => modelAllowed(world, session, modelId))
    ) {
      fail("SUB-WAIT-01", "waited for a model restriction although an allowed model exists");
    }
    const pinned = session.pinnedConnectionId
      ? byId(world.connections, session.pinnedConnectionId)
      : undefined;
    const pinnedServable =
      !!pinned && canServe(world, session, pinned, session.preferredModelId, now);
    if (session.pinnedConnectionId ? pinnedServable : anyServable) {
      fail("SUB-WAIT-01", "waited although an eligible account had capacity");
    }
    // The wait explains itself (SUB-WAIT-02, D-24) and names the earliest time
    // a known reset makes the session runnable (SUB-WAIT-02, D-22).
    const allowedModels = models.filter((modelId) => modelAllowed(world, session, modelId));
    const never = !!session.pinnedConnectionId && pinnedNeverServes(world, session, pinned);
    const expectedReason: WaitReason =
      allowedModels.length === 0
        ? "model_not_allowed"
        : session.pinnedConnectionId
          ? never
            ? "pinned_account_ineligible"
            : "pinned_account_unavailable"
          : "no_eligible_capacity";
    if (decision.reason !== expectedReason) {
      fail(
        never && decision.reason === "pinned_account_unavailable" ? "SUB-ACCESS-06" : "SUB-WAIT-02",
        "explained the wait with " + decision.reason + " instead of " + expectedReason,
      );
    }
    const expectedReset =
      expectedReason === "pinned_account_unavailable"
        ? earliestRunnableAt(world, now, (at) =>
            canServe(world, session, pinned!, session.preferredModelId, at),
          )
        : expectedReason === "no_eligible_capacity"
          ? earliestRunnableAt(world, now, (at) =>
              allowedModels.some((modelId) =>
                world.connections.some(
                  (connection) =>
                    (connection.ownership.kind === "shared" || personalFallback) &&
                    canServe(world, session, connection, modelId, at),
                ),
              ),
            )
          : null;
    if (decision.reason === expectedReason && decision.earliestResetAt !== expectedReset) {
      fail("SUB-WAIT-02", "did not name the earliest time a reset makes the session runnable");
    }
  }
  return violations;
}
