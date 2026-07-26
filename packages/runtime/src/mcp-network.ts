import type { Settings } from "@opengeni/config";
import {
  isNonPublicAddress,
  pinnedFetch,
  resolvePinnedDestination,
  type DnsLookup,
  type FetchLike,
} from "@opengeni/network";

export { undiciFetch } from "@opengeni/network";

export const MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MCP_MAX_INBOUND_REQUEST_BYTES = 1024 * 1024;
export const MCP_MAX_TOOL_DEFINITION_BYTES = 128 * 1024;
export const MCP_MAX_TOOL_LIST_BYTES = 4 * 1024 * 1024;
export const MCP_MAX_TOOL_LIST_ENTRIES = 1_000;
export const MCP_MAX_TOOL_RESULT_BYTES = 1024 * 1024;
export const MCP_MAX_TOOL_SEARCH_DISCLOSURE_BYTES = 256 * 1024;
export const MCP_MAX_SELECTED_SERVERS = 64;
export const MCP_MAX_CONCURRENT_SERVER_OPERATIONS = 8;
export const MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES = 4_096;
export const MCP_MAX_AGGREGATE_TOOL_LIST_BYTES = 16 * 1024 * 1024;
export const MCP_MAX_TOOL_SEARCH_SOURCES = 64;
export const MCP_MAX_TOOL_SEARCH_SOURCE_LABEL_LENGTH = 120;
export const MCP_MAX_TOOL_SEARCH_DESCRIPTION_BYTES = 16 * 1024;

export class McpPayloadTooLargeError extends Error {
  constructor(
    readonly label: string,
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super(`${label} exceeds the ${maxBytes}-byte safety limit`);
    this.name = "McpPayloadTooLargeError";
  }
}

export function mcpSerializedSizeBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    throw new Error("MCP payload is not JSON serializable");
  }
  return Buffer.byteLength(serialized);
}

export function assertMcpPayloadWithinBytes(value: unknown, maxBytes: number, label: string): void {
  const actualBytes = mcpSerializedSizeBytes(value);
  if (actualBytes > maxBytes) {
    throw new McpPayloadTooLargeError(label, actualBytes, maxBytes);
  }
}

export function assertMcpToolListWithinBounds<T>(tools: readonly T[]): readonly T[] {
  if (tools.length > MCP_MAX_TOOL_LIST_ENTRIES) {
    throw new McpPayloadTooLargeError("MCP tool list", tools.length, MCP_MAX_TOOL_LIST_ENTRIES);
  }
  for (const tool of tools) {
    const toolBytes = mcpSerializedSizeBytes(tool);
    if (toolBytes > MCP_MAX_TOOL_DEFINITION_BYTES) {
      throw new McpPayloadTooLargeError(
        "MCP tool definition",
        toolBytes,
        MCP_MAX_TOOL_DEFINITION_BYTES,
      );
    }
  }
  // Measure the complete JSON array, including brackets and separators. Summing
  // definitions alone under-counts by one byte per separator plus the array
  // delimiters and makes the advertised serialized-byte ceiling porous.
  const totalBytes = mcpSerializedSizeBytes(tools);
  if (totalBytes > MCP_MAX_TOOL_LIST_BYTES) {
    throw new McpPayloadTooLargeError("MCP tool list", totalBytes, MCP_MAX_TOOL_LIST_BYTES);
  }
  return tools;
}

export function assertMcpServerSelectionWithinBounds<T>(servers: readonly T[]): readonly T[] {
  if (servers.length > MCP_MAX_SELECTED_SERVERS) {
    throw new McpPayloadTooLargeError(
      "selected MCP server count",
      servers.length,
      MCP_MAX_SELECTED_SERVERS,
    );
  }
  return servers;
}

type McpToolListContribution = {
  entries: number;
  bytes: number;
};

/**
 * Atomic aggregate accounting shared by every exposed tools/list in one run.
 * A repeated list for the same source REPLACES its prior contribution, so
 * cache invalidation/relisting cannot ratchet the budget upward. Failed
 * replacements leave the previous accounting intact.
 */
export class McpAggregateToolListBudget {
  private readonly contributions = new Map<string, McpToolListContribution>();
  private totalEntries = 0;
  private totalBytes = 0;

  constructor(
    private readonly label = "aggregate MCP tool list",
    private readonly maxEntries = MCP_MAX_AGGREGATE_TOOL_LIST_ENTRIES,
    private readonly maxBytes = MCP_MAX_AGGREGATE_TOOL_LIST_BYTES,
  ) {}

  replace<T>(sourceId: string, tools: readonly T[]): readonly T[] {
    assertMcpToolListWithinBounds(tools);
    const contribution = {
      entries: tools.length,
      // Conservatively account each server as its complete serialized array.
      // Summing these arrays slightly over-counts the brackets relative to one
      // flattened array, which is intentional for a fail-closed hard ceiling.
      bytes: mcpSerializedSizeBytes(tools),
    };
    const previous = this.contributions.get(sourceId) ?? { entries: 0, bytes: 0 };
    const nextEntries = this.totalEntries - previous.entries + contribution.entries;
    if (nextEntries > this.maxEntries) {
      throw new McpPayloadTooLargeError(this.label, nextEntries, this.maxEntries);
    }
    const nextBytes = this.totalBytes - previous.bytes + contribution.bytes;
    if (nextBytes > this.maxBytes) {
      throw new McpPayloadTooLargeError(this.label, nextBytes, this.maxBytes);
    }
    this.contributions.set(sourceId, contribution);
    this.totalEntries = nextEntries;
    this.totalBytes = nextBytes;
    return tools;
  }

  remove(sourceId: string): void {
    const previous = this.contributions.get(sourceId);
    if (!previous) return;
    this.contributions.delete(sourceId);
    this.totalEntries -= previous.entries;
    this.totalBytes -= previous.bytes;
  }

  snapshot(): Readonly<McpToolListContribution> {
    return { entries: this.totalEntries, bytes: this.totalBytes };
  }
}

/** Stable-order parallel map with a hard in-flight ceiling and fail-stop drain. */
export async function boundedParallelMap<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("bounded parallel map concurrency must be a positive integer");
  }
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  let nextIndex = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = nextIndex;
      if (index >= values.length) return;
      nextIndex += 1;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        errors.push({ index, error });
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  if (errors.length > 0) {
    errors.sort((left, right) => left.index - right.index);
    throw errors[0]!.error;
  }
  return results;
}

/**
 * Guard normal MCP traffic with the same deployment policy as OAuth traffic.
 * The pinned transport resolves and policy-checks the destination after the
 * caller has composed any credential headers, then performs the final network
 * call through the vetted Agent. It forces manual redirects, so an
 * Authorization-bearing request never follows a provider-controlled Location
 * to an unvalidated host.
 *
 * This module is deliberately agent-loop-free. API code imports the explicit
 * `@opengeni/runtime/mcp-network` leaf rather than the runtime root barrel.
 */
export function guardedMcpFetch<TInput extends string | URL | Request>(
  settings: Pick<Settings, "environment" | "integrationsAllowPrivateNetworkTargets">,
  fetchImpl: (input: TInput, init?: RequestInit) => Promise<Response>,
  options: {
    maxResponseBytes?: number;
    dnsLookup?: DnsLookup;
    requireHttpsOutsideLocalTest?: boolean;
  } = {},
): (input: TInput, init?: RequestInit) => Promise<Response> {
  return async (input: TInput, init?: RequestInit) => {
    const response = await pinnedFetch(input, init, settings, {
      fetchImpl: fetchImpl as FetchLike,
      ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
      label: "MCP endpoint",
      requireHttpsOutsideLocalTest: options.requireHttpsOutsideLocalTest ?? true,
    });
    return boundMcpResponseBody(response, options.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES);
  };
}

export function boundMcpResponseBody(response: Response, maxBytes: number): Response {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new McpPayloadTooLargeError("MCP response", declaredLength, maxBytes);
  }
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new McpPayloadTooLargeError("MCP response", receivedBytes, maxBytes));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(bounded, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url },
  });
  return bounded;
}

export async function cancelMcpResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Read and rebuild an inbound MCP request before the SDK parses it. */
export async function boundedMcpRequest(
  request: Request,
  maxBytes = MCP_MAX_INBOUND_REQUEST_BYTES,
): Promise<Request> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized)) {
      await request.body?.cancel().catch(() => undefined);
      throw new McpPayloadTooLargeError("MCP request", 0, maxBytes);
    }
    const declaredBytes = Number(normalized);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      throw new McpPayloadTooLargeError("MCP request", declaredBytes, maxBytes);
    }
  }
  if (!request.body) {
    return request;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpPayloadTooLargeError("MCP request", receivedBytes, maxBytes);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body, headers: request.headers });
}

export async function assertMcpDestinationAllowed(
  rawUrl: string,
  settings: Pick<Settings, "environment" | "integrationsAllowPrivateNetworkTargets">,
  options: { dnsLookup?: DnsLookup } = {},
): Promise<void> {
  await resolvePinnedDestination(rawUrl, settings, {
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    label: "MCP endpoint",
    requireHttpsOutsideLocalTest: true,
  });
}

export const isNonPublicMcpAddress = isNonPublicAddress;
