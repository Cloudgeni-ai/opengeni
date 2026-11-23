import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast";
import {
  ComposerMobilePlus,
  type ComposerPlusPanel,
  type ComposerPlusProps,
} from "./composer-mobile-plus";
import { useAppContext } from "../app-context";
import { userErrorText } from "../../ui/api-error";
import { hasWorkspacePermission, isWorkspacePermissionDenied } from "../lib/permissions";
import type { CapabilityCatalogItem, ConnectionMetadata } from "../types";
import { composerConnectorOptions } from "../lib/composer-connectors";
import {
  capabilityReconnectPlan,
  connectionHealth,
  loadConnectionHealthAccounts,
} from "../lib/capabilities";
import { startMcpOAuthWithTimeout } from "../lib/mcp-oauth";
import { usePage } from "../lib/navigation";
import type { McpServerOption } from "../lib/session-tools";

type ConnectorCatalog = {
  items: CapabilityCatalogItem[];
  connections: ConnectionMetadata[] | null;
};

/**
 * The last connectors and connection statuses per caller and workspace. A
 * composer that mounts again (a new chat, another session) opens + > Connectors
 * with these rows at once and refreshes them in place, instead of loading
 * inside the menu.
 */
const connectorCatalogCache = new WeakMap<object, Map<string, ConnectorCatalog>>();

function cachedConnectorCatalog(client: object, workspaceId: string) {
  return connectorCatalogCache.get(client)?.get(workspaceId) ?? null;
}

function cacheConnectorCatalog(
  client: object,
  workspaceId: string,
  value: ConnectorCatalog | null,
) {
  let byWorkspace = connectorCatalogCache.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    connectorCatalogCache.set(client, byWorkspace);
  }
  if (value) byWorkspace.set(workspaceId, value);
  else byWorkspace.delete(workspaceId);
}

/**
 * A connector seen needing reconnecting, kept until it is reconnected or the
 * person turns it off for the chat. Its row otherwise drops the marker
 * whenever the composer has no current read (a reload after a sign-in or
 * grant refresh shows rows without status) and, in a Personal workspace,
 * when the catalog stops carrying a connector from another workspace whose
 * account stopped working, so the row vanishes moments after it appeared.
 */
type NeedsReconnect = {
  server: McpServerOption;
  item: CapabilityCatalogItem;
  connections: ConnectionMetadata[];
};
const needsReconnectCache = new WeakMap<object, Map<string, Map<string, NeedsReconnect>>>();

function needsReconnectFor(client: object, workspaceId: string): Map<string, NeedsReconnect> {
  let byWorkspace = needsReconnectCache.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    needsReconnectCache.set(client, byWorkspace);
  }
  let marked = byWorkspace.get(workspaceId);
  if (!marked) {
    marked = new Map();
    byWorkspace.set(workspaceId, marked);
  }
  return marked;
}

/**
 * Rows with every connector still needing reconnecting marked so. A fresh
 * read clears a mark only when it shows the connector working again, or its
 * account active again or gone; an unchanged or missing answer keeps it.
 */
export function keepReconnectMarkers(
  rows: McpServerOption[],
  marked: Map<string, NeedsReconnect>,
  current: ConnectorCatalog | null,
): McpServerOption[] {
  for (const row of rows) {
    if (row.connectionStatus !== "reconnect" || !current) continue;
    const item = current.items.find((candidate) => candidate.runtime.mcpServerId === row.id);
    const account = item ? connectionHealth(item, current.connections ?? [], true) : null;
    if (item && account?.state === "attention" && account.connection)
      marked.set(row.id, { server: row, item, connections: [account.connection] });
  }
  if (current?.connections) {
    for (const [serverId, mark] of marked) {
      const row = rows.find((candidate) => candidate.id === serverId);
      const listed = current.items.some((item) => item.runtime.mcpServerId === serverId);
      if (
        listed &&
        row &&
        row.connectionStatus !== "reconnect" &&
        row.connectionStatus !== "unknown"
      ) {
        marked.delete(serverId);
        continue;
      }
      if (!listed) {
        const ids = new Set(mark.connections.map((connection) => connection.id));
        const accounts = current.connections.filter((connection) => ids.has(connection.id));
        const stillBroken = accounts.some(
          (connection) => connection.status === "needs_reauth" || connection.status === "error",
        );
        if (!stillBroken) marked.delete(serverId);
      }
    }
  }
  if (marked.size === 0) return rows;
  const next = rows.map((row) =>
    marked.has(row.id) && row.connectionStatus !== "reconnect"
      ? { ...marked.get(row.id)!.server, ...row, connectionStatus: "reconnect" as const }
      : row,
  );
  for (const [serverId, mark] of marked) {
    if (!next.some((row) => row.id === serverId)) next.push(mark.server);
  }
  return next;
}

export function WorkspaceComposerPlus(
  props: ComposerPlusProps & {
    workspaceId: string;
    openRequest?: { panel: ComposerPlusPanel; nonce: number } | undefined;
  },
) {
  const page = usePage();
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
    /** Set once this composer has seen another caller or grant: no cache then. */
    identityChanged: false,
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
    lifecycle.identityChanged = true;
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
      : // Only a freshly mounted composer reuses the cache; a caller or grant
        // change inside one stays masked until its own read returns.
        canReadConnections === true && !lifecycle.identityChanged
        ? cachedConnectorCatalog(client, workspaceId)
        : null;
  const deniedMessage =
    "Your workspace access doesn't allow connection discovery. Ask a workspace admin for connection access.";
  // Marks belong to this caller and workspace; losing connection access drops them.
  if (canReadConnections === false) needsReconnectCache.get(client)?.delete(workspaceId);
  const marked = canReadConnections === true ? needsReconnectFor(client, workspaceId) : null;
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
          ? // Health reads the account inventory the tool runtime resolves.
            loadConnectionHealthAccounts(client, workspaceId).then(
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
          cacheConnectorCatalog(client, workspaceId, null);
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
      setCatalog((previous) => {
        const next = {
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
        };
        cacheConnectorCatalog(
          client,
          workspaceId,
          accessDenied || canReadConnections !== true
            ? null
            : { items: next.items, connections: next.connections },
        );
        return next;
      });
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
            : `Couldn't load connectors. ${userErrorText(failure, "Try again.")}`,
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
    const params = page.readQuery();
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
      "capability",
      "stage",
      "reason",
    ])
      params.delete(key);
    page.replaceQuery(params, { keepHistoryState: true });
    if (outcome === "success") {
      void refreshRuntime.current(workspaceId);
      void reload();
      toast.success("Authorization completed. Connection status is being refreshed.");
    } else {
      // The failure copy loads only on this path, keeping it out of the session route.
      void import("../lib/oauth-callback-messages").then(({ mcpOAuthCallbackFailureMessage }) => {
        const message = mcpOAuthCallbackFailureMessage(stage, reason);
        setError(message);
        toast.error(message);
      });
    }
  }, [page, reload, workspaceId]);
  const manage = (serverId: string) => {
    const item = current?.items.find((candidate) => candidate.runtime.mcpServerId === serverId);
    page.assign(
      `/workspaces/${encodeURIComponent(workspaceId)}/plugins${item ? `?suggested_capability=${encodeURIComponent(item.id)}` : ""}`,
    );
  };
  const reconnect = async (serverId: string) => {
    const generation = lifecycle.generation;
    const deniedRevision = lifecycle.deniedConnectionsRevision;
    const listed = current?.items.find((candidate) => candidate.runtime.mcpServerId === serverId);
    // A connector the catalog stopped listing (its account stopped working)
    // reconnects through the account it was seen with.
    const mark = listed ? undefined : marked?.get(serverId);
    const item = listed ?? mark?.item;
    const health = listed
      ? connectionHealth(listed, current?.connections ?? [], current?.connections !== null)
      : mark
        ? connectionHealth(mark.item, mark.connections, true)
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
      const returnUrl = new URL(page.href());
      returnUrl.searchParams.set("composer_connector", item.id);
      // A personal account can come from another workspace, which owns its row.
      const response = await startMcpOAuthWithTimeout(
        client,
        plan.connectionWorkspaceId ?? workspaceId,
        {
          connectionId,
          ownership: plan.ownership,
          ...((item.mcpUrl ?? item.endpointUrl)
            ? { mcpUrl: (item.mcpUrl ?? item.endpointUrl)! }
            : {}),
          ...(item.connectionRef?.providerDomain
            ? { providerDomain: item.connectionRef.providerDomain }
            : {}),
          returnPath: returnUrl.pathname + returnUrl.search,
        },
      );
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
      page.assign(response.authorizationUrl);
    } catch (failure) {
      if (
        scope.current.client === client &&
        scope.current.workspaceId === workspaceId &&
        scope.current.canReadConnections === true &&
        lifecycle.generation === generation
      )
        setError(`Couldn't reconnect. ${userErrorText(failure, "Try again.")}`);
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
  const rows = composerConnectorOptions(
    current
      ? props.servers
      : props.servers.map(({ connectionStatus, detail: _detail, ...server }) => ({
          ...server,
          ...(connectionStatus ? { connectionStatus: "unknown" as const } : {}),
        })),
    current?.items ?? [],
    current?.connections ?? null,
    (path) => client.catalogAssetUrl(path),
  );
  return (
    <ComposerMobilePlus
      {...props}
      servers={marked ? keepReconnectMarkers(rows, marked, current) : rows}
      onToolSelectionChange={(selection) => {
        // Turned off for this chat: the person has dealt with it.
        for (const serverId of marked?.keys() ?? []) {
          if (props.selection.mcpServerIds.has(serverId) && !selection.mcpServerIds.has(serverId))
            marked?.delete(serverId);
        }
        props.onToolSelectionChange(selection);
      }}
      connectorActions={{
        ...props.connectorActions,
        onReconnect: (id) => void reconnect(id),
        // Rows already on screen refresh in place; only a first load shows rows loading.
        loading: loading && !current,
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
