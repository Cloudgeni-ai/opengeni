/**
 * Codex chat turns on the shared subscription core (M3 PR 1).
 *
 * Dormant until an organization's Codex cutover row is enabled: the worker
 * calls into this module only for that disposition. Everything here runs
 * under the exact accepted turn (`withSubscriptionCoreAcceptedTurn`), so a
 * caller cannot use it as a general account, connection or session reader.
 *
 * Core credential plaintext (the format the PR 3 migration maps legacy rows
 * to): `credential_encrypted` holds the same `encryptEnvironmentValue` blob as
 * the legacy Codex tables, whose plaintext is the JSON object
 * `{ access_token, refresh_token, id_token }` with OpenAI's snake_case names.
 * `provider_account_id` is the ChatGPT account id sent as
 * `ChatGPT-Account-ID`, `provider_state.isFedramp` is the FedRAMP routing
 * flag (absent means false), and `plan_type` is the recorded ChatGPT plan.
 * The bearer's `credentialVersion` is the connection's `refresh_generation`,
 * which advances on every persisted refresh and fences quota observations.
 */
import { sql } from "drizzle-orm";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  accessTokenExpiry,
  CODEX_REFRESH_FALLBACK_MS,
  CODEX_REFRESH_WINDOW_MS,
  CodexReloginRequired,
  parseIdToken,
  refreshCodexToken,
} from "@opengeni/codex";
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
  decidePlacement,
  quotaCapacity,
  type PlacementDecision,
  type PlacementInput,
  type PlacementSwitch,
  type ReselectionPoint,
  type SubscriptionQuota,
  type WaitReason,
} from "@opengeni/subscriptions";
import type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { withCodexTokenDeadline } from "./codex-token-resolver";

export type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import { rawRows, withRlsContext, type Database } from "./database";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
import {
  withSubscriptionCoreAcceptedTurn,
  withSubscriptionCoreCodexRefreshLock,
  withSubscriptionCorePlacementWorld,
  type SubscriptionCoreAcceptedTurnIdentity,
} from "./subscription-core-placement-world";
import {
  acquireSubscriptionTurnLease,
  assertSubscriptionTurnLeaseCurrent,
  decodeSubscriptionQuota,
  persistSubscriptionCodexRefreshWithPlan,
  readSubscriptionProviderCutoverState,
  readSubscriptionSessionBinding,
  releaseSubscriptionTurnLease,
  writeSubscriptionSessionBinding,
  type SubscriptionSessionBinding,
} from "./subscription-core-repository";

/** The exact accepted turn plus its immutable v2 authority, read once per attempt. */
export type SubscriptionCoreTurnIdentity = SubscriptionCoreAcceptedTurnIdentity & {
  /** Parsed from `session_turns.subscription_authority`; NULL means no personal authority. */
  acceptedAuthorityV2: SubscriptionPersonalAuthorityV2;
};

/** The live chat-turn lease that authorizes credential reads and writes. */
export type SubscriptionCoreCodexLeaseRef = {
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
export async function readSubscriptionCoreCodexTurnModel(
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

export type SubscriptionCoreCodexPlacementRequest = {
  identity: SubscriptionCoreTurnIdentity;
  attemptId: string;
  executionGeneration: number;
  holderId: string;
  /** The turn's accepted product model; M3 places Codex models only. */
  productModelId: string;
  reasoningLevel: string;
  leaseTtlMs: number;
  now?: Date;
};

export type SubscriptionCoreCodexPlacement =
  | { kind: "not_visible" }
  /** The organization's Codex cutover is not enabled (checked in the same transaction). */
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
 * Place one Codex chat turn on the core and acquire its generation-fenced
 * lease in one transaction. Strict M3 policy: Codex models only (the turn's
 * accepted product model), no cross-provider failover, explicit choices are
 * honoured or wait (D-24), and the binding is written only through its
 * compare-and-swap API. Ownerless sessions never write a binding (the
 * database refuses one without an exact turn) and are shared-only.
 */
export async function placeSubscriptionCoreCodexTurn(
  db: Database,
  request: SubscriptionCoreCodexPlacementRequest,
): Promise<SubscriptionCoreCodexPlacement> {
  if (!Number.isSafeInteger(request.executionGeneration) || request.executionGeneration < 1)
    throw new Error("Core Codex placement requires a positive execution generation");
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
  request: SubscriptionCoreCodexPlacementRequest,
): Promise<SubscriptionCoreCodexPlacement> {
  const { identity } = request;
  const now = request.now ?? new Date();
  const result = await withSubscriptionCorePlacementWorld(
    db,
    codexPlacementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
    async (tx, worldInput): Promise<SubscriptionCoreCodexPlacement> => {
      if (!(await codexCutoverEnabled(tx, identity.accountId)))
        return { kind: "cutover_not_enabled" };
      const fence = await readAttemptFence(tx, request);
      if (!fence) return { kind: "attempt_fenced" };

      const input = await codexPlacementInput(tx, identity, worldInput, request.productModelId);
      const lease = {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        provider: "codex" as const,
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
          healthRetryAt: await earliestCodexHealthRetryAt(tx, identity),
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
      const rotation = input.settings.rotation.codex;
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
async function codexCutoverEnabled(tx: Database, accountId: string): Promise<boolean> {
  return (
    (await readSubscriptionProviderCutoverState(tx, { accountId, provider: "codex" })) === "enabled"
  );
}

/** The world request for one Codex chat turn: its accepted product model only. */
function codexPlacementWorldRequest(
  identity: SubscriptionCoreTurnIdentity,
  productModelId: string,
  reasoningLevel: string,
  now: Date,
) {
  return {
    ...identity,
    preferredModelId: productModelId,
    reasoningLevel,
    // Codex only: Claude and SuperGrok stay on their v1 selectors in M3.
    models: [{ id: productModelId, provider: "codex", reasoningLevels: [reasoningLevel] }],
    // Re-selection points are derived inside the transaction from the
    // binding and session it reads (codexPlacementInput).
    reselectionPoints: [],
    now,
  };
}

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
export function subscriptionCoreCodexReselectionPoints(input: {
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
async function lastCodexContextReplacedAt(
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

/** Strict M3 placement input: Codex connections only, no cross-provider failover. */
async function codexPlacementInput(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
  worldInput: PlacementInput,
  productModelId: string,
): Promise<PlacementInput> {
  const binding = worldInput.session.binding;
  const lastContextReplacedAt =
    binding && binding.lastModelCallAt > 0 ? await lastCodexContextReplacedAt(tx, identity) : null;
  return {
    ...worldInput,
    session: {
      ...worldInput.session,
      reselectionPoints: subscriptionCoreCodexReselectionPoints({
        binding: binding
          ? { modelId: binding.modelId, lastModelCallAt: binding.lastModelCallAt }
          : null,
        productModelId,
        lastContextReplacedAt,
      }),
    },
    settings: { ...worldInput.settings, crossProviderFailover: false, fallbackOrder: {} },
    connections: worldInput.connections.filter((connection) => connection.provider === "codex"),
  };
}

/** Earliest end of a time-bound health quarantine among the visible Codex connections. */
async function earliestCodexHealthRetryAt(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
): Promise<Date | null> {
  const [row] = await rawRows<{ retry_at: Date | string | null }>(
    tx,
    sql`select min(health_retry_at) as retry_at from subscription_connections
      where account_id = ${identity.accountId}::uuid and provider = 'codex'
        and status = 'error' and health_retry_at > clock_timestamp()`,
  );
  return row?.retry_at ? new Date(row.retry_at) : null;
}

export type SubscriptionCoreCodexPlacementEvaluation =
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

/**
 * Decide where this exact accepted turn would run now, without leasing,
 * binding or writing anything. Waiter reconciliation uses it to decide
 * between resuming the blocked turn and waiting longer; the resumed attempt
 * then places (and leases) through placeSubscriptionCoreCodexTurn, which
 * rechecks everything in its own transaction.
 */
/** Read live credit consent and placement without changing a binding or lease. */
export async function canSpendSubscriptionCoreCodexExtraCredits(
  db: Database,
  request: SubscriptionCoreCodexPlacementRequest & { connectionId: string },
): Promise<boolean> {
  const { identity } = request;
  const now = new Date();
  const result = await withSubscriptionCorePlacementWorld(
    db,
    codexPlacementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
    async (tx, worldInput) => {
      if (
        !(await codexCutoverEnabled(tx, identity.accountId)) ||
        !(await readAttemptFence(tx, request))
      )
        return false;
      if (
        !(await assertSubscriptionTurnLeaseCurrent(tx, {
          ...identity,
          provider: "codex",
          connectionId: request.connectionId,
          holderId: request.holderId,
          generation: request.executionGeneration,
        }))
      )
        return false;
      const input = await codexPlacementInput(tx, identity, worldInput, request.productModelId);
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

export async function evaluateSubscriptionCoreCodexPlacement(
  db: Database,
  request: {
    identity: SubscriptionCoreTurnIdentity;
    productModelId: string;
    reasoningLevel: string;
    now?: Date;
  },
): Promise<SubscriptionCoreCodexPlacementEvaluation> {
  const { identity } = request;
  const now = request.now ?? new Date();
  const result = await withSubscriptionCorePlacementWorld(
    db,
    codexPlacementWorldRequest(identity, request.productModelId, request.reasoningLevel, now),
    async (tx, worldInput): Promise<SubscriptionCoreCodexPlacementEvaluation> => {
      if (!(await codexCutoverEnabled(tx, identity.accountId)))
        return { kind: "cutover_not_enabled" };
      const input = await codexPlacementInput(tx, identity, worldInput, request.productModelId);
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
        healthRetryAt: await earliestCodexHealthRetryAt(tx, identity),
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
export async function recoverSubscriptionCoreCodexConnectionHealth(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<number> {
  const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    if (!(await codexCutoverEnabled(tx, identity.accountId))) return 0;
    const [row] = await rawRows<{ recovered: number | string }>(
      tx,
      sql`select opengeni_private.recover_subscription_codex_connection_health(
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
          ${identity.sessionId}::uuid, ${identity.turnId}::uuid
        ) as recovered`,
    );
    return Number(row?.recovered ?? 0);
  });
  return access.status === "completed" ? access.value : 0;
}

/** How long a 403 that survived refresh keeps a connection out of placement. */
export const SUBSCRIPTION_CORE_CODEX_FORBIDDEN_QUARANTINE_MS = 60 * 60 * 1000;
/** How long a plan-entitlement refusal keeps a model off a connection (legacy parity, 0524). */
export const SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Record a refusal that survived refresh as connection health, so eligibility
 * excludes the connection and sticky placement does not return to it:
 * a revoked sign-in becomes `needs_relogin` (cleared only by a new sign-in),
 * and a 403 becomes a time-bound `error` quarantine. Written only for the
 * exact accepted turn holding the live lease, under the refresh-generation
 * compare-and-swap of the credential that was refused.
 */
export async function quarantineSubscriptionCoreCodexConnection(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  input: {
    kind: "sign_in" | "forbidden";
    refreshGeneration: number;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const forbidden = input.kind === "forbidden";
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const [row] = await rawRows<{ marked: boolean }>(
      tx,
      sql`select opengeni_private.quarantine_subscription_codex_connection(
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
                  now.getTime() + SUBSCRIPTION_CORE_CODEX_FORBIDDEN_QUARANTINE_MS,
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
export async function recordSubscriptionCoreCodexModelCooldown(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  input: { modelId: string; until: Date; refreshGeneration: number },
): Promise<boolean> {
  if (!input.modelId.trim() || input.modelId.length > 256) return false;
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const [connection] = await rawRows<{ refresh_generation: number | string }>(
      tx,
      sql`select refresh_generation from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = 'codex'
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
          set quota = jsonb_set(
                case when jsonb_typeof(subscription_connection_quota.quota->'modelCooldowns') = 'object'
                  then subscription_connection_quota.quota
                  else jsonb_set(subscription_connection_quota.quota, '{modelCooldowns}', '{}'::jsonb)
                end,
                array['modelCooldowns', ${input.modelId}],
                to_jsonb(greatest(
                  coalesce((subscription_connection_quota.quota->'modelCooldowns'->>${input.modelId})::bigint, 0),
                  ${input.until.getTime()}::bigint
                ))
              ),
              revision = subscription_connection_quota.revision + 1
          where subscription_connection_quota.account_id = excluded.account_id
        returning connection_id::text as connection_id`,
    );
    return rows.length === 1;
  });
  return access.status === "ok" && access.value;
}

async function readAttemptFence(
  tx: Database,
  request: SubscriptionCoreCodexPlacementRequest,
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
  if (row.provider !== "codex") throw new Error("A core turn lease belongs to another provider");
  return {
    connectionId: row.connection_id,
    holderId: row.holder_id,
    generation: Number(row.generation),
    leasedUntil: new Date(row.leased_until),
    live: row.live,
  };
}

function bindingSwitchReason(
  placementSwitch: PlacementSwitch,
  current: SubscriptionSessionBinding["lastSwitchReason"],
): SubscriptionSessionBinding["lastSwitchReason"] {
  return placementSwitch === "sticky" || placementSwitch === "pinned" ? current : placementSwitch;
}

async function writeBinding(
  tx: Database,
  identity: SubscriptionCoreAcceptedTurnIdentity,
  next: { connectionId: string; modelId: string; placementSwitch: PlacementSwitch },
): Promise<void> {
  const current = await readSubscriptionSessionBinding(tx, identity);
  if (
    current &&
    current.provider === "codex" &&
    current.connectionId === next.connectionId &&
    current.modelId === next.modelId
  ) {
    return;
  }
  const written = await writeSubscriptionSessionBinding(tx, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    provider: "codex",
    connectionId: next.connectionId,
    modelId: next.modelId,
    // A person's explicit choice is changed only by that person.
    choice: current?.choice ?? "automatic",
    onlyThisModel: current?.onlyThisModel ?? false,
    lastModelCallAt: current?.lastModelCallAt ?? null,
    lastSwitchReason: bindingSwitchReason(next.placementSwitch, current?.lastSwitchReason ?? null),
    expectedVersion: current?.version ?? null,
  });
  if (written === null) throw new SubscriptionBindingConflict();
}

/**
 * Give this transaction the per-connection personal capability for the
 * turn's frozen v2 Codex entry. A no-op without that entry, for service and
 * ownerless turns, and before the Codex cutover is enabled.
 */
export async function authorizeSubscriptionCoreFrozenPersonalCodex(
  tx: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<boolean> {
  const personal = subscriptionPersonalAuthorityForProviderV2(
    identity.acceptedAuthorityV2,
    "codex",
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
        ${identity.sessionId}::uuid, ${identity.turnId}::uuid, 'codex',
        ${personal.ownerMembershipId}::uuid, ${personal.authorityGeneration}::bigint,
        ${identity.sessionOwnerSubjectId}, ${identity.initiatingHumanSubjectId}
      ) as authorized`,
  );
  return row?.authorized === true;
}

/** Exact accepted turn + live lease + (for personal) frozen v2 authority. */
async function withLeasedCodexConnection<T>(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  operation: (tx: Database) => Promise<T>,
): Promise<{ status: "not_visible" } | { status: "lease_lost" } | { status: "ok"; value: T }> {
  const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    if (!(await codexCutoverEnabled(tx, identity.accountId)))
      return { status: "not_visible" } as const;
    const current = await assertSubscriptionTurnLeaseCurrent(tx, {
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      provider: "codex",
      connectionId: lease.connectionId,
      holderId: lease.holderId,
      generation: lease.generation,
    });
    if (!current) return { status: "lease_lost" } as const;
    await authorizeSubscriptionCoreFrozenPersonalCodex(tx, identity);
    return { status: "ok", value: await operation(tx) } as const;
  });
  return access.status === "not_visible" ? access : access.value;
}

export type SubscriptionCoreCodexCredential = {
  connectionId: string;
  ownership: "shared" | "personal";
  refreshGeneration: number;
  tokens: { accessToken: string; refreshToken: string; idToken: string };
  chatgptAccountId: string | null;
  isFedramp: boolean;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCodexCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreCodexCredential }
  | { kind: "lease_lost" }
  /** The turn, or the connection under its authority, is not visible. */
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

function decodeCodexTokens(
  key: Uint8Array,
  encrypted: string,
): SubscriptionCoreCodexCredential["tokens"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptEnvironmentValue(key, encrypted));
  } catch {
    // Fixed text and no cause: a JSON.parse message quotes the plaintext it
    // failed on, and runtimes print a cause's message with the error.
    throw new Error("A core Codex credential could not be decrypted");
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.access_token !== "string" ||
    typeof record.refresh_token !== "string" ||
    typeof record.id_token !== "string"
  ) {
    throw new Error("A core Codex credential does not hold the expected token object");
  }
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    idToken: record.id_token,
  };
}

function encryptionKey(settings: Settings): Uint8Array {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error(
      "core Codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured",
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
export async function loadSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
): Promise<SubscriptionCoreCodexCredentialLoad> {
  const key = encryptionKey(settings);
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
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
        where account_id = ${identity.accountId}::uuid and provider = 'codex'
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
      tokens: decodeCodexTokens(key, row.credential_encrypted),
      chatgptAccountId: row.provider_account_id,
      isFedramp: row.provider_state?.isFedramp === true,
      planType: row.plan_type,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
      lastRefreshAt: row.last_refresh_at === null ? null : new Date(row.last_refresh_at),
    },
  };
}

export type SubscriptionCoreCodexRefreshOutcome =
  | {
      kind: "refreshed";
      accessToken: string;
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

export type SubscriptionCoreCodexRefreshDeps = {
  refresh?: typeof refreshCodexToken;
  now?: () => Date;
  /**
   * Called after a persisted refresh whose id_token reports a plan different
   * from the recorded one. The database already cleared the connection's
   * model cooldowns; the caller wakes waiters that may now place.
   */
  onPlanChanged?: (connectionId: string) => void;
};

/**
 * Rotate the leased connection's refresh token through the core's single
 * per-connection lock. Authorization happens in begin, before the provider
 * call; the rotated token is persisted immediately after it returns. A
 * permanent OAuth refusal marks the connection needs-relogin through the
 * same one-shot authorization. Failures are returned, never thrown inside
 * the lock, so that status write commits.
 */
export async function refreshSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observedRefreshGeneration: number,
  deps: SubscriptionCoreCodexRefreshDeps = {},
): Promise<SubscriptionCoreCodexRefreshOutcome> {
  const key = encryptionKey(settings);
  const refresh = deps.refresh ?? refreshCodexToken;
  const now = deps.now ?? (() => new Date());
  const result = await withSubscriptionCoreCodexRefreshLock(
    db,
    {
      ...identity,
      connectionId: lease.connectionId,
      holderId: lease.holderId,
      generation: lease.generation,
    },
    async (tx, credential): Promise<SubscriptionCoreCodexRefreshOutcome> => {
      // Switch-off fails closed before any provider call.
      if (!(await codexCutoverEnabled(tx, identity.accountId))) return { kind: "refused" };
      if (credential.refreshGeneration !== observedRefreshGeneration) return { kind: "superseded" };
      try {
        const tokens = decodeCodexTokens(key, credential.credentialEncrypted);
        const next = await withCodexTokenDeadline(refresh(tokens.refreshToken));
        const rotated = {
          access_token: next.accessToken ?? tokens.accessToken,
          refresh_token: next.refreshToken ?? tokens.refreshToken,
          id_token: next.idToken ?? tokens.idToken,
        };
        // The plan the rotated id_token carries is persisted with the token.
        // Parsing cannot fail the refresh: an unreadable token keeps the plan.
        let planType: string | null = null;
        try {
          planType = next.idToken ? parseIdToken(next.idToken).planType : null;
        } catch {
          planType = null;
        }
        // Persist before any other fallible work: a rolled-back transaction
        // would discard the only valid refresh token.
        const persisted = await persistSubscriptionCodexRefreshWithPlan(tx, {
          accountId: identity.accountId,
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          turnId: identity.turnId,
          connectionId: lease.connectionId,
          expectedRefreshGeneration: credential.refreshGeneration,
          credentialEncrypted: encryptEnvironmentValue(key, JSON.stringify(rotated)),
          expiresAt: accessTokenExpiry(rotated.access_token),
          lastRefreshAt: now(),
          planType,
        });
        if (!persisted) return { kind: "superseded" };
        return {
          kind: "refreshed",
          accessToken: rotated.access_token,
          refreshGeneration: credential.refreshGeneration + 1,
          planType,
        };
      } catch (error) {
        if (error instanceof CodexReloginRequired) {
          const [marked] = await rawRows<{ marked: boolean }>(
            tx,
            sql`select opengeni_private.fail_subscription_codex_refresh(
                ${identity.accountId}::uuid, ${identity.workspaceId}::uuid,
                ${identity.sessionId}::uuid, ${identity.turnId}::uuid,
                ${lease.connectionId}::uuid, ${credential.refreshGeneration}::bigint,
                ${error.message}
              ) as marked`,
          );
          return { kind: "relogin", message: error.message, marked: marked?.marked === true };
        }
        return { kind: "error", error };
      }
    },
  );
  if (result.status !== "completed") return { kind: result.status };
  return result.value;
}

/** Raised when the turn no longer holds its core lease; dispatch must stop. */
export class SubscriptionCoreCodexLeaseLostError extends Error {
  readonly code = "codex_credential_lease_lost";
  constructor() {
    super("The core Codex lease for this turn is no longer current");
    this.name = "SubscriptionCoreCodexLeaseLostError";
  }
}

type CoreRefreshFlight = {
  /** The exact turn lease that started this provider refresh. */
  holderKey: string;
  promise: Promise<SubscriptionCoreCodexRefreshOutcome>;
};

/**
 * The turn lost access to its leased connection mid-turn (the connection, or
 * the turn's authority over it, is no longer visible, enabled or usable).
 * Distinct from a revoked sign-in, which is `CodexReloginRequired`.
 */
export class SubscriptionCoreCodexAccessLostError extends Error {
  readonly code = "subscription_core_access_lost";
  constructor() {
    super("This turn can no longer use its Codex subscription");
    this.name = "SubscriptionCoreCodexAccessLostError";
  }
}

const coreInflight = new Map<string, CoreRefreshFlight>();

/**
 * Outcomes about the connection itself, which every turn waiting on the same
 * connection and generation may share. A lost lease, a refused authorization
 * or an invisible connection belongs to the turn that hit it only.
 */
function connectionLevelRefreshOutcome(outcome: SubscriptionCoreCodexRefreshOutcome): boolean {
  return (
    outcome.kind === "refreshed" ||
    outcome.kind === "superseded" ||
    outcome.kind === "relogin" ||
    outcome.kind === "error"
  );
}

/** Test seams; production uses the database-backed defaults. */
export type SubscriptionCoreCodexResolverDeps = SubscriptionCoreCodexRefreshDeps & {
  load?: typeof loadSubscriptionCoreCodexCredential;
  refreshCredential?: typeof refreshSubscriptionCoreCodexCredential;
};

/**
 * The core counterpart of `buildCodexTokenResolver`: same snapshot shape,
 * proactive staleness refresh and local single-flight, but every read and
 * refresh is scoped to the exact accepted turn and its live lease.
 */
export function buildSubscriptionCoreCodexTokenResolver(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  deps: SubscriptionCoreCodexResolverDeps = {},
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  const loadCredential = deps.load ?? loadSubscriptionCoreCodexCredential;
  const refreshCredential = deps.refreshCredential ?? refreshSubscriptionCoreCodexCredential;
  const holderKey = `${identity.turnId}:${lease.holderId}:${lease.generation}`;
  const load = async (): Promise<SubscriptionCoreCodexCredential> => {
    const loaded = await loadCredential(db, settings, identity, lease);
    switch (loaded.kind) {
      case "loaded":
        return loaded.credential;
      case "lease_lost":
        throw new SubscriptionCoreCodexLeaseLostError();
      case "needs_relogin":
        throw new CodexReloginRequired("The Codex subscription for this turn needs a new sign-in.");
      default:
        throw new SubscriptionCoreCodexAccessLostError();
    }
  };
  const snapshot = (credential: SubscriptionCoreCodexCredential): CodexCredentialTokenSnapshot => ({
    accessToken: credential.tokens.accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    isFedramp: credential.isFedramp,
    credentialVersion: credential.refreshGeneration,
    planType: credential.planType,
  });
  const runOwnRefresh = (credential: SubscriptionCoreCodexCredential) =>
    refreshCredential(db, settings, identity, lease, credential.refreshGeneration, deps);
  const sharedRefresh = async (
    credential: SubscriptionCoreCodexCredential,
  ): Promise<SubscriptionCoreCodexRefreshOutcome> => {
    // Process-wide single-flight per canonical connection and generation;
    // the database advisory lock serializes other replicas.
    const key = `core:${lease.connectionId}:${credential.refreshGeneration}`;
    const existing = coreInflight.get(key);
    if (existing) {
      const outcome = await existing.promise;
      // Another turn's lease or authorization outcome is not this turn's:
      // refresh under this turn's own lease instead.
      return existing.holderKey === holderKey || connectionLevelRefreshOutcome(outcome)
        ? outcome
        : await runOwnRefresh(credential);
    }
    const flight: CoreRefreshFlight = {
      holderKey,
      promise: Promise.resolve() as unknown as Promise<SubscriptionCoreCodexRefreshOutcome>,
    };
    flight.promise = runOwnRefresh(credential).finally(() => {
      if (coreInflight.get(key) === flight) coreInflight.delete(key);
    });
    coreInflight.set(key, flight);
    return await flight.promise;
  };
  const doRefresh = async (
    credential: SubscriptionCoreCodexCredential,
  ): Promise<CodexCredentialTokenSnapshot> => {
    const outcome = await sharedRefresh(credential);
    switch (outcome.kind) {
      case "refreshed":
        if (
          outcome.planType !== null &&
          credential.planType !== null &&
          outcome.planType !== credential.planType
        ) {
          try {
            deps.onPlanChanged?.(lease.connectionId);
          } catch {
            // A wake hint must never fail the request it rode on.
          }
        }
        return {
          accessToken: outcome.accessToken,
          chatgptAccountId: credential.chatgptAccountId,
          isFedramp: credential.isFedramp,
          credentialVersion: outcome.refreshGeneration,
          planType: outcome.planType ?? credential.planType,
        };
      case "superseded":
        return snapshot(await load());
      case "relogin":
        throw new CodexReloginRequired(outcome.message);
      case "lease_lost":
        throw new SubscriptionCoreCodexLeaseLostError();
      case "error":
        throw outcome.error;
      default:
        throw new SubscriptionCoreCodexAccessLostError();
    }
  };
  const resolve = async (force: boolean): Promise<CodexCredentialTokenSnapshot> => {
    const credential = await load();
    const expiry = credential.expiresAt ?? accessTokenExpiry(credential.tokens.accessToken);
    const stale =
      force ||
      (expiry
        ? expiry.getTime() <= Date.now() + CODEX_REFRESH_WINDOW_MS
        : credential.lastRefreshAt
          ? credential.lastRefreshAt.getTime() < Date.now() - CODEX_REFRESH_FALLBACK_MS
          : true);
    return stale ? await doRefresh(credential) : snapshot(credential);
  };
  return { getToken: () => resolve(false), refresh: () => resolve(true) };
}

/**
 * Apply one quota observation (usage headers or a refusal) to the leased
 * connection. The observation applies only to the refresh generation it was
 * made with, and never shortens a running exhaustion (design 2.2).
 */
export async function recordSubscriptionCoreCodexQuotaObservation(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observation: SubscriptionQuota,
): Promise<boolean> {
  return (await applySubscriptionCoreCodexQuotaObservation(db, identity, lease, observation))
    .applied;
}

/**
 * Same as recordSubscriptionCoreCodexQuotaObservation, and also reports
 * whether the observation ended an exhaustion the store still held: that is
 * a capacity change other waiters must hear about (the caller wakes them).
 */
export async function applySubscriptionCoreCodexQuotaObservation(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observation: SubscriptionQuota,
): Promise<{ applied: boolean; recovered: boolean }> {
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const [connection] = await rawRows<{ refresh_generation: number | string }>(
      tx,
      sql`select refresh_generation from subscription_connections
        where account_id = ${identity.accountId}::uuid and provider = 'codex'
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
export async function recordSubscriptionCoreCodexTurnFailure(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  failure: { kind: string; evidence?: Record<string, string | number | boolean | null> },
): Promise<boolean> {
  // Exact accepted turn, enabled gate and this turn's live lease, as for
  // every other core write about the leased connection.
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const rows = await rawRows<{ turn_id: string }>(
      tx,
      sql`insert into subscription_turn_failures (
          account_id, workspace_id, session_id, turn_id, connection_id, provider,
          failure_kind, recovery_evidence
        ) values (
          ${identity.accountId}::uuid, ${identity.workspaceId}::uuid, ${identity.sessionId}::uuid,
          ${identity.turnId}::uuid, ${lease.connectionId}::uuid, 'codex', ${failure.kind},
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
export async function countSubscriptionCoreCodexTurnRefusals(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
): Promise<number | null> {
  const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    if (!(await codexCutoverEnabled(tx, identity.accountId))) return null;
    const [row] = await rawRows<{ refusals: number | string | null }>(
      tx,
      sql`select coalesce(sum(coalesce((recovery_evidence->>'refusals')::integer, 1)), 0) as refusals
        from subscription_turn_failures
        where account_id = ${identity.accountId}::uuid
          and workspace_id = ${identity.workspaceId}::uuid
          and session_id = ${identity.sessionId}::uuid
          and turn_id = ${identity.turnId}::uuid and provider = 'codex'`,
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
export async function touchSubscriptionCoreCodexBinding(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  lastModelCallAt: Date,
): Promise<boolean> {
  if (!identity.sessionOwnerSubjectId) return false;
  const access = await withLeasedCodexConnection(db, identity, lease, async (tx) => {
    const current = await readSubscriptionSessionBinding(tx, identity);
    if (
      !current ||
      current.provider !== "codex" ||
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
