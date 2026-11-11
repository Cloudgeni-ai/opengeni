import { type Settings } from "@opengeni/config";

import type {
  TurnActivityServices as ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "../types";

import { createTurnCredentialLeases } from "./credential-leases";
import { selectCoreCodexTurnCapacity } from "./codex-core-capacity";

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
  /** Accepted-turn work owned and drained by the activity, never a draft hint. */
  codexEntitlementPreparation?: Promise<number> | undefined;
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

export async function selectCodexTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  // This phase is invoked for every turn; only Codex-billed work is placed
  // on the shared core here.
  if (!deps.billingState.isCodexTurn) return { ok: true };
  return await selectCoreCodexTurnCapacity(deps);
}
