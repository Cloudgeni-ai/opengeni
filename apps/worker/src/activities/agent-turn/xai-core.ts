/**
 * SuperGrok on the shared subscription core (design 5.3, SuperGrok track
 * X1a): the provider-neutral chat placement and request custody bound to
 * SuperGrok, and the turn's route between the legacy SuperGrok path and the
 * core. Dormant: the route is `core` only after the SuperGrok drained
 * cutover commits its receipt (X3), and the binding is unregistered until
 * then, so every core entry point fails closed.
 */
import {
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
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import {
  createCoreSubscriptionRequests,
  type CoreSubscriptionRequests,
} from "./subscription-core-requests";
import type { SubscriptionCoreTurn } from "./turn-context";
import { subscriptionTurnLeaseHolderId } from "./subscription-lease";
import { selectXaiTurnCapacity } from "./xai-capacity";
import { refreshExhaustedXaiCoreQuota } from "../xai-quota";

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
  // Waiter wakes after a recovery arrive with the SuperGrok waits (X1b). As
  // for Codex, a failed recovery is best effort and never fails placement.
  recoverHealth: async ({ db }, identity) => {
    await subscriptionCoreTurns(XAI)
      .recoverSubscriptionCoreConnectionHealth(db, identity)
      .catch(() => 0);
  },
  // Re-read billing for exhausted shared connections before placement
  // trusts a stored exhaustion, as the legacy path did (EP-N22, X2a).
  beforePlacement: async ({ db, settings }, identity) => {
    await refreshExhaustedXaiCoreQuota({
      db,
      settings,
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
    });
  },
  adopt: ({ providerTurn }, core, placement) => {
    providerTurn.xaiSubscriptionCore = core;
    providerTurn.effectiveXaiCredentialId = placement.connectionId;
    // Rotation is the core's placement policy, never the legacy rotation.
    providerTurn.xaiRotationEnabled = false;
    providerTurn.xaiAuthoritySnapshot = null;
  },
  // No `park` until X1b: a core wait is a terminal capacity failure.
  isSourceDisconnected: (db, identity, connectionId) =>
    subscriptionCoreRequests(XAI).isSubscriptionCoreSourceDisconnected(db, identity, connectionId),
  sourceDisconnectedError: () => XAI.errors.sourceDisconnected(),
  // SuperGrok records no Codex selection receipt, the only step that raises an
  // attempt-fence error here; any other failure propagates.
  isAttemptFenced: () => false,
};

/**
 * The SuperGrok capacity phase by the organization's SuperGrok route:
 * `legacy` runs the legacy selection unchanged (one added route read),
 * `maintenance` fails closed, `core` places on the shared core.
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
  if (route === "legacy") return await selectXaiTurnCapacity(deps);
  if (route === "maintenance") throw subscriptionCoreCutoverDisabledFailure(DISPLAY_NAME);
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
  return {
    getToken: async () => {
      const { accessToken, userId } = await resolver.getToken();
      return { accessToken, userId };
    },
    refresh: async () => {
      const { accessToken, userId } = await resolver.refresh();
      return { accessToken, userId };
    },
    assertDispatch,
    beforeProviderDispatch: async (request) => {
      await assertDispatch();
      await requests.reserve(request);
    },
    onProviderRequestSettled: requests.observe,
  };
}

/**
 * The session-title custody of a turn: none on the legacy route; on the core
 * the turn's dispatch fence and its title lane, and a turn placed on the core
 * without either fails closed instead of sending unreserved title requests.
 */
export function xaiCoreTitleCustody(
  core: Pick<SubscriptionCoreTurn, "titleRequests"> | null,
  authorization: Pick<XaiCoreRequestAuthorization, "assertDispatch"> | null,
): { assertDispatch: () => Promise<void>; requests: CoreSubscriptionRequests } | undefined {
  if (!core) return undefined;
  if (!authorization || !core.titleRequests)
    throw new Error("A SuperGrok turn on the shared core has no session-title request custody");
  return { assertDispatch: authorization.assertDispatch, requests: core.titleRequests };
}

/**
 * The terminal unknown-outcome failure of a core SuperGrok turn, or null: an
 * earlier or own request whose outcome is unknown is never replayed
 * automatically (the bounded own-interruption recovery Codex has arrives
 * with the SuperGrok settlement, X1b).
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
