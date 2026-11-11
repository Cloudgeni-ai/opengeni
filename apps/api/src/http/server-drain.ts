import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Context } from "hono";

const SERVER_DRAIN_SIGNAL_BINDING = "opengeniServerDrainSignal";

/**
 * Time the standalone process keeps after the HTTP drain deadline to stop its
 * background work and close the clients in-flight requests used (database,
 * NATS, Temporal) before its own exit deadline. The same ten-second process
 * exit margin the chart leaves turn workers inside their pod grace.
 */
export const API_SHUTDOWN_EXIT_MARGIN_MS = 10_000;

/** How long in-flight requests may keep the listener open after SIGTERM. */
export function apiHttpDrainDeadlineMs(shutdownGraceMs: number): number {
  return Math.max(0, shutdownGraceMs - API_SHUTDOWN_EXIT_MARGIN_MS);
}

type ServerDrainBindings = { [SERVER_DRAIN_SIGNAL_BINDING]?: AbortSignal };

/** Lets live streams opened through this server end when it starts draining. */
export function apiRequestBindingsForServerDrain(signal: AbortSignal): ServerDrainBindings {
  return { [SERVER_DRAIN_SIGNAL_BINDING]: signal };
}

/**
 * The signal a live event stream ends on: the client going away or, on a
 * standalone server, the start of its drain. An unbounded stream would
 * otherwise hold a draining server open until its deadline cut it; ending it
 * at a clean frame boundary lets the client resume on another replica at once.
 * Ordinary requests keep `c.req.raw.signal` so they finish their work.
 */
export function liveStreamSignal(c: Context): AbortSignal {
  const drain = (c.env as ServerDrainBindings | undefined)?.[SERVER_DRAIN_SIGNAL_BINDING];
  return drain ? AbortSignal.any([c.req.raw.signal, drain]) : c.req.raw.signal;
}

type DrainableServer = Pick<Server<unknown>, "stop">;

/**
 * Graceful HTTP/1.1 drain for Bun servers.
 *
 * A keep-alive client keeps sending on a pooled socket after the pod has left
 * the Service endpoints, so removing the endpoint does not stop requests on
 * that socket. Closing the server with `stop(true)` then resets a socket whose
 * request is still running: the handler completes and logs success, but the
 * client gets ECONNRESET. Draining instead:
 *
 * - stops listening and closes keep-alive sockets that are idle between
 *   requests (`stop(false)`), so new requests reach other replicas;
 * - marks every response produced from then on with `Connection: close`, so a
 *   client never reuses a socket the server is about to close;
 * - ends live event streams and closes WebSockets with 1001 (going away),
 *   whose clients reconnect elsewhere;
 * - lets in-flight requests finish writing, and closes what is still open only
 *   at the deadline the shutdown grace allows.
 */
export function createHttpServerDrain() {
  const controller = new AbortController();
  const webSockets = new Set<ServerWebSocket<unknown>>();
  const goAway = (socket: ServerWebSocket<unknown>) => {
    try {
      socket.close(1001, "server shutting down");
    } catch {
      // Already closing.
    }
  };
  const begin = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const socket of webSockets) goAway(socket);
  };
  return {
    get draining() {
      return controller.signal.aborted;
    },
    /** Aborted when the drain begins. */
    signal: controller.signal,
    begin,
    /** Wraps a fetch handler so responses produced while draining close their connection. */
    fetch<Args extends unknown[], R extends Response | undefined>(
      handler: (request: Request, ...args: Args) => R | Promise<R>,
    ) {
      return async (request: Request, ...args: Args): Promise<R> => {
        const response = await handler(request, ...args);
        return controller.signal.aborted && response
          ? (closingConnection(response) as R)
          : response;
      };
    },
    /** Wraps WebSocket handlers so the drain can close every open socket. */
    websocket<T>(handlers: WebSocketHandler<T>): WebSocketHandler<T> {
      return {
        ...handlers,
        open: (socket: ServerWebSocket<T>) => {
          const tracked = socket as ServerWebSocket<unknown>;
          webSockets.add(tracked);
          handlers.open?.(socket);
          if (controller.signal.aborted) goAway(tracked);
        },
        close: (socket: ServerWebSocket<T>, code: number, reason: string) => {
          webSockets.delete(socket as ServerWebSocket<unknown>);
          handlers.close?.(socket, code, reason);
        },
      };
    },
    /**
     * Begins the drain and stops `server` once its in-flight requests have
     * finished, or closes them at `deadlineMs`.
     */
    async stop(server: DrainableServer, deadlineMs: number): Promise<void> {
      begin();
      const graceful = server.stop(false).then(
        () => true,
        () => false,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadlineMs));
      });
      try {
        if (await Promise.race([graceful, deadline])) return;
      } finally {
        clearTimeout(timer);
      }
      await server.stop(true).catch(() => undefined);
    },
  };
}

export type HttpServerDrain = ReturnType<typeof createHttpServerDrain>;

function closingConnection(response: Response): Response {
  try {
    response.headers.set("connection", "close");
    return response;
  } catch {
    // Immutable headers (a proxied fetch response): copy them.
    const headers = new Headers(response.headers);
    headers.set("connection", "close");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
