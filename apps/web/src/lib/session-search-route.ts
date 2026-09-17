/** Shareable search intent; never an authorization or a stored conversation cache. */
export type SessionSearchRoute = {
  find?: string;
  matchSequence?: number;
  matchOffset?: number;
};

export function parseSessionSearchRoute(search: Record<string, unknown>): SessionSearchRoute {
  if (typeof search.find !== "string" || !search.find.trim() || search.find.length > 200) {
    return {};
  }
  const result: SessionSearchRoute = { find: search.find };
  const sequence = searchInteger(search.matchSequence);
  const offset = searchInteger(search.matchOffset);
  if (sequence !== null && sequence > 0) {
    result.matchSequence = sequence;
    if (offset !== null && offset >= 0) result.matchOffset = offset;
  }
  return result;
}

function searchInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Scoped event: the mounted rail owns dialog state across conversation navigation. */
export const OPEN_SESSION_SEARCH_EVENT = "opengeni:open-session-search";

export function requestSessionSearch(workspaceId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_SEARCH_EVENT, { detail: { workspaceId } }));
}
