import type { AuthNeededItem } from "./timeline/types";
import type { CapabilityCatalogItem } from "@opengeni/sdk";

/** Recovery events identify runtime servers/connections, while recommendation
 * events already carry a catalog id. Never guess among same-domain accounts. */
export function sessionAuthRecommendation(
  item: AuthNeededItem,
  catalog: CapabilityCatalogItem[],
): AuthNeededItem | undefined {
  if (
    item.authoritySource === "host" ||
    item.reason === "unsupported_auth" ||
    item.reason === "resource_scope_unavailable"
  )
    return undefined;
  if (item.capability) return item;
  const recoveryServerId = item.canonicalServerId ?? item.serverId;
  const matches = catalog.filter(
    (candidate) =>
      (recoveryServerId !== null &&
        candidate.runtime.mcpServerId === recoveryServerId &&
        recoveryServerId !== "opengeni") ||
      (item.connectionId !== null && candidate.connectionRef?.connectionId === item.connectionId),
  );
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  const personalAccess = item.reason === "personal_authority_unavailable";
  if (
    personalAccess &&
    ((item.connectionSubjectScope ?? entry.connectionRef?.subjectScope) !== "subject" ||
      entry.connectionRef?.authoritySource === "host")
  )
    return undefined;
  return {
    ...item,
    capability: {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      source: entry.source,
      action: "connect",
      rationale: personalAccess
        ? "Review permission to use your personal account in this conversation."
        : "Reconnect this integration to use its tools in this conversation.",
      requiredVariables: [],
    },
  };
}
