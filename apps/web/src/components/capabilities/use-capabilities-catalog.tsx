import { useRef, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import type {
  ApiIntegrationInstallationSummary,
  CapabilityCatalogItem,
  ConnectionMetadata,
  IntegrationDefinitionSummary,
  SlackInstallationBinding,
  SocialConnection,
} from "@/types";

export type CapabilitiesCatalog = {
  items: CapabilityCatalogItem[];
  setItems: (items: CapabilityCatalogItem[]) => void;
  /**
   * null = connections have not loaded (or the load failed, e.g. the grant lacks
   * connections:read); an array = loaded, even when empty. Health must not treat a
   * failed load as "every connection was deleted".
   */
  connections: ConnectionMetadata[] | null;
  /**
   * True when the last connections fetch failed. Combined with a still-null
   * `connections`, the integration adapters surface a visible failure with a
   * retry instead of pinning their tiles at Loading forever.
   */
  connectionsLoadFailed: boolean;
  /** Merge one freshly returned connection row into the loaded list. */
  replaceConnection: (connection: ConnectionMetadata) => void;
  /** Adopt a fresh connection list from a targeted fetch (an OAuth return). */
  adoptConnections: (connections: ConnectionMetadata[]) => void;
  /**
   * The curated multi-account ApiIntegration catalog (Outlook Mail/Calendar/
   * Contacts, OneDrive, extra Drive accounts).
   */
  apiIntegrationDefinitions: IntegrationDefinitionSummary[];
  /** Every installed instance of it, curated and custom alike. */
  apiIntegrationInstances: ApiIntegrationInstallationSummary[];
  socialConnections: SocialConnection[];
  slackInstallationBindings: SlackInstallationBinding[];
  loading: boolean;
  loadError: Error | null;
  /** Bumped after every accepted load, so per-instance surfaces can reload themselves. */
  revision: number;
  refresh: () => Promise<void>;
};

/**
 * The Capabilities page's whole workspace-scoped data load.
 *
 * Every response is fenced on the exact client + workspace it was requested
 * for. Switching workspaces mid-flight must never populate the new workspace's
 * catalog, connections, integration definitions, or installed instances with
 * the previous workspace's rows - the late response is dropped entirely, and
 * it can no longer clear the new workspace's loading state or raise its error.
 */
export function useCapabilitiesCatalog(workspaceId: string): CapabilitiesCatalog {
  const context = useAppContext();
  const client = context.client;

  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [connections, setConnections] = useState<ConnectionMetadata[] | null>(null);
  const [connectionsLoadFailed, setConnectionsLoadFailed] = useState(false);
  const [apiIntegrationDefinitions, setApiIntegrationDefinitions] = useState<
    IntegrationDefinitionSummary[]
  >([]);
  const [apiIntegrationInstances, setApiIntegrationInstances] = useState<
    ApiIntegrationInstallationSummary[]
  >([]);
  const [socialConnections, setSocialConnections] = useState<SocialConnection[]>([]);
  const [slackInstallationBindings, setSlackInstallationBindings] = useState<
    SlackInstallationBinding[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);

  const scopeRef = useRef({ client, workspaceId });
  scopeRef.current = { client, workspaceId };

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    const scope = { client, workspaceId };
    const isCurrentScope = () =>
      scopeRef.current.client === scope.client &&
      scopeRef.current.workspaceId === scope.workspaceId;
    setLoading(true);
    try {
      const [catalog, conns, socials, slackBindings, apiDefinitions, apiInstances] =
        await Promise.all([
          client.listCapabilities(workspaceId),
          // null (not []) on failure so health can tell "didn't load" from "loaded empty".
          client.listConnections(workspaceId).catch(() => null),
          client.listSocialConnections(workspaceId).catch(() => null),
          client.listSlackInstallationBindings(workspaceId).catch(() => null),
          client.listIntegrationDefinitions(workspaceId).catch(() => null),
          client.listApiIntegrations(workspaceId).catch(() => null),
        ]);
      if (!isCurrentScope()) return;
      setItems(catalog.items);
      // Don't clobber previously-loaded connections with null on a failed refetch
      // (that would flip healthy items to "unverified" until the next reload); a
      // first-load failure leaves the prior null = "not loaded", which is correct.
      // The failure itself is tracked so the integrations can say so and retry.
      if (conns !== null) setConnections(conns);
      setConnectionsLoadFailed(conns === null);
      if (socials !== null) setSocialConnections(socials);
      if (slackBindings !== null) setSlackInstallationBindings(slackBindings);
      if (apiDefinitions !== null) setApiIntegrationDefinitions(apiDefinitions.definitions);
      if (apiInstances !== null) setApiIntegrationInstances(apiInstances.integrations);
      setLoadError(null);
      setRevision((current) => current + 1);
    } catch (error) {
      if (!isCurrentScope()) return;
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load capabilities", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (isCurrentScope()) setLoading(false);
    }
  }

  return {
    items,
    setItems,
    connections,
    connectionsLoadFailed,
    replaceConnection: (updated) =>
      setConnections((current) =>
        current
          ? current.some((entry) => entry.id === updated.id)
            ? current.map((entry) => (entry.id === updated.id ? updated : entry))
            : [...current, updated]
          : [updated],
      ),
    adoptConnections: (next) => {
      setConnections(next);
      setConnectionsLoadFailed(false);
    },
    apiIntegrationDefinitions,
    apiIntegrationInstances,
    socialConnections,
    slackInstallationBindings,
    loading,
    loadError,
    revision,
    refresh,
  };
}
