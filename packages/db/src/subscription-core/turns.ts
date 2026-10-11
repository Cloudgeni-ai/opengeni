/**
 * Chat turns on the shared subscription core, for any provider (M3 PR 1,
 * extracted in M4).
 *
 * Dormant until an organization's cutover row for the provider is enabled:
 * the worker calls into this module only for that disposition. Everything
 * here runs under the exact accepted turn (`withSubscriptionCoreAcceptedTurn`),
 * so a caller cannot use it as a general account, connection or session
 * reader. The provider is data (`SubscriptionCoreProvider`): its adapter
 * decodes and refreshes the credential, and supplies the health policy and
 * cache facts. The connection's `refresh_generation` advances on every
 * persisted refresh and fences quota observations.
 */
import { sql } from "drizzle-orm";

import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";

import {
  readTurnExecutionPolicyV1,
  EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2,
  SubscriptionPersonalAuthorityV2,
  subscriptionPersonalAuthorityForProviderV2,
} from "@opengeni/contracts";

import {
  applyQuotaObservation,
  connectionIneligibility,
  connectionUsesExtraCredits,
  personalFallbackActive,
  decidePlacement,
  quotaCapacity,
  subscriptionCoreCredentialRefresher,
  type PlacementDecision,
  type PlacementInput,
  type PlacementSwitch,
  type ReselectionPoint,
  type SubscriptionQuota,
  type WaitReason,
} from "@opengeni/subscriptions";

import { rawRows, withRlsContext, type Database } from "../database";

import { decryptEnvironmentValue, encryptEnvironmentValue } from "../environment-crypto";

import {
  withSubscriptionCoreAcceptedTurn,
  withSubscriptionCoreProviderPlacementWorld,
  withSubscriptionCoreRefreshLock,
  type SubscriptionCoreAcceptedTurnIdentity,
} from "../subscription-core-placement-world";

import {
  acquireSubscriptionTurnLease,
  assertSubscriptionTurnLeaseCurrent,
  decodeSubscriptionQuota,
  persistSubscriptionCoreRefreshWithPlan,
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
  releaseSubscriptionTurnLease,
  writeSubscriptionSessionBinding,
  type SubscriptionSessionBinding,
} from "../subscription-core-repository";

import {
  memoByProvider,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";

/** The exact accepted turn plus its immutable v2 authority, read once per attempt. */
export type SubscriptionCoreTurnIdentity = SubscriptionCoreAcceptedTurnIdentity & {
  /** Parsed from `session_turns.subscription_authority`; NULL means no personal authority. */
  acceptedAuthorityV2: SubscriptionPersonalAuthorityV2;
};

/** The live chat-turn lease that authorizes credential reads and writes. */
export type SubscriptionCoreLeaseRef = {
  connectionId: string;
  holderId: string;
  generation: number;
};

/**
 * Read the session owner tuple and the turn's immutable v2 authority. The
 * owner is the session's recorded owner and its membership, never a viewer,
 * creator or live-membership inference; NULL authority is no personal
 * authority. A malformed stored value fails closed.
 */
export async function readSubscriptionCoreTurnIdentity(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<SubscriptionCoreTurnIdentity | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{
        owner_subject_id: string | null;
        owner_membership_id: string | null;
        initiating_human_subject_id: string | null;
        subscription_authority: unknown;
      }>(
        tx,
        sql`select session.owner_subject_id,
            session.owner_organization_membership_id::text as owner_membership_id,
            turn.initiating_human_subject_id, turn.subscription_authority
          from sessions session
          join session_turns turn on turn.account_id = session.account_id
            and turn.workspace_id = session.workspace_id and turn.session_id = session.id
          where session.account_id = ${input.accountId}::uuid
            and session.workspace_id = ${input.workspaceId}::uuid
            and session.id = ${input.sessionId}::uuid
            and turn.id = ${input.turnId}::uuid
          limit 1`,
      );
      if (!row) return null;
      return {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sessionOwnerSubjectId: row.owner_subject_id,
        sessionOwnerMembershipId: row.owner_membership_id,
        initiatingHumanSubjectId: row.initiating_human_subject_id,
        acceptedAuthorityV2:
          row.subscription_authority === null
            ? EMPTY_SUBSCRIPTION_PERSONAL_AUTHORITY_V2
            : SubscriptionPersonalAuthorityV2.parse(row.subscription_authority),
      };
    },
  );
}

/**
 * The accepted model and reasoning level of a (waiting) turn, for evaluating
 * where it could run. The frozen execution policy wins; the turn columns are
 * the fallback for turns accepted without one. The resumed attempt re-verifies
 * its policy at claim, so this read never authorizes anything by itself.
 */
export async function readSubscriptionCoreTurnModel(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<{ productModelId: string; reasoningLevel: string } | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{
        model: string;
        reasoning_effort: string;
        metadata: Record<string, unknown> | null;
      }>(
        tx,
        sql`select model, reasoning_effort, metadata from session_turns
          where account_id = ${input.accountId}::uuid
            and workspace_id = ${input.workspaceId}::uuid
            and session_id = ${input.sessionId}::uuid and id = ${input.turnId}::uuid`,
      );
      if (!row) return null;
      const policy = readTurnExecutionPolicyV1(row.metadata ?? {});
      return policy.kind === "valid"
        ? {
            productModelId: policy.policy.productModelId,
            reasoningLevel: policy.policy.reasoningEffort,
          }
        : { productModelId: row.model, reasoningLevel: row.reasoning_effort };
    },
  );
}

/**
 * The RLS actor that core lease and credential operations run as for this turn.
 *
 * For a service-initiated turn in an owned session the session owner stands in
 * as the actor's initiating human, as `withSubscriptionCoreAcceptedTurn` does,
 * only so the owner's session rows are visible. It grants no personal
 * authority: personal access is decided from the turn's stored
 * `initiating_human_subject_id`, which stays NULL for service turns. The v2
 * placement helper refuses a NULL turn human, and the lease guard's
 * `authorize_subscription_personal_access` matches the stored turn human
 * exactly, so a service turn never leases, reads or refreshes a personal
 * connection.
 */
export function subscriptionCoreTurnActor(identity: SubscriptionCoreAcceptedTurnIdentity): {
  subjectId: string;
  initiatingHumanSubjectId: string | null;
} {
  return {
    subjectId: "service:subscription-core",
    initiatingHumanSubjectId: identity.sessionOwnerSubjectId
      ? (identity.initiatingHumanSubjectId ?? identity.sessionOwnerSubjectId)
      : null,
  };
}

export type SubscriptionCorePlacementRequest = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
  /** The turn's accepted product model; placement is strict to this provider's models. */
  productModelId: string;
  reasoningLevel: string;
  leaseTtlMs: number;
  now?: Date;
};

export type SubscriptionCorePlacement =
  | { kind: "not_visible" }
  /** The organization's cutover for this provider is not enabled (checked in the same transaction). */
  | { kind: "cutover_not_enabled" }
  /** Another attempt owns the turn, or a newer lease generation exists. */
  | { kind: "attempt_fenced" }
  /** An older attempt's lease of this turn is still live; it expires at `leasedUntil`. */
  | { kind: "lease_busy"; leasedUntil: Date | null }
  | {
      kind: "wait";
      reason: WaitReason;
      earliestResetAt: Date | null;
      /** When a quarantined connection in this world returns, if any. */
      healthRetryAt: Date | null;
      explicitConnectionId: string | null;
    }
  | {
      kind: "run";
      connectionId: string;
      personal: boolean;
      switch: PlacementSwitch;
      /** This exact attempt already held a live lease on the connection. */
      reusedLease: boolean;
      explicit: boolean;
      previousConnectionId: string | null;
      rotationMode: "primary_first" | "spread";
      refreshGeneration: number;
      leasedUntil: Date;
      eligibleCount: number;
      connectedCount: number;
    };

class SubscriptionBindingConflict extends Error {
  constructor() {
    super("Subscription session binding changed during placement");
    this.name = "SubscriptionBindingConflict";
  }
}

const BINDING_CONFLICT_RETRIES = 3;

/**
 * Re-selection points since the binding's last model call (SUB-STICK-05).
 *
 * - `model_changed`: the turn's accepted model is not the bound model.
 * - `compaction_completed`: the session's durable `session.context.compacted`
 *   or `session.context.cleared` event occurred after the binding's last
 *   model call, so the cached prefix the binding kept warm was replaced. The
 *   explicit event is the marker: an unknown input-token count (an aggregate
 *   usage fallback, a provider that reports none) is not a compaction.
 *
 * Both only ever release an automatic binding; an explicit choice is kept.
 */
export function subscriptionCoreReselectionPoints(input: {
  binding: { modelId: string; lastModelCallAt: number } | null;
  productModelId: string;
  /** When the session's context was last compacted or cleared (epoch ms). */
  lastContextReplacedAt: number | null;
}): ReselectionPoint[] {
  const { binding } = input;
  if (!binding) return [];
  const points: ReselectionPoint[] = [];
  if (
    binding.lastModelCallAt > 0 &&
    input.lastContextReplacedAt !== null &&
    input.lastContextReplacedAt > binding.lastModelCallAt
  ) {
    points.push("compaction_completed");
  }
  if (binding.modelId !== input.productModelId) points.push("model_changed");
  return points;
}

/** The latest compaction or context clear of the session (newest per type by sequence). */
async function readLastContextReplacedAt(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
): Promise<number | null> {
  const [row] = await rawRows<{ replaced_at: Date | string | null }>(
    tx,
    sql`select greatest(
        (select occurred_at from session_events
          where workspace_id = ${identity.workspaceId}::uuid
            and session_id = ${identity.sessionId}::uuid
            and type = 'session.context.compacted'
          order by sequence desc limit 1),
        (select occurred_at from session_events
          where workspace_id = ${identity.workspaceId}::uuid
            and session_id = ${identity.sessionId}::uuid
            and type = 'session.context.cleared'
          order by sequence desc limit 1)
      ) as replaced_at`,
  );
  return row?.replaced_at === null || row?.replaced_at === undefined
    ? null
    : new Date(row.replaced_at).getTime();
}

export type SubscriptionCorePlacementEvaluation =
  | { kind: "not_visible" }
  | { kind: "cutover_not_enabled" }
  | { kind: "run"; connectionId: string; switch: PlacementSwitch }
  | {
      kind: "wait";
      reason: WaitReason;
      earliestResetAt: Date | null;
      /** When a quarantined connection in this world returns, if sooner than any reset. */
      healthRetryAt: Date | null;
      explicitConnectionId: string | null;
    };

async function readAttemptFence(
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
        turn.execution_generation, session.status as session_status,
        session.active_turn_id::text as active_turn_id
      from session_turns turn
      join sessions session on session.account_id = turn.account_id
        and session.workspace_id = turn.workspace_id and session.id = turn.session_id
      where turn.account_id = ${identity.accountId}::uuid
        and turn.workspace_id = ${identity.workspaceId}::uuid
        and turn.session_id = ${identity.sessionId}::uuid
        and turn.id = ${identity.turnId}::uuid
      limit 1`,
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

function bindingSwitchReason(
  placementSwitch: PlacementSwitch,
  current: SubscriptionSessionBinding["lastSwitchReason"],
): SubscriptionSessionBinding["lastSwitchReason"] {
  return placementSwitch === "sticky" || placementSwitch === "pinned" ? current : placementSwitch;
}

export type SubscriptionCoreCredential<Credential = unknown> = {
  connectionId: string;
  ownership: "shared" | "personal";
  refreshGeneration: number;
  /** The decoded secret (the adapter's credential codec). */
  credential: Credential;
  /** The provider's account id for this sign-in (sent upstream by some providers). */
  providerAccountId: string | null;
  /** Provider-owned connection facts; only the provider's adapter interprets them. */
  providerState: Record<string, unknown>;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCredentialLoad<Credential = unknown> =
  | { kind: "loaded"; credential: SubscriptionCoreCredential<Credential> }
  | { kind: "lease_lost" }
  /** The turn, or the connection under its authority, is not visible. */
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

export type SubscriptionCoreRefreshOutcome =
  | {
      kind: "refreshed";
      /** The rotated credential, already persisted. */
      credential: unknown;
      refreshGeneration: number;
      planType: string | null;
    }
  /** Another refresh or credential writer already advanced the generation. */
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "lease_lost" }
  | { kind: "not_visible" }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreRefreshDeps = {
  now?: () => Date;
  /**
   * Called after a persisted refresh whose id_token reports a plan different
   * from the recorded one. The database already cleared the connection's
   * model cooldowns; the caller wakes waiters that may now place.
   */
  onPlanChanged?: (connectionId: string) => void;
};

/**
 * The chat-turn runtime bound to one provider: placement and lease, credential
 * load and refresh, health and quota observations, and settlement facts. One
 * instance per provider (memoized); the functions are identical for every
 * provider and take every provider fact from `provider`.
 */
export const subscriptionCoreTurns = memoByProvider((provider: SubscriptionCoreProvider) => {
  const providerId = subscriptionCoreProviderId(provider);
  /**
   * Place one chat turn on the core and acquire its generation-fenced
   * lease in one transaction. Strict policy: this provider's models only (the turn's
   * accepted product model), no cross-provider failover, explicit choices are
   * honoured or wait (D-24), and the binding is written only through its
   * compare-and-swap API. Ownerless sessions never write a binding (the
   * database refuses one without an exact turn) and are shared-only.
   */
  async function placeSubscriptionCoreTurn(
    db: Database,
    request: SubscriptionCorePlacementRequest,
  ): Promise<SubscriptionCorePlacement> {
    if (!Number.isSafeInteger(request.executionGeneration) || request.executionGeneration < 1)
      throw new Error(
        `Core ${provider.adapter.displayName} placement requires a positive execution generation`,
      );
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await placeOnce(db, request);
      } catch (error) {
        if (!(error instanceof SubscriptionBindingConflict) || attempt >= BINDING_CONFLICT_RETRIES)
          throw error;
      }
    }
  }

  async function placeOnce(
    db: Database,
    request: SubscriptionCorePlacementRequest,
  ): Promise<SubscriptionCorePlacement> {
    const { identity } = request;
    const now = request.now ?? new Date();
    const result = await withSubscriptionCoreProviderPlacementWorld(
      db,
      provider,
      placementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
      async (tx, worldInput): Promise<SubscriptionCorePlacement> => {
        if (!(await cutoverEnabled(tx, identity.accountId))) return { kind: "cutover_not_enabled" };
        const fence = await readAttemptFence(tx, request);
        if (!fence) return { kind: "attempt_fenced" };

        const input = await providerPlacementInput(
          tx,
          identity,
          worldInput,
          request.productModelId,
        );
        const lease = {
          accountId: identity.accountId,
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          provider: providerId,
          holderId: request.holderId,
          generation: request.executionGeneration,
        };

        // Exact-turn reuse first: a Temporal retry of this same attempt keeps
        // its live lease while the connection can still serve the turn.
        const existing = await readTurnLease(tx, identity);
        let reuse: string | null = null;
        if (existing) {
          const ours =
            existing.holderId === request.holderId &&
            existing.generation === request.executionGeneration;
          // A newer or equal generation held by someone else is not this attempt.
          if (!ours && existing.generation >= request.executionGeneration) {
            return { kind: "attempt_fenced" };
          }
          // An older attempt's lease is replaced only after it expires.
          if (!ours && existing.live) {
            return { kind: "lease_busy", leasedUntil: existing.leasedUntil };
          }
          if (ours) {
            const connection = input.connections.find((row) => row.id === existing.connectionId);
            const servable =
              existing.live &&
              connection !== undefined &&
              connectionIneligibility(input, connection, request.productModelId).length === 0;
            if (servable) reuse = existing.connectionId;
            else
              await releaseSubscriptionTurnLease(tx, {
                ...lease,
                connectionId: existing.connectionId,
              });
          }
        }

        const binding = input.session.binding;
        const explicitConnectionId = binding?.choice === "explicit" ? binding.connectionId : null;
        const decision =
          reuse !== null &&
          (explicitConnectionId === null || explicitConnectionId === reuse) &&
          !connectionUsesExtraCredits(input, input.connections.find((row) => row.id === reuse)!)
            ? ({ kind: "run", connectionId: reuse, switch: "sticky" } as const)
            : decidePlacement(input);
        if (decision.kind === "wait") {
          if (reuse !== null)
            await releaseSubscriptionTurnLease(tx, { ...lease, connectionId: reuse });
          return {
            kind: "wait",
            reason: decision.reason,
            earliestResetAt:
              decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
            healthRetryAt: await earliestHealthRetryAt(tx, identity),
            explicitConnectionId,
          };
        }
        if (reuse !== null && decision.connectionId !== reuse) {
          await releaseSubscriptionTurnLease(tx, { ...lease, connectionId: reuse });
        }
        const connection = input.connections.find((row) => row.id === decision.connectionId);
        if (!connection) throw new Error("Core placement chose a connection outside its world");
        const acquired = await acquireSubscriptionTurnLease(tx, {
          ...lease,
          connectionId: connection.id,
          ttlMs: request.leaseTtlMs,
        });
        if (!acquired) return { kind: "lease_busy", leasedUntil: existing?.leasedUntil ?? null };

        const previousConnectionId = binding?.connectionId ?? null;
        if (identity.sessionOwnerSubjectId) {
          await writeBinding(tx, identity, {
            connectionId: connection.id,
            modelId: request.productModelId,
            placementSwitch: decision.switch,
          });
        }
        const rotation = input.settings.rotation[providerId];
        return {
          kind: "run",
          connectionId: connection.id,
          personal: connection.ownership.kind === "personal",
          switch: decision.switch,
          reusedLease: reuse === connection.id,
          explicit: explicitConnectionId === connection.id,
          previousConnectionId,
          rotationMode: rotation?.mode ?? "spread",
          refreshGeneration: connection.refreshGeneration,
          leasedUntil: acquired.leasedUntil,
          eligibleCount: input.connections.filter(
            (row) => connectionIneligibility(input, row, request.productModelId).length === 0,
          ).length,
          connectedCount: input.connections.length,
        };
      },
    );
    return result.status === "not_visible" ? { kind: "not_visible" } : result.value;
  }

  /** Defense in depth: core reads and writes re-check the gate in their own transaction. */
  async function cutoverEnabled(tx: Database, accountId: string): Promise<boolean> {
    return (
      (await readSubscriptionProviderCutoverState(tx, { accountId, provider: providerId })) ===
      "enabled"
    );
  }

  /** The world request for one chat turn: its accepted product model only. */
  function placementWorldRequest(
    identity: SubscriptionCoreTurnIdentity,
    productModelId: string,
    reasoningLevel: string,
    now: Date,
  ) {
    return {
      ...identity,
      preferredModelId: productModelId,
      reasoningLevel,
      // This provider only: no cross-provider failover on the core (M3 policy).
      models: [{ id: productModelId, provider: providerId, reasoningLevels: [reasoningLevel] }],
      // Re-selection points are derived inside the transaction from the
      // binding and session it reads (providerPlacementInput).
      reselectionPoints: [],
      now,
    };
  }

  /** Strict placement input: this provider's connections only, no cross-provider failover. */
  async function providerPlacementInput(
    tx: Database,
    identity: SubscriptionCoreAcceptedTurnIdentity,
    worldInput: PlacementInput,
    productModelId: string,
  ): Promise<PlacementInput> {
    const binding = worldInput.session.binding;
    const lastContextReplacedAt =
      binding && binding.lastModelCallAt > 0 ? await readLastContextReplacedAt(tx, identity) : null;
    const [turn] = await rawRows<{ metadata: Record<string, unknown> | null }>(
      tx,
      sql`select metadata from session_turns where account_id = ${identity.accountId}::uuid
      and workspace_id = ${identity.workspaceId}::uuid and session_id = ${identity.sessionId}::uuid
      and id = ${identity.turnId}::uuid`,
    );
    const policy = readTurnExecutionPolicyV1(turn?.metadata ?? {});
    // Keep accepted retired models: a picker catalog is not the execution contract.
    // Legacy turns without a frozen mapping retain unknown entitlement.
    const upstreamModelId =
      policy.kind === "valid" && policy.policy.productModelId === productModelId
        ? policy.policy.upstreamModelId
        : null;
    return {
      ...worldInput,
      session: {
        ...worldInput.session,
        reselectionPoints: subscriptionCoreReselectionPoints({
          binding: binding
            ? { modelId: binding.modelId, lastModelCallAt: binding.lastModelCallAt }
            : null,
          productModelId,
          lastContextReplacedAt,
        }),
      },
      settings: { ...worldInput.settings, crossProviderFailover: false, fallbackOrder: {} },
      connections: worldInput.connections
        .filter((connection) => connection.provider === providerId)
        .map((connection) =>
          upstreamModelId !== null && connection.observedModelSlugs != null
            ? {
                ...connection,
                entitledModelIds: connection.observedModelSlugs.includes(upstreamModelId)
                  ? [productModelId]
                  : [],
              }
            : connection,
        ),
    };
  }

  /** Earliest retry when a quarantine or fresh catalog observation expires. */
  async function earliestHealthRetryAt(
    tx: Database,
    identity: SubscriptionCoreAcceptedTurnIdentity,
  ): Promise<Date | null> {
    const [row] = await rawRows<{ retry_at: Date | string | null }>(
      tx,
      sql`select min(retry_at) as retry_at from (
      select health_retry_at as retry_at from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = ${providerId}
          and status = 'error' and health_retry_at > clock_timestamp()
      union all
      select quota.model_catalog_expires_at from subscription_connection_quota quota
        join subscription_connections connection on connection.id = quota.connection_id
          and connection.account_id = quota.account_id
        where connection.account_id = ${identity.accountId}::uuid and connection.provider = ${providerId}
          and connection.status = 'active' and connection.allocator_enabled
          and quota.model_catalog_refresh_generation = connection.refresh_generation
          and quota.model_catalog_expires_at > clock_timestamp()
      ) deadlines`,
    );
    return row?.retry_at ? new Date(row.retry_at) : null;
  }

  /**
   * Decide where this exact accepted turn would run now, without leasing,
   * binding or writing anything. Waiter reconciliation uses it to decide
   * between resuming the blocked turn and waiting longer; the resumed attempt
   * then places (and leases) through placeSubscriptionCoreTurn, which
   * rechecks everything in its own transaction.
   */
  /** Read live credit consent and placement without changing a binding or lease. */
  async function canSpendSubscriptionCoreExtraCredits(
    db: Database,
    request: SubscriptionCorePlacementRequest & { connectionId: string },
  ): Promise<boolean> {
    const { identity } = request;
    const now = new Date();
    const result = await withSubscriptionCoreProviderPlacementWorld(
      db,
      provider,
      placementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
      async (tx, worldInput) => {
        if (
          !(await cutoverEnabled(tx, identity.accountId)) ||
          !(await readAttemptFence(tx, request))
        )
          return false;
        if (
          !(await assertSubscriptionTurnLeaseCurrent(tx, {
            ...identity,
            provider: providerId,
            connectionId: request.connectionId,
            holderId: request.holderId,
            generation: request.executionGeneration,
          }))
        )
          return false;
        const input = await providerPlacementInput(
          tx,
          identity,
          worldInput,
          request.productModelId,
        );
        const current = input.connections.find((row) => row.id === request.connectionId);
        if (!current?.extraCreditsEnabled) return false;
        // The exact accepted lease remains usable after allocator pause.
        current.allocatorEnabled = true;
        if (current.assignmentPolicies)
          current.assignmentPolicies = current.assignmentPolicies.map((policy) => ({
            ...policy,
            allocatorEnabled: true,
          }));
        current.quota = {
          modelCooldowns: {},
          exhaustedUntil: null,
          exhaustedKind: null,
          revision: 0,
          observedAt: now.getTime(),
          observedRefreshGeneration: current.refreshGeneration,
          source: "usage_endpoint",
          ...current.quota,
          windows: [
            ...(current.quota?.windows ?? []),
            {
              id: "included_admission",
              status: "exhausted",
              usedPercent: 100,
              resetsAt: now.getTime() + 60_000,
            },
          ],
        };
        const decision = decidePlacement(input);
        return decision.kind === "run" && decision.connectionId === request.connectionId;
      },
    );
    return result.status === "completed" && result.value;
  }

  /** Funding checks never mint personal authority or expose it to workspace readers.
   * Temporary capacity waits remain subscription-funded; static access and model
   * eligibility use exactly the placement world's frozen accepted authority. */
  async function subscriptionCoreAcceptedTurnIsFunded(
    db: Database,
    request: {
      accountId: string;
      workspaceId: string;
      sessionId: string;
      turnId: string;
      productModelId: string;
    },
  ): Promise<boolean> {
    const identity = await readSubscriptionCoreTurnIdentity(db, request);
    if (!identity) return false;
    const result = await withSubscriptionCoreProviderPlacementWorld(
      db,
      provider,
      placementWorldRequest(identity, request.productModelId, "medium", new Date()),
      async (tx, world) => {
        if (!(await cutoverEnabled(tx, identity.accountId))) return false;
        const input = await providerPlacementInput(tx, identity, world, request.productModelId);
        return input.connections.some(
          (connection) =>
            (connection.ownership.kind === "shared" || personalFallbackActive(input)) &&
            connectionIneligibility(input, connection, request.productModelId).every(
              (reason) => reason === "exhausted" || reason === "model_cooling_down",
            ),
        );
      },
    );
    return result.status === "completed" && result.value;
  }

  async function evaluateSubscriptionCorePlacement(
    db: Database,
    request: {
      identity: SubscriptionCoreTurnIdentity;
      productModelId: string;
      reasoningLevel: string;
      now?: Date;
    },
  ): Promise<SubscriptionCorePlacementEvaluation> {
    const { identity } = request;
    const now = request.now ?? new Date();
    const result = await withSubscriptionCoreProviderPlacementWorld(
      db,
      provider,
      placementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
      async (tx, worldInput): Promise<SubscriptionCorePlacementEvaluation> => {
        if (!(await cutoverEnabled(tx, identity.accountId))) return { kind: "cutover_not_enabled" };
        const input = await providerPlacementInput(
          tx,
          identity,
          worldInput,
          request.productModelId,
        );
        const decision: PlacementDecision = decidePlacement(input);
        if (decision.kind === "run") {
          return { kind: "run", connectionId: decision.connectionId, switch: decision.switch };
        }
        const binding = input.session.binding;
        return {
          kind: "wait",
          reason: decision.reason,
          earliestResetAt:
            decision.earliestResetAt === null ? null : new Date(decision.earliestResetAt),
          healthRetryAt: await earliestHealthRetryAt(tx, identity),
          explicitConnectionId: binding?.choice === "explicit" ? binding.connectionId : null,
        };
      },
    );
    return result.status === "not_visible" ? { kind: "not_visible" } : result.value;
  }

  /**
   * Return due time-bound quarantines (a 403 refusal) to service, inside this
   * exact accepted turn's own transaction. The SQL function filters explicitly
   * (it does not rely on row-level security, which its owner may bypass):
   * shared connections by the ordinary visibility rule for this workspace and
   * turn, personal connections only for the owner's own turn (stored turn
   * human = owner; never a service or API-key turn) with the owner's
   * membership still active and a frozen v2 entry for the connection's
   * membership and generation. Sign-in failures and administrator status changes
   * are never cleared here (any other status or error write drops the retry
   * time). Returns how many connections recovered, so the caller can wake
   * waiters that may now place.
   */
  async function recoverSubscriptionCoreConnectionHealth(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
  ): Promise<number> {
    const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
      if (!(await cutoverEnabled(tx, identity.accountId))) return 0;
      const [row] = await rawRows<{ recovered: number | string }>(
        tx,
        sql`select opengeni_private.recover_subscription_core_connection_health(${providerId},
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
          ${identity.sessionId}::uuid, ${identity.turnId}::uuid
        ) as recovered`,
      );
      return Number(row?.recovered ?? 0);
    });
    return access.status === "completed" ? access.value : 0;
  }

  /**
   * Record a refusal that survived refresh as connection health, so eligibility
   * excludes the connection and sticky placement does not return to it:
   * a revoked sign-in becomes `needs_relogin` (cleared only by a new sign-in),
   * and a 403 becomes a time-bound `error` quarantine. Written only for the
   * exact accepted turn holding the live lease, under the refresh-generation
   * compare-and-swap of the credential that was refused.
   */
  async function quarantineSubscriptionCoreConnection(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    input: {
      kind: "sign_in" | "forbidden";
      refreshGeneration: number;
      now?: Date;
    },
  ): Promise<boolean> {
    const now = input.now ?? new Date();
    const forbidden = input.kind === "forbidden";
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const [row] = await rawRows<{ marked: boolean }>(
        tx,
        sql`select opengeni_private.quarantine_subscription_core_connection(${providerId},
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
          ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
          ${lease.connectionId}::uuid, ${lease.holderId}, ${lease.generation}::bigint,
          ${input.refreshGeneration}::bigint,
          ${forbidden ? "error" : "needs_relogin"},
          ${
            forbidden
              ? "model request was forbidden for this credential"
              : "model request remained unauthorized after refresh"
          },
          ${
            forbidden
              ? new Date(
                  now.getTime() + provider.adapter.health.forbiddenQuarantineMs,
                ).toISOString()
              : null
          }::timestamptz
        ) as marked`,
      );
      return row?.marked === true;
    });
    return access.status === "ok" && access.value;
  }

  /**
   * Keep one model off the leased connection until `until` after the plan
   * refused it (SUB-ELIG-03). The cooldown is part of the connection's quota
   * state, so placement excludes the model there, a waiter learns when it
   * returns, and a plan change seen on refresh clears it early. Fenced on the
   * refresh generation the refused bearer carried; never shortens a cooldown.
   */
  async function recordSubscriptionCoreModelCooldown(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    input: { modelId: string; until: Date; refreshGeneration: number },
  ): Promise<boolean> {
    if (!input.modelId.trim() || input.modelId.length > 256) return false;
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const [connection] = await rawRows<{ refresh_generation: number | string }>(
        tx,
        sql`select refresh_generation from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = ${providerId}
          and id = ${lease.connectionId}::uuid`,
      );
      if (!connection || Number(connection.refresh_generation) !== input.refreshGeneration)
        return false;
      const empty = {
        windows: [],
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        source: "refusal",
      };
      const rows = await rawRows<{ connection_id: string }>(
        tx,
        sql`insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
        ) values (
          ${identity.accountId}::uuid, ${lease.connectionId}::uuid,
          jsonb_set(${JSON.stringify(empty)}::jsonb, array['modelCooldowns', ${input.modelId}],
            to_jsonb(${input.until.getTime()}::bigint)),
          ${input.refreshGeneration}, 1, clock_timestamp()
        )
        on conflict (connection_id) do update
          -- A row without quota for this refresh generation (for example one
          -- the model catalog created) holds no observation to merge into:
          -- the cooldown becomes its observation. Readers ignore quota whose
          -- observed generation is missing.
          set quota = case
                when subscription_connection_quota.observed_refresh_generation
                  is distinct from excluded.observed_refresh_generation
                then excluded.quota
                else jsonb_set(
                  case when jsonb_typeof(subscription_connection_quota.quota->'modelCooldowns') = 'object'
                    then subscription_connection_quota.quota
                    else jsonb_set(subscription_connection_quota.quota, '{modelCooldowns}', '{}'::jsonb)
                  end,
                  array['modelCooldowns', ${input.modelId}],
                  to_jsonb(greatest(
                    coalesce((subscription_connection_quota.quota->'modelCooldowns'->>${input.modelId})::bigint, 0),
                    ${input.until.getTime()}::bigint
                  ))
                )
              end,
              updated_at = case
                when subscription_connection_quota.observed_refresh_generation
                  is distinct from excluded.observed_refresh_generation
                then excluded.updated_at
                else subscription_connection_quota.updated_at
              end,
              observed_refresh_generation = excluded.observed_refresh_generation,
              revision = subscription_connection_quota.revision + 1
          where subscription_connection_quota.account_id = excluded.account_id
        returning connection_id::text as connection_id`,
      );
      return rows.length === 1;
    });
    return access.status === "ok" && access.value;
  }

  async function readTurnLease(
    tx: Database,
    identity: SubscriptionCoreAcceptedTurnIdentity,
  ): Promise<{
    connectionId: string;
    holderId: string;
    generation: number;
    leasedUntil: Date;
    live: boolean;
  } | null> {
    const [row] = await rawRows<{
      connection_id: string;
      provider: string;
      holder_id: string;
      generation: number | string;
      leased_until: Date | string;
      live: boolean;
    }>(
      tx,
      sql`select connection_id::text as connection_id, provider, holder_id, generation,
        leased_until, leased_until > clock_timestamp() as live
      from subscription_leases
      where account_id = ${identity.accountId}::uuid
        and workspace_id = ${identity.workspaceId}::uuid
        and session_id = ${identity.sessionId}::uuid
        and turn_id = ${identity.turnId}::uuid`,
    );
    if (!row) return null;
    if (row.provider !== providerId)
      throw new Error("A core turn lease belongs to another provider");
    return {
      connectionId: row.connection_id,
      holderId: row.holder_id,
      generation: Number(row.generation),
      leasedUntil: new Date(row.leased_until),
      live: row.live,
    };
  }

  async function writeBinding(
    tx: Database,
    identity: SubscriptionCoreAcceptedTurnIdentity,
    next: { connectionId: string; modelId: string; placementSwitch: PlacementSwitch },
  ): Promise<void> {
    const current = await readSubscriptionSessionBinding(tx, identity);
    if (
      current &&
      current.provider === providerId &&
      current.connectionId === next.connectionId &&
      current.modelId === next.modelId
    ) {
      return;
    }
    const written = await writeSubscriptionSessionBinding(tx, {
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      provider: providerId,
      connectionId: next.connectionId,
      modelId: next.modelId,
      // A person's explicit choice is changed only by that person.
      choice: current?.choice ?? "automatic",
      onlyThisModel: current?.onlyThisModel ?? false,
      lastModelCallAt: current?.lastModelCallAt ?? null,
      lastSwitchReason: bindingSwitchReason(
        next.placementSwitch,
        current?.lastSwitchReason ?? null,
      ),
      expectedVersion: current?.version ?? null,
    });
    if (written === null) throw new SubscriptionBindingConflict();
  }

  /**
   * Give this transaction the per-connection personal capability for the
   * turn's frozen v2 entry for this provider. A no-op without that entry, for service and
   * ownerless turns, and before the provider's cutover is enabled.
   */
  async function authorizeSubscriptionCoreFrozenPersonal(
    tx: Database,
    identity: SubscriptionCoreTurnIdentity,
  ): Promise<boolean> {
    const personal = subscriptionPersonalAuthorityForProviderV2(
      identity.acceptedAuthorityV2,
      providerId as SubscriptionPersonalAuthorityV2["personal"][number]["provider"],
    );
    if (
      !personal ||
      !identity.sessionOwnerSubjectId ||
      !identity.initiatingHumanSubjectId ||
      identity.sessionOwnerMembershipId !== personal.ownerMembershipId
    ) {
      return false;
    }
    const [row] = await rawRows<{ authorized: boolean }>(
      tx,
      sql`select opengeni_private.authorize_subscription_personal_placement_access(
        ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
        ${identity.sessionId}::uuid, ${identity.turnId}::uuid, ${providerId},
        ${personal.ownerMembershipId}::uuid, ${personal.authorityGeneration}::bigint,
        ${identity.sessionOwnerSubjectId}, ${identity.initiatingHumanSubjectId}
      ) as authorized`,
    );
    return row?.authorized === true;
  }

  /** Exact accepted turn + live lease + (for personal) frozen v2 authority. */
  async function withLeasedConnection<T>(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    operation: (tx: Database) => Promise<T>,
  ): Promise<{ status: "not_visible" } | { status: "lease_lost" } | { status: "ok"; value: T }> {
    const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
      if (!(await cutoverEnabled(tx, identity.accountId)))
        return { status: "not_visible" } as const;
      const current = await assertSubscriptionTurnLeaseCurrent(tx, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        provider: providerId,
        connectionId: lease.connectionId,
        holderId: lease.holderId,
        generation: lease.generation,
      });
      if (!current) return { status: "lease_lost" } as const;
      await authorizeSubscriptionCoreFrozenPersonal(tx, identity);
      return { status: "ok", value: await operation(tx) } as const;
    });
    return access.status === "not_visible" ? access : access.value;
  }

  function decodeCredential(key: Uint8Array, encrypted: string): unknown {
    let plaintext: string;
    try {
      plaintext = decryptEnvironmentValue(key, encrypted);
    } catch {
      // Fixed text and no cause: never echo ciphertext or key material.
      throw new Error(`A core ${provider.adapter.displayName} credential could not be decrypted`);
    }
    // The adapter throws fixed text for malformed plaintext (never echoing it).
    return provider.adapter.credential.decode(plaintext);
  }

  function encryptionKey(settings: Settings): Uint8Array {
    const key = environmentsEncryptionKeyBytes(settings);
    if (!key) {
      throw new Error(
        `core ${provider.adapter.displayName} credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured`,
      );
    }
    return key;
  }

  /**
   * Materialize the leased connection's credential for this exact turn. Reads
   * require the accepted turn, the live lease, and for a personal connection
   * the turn's frozen v2 entry. Ownerless turns never read a personal or
   * people-scoped connection.
   */
  async function loadSubscriptionCoreCredential(
    db: Database,
    settings: Settings,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
  ): Promise<SubscriptionCoreCredentialLoad> {
    const key = encryptionKey(settings);
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const [row] = await rawRows<{
        id: string;
        kind: string;
        status: string;
        ownership: "shared" | "personal";
        scope_kind: string;
        credential_encrypted: string;
        expires_at: Date | string | null;
        last_refresh_at: Date | string | null;
        refresh_generation: number | string;
        provider_account_id: string | null;
        plan_type: string | null;
        provider_state: Record<string, unknown> | null;
      }>(
        tx,
        sql`select id::text as id, kind, status, ownership, scope_kind, credential_encrypted,
          expires_at, last_refresh_at, refresh_generation, provider_account_id, plan_type,
          provider_state
        from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = ${providerId}
          and id = ${lease.connectionId}::uuid
        limit 1`,
      );
      return row ?? null;
    });
    if (access.status !== "ok") return { kind: access.status };
    const row = access.value;
    if (!row) return { kind: "not_visible" };
    if (
      identity.sessionOwnerSubjectId === null &&
      (row.ownership !== "shared" ||
        (row.scope_kind !== "organization" && row.scope_kind !== "workspaces"))
    ) {
      return { kind: "not_visible" };
    }
    if (row.kind !== "subscription") return { kind: "unavailable" };
    if (row.status === "needs_relogin") return { kind: "needs_relogin" };
    if (row.status !== "active") return { kind: "unavailable" };
    return {
      kind: "loaded",
      credential: {
        connectionId: row.id,
        ownership: row.ownership,
        refreshGeneration: Number(row.refresh_generation),
        credential: decodeCredential(key, row.credential_encrypted),
        providerAccountId: row.provider_account_id,
        providerState: row.provider_state ?? {},
        planType: row.plan_type,
        expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
        lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
      },
    };
  }

  /**
   * Rotate the leased connection's refresh token through the core's single
   * per-connection lock. Authorization happens in begin, before the provider
   * call; the rotated token is persisted immediately after it returns. A
   * permanent OAuth refusal marks the connection needs-relogin through the
   * same one-shot authorization. Failures are returned, never thrown inside
   * the lock, so that status write commits.
   */
  async function refreshSubscriptionCoreCredential(
    db: Database,
    settings: Settings,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    observedRefreshGeneration: number,
    deps: SubscriptionCoreRefreshDeps = {},
  ): Promise<SubscriptionCoreRefreshOutcome> {
    const key = encryptionKey(settings);
    const now = deps.now ?? (() => new Date());
    const result = await withSubscriptionCoreRefreshLock(
      db,
      provider,
      {
        ...identity,
        connectionId: lease.connectionId,
        holderId: lease.holderId,
        generation: lease.generation,
      },
      async (tx, credential): Promise<SubscriptionCoreRefreshOutcome> => {
        // Switch-off fails closed before any provider call.
        if (!(await cutoverEnabled(tx, identity.accountId))) return { kind: "refused" };
        if (credential.refreshGeneration !== observedRefreshGeneration)
          return { kind: "superseded" };
        let current: unknown;
        try {
          current = decodeCredential(key, credential.credentialEncrypted);
        } catch (error) {
          return { kind: "error", error };
        }
        // Renewal depends on the credential's format, never on the provider.
        const refresher = subscriptionCoreCredentialRefresher(provider.adapter, current);
        if (!refresher) {
          // A credential that never renews (an API key, a setup token) is
          // refreshed only when it expired or the provider refused it: only a
          // new sign-in recovers, so mark the connection needs-relogin under
          // the same one-shot authorization a permanent refusal uses.
          const message = provider.adapter.reloginText("");
          const [marked] = await rawRows<{ marked: boolean }>(
            tx,
            sql`select opengeni_private.fail_subscription_core_refresh(${providerId},
              ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
              ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
              ${lease.connectionId}::uuid, ${credential.refreshGeneration}::bigint,
              ${message}
            ) as marked`,
          );
          return { kind: "relogin", message, marked: marked?.marked === true };
        }
        try {
          const rotated = await refresher.rotate(current);
          // Persist before any other fallible work: a rolled-back transaction
          // would discard the only valid refresh token.
          const persisted = await persistSubscriptionCoreRefreshWithPlan(tx, {
            provider: providerId,
            accountId: identity.accountId,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            connectionId: lease.connectionId,
            expectedRefreshGeneration: credential.refreshGeneration,
            credentialEncrypted: encryptEnvironmentValue(
              key,
              provider.adapter.credential.encode(rotated.credential),
            ),
            expiresAt: rotated.expiresAt,
            lastRefreshAt: now(),
            planType: rotated.planType,
          });
          if (!persisted) return { kind: "superseded" };
          return {
            kind: "refreshed",
            credential: rotated.credential,
            refreshGeneration: credential.refreshGeneration + 1,
            planType: rotated.planType,
          };
        } catch (error) {
          const relogin = refresher.reloginMessage(error);
          if (relogin !== null) {
            const [marked] = await rawRows<{ marked: boolean }>(
              tx,
              sql`select opengeni_private.fail_subscription_core_refresh(${providerId},
                ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
                ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
                ${lease.connectionId}::uuid, ${credential.refreshGeneration}::bigint,
                ${provider.adapter.reloginText(relogin)}
              ) as marked`,
            );
            return { kind: "relogin", message: relogin, marked: marked?.marked === true };
          }
          return { kind: "error", error };
        }
      },
    );
    if (result.status !== "completed") return { kind: result.status };
    return result.value;
  }

  /**
   * Apply one quota observation (usage headers or a refusal) to the leased
   * connection. The observation applies only to the refresh generation it was
   * made with, and never shortens a running exhaustion (design 2.2).
   */
  async function recordSubscriptionCoreQuotaObservation(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    observation: SubscriptionQuota,
  ): Promise<boolean> {
    return (await applySubscriptionCoreQuotaObservation(db, identity, lease, observation)).applied;
  }

  /**
   * Same as recordSubscriptionCoreQuotaObservation, and also reports
   * whether the observation ended an exhaustion the store still held: that is
   * a capacity change other waiters must hear about (the caller wakes them).
   */
  async function applySubscriptionCoreQuotaObservation(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    observation: SubscriptionQuota,
  ): Promise<{ applied: boolean; recovered: boolean }> {
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const [connection] = await rawRows<{ refresh_generation: number | string }>(
        tx,
        sql`select refresh_generation from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = ${providerId}
          and id = ${lease.connectionId}::uuid`,
      );
      if (!connection) return { applied: false, recovered: false };
      const refreshGeneration = Number(connection.refresh_generation);
      const [row] = await rawRows<{
        quota: unknown;
        quota_revision: number | string | null;
        quota_observed_refresh_generation: number | string | null;
        quota_updated_at: Date | string | null;
      }>(
        tx,
        sql`select quota, revision as quota_revision,
          observed_refresh_generation as quota_observed_refresh_generation,
          updated_at as quota_updated_at
        from subscription_connection_quota
        where account_id = ${identity.accountId}::uuid and connection_id = ${lease.connectionId}::uuid
        for update`,
      );
      const current = row ? decodeSubscriptionQuota(row) : null;
      const next = applyQuotaObservation({ refreshGeneration, quota: current }, observation);
      if (!next || next === current) return { applied: false, recovered: false };
      const observedNow = observation.observedAt ?? Date.now();
      const recovered =
        current !== null &&
        quotaCapacity(current, observedNow).kind === "exhausted" &&
        quotaCapacity(next, observedNow).kind !== "exhausted";
      const stored = {
        windows: next.windows,
        modelCooldowns: next.modelCooldowns,
        exhaustedUntil: next.exhaustedUntil,
        exhaustedKind: next.exhaustedKind,
        source: next.source,
      };
      const observedAt = new Date(next.observedAt ?? Date.now()).toISOString();
      await tx.execute(
        sql`insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
        ) values (
          ${identity.accountId}::uuid, ${lease.connectionId}::uuid, ${JSON.stringify(stored)}::jsonb,
          ${refreshGeneration}, 1, ${observedAt}::timestamptz
        )
        on conflict (connection_id) do update
          set quota = excluded.quota,
              observed_refresh_generation = excluded.observed_refresh_generation,
              revision = subscription_connection_quota.revision + 1,
              updated_at = excluded.updated_at
          where subscription_connection_quota.account_id = excluded.account_id`,
      );
      return { applied: true, recovered };
    });
    return access.status === "ok" ? access.value : { applied: false, recovered: false };
  }

  /** A (turn, connection) failure receipt for core settlement and audit. */
  async function recordSubscriptionCoreTurnFailure(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    failure: { kind: string; evidence?: Record<string, string | number | boolean | null> },
  ): Promise<boolean> {
    // Exact accepted turn, enabled gate and this turn's live lease, as for
    // every other core write about the leased connection.
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const rows = await rawRows<{ turn_id: string }>(
        tx,
        sql`insert into subscription_turn_failures (
          account_id, workspace_id, session_id, turn_id, connection_id, provider,
          failure_kind, recovery_evidence
        ) values (
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid, ${identity.sessionId}::uuid,
          ${identity.turnId}::uuid, ${lease.connectionId}::uuid, ${providerId}, ${failure.kind},
          ${JSON.stringify(failure.evidence ?? {})}::jsonb
        )
        on conflict (workspace_id, turn_id, connection_id) do update
          set failure_kind = excluded.failure_kind,
              -- Every refusal of this turn by this connection is counted, so
              -- the per-turn failover bound covers alternating accounts too.
              recovery_evidence = excluded.recovery_evidence || jsonb_build_object(
                'refusals',
                coalesce((subscription_turn_failures.recovery_evidence->>'refusals')::integer, 1) + 1
              )
          where subscription_turn_failures.account_id = excluded.account_id
        returning turn_id::text as turn_id`,
      );
      return rows.length === 1;
    });
    return access.status === "ok" && access.value;
  }

  /**
   * How many times connections refused this exact turn (each failure receipt
   * counts its refusals). The in-turn failover bound reads it after recording
   * the refusal it is settling. Null when the turn is not visible or the gate
   * is off, which callers treat as "do not fail over".
   */
  async function countSubscriptionCoreTurnRefusals(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
  ): Promise<number | null> {
    const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
      if (!(await cutoverEnabled(tx, identity.accountId))) return null;
      const [row] = await rawRows<{ refusals: number | string | null }>(
        tx,
        sql`select coalesce(sum(coalesce((recovery_evidence->>'refusals')::integer, 1)), 0) as refusals
        from subscription_turn_failures
        where account_id = ${identity.accountId}::uuid
          and workspace_id = ${identity.workspaceId}::uuid
          and session_id = ${identity.sessionId}::uuid
          and turn_id = ${identity.turnId}::uuid and provider = ${providerId}`,
      );
      return Number(row?.refusals ?? 0);
    });
    return access.status === "completed" ? access.value : null;
  }

  /**
   * Record a completed model call on the session's chat binding so the next
   * placement measures cache warmth from it (design 3.4). Only the leased
   * connection's binding moves, and only forward, through the binding CAS.
   */
  async function touchSubscriptionCoreBinding(
    db: Database,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    lastModelCallAt: Date,
  ): Promise<boolean> {
    if (!identity.sessionOwnerSubjectId) return false;
    const access = await withLeasedConnection(db, identity, lease, async (tx) => {
      const current = await readSubscriptionSessionBinding(tx, identity);
      if (
        !current ||
        current.provider !== providerId ||
        current.connectionId !== lease.connectionId ||
        (current.lastModelCallAt !== null && current.lastModelCallAt >= lastModelCallAt)
      ) {
        return false;
      }
      const written = await writeSubscriptionSessionBinding(tx, {
        ...current,
        lastModelCallAt,
        expectedVersion: current.version,
      });
      return written !== null;
    });
    return access.status === "ok" && access.value;
  }

  return {
    placeSubscriptionCoreTurn,
    canSpendSubscriptionCoreExtraCredits,
    subscriptionCoreAcceptedTurnIsFunded,
    evaluateSubscriptionCorePlacement,
    recoverSubscriptionCoreConnectionHealth,
    quarantineSubscriptionCoreConnection,
    recordSubscriptionCoreModelCooldown,
    authorizeSubscriptionCoreFrozenPersonal,
    loadSubscriptionCoreCredential,
    refreshSubscriptionCoreCredential,
    recordSubscriptionCoreQuotaObservation,
    applySubscriptionCoreQuotaObservation,
    recordSubscriptionCoreTurnFailure,
    countSubscriptionCoreTurnRefusals,
    touchSubscriptionCoreBinding,
  };
});
