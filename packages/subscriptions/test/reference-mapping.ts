/**
 * Maps a reference-model world (from @opengeni/testing) to the production
 * placement input, and production decisions back to reference decisions.
 *
 * The mapping varies representations that must not change a decision
 * (null vs explicit entitlements, quota encodings, cache-fact kinds, health
 * states), keyed deterministically by connection id, so conformance also
 * exercises those equivalences.
 */
import type {
  Connection as ReferenceConnection,
  World as ReferenceWorld,
} from "@opengeni/testing/subscription-reference-model";
import {
  effectiveSettings,
  spreadHash,
  type CacheFacts,
  type PlacementInput,
  type SubscriptionConnection,
  type SubscriptionQuota,
  type SubscriptionSettingsPolicy,
  type SubscriptionSettingValues,
} from "../src/index";

function variant(id: string, salt: string, choices: number): number {
  return spreadHash(salt, id) % choices;
}

function baseQuota(): SubscriptionQuota {
  return {
    windows: [],
    modelCooldowns: {},
    exhaustedUntil: null,
    exhaustedKind: null,
    revision: 1,
    observedAt: 0,
    observedRefreshGeneration: 1,
    source: "usage_endpoint",
  };
}

function mapQuota(connection: ReferenceConnection, now: number): SubscriptionQuota | null {
  const cooldowns = { ...connection.modelCooldowns };
  const hasCooldowns = Object.keys(cooldowns).length > 0;
  const shape = variant(connection.id, "quota-shape", 3);
  const quota = connection.quota;
  if (quota.kind === "unknown") {
    if (shape === 0 && !hasCooldowns) return null;
    return {
      ...baseQuota(),
      windows:
        shape === 1
          ? [{ id: "primary", usedPercent: null, resetsAt: null, status: "unknown" }]
          : [],
      modelCooldowns: cooldowns,
      observedAt: null,
    };
  }
  if (quota.kind === "available") {
    return {
      ...baseQuota(),
      windows: [
        {
          id: "primary",
          usedPercent: shape === 2 ? 92 : 35,
          resetsAt: now + 3_600_000,
          status: shape === 2 ? "warning" : "ok",
        },
        ...(shape === 1
          ? [{ id: "secondary", usedPercent: null, resetsAt: null, status: "unknown" as const }]
          : []),
      ],
      modelCooldowns: cooldowns,
    };
  }
  // Exhausted: either a deadline, an exhausted window, or both.
  return {
    ...baseQuota(),
    exhaustedUntil: shape === 1 ? null : quota.resetsAt,
    exhaustedKind: shape === 1 ? null : "quota",
    windows:
      shape === 0
        ? []
        : [{ id: "primary", usedPercent: 100, resetsAt: quota.resetsAt, status: "exhausted" }],
    modelCooldowns: cooldowns,
    source: "refusal",
  };
}

function mapConnection(connection: ReferenceConnection, now: number): SubscriptionConnection {
  const providerModelsEntitled = connection.entitledModels;
  const ownership = connection.ownership;
  return {
    id: connection.id,
    provider: connection.provider,
    kind: "subscription",
    ownership:
      ownership.kind === "personal"
        ? { kind: "personal", ownerMembershipId: ownership.ownerId }
        : {
            kind: "shared",
            managedByWorkspaceId: null,
            scope:
              ownership.scope.kind === "organization"
                ? { kind: "organization" }
                : ownership.scope.kind === "workspaces"
                  ? {
                      kind: "workspaces",
                      workspaceIds: ownership.scope.workspaceIds,
                      allowPersonalWorkspaces: ownership.scope.personalWorkspaces,
                    }
                  : { kind: "people", membershipIds: ownership.scope.personIds },
          },
    health: connection.healthy
      ? "healthy"
      : variant(connection.id, "health", 2) === 0
        ? "needs_reconnect"
        : "error",
    allocatorEnabled: connection.allocatorEnabled,
    entitledModelIds: providerModelsEntitled,
    excludedModelIds: [],
    allowedModelIds: connection.allowedModelIds ?? null,
    refreshGeneration: 1,
    quota: mapQuota(connection, now),
  };
}

function mapSettings(
  settings: ReferenceWorld["settings"]["organization"],
): SubscriptionSettingValues {
  return {
    rotation: settings.rotation,
    providers: {},
    crossProviderFailover: settings.crossProviderFailover,
    fallbackOrder: settings.fallbackOrder,
    personalConnectionsAllowed: settings.personalConnectionsAllowed,
    personalFallbackAllowed: settings.personalFallbackAllowed,
  };
}

export function mapSettingsPolicy(world: ReferenceWorld): SubscriptionSettingsPolicy {
  return {
    organization: mapSettings(world.settings.organization),
    locked: world.settings.locked,
    workspaces: Object.fromEntries(
      Object.entries(world.settings.workspaceOverrides).map(([workspaceId, override]) => [
        workspaceId,
        { ...override } as Partial<SubscriptionSettingValues>,
      ]),
    ),
  };
}

/** The production placement input equivalent to one reference world and session. */
export function toPlacementInput(
  world: ReferenceWorld,
  sessionId: string,
  now: number,
): PlacementInput {
  const session = world.sessions.find((candidate) => candidate.id === sessionId)!;
  const workspace = world.workspaces.find((candidate) => candidate.id === session.workspaceId)!;
  const connections = world.connections.map((connection) => mapConnection(connection, now));
  const providers = [...new Set(world.models.map((model) => model.provider))];
  const cacheFacts: Record<string, CacheFacts> = {};
  for (const provider of providers) {
    const ttl = world.cacheTtlMs[provider];
    // The reference treats a provider without a lifetime as never warm.
    cacheFacts[provider] =
      ttl === undefined
        ? { kind: "exact_ttl", ttlMs: 0 }
        : variant(provider, "cache", 2) === 0
          ? { kind: "exact_ttl", ttlMs: ttl }
          : { kind: "measured_idle_cutoff", cutoffMs: ttl };
  }
  const pinned = session.pinnedConnectionId
    ? world.connections.find((connection) => connection.id === session.pinnedConnectionId)
    : undefined;
  const boundConnection = session.binding
    ? world.connections.find((connection) => connection.id === session.binding!.connectionId)
    : undefined;
  return {
    now,
    workspace: {
      id: workspace.id,
      kind: workspace.kind,
      ownerMembershipId: workspace.ownerId,
      allowedModelIds: workspace.allowedModels,
    },
    session: {
      id: session.id,
      workspaceId: session.workspaceId,
      visibility: session.visibility,
      ownerMembershipId: session.ownerId,
      preferredModelId: session.preferredModelId,
      reasoningLevel: session.reasoningLevel,
      binding: session.pinnedConnectionId
        ? {
            connectionId: session.pinnedConnectionId,
            provider: pinned?.provider ?? "unknown",
            modelId: session.preferredModelId,
            choice: "explicit",
            lastModelCallAt: session.binding?.lastUsedAt ?? 0,
          }
        : session.binding
          ? {
              connectionId: session.binding.connectionId,
              provider: boundConnection?.provider ?? "unknown",
              modelId: session.binding.modelId,
              choice: "automatic",
              lastModelCallAt: session.binding.lastUsedAt,
            }
          : null,
      onlyThisModel: session.onlyThisModel,
      reselectionPoints: session.reselectionPoint
        ? [variant(session.id, "reselection", 2) === 0 ? "compaction_completed" : "model_changed"]
        : [],
      // The reference has no accepted-authority concept: the owner's work
      // carries personal authority for every provider.
      personalAuthority: providers.map((provider) => ({
        provider,
        ownerMembershipId: session.ownerId,
      })),
      compactionProviderLock: null,
    },
    settings: effectiveSettings(mapSettingsPolicy(world), workspace.id).values,
    people: world.people.map((person) => ({
      membershipId: person.id,
      active: person.active,
      personalFallbackOptIn: person.personalFallbackOptIn,
    })),
    models: world.models,
    connections,
    cacheFacts,
  };
}
