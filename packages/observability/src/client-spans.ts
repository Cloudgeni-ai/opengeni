import { childSpanRecordingActive, startChildSpan, withTraceContext } from "./trace-context";

/**
 * Outbound-call spans for scopes that record child spans (API requests). Every
 * helper here calls straight through, at no cost, in any other scope. Spans
 * carry only code-chosen names, the HTTP method and the response status: never
 * URLs, hosts, paths, headers, arguments or results.
 */

const HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
]);

function requestMethod(input: unknown, init: unknown): string {
  let method: unknown;
  try {
    method =
      (typeof init === "object" && init !== null
        ? (init as { method?: unknown }).method
        : undefined) ??
      (typeof Request !== "undefined" && input instanceof Request ? input.method : undefined) ??
      "GET";
  } catch {
    method = undefined;
  }
  const upper = typeof method === "string" ? method.toUpperCase() : "";
  return HTTP_METHODS.has(upper) ? upper : "_OTHER";
}

/** The fetch implementation a `traceFetch` wrapper calls. */
const TRACED_FETCH_TARGET = Symbol("opengeni.tracedFetchTarget");

/**
 * The fetch implementation that actually performs a call: `fetchImpl` itself,
 * or for a `traceFetch` wrapper (at any depth) the implementation it wraps.
 * A transport check that admits a specific fetch (native fetch, say) must look
 * through the API's tracing, which wraps `globalThis.fetch` at startup.
 */
export function tracedFetchTarget<F>(fetchImpl: F): F {
  let target: unknown = fetchImpl;
  while (typeof target === "function") {
    const next: unknown = (target as { [TRACED_FETCH_TARGET]?: unknown })[TRACED_FETCH_TARGET];
    if (next === undefined) break;
    target = next;
  }
  return target as F;
}

/**
 * Wrap a fetch implementation so each call under an API request is a client span.
 *
 * The wrapper is transparent: it calls `fetchImpl` synchronously with the same
 * arguments and settles with its exact response or error, so the caller's
 * abort signal and response body custody are those of `fetchImpl` itself.
 * `tracedFetchTarget` returns `fetchImpl` for it.
 */
export function traceFetch<F extends (input: never, init?: never) => Promise<Response>>(
  fetchImpl: F,
): F {
  const traced = (input: never, init?: never): Promise<Response> => {
    if (!childSpanRecordingActive()) return fetchImpl(input, init);
    const method = requestMethod(input, init);
    const span = startChildSpan(`HTTP ${method}`, { "http.request.method": method }, "client");
    if (!span) return fetchImpl(input, init);
    let pending: Promise<Response>;
    try {
      pending = fetchImpl(input, init);
    } catch (error) {
      span.end({ error });
      throw error;
    }
    return Promise.resolve(pending).then(
      (response) => {
        span.end({ attributes: { "http.response.status_code": response.status } });
        return response;
      },
      (error: unknown) => {
        span.end({ error });
        throw error;
      },
    );
  };
  // Keep runtime extras of the wrapped implementation (Bun's fetch.preconnect).
  for (const key of Object.keys(fetchImpl)) {
    (traced as unknown as Record<string, unknown>)[key] = (
      fetchImpl as unknown as Record<string, unknown>
    )[key];
  }
  Object.defineProperty(traced, TRACED_FETCH_TARGET, { value: fetchImpl });
  return traced as unknown as F;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Trace every method call on a client object (object storage, workflow
 * client) as `<client> <method>`. Work inside the call nests under its span.
 * Non-function properties pass through unchanged; methods run with the
 * original object as `this`, so a method's internal calls are not traced twice.
 */
export function traceClientCalls<T extends object>(target: T, client: string): T {
  const wrappers = new Map<string, { original: unknown; wrapper: unknown }>();
  return new Proxy(target, {
    get(base, property) {
      const value = Reflect.get(base, property, base) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      const cached = wrappers.get(property);
      if (cached?.original === value) return cached.wrapper;
      const method = value as (...args: unknown[]) => unknown;
      const wrapper = (...args: unknown[]): unknown => {
        if (!childSpanRecordingActive()) return method.apply(base, args);
        const span = startChildSpan(
          `${client} ${property}`,
          { "opengeni.client": client, "opengeni.client.operation": property },
          "client",
        );
        if (!span) return method.apply(base, args);
        let result: unknown;
        try {
          result = withTraceContext(span, () => method.apply(base, args));
        } catch (error) {
          span.end({ error });
          throw error;
        }
        if (!isThenable(result)) {
          span.end();
          return result;
        }
        return Promise.resolve(result).then(
          (settled) => {
            span.end();
            return settled;
          },
          (error: unknown) => {
            span.end({ error });
            throw error;
          },
        );
      };
      wrappers.set(property, { original: value, wrapper });
      return wrapper;
    },
  });
}
