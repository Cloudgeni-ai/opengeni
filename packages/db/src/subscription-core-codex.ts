/**
 * Codex chat turns on the shared subscription core.
 *
 * The runtime is provider-neutral (`./subscription-core/turns`); this module
 * binds it to Codex (`SUBSCRIPTION_CORE_CODEX`) under the exported names the
 * worker, API and tests use, and maps the neutral credential to Codex's
 * token snapshot: `provider_account_id` is the ChatGPT account id sent as
 * `ChatGPT-Account-ID`, `provider_state.isFedramp` is the FedRAMP routing
 * flag (absent means false). The bearer's `credentialVersion` is the
 * connection's `refresh_generation`.
 */
import type { Settings } from "@opengeni/config";
import { CodexReloginRequired, refreshCodexToken } from "@opengeni/codex";
import type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
import type { Database } from "./database";
import {
  buildSubscriptionCoreCredentialResolver,
  subscriptionCoreRefreshPolicy,
} from "./subscription-core/credential-resolver";
import {
  subscriptionCoreTurns,
  type SubscriptionCoreCredential,
  type SubscriptionCoreCredentialLoad,
  type SubscriptionCoreLeaseRef,
  type SubscriptionCorePlacement,
  type SubscriptionCorePlacementEvaluation,
  type SubscriptionCorePlacementRequest,
  type SubscriptionCoreRefreshDeps,
  type SubscriptionCoreTurnIdentity,
} from "./subscription-core/turns";
import {
  SUBSCRIPTION_CORE_CODEX,
  subscriptionCoreCodexProvider,
  type SubscriptionCoreCodexTokens,
} from "./subscription-core-codex-adapter";
import {
  SubscriptionCoreCodexAccessLostError,
  SubscriptionCoreCodexLeaseLostError,
} from "./subscription-core-codex-errors";

export {
  SubscriptionCoreCodexAccessLostError,
  SubscriptionCoreCodexLeaseLostError,
} from "./subscription-core-codex-errors";

export type { CodexCredentialTokenSnapshot } from "./codex-token-resolver";
export {
  readSubscriptionCoreTurnIdentity,
  subscriptionCoreTurnActor,
  type SubscriptionCoreTurnIdentity,
} from "./subscription-core/turns";
export {
  SUBSCRIPTION_CORE_CODEX_ENTITLEMENT_COOLDOWN_MS,
  SUBSCRIPTION_CORE_CODEX_EXHAUSTED_FALLBACK_MS,
  SUBSCRIPTION_CORE_CODEX_FORBIDDEN_QUARANTINE_MS,
  SUBSCRIPTION_CORE_CODEX_RATE_LIMIT_FALLBACK_MS,
} from "./subscription-core-codex-adapter";

const core = subscriptionCoreTurns(SUBSCRIPTION_CORE_CODEX);

export type SubscriptionCoreCodexLeaseRef = SubscriptionCoreLeaseRef;
export type SubscriptionCoreCodexPlacementRequest = SubscriptionCorePlacementRequest;
export type SubscriptionCoreCodexPlacement = SubscriptionCorePlacement;
export type SubscriptionCoreCodexPlacementEvaluation = SubscriptionCorePlacementEvaluation;

export { readSubscriptionCoreTurnModel as readSubscriptionCoreCodexTurnModel } from "./subscription-core/turns";
export { subscriptionCoreReselectionPoints as subscriptionCoreCodexReselectionPoints } from "./subscription-core/turns";

export const placeSubscriptionCoreCodexTurn = core.placeSubscriptionCoreTurn;
export const canSpendSubscriptionCoreCodexExtraCredits = core.canSpendSubscriptionCoreExtraCredits;
export const subscriptionCoreAcceptedCodexTurnIsFunded = core.subscriptionCoreAcceptedTurnIsFunded;
export const evaluateSubscriptionCoreCodexPlacement = core.evaluateSubscriptionCorePlacement;
export const recoverSubscriptionCoreCodexConnectionHealth =
  core.recoverSubscriptionCoreConnectionHealth;
export const quarantineSubscriptionCoreCodexConnection = core.quarantineSubscriptionCoreConnection;
export const recordSubscriptionCoreCodexModelCooldown = core.recordSubscriptionCoreModelCooldown;
export const authorizeSubscriptionCoreFrozenPersonalCodex =
  core.authorizeSubscriptionCoreFrozenPersonal;
export const recordSubscriptionCoreCodexQuotaObservation =
  core.recordSubscriptionCoreQuotaObservation;
export const applySubscriptionCoreCodexQuotaObservation =
  core.applySubscriptionCoreQuotaObservation;
export const recordSubscriptionCoreCodexTurnFailure = core.recordSubscriptionCoreTurnFailure;
export const countSubscriptionCoreCodexTurnRefusals = core.countSubscriptionCoreTurnRefusals;
export const touchSubscriptionCoreCodexBinding = core.touchSubscriptionCoreBinding;

/** A leased Codex credential: the neutral credential in Codex's token terms. */
export type SubscriptionCoreCodexCredential = {
  connectionId: string;
  ownership: "shared" | "personal";
  refreshGeneration: number;
  tokens: SubscriptionCoreCodexTokens;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreCodexCredentialLoad =
  | { kind: "loaded"; credential: SubscriptionCoreCodexCredential }
  | Exclude<SubscriptionCoreCredentialLoad, { kind: "loaded" }>;

function codexCredential(
  credential: SubscriptionCoreCredential<unknown>,
): SubscriptionCoreCodexCredential {
  return {
    connectionId: credential.connectionId,
    ownership: credential.ownership,
    refreshGeneration: credential.refreshGeneration,
    tokens: credential.credential as SubscriptionCoreCodexTokens,
    chatgptAccountId: credential.providerAccountId,
    isFedramp: credential.providerState.isFedramp === true,
    planType: credential.planType,
    expiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
  };
}

/**
 * Materialize the leased connection's credential for this exact turn. Reads
 * require the accepted turn, the live lease, and for a personal connection
 * the turn's frozen v2 entry. Ownerless turns never read a personal or
 * people-scoped connection.
 */
export async function loadSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
): Promise<SubscriptionCoreCodexCredentialLoad> {
  const loaded = await core.loadSubscriptionCoreCredential(db, settings, identity, lease);
  return loaded.kind === "loaded"
    ? { kind: "loaded", credential: codexCredential(loaded.credential) }
    : loaded;
}

export type SubscriptionCoreCodexRefreshOutcome =
  | {
      kind: "refreshed";
      accessToken: string;
      refreshGeneration: number;
      planType: string | null;
    }
  /** Another refresh or credential writer already advanced the generation. */
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "lease_lost" }
  | { kind: "not_visible" }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCodexRefreshDeps = SubscriptionCoreRefreshDeps & {
  /** The OAuth token refresh call (tests inject a scripted upstream). */
  refresh?: typeof refreshCodexToken;
};

/**
 * Rotate the leased connection's refresh token through the core's single
 * per-connection lock. Authorization happens in begin, before the provider
 * call; the rotated token is persisted immediately after it returns. A
 * permanent OAuth refusal marks the connection needs-relogin through the
 * same one-shot authorization. Failures are returned, never thrown inside
 * the lock, so that status write commits.
 */
export async function refreshSubscriptionCoreCodexCredential(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  observedRefreshGeneration: number,
  deps: SubscriptionCoreCodexRefreshDeps = {},
): Promise<SubscriptionCoreCodexRefreshOutcome> {
  const turns = deps.refresh
    ? subscriptionCoreTurns(subscriptionCoreCodexProvider({ refresh: deps.refresh }))
    : core;
  const outcome = await turns.refreshSubscriptionCoreCredential(
    db,
    settings,
    identity,
    lease,
    observedRefreshGeneration,
    deps,
  );
  if (outcome.kind !== "refreshed") return outcome;
  return {
    kind: "refreshed",
    accessToken: (outcome.credential as SubscriptionCoreCodexTokens).accessToken,
    refreshGeneration: outcome.refreshGeneration,
    planType: outcome.planType,
  };
}

/** Test seams; production uses the database-backed defaults. */
export type SubscriptionCoreCodexResolverDeps = SubscriptionCoreCodexRefreshDeps & {
  load?: typeof loadSubscriptionCoreCodexCredential;
  refreshCredential?: typeof refreshSubscriptionCoreCodexCredential;
};

/**
 * The core counterpart of `buildCodexTokenResolver`: same snapshot shape,
 * proactive staleness refresh and local single-flight (the shared core
 * resolver), but every read and refresh is scoped to the exact accepted turn
 * and its live lease.
 */
export function buildSubscriptionCoreCodexTokenResolver(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreCodexLeaseRef,
  deps: SubscriptionCoreCodexResolverDeps = {},
): {
  getToken: () => Promise<CodexCredentialTokenSnapshot>;
  refresh: () => Promise<CodexCredentialTokenSnapshot>;
} {
  const loadCredential = deps.load ?? loadSubscriptionCoreCodexCredential;
  const refreshCredential = deps.refreshCredential ?? refreshSubscriptionCoreCodexCredential;
  const snapshot = (credential: SubscriptionCoreCodexCredential): CodexCredentialTokenSnapshot => ({
    accessToken: credential.tokens.accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    isFedramp: credential.isFedramp,
    credentialVersion: credential.refreshGeneration,
    planType: credential.planType,
  });
  return buildSubscriptionCoreCredentialResolver<
    SubscriptionCoreCodexCredential,
    Extract<SubscriptionCoreCodexRefreshOutcome, { kind: "refreshed" }>,
    CodexCredentialTokenSnapshot
  >({
    flightNamespace: "turn",
    connectionId: lease.connectionId,
    holderKey: `${identity.turnId}:${lease.holderId}:${lease.generation}`,
    policy: (credential) =>
      subscriptionCoreRefreshPolicy(SUBSCRIPTION_CORE_CODEX.adapter, credential.tokens),
    load: () => loadCredential(db, settings, identity, lease),
    embeddedExpiry: (credential) =>
      SUBSCRIPTION_CORE_CODEX.adapter.credential.expiry(credential.tokens),
    refresh: (credential) =>
      refreshCredential(db, settings, identity, lease, credential.refreshGeneration, deps),
    snapshot,
    refreshedSnapshot: (outcome, credential) => ({
      accessToken: outcome.accessToken,
      chatgptAccountId: credential.chatgptAccountId,
      isFedramp: credential.isFedramp,
      credentialVersion: outcome.refreshGeneration,
      planType: outcome.planType ?? credential.planType,
    }),
    onPlanChanged: deps.onPlanChanged ? () => deps.onPlanChanged?.(lease.connectionId) : undefined,
    errors: {
      relogin: (message) =>
        new CodexReloginRequired(
          message ?? "The Codex subscription for this turn needs a new sign-in.",
        ),
      leaseLost: () => new SubscriptionCoreCodexLeaseLostError(),
      accessLost: () => new SubscriptionCoreCodexAccessLostError(),
    },
  });
}
