/** Only the finite rail reads that may straddle an accepted logout-all.
 * Search/cursor reads and any extra query remain visible in the error ledger. */
export function exactLogoutAllSessionListSearch(search: string): boolean {
  if (search === "") return true; // Pre-page API during a rolling upgrade.
  const params = new URLSearchParams(search);
  const allKeys = [...params.keys()];
  if (new Set(allKeys).size !== allKeys.length) return false;
  const exactly = (name: string, value: string): boolean =>
    params.getAll(name).length === 1 && params.get(name) === value;
  // The rail reads compact summary records (#3184); the projection is the
  // only extra key any of these reads may carry, and only with that value.
  if (params.has("projection") && !exactly("projection", "summary")) return false;
  const keys = allKeys.filter((key) => key !== "projection");
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
    // The Default project adds only its explicit null channel to the same read.
    (keys.length === 5 || (keys.length === 6 && exactly("channelId", "null"))) &&
    exactly("limit", "50") &&
    exactly("parentSessionId", "null") &&
    exactly("sortBy", "updatedAt") &&
    exactly("archiveStatus", "active");
  return activeRoots || archivedRoots || pins || currentActiveRoots;
}
