import { useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { toast } from "sonner";

import { useAppContext } from "@/context";
import { hasWorkspacePermission, isWorkspacePermissionDenied } from "@/lib/permissions";
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

type CatalogState = {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  epoch: number;
  items: CapabilityCatalogItem[];
  connections: ConnectionMetadata[] | null;
  connectionsLoadFailed: boolean;
  connectionsAccessDenied: boolean;
  apiIntegrationDefinitions: IntegrationDefinitionSummary[];
  apiIntegrationInstances: ApiIntegrationInstallationSummary[];
  socialConnections: SocialConnection[];
  slackInstallationBindings: SlackInstallationBinding[];
  loading: boolean;
  loadError: Error | null;
  revision: number;
};

type ConnectionReadAccess = boolean | null;

function emptyCatalogState(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  epoch: number,
  readAccess: ConnectionReadAccess,
): CatalogState {
  return {
    client,
    workspaceId,
    epoch,
    items: [],
    connections: null,
    connectionsLoadFailed: readAccess === false,
    connectionsAccessDenied: readAccess === false,
    apiIntegrationDefinitions: [],
    apiIntegrationInstances: [],
    socialConnections: [],
    slackInstallationBindings: [],
    loading: true,
    loadError: null,
    revision: 0,
  };
}

/**
 * The Capabilities page's whole workspace-scoped data load.
 *
 * Both rendered state and responses are fenced on the exact client + workspace.
 * A new read identity sees no previous rows even before its first request settles;
 * within one identity a transient connection failure still retains cached rows.
 */
export function useCapabilitiesCatalog(workspaceId: string): CapabilitiesCatalog {
  const context = useAppContext();
  const client = context.client;
  // A missing bootstrap context is not a confirmed denial. Neither state may
  // expose rows from the previous grant, but only a known grant can read them.
  const readAccess =
    context.accessContext === null
      ? null
      : hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");

  const scopeRef = useRef({ client, workspaceId, readAccess, epoch: 0 });
  // Distinguish A -> B -> A from uninterrupted A: an old A request or cached
  // row cannot regain authority merely because its client/workspace match again.
  if (
    scopeRef.current.client !== client ||
    scopeRef.current.workspaceId !== workspaceId ||
    scopeRef.current.readAccess !== readAccess
  ) {
    scopeRef.current = { client, workspaceId, readAccess, epoch: scopeRef.current.epoch + 1 };
  }
  const epoch = scopeRef.current.epoch;
  const [state, setState] = useState(() =>
    emptyCatalogState(client, workspaceId, epoch, readAccess),
  );
  const refreshRevision = useRef(0);
  const connectionRevision = useRef(0);
  const successfulConnectionRevision = useRef(0);
  const deniedConnectionRevision = useRef(0);
  const mutationAuthorityEpoch = useRef(0);
  const callbackAuthorityEpoch = mutationAuthorityEpoch.current;
  const isCurrentScope = () => scopeRef.current.epoch === epoch;
  // No effect-time reset: the first render under a different principal must
  // already be safe, and an old request must not clear freshly loaded rows.
  const visible =
    state.client === client && state.workspaceId === workspaceId && state.epoch === epoch
      ? state
      : emptyCatalogState(client, workspaceId, epoch, readAccess);
  const update = (change: (current: CatalogState) => CatalogState) =>
    setState((current) => {
      if (!isCurrentScope()) return current;
      const scoped =
        current.client === client && current.workspaceId === workspaceId && current.epoch === epoch
          ? current
          : emptyCatalogState(client, workspaceId, epoch, readAccess);
      return change(scoped);
    });

  async function fetchConnections(): Promise<ConnectionMetadata[] | null> {
    if (readAccess !== true) return null;
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
        if (deniedConnectionRevision.current > successfulConnectionRevision.current) {
          // Callbacks created while access was denied also predate this recovery.
          mutationAuthorityEpoch.current++;
        }
        successfulConnectionRevision.current = request;
        update((current) => ({
          ...current,
          connections: loaded,
          connectionsLoadFailed: false,
          connectionsAccessDenied: false,
        }));
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
        // A callback issued before the 403 must remain retired after recovery.
        mutationAuthorityEpoch.current++;
        update((current) => ({
          ...current,
          connections: null,
          connectionsLoadFailed: true,
          connectionsAccessDenied: true,
        }));
      } else if (
        live() &&
        !denied &&
        request === connectionRevision.current &&
        deniedConnectionRevision.current <= successfulConnectionRevision.current
      ) {
        // Transient errors retain cached rows and any confirmed denial.
        update((current) => ({ ...current, connectionsLoadFailed: true }));
      }
      return null;
    }
  }

  async function refresh(): Promise<void> {
    if (!workspaceId) return;
    const request = ++refreshRevision.current;
    const live = () => isCurrentScope() && refreshRevision.current === request;
    update((current) => ({ ...current, loading: true }));
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
      update((current) => ({
        ...current,
        items: catalog.items,
        socialConnections: socials ?? current.socialConnections,
        slackInstallationBindings: slackBindings ?? current.slackInstallationBindings,
        apiIntegrationDefinitions: apiDefinitions?.definitions ?? current.apiIntegrationDefinitions,
        apiIntegrationInstances: apiInstances?.integrations ?? current.apiIntegrationInstances,
        loadError: null,
        revision: current.revision + 1,
      }));
    } catch (error) {
      if (!live()) return;
      update((current) => ({
        ...current,
        loadError: error instanceof Error ? error : new Error(String(error)),
      }));
      toast.error("Failed to load plugins", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (live()) update((current) => ({ ...current, loading: false }));
    }
  }

  return {
    items: visible.items,
    setItems: (items) => update((current) => ({ ...current, items })),
    connections: visible.connections,
    connectionsLoadFailed: visible.connectionsLoadFailed,
    connectionsAccessDenied: visible.connectionsAccessDenied,
    replaceConnection: (updated) =>
      update((current) =>
        callbackAuthorityEpoch !== mutationAuthorityEpoch.current || current.connectionsAccessDenied
          ? current // An in-flight update is not a new successful list read.
          : {
              ...current,
              connections: current.connections
                ? current.connections.some((entry) => entry.id === updated.id)
                  ? current.connections.map((entry) => (entry.id === updated.id ? updated : entry))
                  : [...current.connections, updated]
                : [updated],
            },
      ),
    fetchConnections,
    apiIntegrationDefinitions: visible.apiIntegrationDefinitions,
    apiIntegrationInstances: visible.apiIntegrationInstances,
    socialConnections: visible.socialConnections,
    slackInstallationBindings: visible.slackInstallationBindings,
    loading: visible.loading,
    loadError: visible.loadError,
    revision: visible.revision,
    refresh,
  };
}
