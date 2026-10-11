/**
 * SuperGrok on the shared subscription core (design 5.3, SuperGrok track
 * X1a): the provider-neutral chat placement and request custody bound to
 * SuperGrok. SuperGrok runs only on the core (the legacy path was deleted in
 * X4): the route is `core` after the SuperGrok drained cutover commits its
 * receipt (X3), which this binary requires; any other route fails closed.
 */
import {
  CodexCredentialLeaseAttemptFencedError,
  readSubscriptionCoreProviderRoute,
  SUBSCRIPTION_CORE_XAI,
  SubscriptionCoreError,
  subscriptionCoreRequests,
  subscriptionCoreTurns,
  withRlsContext,
  buildSubscriptionCoreXaiTokenResolver,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  type Database,
  type SubscriptionCoreProvider,
} from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import type { XaiSubscriptionRequestContext } from "@opengeni/xai-subscription";
import type { CapacityPhaseDeps, CapacityPhaseOutcome } from "./codex-capacity";
import { subscriptionCoreCutoverDisabledFailure } from "./codex-core-errors";
import type { XaiTurnLease } from "./credential-leases";
import { classifyXaiProviderError } from "./errors";
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  parkCoreSubscriptionTurn,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import {
  SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
  subscriptionCoreFailoverMetrics,
} from "./subscription-core-failover";
import { createCoreSubscriptionRequests } from "./subscription-core-requests";
import type { CoreRefusalBinding } from "./subscription-core-settlement";
import type { SubscriptionCoreTurn } from "./turn-context";
import { subscriptionTurnLeaseHolderId } from "./subscription-lease";
import { recoverCoreHealthAndWake } from "../subscription-core-codex-waits";
import { XAI_CORE_WAIT_BINDING } from "../subscription-core-xai-waits";

const XAI = SUBSCRIPTION_CORE_XAI as SubscriptionCoreProvider;
const DISPLAY_NAME = "SuperGrok";

const hasCoreCode = (error: unknown, code: string): boolean =>
  error instanceof SubscriptionCoreError && error.code === code;

/** SuperGrok's chat placement on the shared core. */
export const XAI_CORE_TURN_PROVIDER: CoreTurnPlacementProvider = {
  id: "xai",
  displayName: DISPLAY_NAME,
  startupPhaseProvider: "supergrok-subscription",
  leaseTtlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
  lease: (deps) => deps.leases.xai,
  place: (db, request) => subscriptionCoreTurns(XAI).placeSubscriptionCoreTurn(db, request),
  // A recovery wakes the account's other SuperGrok waiters too.
  recoverHealth: async ({ db, signalCodexCapacityWorkflow }, identity) => {
    await recoverCoreHealthAndWake(
      { db, signalCodexCapacityWorkflow },
      XAI_CORE_WAIT_BINDING,
      identity,
    );
  },
  adopt: ({ providerTurn }, core, placement) => {
    providerTurn.xaiSubscriptionCore = core;
    providerTurn.effectiveXaiCredentialId = placement.connectionId;
  },
  // A wait parks the same turn on the durable core waiter (EP-T09).
  park: (deps, wait) => parkCoreSubscriptionTurn(deps, wait, XAI_CORE_WAIT_BINDING, DISPLAY_NAME),
  isSourceDisconnected: (db, identity, connectionId) =>
    subscriptionCoreRequests(XAI).isSubscriptionCoreSourceDisconnected(db, identity, connectionId),
  sourceDisconnectedError: () => XAI.errors.sourceDisconnected(),
  isAttemptFenced: (error) => error instanceof CodexCredentialLeaseAttemptFencedError,
};

/**
 * The SuperGrok capacity phase by the organization's SuperGrok route: `core`
 * places on the shared core; `maintenance` and a missing receipt (`legacy`,
 * which this binary's readiness check already refuses) fail closed.
 */
export async function selectXaiTurnCapacityByRoute(
  deps: CapacityPhaseDeps,
): Promise<CapacityPhaseOutcome> {
  if (!deps.billingState.isXaiTurn) return { ok: true };
  const { input } = deps;
  const route = await withRlsContext(
    deps.db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    (scoped) =>
      readSubscriptionCoreProviderRoute(scoped, { accountId: input.accountId, provider: "xai" }),
  );
  if (route !== "core") throw subscriptionCoreCutoverDisabledFailure(DISPLAY_NAME);
  const turnId = deps.attempt.turnId;
  if (!turnId) throw new Error("Turn id was not initialized");
  deps.leases.xai.holderId ??= subscriptionTurnLeaseHolderId("xai", DISPLAY_NAME, input, turnId);
  return await selectCoreSubscriptionTurnCapacity(deps, XAI_CORE_TURN_PROVIDER);
}

/** One attempt's SuperGrok request custody on the core (unknown outcomes are never replayed). */
export function createCoreXaiRequests(
  db: Database,
  core: SubscriptionCoreTurn,
  ref: { connectionId: string; holderId: string; generation: number },
  execution: { attemptId: string; executionGeneration: number },
) {
  const requests = subscriptionCoreRequests(XAI);
  return createCoreSubscriptionRequests({
    reserve: (request) =>
      requests.reserveSubscriptionCoreRequest(db, core.identity, ref, { ...request, ...execution }),
    settle: (request) =>
      requests.settleSubscriptionCoreRequest(db, core.identity, ref, { ...request, ...execution }),
    displayName: DISPLAY_NAME,
    outcomeUnknown: () => XAI.errors.requestOutcomeUnknown(),
    isOutcomeUnknown: (error) => hasCoreCode(error, "subscription_core_request_outcome_unknown"),
  });
}

export type XaiCoreRequestAuthorization = {
  getToken: XaiSubscriptionRequestContext["getToken"];
  refresh: XaiSubscriptionRequestContext["refresh"];
  /** The dispatch fence every physical request passes before its reservation. */
  assertDispatch: () => Promise<void>;
  beforeProviderDispatch: NonNullable<XaiSubscriptionRequestContext["beforeProviderDispatch"]>;
  onProviderRequestSettled: NonNullable<XaiSubscriptionRequestContext["onProviderRequestSettled"]>;
};

/**
 * Materialization, refresh and custody for a core-placed SuperGrok turn: the
 * bearer comes from the shared core resolver under the exact accepted turn
 * and this attempt's live core lease; each physical request (each transport
 * attempt and each continuation) is fenced and reserved before network I/O.
 * Session-title requests use `core.titleRequests` with the same fence.
 */
export function buildXaiCoreRequestAuthorization(input: {
  db: Database;
  settings: Settings;
  core: SubscriptionCoreTurn;
  lease: XaiTurnLease;
  execution: { attemptId: string; executionGeneration: number };
}): XaiCoreRequestAuthorization {
  const { db, core, lease } = input;
  const ref = coreLeaseRef(lease, core, DISPLAY_NAME);
  core.requests = createCoreXaiRequests(db, core, ref, input.execution);
  core.titleRequests = createCoreXaiRequests(db, core, ref, input.execution);
  const resolver = guardCoreTokenResolver(
    db,
    XAI_CORE_TURN_PROVIDER,
    core,
    lease,
    buildSubscriptionCoreXaiTokenResolver(db, input.settings, core.identity, ref),
    (error) => hasCoreCode(error, "subscription_core_lease_lost"),
  );
  const assertDispatch = async () => {
    await assertCoreSourceConnected(db, XAI_CORE_TURN_PROVIDER, core);
    await lease.assertCurrentForDispatch();
  };
  const requests = core.requests;
  // The refusal settlement fences its quota write on the generation the
  // refused bearer carried.
  const carried = (snapshot: {
    accessToken: string;
    userId: string;
    credentialVersion: number;
  }) => {
    core.credentialVersion = snapshot.credentialVersion;
    return { accessToken: snapshot.accessToken, userId: snapshot.userId };
  };
  return {
    getToken: async () => carried(await resolver.getToken()),
    refresh: async () => carried(await resolver.refresh()),
    assertDispatch,
    beforeProviderDispatch: async (request) => {
      await assertDispatch();
      await requests.reserve(request);
    },
    onProviderRequestSettled: requests.observe,
  };
}

/**
 * The terminal unknown-outcome failure of a core SuperGrok turn, or null: an
 * earlier or own request whose outcome is unknown is never replayed
 * automatically.
 */
export function xaiCoreRequestOutcomeUnknown(
  error: unknown,
  core: Pick<SubscriptionCoreTurn, "requests" | "titleRequests">,
): (Error & { code: string }) | null {
  let current: unknown = error;
  let unknown = false;
  for (let depth = 0; depth < 8 && current instanceof Error && !unknown; depth++) {
    unknown = hasCoreCode(current, "subscription_core_request_outcome_unknown");
    current = current.cause;
  }
  if (!unknown && !core.requests?.hasUnknownOutcome() && !core.titleRequests?.hasUnknownOutcome())
    return null;
  return XAI.errors.requestOutcomeUnknown() as Error & { code: string };
}

/** After the history commit, settle completed responses; true when no request is unresolved. */
export async function xaiCoreLanesRecoverAfterCheckpoint(
  core: Pick<SubscriptionCoreTurn, "requests" | "titleRequests">,
  commitHistory: () => Promise<void>,
): Promise<boolean> {
  try {
    await commitHistory();
    await core.requests?.checkpoint();
    return (
      (!core.requests || core.requests.canRecover()) &&
      (!core.titleRequests || core.titleRequests.canRecover())
    );
  } catch {
    return false;
  }
}

/** SuperGrok's in-turn failover and refusal settlement on the core (X1b). */
export const XAI_CORE_REFUSAL: CoreRefusalBinding = {
  provider: XAI,
  displayName: DISPLAY_NAME,
  classify: classifyXaiProviderError,
  lease: (deps) => deps.leases.xai,
  isSourceDisconnected: XAI_CORE_TURN_PROVIDER.isSourceDisconnected,
  failover: {
    displayName: DISPLAY_NAME,
    lease: (deps) => deps.leases.xai,
    countRefusals: (db, identity) =>
      subscriptionCoreTurns(XAI).countSubscriptionCoreTurnRefusals(db, identity),
    refusalLimit: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
    recoveryReason: "xai_credential_failover",
    recoveryProvider: "supergrok-subscription",
    metrics: subscriptionCoreFailoverMetrics("xai"),
  },
};
