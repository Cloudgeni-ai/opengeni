import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Any web-standard handler: `createSessionProxyHandler`, `createChatHandler`, or your own. */
export type WebHandler = (request: Request) => Promise<Response>;

/** Express/Connect request: Node's `IncomingMessage` plus what those frameworks add. */
export type NodeRequestLike = IncomingMessage & {
  originalUrl?: string | undefined;
  /** Set when a body parser (for example `express.json()`) already consumed the body. */
  body?: unknown;
  protocol?: string | undefined;
};

export type NodeMiddleware = (
  request: NodeRequestLike,
  response: ServerResponse,
  next?: (error?: unknown) => void,
) => void;

export type NodeMiddlewareOptions = {
  /** Origin used to build the request URL. Defaults to the Host header over http(s). */
  origin?: string | undefined;
};

/**
 * Expose a web-standard handler as Express/Connect (or plain `node:http`)
 * middleware. Mount it with the same path the browser client uses:
 *
 * ```ts
 * app.use("/api/opengeni", toNodeMiddleware(handler));
 * ```
 *
 * The full original URL is forwarded (Express strips the mount path from
 * `req.url`), bodies stream through unless a body parser already consumed
 * them, responses (including SSE) are written as they arrive, and a client
 * disconnect aborts the request signal.
 */
export function toNodeMiddleware(
  handler: WebHandler,
  options: NodeMiddlewareOptions = {},
): NodeMiddleware {
  return (request, response, next) => {
    void (async () => {
      const abort = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) abort.abort();
      });
      const web = await handler(toWebRequest(request, abort.signal, options));
      await writeWebResponse(web, response);
    })().catch((error: unknown) => {
      if (next) next(error);
      else if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      } else response.destroy(error instanceof Error ? error : undefined);
    });
  };
}

/** Express/Connect naming alias. */
export const toExpressMiddleware = toNodeMiddleware;

function toWebRequest(
  request: NodeRequestLike,
  signal: AbortSignal,
  options: NodeMiddlewareOptions,
): Request {
  const encrypted = (request.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  const origin =
    options.origin?.replace(/\/+$/, "") ??
    `${request.protocol ?? (encrypted ? "https" : "http")}://${request.headers.host ?? "localhost"}`;
  const url = new URL(request.originalUrl ?? request.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = request.method ?? "GET";
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (request.body !== undefined && (request.readableEnded || request.complete)) {
      // A body parser consumed the stream: forward what it parsed.
      body =
        typeof request.body === "string" || request.body instanceof Uint8Array
          ? (request.body as string | Uint8Array<ArrayBuffer>)
          : JSON.stringify(request.body);
      headers.delete("content-length");
    } else {
      body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
    }
  }
  return new Request(url, {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

async function writeWebResponse(web: Response, response: ServerResponse): Promise<void> {
  response.statusCode = web.status;
  const cookies = web.headers.getSetCookie?.() ?? [];
  web.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  });
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!web.body) {
    response.end();
    return;
  }
  // Send headers now so SSE clients see the stream open before the first event.
  response.flushHeaders();
  const reader = web.body.getReader();
  response.once("close", () => {
    void reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!response.write(value)) {
      await new Promise<void>((resolve) => {
        const settle = () => {
          response.off("drain", settle);
          response.off("close", settle);
          resolve();
        };
        response.once("drain", settle);
        response.once("close", settle);
      });
    }
    if (response.destroyed) break;
  }
  response.end();
}
