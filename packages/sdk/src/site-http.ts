/** HTTP transport for the ordinary SDK. One response port per request keeps
 * event streams incremental and cancellation independent of other requests. */
export const SITE_HTTP = "opengeni.site.http";
export const SITE_WORKSPACE = "site-host";
export type SiteHttpRequest = {
  type: typeof SITE_HTTP;
  requestId: string;
  path: string;
  method: string;
  headers: [string, string][];
  body?: string;
};

import { siteSessionPath } from "@opengeni/contracts/site-session-http";
export { siteSessionPath } from "@opengeni/contracts/site-session-http";

export function isSiteHttpRequest(value: unknown): value is SiteHttpRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as SiteHttpRequest;
  return (
    v.type === SITE_HTTP &&
    typeof v.requestId === "string" &&
    typeof v.path === "string" &&
    /^(GET|POST|PUT|PATCH|DELETE)$/u.test(v.method) &&
    (v.body === undefined || typeof v.body === "string") &&
    Array.isArray(v.headers) &&
    v.headers.every(
      (h) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === "string"),
    )
  );
}

export async function serveSiteHttp(
  message: SiteHttpRequest,
  port: MessagePort,
  fetchResponse: (request: SiteHttpRequest, signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let wake: (() => void) | undefined;
  let pulling = false;
  const onMessage = (event: MessageEvent) => {
    if (event.data === "pull") {
      pulling = true;
      wake?.();
    }
  };
  const abort = () => {
    void reader?.cancel(signal.reason).catch(() => {});
    wake?.();
  };
  port.addEventListener("message", onMessage);
  signal.addEventListener("abort", abort, { once: true });
  port.start();
  try {
    if (signal.aborted) throw signal.reason;
    const response = await fetchResponse(message, signal);
    reader = response.body?.getReader();
    port.postMessage({ status: response.status, headers: [...response.headers], body: !!reader });
    if (reader)
      while (!signal.aborted) {
        if (!pulling)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = undefined;
        if (signal.aborted) break;
        pulling = false;
        const part = await reader.read();
        if (part.done) {
          port.postMessage({ done: true });
          break;
        }
        port.postMessage({ chunk: part.value });
      }
    if (signal.aborted) throw signal.reason;
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : "Site request failed" });
  } finally {
    signal.removeEventListener("abort", abort);
    port.removeEventListener("message", onMessage);
    await reader?.cancel().catch(() => {});
    port.close();
  }
}

export async function sitePortFetch(
  port: MessagePort,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  siteSessionPath(path, SITE_WORKSPACE, request.method);
  const channel = new MessageChannel();
  const requestId = crypto.randomUUID();
  const body = request.body ? await request.text() : undefined;
  return await new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    const cleanup = () => {
      finished = true;
      request.signal.removeEventListener("abort", abort);
      channel.port1.close();
    };
    const abort = () => {
      if (finished) return;
      port.postMessage({ type: "opengeni.site.cancel", version: 2, requestId });
      const error = request.signal.reason ?? new DOMException("Cancelled", "AbortError");
      controller?.error(error);
      reject(error);
      cleanup();
    };
    channel.port1.onmessage = (event) => {
      const data = event.data;
      if (data.error) {
        const error = new Error(data.error);
        controller?.error(error);
        reject(error);
        cleanup();
      } else if (data.status) {
        const stream = data.body
          ? new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
              },
              pull() {
                channel.port1.postMessage("pull");
              },
              cancel() {
                controller = undefined;
                abort();
              },
            })
          : null;
        resolve(new Response(stream, { status: data.status, headers: data.headers }));
        if (!data.body) cleanup();
      } else if (data.done) {
        controller?.close();
        cleanup();
      } else if (data.chunk) controller?.enqueue(data.chunk);
    };
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    port.postMessage(
      {
        type: SITE_HTTP,
        requestId,
        path,
        method: request.method,
        headers: [...request.headers],
        ...(body === undefined ? {} : { body }),
      } satisfies SiteHttpRequest,
      [channel.port2],
    );
  });
}
