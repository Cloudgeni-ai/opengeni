import {
  HostMcpCreateSelections as selections,
  type HostMcpCreateSelection,
} from "@opengeni/contracts/host-mcp-bindings";
export type { HostMcpCreateSelection } from "@opengeni/contracts/host-mcp-bindings";
const key = "_opengeni_session_create_host_delegations_v1";

/** Replay identity only: neither grant admission nor credential authority. */
export function normalizeHostCreateSelection(value: unknown): HostMcpCreateSelection[] {
  return selections
    .parse(value ?? [])
    .sort((a, b) => (a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0));
}
export function metadataWithHostCreateSelection(
  metadata: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next[key];
  const canonical = normalizeHostCreateSelection(value);
  if (canonical.length) next[key] = canonical;
  return next;
}
export function hostCreateSelectionFromMetadata(
  metadata: Record<string, unknown>,
): HostMcpCreateSelection[] {
  // A malformed stored identity fails closed; it must not become an empty grant.
  return normalizeHostCreateSelection(metadata[key]);
}
