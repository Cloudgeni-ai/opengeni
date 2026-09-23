import type { Context } from "hono";
import { isIP } from "node:net";

const TRANSPORT_PEER_ADDRESS_BINDING = "opengeniTransportPeerAddress";

type ApiRequestBindings = {
  [TRANSPORT_PEER_ADDRESS_BINDING]?: string | null;
};

export function apiRequestBindingsForTransportPeer(
  address: string | null | undefined,
): ApiRequestBindings {
  return { [TRANSPORT_PEER_ADDRESS_BINDING]: address ?? null };
}

/**
 * Resolve a quota/audit source from the server-owned transport peer. Forwarded
 * values are considered only when the operator declares an exact trusted proxy
 * hop count; the chain is then walked from the server side so caller-prepended
 * values cannot replace the address inserted by the trusted edge.
 */
export function trustedRequestSourceAddress(c: Context, trustedProxyHops: number): string {
  const bindings = c.env as ApiRequestBindings | undefined;
  const peer = normalizedAddress(bindings?.[TRANSPORT_PEER_ADDRESS_BINDING]) ?? "unknown";
  if (!Number.isInteger(trustedProxyHops) || trustedProxyHops <= 0 || peer === "unknown") {
    return peer;
  }

  const header = c.req.header("x-forwarded-for");
  if (!header) return peer;

  // Do not filter malformed entries: removing one shifts the trusted-side
  // position and could promote a caller-prepended value into the source slot.
  const forwarded = header.split(",").map((value) => normalizedAddress(value));
  if (forwarded.some((value) => value === null)) return peer;

  const sourceIndex = forwarded.length - trustedProxyHops;
  return sourceIndex >= 0 ? (forwarded[sourceIndex] ?? peer) : peer;
}

function normalizedAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && isIP(normalized) !== 0 ? normalized : null;
}
