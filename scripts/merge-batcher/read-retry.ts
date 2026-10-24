/** Retry only explicitly read-only calls. Never wrap an effect transport. */
export interface ReadRetryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
const clock: ReadRetryClock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly retryAfterSeconds = 0,
  ) {
    super(`GitHub ${operation} failed (${status}); response body suppressed`);
  }
}
export class ReadUnavailable extends ProviderError {
  constructor(
    status: number,
    readonly attempts: number,
    readonly endpoint: string,
    retryAfterSeconds = 0,
  ) {
    super(status, "read", retryAfterSeconds);
    this.message = `GitHub read unavailable (${status || "transport"}), ${attempts} attempts: ${endpoint}`;
  }
}
function safeEndpoint(input: string): string {
  const url = new URL(input);
  // Signed artifact URLs and query strings must never enter diagnostics.
  return url.hostname === "api.github.com" ? url.pathname : "artifact download";
}
export async function retryRead(
  transport: typeof fetch,
  input: string,
  init: RequestInit,
  time: ReadRetryClock = clock,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    let query: unknown;
    try {
      query = JSON.parse(String(init.body)).query;
    } catch {
      throw new Error("Read retry requires a read-only request");
    }
    if (method !== "POST" || !/^\s*query\b/.test(String(query)))
      throw new Error("Read retry forbids mutations");
  }
  const deadline = time.now() + 60_000;
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    let retryAfter = 0;
    try {
      init.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - time.now())));
      const response = await transport(input, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      status = response.status;
      const rateLimited =
        status === 429 ||
        (status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")));
      if (!rateLimited && status < 500) {
        if (!response.ok) return response;
        // Finish reading while the attempt's timeout is still alive. Otherwise
        // a timeout after headers would escape the bounded read retry path.
        if (!response.body) return response;
        const body = await response.arrayBuffer();
        return new Response(body, {
          status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const raw = response.headers.get("retry-after");
      retryAfter = raw ? Math.max(0, Number(raw) || (Date.parse(raw) - time.now()) / 1000 || 0) : 0;
      if (rateLimited && !retryAfter) {
        retryAfter = Math.max(
          60,
          Number(response.headers.get("x-ratelimit-reset")) - time.now() / 1000 || 60,
        );
      }
      await response.body?.cancel();
    } catch (error) {
      // Cancellation belongs to the caller. Programming/validation failures are
      // not a reason to repeat a request.
      if (init.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : "";
      if (!(error instanceof TypeError) && !["TimeoutError", "AbortError"].includes(name))
        throw error;
    }
    const delay = Math.max(
      retryAfter * 1000,
      250 * 2 ** (attempt - 1) + Math.floor(time.random() * 250),
    );
    if (attempt >= 5 || time.now() + delay >= deadline)
      throw new ReadUnavailable(status, attempt, safeEndpoint(input), Math.ceil(retryAfter));
    await time.sleep(delay);
  }
}
