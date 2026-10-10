/**
 * The bearer resolver every provider's chat turn uses on the shared core:
 * load the leased connection's credential under the exact accepted turn,
 * refresh it proactively when stale, and share one in-flight refresh per
 * connection and refresh generation within the process (the database's
 * per-connection advisory lock serializes other replicas).
 *
 * The caller supplies the provider's view of a loaded credential, how a
 * snapshot is built from it, and the errors it raises; this module decides
 * when to refresh and which outcomes may be shared between turns.
 */

/** What every loaded credential view exposes to the resolver. */
export type SubscriptionCoreLoadedCredentialBase = {
  refreshGeneration: number;
  planType: string | null;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
};

export type SubscriptionCoreRefreshedBase = {
  kind: "refreshed";
  refreshGeneration: number;
  /** The plan the rotated credential reported; absent when the caller does not track it. */
  planType?: string | null;
};

/** A refresh outcome whose `refreshed` member carries a provider-specific payload. */
export type SubscriptionCoreRefreshOutcomeOf<Refreshed extends SubscriptionCoreRefreshedBase> =
  | Refreshed
  /** Another refresh or credential writer already advanced the generation. */
  | { kind: "superseded" }
  | { kind: "relogin"; message: string; marked: boolean }
  | { kind: "lease_lost" }
  | { kind: "not_visible" }
  | { kind: "refused" }
  | { kind: "error"; error: unknown };

export type SubscriptionCoreCredentialLoadOf<Loaded> =
  | { kind: "loaded"; credential: Loaded }
  | { kind: "lease_lost" }
  | { kind: "not_visible" }
  | { kind: "needs_relogin" }
  | { kind: "unavailable" };

export type SubscriptionCoreResolverInput<
  Loaded extends SubscriptionCoreLoadedCredentialBase,
  Refreshed extends SubscriptionCoreRefreshedBase,
  Snapshot,
> = {
  /**
   * Separates flights of different callers (chat turns, connection-level
   * operations): only flights in the same namespace share an outcome.
   */
  flightNamespace: string;
  connectionId: string;
  /** The exact turn lease (turn, holder, generation) this resolver serves. */
  holderKey: string;
  /** Refresh this long before expiry, or after `fallbackMs` when expiry is unknown. */
  policy: { windowMs: number; fallbackMs: number };
  load(): Promise<SubscriptionCoreCredentialLoadOf<Loaded>>;
  /** The expiry embedded in the credential, used when the store records none. */
  embeddedExpiry(loaded: Loaded): Date | null;
  refresh(loaded: Loaded): Promise<SubscriptionCoreRefreshOutcomeOf<Refreshed>>;
  snapshot(loaded: Loaded): Snapshot;
  refreshedSnapshot(outcome: Refreshed, loaded: Loaded): Snapshot;
  /** A persisted refresh reported a plan different from the recorded one. */
  onPlanChanged?: (() => void) | undefined;
  errors: {
    /** The sign-in was revoked; only a new sign-in recovers. */
    relogin(message: string | null): Error;
    /** The turn no longer holds its lease; dispatch must stop. */
    leaseLost(): Error;
    /** The connection, or the turn's authority over it, is no longer usable. */
    accessLost(): Error;
  };
};

type RefreshFlight = {
  /** The exact turn lease that started this provider refresh. */
  holderKey: string;
  promise: Promise<SubscriptionCoreRefreshOutcomeOf<SubscriptionCoreRefreshedBase>>;
};

const inflight = new Map<string, RefreshFlight>();

/**
 * Outcomes about the connection itself, which every turn waiting on the same
 * connection and generation may share. A lost lease, a refused authorization
 * or an invisible connection belongs to the turn that hit it only.
 */
function connectionLevelRefreshOutcome(outcome: { kind: string }): boolean {
  return (
    outcome.kind === "refreshed" ||
    outcome.kind === "superseded" ||
    outcome.kind === "relogin" ||
    outcome.kind === "error"
  );
}

export function buildSubscriptionCoreCredentialResolver<
  Loaded extends SubscriptionCoreLoadedCredentialBase,
  Refreshed extends SubscriptionCoreRefreshedBase,
  Snapshot,
>(
  input: SubscriptionCoreResolverInput<Loaded, Refreshed, Snapshot>,
): { getToken: () => Promise<Snapshot>; refresh: () => Promise<Snapshot> } {
  const { errors, holderKey } = input;
  const load = async (): Promise<Loaded> => {
    const loaded = await input.load();
    switch (loaded.kind) {
      case "loaded":
        return loaded.credential;
      case "lease_lost":
        throw errors.leaseLost();
      case "needs_relogin":
        throw errors.relogin(null);
      default:
        throw errors.accessLost();
    }
  };
  const runOwnRefresh = (loaded: Loaded) => input.refresh(loaded);
  const sharedRefresh = async (
    loaded: Loaded,
  ): Promise<SubscriptionCoreRefreshOutcomeOf<Refreshed>> => {
    const key = `${input.flightNamespace}:${input.connectionId}:${loaded.refreshGeneration}`;
    const existing = inflight.get(key);
    if (existing) {
      const outcome = (await existing.promise) as SubscriptionCoreRefreshOutcomeOf<Refreshed>;
      // Another turn's lease or authorization outcome is not this turn's:
      // refresh under this turn's own lease instead.
      return existing.holderKey === holderKey || connectionLevelRefreshOutcome(outcome)
        ? outcome
        : await runOwnRefresh(loaded);
    }
    const flight: RefreshFlight = {
      holderKey,
      promise: Promise.resolve() as unknown as RefreshFlight["promise"],
    };
    flight.promise = runOwnRefresh(loaded).finally(() => {
      if (inflight.get(key) === flight) inflight.delete(key);
    });
    inflight.set(key, flight);
    return (await flight.promise) as SubscriptionCoreRefreshOutcomeOf<Refreshed>;
  };
  const doRefresh = async (loaded: Loaded): Promise<Snapshot> => {
    const outcome = await sharedRefresh(loaded);
    switch (outcome.kind) {
      case "refreshed":
        if (
          outcome.planType !== undefined &&
          outcome.planType !== null &&
          loaded.planType !== null &&
          outcome.planType !== loaded.planType
        ) {
          try {
            input.onPlanChanged?.();
          } catch {
            // A wake hint must never fail the request it rode on.
          }
        }
        return input.refreshedSnapshot(outcome as Refreshed, loaded);
      case "superseded":
        return input.snapshot(await load());
      case "relogin":
        throw errors.relogin(outcome.message);
      case "lease_lost":
        throw errors.leaseLost();
      case "error":
        throw outcome.error;
      default:
        throw errors.accessLost();
    }
  };
  const resolve = async (force: boolean): Promise<Snapshot> => {
    const loaded = await load();
    const expiry = loaded.expiresAt ?? input.embeddedExpiry(loaded);
    const stale =
      force ||
      (expiry
        ? expiry.getTime() <= Date.now() + input.policy.windowMs
        : loaded.lastRefreshAt
          ? loaded.lastRefreshAt.getTime() < Date.now() - input.policy.fallbackMs
          : true);
    return stale ? await doRefresh(loaded) : input.snapshot(loaded);
  };
  return { getToken: () => resolve(false), refresh: () => resolve(true) };
}
