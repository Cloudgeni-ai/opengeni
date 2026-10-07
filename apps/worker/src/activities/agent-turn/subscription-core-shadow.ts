/**
 * Shadow comparison of the shared subscription core at turn placement
 * (docs/design/subscription-core-2026-10-07.md step M1, SUB-COMPAT-03).
 *
 * After the legacy Codex, Claude or SuperGrok selection has decided, the
 * worker loads a read-only legacy world for the same session and turn, runs
 * the core's placement on it and records only content-free data:
 *
 * - security parity: is the legacy-selected account inside the core's
 *   eligible set, and if not, the first fixed reason;
 * - the reference checker's contract violations of the core's own decision;
 * - would-switch: whether the core would place on a different account, wait
 *   or fail;
 * - the legacy decision inputs the Codex fleet shadow omits, with per-session
 *   stable aliases instead of connection ids.
 *
 * It never changes placement: every failure, timeout and cancellation is
 * swallowed and counted, the database work is one bounded read-only
 * transaction under the turn's own session actor, and a deadline bounds the
 * time it can add to the turn.
 */
import { createHash } from "node:crypto";
import {
  loadLegacySubscriptionPlacementWorld,
  type Database,
  type LegacyPlacementInputs,
  type LegacyPlacementWorldRequest,
  type LegacyPlacementWorldResult,
} from "@opengeni/db";
import { createLogThrottle, type LogThrottle, type Observability } from "@opengeni/observability";
import {
  connectionIneligibility,
  decidePlacement,
  isAuthorizationIneligibility,
  quotaCapacity,
  type PlacementDecision,
  type PlacementInput,
} from "@opengeni/subscriptions";
import { checkPlacementDecision } from "@opengeni/subscriptions/reference";
import {
  recordSubscriptionCoreShadow,
  type SubscriptionCoreShadowInput,
  type SubscriptionCoreShadowObservation,
  type SubscriptionCoreShadowParity,
  type SubscriptionCoreShadowPlacement,
  type SubscriptionCoreShadowProvider,
} from "../../observability-metrics";
import type { CapacityPhaseDeps } from "./codex-capacity";

/** The legacy selector's outcome for this turn. */
export type SubscriptionCoreShadowLegacy = {
  selectedConnectionId: string | null;
  /** The legacy lease was reused from an earlier attempt of the same turn. */
  reusedLease: boolean;
};

export type SubscriptionCoreShadowComparison = {
  decision: PlacementDecision;
  parity: SubscriptionCoreShadowParity;
  parityReasons: string[];
  placement: SubscriptionCoreShadowPlacement;
  violations: string[];
  inputs: SubscriptionCoreShadowInput[];
};

/** Pure comparison of the core's decision with the legacy decision on one world. */
export function compareSubscriptionCoreShadow(
  world: { input: PlacementInput; legacy: LegacyPlacementInputs },
  legacy: SubscriptionCoreShadowLegacy,
): SubscriptionCoreShadowComparison {
  const { input } = world;
  const decision = decidePlacement(input);
  let violations: string[];
  try {
    violations = checkPlacementDecision(input, decision).map((violation) => violation.requirement);
  } catch {
    violations = ["checker_error"];
  }
  let parity: SubscriptionCoreShadowParity;
  let parityReasons: string[] = [];
  const legacyConnection = legacy.selectedConnectionId
    ? input.connections.find((connection) => connection.id === legacy.selectedConnectionId)
    : undefined;
  if (!legacy.selectedConnectionId) parity = "no_selection";
  else if (!legacyConnection) parity = "unknown_connection";
  else {
    const reasons = connectionIneligibility(
      input,
      legacyConnection,
      input.session.preferredModelId,
    );
    // Authorization reasons first: they are the security parity signal.
    const authorization = reasons.filter(isAuthorizationIneligibility);
    parityReasons = [
      ...authorization,
      ...reasons.filter((reason) => !isAuthorizationIneligibility(reason)),
    ];
    parity =
      reasons.length === 0
        ? "eligible"
        : authorization.length > 0
          ? "not_authorized"
          : "not_servable";
  }
  let placement: SubscriptionCoreShadowPlacement;
  if (legacy.selectedConnectionId) {
    placement =
      decision.kind === "run"
        ? decision.connectionId === legacy.selectedConnectionId
          ? "same_account"
          : "different_account"
        : "core_waits";
  } else {
    placement = decision.kind === "run" ? "core_runs_legacy_waits" : "both_wait";
  }
  return {
    decision,
    parity,
    parityReasons,
    placement,
    violations,
    inputs: presentInputs(world, legacy),
  };
}

function presentInputs(
  world: { input: PlacementInput; legacy: LegacyPlacementInputs },
  legacy: SubscriptionCoreShadowLegacy,
): SubscriptionCoreShadowInput[] {
  const { input, legacy: inputs } = world;
  const modelId = input.session.preferredModelId;
  const present = new Set<SubscriptionCoreShadowInput>();
  if (inputs.pin?.source === "manual") present.add("manual_pin");
  if (inputs.pin?.source === "policy") present.add("policy_pin");
  if (inputs.lastConnectionId) present.add("last_account");
  if (inputs.rotationEnabled === false) present.add("rotation_off");
  if (inputs.rotationEnabled === true) present.add("rotation_on");
  if (inputs.source === "organization") present.add("organization_pool");
  if (inputs.source === "user") present.add("personal_pool");
  if (inputs.codexMode !== null && inputs.codexMode !== "automatic") {
    present.add("codex_mode_override");
  }
  if (inputs.workspaceModelPolicy !== "none") present.add("model_policy");
  if (input.session.compactionProviderLock !== null) present.add("compaction_lock");
  if (legacy.reusedLease) present.add("lease_reused");
  if (inputs.truncated) present.add("truncated");
  for (const connection of input.connections) {
    if (connection.allowedModelIds !== null && !connection.allowedModelIds.includes(modelId)) {
      present.add("model_filtered");
    }
    if (connection.excludedModelIds.includes(modelId)) present.add("plan_excluded");
    if ((connection.quota?.modelCooldowns[modelId] ?? -Infinity) > input.now) {
      present.add("model_cooldown");
    }
    const capacity = quotaCapacity(connection.quota, input.now).kind;
    if (capacity === "exhausted") present.add("exhausted");
    if (capacity === "unknown") present.add("unknown_quota");
  }
  return [...present];
}

/** A per-session stable, unlinkable-across-sessions alias for a connection id. */
export function shadowConnectionAlias(sessionId: string, connectionId: string): string {
  return (
    "c" +
    createHash("sha256")
      .update(sessionId + "\u0000" + connectionId)
      .digest("hex")
      .slice(0, 10)
  );
}

const MAX_LOGGED_CANDIDATES = 16;

function debugRecord(
  world: { input: PlacementInput; legacy: LegacyPlacementInputs },
  legacy: SubscriptionCoreShadowLegacy,
  comparison: SubscriptionCoreShadowComparison,
): Record<string, string | number | boolean | null> {
  const { input, legacy: inputs } = world;
  const alias = (id: string | null | undefined) =>
    id ? shadowConnectionAlias(input.session.id, id) : null;
  const modelId = input.session.preferredModelId;
  const candidates = input.connections.slice(0, MAX_LOGGED_CANDIDATES).map((connection) => ({
    alias: alias(connection.id),
    ownership: connection.ownership.kind,
    scope: connection.ownership.kind === "shared" ? connection.ownership.scope.kind : null,
    health: connection.health,
    allocator: connection.allocatorEnabled,
    capacity: quotaCapacity(connection.quota, input.now).kind,
    ineligible: connectionIneligibility(input, connection, modelId),
  }));
  const decision = comparison.decision;
  return {
    parity: comparison.parity,
    parityReasons: comparison.parityReasons.join(","),
    placement: comparison.placement,
    violations: comparison.violations.join(","),
    coreOutcome: decision.kind === "run" ? "run:" + decision.switch : "wait:" + decision.reason,
    coreConnection: decision.kind === "run" ? alias(decision.connectionId) : null,
    legacyConnection: alias(legacy.selectedConnectionId),
    legacySource: inputs.source,
    codexMode: inputs.codexMode,
    rotationEnabled: inputs.rotationEnabled,
    activeConnection: alias(inputs.activeConnectionId),
    pinConnection: alias(inputs.pin?.connectionId),
    pinSource: inputs.pin?.source ?? null,
    lastConnection: alias(inputs.lastConnectionId),
    poolOrder: inputs.poolOrder.slice(0, MAX_LOGGED_CANDIDATES).map(alias).join(","),
    workspaceModelPolicy: inputs.workspaceModelPolicy,
    idleMs: inputs.lastModelCallAt === null ? null : input.now - inputs.lastModelCallAt,
    reusedLease: legacy.reusedLease,
    truncated: inputs.truncated,
    connectionCount: input.connections.length,
    candidates: JSON.stringify(candidates),
  };
}

/** The shadow's world request for a turn, from the capacity phase's own inputs. */
export function subscriptionCoreShadowRequest(
  deps: Pick<CapacityPhaseDeps, "input" | "turn" | "turnExecutionPolicy">,
  provider: LegacyPlacementWorldRequest["provider"],
  turnId: string,
  authorityScope: LegacyPlacementWorldRequest["authorityScope"],
): SubscriptionCoreShadowDeps["request"] {
  const policy = deps.turnExecutionPolicy;
  return {
    accountId: deps.input.accountId,
    workspaceId: deps.input.workspaceId,
    sessionId: deps.input.sessionId,
    turnId,
    provider,
    productModelId: policy.productModelId,
    upstreamModelId: policy.upstreamModelId,
    reasoningLevel: policy.reasoningEffort,
    // The same provider identity the authoritative workspace model gate uses.
    modelPolicyProviderId: policy.providerId,
    authorityScope,
    initiatingHumanSubjectId: deps.turn.initiatingHumanSubjectId ?? null,
  };
}

export const SUBSCRIPTION_CORE_SHADOW_LOG_INTERVAL_MS = 10 * 60_000;
const defaultLogThrottle = createLogThrottle({
  intervalMs: SUBSCRIPTION_CORE_SHADOW_LOG_INTERVAL_MS,
  maxKeys: 1_024,
});

export type SubscriptionCoreShadowDeps = {
  enabled: boolean;
  timeoutMs: number;
  db: Database;
  observability: Pick<Observability, "incrementCounter" | "observeHistogram" | "info">;
  request: Omit<LegacyPlacementWorldRequest, "now" | "statementTimeoutMs" | "deadlineAt">;
  legacy: SubscriptionCoreShadowLegacy;
  signal?: AbortSignal | undefined;
  now?: () => Date;
  load?: (
    db: Database,
    request: LegacyPlacementWorldRequest,
  ) => Promise<LegacyPlacementWorldResult>;
  logThrottle?: LogThrottle;
};

export type SubscriptionCoreShadowResult =
  | { outcome: "disabled" }
  | {
      outcome: "skipped";
      reason: Extract<SubscriptionCoreShadowObservation, { outcome: "skipped" }>["reason"];
    }
  | { outcome: "compared"; comparison: SubscriptionCoreShadowComparison };

const TIMED_OUT = Symbol("subscription-core-shadow-timeout");
const CANCELLED = Symbol("subscription-core-shadow-cancelled");

/**
 * Run the shadow comparison. Never throws and never changes placement; the
 * result is returned for tests only.
 */
export async function runSubscriptionCoreShadow(
  deps: SubscriptionCoreShadowDeps,
): Promise<SubscriptionCoreShadowResult> {
  if (!deps.enabled) return { outcome: "disabled" };
  const provider = deps.request.provider as SubscriptionCoreShadowProvider;
  const startedAt = performance.now();
  const finish = (
    observation: SubscriptionCoreShadowObservation,
    result: SubscriptionCoreShadowResult,
  ): SubscriptionCoreShadowResult => {
    try {
      recordSubscriptionCoreShadow(
        deps.observability,
        provider,
        observation,
        (performance.now() - startedAt) / 1000,
      );
    } catch {
      // Metrics are best effort too.
    }
    return result;
  };
  const skip = (
    reason: Extract<SubscriptionCoreShadowObservation, { outcome: "skipped" }>["reason"],
  ) => finish({ outcome: "skipped", reason }, { outcome: "skipped", reason });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (deps.signal?.aborted) return skip("cancelled");
    const timeoutMs = Math.max(1, Math.floor(deps.timeoutMs));
    const now = (deps.now ?? (() => new Date()))();
    const load = deps.load ?? loadLegacySubscriptionPlacementWorld;
    const loading = load(deps.db, {
      ...deps.request,
      now,
      statementTimeoutMs: timeoutMs,
      deadlineAt: Date.now() + timeoutMs,
    });
    // An abandoned load still settles (its own statement timeout and
    // deadline bound it); its late failure must never surface.
    loading.catch(() => undefined);
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      onAbort = () => resolve(CANCELLED);
      deps.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const loaded = await Promise.race([loading, deadline, cancelled]);
    if (loaded === TIMED_OUT) return skip("timeout");
    if (loaded === CANCELLED) return skip("cancelled");
    if (loaded.status === "skipped") return skip(loaded.reason);
    const comparison = compareSubscriptionCoreShadow(loaded, deps.legacy);
    const throttle = deps.logThrottle ?? defaultLogThrottle;
    const notable =
      comparison.parity === "not_authorized" ||
      comparison.parity === "unknown_connection" ||
      comparison.violations.length > 0;
    const admission = throttle.admit(
      [
        deps.request.workspaceId,
        provider,
        comparison.parity,
        comparison.placement,
        notable ? "notable" : "routine",
      ].join(":"),
    );
    if (admission) {
      deps.observability.info("Subscription core shadow comparison", {
        workspaceId: deps.request.workspaceId,
        sessionId: deps.request.sessionId,
        turnId: deps.request.turnId,
        provider,
        ...debugRecord(loaded, deps.legacy, comparison),
        ...(admission.suppressedCount > 0 ? { suppressedCount: admission.suppressedCount } : {}),
      });
    }
    return finish(
      {
        outcome: "compared",
        parity: comparison.parity,
        parityReason: comparison.parityReasons[0] ?? null,
        placement: comparison.placement,
        violations: comparison.violations,
        inputs: comparison.inputs,
      },
      { outcome: "compared", comparison },
    );
  } catch {
    return skip(deps.signal?.aborted ? "cancelled" : "error");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) deps.signal?.removeEventListener("abort", onAbort);
  }
}
