/** Shareable search intent; never an authorization or a stored conversation cache. */
export type SessionSearchRoute = {
  find?: string;
  matchSequence?: number;
  matchOffset?: number;
  searchOrigin?: "session-search";
  /** Open on this event's moment (an inbox item or a notification), not the latest message. */
  at?: number;
};

export function parseSessionSearchRoute(search: Record<string, unknown>): SessionSearchRoute {
  const at = searchInteger(search.at);
  const moment: SessionSearchRoute = at !== null && at > 0 ? { at } : {};
  if (typeof search.find !== "string" || !search.find.trim() || search.find.length > 200) {
    return moment;
  }
  const result: SessionSearchRoute = { ...moment, find: search.find };
  if (search.searchOrigin === "session-search") result.searchOrigin = "session-search";
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

export function requestSessionSearch(workspaceId: string, returnFocus?: HTMLElement): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SESSION_SEARCH_EVENT, {
      detail: { workspaceId, ...(returnFocus ? { returnFocus } : {}) },
    }),
  );
}
