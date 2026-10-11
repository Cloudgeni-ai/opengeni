/**
 * Codex chat-turn placement on the shared subscription core (M3 PR 1,
 * inventory EP-T01..T05): the provider-neutral placement
 * (`subscription-core-capacity.ts`) bound to Codex, under the names M3
 * shipped. Reached only when the organization's Codex cutover row is
 * enabled; missing or disabled cutover state fails closed.
 */
import {
  assertModelConnectionAllowsTurn,
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  CodexCredentialLeaseAttemptFencedError,
  SubscriptionCoreCodexLeaseLostError,
  SubscriptionCoreCodexSourceDisconnectedError,
  isSubscriptionCoreCodexSourceDisconnected,
  buildSubscriptionCoreCodexTokenResolver,
  placeSubscriptionCoreCodexTurn,
  recordSubscriptionCoreCodexSelectionForTurnAttempt,
  type CodexCredentialTokenSnapshot,
  type Database,
  type SubscriptionCoreCodexPlacement,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import { refreshCoreCodexModelEntitlements } from "@opengeni/core";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  CODEX_CORE_WAIT_BINDING,
  recoverCoreCodexHealthAndWake,
  wakeSubscriptionCoreCodexWaitersAndDeliver,
  type CoreCodexWakeServices,
} from "../subscription-core-codex-waits";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import type { CodexTurnLease } from "./credential-leases";
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  parkCoreSubscriptionTurn,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import type { CodexSubscriptionCoreTurn, ProviderTurnState } from "./turn-context";

export function isCoreCodexSourceDisconnectedError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof SubscriptionCoreCodexSourceDisconnectedError) return true;
    current = current.cause;
  }
  return false;
}

/** Codex's chat placement on the shared core. */
export const CODEX_CORE_TURN_PROVIDER: CoreTurnPlacementProvider = {
  id: "codex",
  displayName: "Codex",
  startupPhaseProvider: "codex-subscription",
  leaseTtlMs: CODEX_CREDENTIAL_LEASE_TTL_MS,
  lease: (deps) => deps.leases.codex,
  place: (db, request) => placeSubscriptionCoreCodexTurn(db, request),
  // A recovery wakes the account's other waiters too.
  recoverHealth: async ({ db, signalCodexCapacityWorkflow }, identity) => {
    await recoverCoreCodexHealthAndWake({ db, signalCodexCapacityWorkflow }, identity);
  },
  beforePlacement: (deps, identity) =>
    refreshCoreCodexModelEntitlements(deps.db, deps.settings, {
      accountId: deps.input.accountId,
      workspaceId: deps.input.workspaceId,
      subjectId: identity.initiatingHumanSubjectId,
    }),
  adopt: ({ providerTurn, turnExecutionPolicy }, core, placement) => {
    providerTurn.codexSubscriptionCore = core;
    providerTurn.effectiveCodexCredentialId = placement.connectionId;
    providerTurn.codexProductModelId = turnExecutionPolicy.productModelId;
    providerTurn.codexPolicySnapshot = null;
    // In-turn re-placement after a refusal arrives with the core failover
    // bound (PR 2); this turn never walks to a second account.
    providerTurn.codexCredentialFailoverLimit = 1;
  },
  recordSelection: async (deps, placement, turnId) => {
    const { input, db, bus, observability, attempt, codexWorkspaceKey } = deps;
    const receipt = await recordSubscriptionCoreCodexSelectionForTurnAttempt(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
      attemptId: input.attemptId,
      executionGeneration: attempt.executionGeneration,
      credentialId: placement.connectionId,
      previousCredentialId: placement.previousConnectionId,
      strategy: placement.rotationMode,
      reusedLease: placement.reusedLease,
      pinnedCredentialId: placement.explicit ? placement.connectionId : null,
      eligibleCount: placement.eligibleCount,
      connectedCount: placement.connectedCount,
    });
    await publishDurableSessionEvents(bus, input.workspaceId, input.sessionId, receipt.events);
    observability.incrementCounter({
      name: "opengeni_codex_credential_selections_total",
      help: "Codex credential selections by strategy and reason.",
      labels: {
        workspace_key: codexWorkspaceKey,
        strategy: `core_${placement.rotationMode}`,
        reason: receipt.diagnostics.reason,
      },
    });
  },
  park: (deps, wait) => parkCoreCodexTurn(deps, wait),
  isSourceDisconnected: (db, identity, connectionId) =>
    isSubscriptionCoreCodexSourceDisconnected(db, identity, connectionId),
  sourceDisconnectedError: () => new SubscriptionCoreCodexSourceDisconnectedError(),
  isAttemptFenced: (error) => error instanceof CodexCredentialLeaseAttemptFencedError,
};

/** Lifecycle disappearance is not an auth refusal or an ordinary account pause. */
export async function assertCoreCodexSourceConnected(
  db: Database,
  core: CodexSubscriptionCoreTurn,
): Promise<void> {
  await assertCoreSourceConnected(db, CODEX_CORE_TURN_PROVIDER, core);
}

/**
 * The turn's model-connection check. A shared-core placement already
 * enforced the connection's model allowlist, entitlement exclusions and the
 * workspace model policy in the same transaction as its lease; the legacy
 * check reads legacy rows and must never see a core connection id.
 */
export async function assertTurnModelConnection(
  db: Database,
  providerTurn: Pick<ProviderTurnState, "codexSubscriptionCore"> &
    Partial<Pick<ProviderTurnState, "xaiSubscriptionCore">>,
  input: Parameters<typeof assertModelConnectionAllowsTurn>[1],
): Promise<void> {
  if (providerTurn.codexSubscriptionCore || providerTurn.xaiSubscriptionCore) return;
  await assertModelConnectionAllowsTurn(db, input);
}

/**
 * The bearer resolver for a core-placed turn (EP-T03): the same snapshot
 * shape as the legacy resolver, but every read and refresh goes through the
 * exact accepted turn and this attempt's live core lease. A lost lease marks
 * the local holder lost, so dispatch stops with the ordinary lease-loss error.
 */
export function buildCoreCodexRequestTokenResolver(
  db: Database,
  settings: Settings,
  core: CodexSubscriptionCoreTurn,
  lease: CodexTurnLease,
  wake?: Pick<CoreCodexWakeServices, "signalCodexCapacityWorkflow">,
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  const ref = coreLeaseRef(lease, core, "Codex");
  const resolver = buildSubscriptionCoreCodexTokenResolver(db, settings, core.identity, ref, {
    // A rotated id_token reporting a new plan cleared the connection's
    // model cooldowns in the same commit; waiters may now place (EP-T10).
    onPlanChanged: () =>
      void wakeSubscriptionCoreCodexWaitersAndDeliver(
        { db, signalCodexCapacityWorkflow: wake?.signalCodexCapacityWorkflow },
        { accountId: core.identity.accountId, reason: "plan_changed" },
      ),
  });
  return guardCoreTokenResolver(
    db,
    CODEX_CORE_TURN_PROVIDER,
    core,
    lease,
    resolver,
    (error) => error instanceof SubscriptionCoreCodexLeaseLostError,
  );
}

export async function selectCoreCodexTurnCapacity(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  return await selectCoreSubscriptionTurnCapacity(deps, CODEX_CORE_TURN_PROVIDER);
}

/** Park on the durable core waiter (the shared park, Codex's waiter entry points). */
async function parkCoreCodexTurn(
  deps: CapacityPhaseDeps,
  wait: Extract<SubscriptionCoreCodexPlacement, { kind: "wait" }>,
): Promise<CapacityPhaseOutcome> {
  return await parkCoreSubscriptionTurn(deps, wait, CODEX_CORE_WAIT_BINDING, "Codex");
}
