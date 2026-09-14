import type { Session, UpdateSessionToolPolicyRequest } from "@opengeni/sdk";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import type { McpServerOption } from "@/lib/session-tools";
import { connectionHealth } from "@/lib/capabilities";
import { capabilityLogoSource } from "@/components/capabilities/capability-logo-source";

/** Catalog identity, never a display-name match, joins selection to connection health. */
export function composerConnectorOptions(
  servers: readonly McpServerOption[],
  items: readonly CapabilityCatalogItem[],
  connections: ConnectionMetadata[] | null,
  assetUrl: (path: string | null) => string | null,
): McpServerOption[] {
  const byId = new Map(servers.map((server) => [server.id, server]));
  for (const item of items) {
    const id = item.runtime.mcpServerId;
    if (item.kind !== "mcp" || !item.enabled || !id) continue;
    const health = connectionHealth(item, connections ?? [], connections !== null);
    const state =
      health.state === "attention"
        ? "reconnect"
        : health.state === "unverified"
          ? "unknown"
          : !item.runtime.available || item.lifecycle.readiness === "unavailable"
            ? "unavailable"
            : "ready";
    const connection =
      health.state === "connected" || health.state === "attention" ? health.connection : null;
    byId.set(id, {
      id,
      name: item.name,
      logoSrc: capabilityLogoSource(item, assetUrl),
      connectionStatus: state,
      ...(connection
        ? { detail: connection.subjectId ? "Personal account" : "Workspace connection" }
        : {}),
    });
  }
  return [...byId.values()];
}

/** Only actual toggle changes alter exclusions; unavailable connections retain their choice. */
export function changedConnectorExclusions(
  previous: Iterable<string>,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): string[] {
  const next = new Set(previous);
  for (const id of before) if (!after.has(id)) next.add(id);
  for (const id of after) if (!before.has(id)) next.delete(id);
  return [...next].sort();
}

/** Reproject live defaults without turning a reconnect into a new user selection. */
export function defaultConnectorSelection(
  defaultIds: Iterable<string>,
  excludedIds: Iterable<string>,
): Set<string> {
  const excluded = new Set(excludedIds);
  return new Set([...defaultIds].filter((id) => !excluded.has(id)));
}

/** A newly enabled connector outside defaults is an explicit session override. */
export function addsConnectorOutsideDefaults(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  defaultIds: Iterable<string>,
): boolean {
  const defaults = new Set(defaultIds);
  return [...after].some((id) => !before.has(id) && !defaults.has(id));
}

/** Connector switches change only connectors, preserving hidden refs and builtin choices. */
export function connectorSelectionUpdate(
  session: Pick<Session, "tools" | "toolPolicy" | "toolPolicyVersion" | "firstPartyMcpTools">,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  workspaceDefaultIds: Iterable<string>,
): UpdateSessionToolPolicyRequest {
  if (
    session.toolPolicy.mode === "workspace_default" &&
    !addsConnectorOutsideDefaults(before, after, workspaceDefaultIds)
  ) {
    return {
      mode: "workspace_default",
      excludedMcpServerIds: changedConnectorExclusions(
        session.toolPolicy.excludedMcpServerIds ?? [],
        before,
        after,
      ),
      expectedVersion: session.toolPolicyVersion,
    };
  }
  const removed = new Set([...before].filter((id) => !after.has(id)));
  const excluded = new Set(
    session.toolPolicy.mode === "workspace_default" ? session.toolPolicy.excludedMcpServerIds : [],
  );
  const tools = session.tools.filter(
    (tool) =>
      tool.id !== "opengeni" &&
      !removed.has(tool.id) &&
      (!excluded.has(tool.id) || after.has(tool.id)),
  );
  const persistedIds = new Set(tools.map((tool) => tool.id));
  for (const id of after) {
    if (!persistedIds.has(id)) tools.push({ kind: "mcp", id });
  }
  return {
    mode: "explicit",
    tools,
    firstPartyMcpTools: [...session.firstPartyMcpTools],
    expectedVersion: session.toolPolicyVersion,
  };
}
