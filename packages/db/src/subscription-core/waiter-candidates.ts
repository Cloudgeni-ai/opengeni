import type { ProviderId } from "@opengeni/subscriptions";

/** Wake hints are bounded data, never a grant or a replacement for placement. */
export const MAX_CAPACITY_WAIT_CANDIDATES = 32;

/** Null denotes a legacy home-only evaluation. An empty array still denotes
 * a failover-aware evaluation and therefore requires bounded reconciliation:
 * settings or a cutover can introduce a candidate after this snapshot.
 */
export function capacityWaitCandidateProviders(
  providers: readonly ProviderId[] | null | undefined,
): ProviderId[] | null {
  if (providers == null) return null;
  if (
    providers.length > MAX_CAPACITY_WAIT_CANDIDATES ||
    providers.some((provider) => !/^[a-z][a-z0-9_]{0,63}$/.test(provider))
  )
    throw new Error("Capacity wait candidates must be bounded provider identifiers");
  return [...new Set(providers)].sort();
}
