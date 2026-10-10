/**
 * The provider a shared subscription-core routine runs for, passed as data.
 *
 * Shared core modules (this directory and the neutral `subscription-core-*`
 * modules) never name a provider or branch on one: every per-provider fact
 * comes from the registered adapter (`@opengeni/subscriptions`
 * `SubscriptionCoreAdapter`) plus the few database facts below. Adapters and
 * the registry (`subscription-core-providers.ts`) are the only modules that
 * name providers; a guard test enforces this.
 */
import type { SQL } from "drizzle-orm";
import type { SubscriptionCoreAdapter } from "@opengeni/subscriptions";
import type { Database } from "../database";
import type { SubscriptionCoreErrors } from "./errors";

export type SubscriptionCoreProvider<Credential = unknown> = {
  readonly adapter: SubscriptionCoreAdapter<Credential>;
  /**
   * A boolean SQL expression over the placement world's `session` row that is
   * true when the session's history can only continue on this provider (its
   * remote compaction state), or null when the provider has none.
   */
  readonly sessionCompactionLock: SQL | null;
  /** The errors the core raises to this provider's callers. */
  readonly errors: SubscriptionCoreErrors;
  readonly settings: {
    /**
     * The `subscription_settings` column holding this provider's primary
     * connection, as in the provider's SQL registry row, until settings are
     * keyed by provider (design 5.1.2).
     */
    readonly primaryColumn: string;
  };
  /**
   * Runs inside an organization-route allocator change of a shared
   * connection, after the organization pool's copy changed (for example the
   * provider's organization reach for workspaces created later), or null.
   */
  readonly organizationAllocatorChanged:
    | ((tx: Database, accountId: string, connectionId: string) => Promise<void>)
    | null;
};

/** The provider id the database stores for this provider's rows. */
export function subscriptionCoreProviderId(provider: SubscriptionCoreProvider): string {
  return provider.adapter.provider;
}

/**
 * One runtime instance per provider binding: `factory(provider)` runs once
 * per binding object and its functions close over that provider. Instances
 * resolve each other lazily (at call time), so modules may depend on each
 * other without recursion at construction.
 */
export function memoByProvider<Runtime>(
  factory: (provider: SubscriptionCoreProvider) => Runtime,
): (provider: SubscriptionCoreProvider) => Runtime {
  const instances = new WeakMap<SubscriptionCoreProvider, Runtime>();
  return (provider) => {
    const existing = instances.get(provider);
    if (existing) return existing;
    const created = factory(provider);
    instances.set(provider, created);
    return created;
  };
}
