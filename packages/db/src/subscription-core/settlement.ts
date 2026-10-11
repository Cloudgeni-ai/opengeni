/**
 * The provider-neutral settlement step for one classified upstream outcome
 * on a leased connection (design docs/design/subscription-core-2026-10-07.md,
 * 5.3 "API-key connectors on the shared core"): the request ledger outcome,
 * then the plan of `planSubscriptionCoreRefusal` applied through the core's
 * fenced writers. It is the settlement every adapter's turn path is to use (a
 * connector contributes only its classification and its health durations);
 * today the conformance suite drives it, and the live worker still settles
 * through its own provider-named step until it adopts this one (decision 5).
 */
import type { Settings } from "@opengeni/config";
import {
  planSubscriptionCoreRefusal,
  subscriptionCoreCredentialRefresher,
  type ProviderErrorOutcome,
} from "@opengeni/subscriptions";

import type { Database } from "../database";

import { memoByProvider, type SubscriptionCoreProvider } from "./provider";
import { subscriptionCoreRequests } from "./requests";
import {
  subscriptionCoreTurns,
  type SubscriptionCoreLeaseRef,
  type SubscriptionCoreTurnIdentity,
} from "./turns";

export type SubscriptionCoreSettlement =
  /** Retry the same connection once with the refreshed (or concurrently renewed) credential. */
  | { kind: "retry_same_connection" }
  /**
   * The refusal is recorded; placement fails over. `receipt` and `health`
   * report each fenced write (false: the turn or its lease was no longer
   * current, or the credential had already moved on).
   */
  | { kind: "settled"; receipt: boolean; health: boolean }
  /** Not a refusal of the connection: nothing recorded, no failover. */
  | { kind: "no_failover" }
  /** The refresh could not run (lease lost, not visible, failed): nothing recorded. */
  | { kind: "refresh_failed"; reason: string };

export const subscriptionCoreSettlement = memoByProvider((provider: SubscriptionCoreProvider) => {
  async function settleSubscriptionCoreOutcome(
    db: Database,
    settings: Settings,
    identity: SubscriptionCoreTurnIdentity,
    lease: SubscriptionCoreLeaseRef,
    input: {
      /** The connector's classification, or null when it could not classify. */
      outcome: ProviderErrorOutcome | null;
      /** The refresh generation the refused request's credential held. */
      refreshGeneration: number;
      /** The decoded credential the request carried (its format decides renewal). */
      credential: unknown;
      /** This outcome follows a refresh of the same connection for this request. */
      refreshed: boolean;
      /** The reserved request this outcome settles. */
      request: { operationId: string; attemptId: string; executionGeneration: number };
      now?: number;
    },
  ): Promise<SubscriptionCoreSettlement> {
    const runtime = subscriptionCoreTurns(provider);
    const now = input.now ?? Date.now();
    const plan = planSubscriptionCoreRefusal(provider.adapter, input.outcome, {
      now,
      refreshGeneration: input.refreshGeneration,
      renewable: subscriptionCoreCredentialRefresher(provider.adapter, input.credential) !== null,
      refreshed: input.refreshed,
    });
    await subscriptionCoreRequests(provider).settleSubscriptionCoreRequest(db, identity, lease, {
      ...input.request,
      outcome: plan.requestOutcome,
    });
    switch (plan.kind) {
      case "no_failover":
        return { kind: "no_failover" };
      case "retry_after_refresh": {
        const refreshed = await runtime.refreshSubscriptionCoreCredential(
          db,
          settings,
          identity,
          lease,
          input.refreshGeneration,
        );
        if (refreshed.kind === "refreshed" || refreshed.kind === "superseded")
          return { kind: "retry_same_connection" };
        if (refreshed.kind === "relogin") {
          // The refresh itself was refused and marked the connection.
          const receipt = await runtime.recordSubscriptionCoreTurnFailure(db, identity, lease, {
            kind: input.outcome!.kind,
            evidence: { refreshGeneration: input.refreshGeneration },
          });
          return { kind: "settled", receipt, health: refreshed.marked };
        }
        return { kind: "refresh_failed", reason: refreshed.kind };
      }
      case "settle": {
        // The receipt first: it counts toward the per-turn failover bound
        // even when the health write is fenced out.
        const receipt = await runtime.recordSubscriptionCoreTurnFailure(
          db,
          identity,
          lease,
          plan.receipt,
        );
        const health = plan.health;
        let applied: boolean;
        switch (health.kind) {
          case "quota":
            applied = await runtime.recordSubscriptionCoreQuotaObservation(
              db,
              identity,
              lease,
              health.observation,
            );
            break;
          case "model_cooldown":
            applied = await runtime.recordSubscriptionCoreModelCooldown(db, identity, lease, {
              modelId: health.modelId,
              until: new Date(health.until),
              refreshGeneration: input.refreshGeneration,
            });
            break;
          case "quarantine":
            applied = await runtime.quarantineSubscriptionCoreConnection(db, identity, lease, {
              kind: health.reason,
              refreshGeneration: input.refreshGeneration,
              now: new Date(now),
            });
            break;
        }
        return { kind: "settled", receipt, health: applied };
      }
    }
  }

  return { settleSubscriptionCoreOutcome };
});
