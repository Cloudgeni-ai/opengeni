import type { Context } from "hono";

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
  if (trustedProxyHops <= 0 || peer === "unknown") return peer;

  const forwarded = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map(normalizedAddress)
    .filter((value): value is string => value !== null);
  const sourceIndex = forwarded.length - trustedProxyHops;
  return sourceIndex >= 0 ? forwarded[sourceIndex]! : peer;
}

function normalizedAddress(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 128) : null;
}
