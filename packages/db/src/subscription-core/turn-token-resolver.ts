/**
 * The bearer resolver of one chat turn on the shared subscription core, for
 * any provider: the shared resolver (`./credential-resolver`: proactive
 * staleness refresh by the adapter's policy, local single-flight) over the
 * provider's turn runtime, so every read and refresh is scoped to the exact
 * accepted turn and its live lease. The caller maps the leased credential
 * to its transport's token snapshot and names its relogin error.
 *
 * The first provider keeps its own M3 binding, which predates this helper
 * and carries test seams of its own.
 */
import type { Settings } from "@opengeni/config";
import type { Database } from "../database";
import {
  buildSubscriptionCoreCredentialResolver,
  subscriptionCoreRefreshPolicy,
} from "./credential-resolver";
import type { SubscriptionCoreProvider } from "./provider";
import {
  subscriptionCoreTurns,
  type SubscriptionCoreCredential,
  type SubscriptionCoreLeaseRef,
  type SubscriptionCoreRefreshDeps,
  type SubscriptionCoreTurnIdentity,
} from "./turns";

export type SubscriptionCoreTurnTokenMapping<Snapshot> = {
  /** The transport's token snapshot for a leased (or just rotated) credential. */
  snapshot(credential: SubscriptionCoreCredential): Snapshot;
  /** The provider's revoked-sign-in error (null: the stored status says so). */
  relogin(message: string | null): Error;
};

export function buildSubscriptionCoreTurnTokenResolver<Snapshot>(
  db: Database,
  settings: Settings,
  provider: SubscriptionCoreProvider,
  identity: SubscriptionCoreTurnIdentity,
  lease: SubscriptionCoreLeaseRef,
  mapping: SubscriptionCoreTurnTokenMapping<Snapshot>,
  deps: SubscriptionCoreRefreshDeps = {},
): { getToken: () => Promise<Snapshot>; refresh: () => Promise<Snapshot> } {
  const turns = subscriptionCoreTurns(provider);
  const { adapter } = provider;
  return buildSubscriptionCoreCredentialResolver({
    flightNamespace: "turn",
    connectionId: lease.connectionId,
    holderKey: `${identity.turnId}:${lease.holderId}:${lease.generation}`,
    policy: (loaded: SubscriptionCoreCredential) =>
      subscriptionCoreRefreshPolicy(adapter, loaded.credential),
    load: () => turns.loadSubscriptionCoreCredential(db, settings, identity, lease),
    embeddedExpiry: (loaded) => adapter.credential.expiry(loaded.credential),
    refresh: (loaded) =>
      turns.refreshSubscriptionCoreCredential(
        db,
        settings,
        identity,
        lease,
        loaded.refreshGeneration,
        deps,
      ),
    snapshot: mapping.snapshot,
    refreshedSnapshot: (outcome, loaded) =>
      mapping.snapshot({
        ...loaded,
        credential: outcome.credential,
        refreshGeneration: outcome.refreshGeneration,
        planType: outcome.planType ?? loaded.planType,
      }),
    onPlanChanged: deps.onPlanChanged ? () => deps.onPlanChanged?.(lease.connectionId) : undefined,
    errors: {
      relogin: mapping.relogin,
      leaseLost: () => provider.errors.leaseLost(),
      accessLost: () => provider.errors.accessLost(),
    },
  });
}
