// The explicit entrypoint avoids Bun's native `undici` compatibility shim,
// which exposes an Agent-shaped object without Dispatcher methods.
import { Agent, fetch as undiciFetchImpl } from "undici/index.js";
import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type DnsAddress = {
  address: string;
  family: 4 | 6;
};

export type DnsLookup = (hostname: string) => Promise<readonly DnsAddress[]>;

export type OutboundNetworkSettings = {
  environment: string;
  integrationsAllowPrivateNetworkTargets: boolean;
};

export type PinnedDestination = {
  url: URL;
  hostname: string;
  addresses: readonly DnsAddress[];
};

export type DispatcherLifecycle = {
  /** The raw dispatcher handed to fetch; omitted for test-only lifecycle fakes. */
  dispatcher?: unknown;
  close: () => Promise<void> | void;
  destroy: (error?: unknown) => Promise<void> | void;
};

export type PinnedFetchOptions = {
  fetchImpl?: FetchLike;
  dnsLookup?: DnsLookup;
  agentFactory?: (addresses: readonly DnsAddress[]) => DispatcherLifecycle;
  label?: string;
  requireHttpsOutsideLocalTest?: boolean;
};

export const OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;

export type HttpUrlValidationOptions = {
  allowLoopbackHttp?: boolean;
  label?: string;
};

/** Validate a protocol endpoint before it is persisted, returned, or opened. */
export function validateHttpUrl(rawUrl: string, options: HttpUrlValidationOptions = {}): string {
  const label = options.label ?? "HTTP endpoint";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DestinationPolicyError("invalid_url", `${label} URL is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DestinationPolicyError(
      "unsupported_protocol",
      `${label} only supports http and https URLs`,
    );
  }
  if (url.username || url.password) {
    throw new DestinationPolicyError("invalid_url", `${label} URL may not contain credentials`);
  }
  if (url.hash) {
    throw new DestinationPolicyError("invalid_url", `${label} URL may not contain a fragment`);
  }
  if (
    url.protocol === "http:" &&
    !(options.allowLoopbackHttp && isLoopbackHostname(url.hostname))
  ) {
    throw new DestinationPolicyError("https_required", `${label} must use https`);
  }
  return url.toString();
}

/**
 * Raised when a response cannot be safely consumed within its caller's byte
 * budget. The error intentionally contains no response bytes or provider
 * message: these readers are used on credential-bearing paths.
 */
export class ResponseBodyLimitError extends Error {
  constructor(
    readonly label: string,
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly reason: "declared_length" | "stream_overflow" | "invalid_content_length",
  ) {
    super(`${label} exceeded its ${maxBytes}-byte response limit`);
    this.name = "ResponseBodyLimitError";
  }
}

/**
 * Read a response through its stream with a hard byte ceiling.
 *
 * A declared Content-Length above the ceiling is rejected before reading. A
 * body exactly at the ceiling is accepted; the first byte beyond it cancels
 * the stream and rejects. Cancellation is important because pinnedFetch owns a
 * per-response dispatcher which must be closed on every exit path.
 */
export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("response body limit must be a non-negative safe integer");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const normalized = declared.trim();
    if (!/^\d+$/.test(normalized)) {
      await cancelResponse(response);
      throw new ResponseBodyLimitError(label, 0, maxBytes, "invalid_content_length");
    }
    const declaredBytes = Number(normalized);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await cancelResponse(response);
      throw new ResponseBodyLimitError(label, declaredBytes, maxBytes, "declared_length");
    }
  }
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyLimitError(label, receivedBytes, maxBytes, "stream_overflow");
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
  return body;
}

export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBodyBounded(response, maxBytes, label));
}

export async function readResponseJsonBounded<T = unknown>(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<T> {
  return JSON.parse(await readResponseTextBounded(response, maxBytes, label)) as T;
}

export type ResolvePinnedDestinationOptions = {
  dnsLookup?: DnsLookup;
  label?: string;
  requireHttpsOutsideLocalTest?: boolean;
};

export type DestinationPolicyReason =
  | "invalid_url"
  | "unsupported_protocol"
  | "https_required"
  | "dns_failed"
  | "dns_empty"
  | "invalid_dns_answer"
  | "private_or_special_use";

export class DestinationPolicyError extends Error {
  constructor(
    readonly reason: DestinationPolicyReason,
    message: string,
  ) {
    super(message);
    this.name = "DestinationPolicyError";
  }
}

const defaultDnsLookup: DnsLookup = async (hostname) => {
  const answers = await nodeLookup(hostname, { all: true });
  return answers.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? (6 as const) : (4 as const),
  }));
};

const defaultFetch: FetchLike = (input, init) =>
  (undiciFetchImpl as unknown as FetchLike)(input, init);

/** Undici fetch used by the pinned transport; Bun callers should prefer this over native fetch. */
export const undiciFetch: FetchLike = defaultFetch;

/**
 * Resolve and policy-check one destination. The returned address set is the
 * complete DNS answer that the caller is allowed to use; the transport never
 * performs a second resolver call.
 */
export async function resolvePinnedDestination(
  rawUrl: string | URL,
  settings: OutboundNetworkSettings,
  options: ResolvePinnedDestinationOptions = {},
): Promise<PinnedDestination> {
  const label = options.label ?? "Outbound request";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DestinationPolicyError("invalid_url", `${label} URL is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DestinationPolicyError(
      "unsupported_protocol",
      `${label} only supports http and https URLs`,
    );
  }
  const localTestEscape = isLocalTestEnvironment(settings.environment);
  if (options.requireHttpsOutsideLocalTest && !localTestEscape && url.protocol !== "https:") {
    throw new DestinationPolicyError(
      "https_required",
      `${label} must use https outside local/test`,
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new DestinationPolicyError("invalid_url", `${label} URL has no hostname`);
  }

  const literalFamily = isIP(hostname);
  let addresses: readonly DnsAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
      : await (options.dnsLookup ?? defaultDnsLookup)(hostname);
  } catch {
    throw new DestinationPolicyError("dns_failed", `${label} hostname could not be resolved`);
  }

  const normalizedAddresses = dedupeAddresses(addresses);
  if (normalizedAddresses.length === 0) {
    throw new DestinationPolicyError("dns_empty", `${label} hostname has no addresses`);
  }
  if (normalizedAddresses.some((entry) => isInvalidAddress(entry.address))) {
    throw new DestinationPolicyError(
      "invalid_dns_answer",
      `${label} hostname returned an invalid address`,
    );
  }

  const privateEscape = localTestEscape || settings.integrationsAllowPrivateNetworkTargets === true;
  if (
    !privateEscape &&
    (isLocalHostname(hostname) ||
      normalizedAddresses.some((entry) => isNonPublicAddress(entry.address)))
  ) {
    throw new DestinationPolicyError(
      "private_or_special_use",
      `${label} may not target a private or special-use network address`,
    );
  }
  return { url, hostname, addresses: normalizedAddresses };
}

/**
 * Fetch through a dispatcher whose lookup is pinned to the result of exactly
 * one policy resolution. The response body owns the agent until completion,
 * cancellation, or stream failure.
 */
export async function pinnedFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  settings: OutboundNetworkSettings,
  options: PinnedFetchOptions = {},
): Promise<Response> {
  const rawUrl = input instanceof Request ? input.url : input;
  const destination = await resolvePinnedDestination(rawUrl, settings, options);
  const dispatcher =
    options.agentFactory?.(destination.addresses) ?? createPinnedAgent(destination.addresses);
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const fetchInit = {
    ...init,
    redirect: "manual" as const,
    dispatcher: dispatcher.dispatcher ?? dispatcher,
  } as RequestInit & { dispatcher: DispatcherLifecycle };
  let response: Response;
  try {
    response = await fetchImpl(input, fetchInit);
  } catch (error) {
    await destroyDispatcher(dispatcher, error);
    throw error;
  }
  if (!response.body) {
    await closeDispatcher(dispatcher);
    return response;
  }
  return responseWithDispatcherLifecycle(response, dispatcher);
}

export function isLocalTestEnvironment(environment: string): boolean {
  return environment === "local" || environment === "test";
}

/** Return true for malformed, non-IPv4, and non-IPv6 address strings. */
export function isInvalidAddress(address: string): boolean {
  return isIP(stripAddressBrackets(address.trim())) === 0;
}

/**
 * Classify private, reserved, documentation, benchmark, multicast, and other
 * special-use answers. IPv4-mapped IPv6 addresses are classified through their
 * embedded IPv4 value.
 */
export function isNonPublicAddress(address: string): boolean {
  const normalized = stripAddressBrackets(address.trim().toLowerCase());
  const family = isIP(normalized);
  if (family === 0) {
    return true;
  }
  if (family === 4) {
    return isNonPublicIpv4(normalized);
  }
  const mappedText = ipv4FromMappedText(normalized);
  if (mappedText !== null) {
    return isNonPublicIpv4(mappedText);
  }
  const value = parseIpv6(normalized);
  if (value === null) {
    return true;
  }
  const mapped = ipv4FromMappedIpv6(value);
  if (mapped !== null) {
    return isNonPublicIpv4(mapped);
  }
  // Fail closed on unallocated/non-global IPv6 space. Current globally routed
  // unicast addresses live in 2000::/3; local, transition, multicast, and
  // future-use ranges must not become credential-bearing egress merely because
  // they were absent from a denylist.
  if (!hasIpv6Prefix(value, IPV6_GLOBAL_UNICAST_PREFIX, 3)) {
    return true;
  }
  return IPV6_SPECIAL_PREFIXES.some(([prefix, bits]) => hasIpv6Prefix(value, prefix, bits));
}

// Backwards-compatible name used by the database token-broker API.
export const isPrivateAddress = isNonPublicAddress;

function createPinnedAgent(addresses: readonly DnsAddress[]): DispatcherLifecycle {
  const agent = new Agent({
    connect: {
      lookup: ((
        _hostname: string,
        options: { all?: boolean; family?: number },
        callback: (
          error: Error | null,
          address?: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ) => {
        const candidates =
          options.family === 4 || options.family === 6
            ? addresses.filter((entry) => entry.family === options.family)
            : addresses;
        if (candidates.length === 0) {
          callback(new Error("pinned DNS answer has no address for requested family"));
          return;
        }
        if (options.all) {
          callback(
            null,
            candidates.map((entry) => ({ address: entry.address, family: entry.family })),
          );
          return;
        }
        const first = candidates[0]!;
        callback(null, first.address, first.family);
      }) as never,
    },
  });
  return {
    dispatcher: agent,
    close: async () => {
      await agent.close();
    },
    destroy: async (error) => {
      await agent.destroy(error instanceof Error ? error : null);
    },
  };
}

function responseWithDispatcherLifecycle(
  response: Response,
  dispatcher: DispatcherLifecycle,
): Response {
  const reader = response.body!.getReader();
  let disposed: Promise<void> | null = null;
  let cancelled = false;
  const finish = (destroy: boolean, error?: unknown): Promise<void> => {
    if (!disposed) {
      disposed = destroy ? destroyDispatcher(dispatcher, error) : closeDispatcher(dispatcher);
    }
    return disposed;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await finish(cancelled);
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await finish(true, error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        await finish(true, reason);
      }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(wrapped, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url },
  });
  return wrapped;
}

async function closeDispatcher(dispatcher: DispatcherLifecycle): Promise<void> {
  try {
    await dispatcher.close();
  } catch {
    await destroyDispatcher(dispatcher);
  }
}

async function destroyDispatcher(dispatcher: DispatcherLifecycle, error?: unknown): Promise<void> {
  try {
    await dispatcher.destroy(error);
  } catch {
    // Cleanup is best effort after the dispatcher has already failed.
  }
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function normalizeHostname(hostname: string): string {
  return stripAddressBrackets(hostname.trim().toLowerCase()).replace(/\.$/, "");
}

function stripAddressBrackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    isLoopbackIpv4(normalized)
  );
}

function isLoopbackIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  return hostname.split(".")[0] === "127";
}

function dedupeAddresses(addresses: readonly DnsAddress[]): DnsAddress[] {
  const out: DnsAddress[] = [];
  const seen = new Set<string>();
  for (const entry of addresses) {
    const address = stripAddressBrackets(entry.address.trim().toLowerCase());
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      out.push({ address, family: 4 });
      continue;
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ address, family });
    }
  }
  return out;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const value = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
  const unsigned = value >>> 0;
  return (
    inIpv4Range(unsigned, 0x00000000, 0x00ffffff) ||
    inIpv4Range(unsigned, 0x0a000000, 0x0affffff) ||
    inIpv4Range(unsigned, 0x64400000, 0x647fffff) ||
    inIpv4Range(unsigned, 0x7f000000, 0x7fffffff) ||
    inIpv4Range(unsigned, 0xa9fe0000, 0xa9feffff) ||
    inIpv4Range(unsigned, 0xac100000, 0xac1fffff) ||
    inIpv4Range(unsigned, 0xc0000000, 0xc00000ff) ||
    inIpv4Range(unsigned, 0xc0000200, 0xc00002ff) ||
    inIpv4Range(unsigned, 0xc01fc400, 0xc01fc4ff) ||
    inIpv4Range(unsigned, 0xc034c100, 0xc034c1ff) ||
    inIpv4Range(unsigned, 0xc0586300, 0xc05863ff) ||
    inIpv4Range(unsigned, 0xc0a80000, 0xc0a8ffff) ||
    inIpv4Range(unsigned, 0xc0af3000, 0xc0af30ff) ||
    inIpv4Range(unsigned, 0xc6120000, 0xc613ffff) ||
    inIpv4Range(unsigned, 0xc6336400, 0xc63364ff) ||
    inIpv4Range(unsigned, 0xcb007100, 0xcb0071ff) ||
    inIpv4Range(unsigned, 0xe0000000, 0xffffffff)
  );
}

function inIpv4Range(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

const IPV6_GLOBAL_UNICAST_PREFIX = ipv6Constant("2000::");

const IPV6_SPECIAL_PREFIXES: readonly [bigint, number][] = [
  [ipv6Constant("::"), 96],
  [ipv6Constant("64:ff9b::"), 96],
  [ipv6Constant("64:ff9b:1::"), 48],
  [ipv6Constant("100::"), 64],
  // IETF protocol assignments contain globally reachable carve-outs, but they
  // are control-plane anycast/protocol addresses rather than integration
  // endpoints. Credential-bearing MCP/OAuth egress fails closed on the full
  // special-purpose block.
  [ipv6Constant("2001::"), 23],
  [ipv6Constant("2001:db8::"), 32],
  [ipv6Constant("2002::"), 16],
  [ipv6Constant("2620:4f:8000::"), 48],
  [ipv6Constant("3ffe::"), 16],
  [ipv6Constant("3fff::"), 20],
  [ipv6Constant("5f00::"), 16],
  [ipv6Constant("fc00::"), 7],
  [ipv6Constant("fe80::"), 10],
  [ipv6Constant("fec0::"), 10],
  [ipv6Constant("ff00::"), 8],
];

function hasIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = 128n - BigInt(bits);
  return value >> shift === prefix >> shift;
}

function ipv4FromMappedIpv6(value: bigint): string | null {
  if (value >> 32n !== 0xffffn) {
    return null;
  }
  const embedded = Number(value & 0xffffffffn);
  return `${embedded >>> 24}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`;
}

function ipv4FromMappedText(address: string): string | null {
  if (!address.startsWith("::ffff:")) {
    return null;
  }
  const embedded = address.slice("::ffff:".length);
  if (isIP(embedded) === 4) {
    return embedded;
  }
  const parts = embedded.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function parseIpv6(address: string): bigint | null {
  const percent = address.indexOf("%");
  if (percent >= 0) {
    return null;
  }
  let value = address;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const dotted = value.slice(lastColon + 1);
    const parts = dotted.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const hex =
      ((parts[0]! << 8) | parts[1]!).toString(16).padStart(4, "0") +
      ((parts[2]! << 8) | parts[3]!).toString(16).padStart(4, "0");
    value = `${value.slice(0, lastColon + 1)}${hex}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (left.concat(right).some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return null;
  }
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) {
    return null;
  }
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6Constant(address: string): bigint {
  const value = parseIpv6(address);
  if (value === null) {
    throw new Error(`invalid IPv6 constant: ${address}`);
  }
  return value;
}
