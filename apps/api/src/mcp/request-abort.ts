import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Serve one first-party MCP POST and bind the tool handlers' `extra.signal` to
 * the HTTP client's connection.
 *
 * The API builds a fresh transport plus `McpServer` per POST, so an MCP
 * `notifications/cancelled` from the worker would land on a different Protocol
 * instance and never reach the handler. The only cancellation evidence this
 * process can observe is the HTTP request's own abort (`Request.signal`, which
 * Bun fires when the client disconnects). Closing the transport runs the SDK
 * `Protocol._onclose`, which aborts every in-flight request handler's
 * controller, so a blocking tool such as `session_wait` stops promptly when the
 * worker drops the call (Steer, Pause, turn interruption).
 *
 * In JSON-response mode the SDK's `handleRequest` promise never settles once
 * its stream mapping is cleared, so the race resolves a client-gone response
 * instead of leaving the route handler pending.
 */
export async function handleMcpRequestWithClientAbort(
  transport: Pick<WebStandardStreamableHTTPServerTransport, "handleRequest" | "close">,
  request: Request,
  clientSignal: AbortSignal | undefined,
): Promise<Response> {
  if (!clientSignal) return await transport.handleRequest(request);
  const clientGone = () => new Response(null, { status: 499 });
  if (clientSignal.aborted) {
    await transport.close().catch(() => undefined);
    return clientGone();
  }
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<Response>((resolve) => {
    onAbort = () => {
      void transport.close().catch(() => undefined);
      resolve(clientGone());
    };
    clientSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([transport.handleRequest(request), aborted]);
  } finally {
    if (onAbort) clientSignal.removeEventListener("abort", onAbort);
  }
}
