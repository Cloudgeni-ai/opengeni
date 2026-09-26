/** Only the finite rail reads that may straddle an accepted logout-all.
 * Search/cursor reads and any extra query remain visible in the error ledger. */
export function exactLogoutAllSessionListSearch(search: string): boolean {
  if (search === "") return true; // Pre-page API during a rolling upgrade.
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return false;
  const exactly = (name: string, value: string): boolean =>
    params.getAll(name).length === 1 && params.get(name) === value;
  if (!exactly("view", "page")) return false;
  const activeRoots =
    keys.length === 3 && exactly("limit", "50") && exactly("parentSessionId", "null");
  const archivedRoots =
    keys.length === 4 &&
    exactly("limit", "50") &&
    exactly("parentSessionId", "null") &&
    exactly("archivedOnly", "true");
  const pins = keys.length === 3 && exactly("limit", "1") && exactly("pinsOnly", "true");
  const currentActiveRoots =
    keys.length === 5 &&
    exactly("limit", "50") &&
    exactly("parentSessionId", "null") &&
    exactly("sortBy", "updatedAt") &&
    exactly("archiveStatus", "active");
  return activeRoots || archivedRoots || pins || currentActiveRoots;
}
