/**
 * Deprecation notices advertised by the OpenGeni API.
 *
 * Per the public API compatibility policy, a route whose behaviour is scheduled
 * for removal answers with the standard `Deprecation` (RFC 9745) and `Sunset`
 * (RFC 8594) headers plus `Link: <notes>; rel="deprecation"`. The client
 * surfaces them through `OpenGeniClientOptions.onDeprecation`, or by default
 * as a one-time `console.warn` per route, so an integrator pinned to an older
 * SDK learns about a removal well before it happens.
 */

export type OpenGeniDeprecationNotice = {
  /** Request method, upper case. */
  method: string;
  /** Request path with ids collapsed (`/v1/workspaces/:id/...`), stable per route. */
  route: string;
  /** Exact request path. */
  path: string;
  /** When the deprecation was announced, if the header carried a date. */
  deprecatedAt: Date | null;
  /** Earliest removal on the server, if advertised. */
  sunset: Date | null;
  /** Migration notes (`rel="deprecation"`), if advertised. */
  link: string | null;
  /** Replacement (`rel="successor-version"`), if advertised. */
  successor: string | null;
};

/** `false` silences notices; a function receives each route's notice once per client. */
export type OpenGeniDeprecationHandler = (notice: OpenGeniDeprecationNotice) => void;

type HeaderBag = { get(name: string): string | null };

const ID_SEGMENT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{20,})$/i;

function routeKey(path: string): string {
  return path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

function parseDeprecationDate(value: string): Date | null {
  const trimmed = value.trim();
  // RFC 9745 structured date `@<unix seconds>`; older drafts used `true` or an HTTP-date.
  const structured = /^@(-?\d+)$/.exec(trimmed);
  if (structured) return new Date(Number(structured[1]) * 1000);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function parseLinks(value: string | null): Map<string, string> {
  const links = new Map<string, string>();
  if (!value) return links;
  for (const match of value.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]+)*)/g)) {
    const rel = /;\s*rel="?([^";,]+)"?/i.exec(match[2] ?? "")?.[1];
    if (!rel) continue;
    for (const name of rel.toLowerCase().split(/\s+/)) {
      if (!links.has(name)) links.set(name, match[1]!);
    }
  }
  return links;
}

/** Read a deprecation notice from response headers; `null` when none is advertised. */
export function parseDeprecationNotice(
  method: string,
  url: string,
  headers: HeaderBag,
): OpenGeniDeprecationNotice | null {
  const deprecation = headers.get("deprecation");
  const sunsetHeader = headers.get("sunset");
  if (!deprecation && !sunsetHeader) return null;
  let path = url;
  try {
    path = new URL(url, "http://opengeni.invalid").pathname;
  } catch {
    // Keep the raw value; the notice is advisory.
  }
  const sunset = sunsetHeader ? Date.parse(sunsetHeader) : Number.NaN;
  const links = parseLinks(headers.get("link"));
  return {
    method: method.toUpperCase(),
    route: routeKey(path),
    path,
    deprecatedAt: deprecation ? parseDeprecationDate(deprecation) : null,
    sunset: Number.isNaN(sunset) ? null : new Date(sunset),
    link: links.get("deprecation") ?? links.get("sunset") ?? null,
    successor: links.get("successor-version") ?? null,
  };
}

const warnedRoutes = new Set<string>();

/** The default handler: one `console.warn` per route per process. */
export function warnDeprecationOnce(notice: OpenGeniDeprecationNotice): void {
  const key = `${notice.method} ${notice.route}`;
  if (warnedRoutes.has(key)) return;
  warnedRoutes.add(key);
  const sunset = notice.sunset ? ` and will be removed after ${notice.sunset.toISOString()}` : "";
  const notes = notice.link ? ` Migration notes: ${notice.link}.` : "";
  console.warn(
    `[@opengeni/sdk] ${key} is deprecated${sunset}.${notes} Upgrade @opengeni/sdk, or pass onDeprecation to handle this notice.`,
  );
}

type FetchFunction<R extends { headers: HeaderBag }> = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<R>;

/**
 * Wrap a fetch implementation so every response is inspected for a deprecation
 * notice. The handler runs at most once per route for this wrapper and never
 * affects the request: a throwing handler is swallowed.
 */
export function withDeprecationNotices<R extends { headers: HeaderBag }>(
  fetchImpl: FetchFunction<R>,
  handler: OpenGeniDeprecationHandler | false | undefined,
): FetchFunction<R> {
  if (handler === false) return fetchImpl;
  const notify = handler ?? warnDeprecationOnce;
  const seen = new Set<string>();
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    try {
      const headers = response.headers;
      if (headers && (headers.get("deprecation") || headers.get("sunset"))) {
        const method =
          init?.method ??
          (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const notice = parseDeprecationNotice(method, url, headers);
        if (notice) {
          const key = `${notice.method} ${notice.route}`;
          if (!seen.has(key)) {
            seen.add(key);
            notify(notice);
          }
        }
      }
    } catch {
      // Deprecation notices are advisory and must never fail a request.
    }
    return response;
  };
}
