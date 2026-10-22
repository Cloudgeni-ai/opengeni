import { sql } from "drizzle-orm";
import {
  bindingStickiness,
  connectionIneligibility,
  connectionUsesExtraCredits,
  decidePlacement,
  failoverCandidateModels,
  mapReasoningLevel,
  modelPermitted,
  type PlacementDecision,
  type PlacementInput,
  type PlacementSwitch,
} from "@opengeni/subscriptions";
import { rawRows, type Database } from "../database";
import { withSubscriptionCoreAcceptedTurn } from "../subscription-core-placement-world";
import {
  acquireSubscriptionTurnLease,
  advanceSubscriptionBindingCacheClock,
  isSubscriptionSessionBindingRollingConflict,
  readSubscriptionSessionBinding,
  releaseSubscriptionTurnLease,
  writeSubscriptionSessionBinding,
} from "../subscription-core-repository";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";
import {
  subscriptionCoreTurns,
  type SubscriptionCorePlacement,
  type SubscriptionCorePlacementEvaluation,
  type SubscriptionCorePlacementRequest,
  type SubscriptionCoreTurnIdentity,
} from "./turns";
import {
  policyBinding,
  withSubscriptionCoreFailoverPlacementWorld,
  type SubscriptionCoreFailoverWorld,
  type SubscriptionCoreFailoverWorldRequest,
} from "./failover-world";

export type SubscriptionCoreFailoverRequest = SubscriptionCorePlacementRequest &
  SubscriptionCoreFailoverWorldRequest;
type Selection = { provider: string; modelId: string; reasoningLevel: string };
/** Dormant B1 boundary only. C2 must surface this configuration diagnostic
 * instead of claiming all-provider capacity exhaustion; home retry deadlines
 * remain valid. Do not synthesize a target, tier or new accepted authority.
 */
type WithMappingReason<T> = T extends { kind: "wait"; reason: string }
  ? Omit<T, "reason"> & { reason: T["reason"] | "failover_no_model_mapping" }
  : T;
export type SubscriptionCoreFailoverPlacement = WithMappingReason<SubscriptionCorePlacement> &
  Partial<Selection> & { candidateProviders?: string[] };
export type SubscriptionCoreFailoverEvaluation =
  WithMappingReason<SubscriptionCorePlacementEvaluation> &
    Partial<Selection> & { candidateProviders?: string[] };

function failoverWaitReason(
  reason: Extract<PlacementDecision, { kind: "wait" }>["reason"],
  world: SubscriptionCoreFailoverWorld,
) {
  return world.noModelMapping &&
    (reason === "no_eligible_capacity" || reason === "model_not_allowed")
    ? ("failover_no_model_mapping" as const)
    : reason;
}

class SubscriptionBindingConflict extends Error {}
const BINDING_CONFLICT_RETRIES = 3;
const FAILOVER_WAITS = new Set([
  "no_eligible_capacity",
  "model_not_allowed",
  "compaction_provider_locked",
]);

/** Parity copy from turns.ts, kept local until the M4 stacks can share it. */
export async function readAttemptFence(
  tx: Database,
  request: SubscriptionCorePlacementRequest,
): Promise<boolean> {
  const { identity } = request;
  const [row] = await rawRows<{
    status: string;
    active_attempt_id: string | null;
    execution_generation: number | string;
    session_status: string;
    active_turn_id: string | null;
  }>(
    tx,
    sql`select turn.status, turn.active_attempt_id::text as active_attempt_id,
    turn.execution_generation, session.status as session_status, session.active_turn_id::text as active_turn_id
    from session_turns turn join sessions session on session.account_id = turn.account_id
      and session.workspace_id = turn.workspace_id and session.id = turn.session_id
    where turn.account_id = ${identity.accountId}::uuid and turn.workspace_id = ${identity.workspaceId}::uuid
      and turn.session_id = ${identity.sessionId}::uuid and turn.id = ${identity.turnId}::uuid limit 1`,
  );
  return (
    row !== undefined &&
    row.status === "running" &&
    row.session_status === "running" &&
    row.active_turn_id === identity.turnId &&
    row.active_attempt_id === request.attemptId &&
    Number(row.execution_generation) === request.executionGeneration
  );
}

/** Read whatever provider owns this turn's single lease; do not invent a home lease. */
async function readTurnLease(tx: Database, identity: SubscriptionCoreTurnIdentity) {
  const [row] = await rawRows<{
    connection_id: string;
    provider: string;
    holder_id: string;
    generation: number | string;
    leased_until: Date | string;
    live: boolean;
  }>(
    tx,
    sql`select connection_id::text, provider, holder_id, generation, leased_until,
    leased_until > clock_timestamp() as live from subscription_leases
    where account_id = ${identity.accountId}::uuid and workspace_id = ${identity.workspaceId}::uuid
      and session_id = ${identity.sessionId}::uuid and turn_id = ${identity.turnId}::uuid`,
  );
  return row
    ? {
        provider: row.provider,
        connectionId: row.connection_id,
        holderId: row.holder_id,
        generation: Number(row.generation),
        leasedUntil: new Date(row.leased_until),
        live: row.live,
      }
    : null;
}

function leaseFence(
  existing: Awaited<ReturnType<typeof readTurnLease>>,
  request: SubscriptionCorePlacementRequest,
): SubscriptionCorePlacement | null {
  if (
    !existing ||
    (existing.holderId === request.holderId && existing.generation === request.executionGeneration)
  )
    return null;
  if (existing.generation >= request.executionGeneration) return { kind: "attempt_fenced" };
  return existing.live ? { kind: "lease_busy", leasedUntil: existing.leasedUntil } : null;
}

/** D-33 router: when disabled or pinned, delegate unchanged. Otherwise keep a
 * serving fallback out of the home-only path and retry the WHOLE world after
 * a home capacity wait. No first caller/worker wiring is installed by B1.
 */
export async function placeSubscriptionCoreTurnWithFailover(
  db: Database,
  home: SubscriptionCoreProvider,
  request: SubscriptionCoreFailoverRequest,
): Promise<SubscriptionCoreFailoverPlacement> {
  if (!Number.isSafeInteger(request.executionGeneration) || request.executionGeneration < 1)
    throw new Error("Failover placement requires a positive execution generation");
  // The route probe, foreign-lease cleanup and home-only placement must
  // share the same session fence as cross-provider placement. Otherwise a
  // concurrent caller can switch the lease between those transactions and
  // send a foreign lease into the home-only reader. Nested RLS scopes use
  // savepoints on this transaction, so the fence survives every branch.
  const result = await withSubscriptionCoreAcceptedTurn(db, request.identity, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`subscription-failover:${request.identity.workspaceId}:${request.identity.sessionId}`}, 0))`);
    return placeSubscriptionCoreTurnWithFailoverLocked(tx, home, request);
  });
  return result.status === "not_visible" ? { kind: "not_visible" } : result.value;
}

async function placeSubscriptionCoreTurnWithFailoverLocked(
  db: Database,
  home: SubscriptionCoreProvider,
  request: SubscriptionCoreFailoverRequest,
): Promise<SubscriptionCoreFailoverPlacement> {
  const homeId = subscriptionCoreProviderId(home);
  const homePlacement = async (): Promise<SubscriptionCorePlacement> => {
    // An old cross-provider lease must never reach M4's home-only reader.
    // DELETE takes no connection lock. Keep its ordinary fencing rules.
    const settled = await withSubscriptionCoreAcceptedTurn(db, request.identity, async (tx) => {
      if (!(await readAttemptFence(tx, request))) return { kind: "attempt_fenced" } as const;
      const existing = await readTurnLease(tx, request.identity);
      if (!existing || existing.provider === homeId) return null;
      const fence = leaseFence(existing, request);
      if (fence) return fence;
      await releaseSubscriptionTurnLease(tx, {
        ...request.identity,
        provider: existing.provider,
        connectionId: existing.connectionId,
        holderId: existing.holderId,
        generation: existing.generation,
      });
      return null;
    });
    if (settled.status === "not_visible") return { kind: "not_visible" };
    if (settled.value) return settled.value;
    return subscriptionCoreTurns(home).placeSubscriptionCoreTurn(db, request);
  };
  if (request.crossProviderFailoverEnabled !== true) return homePlacement();
  const route = await withSubscriptionCoreFailoverPlacementWorld(
    db,
    home,
    request,
    false,
    async (tx, world) => {
      const lease = await readTurnLease(tx, request.identity);
      return (
        world.serving.modelId !== request.productModelId ||
        (lease !== null && lease.provider !== homeId)
      );
    },
  );
  if (route.status === "not_visible") return { kind: "not_visible" };
  if (route.status === "home_only") return homePlacement();
  if (!route.value) {
    const result = await homePlacement();
    if (result.kind !== "wait" || !FAILOVER_WAITS.has(result.reason)) return result;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await placeFailoverOnce(db, home, request);
      return result === null ? homePlacement() : result;
    } catch (error) {
      if (!(error instanceof SubscriptionBindingConflict)) throw error;
      if (attempt >= BINDING_CONFLICT_RETRIES)
        return { kind: "lease_busy", leasedUntil: null, cause: "binding_conflict" };
    }
  }
}

function stickyDecision(
  input: PlacementInput,
  connectionId: string,
  modelId: string,
): Extract<PlacementDecision, { kind: "run" }> {
  const connection = input.connections.find((row) => row.id === connectionId)!;
  return {
    kind: "run",
    connectionId,
    provider: connection.provider,
    modelId,
    reasoningLevel: mapReasoningLevel(
      input.session.reasoningLevel,
      input.models.find((model) => model.id === input.session.preferredModelId),
      input.models.find((model) => model.id === modelId)!,
    ),
    personal: connection.ownership.kind === "personal",
    switch: "sticky",
  };
}

function canReuse(input: PlacementInput, connectionId: string, modelId: string): boolean {
  const connection = input.connections.find((row) => row.id === connectionId);
  return (
    connection !== undefined &&
    failoverCandidateModels(input).includes(modelId) &&
    modelPermitted(input, modelId) &&
    connectionIneligibility(input, connection, modelId).length === 0 &&
    !connectionUsesExtraCredits(input, connection)
  );
}

function decisionFor(world: SubscriptionCoreFailoverWorld): PlacementDecision {
  const { input, serving } = world;
  const binding = input.session.binding;
  // A later attempt of THIS turn keeps its configured serving model unless
  // forced away; a cold cache alone must not bounce one turn home.
  if (
    serving.thisTurn &&
    binding &&
    binding.modelId === serving.modelId &&
    input.session.reselectionPoints.length === 0 &&
    canReuse(input, binding.connectionId, binding.modelId)
  )
    return stickyDecision(input, binding.connectionId, binding.modelId);
  return decidePlacement(input);
}

async function placeFailoverOnce(
  db: Database,
  home: SubscriptionCoreProvider,
  request: SubscriptionCoreFailoverRequest,
): Promise<SubscriptionCoreFailoverPlacement | null> {
  const { identity } = request;
  const result = await withSubscriptionCoreFailoverPlacementWorld(
    db,
    home,
    request,
    true,
    async (tx, world): Promise<SubscriptionCoreFailoverPlacement> => {
      if (!(await readAttemptFence(tx, request))) return { kind: "attempt_fenced" };
      const { input } = world;
      const existing = await readTurnLease(tx, identity);
      const fence = leaseFence(existing, request);
      if (fence) return fence;
      const modelId =
        existing?.provider === world.serving.provider
          ? world.serving.modelId
          : existing
            ? world.bindings.get(existing.provider)?.modelId
            : undefined;
      const reuse =
        existing?.live &&
        existing.holderId === request.holderId &&
        existing.generation === request.executionGeneration &&
        modelId &&
        canReuse(input, existing.connectionId, modelId)
          ? existing.connectionId
          : null;
      const decision = reuse ? stickyDecision(input, reuse, modelId!) : decisionFor(world);
      const stickiness = reuse ? null : bindingStickiness(input);
      if (
        existing &&
        (decision.kind !== "run" ||
          decision.connectionId !== existing.connectionId ||
          (!existing.live &&
            existing.holderId === request.holderId &&
            existing.generation === request.executionGeneration))
      )
        await releaseSubscriptionTurnLease(tx, {
          ...identity,
          provider: existing.provider,
          connectionId: existing.connectionId,
          holderId: existing.holderId,
          generation: existing.generation,
        });
      if (decision.kind === "wait")
        return {
          kind: "wait",
          reason: failoverWaitReason(decision.reason, world),
          earliestResetAt:
            decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
          healthRetryAt: await earliestHealthRetryAtAcrossProviders(tx, identity, world),
          explicitConnectionId: null,
          candidateProviders: world.candidateProviders,
        };
      const connection = input.connections.find((row) => row.id === decision.connectionId);
      if (!connection) throw new Error("Failover chose a connection outside its world");
      const acquired = await acquireSubscriptionTurnLease(tx, {
        ...identity,
        provider: decision.provider,
        connectionId: decision.connectionId,
        holderId: request.holderId,
        generation: request.executionGeneration,
        ttlMs: request.leaseTtlMs,
      });
      if (!acquired) return { kind: "lease_busy", leasedUntil: existing?.leasedUntil ?? null };
      const targetBinding = world.bindings.get(decision.provider) ?? null;
      const placementSwitch =
        decision.switch === "initial" && decision.modelId !== request.productModelId
          ? decision.provider === subscriptionCoreProviderId(home)
            ? "failover_same_provider"
            : "failover_cross_provider"
          : decision.switch;
      if (identity.sessionOwnerSubjectId)
        await commitBinding(tx, identity, decision.provider, {
          decidedFrom: policyBinding(targetBinding),
          clockDecided:
            world.serving.provider === decision.provider &&
            stickiness?.kind === "reselect" &&
            (stickiness.reason === "cache_cold" || stickiness.reason === "reselection_point"),
          connectionId: decision.connectionId,
          modelId: decision.modelId,
          placementSwitch,
          now: new Date(input.now),
          restartClock: !reuse,
        });
      return {
        kind: "run",
        provider: decision.provider,
        modelId: decision.modelId,
        reasoningLevel: decision.reasoningLevel,
        candidateProviders: world.candidateProviders,
        connectionId: connection.id,
        personal: connection.ownership.kind === "personal",
        switch: placementSwitch,
        reusedLease: reuse === connection.id,
        explicit: targetBinding?.choice === "explicit",
        previousConnectionId: input.session.binding?.connectionId ?? null,
        rotationMode: input.settings.rotation[decision.provider]?.mode ?? "spread",
        refreshGeneration: connection.refreshGeneration,
        leasedUntil: acquired.leasedUntil,
        eligibleCount: input.connections.filter(
          (row) => connectionIneligibility(input, row, decision.modelId).length === 0,
        ).length,
        connectedCount: input.connections.length,
        reselection:
          stickiness?.kind === "reselect"
            ? {
                reason: stickiness.reason,
                ineligibility: stickiness.ineligibility,
                points: stickiness.points,
              }
            : null,
      };
    },
  );
  return result.status === "home_only"
    ? null
    : result.status === "not_visible"
      ? { kind: "not_visible" }
      : result.value;
}

/** Read-only evaluation never acquires a binding lock or a lease. */
export async function evaluateSubscriptionCorePlacementWithFailover(
  db: Database,
  home: SubscriptionCoreProvider,
  request: SubscriptionCoreFailoverWorldRequest,
): Promise<SubscriptionCoreFailoverEvaluation> {
  const result = await withSubscriptionCoreFailoverPlacementWorld(
    db,
    home,
    request,
    false,
    async (tx, world): Promise<SubscriptionCoreFailoverEvaluation> => {
      const decision = decisionFor(world);
      return decision.kind === "run"
        ? { ...decision, candidateProviders: world.candidateProviders }
        : {
            kind: "wait",
            reason: failoverWaitReason(decision.reason, world),
            earliestResetAt:
              decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
            healthRetryAt: await earliestHealthRetryAtAcrossProviders(tx, request.identity, world),
            explicitConnectionId: null,
            candidateProviders: world.candidateProviders,
          };
    },
  );
  return result.status === "home_only"
    ? subscriptionCoreTurns(home).evaluateSubscriptionCorePlacement(db, request)
    : result.status === "not_visible"
      ? { kind: "not_visible" }
      : result.value;
}

/** D-39 sums ledger evidence directly, including providers held or removed. */
export async function countSubscriptionCoreTurnRefusalsAcrossProviders(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<number | null> {
  const result = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    const [row] = await rawRows<{ refusals: string | number }>(
      tx,
      sql`
      select coalesce(sum(coalesce((recovery_evidence->>'refusals')::integer, 1)), 0) as refusals
      from subscription_turn_failures where account_id = ${identity.accountId}::uuid
        and workspace_id = ${identity.workspaceId}::uuid and session_id = ${identity.sessionId}::uuid
        and turn_id = ${identity.turnId}::uuid`,
    );
    const count = Number(row?.refusals);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid turn refusal count");
    return count;
  });
  return result.status === "completed" ? result.value : null;
}

/** Scoped to eligible candidate providers, never legacy/held capacity. Personal
 * quarantine visibility remains subject to app-role RLS, as in M4. */
export async function earliestHealthRetryAtAcrossProviders(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
  world: Pick<SubscriptionCoreFailoverWorld, "providers" | "candidateProviders">,
): Promise<Date | null> {
  const deadlines: number[] = [];
  for (const providerId of world.candidateProviders) {
    const kind = subscriptionCoreConnectionKind(world.providers.get(providerId)!);
    const [row] = await rawRows<{ retry_at: Date | string | null }>(
      tx,
      sql`
      select min(retry_at) as retry_at from (
        select health_retry_at as retry_at from subscription_connections
          where account_id = ${identity.accountId}::uuid and provider = ${providerId} and kind = ${kind}
            and status = 'error' and health_retry_at > clock_timestamp()
        union all select quota.model_catalog_expires_at from subscription_connection_quota quota
          join subscription_connections connection on connection.id = quota.connection_id and connection.account_id = quota.account_id
          where connection.account_id = ${identity.accountId}::uuid and connection.provider = ${providerId}
            and connection.kind = ${kind} and connection.status = 'active' and connection.allocator_enabled
            and quota.model_catalog_refresh_generation = connection.refresh_generation
            and quota.model_catalog_expires_at > clock_timestamp()
      ) deadlines`,
    );
    if (row?.retry_at) deadlines.push(new Date(row.retry_at).getTime());
  }
  return deadlines.length ? new Date(Math.min(...deadlines)) : null;
}

/** Parity copy of M4 commitBinding: target row ONLY, immutable provider/pin,
 * compare-and-swap first insert, per-provider clock. All candidate rows were
 * locked before the lease's single connection lock. */
export async function commitBinding(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
  providerId: string,
  next: {
    decidedFrom: PlacementInput["session"]["binding"];
    clockDecided: boolean;
    connectionId: string;
    modelId: string;
    placementSwitch: PlacementSwitch;
    now: Date;
    restartClock: boolean;
  },
): Promise<void> {
  const current = await readSubscriptionSessionBinding(tx, {
    ...identity,
    provider: providerId,
    forUpdate: true,
  });
  const seen = current?.connectionId ? current : null;
  const decided = next.decidedFrom;
  const unchanged =
    seen === null
      ? decided === null
      : decided !== null &&
        seen.connectionId === decided.connectionId &&
        seen.provider === decided.provider &&
        seen.modelId === decided.modelId &&
        seen.choice === decided.choice &&
        (next.clockDecided
          ? (seen.lastModelCallAt?.getTime() ?? 0) === decided.lastModelCallAt
          : (seen.lastModelCallAt?.getTime() ?? 0) >= decided.lastModelCallAt);
  if (!unchanged || (current?.choice === "explicit" && current.connectionId === null))
    throw new SubscriptionBindingConflict();
  if (current && current.connectionId === next.connectionId && current.modelId === next.modelId) {
    await advanceSubscriptionBindingCacheClock(tx, {
      ...identity,
      provider: providerId,
      connectionId: next.connectionId,
      at: next.now,
      restart: next.restartClock,
    });
    return;
  }
  try {
    const written = await writeSubscriptionSessionBinding(tx, {
      ...identity,
      provider: providerId,
      connectionId: next.connectionId,
      modelId: next.modelId,
      choice: current?.choice ?? "automatic",
      onlyThisModel: current?.onlyThisModel ?? false,
      lastModelCallAt: next.restartClock ? next.now : null,
      lastSwitchReason:
        next.placementSwitch === "sticky" || next.placementSwitch === "pinned"
          ? (current?.lastSwitchReason ?? null)
          : next.placementSwitch,
      expectedVersion: current?.version ?? null,
    });
    if (written === null) throw new SubscriptionBindingConflict();
  } catch (error) {
    if (isSubscriptionSessionBindingRollingConflict(error)) throw new SubscriptionBindingConflict();
    throw error;
  }
}
