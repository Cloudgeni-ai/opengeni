/**
 * Which open requests keep a page "loading" for a network_idle wait and for
 * the short settle after an action. A page is network idle when none of its
 * requests, in its main document or any of its frames, count as loading for
 * a quiet window.
 */

/** One request in a tab's ledger, from any of its sessions: the page, or a
 * cross-origin iframe's. */
export type TrackedRequest = {
  method: string;
  url: string;
  /** The document that issued the request; absent when not reported. */
  loaderId: string | null;
  browserInitiated: boolean;
  /** An event stream or other response that never finishes by design. */
  stream: boolean;
  /** A request the page's content does not wait for (see requestIgnoredForIdle). */
  ignored: boolean;
  /** Resource type as Chrome reports it, such as Document or Fetch. */
  type: string | null;
  frameId: string | null;
  /** Session whose Network domain reported the request starting. */
  sessionId: string;
  startedAt: number;
  /** When the response headers arrived, and when body data last did. */
  respondedAt: number | null;
  dataAt: number | null;
};

/** A response whose body has had no data for this long is a stream or a body
 * the page is not reading, and no longer counts as the page loading. */
export const NETWORK_BODY_STALL_MS = 3_000;
/** A request still without a response after this long is taken for a long
 * poll, which answers only when the server has news. */
export const NETWORK_LONG_POLL_MS = 10_000;
/** Request types the page's content never waits for: beacons and link pings,
 * CSP reports, prefetches for later pages, media streaming and the manifest. */
const NETWORK_IDLE_IGNORED_TYPES = new Set([
  "Ping",
  "CSPViolationReport",
  "Prefetch",
  "Media",
  "Manifest",
]);

export function requestIgnoredForIdle(
  type: string | null,
  url: string,
  browserInitiated: boolean,
): boolean {
  // The browser's own icon fetch, and blob: and data: URLs, which are read
  // locally and touch no network.
  if (browserInitiated || /^(?:blob|data):/i.test(url)) return true;
  return type !== null && NETWORK_IDLE_IGNORED_TYPES.has(type);
}

/**
 * Whether an open request keeps the page loading at `now`. Event streams and
 * ignored types never do. A response stops counting once its body has gone
 * without data for NETWORK_BODY_STALL_MS, so a slow download or a streamed
 * answer that keeps sending still counts. A request with no response yet
 * stops counting after NETWORK_LONG_POLL_MS, as a long poll. A request the
 * ledger no longer holds still counts.
 */
export function requestLoad(
  request: TrackedRequest | undefined,
  now: number,
): "loading" | "quiet" | "long_poll" {
  if (!request) return "loading";
  if (request.stream || request.ignored) return "quiet";
  if (request.respondedAt !== null) {
    const lastData = Math.max(request.respondedAt, request.dataAt ?? 0);
    return now - lastData >= NETWORK_BODY_STALL_MS ? "quiet" : "loading";
  }
  return now - request.startedAt >= NETWORK_LONG_POLL_MS ? "long_poll" : "loading";
}
