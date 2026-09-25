import { BlockList, isIP } from "node:net";
import { trustedProxyCidrEntries, type Settings } from "@opengeni/config";
import type { Context } from "hono";

const TRANSPORT_PEER_ADDRESS_BINDING = "opengeniTransportPeerAddress";

/** Returned when the runtime supplied no transport peer (for example an
 * in-process test request). Callers treat it as one shared bucket. */
export const UNKNOWN_REQUEST_SOURCE_ADDRESS = "unknown";

/**
 * App-owned request header carrying the server-resolved client address into
 * Better Auth, which reads client addresses only from request headers. It is
 * removed from every inbound request and re-stamped on managed-auth routes, so
 * a caller-supplied value never reaches the auth rate limiter or session IP.
 */
export const TRUSTED_CLIENT_ADDRESS_HEADER = "x-opengeni-trusted-client-address";

type ApiRequestBindings = {
  [TRANSPORT_PEER_ADDRESS_BINDING]?: string | null;
};

/** The deployment's declared proxy chain (`OPENGENI_API_TRUSTED_PROXY_*`). */
export type RequestSourceTrust = Pick<Settings, "apiTrustedProxyHops" | "apiTrustedProxyCidrs">;

export function apiRequestBindingsForTransportPeer(
  address: string | null | undefined,
): ApiRequestBindings {
  return { [TRANSPORT_PEER_ADDRESS_BINDING]: address ?? null };
}

/**
 * Resolve a quota/audit source from the server-owned transport peer. Forwarded
 * values are considered only when the operator declares an exact trusted proxy
 * hop count (`OPENGENI_API_TRUSTED_PROXY_HOPS`) and, when
 * `OPENGENI_API_TRUSTED_PROXY_CIDRS` is set, only for a transport peer inside
 * those ranges. Each trusted proxy must append the address of the peer that
 * connected to it, or overwrite the header with the original client address;
 * the chain is then walked from the server side so caller-prepended values
 * cannot replace the address observed by the trusted edge. A missing, short,
 * or malformed chain falls back to the transport peer.
 */
export function trustedRequestSourceAddress(c: Context, trust: RequestSourceTrust): string {
  const bindings = c.env as ApiRequestBindings | undefined;
  const peer =
    normalizedAddress(bindings?.[TRANSPORT_PEER_ADDRESS_BINDING]) ?? UNKNOWN_REQUEST_SOURCE_ADDRESS;
  const trustedProxyHops = trust.apiTrustedProxyHops;
  if (
    !Number.isInteger(trustedProxyHops) ||
    trustedProxyHops <= 0 ||
    peer === UNKNOWN_REQUEST_SOURCE_ADDRESS ||
    !peerIsTrustedProxy(peer, trust.apiTrustedProxyCidrs)
  ) {
    return peer;
  }
  const header = c.req.header("x-forwarded-for");
  if (!header) return peer;
  // Entries are never filtered: dropping a malformed value would shift the
  // server-side position and could promote a caller-prepended value.
  const forwarded = header.split(",");
  const sourceIndex = forwarded.length - trustedProxyHops;
  if (sourceIndex < 0) return peer;
  return normalizedAddress(forwarded[sourceIndex]) ?? peer;
}

/**
 * Rate-limit key for a trusted source address. An IPv6 address keys on its
 * /64, the block one subscriber normally holds and the granularity Better
 * Auth applies to the same stamped address, so rotating addresses inside one
 * /64 cannot mint fresh buckets. An IPv4-mapped IPv6 address (how a
 * dual-stack listener reports an IPv4 peer) keys on the embedded IPv4 address
 * instead of collapsing every IPv4 client into one /64. Anything else,
 * including {@link UNKNOWN_REQUEST_SOURCE_ADDRESS}, is returned unchanged.
 */
export function requestSourceRateLimitKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6]!;
    const low = groups[7]!;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** {@link trustedRequestSourceAddress} as an application rate-limit key. */
export function trustedRequestSourceRateLimitKey(c: Context, trust: RequestSourceTrust): string {
  return requestSourceRateLimitKey(trustedRequestSourceAddress(c, trust));
}

/**
 * Replace any caller-supplied {@link TRUSTED_CLIENT_ADDRESS_HEADER}. When
 * `stamp` is true the header is set to the trusted source address, so every
 * Better Auth request derived from this request (direct handler calls,
 * isolated provider requests, and `auth.api.*` calls built from its headers)
 * keys rate limits and session records on the real client.
 */
export function replaceTrustedClientAddressHeader(
  c: Context,
  trust: RequestSourceTrust,
  stamp: boolean,
): void {
  const headers = c.req.raw.headers;
  headers.delete(TRUSTED_CLIENT_ADDRESS_HEADER);
  if (!stamp) return;
  const address = trustedRequestSourceAddress(c, trust);
  if (address !== UNKNOWN_REQUEST_SOURCE_ADDRESS) {
    headers.set(TRUSTED_CLIENT_ADDRESS_HEADER, address);
  }
}

const trustedProxyRanges = new Map<string, BlockList | null>();

function peerIsTrustedProxy(peer: string, cidrs: string): boolean {
  let ranges = trustedProxyRanges.get(cidrs);
  if (ranges === undefined) {
    // Settings validation already rejected malformed entries at boot.
    const entries = trustedProxyCidrEntries(cidrs);
    ranges = entries.length === 0 ? null : new BlockList();
    for (const entry of entries) ranges?.addSubnet(entry.address, entry.prefix, entry.family);
    trustedProxyRanges.set(cidrs, ranges);
  }
  if (!ranges) return true;
  return ranges.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4");
}

/**
 * Canonical IP text, or null. Accepts the `ipv4:port` and `[ipv6]:port` forms
 * some load balancers write into X-Forwarded-For, and drops IPv6 zone ids.
 */
function normalizedAddress(value: string | null | undefined): string | null {
  let candidate = value?.trim();
  if (!candidate || candidate.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/u.exec(candidate);
  if (bracketed) {
    candidate = bracketed[1]!;
  } else {
    const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u.exec(candidate);
    if (ipv4WithPort) candidate = ipv4WithPort[1]!;
  }
  const zone = candidate.indexOf("%");
  if (zone >= 0) candidate = candidate.slice(0, zone);
  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return candidate.toLowerCase();
  return null;
}

/** The eight 16-bit groups of a valid IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    const octets = last.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest, ...tail];
  if (groups.length !== 8) return null;
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups;
}
