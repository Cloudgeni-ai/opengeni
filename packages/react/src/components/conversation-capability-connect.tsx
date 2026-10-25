import { integrationDefinitionIdFromCapabilityId } from "@opengeni/contracts";
import {
  PERSONAL_INTEGRATION_SETUP_PERMISSION,
  personalIntegrationSetupAccess,
} from "@opengeni/contracts/personal-integration-setup";
import type { AccessContext, CapabilityCatalogItem, Permission } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import type { AuthNeededItem } from "../timeline";

/** What the conversation reads to decide whether this person can connect in the chat. */
export type InChatConnectSource = {
  getAccessContext: () => Promise<AccessContext>;
  listCapabilities: (workspaceId: string) => Promise<{ items: CapabilityCatalogItem[] }>;
};

export type InChatConnectSupport =
  | { status: "idle" | "loading" | "failed" }
  | {
      status: "ready";
      permissions: ReadonlySet<Permission>;
      permissionMode?: "legacy" | "explicit" | undefined;
      catalog: ReadonlyMap<string, CapabilityCatalogItem>;
    };

export type InChatConnectDecision =
  /**
   * The shared connect card: sign in, enable, add to this chat, continue.
   * `personalOnly`: the person can connect only their own account.
   */
  | { kind: "card"; item: CapabilityCatalogItem; personalOnly: boolean }
  /**
   * A deployment's reviewed integration (Outlook Mail, OneDrive, ...): the
   * person signs in with their own account, which installs its reviewed tools
   * for that account alone, adds them to this chat and continues.
   */
  | { kind: "integration"; capabilityId: string; name: string }
  /** An agent's card this person cannot act on here. */
  | { kind: "unavailable" }
  /** Not an in-chat connection: the default recovery row decides. */
  | { kind: "default" };

const UNAVAILABLE_REASONS = new Set([
  "personal_authority_unavailable",
  "unsupported_auth",
  "resource_scope_unavailable",
]);

/** Cards that finish through their own flows, never the shared connect card. */
const OWN_FLOW_CAPABILITY_IDS = new Set([
  "api:connected-machine",
  "api:github-app",
  "mcp:codex_apps",
]);

/** Whether an auth notice is an agent's request to set up a capability in this chat. */
export function isAgentCapabilityRequest(item: AuthNeededItem): boolean {
  return (
    item.capability !== undefined &&
    item.capability !== null &&
    !item.setupRequest &&
    item.authoritySource !== "host" &&
    !(item.reason && UNAVAILABLE_REASONS.has(item.reason)) &&
    !OWN_FLOW_CAPABILITY_IDS.has(item.capability.id)
  );
}

/**
 * Decide how a stock conversation shows an agent's capability card. The
 * shared card handles OAuth MCP capabilities; it is offered only when this
 * person's own grant can finish every step it takes and the session proxy
 * lets the browser set chat tools: add it to this chat (`sessions:control`),
 * and either use the workspace's shared account (`connections:read`) or
 * connect an account as {@link personalIntegrationSetupAccess} allows (with
 * only `connections:personal`, their own account, enabling a reviewed OAuth
 * integration for personal accounts if it is not on yet). Anything else keeps
 * the default row. Host-managed connections (`authoritySource: "host"`)
 * never come here.
 */
export function inChatConnectDecision(
  item: AuthNeededItem,
  support: InChatConnectSupport,
  chatConnections: boolean,
): InChatConnectDecision {
  if (!chatConnections || !isAgentCapabilityRequest(item)) return { kind: "default" };
  if (support.status !== "ready") return { kind: "default" };
  const requested = item.capability!;
  const permissions = [...support.permissions];
  const grant = { permissions, permissionMode: support.permissionMode };
  const can = (permission: Permission) =>
    permissions.includes(permission) ||
    (support.permissionMode !== "explicit" && permissions.includes("workspace:admin"));
  if (integrationDefinitionIdFromCapabilityId(requested.id)) {
    // Connecting your own account is the whole step: the integration's tools
    // are installed for that account only, never for the workspace, so the
    // personal setup permission (included in connections:write) is enough.
    return can("sessions:control") &&
      (can(PERSONAL_INTEGRATION_SETUP_PERMISSION) || can("connections:write"))
      ? { kind: "integration", capabilityId: requested.id, name: requested.name }
      : { kind: "unavailable" };
  }
  const capability = support.catalog.get(requested.id);
  if (!capability || capability.kind !== "mcp" || capability.authKind !== "oauth2")
    return { kind: "default" };
  if (!can("sessions:control")) return { kind: "unavailable" };
  const usesSharedAccount =
    capability.enabled &&
    capability.connectionRef !== null &&
    capability.connectionRef !== undefined &&
    capability.connectionRef.subjectScope !== "subject";
  if (usesSharedAccount)
    return can("connections:read")
      ? { kind: "card", item: capability, personalOnly: false }
      : { kind: "unavailable" };
  const access = personalIntegrationSetupAccess(grant, capability);
  return access
    ? { kind: "card", item: capability, personalOnly: access === "personal" }
    : { kind: "unavailable" };
}

/**
 * Read the person's grant and the capability catalog once, and only when the
 * conversation shows an agent's capability card.
 */
export function useInChatConnectSupport(
  client: Partial<InChatConnectSource>,
  workspaceId: string,
  needed: boolean,
): InChatConnectSupport {
  const [loaded, setLoaded] = useState<{
    client: Partial<InChatConnectSource>;
    workspaceId: string;
    support: InChatConnectSupport;
  } | null>(null);
  const requested = useRef<{ client: Partial<InChatConnectSource>; workspaceId: string } | null>(
    null,
  );
  useEffect(() => {
    if (!needed) return;
    if (
      typeof client.getAccessContext !== "function" ||
      typeof client.listCapabilities !== "function"
    )
      return;
    const previous = requested.current;
    if (previous?.client === client && previous.workspaceId === workspaceId) return;
    const request = { client, workspaceId };
    requested.current = request;
    let live = true;
    Promise.all([client.getAccessContext(), client.listCapabilities(workspaceId)]).then(
      ([access, catalog]) => {
        if (!live) return;
        const grant = access.workspaceGrants.find((entry) => entry.workspaceId === workspaceId);
        setLoaded({
          client,
          workspaceId,
          support: {
            status: "ready",
            permissions: new Set(grant?.permissions ?? []),
            permissionMode: grant?.permissionMode,
            catalog: new Map(catalog.items.map((entry) => [entry.id, entry])),
          },
        });
      },
      () => {
        if (live) setLoaded({ client, workspaceId, support: { status: "failed" } });
      },
    );
    return () => {
      live = false;
      if (requested.current === request) requested.current = null;
    };
  }, [client, workspaceId, needed]);
  if (loaded?.client === client && loaded.workspaceId === workspaceId) return loaded.support;
  return { status: needed ? "loading" : "idle" };
}
