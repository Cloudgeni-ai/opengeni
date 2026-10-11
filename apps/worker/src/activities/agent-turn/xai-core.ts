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
import {
  subscriptionCoreAccountRefusedFailure,
  subscriptionCoreCutoverDisabledFailure,
  type SubscriptionCoreCodexTurnError,
} from "./codex-core-errors";
import type { XaiTurnLease } from "./credential-leases";
import { classifyXaiProviderError } from "./errors";
import type { TurnFailureDeps } from "./failure-settlement";
import type { RunAgentTurnResult } from "../types";
import {
  assertCoreSourceConnected,
  coreLeaseRef,
  guardCoreTokenResolver,
  parkCoreSubscriptionTurn,
  selectCoreSubscriptionTurnCapacity,
  type CoreTurnPlacementProvider,
} from "./subscription-core-capacity";
import {
  failOverCoreSubscriptionTurn,
  SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
  type CoreFailoverBinding,
} from "./subscription-core-failover";
import {
  createCoreSubscriptionRequests,
  type CoreSubscriptionRequests,
} from "./subscription-core-requests";
import {
  recordCoreSubscriptionRefusal,
  touchCoreSubscriptionBinding,
} from "./subscription-core-settlement";
import type { SubscriptionCoreTurn } from "./turn-context";
import { subscriptionTurnLeaseHolderId } from "./subscription-lease";
import { selectXaiTurnCapacity } from "./xai-capacity";
import { refreshExhaustedXaiCoreQuota } from "../xai-quota";
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
  // A wait parks the same turn on the durable core waiter (EP-T09).
  park: (deps, wait) => parkCoreSubscriptionTurn(deps, wait, XAI_CORE_WAIT_BINDING, DISPLAY_NAME),
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
 * automatically.
 */
export function xaiCoreRequestOutcomeUnknown(
  error: unknown,
  core: Pick<SubscriptionCoreTurn, "requests">,
): (Error & { code: string }) | null {
  let current: unknown = error;
  let unknown = false;
  for (let depth = 0; depth < 8 && current instanceof Error && !unknown; depth++) {
    unknown = hasCoreCode(current, "subscription_core_request_outcome_unknown");
    current = current.cause;
  }
  // The tool-less session-title request never enters history and is joined
  // before settlement, so its custody does not fence replay.
  if (!unknown && !core.requests?.hasUnknownOutcome()) return null;
  return XAI.errors.requestOutcomeUnknown() as Error & { code: string };
}

/** After the history commit, settle completed responses; true when no request is unresolved. */
export async function xaiCoreLanesRecoverAfterCheckpoint(
  core: Pick<SubscriptionCoreTurn, "requests">,
  commitHistory: () => Promise<void>,
): Promise<boolean> {
  try {
    await commitHistory();
    await core.requests?.checkpoint();
    return !core.requests || core.requests.canRecover();
  } catch {
    return false;
  }
}

/** SuperGrok's in-turn failover on the core: the shared bound, its own reason and metrics. */
export const XAI_CORE_FAILOVER: CoreFailoverBinding = {
  displayName: DISPLAY_NAME,
  lease: (deps) => deps.leases.xai,
  countRefusals: (db, identity) =>
    subscriptionCoreTurns(XAI).countSubscriptionCoreTurnRefusals(db, identity),
  refusalLimit: SUBSCRIPTION_CORE_TURN_REFUSAL_LIMIT,
  recoveryReason: "xai_credential_failover",
  recoveryProvider: "supergrok-subscription",
  metrics: {
    checkpoints: {
      name: "opengeni_subscription_core_failover_checkpoints_total",
      help: "Durable subscription-core failover checkpoint attempts by provider and outcome.",
    },
    settlements: {
      name: "opengeni_subscription_core_failover_settlements_total",
      help: "Atomic subscription-core failover settlements by provider and outcome.",
    },
    labels: () => ({ provider: "xai" }),
  },
};

/**
 * Failure settlement of a core SuperGrok turn (X1b): the adapter
 * classification (`classifyXaiProviderError`) becomes a shared outcome; a
 * definitive refusal is recorded against the leased connection and the same
 * turn re-places within the per-turn bound (another account, or a durable
 * wait). A graceful source disconnect re-places without a refusal. Returns
 * the settled result, or the typed terminal failure when automatic
 * re-placement was not possible (null: not an account refusal).
 */
export async function settleCoreXaiRefusal(
  deps: TurnFailureDeps,
  core: SubscriptionCoreTurn,
): Promise<{ result: RunAgentTurnResult | null; failure: SubscriptionCoreCodexTurnError | null }> {
  const { error, db, leases, eventing, attempt } = deps;
  const outcome = classifyXaiProviderError(error);
  // Only a pre-dispatch lifecycle fence or a definite refusal can enter
  // graceful recovery; a concurrent disconnect never upgrades an ambiguous
  // failure into replay proof.
  const disconnected =
    causeHasCoreCode(error, "subscription_core_source_disconnected") ||
    (!!outcome &&
      (await XAI_CORE_TURN_PROVIDER.isSourceDisconnected(
        db,
        core.identity,
        core.connectionId,
      ).catch(() => false)));
  if (disconnected) {
    const settled = await failOverCoreSubscriptionTurn(
      deps,
      core,
      "source_disconnected",
      XAI_CORE_FAILOVER,
    );
    if (settled) return { result: settled, failure: null };
  } else if (outcome) {
    const recorded = await recordCoreSubscriptionRefusal({
      db,
      provider: XAI,
      core,
      lease: leases.xai,
      outcome,
    });
    if (recorded.receipt && eventing.publish && attempt.turnId && eventing.turnStartedPublished) {
      const settled = await failOverCoreSubscriptionTurn(
        deps,
        core,
        { kind: outcome.kind, unbounded: false },
        XAI_CORE_FAILOVER,
      );
      if (settled) return { result: settled, failure: null };
    }
  }
  const refusal =
    disconnected || causeHasCoreCode(error, "subscription_core_access_lost")
      ? "access_lost"
      : outcome?.kind === "unauthorized"
        ? "sign_in"
        : outcome?.kind === "forbidden"
          ? "forbidden"
          : null;
  return {
    result: null,
    failure: refusal ? subscriptionCoreAccountRefusedFailure(refusal, DISPLAY_NAME) : null,
  };
}

function causeHasCoreCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (hasCoreCode(current, code)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Finalization of a core SuperGrok turn before its lease is released: a
 * completed model call moves the binding's cache clock. No per-turn quota
 * call runs on the core path: quota is observed on refusal and by the
 * out-of-turn probe.
 */
export async function finalizeCoreXaiTurn(input: {
  db: Database;
  core: SubscriptionCoreTurn;
  lease: XaiTurnLease;
}): Promise<void> {
  const at = [input.core.requests, input.core.titleRequests]
    .map((lane) => lane?.lastResponseReceivedAt() ?? null)
    .reduce<Date | null>(
      (latest, next) => (next && (!latest || next > latest) ? next : latest),
      null,
    );
  await touchCoreSubscriptionBinding({
    db: input.db,
    provider: XAI,
    core: input.core,
    lease: input.lease,
    modelCallCompletedAt: at,
  });
}
