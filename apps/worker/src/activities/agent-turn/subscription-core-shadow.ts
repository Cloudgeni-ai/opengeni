/**
 * Shadow comparison of the shared subscription core at turn placement
 * (docs/design/subscription-core-2026-10-07.md step M1, SUB-COMPAT-03).
 *
 * After the legacy Claude or SuperGrok selection has decided, the
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
 * It never changes placement and never delays the turn: callers start it in
 * the background (`startSubscriptionCoreShadow`), at most
 * `SUBSCRIPTION_CORE_SHADOW_MAX_IN_FLIGHT` run per process, every failure,
 * timeout and cancellation is swallowed and counted, and the database work is
 * one bounded transaction of SELECT statements under the turn's own session
 * actor that starts no statement after its deadline.
 */
import { createHash } from "node:crypto";
import {
  loadLegacySubscriptionPlacementWorld,
  type Database,
  type LegacyPlacementInputs,
  type LegacyPlacementWorldRequest,
  type LegacyPlacementWorldResult,
  type LegacySessionState,
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
  recordSubscriptionCoreShadowStuckLoad,
  type SubscriptionCoreShadowInput,
  type SubscriptionCoreShadowObservation,
  type SubscriptionCoreShadowParity,
  type SubscriptionCoreShadowPlacement,
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

export type SubscriptionCoreShadowRequest = Omit<
  LegacyPlacementWorldRequest,
  "now" | "statementTimeoutMs" | "deadlineAt" | "signal"
>;

/** The shadow's world request for a turn, from the capacity phase's own inputs. */
export function subscriptionCoreShadowRequest(
  deps: Pick<CapacityPhaseDeps, "input" | "turnExecutionPolicy">,
  provider: LegacyPlacementWorldRequest["provider"],
  turnId: string,
  authorityScope: LegacyPlacementWorldRequest["authorityScope"],
  legacySession: LegacySessionState,
): SubscriptionCoreShadowRequest {
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
    legacySession,
  };
}

export const SUBSCRIPTION_CORE_SHADOW_LOG_INTERVAL_MS = 10 * 60_000;
/** Debug records per process per minute, across all keys. */
export const SUBSCRIPTION_CORE_SHADOW_MAX_LOGS_PER_MINUTE = 30;
/** Shadow comparisons running at once per process; more are skipped as `busy`. */
export const SUBSCRIPTION_CORE_SHADOW_MAX_IN_FLIGHT = 2;
/** A load still unsettled after this many timeouts gives its slot back. */
export const SUBSCRIPTION_CORE_SHADOW_SLOT_CEILING_FACTOR = 10;
const defaultLogThrottle = createLogThrottle({
  intervalMs: SUBSCRIPTION_CORE_SHADOW_LOG_INTERVAL_MS,
  maxKeys: 1_024,
});

/** A fixed-window cap on debug records per process, across all throttle keys. */
export function createShadowLogRateCap(maxPerMinute: number, now: () => number = Date.now) {
  let windowStartedAt = -Infinity;
  let used = 0;
  return {
    take(): boolean {
      const at = now();
      if (at - windowStartedAt >= 60_000) {
        windowStartedAt = at;
        used = 0;
      }
      if (used >= maxPerMinute) return false;
      used += 1;
      return true;
    },
  };
}
const defaultLogRateCap = createShadowLogRateCap(SUBSCRIPTION_CORE_SHADOW_MAX_LOGS_PER_MINUTE);

let inFlight = 0;
/** Shadow comparisons currently running in this process (tests and diagnostics). */
export function subscriptionCoreShadowInFlight(): number {
  return inFlight;
}

export type SubscriptionCoreShadowDeps = {
  enabled: boolean;
  /** Fixed metric label, given outside the request so a failing builder is still attributed. */
  provider: LegacyPlacementWorldRequest["provider"];
  timeoutMs: number;
  db: Database;
  observability: Pick<Observability, "incrementCounter" | "observeHistogram" | "info">;
  /** Built inside the fail-open boundary, so a malformed input is only counted. */
  request: () => SubscriptionCoreShadowRequest;
  legacy: SubscriptionCoreShadowLegacy;
  signal?: AbortSignal | undefined;
  now?: () => Date;
  load?: (
    db: Database,
    request: LegacyPlacementWorldRequest,
  ) => Promise<LegacyPlacementWorldResult>;
  logThrottle?: LogThrottle;
  logRateCap?: { take(): boolean };
  maxInFlight?: number;
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
 * Start the shadow comparison in the background and return at once. The turn
 * never waits for it; the returned promise (which never rejects) is for tests.
 */
export function startSubscriptionCoreShadow(
  deps: SubscriptionCoreShadowDeps,
): Promise<SubscriptionCoreShadowResult> {
  try {
    if (!deps.enabled) return Promise.resolve({ outcome: "disabled" });
    const running = runSubscriptionCoreShadow(deps);
    running.catch(() => undefined);
    return running;
  } catch {
    return Promise.resolve({ outcome: "skipped", reason: "error" });
  }
}

/**
 * Run the shadow comparison. Never throws and never changes placement; the
 * result is returned for tests only.
 */
export async function runSubscriptionCoreShadow(
  deps: SubscriptionCoreShadowDeps,
): Promise<SubscriptionCoreShadowResult> {
  if (!deps.enabled) return { outcome: "disabled" };
  const provider = deps.provider;
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

  const maxInFlight = deps.maxInFlight ?? SUBSCRIPTION_CORE_SHADOW_MAX_IN_FLIGHT;
  let admitted = false;
  let released = false;
  // The slot is held until the database load itself settles, so an abandoned
  // load still counts against the cap.
  const release = () => {
    if (admitted && !released) {
      released = true;
      inFlight -= 1;
    }
  };
  let loadStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Stops the load before its next statement once the shadow stops waiting.
  const stop = new AbortController();
  try {
    const request = { ...deps.request(), provider };
    if (deps.signal?.aborted) return skip("cancelled");
    if (inFlight >= maxInFlight) return skip("busy");
    inFlight += 1;
    admitted = true;
    const timeoutMs = Math.max(1, Math.floor(deps.timeoutMs));
    const now = (deps.now ?? (() => new Date()))();
    const load = deps.load ?? loadLegacySubscriptionPlacementWorld;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        stop.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      onAbort = () => {
        stop.abort();
        resolve(CANCELLED);
      };
      deps.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const loading = load(deps.db, {
      ...request,
      now,
      statementTimeoutMs: timeoutMs,
      deadlineAt: Date.now() + timeoutMs,
      signal: stop.signal,
    });
    // An abandoned load still settles (its statement timeout and deadline
    // bound it); its late failure must never surface. A load that never
    // settles (for example a socket hung by a partition) gives its slot back
    // after a hard ceiling, so it cannot disable the shadow for good.
    loadStarted = true;
    const ceiling = setTimeout(() => {
      if (released) return;
      release();
      try {
        recordSubscriptionCoreShadowStuckLoad(deps.observability, provider);
      } catch {
        // Best effort.
      }
    }, timeoutMs * SUBSCRIPTION_CORE_SHADOW_SLOT_CEILING_FACTOR);
    (ceiling as { unref?: () => void }).unref?.();
    const settle = () => {
      clearTimeout(ceiling);
      release();
    };
    loading.then(settle, settle);
    const loaded = await Promise.race([loading, deadline, cancelled]);
    if (loaded === TIMED_OUT) return skip("timeout");
    if (loaded === CANCELLED) return skip("cancelled");
    if (loaded.status === "skipped") return skip(loaded.reason);
    const comparison = compareSubscriptionCoreShadow(loaded, deps.legacy);
    const throttle = deps.logThrottle ?? defaultLogThrottle;
    const rateCap = deps.logRateCap ?? defaultLogRateCap;
    const notable =
      comparison.parity === "not_authorized" ||
      comparison.parity === "unknown_connection" ||
      comparison.violations.length > 0;
    const admission = throttle.admit(
      [
        request.workspaceId,
        provider,
        comparison.parity,
        comparison.parityReasons[0] ?? "-",
        comparison.placement,
        notable ? "notable" : "routine",
      ].join(":"),
    );
    if (admission && rateCap.take()) {
      deps.observability.info("Subscription core shadow comparison", {
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        turnId: request.turnId,
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
    if (!loadStarted) release();
    if (timer) clearTimeout(timer);
    if (onAbort) deps.signal?.removeEventListener("abort", onAbort);
    stop.abort();
  }
}
