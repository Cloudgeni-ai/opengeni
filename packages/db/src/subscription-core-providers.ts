/**
 * The providers that run on the shared subscription core: the only module,
 * with the adapters themselves, that enumerates providers. Shared core
 * modules receive a binding from here as data.
 *
 * Adding a provider takes three things: its adapter and database binding
 * (`subscription-core-<provider>-adapter.ts`), its entry below, and its row
 * in `opengeni_private.subscription_core_providers` (a migration, which also
 * widens the provider CHECK lists). `check:subscription-core-neutral` keeps
 * this list and the SQL registry rows equal.
 */
import type { SubscriptionCoreAdapter } from "@opengeni/subscriptions";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";

const REGISTERED: readonly SubscriptionCoreProvider[] = Object.freeze([
  SUBSCRIPTION_CORE_CODEX as SubscriptionCoreProvider,
]);

// Private: callers read through the functions below, so the registry cannot
// be changed at runtime.
const BINDINGS = new Map(REGISTERED.map((binding) => [binding.adapter.provider, binding]));

/** The registered provider ids, sorted. */
export function subscriptionCoreProviderIds(): string[] {
  return [...BINDINGS.keys()].sort();
}

/** The registered binding for a provider id; fails closed for any other id. */
export function subscriptionCoreProvider(providerId: string): SubscriptionCoreProvider {
  const binding = BINDINGS.get(providerId);
  if (!binding || binding.adapter.provider !== providerId) {
    throw new Error("No subscription-core provider is registered for this id");
  }
  return binding;
}

/** The registered adapter for a provider id; fails closed for any other id. */
export function subscriptionCoreAdapter(providerId: string): SubscriptionCoreAdapter {
  return subscriptionCoreProvider(providerId).adapter;
}
