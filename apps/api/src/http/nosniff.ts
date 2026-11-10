/**
 * `X-Content-Type-Options: nosniff` for answers that leave the API outside the
 * Hono middleware chain (WebSocket upgrade refusals, the last-resort error
 * answer). The Hono app sets it for everything it serves.
 */
export const NOSNIFF_HEADER = "x-content-type-options";

/** Returns the response with nosniff, keeping a value the response already set. */
export function withNoSniff(response: Response): Response {
  if (response.headers.has(NOSNIFF_HEADER)) return response;
  try {
    response.headers.set(NOSNIFF_HEADER, "nosniff");
    return response;
  } catch {
    // Immutable headers (for example a fetch() or Response.redirect() answer).
    const headers = new Headers(response.headers);
    headers.set(NOSNIFF_HEADER, "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Adds nosniff to a possibly asynchronous, possibly absent response. */
export function withNoSniffEventually(
  response: Response | undefined | Promise<Response | undefined>,
): Response | undefined | Promise<Response | undefined> {
  if (response instanceof Promise) {
    return response.then((resolved) => (resolved ? withNoSniff(resolved) : resolved));
  }
  return response ? withNoSniff(response) : response;
}

/**
 * The generic 500 for a failure that escaped the app's own error handler (Hono
 * re-throws values that are not `Error` instances). Never echoes the failure.
 */
export function lastResortErrorResponse(): Response {
  return new Response(
    JSON.stringify({ code: "INTERNAL_ERROR", message: "The request failed unexpectedly." }),
    {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        [NOSNIFF_HEADER]: "nosniff",
      },
    },
  );
}

/** Runs one request, turning any escaped failure into {@link lastResortErrorResponse}. */
export async function serveWithLastResortError(
  handle: () => Response | Promise<Response>,
  onError?: (error: unknown) => void,
): Promise<Response> {
  try {
    return await handle();
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      /* The answer matters more than the log. */
    }
    return lastResortErrorResponse();
  }
}
