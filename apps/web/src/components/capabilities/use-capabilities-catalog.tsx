import { useRef, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { isWorkspacePermissionDenied } from "@/lib/permissions";
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
  connectionsAccessDenied: boolean;
  /** Merge one freshly returned connection row into the loaded list. */
  replaceConnection: (connection: ConnectionMetadata) => void;
  /** Fetch connection rows independently of the catalog (also used on OAuth return). */
  fetchConnections: () => Promise<ConnectionMetadata[] | null>;
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
  const [connectionDenialScope, setConnectionDenialScope] = useState<{
    client: typeof client;
    workspaceId: string;
  } | null>(null);
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
  const refreshRevision = useRef(0);
  const connectionRevision = useRef(0);
  const successfulConnectionRevision = useRef(0);
  const deniedConnectionRevision = useRef(0);
  const isCurrentScope = () =>
    scopeRef.current.client === client && scopeRef.current.workspaceId === workspaceId;

  async function fetchConnections(): Promise<ConnectionMetadata[] | null> {
    const request = ++connectionRevision.current;
    const live = () => isCurrentScope();
    try {
      const loaded = await client.listConnections(workspaceId);
      // A later successful read restores access; an earlier success cannot undo
      // a confirmed denial, even if it settles after that denial.
      if (
        live() &&
        request > deniedConnectionRevision.current &&
        request > successfulConnectionRevision.current
      ) {
        successfulConnectionRevision.current = request;
        setConnections(loaded);
        setConnectionsLoadFailed(false);
        setConnectionDenialScope(null);
      }
      return live() && request > deniedConnectionRevision.current ? loaded : null;
    } catch (error) {
      const denied = isWorkspacePermissionDenied(error);
      if (
        live() &&
        denied &&
        request > successfulConnectionRevision.current &&
        request > deniedConnectionRevision.current
      ) {
        deniedConnectionRevision.current = request;
        setConnections(null);
        setConnectionsLoadFailed(true);
        setConnectionDenialScope({ client, workspaceId });
      } else if (
        live() &&
        !denied &&
        request === connectionRevision.current &&
        deniedConnectionRevision.current <= successfulConnectionRevision.current
      ) {
        // Transient errors retain cached rows and any confirmed denial.
        setConnectionsLoadFailed(true);
      }
      return null;
    }
  }

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    const request = ++refreshRevision.current;
    const live = () => isCurrentScope() && refreshRevision.current === request;
    setLoading(true);
    try {
      const [catalog, , socials, slackBindings, apiDefinitions, apiInstances] = await Promise.all([
        client.listCapabilities(workspaceId),
        // Settles access independently even when the catalog request rejects.
        fetchConnections(),
        client.listSocialConnections(workspaceId).catch(() => null),
        client.listSlackInstallationBindings(workspaceId).catch(() => null),
        client.listIntegrationDefinitions(workspaceId).catch(() => null),
        client.listApiIntegrations(workspaceId).catch(() => null),
      ]);
      if (!live()) return;
      setItems(catalog.items);
      if (socials !== null) setSocialConnections(socials);
      if (slackBindings !== null) setSlackInstallationBindings(slackBindings);
      if (apiDefinitions !== null) setApiIntegrationDefinitions(apiDefinitions.definitions);
      if (apiInstances !== null) setApiIntegrationInstances(apiInstances.integrations);
      setLoadError(null);
      setRevision((current) => current + 1);
    } catch (error) {
      if (!live()) return;
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load plugins", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (live()) setLoading(false);
    }
  }

  return {
    items,
    setItems,
    connections,
    connectionsLoadFailed,
    connectionsAccessDenied:
      connectionDenialScope?.client === client && connectionDenialScope.workspaceId === workspaceId,
    replaceConnection: (updated) =>
      setConnections((current) =>
        current
          ? current.some((entry) => entry.id === updated.id)
            ? current.map((entry) => (entry.id === updated.id ? updated : entry))
            : [...current, updated]
          : [updated],
      ),
    fetchConnections,
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
