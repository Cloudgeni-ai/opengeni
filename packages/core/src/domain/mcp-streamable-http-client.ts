import {
  Client,
  type ClientCapabilities,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export type McpStreamableHttpClient = Client;

export type McpStreamableHttpConnectInput = {
  url: string | URL;
  clientName: string;
  clientVersion: string;
  timeoutMs: number;
  requestInit?: RequestInit;
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Client capabilities to advertise, such as protocol extensions. */
  capabilities?: ClientCapabilities;
};

/**
 * Connect an MCP client over streamable HTTP with protocol revision 2026-07-28
 * (MCP TypeScript SDK v2). The era is negotiated per server: `server/discover`
 * first, then the 2025-era `initialize` handshake for legacy servers. A legacy
 * server that answers the probe with a 5xx is retried with the plain 2025
 * handshake, so every server that connected before still connects.
 */
export async function connectMcpStreamableHttpClient(
  input: McpStreamableHttpConnectInput,
): Promise<McpStreamableHttpClient> {
  try {
    return await connectOnce(input, "auto");
  } catch (error) {
    if (!(SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed)) {
      throw legacyMcpClientError(error);
    }
  }
  try {
    return await connectOnce(input, "legacy");
  } catch (error) {
    throw legacyMcpClientError(error);
  }
}

/**
 * Run `use` against a connected client, then close it. A server can answer the
 * 2026-07-28 `server/discover` probe yet send 2025-era results without the
 * required `resultType`, so every result fails validation. Such a server is a
 * 2025-era server in practice: reconnect it over the 2025 handshake and run
 * `use` once more instead of losing its results.
 */
export async function withMcpStreamableHttpClient<T>(
  input: McpStreamableHttpConnectInput,
  use: (client: McpStreamableHttpClient) => Promise<T>,
): Promise<T> {
  let client = await connectMcpStreamableHttpClient(input);
  try {
    try {
      return await use(client);
    } catch (error) {
      if (!isModernEraResultMismatch(client, error)) throw error;
    }
    await client.close().catch(() => undefined);
    try {
      client = await connectOnce(input, "legacy");
    } catch (error) {
      throw legacyMcpClientError(error);
    }
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function isModernEraResultMismatch(
  client: McpStreamableHttpClient,
  error: unknown,
): boolean {
  try {
    return (
      client.getProtocolEra() === "modern" &&
      SdkError.isInstance(error) &&
      error.code === SdkErrorCode.InvalidResult &&
      (error.data as { violation?: unknown } | undefined)?.violation === "missing-resultType"
    );
  } catch {
    return false;
  }
}

async function connectOnce(
  input: McpStreamableHttpConnectInput,
  mode: "auto" | "legacy",
): Promise<McpStreamableHttpClient> {
  const client = new Client(
    { name: input.clientName, version: input.clientVersion },
    { capabilities: input.capabilities ?? {}, versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(input.url), {
    ...(input.requestInit ? { requestInit: input.requestInit } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  try {
    await client.connect(transport, {
      timeout: input.timeoutMs,
      maxTotalTimeout: input.timeoutMs,
    });
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Re-express a v2 client failure in the shape the 2025-era SDK used
 * ("MCP error <code>: <message>", "Streamable HTTP error: <message>"), which
 * operator-facing classification and messages were written against.
 */
export function legacyMcpClientError(error: unknown): unknown {
  try {
    let legacy: Error & { code?: unknown; data?: unknown };
    if (ProtocolError.isInstance(error)) {
      legacy = Object.assign(new Error(`MCP error ${error.code}: ${error.message}`), {
        name: "McpError",
        code: error.code,
        data: error.data,
      });
    } else if (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout) {
      legacy = Object.assign(new Error(`MCP error -32001: ${error.message}`), {
        name: "McpError",
        code: -32_001,
        data: error.data,
      });
    } else if (SdkError.isInstance(error) && error.code === SdkErrorCode.ConnectionClosed) {
      legacy = Object.assign(new Error(`MCP error -32000: ${error.message}`), {
        name: "McpError",
        code: -32_000,
      });
    } else if (SdkHttpError.isInstance(error)) {
      const status = (error.data as { status?: unknown } | undefined)?.status;
      legacy = Object.assign(new Error(`Streamable HTTP error: ${error.message}`), {
        code: typeof status === "number" ? status : -1,
      });
    } else if (
      SdkError.isInstance(error) &&
      error.code === SdkErrorCode.ClientHttpUnexpectedContent
    ) {
      legacy = Object.assign(new Error(`Streamable HTTP error: ${error.message}`), { code: -1 });
    } else {
      return error;
    }
    if (error instanceof Error && error.stack) legacy.stack = error.stack;
    return legacy;
  } catch {
    return error;
  }
}
