import type { Context } from "hono";

const REQUEST_IDLE_TIMEOUT_BINDING = "opengeniRequestIdleTimeout";

/** The API server's idle timeout: a connection that sends or receives nothing
 * for this long is closed, even while its handler is still running. It is
 * also the longest idle timeout Bun accepts, per server or per request. */
export const API_SERVER_IDLE_TIMEOUT_SECONDS = 255;

type RequestIdleTimeout = {
  /** Bun's `server.timeout` for this request's connection. */
  set: (seconds: number) => void;
  /** The server's own idle timeout, restored once lifted work settles. */
  serverSeconds: number;
};

type RequestIdleTimeoutBindings = {
  [REQUEST_IDLE_TIMEOUT_BINDING]?: RequestIdleTimeout;
};

/** Lets a route change this request's connection idle timeout. */
export function apiRequestBindingsForIdleTimeout(
  set: (seconds: number) => void,
  serverSeconds = API_SERVER_IDLE_TIMEOUT_SECONDS,
): RequestIdleTimeoutBindings {
  return { [REQUEST_IDLE_TIMEOUT_BINDING]: { set, serverSeconds } };
}

/**
 * For a route whose response legitimately waits for longer bounded work (an
 * action batch, bounded by its own deadline at the controller), stop the
 * server's idle timer from resetting the connection while that work runs.
 * Bun clamps a per-request idle timeout to 255 seconds, so the timer is
 * turned off rather than lengthened; the work's own deadline bounds the
 * request, and a client that goes away still closes it. The timer belongs to
 * the connection, not the request, so it is restored once the work settles:
 * later requests on a kept-alive connection, and the idle connection itself,
 * keep the server's idle timeout. Without a server binding (in-process
 * requests) there is nothing to change.
 */
export async function withoutRequestIdleTimeout<T>(c: Context, work: () => Promise<T>): Promise<T> {
  const idle = (c.env as RequestIdleTimeoutBindings | undefined)?.[REQUEST_IDLE_TIMEOUT_BINDING];
  if (!idle) return await work();
  idle.set(0);
  try {
    return await work();
  } finally {
    try {
      idle.set(idle.serverSeconds);
    } catch {
      // The connection already closed; there is no timer left to restore.
    }
  }
}
