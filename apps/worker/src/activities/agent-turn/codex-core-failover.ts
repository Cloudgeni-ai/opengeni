/**
 * In-turn re-placement after a definitive refusal on a Codex turn placed by
 * the shared subscription core (M3 PR 2a, inventory EP-T06): the shared
 * failover (`subscription-core-failover.ts`) bound to Codex, under the names
 * and metrics M3 shipped.
 *
 * An explicit choice never fails over (D-24): its placement waits on the
 * chosen account. The per-turn bound counts every refusal of the turn, by
 * any account (SUB-FAIL-11).
 */
import { countSubscriptionCoreCodexTurnRefusals } from "@opengeni/db";
import type { RunAgentTurnResult } from "../types";
import type { CodexCredentialFailure } from "./errors";
import type { TurnFailureDeps } from "./failure-settlement";
import {
  coreFailoverDisposition,
  failOverCoreSubscriptionTurn,
  SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
  type CoreFailoverBinding,
} from "./subscription-core-failover";
import type { CodexSubscriptionCoreTurn } from "./turn-context";

/** The shared per-turn refusal bound, under its M3 name. */
export const SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT = SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT;

/** Pure bound: fail over while under the limit, stop at it. */
export function coreCodexFailoverDisposition(
  refusals: number | null,
  limit: number = SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT,
): "failover" | "exhausted" | "unrecorded" {
  return coreFailoverDisposition(refusals, limit);
}

const CODEX_CORE_FAILOVER: CoreFailoverBinding = {
  displayName: "Codex",
  lease: (deps) => deps.leases.codex,
  countRefusals: (db, identity) => countSubscriptionCoreCodexTurnRefusals(db, identity),
  refusalLimit: SUBSCRIPTION_CORE_CODEX_TURN_REFUSAL_LIMIT,
  recoveryReason: "codex_credential_failover",
  recoveryProvider: "codex-subscription",
  metrics: {
    checkpoints: {
      name: "opengeni_codex_failover_checkpoints_total",
      help: "Durable Codex failover checkpoint attempts by outcome.",
    },
    settlements: {
      name: "opengeni_codex_failover_settlements_total",
      help: "Atomic Codex failover settlements by outcome.",
    },
    labels: (deps) => ({ workspace_key: deps.codexWorkspaceKey }),
  },
};

/**
 * Re-place the same turn after graceful source disappearance, without a
 * refusal/quarantine budget, or settle a recorded refusal within its bound.
 * A usage-verification refusal (`origin`) does not count toward the bound.
 * Returns null when automatic replay is unsafe.
 */
export async function failOverCoreCodexTurn(
  deps: TurnFailureDeps,
  core: CodexSubscriptionCoreTurn,
  refusal: CodexCredentialFailure | "source_disconnected",
): Promise<RunAgentTurnResult | null> {
  return await failOverCoreSubscriptionTurn(
    deps,
    core,
    refusal === "source_disconnected"
      ? refusal
      : { kind: refusal.kind, unbounded: refusal.origin !== undefined },
    CODEX_CORE_FAILOVER,
  );
}
