import { readSubscriptionProviderCutoverState, withRlsContext } from "@opengeni/db";
import { type Settings } from "@opengeni/config";

import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";

import { createTurnCredentialLeases } from "./credential-leases";
import { selectCoreCodexTurnCapacity } from "./codex-core-capacity";
import { subscriptionCoreCutoverDisabledFailure } from "./codex-core-errors";

import type { ClaimTurnOk } from "./claim";
import type {
  AttemptIdentityState,
  BillingState,
  ClaimedResult,
  EventingState,
  ProviderTurnState,
  TurnControlState,
} from "./turn-context";

export type CapacityPhaseDeps = {
  input: RunAgentTurnInput;
  settings: Settings;
  db: ActivityServices["db"];
  bus: ActivityServices["bus"];
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: ActivityServices["wakeSessionWorkflow"];
  signalCodexCapacityWorkflow: ActivityServices["signalCodexCapacityWorkflow"];
  cancellationSignal: AbortSignal | undefined;
  dispatchId: string;
  control: TurnControlState;
  attempt: AttemptIdentityState;
  billingState: BillingState;
  eventing: EventingState & {
    publish: NonNullable<EventingState["publish"]>;
    settle: NonNullable<EventingState["settle"]>;
  };
  providerTurn: ProviderTurnState;
  leases: ReturnType<typeof createTurnCredentialLeases>;
  claimedResult: ClaimedResult;
  acknowledgeLostAttemptOwnership: () => void;
  acknowledgeRecoveryQuiescence: () => void;
  setLastInputTokensFenced: (lastInputTokens: number | null) => Promise<void>;
  turn: ClaimTurnOk["turn"];
  session: ClaimTurnOk["session"];
  turnExecutionPolicy: ClaimTurnOk["turnExecutionPolicy"];
  trigger: ClaimTurnOk["trigger"];
  codexWorkspaceKey: string;
};

export type CapacityPhaseOutcome = { exit: RunAgentTurnResult } | { ok: true };

export type CodexCutoverState = "not_configured" | "disabled" | "enabled";

/** Missing or disabled cutover state is maintenance, never legacy routing. */
export function codexCutoverDisposition(state: CodexCutoverState): "core" | "fail_closed" {
  return state === "enabled" ? "core" : "fail_closed";
}

export async function selectCodexTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  // This phase is invoked for every turn. Only Codex-billed work may read or
  // be blocked by Codex's one-way cutover state.
  if (!deps.billingState.isCodexTurn) return { ok: true };

  const cutover = await withRlsContext(
    deps.db,
    { accountId: deps.input.accountId, workspaceId: deps.input.workspaceId },
    (scoped) =>
      readSubscriptionProviderCutoverState(scoped, {
        accountId: deps.input.accountId,
        provider: "codex",
      }),
  );
  const disposition = codexCutoverDisposition(cutover);
  // Once the one-way migration has created a provider row, an explicitly
  // disabled cutover must never silently route work back through the legacy
  // Codex tables; an enabled one places the turn on the shared core.
  if (disposition === "fail_closed") throw subscriptionCoreCutoverDisabledFailure();
  return await selectCoreCodexTurnCapacity(deps);
}
