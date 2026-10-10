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
import type { SubscriptionCoreAdapterRegistry } from "@opengeni/subscriptions";
import type { SubscriptionCoreProvider } from "./subscription-core/provider";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";

const REGISTERED: readonly SubscriptionCoreProvider[] = [
  SUBSCRIPTION_CORE_CODEX as SubscriptionCoreProvider,
];

/** Registered database bindings by provider id. */
export const SUBSCRIPTION_CORE_PROVIDERS: ReadonlyMap<string, SubscriptionCoreProvider> = new Map(
  REGISTERED.map((binding) => [binding.adapter.provider, binding]),
);

/** Registered adapters by provider id. */
export const SUBSCRIPTION_CORE_ADAPTERS: SubscriptionCoreAdapterRegistry = new Map(
  REGISTERED.map((binding) => [binding.adapter.provider, binding.adapter]),
);

/** The registered binding for a provider id; fails closed for any other id. */
export function subscriptionCoreProvider(providerId: string): SubscriptionCoreProvider {
  const binding = SUBSCRIPTION_CORE_PROVIDERS.get(providerId);
  if (!binding) throw new Error("No subscription-core provider is registered for this id");
  return binding;
}
