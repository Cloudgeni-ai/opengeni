import type { McpConnectionAccountBinding } from "@opengeni/contracts";

/** Canonical readiness comes only from routes present in this exact attempt,
 * joined to this turn's accepted bindings. It never grants account access. */
export function capabilityAccountReadiness(
  availableRoutes: Iterable<string>,
  bindings: readonly McpConnectionAccountBinding[] | null,
) {
  const available = new Set(availableRoutes);
  const actualRoutes = new Set(available);
  const accepted = new Set<string>();
  for (const binding of bindings ?? []) {
    accepted.add(binding.canonicalServerId);
    if (actualRoutes.has(binding.serverId)) available.add(binding.canonicalServerId);
  }
  return { available, accepted };
}
