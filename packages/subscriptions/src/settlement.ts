import {
  modelCooldownFromOutcome,
  type ProviderErrorOutcome,
  type SubscriptionCoreAdapter,
} from "./adapter";
import type { ModelId, SubscriptionQuota } from "./types";

/**
 * How a reserved model request settles (the request ledger's outcome):
 * `refused` when the provider definitively declined it, `response_received`
 * when a response arrived (an error response included), `unknown` when the
 * outcome cannot be known (the connection dropped mid-call), which blocks
 * every later request of the turn instead of a replay.
 */
export type SubscriptionCoreRequestOutcome = "response_received" | "refused" | "unknown";

/** The connection state a definitive refusal leaves, so placement avoids it. */
export type SubscriptionCoreRefusalHealth =
  /** A quota observation: exhausted (usage limit, spend budget or rate limit) until `exhaustedUntil`. */
  | { kind: "quota"; observation: SubscriptionQuota }
  /** One model rests on the connection until `until`. */
  | { kind: "model_cooldown"; modelId: ModelId; until: number }
  /** `sign_in`: needs a new sign-in or key; `forbidden`: a time-bound quarantine. */
  | { kind: "quarantine"; reason: "sign_in" | "forbidden" };

/**
 * The provider-neutral settlement of one classified upstream outcome on the
 * leased connection (design 5.3, "API-key connectors on the shared core").
 *
 * - `retry_after_refresh`: a refused renewable credential is refreshed once
 *   under the core's lock and the same connection is retried; only a refusal
 *   that survives the refresh is settled.
 * - `settle`: the (turn, connection) failure receipt is written first (it
 *   counts toward the per-turn failover bound and carries the refresh
 *   generation the refused credential held), then `health`; placement then
 *   fails over.
 * - `no_failover`: an overloaded, failed or fatal reply is not a refusal of
 *   the connection: no receipt, no health change, no rotation (it may have
 *   consumed work; the turn's own error handling decides).
 */
export type SubscriptionCoreRefusalPlan =
  | { kind: "retry_after_refresh"; requestOutcome: SubscriptionCoreRequestOutcome }
  | {
      kind: "settle";
      requestOutcome: SubscriptionCoreRequestOutcome;
      receipt: { kind: ProviderErrorOutcome["kind"]; evidence: { refreshGeneration: number } };
      health: SubscriptionCoreRefusalHealth;
    }
  | { kind: "no_failover"; requestOutcome: SubscriptionCoreRequestOutcome };

/**
 * Plan the settlement of one classified outcome. A null outcome (the
 * connector could not classify what happened, such as a dropped connection)
 * is an unknown request outcome and never a refusal.
 *
 * - a `rate_limited` or `exhausted` refusal naming a model (`modelId`): that
 *   model cools down on the connection until the provider's time, or the
 *   matching fallback below; the connection keeps serving other models;
 * - `rate_limited`: exhausted (`rate_limit`) until the retry time, or the
 *   adapter's `rateLimitFallbackMs` when the provider gave none;
 * - `exhausted`: exhausted (`quota`) until the provider's reset, which is
 *   authoritative. Without a known future reset, an exhausted window that
 *   resets after the adapter's `exhaustedFallbackMs` instead: placement
 *   retries the connection then even when no usage reading exists, and a
 *   later usage reading (which replaces windows but never shortens an
 *   exhaustion deadline) can show recovered capacity sooner;
 * - `entitlement_missing`: the model cools down for `entitlementCooldownMs`;
 * - `unauthorized` and `forbidden`: refresh and retry once when the credential
 *   renews and has not been refreshed for this refusal; otherwise
 *   `unauthorized` needs a new sign-in (a static key: a new key) and
 *   `forbidden` is quarantined for `forbiddenQuarantineMs`.
 */
export function planSubscriptionCoreRefusal(
  adapter: Pick<SubscriptionCoreAdapter, "health">,
  outcome: ProviderErrorOutcome | null,
  input: {
    now: number;
    /** The refresh generation of the credential the refused request carried. */
    refreshGeneration: number;
    /** The credential renews (the core may refresh it). */
    renewable: boolean;
    /** This refusal already follows a refresh of the same connection. */
    refreshed: boolean;
  },
): SubscriptionCoreRefusalPlan {
  if (outcome === null) return { kind: "no_failover", requestOutcome: "unknown" };
  const { now, refreshGeneration } = input;
  const quota = (
    fields: Pick<SubscriptionQuota, "windows" | "exhaustedUntil" | "exhaustedKind">,
  ): SubscriptionCoreRefusalHealth => ({
    kind: "quota" as const,
    observation: {
      modelCooldowns: {},
      revision: 0,
      observedAt: now,
      observedRefreshGeneration: refreshGeneration,
      source: "refusal" as const,
      ...fields,
    },
  });
  const settle = (health: SubscriptionCoreRefusalHealth): SubscriptionCoreRefusalPlan => ({
    kind: "settle",
    requestOutcome: "refused",
    receipt: { kind: outcome.kind, evidence: { refreshGeneration } },
    health,
  });
  // A limit on one model (a gateway's per-model rate limit or budget) cools
  // that model only, until the provider's time or the adapter's fallback;
  // the connection keeps serving its other models.
  if (
    (outcome.kind === "rate_limited" || outcome.kind === "exhausted") &&
    outcome.modelId !== undefined
  ) {
    const known = modelCooldownFromOutcome(outcome, now);
    return settle({
      kind: "model_cooldown",
      modelId: outcome.modelId,
      until:
        known !== null && known.until > now
          ? known.until
          : now +
            (outcome.kind === "rate_limited"
              ? adapter.health.rateLimitFallbackMs
              : adapter.health.exhaustedFallbackMs),
    });
  }
  switch (outcome.kind) {
    case "rate_limited":
      return settle(
        quota({
          windows: [],
          exhaustedUntil:
            now +
            (outcome.retryAfterMs !== null && outcome.retryAfterMs > 0
              ? outcome.retryAfterMs
              : adapter.health.rateLimitFallbackMs),
          exhaustedKind: "rate_limit",
        }),
      );
    case "exhausted":
      return settle(
        outcome.resetAt !== null && outcome.resetAt > now
          ? quota({ windows: [], exhaustedUntil: outcome.resetAt, exhaustedKind: "quota" })
          : quota({
              windows: [
                {
                  id: "exhausted_without_reset",
                  usedPercent: 100,
                  resetsAt: now + adapter.health.exhaustedFallbackMs,
                  status: "exhausted",
                },
              ],
              exhaustedUntil: null,
              exhaustedKind: null,
            }),
      );
    case "entitlement_missing":
      return settle({
        kind: "model_cooldown",
        modelId: outcome.modelId,
        until: now + adapter.health.entitlementCooldownMs,
      });
    case "unauthorized":
    case "forbidden":
      if (input.renewable && !input.refreshed)
        return { kind: "retry_after_refresh", requestOutcome: "refused" };
      return settle({
        kind: "quarantine",
        reason: outcome.kind === "unauthorized" ? "sign_in" : "forbidden",
      });
    case "overloaded":
      return { kind: "no_failover", requestOutcome: "refused" };
    case "transient":
    case "fatal":
      return { kind: "no_failover", requestOutcome: "response_received" };
  }
}
