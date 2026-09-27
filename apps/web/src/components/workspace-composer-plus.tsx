import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ComposerMobilePlus, type ComposerPlusProps } from "@/components/composer-mobile-plus";
import { useAppContext } from "@/context";
import { hasWorkspacePermission, isWorkspacePermissionDenied } from "@/lib/permissions";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import { composerConnectorOptions } from "@/lib/composer-connectors";
import { capabilityReconnectPlan, connectionHealth } from "@/lib/capabilities";
import { startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";

export function WorkspaceComposerPlus(props: ComposerPlusProps & { workspaceId: string }) {
  const context = useAppContext();
  const { client } = context;
  const { workspaceId } = props;
  const canReadConnections =
    context.accessContext === null
      ? null
      : hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const [catalog, setCatalog] = useState<{
    workspaceId: string;
    client: typeof client;
    epoch: number;
    items: CapabilityCatalogItem[];
    connections: ConnectionMetadata[] | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const lifecycle = useRef({
    revision: 0,
    generation: 0,
    successfulConnectionsRevision: 0,
    deniedConnectionsRevision: 0,
  }).current;
  const scope = useRef({ client, workspaceId, canReadConnections });
  // Fence cached rows on the first render of a new identity, including A -> B -> A.
  // Effect cleanup runs after that render and cannot protect it on its own.
  if (
    scope.current.client !== client ||
    scope.current.workspaceId !== workspaceId ||
    scope.current.canReadConnections !== canReadConnections
  ) {
    lifecycle.generation++;
    lifecycle.successfulConnectionsRevision = 0;
    lifecycle.deniedConnectionsRevision = 0;
    scope.current = { client, workspaceId, canReadConnections };
  }
  const refreshRuntime = useRef(context.refreshWorkspaceMcpServers);
  refreshRuntime.current = context.refreshWorkspaceMcpServers;
  const current =
    catalog?.workspaceId === workspaceId &&
    catalog.client === client &&
    canReadConnections === true &&
    catalog.epoch === lifecycle.generation
      ? catalog
      : null;
  const deniedMessage =
    "Your workspace access doesn't allow connection discovery. Ask a workspace admin for connection access.";
  const reload = useCallback(async () => {
    const request = ++lifecycle.revision;
    const generation = lifecycle.generation;
    const liveScope = () =>
      scope.current.client === client &&
      scope.current.workspaceId === workspaceId &&
      lifecycle.generation === generation;
    const live = () => liveScope() && lifecycle.revision === request;
    setLoading(true);
    let denied = false;
    try {
      const connectionLoad = (
        canReadConnections === true
          ? client.listConnections(workspaceId).then(
              (connections) => ({ connections, denied: false }),
              (failure: unknown) => ({
                connections: null,
                denied: isWorkspacePermissionDenied(failure),
              }),
            )
          : Promise.resolve({ connections: null, denied: canReadConnections === false })
      ).then((result) => {
        if (
          liveScope() &&
          result.denied &&
          request > lifecycle.successfulConnectionsRevision &&
          request > lifecycle.deniedConnectionsRevision
        ) {
          lifecycle.deniedConnectionsRevision = request;
          denied = true;
          // A failed catalog refresh must not leave the prior account rows visible.
          setCatalog((previous) =>
            previous?.client === client &&
            previous.workspaceId === workspaceId &&
            previous.epoch === generation
              ? { ...previous, connections: null }
              : previous,
          );
          setError(deniedMessage);
        } else if (
          liveScope() &&
          result.connections !== null &&
          request > lifecycle.deniedConnectionsRevision &&
          request > lifecycle.successfulConnectionsRevision
        ) {
          lifecycle.successfulConnectionsRevision = request;
          setCatalog((previous) =>
            previous?.client === client &&
            previous.workspaceId === workspaceId &&
            previous.epoch === generation
              ? { ...previous, connections: result.connections }
              : previous,
          );
          setError((previous) => (previous === deniedMessage ? null : previous));
        }
        return result;
      });
      const [result, connectionResult] = await Promise.all([
        client.listCapabilities(workspaceId),
        connectionLoad,
      ]);
      if (!live()) return;
      const accessDenied =
        lifecycle.deniedConnectionsRevision > lifecycle.successfulConnectionsRevision;
      setCatalog((previous) => ({
        client,
        workspaceId,
        epoch: generation,
        items: result.items,
        connections: accessDenied
          ? null
          : (connectionResult.connections ??
            (previous?.client === client &&
            previous.workspaceId === workspaceId &&
            previous.epoch === generation
              ? previous.connections
              : null)),
      }));
      setError(
        accessDenied
          ? deniedMessage
          : canReadConnections === null
            ? null
            : connectionResult.connections === null
              ? "Connection status couldn't be checked. Open Capabilities to check the connection."
              : null,
      );
    } catch (failure) {
      if (live())
        setError(
          denied || lifecycle.deniedConnectionsRevision > lifecycle.successfulConnectionsRevision
            ? deniedMessage
            : failure instanceof Error
              ? failure.message
              : "Couldn't load connectors.",
        );
    } finally {
      if (live()) setLoading(false);
    }
  }, [client, workspaceId, lifecycle, canReadConnections]);
  useEffect(() => {
    setError(null);
    setBusyId(null);
    void reload();
    const onFocus = () => {
      void reload();
      void refreshRuntime.current(workspaceId);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      lifecycle.revision++;
      lifecycle.generation++;
      window.removeEventListener("focus", onFocus);
    };
  }, [reload, workspaceId, lifecycle]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("composer_connector") || !params.has("integration_oauth")) return;
    const outcome = params.get("integration_oauth");
    const stage = params.get("stage");
    const reason = params.get("reason");
    for (const key of [
      "composer_connector",
      "integration_oauth",
      "connectionId",
      "providerDomain",
      "ownership",
      "stage",
      "reason",
    ])
      params.delete(key);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${params.size ? `?${params}` : ""}`,
    );
    if (outcome === "success") {
      void refreshRuntime.current(workspaceId);
      void reload();
      toast.success("Authorization completed. Connection status is being refreshed.");
    } else {
      // The failure copy loads only on this path, keeping it out of the session route.
      void import("@/lib/oauth-callback-messages").then(({ mcpOAuthCallbackFailureMessage }) => {
        const message = mcpOAuthCallbackFailureMessage(stage, reason);
        setError(message);
        toast.error(message);
      });
    }
  }, [reload, workspaceId]);
  const manage = (serverId: string) => {
    const item = current?.items.find((candidate) => candidate.runtime.mcpServerId === serverId);
    window.location.assign(
      `/workspaces/${encodeURIComponent(workspaceId)}/plugins${item ? `?suggested_capability=${encodeURIComponent(item.id)}` : ""}`,
    );
  };
  const reconnect = async (serverId: string) => {
    const generation = lifecycle.generation;
    const deniedRevision = lifecycle.deniedConnectionsRevision;
    const item = current?.items.find((candidate) => candidate.runtime.mcpServerId === serverId);
    const health = item
      ? connectionHealth(item, current?.connections ?? [], current?.connections !== null)
      : null;
    const plan = item && health ? capabilityReconnectPlan(item, health) : null;
    // Reuse a surviving OAuth connection. A missing credential or API key uses
    // the existing settings repair flow so a new account is never silently bound.
    if (!item || plan?.kind !== "oauth" || !plan.connectionId) {
      manage(serverId);
      return;
    }
    const connectionId = plan.connectionId;
    setBusyId(serverId);
    setError(null);
    try {
      const returnUrl = new URL(window.location.href);
      returnUrl.searchParams.set("composer_connector", item.id);
      const response = await startMcpOAuthWithTimeout(client, workspaceId, {
        connectionId,
        ownership: plan.ownership,
        ...((item.mcpUrl ?? item.endpointUrl)
          ? { mcpUrl: (item.mcpUrl ?? item.endpointUrl)! }
          : {}),
        ...(item.connectionRef?.providerDomain
          ? { providerDomain: item.connectionRef.providerDomain }
          : {}),
        returnPath: returnUrl.pathname + returnUrl.search,
      });
      if (
        scope.current.client !== client ||
        scope.current.workspaceId !== workspaceId ||
        scope.current.canReadConnections !== true ||
        lifecycle.generation !== generation ||
        lifecycle.deniedConnectionsRevision !== deniedRevision
      )
        return;
      if (!response.authorizationUrl)
        throw new Error("The provider did not return an authorization link.");
      window.location.assign(response.authorizationUrl);
    } catch (failure) {
      if (
        scope.current.client === client &&
        scope.current.workspaceId === workspaceId &&
        scope.current.canReadConnections === true &&
        lifecycle.generation === generation
      )
        setError(failure instanceof Error ? failure.message : "Couldn't reconnect.");
    } finally {
      if (
        scope.current.client === client &&
        scope.current.workspaceId === workspaceId &&
        scope.current.canReadConnections === true &&
        lifecycle.generation === generation
      )
        setBusyId(null);
    }
  };
  return (
    <ComposerMobilePlus
      {...props}
      servers={composerConnectorOptions(
        current
          ? props.servers
          : props.servers.map(({ connectionStatus, detail: _detail, ...server }) => ({
              ...server,
              ...(connectionStatus ? { connectionStatus: "unknown" as const } : {}),
            })),
        current?.items ?? [],
        current?.connections ?? null,
        (path) => client.catalogAssetUrl(path),
      )}
      connectorActions={{
        ...props.connectorActions,
        onReconnect: (id) => void reconnect(id),
        loading,
        error: canReadConnections === false ? deniedMessage : current ? error : null,
        busyId: current ? busyId : null,
      }}
      onOpenConnectors={() => {
        props.connectorActions?.accountControls?.onRefresh?.();
        props.onOpenConnectors?.();
        void reload();
        void refreshRuntime.current(workspaceId);
      }}
    />
  );
}
