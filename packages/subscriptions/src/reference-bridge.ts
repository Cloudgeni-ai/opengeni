/**
 * Bridge from the production placement input to the independent reference
 * model, so the reference `checkDecision` can judge a production decision for
 * a real world (the worker's shadow comparison). It maps the production
 * concepts the reference model does not have onto ones it does, using only the
 * raw inputs, never the production eligibility or placement functions, so a
 * policy bug cannot hide from the checker:
 *
 * - A provider switched off, a compaction provider lock and the workspace
 *   model ceiling become the workspace's allowed model list.
 * - Shared connections a workspace does not manage while organization
 *   accounts are off, and personal connections without frozen personal
 *   authority for their provider, are left out (nothing may use them).
 * - Quota and cache lifetimes are decoded here, independently of the
 *   production decoders, from the raw shared quota model (design 2.2) and
 *   cache facts (design 6.1), including the input's staleness bounds. An
 *   exhaustion with no known reset can never become servable by time alone, so
 *   it is presented as excluded from allocation.
 * - An exact cache lifetime on the binding is that provider's lifetime.
 * - An explicit binding is the reference model's pin.
 */
import * as reference from "./reference-model";
import { inferenceSourceFor } from "./settings";
import type {
  CacheFacts,
  PlacementDecision,
  PlacementInput,
  SubscriptionConnection,
  SubscriptionQuota,
} from "./types";

/** Design 6.1: an unmeasured idle cut-off counts as one hour. */
const UNMEASURED_CUTOFF_MS = 3_600_000;

function lifetimeOf(facts: CacheFacts | undefined): number {
  if (facts?.kind === "exact_ttl") return Math.max(0, facts.ttlMs);
  return Math.max(0, facts?.cutoffMs ?? UNMEASURED_CUTOFF_MS);
}

type DecodedQuota = reference.Quota | { kind: "exhausted_without_reset" };

/**
 * Design 2.2 read from the raw fields: a running deadline or exhausted
 * window is exhaustion until its latest reset; any fresh observed window, an
 * exhausted window whose reset passed, or a passed quota deadline is known
 * capacity; nothing else is known (SUB-ELIG-06).
 */
function decodeQuota(
  quota: SubscriptionQuota | null,
  now: number,
  staleAfterMs: number | undefined,
): DecodedQuota {
  if (quota === null) return { kind: "unknown" };
  const fresh =
    staleAfterMs === undefined ||
    (quota.observedAt !== null && now - quota.observedAt <= staleAfterMs);
  const blockingResets: (number | null)[] = [];
  if (quota.exhaustedUntil !== null && quota.exhaustedUntil > now) {
    blockingResets.push(quota.exhaustedUntil);
  }
  for (const window of quota.windows) {
    if (window.status === "exhausted" && (window.resetsAt === null || window.resetsAt > now)) {
      blockingResets.push(window.resetsAt);
    }
  }
  if (blockingResets.length > 0) {
    return blockingResets.includes(null)
      ? { kind: "exhausted_without_reset" }
      : { kind: "exhausted", resetsAt: Math.max(...(blockingResets as number[])) };
  }
  const observed =
    quota.windows.some((window) => window.status !== "unknown") ||
    (quota.exhaustedUntil !== null && quota.exhaustedKind === "quota");
  return observed && fresh ? { kind: "available" } : { kind: "unknown" };
}

function referenceConnection(
  input: PlacementInput,
  connection: SubscriptionConnection,
): reference.Connection {
  const providerModels = input.models
    .filter((model) => model.provider === connection.provider)
    .map((model) => model.id);
  const entitled = (connection.entitledModelIds ?? providerModels).filter(
    (modelId) => !connection.excludedModelIds.includes(modelId),
  );
  const capacity = decodeQuota(
    connection.quota,
    input.now,
    input.quotaStaleAfterMs?.[connection.provider],
  );
  const ownership: reference.Connection["ownership"] =
    connection.ownership.kind === "personal"
      ? { kind: "personal", ownerId: connection.ownership.ownerMembershipId }
      : {
          kind: "shared",
          scope:
            connection.ownership.scope.kind === "organization"
              ? { kind: "organization" }
              : connection.ownership.scope.kind === "workspaces"
                ? {
                    kind: "workspaces",
                    workspaceIds: connection.ownership.scope.workspaceIds,
                    personalWorkspaces: connection.ownership.scope.allowPersonalWorkspaces,
                  }
                : { kind: "people", personIds: connection.ownership.scope.membershipIds },
        };
  return {
    id: connection.id,
    provider: connection.provider,
    ownership,
    healthy: connection.health === "healthy",
    allocatorEnabled: connection.allocatorEnabled && capacity.kind !== "exhausted_without_reset",
    entitledModels: entitled,
    allowedModelIds: connection.allowedModelIds,
    ...(connection.assignmentPolicies === undefined
      ? {}
      : { assignmentPolicies: connection.assignmentPolicies }),
    modelCooldowns: { ...connection.quota?.modelCooldowns },
    quota: capacity.kind === "exhausted_without_reset" ? { kind: "unknown" } : capacity,
  };
}

/** The reference world equivalent to one production placement input. */
export function toReferenceWorld(input: PlacementInput): {
  world: reference.World;
  sessionId: string;
} {
  const { session, settings, workspace } = input;
  const switches = (provider: string) => settings.providers[provider];
  const ceiling = input.models
    .filter(
      (model) =>
        (workspace.allowedModelIds === null || workspace.allowedModelIds.includes(model.id)) &&
        switches(model.provider)?.enabled !== false &&
        (session.compactionProviderLock === null ||
          model.provider === session.compactionProviderLock),
    )
    .map((model) => model.id);
  const usable = input.connections.filter((connection) => {
    if (connection.ownership.kind === "personal") {
      const owner = connection.ownership.ownerMembershipId;
      return session.personalAuthority.some(
        (authority) =>
          authority.provider === connection.provider && authority.ownerMembershipId === owner,
      );
    }
    if (connection.assignmentPolicies !== undefined) return true;
    const source = inferenceSourceFor(settings, connection.provider);
    const managedHere = connection.ownership.managedByWorkspaceId === workspace.id;
    if (source === "workspace") return managedHere;
    if (source === "organization") return !managedHere;
    return switches(connection.provider)?.useOrganizationAccounts !== false || managedHere;
  });
  const providers = new Set([
    ...input.models.map((model) => model.provider),
    ...input.connections.map((connection) => connection.provider),
  ]);
  const binding = session.binding;
  return {
    sessionId: session.id,
    world: {
      settings: {
        organization: {
          rotation: settings.rotation,
          inferenceSource: Object.fromEntries(
            [...providers].map((provider) => [provider, inferenceSourceFor(settings, provider)]),
          ),
          crossProviderFailover: settings.crossProviderFailover,
          fallbackOrder: Object.fromEntries(
            Object.entries(settings.fallbackOrder).map(([modelId, order]) => [modelId, [...order]]),
          ),
          personalConnectionsAllowed: settings.personalConnectionsAllowed,
          personalFallbackAllowed: settings.personalFallbackAllowed,
        },
        locked: [],
        workspaceOverrides: {},
      },
      workspaces: [
        {
          id: workspace.id,
          kind: workspace.kind,
          ownerId: workspace.ownerMembershipId,
          allowedModels: ceiling,
        },
      ],
      people: input.people.map((person) => ({
        id: person.membershipId,
        active: person.active,
        personalFallbackOptIn: person.personalFallbackOptIn,
      })),
      models: input.models,
      connections: usable.map((connection) => referenceConnection(input, connection)),
      sessions: [
        {
          id: session.id,
          workspaceId: session.workspaceId,
          visibility: session.visibility,
          ownerId: session.ownerMembershipId,
          preferredModelId: session.preferredModelId,
          reasoningLevel: session.reasoningLevel,
          binding: binding
            ? {
                connectionId: binding.connectionId,
                modelId: binding.modelId,
                lastUsedAt: binding.lastModelCallAt,
              }
            : null,
          pinnedConnectionId: binding?.choice === "explicit" ? binding.connectionId : null,
          onlyThisModel: session.onlyThisModel,
          reselectionPoint: session.reselectionPoints.length > 0,
        },
      ],
      cacheTtlMs: Object.fromEntries(
        [...providers].map((provider) => [
          provider,
          binding?.cacheTtlMs != null &&
          input.connections.find((connection) => connection.id === binding.connectionId)
            ?.provider === provider
            ? Math.max(0, binding.cacheTtlMs)
            : lifetimeOf(input.cacheFacts[provider]),
        ]),
      ),
    },
  };
}

/**
 * The reference-shaped view of a production decision on this input. A wait
 * the production policy explains with the compaction lock is, to the
 * reference model (which sees the lock as a model restriction), a wait on the
 * restriction when no candidate model is left, else a wait for capacity.
 */
export function toReferenceDecision(
  decision: PlacementDecision,
  input: PlacementInput,
): reference.Decision {
  if (decision.kind === "run") {
    return {
      kind: "run",
      connectionId: decision.connectionId,
      modelId: decision.modelId,
      reasoningLevel: decision.reasoningLevel,
      switch: decision.switch,
    };
  }
  if (decision.reason !== "compaction_provider_locked") {
    return { kind: "wait", reason: decision.reason, earliestResetAt: decision.earliestResetAt };
  }
  const { world, sessionId } = toReferenceWorld(input);
  const session = world.sessions.find((candidate) => candidate.id === sessionId)!;
  const allowed = world.workspaces[0]!.allowedModels;
  const anyAllowed = reference
    .candidateModels(world, session)
    .some((modelId) => allowed === null || allowed.includes(modelId));
  return {
    kind: "wait",
    reason: anyAllowed ? "no_eligible_capacity" : "model_not_allowed",
    earliestResetAt: decision.earliestResetAt,
  };
}

/** The reference model's invariant violations for a production decision on this input. */
export function checkPlacementDecision(
  input: PlacementInput,
  decision: PlacementDecision,
): reference.InvariantViolation[] {
  const { world, sessionId } = toReferenceWorld(input);
  return reference.checkDecision(world, sessionId, input.now, toReferenceDecision(decision, input));
}
