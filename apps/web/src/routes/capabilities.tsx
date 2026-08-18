// Capabilities: the workspace integrations marketplace. A single scrollable
// page with exactly three sections: Integrations, Connectors, and Bundles.
// Integrations (Slack, GitHub, Google
// Drive, Jira and Confluence, Outlook Mail/Calendar/Contacts, OneDrive) are
// built and run by OpenGeni and render through one row and one detail sheet
// each; a provider with several accounts (Outlook, extra Drive accounts)
// still gets exactly one row, with every account listed in its sheet's
// Connected accounts block. Connectors are MCP servers from the catalog plus
// workspace-defined Custom APIs: a curated Featured strip, then a large
// search, kind filters, an "Enabled" strip the user manages daily, a Custom
// APIs list, and a logo tile grid over the full catalog (1,000+ items,
// rendered incrementally). Credentialed MCP servers connect through the
// connections spine (OAuth redirect or an API-key form) in a right-hand detail
// sheet, never by hand-editing enable headers. Bundles are Skills, Plugins,
// and Packs: a named collection of tools and instructions rather than a live
// connection, so they get their own section, their own search, and one uniform
// row (see `bundles-section.tsx`) instead of three unheaded blocks. Nothing
// with kind skill, plugin, or pack ever reaches the Connectors Enabled/Browse
// projections.
import { usePacks, useRigs, useVariableSets } from "@opengeni/react";
import { PlugIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  lazy,
} from "react";
import { toast } from "sonner";

import { AddCustomDialog } from "@/components/capabilities/add-custom-dialog";
import { BundlesSection } from "@/components/capabilities/bundles-section";
import {
  CapabilityBrowseSection,
  CapabilityDiscoveryControls,
  EnabledCapabilitiesSection,
} from "@/components/capabilities/capability-catalog-sections";
import {
  CapabilityDetailSheet,
  type ConnectAction,
} from "@/components/capabilities/capability-detail-sheet";
import {
  customApiAuthenticationMayBeRequired,
  customApiConnectionRequest,
  customApiFlowReducer,
  customApiInstallValidationError,
  customApiProviderDomain,
  customApiSourceFromDraft,
  filterCustomApiInstances,
  initialCustomApiFlowState,
} from "@/components/capabilities/custom-api-flow";
import { CustomApiSection } from "@/components/capabilities/custom-api-section";
import {
  FeaturedConnectorsStrip,
  featuredConnectors,
} from "@/components/capabilities/featured-connectors";
import { IntegrationRow } from "@/components/capabilities/integration-row";
import { IntegrationSheet } from "@/components/capabilities/integration-sheet";
import {
  QuickConnectDialog,
  type QuickConnectRequest,
} from "@/components/capabilities/quick-connect-dialog";
import { useApiIntegrationOAuthCallback } from "@/components/capabilities/use-api-integration-accounts";
import { useCapabilitiesCatalog } from "@/components/capabilities/use-capabilities-catalog";
import { useAtlassianIntegration } from "@/components/capabilities/use-atlassian-integration";
import { useGitHubIntegration } from "@/components/capabilities/use-github-integration";
import { useGoogleDriveIntegration } from "@/components/capabilities/use-google-drive-integration";
import { useOneDriveIntegration } from "@/components/capabilities/use-onedrive-integration";
import { useOutlookCalendarIntegration } from "@/components/capabilities/use-outlook-calendar-integration";
import { useOutlookContactsIntegration } from "@/components/capabilities/use-outlook-contacts-integration";
import { useOutlookMailIntegration } from "@/components/capabilities/use-outlook-mail-integration";
import {
  canManageSlackReactionSummon,
  useSlackIntegration,
} from "@/components/capabilities/use-slack-integration";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import {
  apiKeyConnectionRef,
  apiKeyCredential,
  capabilityConnectPlan,
  capabilityCounts,
  capabilityErrorToast,
  capabilityInputFromForm,
  capabilityQuickConnectPlan,
  connectionHealth,
  connectionToReuseForApiKey,
  createInputFromCatalogItem,
  filterCapabilityCatalogItems,
  isConnectorCatalogItem,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthConnectionRef,
  oauthConnectionOwnership,
  oauthResumeAction,
  registryResultsForQuery,
  resolveSheetItem,
  sortFeaturedFirst,
  type CapabilityFilter,
  type CapabilityFormState,
  type ConnectionHealth,
  type RequiredHeaderField,
  type SheetSelection,
} from "@/lib/capabilities";
import { listViewState } from "@/lib/load-state";
import { mcpOAuthCallbackFailureMessage, startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
import { hasWorkspacePermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { request } from "@/api";

// Custom API creation is a fundamentally different "define a new connector
// from a spec" flow (paste a URL, preview, pick tools, authenticate, create),
// not a catalog connect - its own multi-phase dialog stays lazy since it is
// only needed once a workspace admin opens "Add custom API".
const CustomApiSetupDialog = lazy(async () => {
  const module = await import("@/components/capabilities/custom-api-setup-dialog");
  return { default: module.CustomApiSetupDialog };
});

import type { IntegrationViewModel } from "@/components/capabilities/integration-view-model";

import type {
  AccessContext,
  ApiIntegrationInstallationSummary,
  CapabilityCatalogItem,
  CapabilityPack,
  ConnectionMetadata,
  ConnectionOwnership,
  PackInstallationPreview,
  PackUninstallPreview,
  SkillUninstallPreview,
} from "@/types";

const PAGE_SIZE = 48;

export function canManageApiIntegrations(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  return hasWorkspacePermission(accessContext, workspaceId, "workspace:admin");
}

/**
 * Whether the `?section=packs` deep link should scroll the Bundles section into
 * view on this render.
 *
 * It must wait for the catalog: on first commit Browse is a skeleton, and
 * resolving a 1000+ item catalog then inserts thousands of pixels above the
 * Bundles section, leaving a reader who followed the link stranded in the
 * middle of the Browse grid. It must also fire exactly once, so a later
 * loading/settled cycle (a refresh) never yanks the page back.
 */
export function shouldScrollToDeepLinkedBundles(
  initialSection: "packs" | undefined,
  loading: boolean,
  alreadyScrolled: boolean,
): boolean {
  return initialSection === "packs" && !loading && !alreadyScrolled;
}

export function CapabilitiesRoute({
  workspaceId,
  initialSection,
  slackLinkToken,
}: {
  workspaceId: string;
  initialSection?: "packs";
  slackLinkToken?: string;
}) {
  const context = useAppContext();
  const client = context.client;
  const onRuntimeChanged = useCallback(
    () => void context.refreshWorkspaceMcpServers(workspaceId),
    [context, workspaceId],
  );

  // The whole workspace-scoped data load lives in one hook that fences every
  // response on the exact client + workspace it was requested for.
  const catalogData = useCapabilitiesCatalog(workspaceId);
  const {
    items,
    setItems,
    connections,
    connectionsLoadFailed,
    replaceConnection,
    adoptConnections,
    apiIntegrationDefinitions,
    apiIntegrationInstances,
    socialConnections,
    slackInstallationBindings,
    loading,
    loadError,
    refresh,
  } = catalogData;
  const [busyId, setBusyId] = useState<string | null>(null);

  // Connectors-only discovery: the chips offer exactly the kinds that grid can
  // show. `?section=packs` no longer selects a kind filter - Packs are Bundles
  // now, so it scrolls that section into view instead.
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Detail/connect sheet. We store the id (+ registry flag + a snapshot for
  // registry items not yet in the catalog), NOT the item object: the rendered
  // item is derived from the LIVE `items` list by id, so any mutation + refresh
  // (strip disable, pack disable, background reload) re-derives the sheet instead
  // of leaving it on a stale snapshot that could re-enable what was just disabled.
  const [selected, setSelected] = useState<SheetSelection | null>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  // The element that opened the integration sheet, captured synchronously so
  // closing it returns focus to that row instead of dropping it on the body.
  const integrationOpenerRef = useRef<HTMLElement | null>(null);
  const capabilityFocusFallbackRef = useRef<HTMLDivElement | null>(null);
  // `/workspaces/:id/packs` redirects here with `?section=packs`. Packs are
  // Bundles now, so that deep link scrolls the Bundles section into view
  // instead of selecting a kind filter the Connectors grid no longer offers.
  const bundlesRef = useRef<HTMLDivElement | null>(null);
  const bundlesScrolled = useRef(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Which integration's detail sheet is open (one sheet, one open id).
  const [openIntegration, setOpenIntegration] = useState<string | null>(null);
  const [skillRemoval, setSkillRemoval] = useState<{
    item: CapabilityCatalogItem;
    preview: SkillUninstallPreview;
  } | null>(null);

  // Custom (workspace-defined OpenAPI/GraphQL) API instances render as an
  // ordinary Connectors list, fed directly from `apiIntegrationInstances`
  // rather than through the generic CapabilityCatalogItem catalog: their
  // creation flow (paste a spec, preview, pick tools, authenticate, create) is
  // its own multi-phase wizard, not a catalog connect.
  const customApiInstances = useMemo(
    () =>
      apiIntegrationInstances.filter((instance) => instance.definitionProvenance === "workspace"),
    [apiIntegrationInstances],
  );
  const [customApi, dispatchCustomApi] = useReducer(
    customApiFlowReducer,
    undefined,
    initialCustomApiFlowState,
  );
  const [customApiBusyKey, setCustomApiBusyKey] = useState<string | null>(null);
  const [customApiRemoveTarget, setCustomApiRemoveTarget] = useState<{
    instance: ApiIntegrationInstallationSummary;
    removesDefinition: boolean;
  } | null>(null);

  // The one shared quick-connect dialog: only `api_key` and unreviewed
  // `oauth2` connectors ever need it. `none` and reviewed `oauth2` connect
  // directly from the row/tile icon with no screen of ours.
  const [quickConnectRequest, setQuickConnectRequest] = useState<QuickConnectRequest | null>(null);

  // Public MCP registry search (only offered when the catalog has no matches).
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [registrySearched, setRegistrySearched] = useState<string | null>(null);

  const packs = usePacks({ workspaceId });
  const rigs = useRigs({ workspaceId });
  const variableSets = useVariableSets({ workspaceId });

  // The Connectors surface owns exactly MCP servers and API connectors. Skills,
  // Plugins, and Packs are Bundles: they are scoped out here (not merely
  // filtered by the chips) so no Enabled, Browse, or search result can ever
  // contain one, and so the chip counts describe what this grid can show.
  const connectorItems = useMemo(() => items.filter(isConnectorCatalogItem), [items]);
  const counts = useMemo(() => capabilityCounts(connectorItems), [connectorItems]);
  const catalogView = listViewState({
    loading,
    error: loadError,
    count: connectorItems.length,
  });

  const filtered = useMemo(
    () => filterCapabilityCatalogItems(connectorItems, filter, query),
    [connectorItems, filter, query],
  );
  // The Featured strip shows curated connectors when nothing narrows the list;
  // the grid then carries the long tail. A search or a non-MCP filter hides the
  // strip and the grid shows every match again. The partition is stable, so
  // within the featured and non-featured groups the server order (kind,
  // category, name) is preserved.
  const showFeatured = query.trim().length === 0 && (filter === "all" || filter === "mcp");
  const featured = useMemo(
    () => (showFeatured ? featuredConnectors(filtered) : []),
    [filtered, showFeatured],
  );
  const featuredIds = useMemo(() => new Set(featured.map((item) => item.id)), [featured]);
  // One placement per integration: a featured tile carries its own Enabled
  // badge, so an enabled featured item stays in the strip and is excluded from
  // the Enabled section; everything else enabled lives in the Enabled section
  // and Browse shows only the rest of the catalog.
  const enabledItems = useMemo(
    () => filtered.filter((item) => item.enabled && !featuredIds.has(item.id)),
    [filtered, featuredIds],
  );
  const browseItems = useMemo(
    () => sortFeaturedFirst(filtered.filter((item) => !item.enabled && !featuredIds.has(item.id))),
    [filtered, featuredIds],
  );
  const visibleBrowse = browseItems.slice(0, visibleCount);
  // Custom APIs answer the same search as every other connector: a query that
  // matches nothing here must not still list every workspace-defined API.
  const visibleCustomApiInstances = useMemo(
    () => filterCustomApiInstances(customApiInstances, query),
    [customApiInstances, query],
  );

  const logoUrl = useCallback(
    (item: CapabilityCatalogItem) => client.catalogAssetUrl(item.logoAssetPath),
    [client],
  );
  const connectionsLoaded = connections !== null;
  const canManageApiIntegrationInstances = canManageApiIntegrations(
    context.accessContext,
    workspaceId,
  );
  const canManageSkills = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );

  // One adapter per integration maps its own data onto the shared view-model.
  // The row and the sheet know nothing provider-specific.
  const slack = useSlackIntegration({
    workspaceId,
    items,
    connections,
    connectionsLoaded,
    slackInstallationBindings,
    sheetOpen: openIntegration === "slack",
    refresh,
    onRuntimeChanged,
  });
  const github = useGitHubIntegration({ workspaceId });
  const googleDrive = useGoogleDriveIntegration({
    workspaceId,
    connections,
    connectionsLoaded,
    connectionsLoadFailed,
    refresh,
    replaceConnection,
    definitions: apiIntegrationDefinitions,
    instances: apiIntegrationInstances,
    onRuntimeChanged,
    refreshRevision: catalogData.revision,
  });
  const atlassian = useAtlassianIntegration({
    workspaceId,
    connections,
    connectionsLoaded,
    connectionsLoadFailed,
    refresh,
    replaceConnection,
  });
  // Outlook Mail/Calendar/Contacts and OneDrive: one row per provider, folding
  // every connected account into that row's Connected accounts block. Every
  // curated definition here is oauth2-only, so a single shared effect (below)
  // handles the OAuth return for all of them.
  useApiIntegrationOAuthCallback({ workspaceId, refresh, onRuntimeChanged });
  const outlookMail = useOutlookMailIntegration({
    workspaceId,
    definitions: apiIntegrationDefinitions,
    instances: apiIntegrationInstances,
    refresh,
    onRuntimeChanged,
    refreshRevision: catalogData.revision,
  });
  const outlookCalendar = useOutlookCalendarIntegration({
    workspaceId,
    definitions: apiIntegrationDefinitions,
    instances: apiIntegrationInstances,
    refresh,
    onRuntimeChanged,
    refreshRevision: catalogData.revision,
  });
  const outlookContacts = useOutlookContactsIntegration({
    workspaceId,
    definitions: apiIntegrationDefinitions,
    instances: apiIntegrationInstances,
    refresh,
    onRuntimeChanged,
    refreshRevision: catalogData.revision,
  });
  const oneDrive = useOneDriveIntegration({
    workspaceId,
    definitions: apiIntegrationDefinitions,
    instances: apiIntegrationInstances,
    refresh,
    onRuntimeChanged,
    refreshRevision: catalogData.revision,
  });
  const integrations = [
    slack,
    github,
    googleDrive,
    atlassian,
    outlookMail,
    outlookCalendar,
    outlookContacts,
    oneDrive,
  ];
  const openIntegrationModel =
    integrations.find((adapter) => adapter.model.id === openIntegration)?.model ?? null;
  // The item the sheet renders, always from the live catalog. Registry items
  // aren't in `items` until persisted, so they fall back to their snapshot; a
  // non-registry selection with no live row resolves to null and the effect
  // below closes the sheet rather than render a ghost.
  const selectedItem: CapabilityCatalogItem | null = useMemo(
    () => resolveSheetItem(selected, items),
    [selected, items],
  );
  const selectedHealth: ConnectionHealth = selectedItem
    ? connectionHealth(selectedItem, connections ?? [], connectionsLoaded)
    : { state: "none" };
  const selectedSocialConnections = selectedItem
    ? (() => {
        const plan = capabilityConnectPlan(selectedItem);
        return plan.mode === "social_oauth"
          ? socialConnections.filter((connection) => connection.provider === plan.provider)
          : [];
      })()
    : [];
  const canManageSocial = canManageSlackReactionSummon(context.accessContext, workspaceId);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const fikenOAuthHandled = useRef(false);
  useEffect(() => {
    if (fikenOAuthHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("fiken");
    if (!outcome) return;
    fikenOAuthHandled.current = true;
    const reason = params.get("reason");
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "connected") {
      void refresh();
      toast.success("Fiken connected");
    } else {
      toast.error("Couldn't connect Fiken", {
        description:
          reason === "provider_denied"
            ? "The Fiken authorization was declined."
            : reason === "no_api_company"
              ? "The Fiken account has API access to no company. Order API module access in Fiken first."
              : "Try again, or connect with a personal API token instead.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const slackUserLinkHandled = useRef(false);
  useEffect(() => {
    if (!slackLinkToken || slackUserLinkHandled.current) return;
    slackUserLinkHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    void request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack/user-links`,
      {
        method: "POST",
        body: JSON.stringify({ linkToken: slackLinkToken }),
      },
    )
      .then(() => {
        toast.success("Slack identity linked", {
          description: "You can return to Slack and invoke OpenGeni again.",
        });
      })
      .catch((error) => {
        toast.error("Couldn't link your Slack identity", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
  }, [slackLinkToken, workspaceId]);

  // Reset the incremental window whenever the result set changes.
  useEffect(() => setVisibleCount(PAGE_SIZE), [filter, query]);

  // Honour the `?section=packs` deep link exactly once, after the catalog has
  // settled. Scrolling on first commit lands in the wrong place: Browse is
  // still a skeleton then, and resolving a 1000+ item catalog inserts thousands
  // of pixels above the Bundles section afterwards.
  useEffect(() => {
    if (!shouldScrollToDeepLinkedBundles(initialSection, loading, bundlesScrolled.current)) return;
    bundlesScrolled.current = true;
    bundlesRef.current?.scrollIntoView({ block: "start" });
  }, [initialSection, loading]);

  // Close the sheet if a live-bound selection vanished from the catalog after a
  // refresh (deleted/unregistered elsewhere) - never leave a ghost open. A
  // snapshot-fallback selection (registry result, or a just-created item not yet
  // in `items`, e.g. after a failed refresh) legitimately isn't in the catalog
  // yet, so it renders from its snapshot instead of being closed here.
  useEffect(() => {
    if (
      selected &&
      !selected.snapshotFallback &&
      !loading &&
      !items.some((entry) => entry.id === selected.id)
    ) {
      setSelected(null);
      setSheetError(null);
    }
  }, [selected, items, loading]);

  // Registry hits stay in state after a search; gate them on the searched term
  // still matching the live query so an old search never renders against a new
  // one (invalidation without a clearing effect that flashes stale tiles first).
  const visibleRegistry = registryResultsForQuery(query, registrySearched, registryResults);

  function refreshAll() {
    void refresh();
    void packs.refresh();
  }

  // `snapshotFallback` defaults to `registry` (a registry result renders from its
  // snapshot until persisted); the add-custom flow passes it explicitly for a
  // just-created item whose row may not be in `items` yet.
  function openItem(item: CapabilityCatalogItem, registry = false, snapshotFallback = registry) {
    const active = document.activeElement;
    sheetOpenerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setSheetError(null);
    setSelected({ id: item.id, registry, snapshotFallback, snapshot: item });
  }

  // --- Custom (workspace-defined) API connectors ------------------------------
  // The creation wizard (paste a spec, preview, pick tools, authenticate,
  // create) stays its own multi-phase flow; an already-installed instance
  // renders as an ordinary row in the Connectors section via CustomApiSection.

  function openCustomApi() {
    if (
      customApi.draft.url.trim() ||
      customApi.preview ||
      customApi.error ||
      customApi.editingInstance
    ) {
      dispatchCustomApi({ type: "open" });
      return;
    }
    dispatchCustomApi({ type: "new" });
  }

  function editCustomApi(
    instance: ApiIntegrationInstallationSummary,
    intent: "update" | "reconnect",
  ) {
    const connection = instance.connectionId
      ? ((connections ?? []).find((candidate) => candidate.id === instance.connectionId) ?? null)
      : null;
    dispatchCustomApi({ type: "edit", intent, instance, connection });
  }

  async function previewCustomApi(connection = customApi.connection) {
    let source;
    try {
      source = customApiSourceFromDraft(customApi.draft);
    } catch (error) {
      dispatchCustomApi({
        type: "preview_error",
        message: error instanceof Error ? error.message : String(error),
        authenticationMayBeRequired: false,
      });
      return;
    }
    dispatchCustomApi({ type: "phase", phase: "previewing", error: null });
    try {
      const preview = await client.previewApiIntegration(workspaceId, {
        source,
        ...(connection
          ? { connectionId: connection.id, ownership: customApi.draft.ownership }
          : {}),
      });
      dispatchCustomApi({ type: "preview", preview, connection });
    } catch (error) {
      dispatchCustomApi({
        type: "preview_error",
        message: error instanceof Error ? error.message : String(error),
        authenticationMayBeRequired: customApiAuthenticationMayBeRequired(source, error),
      });
    }
  }

  async function authenticateCustomApi() {
    let connection: ConnectionMetadata;
    dispatchCustomApi({ type: "phase", phase: "creating_connection", error: null });
    try {
      if (customApi.draft.connectionMode === "existing") {
        const selectedConnection = (connections ?? []).find(
          (candidate) => candidate.id === customApi.draft.existingConnectionId,
        );
        if (!selectedConnection) throw new Error("Choose a compatible existing Connection.");
        connection = selectedConnection;
      } else {
        const providerDomain =
          customApi.preview?.providerDomain ?? customApiProviderDomain(customApi.draft);
        connection = await client.createConnection(
          workspaceId,
          customApiConnectionRequest({
            preview: customApi.preview,
            draft: customApi.draft,
            providerDomain,
          }),
        );
        await refresh();
      }
      dispatchCustomApi({ type: "connection", connection });
      await previewCustomApi(connection);
    } catch (error) {
      dispatchCustomApi({
        type: "phase",
        phase: "auth",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function installCustomApi() {
    const validationError = customApiInstallValidationError(customApi);
    if (validationError) {
      dispatchCustomApi({ type: "phase", phase: "review", error: validationError });
      return;
    }
    const preview = customApi.preview!;
    dispatchCustomApi({ type: "phase", phase: "installing", error: null });
    const editing = customApi.editingInstance;
    try {
      await client.installApiIntegration(workspaceId, {
        source: preview.source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        ...(customApi.connection && preview.auth.kind !== "none"
          ? { connectionId: customApi.connection.id, ownership: customApi.draft.ownership }
          : {}),
        instanceKey: editing?.instanceKey ?? `custom-${crypto.randomUUID()}`,
        displayName: customApi.draft.displayName.trim(),
        ...(editing ? { expectedInstanceVersion: editing.instanceVersion } : {}),
        allowedTools: customApi.selectedTools,
      });
      await refresh();
      onRuntimeChanged();
      toast.success(`${customApi.draft.displayName.trim()} ${editing ? "updated" : "installed"}`, {
        description: `${customApi.selectedTools.length} tools are available through this exact instance.`,
      });
      dispatchCustomApi({ type: "reset" });
    } catch (error) {
      dispatchCustomApi({
        type: "phase",
        phase: "review",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function customApiBack() {
    if (customApi.phase === "review" && customApi.preview?.auth.kind !== "none") {
      dispatchCustomApi({ type: "phase", phase: "auth", error: null });
      return;
    }
    dispatchCustomApi({ type: "phase", phase: "source", error: null });
  }

  function toggleCustomApiTool(toolId: string, toolSelected: boolean) {
    const next = toolSelected
      ? [...new Set([...customApi.selectedTools, toolId])]
      : customApi.selectedTools.filter((candidate) => candidate !== toolId);
    dispatchCustomApi({ type: "tools", selectedTools: next });
  }

  async function previewRemoveCustomApi(instance: ApiIntegrationInstallationSummary) {
    setCustomApiBusyKey(instance.instanceKey);
    try {
      const preview = await client.previewApiIntegrationUninstall(
        workspaceId,
        instance.capabilityId,
        instance.instanceKey,
      );
      setCustomApiRemoveTarget({ instance, removesDefinition: preview.removesDefinition });
    } catch (error) {
      toast.error("Couldn't inspect removal impact", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCustomApiBusyKey(null);
    }
  }

  async function removeCustomApiInstance(): Promise<boolean> {
    if (!customApiRemoveTarget) return false;
    const { instance } = customApiRemoveTarget;
    setCustomApiBusyKey(instance.instanceKey);
    try {
      await client.uninstallApiIntegration(
        workspaceId,
        instance.capabilityId,
        instance.instanceKey,
        {
          expectedInstallationVersion: instance.installationVersion,
          expectedInstanceVersion: instance.instanceVersion,
        },
      );
      setCustomApiRemoveTarget(null);
      await refresh();
      onRuntimeChanged();
      toast.success(`${instance.displayName} removed`, {
        description: "Its Connection was retained and can be reused or disconnected separately.",
      });
      return true;
    } catch (error) {
      toast.error("Couldn't remove this instance", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setCustomApiBusyKey(null);
    }
  }

  // --- Connectors quick-connect fast path --------------------------------------
  // The row/tile icon click: `none` and reviewed `oauth2` act immediately with
  // no screen of ours; `api_key` and unreviewed `oauth2` open the one shared
  // quick-connect dialog. Reuses the exact same connect mutations `handleAction`
  // uses for the full sheet, just without requiring the sheet to be open first.

  function capabilityQuickConnectAction(item: CapabilityCatalogItem): (() => void) | undefined {
    const plan = capabilityQuickConnectPlan(item);
    // No fast path: "dedicated" lifecycles (Skills, Plugins, first-party
    // Fiken/social), "social_oauth", and any api-key connector needing more
    // than one header - the full sheet owns those.
    if (!plan) return undefined;
    if (plan.mode === "enable") {
      return () => void quickEnable(item);
    }
    if (plan.mode === "oauth") {
      return plan.confirm
        ? () =>
            setQuickConnectRequest({
              authKind: "oauth2_unreviewed",
              itemName: item.name,
              providerDomain: plan.providerDomain,
              onConnect: () => quickOAuth(item, plan.providerDomain, plan.mcpUrl, plan.ownership),
            })
        : () => void quickOAuth(item, plan.providerDomain, plan.mcpUrl, plan.ownership);
    }
    return () =>
      setQuickConnectRequest({
        authKind: "api_key",
        itemName: item.name,
        providerDomain: plan.providerDomain,
        fieldLabel: plan.field.label,
        onConnect: (value) =>
          quickApiKey(item, plan.providerDomain, plan.field, plan.ownership, value),
      });
  }

  async function quickEnable(item: CapabilityCatalogItem) {
    setBusyId(item.id);
    try {
      const persisted = await persistIfRegistry(item, false);
      await client.enableCapability(workspaceId, persisted.id);
      await refresh();
      onRuntimeChanged();
      toast.success(`Enabled ${item.name}`);
    } catch (error) {
      const { title, description } = capabilityErrorToast(error, "Couldn't enable this connector");
      toast.error(title, { description });
    } finally {
      setBusyId(null);
    }
  }

  async function quickOAuth(
    item: CapabilityCatalogItem,
    providerDomain: string,
    mcpUrl: string | null,
    ownership: ConnectionOwnership,
  ) {
    setBusyId(item.id);
    try {
      const persisted = await persistIfRegistry(item, false);
      const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(persisted.id)}`;
      const response = await startMcpOAuthWithTimeout(client, workspaceId, {
        ...(mcpUrl ? { mcpUrl } : {}),
        ...(providerDomain ? { providerDomain } : {}),
        ownership,
        returnPath,
      });
      if (!response.authorizationUrl) {
        throw new Error("The provider did not return an authorization link.");
      }
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setBusyId(null);
      const { title, description } = capabilityErrorToast(error, "Couldn't start the connection");
      toast.error(title, { description });
      throw error;
    }
  }

  async function quickApiKey(
    item: CapabilityCatalogItem,
    providerDomain: string,
    field: RequiredHeaderField,
    ownership: ConnectionOwnership,
    value: string,
  ) {
    if (!value) throw new Error(`Enter ${field.label.toLowerCase()}.`);
    setBusyId(item.id);
    try {
      const persisted = await persistIfRegistry(item, false);
      // The credential is stored under the WIRE header name the broker injects,
      // never the human label ("API key" is not even a legal header token).
      const credential = apiKeyCredential(field, value);
      const reuseId = connectionToReuseForApiKey(
        persisted,
        connections ?? [],
        providerDomain,
        ownership,
      );
      const connection = reuseId
        ? await client.updateConnection(workspaceId, reuseId, {
            credential,
            status: "active",
          })
        : await client.createConnection(workspaceId, {
            providerDomain,
            kind: "api_key",
            ownership,
            credential,
          });
      await client.enableCapability(workspaceId, persisted.id, {
        connectionRef: apiKeyConnectionRef(ownership, connection.id, connection.providerDomain),
      });
      await refresh();
      onRuntimeChanged();
      toast.success(`Connected ${item.name}`);
    } catch (error) {
      const { title, description } = capabilityErrorToast(error, "Couldn't connect this connector");
      toast.error(title, { description });
      throw error;
    } finally {
      setBusyId(null);
    }
  }

  // --- Connect flows ---------------------------------------------------------

  // Registry items aren't persisted; create the catalog row before connecting so
  // enable/OAuth have a real capability id to reference.
  async function persistIfRegistry(
    item: CapabilityCatalogItem,
    registry: boolean,
  ): Promise<CapabilityCatalogItem> {
    if (!registry) return item;
    const created = await client.createCapability(workspaceId, createInputFromCatalogItem(item));
    return created;
  }

  async function handleAction(action: ConnectAction) {
    // Act on the LIVE item (derived from the catalog by id), never the stored
    // snapshot - a mutation elsewhere may have changed it since the sheet opened.
    if (!selected || !selectedItem) return;
    const item = selectedItem;
    setBusyId(item.id);
    setSheetError(null);
    try {
      // The plan is derived from the current catalog/registry item (it carries
      // authKind/mcpUrl/providerDomain); connect calls use the persisted id.
      const plan = capabilityConnectPlan(item);

      if (action.type === "install_skill") {
        if (!canManageSkills) {
          throw new Error("Workspace administrator permission is required to install Skills.");
        }
        const libraryId = metadataString(item.metadata.libraryId);
        const expectedVersion = metadataString(item.metadata.version);
        const expectedContentSha256 = metadataString(item.metadata.contentSha256);
        if (!libraryId || !expectedVersion || !expectedContentSha256) {
          throw new Error(
            "This Skill is missing its reviewed library identity. Refresh and try again.",
          );
        }
        const installationVersion = installedSkillVersion(item);
        await client.installLibrarySkill(workspaceId, libraryId, {
          expectedVersion,
          expectedContentSha256,
          ...(installationVersion !== null
            ? { expectedInstallationVersion: installationVersion }
            : {}),
        });
        await refresh();
        onRuntimeChanged();
        toast.success(item.enabled ? `Updated ${item.name}` : `Installed ${item.name}`, {
          description: `Pinned to reviewed Skill version ${expectedVersion}.`,
        });
        setSelected(null);
        return;
      }

      if (action.type === "remove_skill") {
        if (!canManageSkills) {
          throw new Error("Workspace administrator permission is required to remove Skills.");
        }
        const preview = await client.previewSkillUninstall(workspaceId, item.id);
        if (!preview.installed || preview.installationVersion === null || !preview.directOwner) {
          throw new Error("This Skill is no longer directly installed. Refresh and try again.");
        }
        setSkillRemoval({ item, preview });
        return;
      }

      if (action.type === "disconnect") {
        if (item.kind !== "mcp" || !item.actions.includes("disconnect")) {
          throw new Error(`${item.name} must be managed through its dedicated controls.`);
        }
        await client.disableCapability(workspaceId, item.id);
        await refresh();
        onRuntimeChanged();
        toast.success(`Disabled ${item.name}`);
        setSelected(null);
        return;
      }

      if (action.type === "social_oauth" && plan.mode === "social_oauth") {
        const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(item.id)}`;
        const response = await client.startSocialOAuth(workspaceId, {
          provider: action.provider,
          ownership: action.ownership,
          returnPath,
        });
        if (!response.authorizationUrl) {
          throw new Error("The provider did not return an authorization link.");
        }
        window.location.assign(response.authorizationUrl);
        return;
      }

      if (action.type === "disconnect_social") {
        await client.disconnectSocialConnection(workspaceId, action.connectionId);
        await refresh();
        toast.success(`Disconnected ${item.name}`);
        setSelected(null);
        return;
      }

      // First-party Fiken connect / token replacement. The install route
      // verifies the token against Fiken before storing it, so a bad paste
      // fails here with a specific message instead of at first tool use.
      if (action.type === "fiken_api_token") {
        await client.installFikenConnection(workspaceId, {
          apiToken: action.apiToken,
          ...(action.connectionId ? { connectionId: action.connectionId } : {}),
        });
        await refresh();
        onRuntimeChanged();
        toast.success(`Connected ${item.name}`);
        setSelected(null);
        return;
      }

      // Full-page redirect into Fiken's consent screen; the API callback
      // stores the workspace connection and returns to this page with a
      // `fiken` query param handled by the return effect below.
      if (action.type === "fiken_oauth") {
        const response = await client.startFikenOAuth(workspaceId, {
          ...(action.connectionId ? { connectionId: action.connectionId } : {}),
        });
        if (!response.authorizationUrl) {
          throw new Error("Fiken did not return an authorization link.");
        }
        window.location.assign(response.authorizationUrl);
        return;
      }

      if (action.type === "fiken_disconnect") {
        await client.deleteConnection(workspaceId, action.connectionId);
        await refresh();
        onRuntimeChanged();
        toast.success(`Disconnected ${item.name}`);
        setSelected(null);
        return;
      }

      // Reconnect an already-enabled item whose credential lapsed. When the
      // connection row survives, OAuth reuses it (pass connectionId) and the
      // return handler just refreshes; when it was deleted (null id), OAuth
      // mints a fresh row and the return handler re-enables against it. API-key
      // reactivates the surviving row in place, or mints + re-enables if gone.
      if (action.type === "reconnect_oauth") {
        // Trust the installation's connectionRef.kind (the sheet already chose this
        // branch from it), not the catalog plan - on drift plan.mode can read
        // "enable", so fall back to the ref's domain and the item's own MCP URL.
        const providerDomain =
          plan.mode === "oauth"
            ? plan.providerDomain
            : (item.connectionRef?.providerDomain ?? null);
        const mcpUrl =
          plan.mode === "oauth" ? plan.mcpUrl : (item.mcpUrl ?? item.endpointUrl ?? null);
        const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(item.id)}`;
        const response = await startMcpOAuthWithTimeout(client, workspaceId, {
          ...(mcpUrl ? { mcpUrl } : {}),
          ...(providerDomain ? { providerDomain } : {}),
          // Reuse the existing row when it survives; a null id means the row was
          // deleted, so OAuth mints a fresh connection and the return handler
          // re-enables against it.
          ...(action.connectionId ? { connectionId: action.connectionId } : {}),
          ownership: action.ownership,
          returnPath,
        });
        if (!response.authorizationUrl) {
          throw new Error("The provider did not return an authorization link.");
        }
        window.location.assign(response.authorizationUrl);
        return;
      }

      if (action.type === "reconnect_api_key") {
        if (action.connectionId) {
          // The existing row went inactive - rewrite its credential and
          // reactivate it in place; the installation ref already points at it.
          await client.updateConnection(workspaceId, action.connectionId, {
            credential: { headers: action.headers },
            status: "active",
          });
        } else {
          // The row was deleted - mint a fresh connection and re-enable the
          // installation against it (enable upserts the installation config). Domain
          // comes from the plan, or the installation's ref when the catalog drifted.
          const providerDomain =
            plan.mode === "api_key"
              ? plan.providerDomain
              : (item.connectionRef?.providerDomain ?? "");
          const connection = await client.createConnection(workspaceId, {
            providerDomain,
            kind: "api_key",
            ownership: action.ownership,
            credential: { headers: action.headers },
          });
          await client.enableCapability(workspaceId, item.id, {
            connectionRef: apiKeyConnectionRef(
              action.ownership,
              connection.id,
              connection.providerDomain,
            ),
          });
        }
        await refresh();
        onRuntimeChanged();
        toast.success(`Reconnected ${item.name}`);
        setSelected(null);
        return;
      }

      if (item.kind !== "mcp") {
        throw new Error(`${item.name} must be installed through its dedicated controls.`);
      }
      const persisted = await persistIfRegistry(item, selected.registry);

      if (action.type === "oauth" && plan.mode === "oauth") {
        const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(persisted.id)}`;
        const response = await startMcpOAuthWithTimeout(client, workspaceId, {
          ...(plan.mcpUrl ? { mcpUrl: plan.mcpUrl } : {}),
          ...(plan.providerDomain ? { providerDomain: plan.providerDomain } : {}),
          ownership: action.ownership,
          returnPath,
        });
        if (!response.authorizationUrl) {
          throw new Error("The provider did not return an authorization link.");
        }
        // Full-page redirect into the provider's consent screen; we return to
        // returnPath and resume in the OAuth-return effect below.
        window.location.assign(response.authorizationUrl);
        return;
      }

      if (action.type === "api_key" && plan.mode === "api_key") {
        // Reuse only a connection with the selected ownership rather than creating
        // a duplicate on retry; workspace and personal rows never cross-reuse.
        const reuseId = connectionToReuseForApiKey(
          item,
          connections ?? [],
          plan.providerDomain,
          action.ownership,
        );
        const connection = reuseId
          ? await client.updateConnection(workspaceId, reuseId, {
              credential: { headers: action.headers },
              status: "active",
            })
          : await client.createConnection(workspaceId, {
              providerDomain: plan.providerDomain,
              kind: "api_key",
              ownership: action.ownership,
              credential: { headers: action.headers },
            });
        // Build the enable ref from the connection row the API returns, never the
        // catalog domain - the API may canonicalize providerDomain, and the row
        // is the authoritative match the enable path validates against.
        await client.enableCapability(workspaceId, persisted.id, {
          connectionRef: apiKeyConnectionRef(
            action.ownership,
            connection.id,
            connection.providerDomain,
          ),
        });
        await refresh();
        onRuntimeChanged();
        toast.success(`Connected and enabled ${persisted.name}`);
        setSelected(null);
        return;
      }

      // Plain enable (no credentials).
      await client.enableCapability(workspaceId, persisted.id);
      await refresh();
      if (persisted.kind === "mcp") onRuntimeChanged();
      toast.success(`Enabled ${persisted.name}`);
      setSelected(null);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Something went wrong");
      // In-sheet human copy; the raw missing-credentials 422 becomes a prompt to
      // connect rather than an error string.
      setSheetError(
        isMissingCredentialsError(error)
          ? "This integration needs credentials before it can be enabled."
          : copy.description,
      );
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function removeSelectedSkill(): Promise<boolean> {
    if (!skillRemoval || skillRemoval.preview.installationVersion === null) return false;
    setBusyId(skillRemoval.item.id);
    try {
      const result = await client.uninstallSkill(workspaceId, skillRemoval.item.id, {
        expectedInstallationVersion: skillRemoval.preview.installationVersion,
      });
      await refresh();
      onRuntimeChanged();
      toast.success(`Removed ${skillRemoval.item.name}`, {
        description:
          result.status === "retained_by_other_owners"
            ? "Another Plugin or Pack still owns this Skill, so it remains available."
            : "The Skill is no longer active in this workspace.",
      });
      setSkillRemoval(null);
      setSelected(null);
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Couldn't remove Skill");
      toast.error(copy.title, { description: copy.description });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const socialOAuthHandled = useRef(false);
  useEffect(() => {
    if (socialOAuthHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("social_oauth");
    if (!outcome) return;
    socialOAuthHandled.current = true;
    const itemId = params.get("connect_item");
    const accountHandle = params.get("accountHandle");
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "success") {
      void refresh();
      toast.success(accountHandle ? `Connected @${accountHandle}` : "Social account connected");
      setSelected(null);
      return;
    }
    const reason = params.get("reason");
    const item = itemId ? (items.find((candidate) => candidate.id === itemId) ?? null) : null;
    if (item) {
      setSheetError(
        reason ? `Couldn't connect: ${reason}.` : "Couldn't connect. Please try again.",
      );
      setSelected({
        id: item.id,
        registry: false,
        snapshotFallback: false,
        snapshot: item,
      });
    } else {
      toast.error("Connection failed", { description: reason ?? undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items]);

  // Resume an OAuth round-trip. The callback lands back on this path with
  // ?integration_oauth=success|error; we read it once, strip it from the URL,
  // and either auto-enable with the fresh connection or reopen the sheet with a
  // human error + retry. Runs after the catalog loads so the item is resolvable.
  const oauthHandled = useRef(false);
  useEffect(() => {
    if (oauthHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("integration_oauth");
    if (!outcome) return;
    // Provider-definition API integrations have their own immutable preview/install
    // continuation. Leave those callback parameters intact for the control
    // center instead of treating them as a legacy MCP catalog connection.
    if (params.has("api_integration_definition")) return;
    oauthHandled.current = true;

    const itemId = params.get("connect_item");
    // Strip the OAuth params so a refresh doesn't reprocess them.
    window.history.replaceState(null, "", window.location.pathname);

    if (outcome === "success") {
      void resumeOAuthConnect(
        itemId,
        params.get("connectionId"),
        params.get("providerDomain"),
        oauthConnectionOwnership(params.get("ownership")),
      );
    } else {
      const reason = params.get("reason");
      const message = mcpOAuthCallbackFailureMessage(params.get("stage"), reason);
      const item = itemId ? (items.find((candidate) => candidate.id === itemId) ?? null) : null;
      if (item) {
        setSheetError(message);
        setSelected({
          id: item.id,
          registry: false,
          snapshotFallback: false,
          snapshot: item,
        });
      } else {
        toast.error("Connection failed", { description: message });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items]);

  // An agent recommendation deep-links to the same human-reviewed setup sheet
  // as a marketplace click. Loading the live catalog again prevents an old
  // session event from authorizing a removed or changed entry.
  const suggestionHandled = useRef(false);
  useEffect(() => {
    if (suggestionHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const capabilityId = params.get("suggested_capability");
    if (!capabilityId) return;
    suggestionHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    const item = items.find((candidate) => candidate.id === capabilityId);
    if (item) {
      setSelected({
        id: item.id,
        registry: false,
        snapshotFallback: false,
        snapshot: item,
      });
    } else {
      setQuery(capabilityId.replace(/^[^:]+:/, ""));
      toast.error("That recommended capability is no longer available");
    }
  }, [loading, items]);

  // Deep-link from an in-session reconnect card for an api-key connection:
  // ?reconnect_domain=<domain> opens the connect sheet for the enabled item on
  // that provider so the credential can be re-entered. Runs after the catalog
  // loads (it resolves the item by connectionRef domain); a miss just seeds the
  // search so the user can find it. Stripped from the URL after one read.
  const reconnectHandled = useRef(false);
  useEffect(() => {
    if (reconnectHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const domain = params.get("reconnect_domain");
    if (!domain) return;
    reconnectHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    const target = normalizeProviderDomain(domain);
    const item = items.find(
      (candidate) =>
        candidate.enabled &&
        candidate.connectionRef &&
        normalizeProviderDomain(candidate.connectionRef.providerDomain) === target,
    );
    if (item) {
      setSelected({
        id: item.id,
        registry: false,
        snapshotFallback: false,
        snapshot: item,
      });
    } else {
      setQuery(domain);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items]);

  async function resumeOAuthConnect(
    itemId: string | null,
    connectionId: string | null,
    providerDomain: string | null,
    ownership: ConnectionOwnership | null,
  ) {
    setBusyId(itemId ?? "oauth-return");
    // Hoisted above the try so the catch can reopen the sheet from the freshly
    // fetched rows (falling back to closure items only if the fetch itself failed).
    let freshItems: CapabilityCatalogItem[] | null = null;
    try {
      // Resolve the item from a FRESH catalog fetch: a registry item persisted
      // moments before the redirect won't be in the pre-redirect snapshot.
      const [catalog, conns] = await Promise.all([
        client.listCapabilities(workspaceId),
        client.listConnections(workspaceId).catch(() => null),
      ]);
      freshItems = catalog.items;
      setItems(catalog.items);
      // Don't clobber previously-loaded connections with null on a failed refetch
      // (that would flip healthy items to "unverified" until the next reload).
      if (conns !== null) adoptConnections(conns);
      const item =
        (itemId ? catalog.items.find((candidate) => candidate.id === itemId) : undefined) ?? null;
      const action = oauthResumeAction(item, connectionId);

      if (action === "missing") {
        // Connection was created but the catalog row is gone - never leave the
        // success half-handled silently; say plainly it wasn't enabled.
        toast.success(
          "Connected - but this integration is no longer in the catalog, so it wasn't enabled.",
        );
        return;
      }
      if (action === "no_connection") {
        toast.success(`Connected ${item!.name}. Open it to finish enabling.`);
        return;
      }
      if (action === "reconnect") {
        // Already enabled: the connection row was refreshed in place.
        onRuntimeChanged();
        toast.success(`Reconnected ${item!.name}`);
        setSelected(null);
        return;
      }

      // Build the enable connectionRef from the redirect's own authoritative
      // values - the callback carries the canonical providerDomain alongside the
      // connectionId - so enabling never depends on listConnections succeeding
      // (a transient failure or a grant without connections:read would otherwise
      // leave the connection created but the capability un-enabled). Fall back to
      // the fetched row only for an older callback that omitted providerDomain.
      const refDomain =
        providerDomain ??
        conns?.find((candidate) => candidate.id === connectionId)?.providerDomain ??
        null;
      if (!refDomain) {
        toast.success(`Connected ${item!.name}. Open it to finish enabling.`);
        return;
      }
      const returnedConnection = conns?.find((candidate) => candidate.id === connectionId) ?? null;
      const resolvedOwnership =
        ownership ?? (returnedConnection?.subjectId === null ? "workspace" : "personal");
      await client.enableCapability(workspaceId, item!.id, {
        connectionRef: oauthConnectionRef(resolvedOwnership, connectionId!, refDomain),
      });
      await refresh();
      onRuntimeChanged();
      // An already-enabled item reached here only because its old connection row
      // was gone and OAuth minted a new one - that's a reconnect, not a first enable.
      toast.success(
        item!.enabled ? `Reconnected ${item!.name}` : `Connected and enabled ${item!.name}`,
      );
      setSelected(null);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Couldn't finish connecting");
      setSheetError(copy.description);
      // Reopen the sheet on the item so the failure has a Retry, when resolvable.
      const item = itemId
        ? ((freshItems ?? items).find((candidate) => candidate.id === itemId) ?? null)
        : null;
      if (item)
        setSelected({
          id: item.id,
          registry: false,
          snapshotFallback: false,
          snapshot: item,
        });
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  // --- Enabled-strip removal/disconnect (no sheet needed) --------------------
  async function removeFromStrip(item: CapabilityCatalogItem) {
    setBusyId(item.id);
    try {
      if (item.kind === "skill") {
        if (!canManageSkills) {
          throw new Error("Workspace administrator permission is required to remove Skills.");
        }
        const preview = await client.previewSkillUninstall(workspaceId, item.id);
        if (!preview.installed || preview.installationVersion === null || !preview.directOwner) {
          throw new Error("This Skill is no longer directly installed. Refresh and try again.");
        }
        setSkillRemoval({ item, preview });
        return;
      }
      if (item.kind !== "mcp" || !item.actions.includes("disconnect")) {
        throw new Error(`${item.name} must be managed through its dedicated controls.`);
      }
      await client.disableCapability(workspaceId, item.id);
      await refresh();
      onRuntimeChanged();
      toast.success(`Disconnected ${item.name}`);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Couldn't disable");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  // --- Add custom ------------------------------------------------------------
  async function submitAddCustom(form: CapabilityFormState) {
    const input = capabilityInputFromForm(form);
    if (!input) return;
    setBusyId("add");
    try {
      const created = await client.createCapability(workspaceId, input);
      if (form.enableAfterAdd) {
        // A freshly added item may still need credentials; open the sheet so the
        // connect flow drives it rather than firing a bare enable that 422s.
        const plan = capabilityConnectPlan(created);
        if (plan.mode === "enable") {
          await client.enableCapability(workspaceId, created.id);
          if (created.kind === "mcp") onRuntimeChanged();
          toast.success(
            created.kind === "mcp"
              ? `Added and enabled ${created.name}`
              : `Added and enabled ${created.name}`,
          );
        } else {
          toast.success(`Added ${created.name}`);
          // Freshly created: the row isn't in `items` until refresh() lands, and
          // a failed refresh must not drop the connect sheet - render from the
          // returned snapshot until the live row appears.
          openItem(created, false, true);
        }
      } else {
        toast.success(`Added ${created.name}`);
      }
      setAddOpen(false);
      await refresh();
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to add capability");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  // --- Registry search -------------------------------------------------------
  async function searchRegistry() {
    const term = query.trim();
    if (!term) return;
    setRegistryBusy(true);
    try {
      const response = await client.discoverMcpCapabilities(workspaceId, {
        query: term,
        limit: 30,
      });
      setRegistryResults(response.items);
      setRegistrySearched(term);
    } catch (error) {
      setRegistryResults([]);
      setRegistrySearched(null);
      toast.error("Registry search failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRegistryBusy(false);
    }
  }

  // --- Packs actions ---------------------------------------------------------
  async function registerPackManifest(manifestDraft: string): Promise<boolean> {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestDraft);
    } catch {
      toast.error("Manifest must be valid JSON");
      return false;
    }
    try {
      const registered = await client.registerPack(
        workspaceId,
        manifest as Parameters<typeof client.registerPack>[1],
      );
      await Promise.all([packs.refresh(), refresh()]);
      toast.success(`Registered ${registered.pack.name} v${registered.pack.version}`);
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to register pack");
      toast.error(copy.title, { description: copy.description });
      return false;
    }
  }

  async function previewPackInstallation(
    pack: CapabilityPack,
    selection: { rigId?: string; variableSetId?: string },
  ): Promise<PackInstallationPreview | null> {
    setBusyId(`pack:${pack.id}`);
    try {
      return await client.previewPackInstallation(workspaceId, pack.id, selection);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to review pack installation");
      toast.error(copy.title, { description: copy.description });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  async function installPack(
    pack: CapabilityPack,
    preview: PackInstallationPreview,
    selection: { rigId?: string; variableSetId?: string },
    idempotencyKey: string,
  ): Promise<boolean> {
    setBusyId(`pack:${pack.id}`);
    try {
      await client.installPack(workspaceId, pack.id, {
        expectedManifestDigest: preview.manifestDigest,
        idempotencyKey,
        ...selection,
        ...(preview.installationVersion !== null
          ? { expectedInstallationVersion: preview.installationVersion }
          : {}),
      });
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(
        preview.action === "install"
          ? `Installed ${pack.name}`
          : preview.action === "update"
            ? `Updated ${pack.name}`
            : `Repaired ${pack.name}`,
      );
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to install pack");
      toast.error(copy.title, { description: copy.description });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function previewPackUninstall(pack: CapabilityPack): Promise<PackUninstallPreview | null> {
    setBusyId(`pack:${pack.id}`);
    try {
      return await client.previewPackUninstall(workspaceId, pack.id);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to review pack uninstall");
      toast.error(copy.title, { description: copy.description });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  async function uninstallPack(
    pack: CapabilityPack,
    preview: PackUninstallPreview,
    idempotencyKey: string,
  ): Promise<boolean> {
    if (preview.installationVersion === null) return false;
    setBusyId(`pack:${pack.id}`);
    try {
      await client.uninstallPack(workspaceId, pack.id, {
        expectedInstallationVersion: preview.installationVersion,
        idempotencyKey,
      });
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(`Uninstalled ${pack.name}`);
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to uninstall pack");
      toast.error(copy.title, { description: copy.description });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function unregisterPack(pack: CapabilityPack): Promise<boolean> {
    setBusyId(`pack:${pack.id}`);
    try {
      await client.deletePack(workspaceId, pack.id);
      await Promise.all([packs.refresh(), refresh()]);
      toast.success(`Unregistered ${pack.name}`);
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to unregister pack");
      toast.error(copy.title, { description: copy.description });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const packBusyId = busyId?.startsWith("pack:") ? busyId.slice("pack:".length) : null;

  return (
    // The app shell (RailShell) hands each route a fixed-height overflow-hidden
    // flex column, so the PAGE never body-scrolls - the route must own its own
    // vertical scroll. This root IS that scroll viewport (min-h-0 so it can
    // shrink inside the flex parent, overflow-y-auto so the tall catalog grid
    // scrolls); the centered max-width column lives inside it.
    <div
      ref={capabilityFocusFallbackRef}
      data-workspace-scroll-owner="self-managed"
      role="region"
      aria-label="Capabilities"
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader
          icon={<PlugIcon className="size-4" />}
          title="Capabilities"
          description="Connect integrations and enable the tools, packs, and skills your agents can use."
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-fg-muted transition-none disabled:opacity-100"
                onClick={refreshAll}
                disabled={loading || packs.loading}
              >
                <RefreshCwIcon className={cn((loading || packs.loading) && "animate-spin")} />
                Refresh
              </Button>
              <Button type="button" onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add MCP server
              </Button>
            </>
          }
        />

        <section className="mt-8 space-y-3" aria-labelledby="integrations-heading">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Built by OpenGeni
            </p>
            <h2 id="integrations-heading" className="mt-1 text-base font-semibold text-fg">
              Integrations
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              These do more than call tools. They receive events, post as OpenGeni, and hold their
              own identity in the other product.
            </p>
          </div>
          <div className="grid gap-2" data-integration-list>
            {integrations.map((adapter) => {
              const quickConnect = integrationQuickConnect(adapter.model);
              return (
                <IntegrationRow
                  key={adapter.model.id}
                  model={adapter.model}
                  onOpen={() => {
                    const active = document.activeElement;
                    integrationOpenerRef.current =
                      active instanceof HTMLElement && active !== document.body ? active : null;
                    setOpenIntegration(adapter.model.id);
                  }}
                  busy={integrationRowBusy(adapter.model)}
                  {...(quickConnect ? { onQuickConnect: quickConnect } : {})}
                />
              );
            })}
          </div>
        </section>

        <IntegrationSheet
          model={openIntegrationModel}
          open={openIntegrationModel !== null}
          restoreFocusRef={integrationOpenerRef}
          onOpenChange={(open) => {
            if (!open) setOpenIntegration(null);
          }}
        />
        {integrations.map((adapter) => (
          <Fragment key={adapter.model.id}>{adapter.dialogs}</Fragment>
        ))}

        <QuickConnectDialog
          request={quickConnectRequest}
          onOpenChange={(open) => {
            if (!open) setQuickConnectRequest(null);
          }}
        />

        {/*
          One <section> per top-level surface. Featured, the discovery controls,
          Enabled, Custom APIs, and Browse are all Connectors, so they live
          inside this element rather than beside it: otherwise the accessibility
          tree says they belong to no section at all.
        */}
        <section className="mt-10 space-y-3" aria-labelledby="connectors-heading">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Model Context Protocol
            </p>
            <h2 id="connectors-heading" className="mt-1 text-base font-semibold text-fg">
              Connectors
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
              Tools published by the service itself. Connect one and its tools become available to
              agents in this workspace. Featured are the ones most teams start with. Custom APIs
              (below) are workspace-defined connectors from an OpenAPI or GraphQL spec.
            </p>
          </div>

          {showFeatured ? (
            <div className="mt-4">
              <FeaturedConnectorsStrip
                items={featured}
                logoUrl={logoUrl}
                onOpen={openItem}
                health={(item) => connectionHealth(item, connections ?? [], connectionsLoaded)}
                onQuickConnect={capabilityQuickConnectAction}
              />
            </div>
          ) : null}

          <CapabilityDiscoveryControls
            query={query}
            filter={filter}
            counts={counts}
            onQueryChange={setQuery}
            onFilterChange={setFilter}
          />

          <div className="mt-8 space-y-10">
            <EnabledCapabilitiesSection
              items={enabledItems}
              busyId={busyId}
              connectionHealth={(item) =>
                connectionHealth(item, connections ?? [], connectionsLoaded)
              }
              logoUrl={logoUrl}
              onOpen={openItem}
              onDisable={(item) => void removeFromStrip(item)}
            />

            {(filter === "all" || filter === "api") &&
            (query.trim().length === 0 || visibleCustomApiInstances.length > 0) ? (
              <CustomApiSection
                instances={visibleCustomApiInstances}
                connections={connections}
                canManage={canManageApiIntegrationInstances}
                busyKey={customApiBusyKey}
                onConnect={openCustomApi}
                onUpdate={(instance) => editCustomApi(instance, "update")}
                onReconnect={(instance) => editCustomApi(instance, "reconnect")}
                onRemove={(instance) => void previewRemoveCustomApi(instance)}
              />
            ) : null}

            <CapabilityBrowseSection
              filter={filter}
              query={query}
              catalogView={catalogView}
              loadError={loadError}
              enabledCount={enabledItems.length}
              browseItems={browseItems}
              visibleBrowse={visibleBrowse}
              registryBusy={registryBusy}
              registrySearched={registrySearched}
              registryResults={visibleRegistry}
              logoUrl={logoUrl}
              health={(item) => connectionHealth(item, connections ?? [], connectionsLoaded)}
              onRetry={() => void refresh()}
              onOpen={openItem}
              onOpenRegistry={(item) => openItem(item, true)}
              onSearchRegistry={() => void searchRegistry()}
              onLoadMore={() =>
                setVisibleCount((count) => Math.min(count + PAGE_SIZE, browseItems.length))
              }
              onQuickConnect={capabilityQuickConnectAction}
            />
          </div>
        </section>

        <div ref={bundlesRef}>
          <BundlesSection
            client={client}
            workspaceId={workspaceId}
            connections={connections}
            canManage={canManageSkills}
            items={items}
            logoUrl={logoUrl}
            busyCatalogId={busyId}
            onOpenCatalogItem={openItem}
            packs={packs}
            variableSets={variableSets.variableSets.map((variableSet) => ({
              id: variableSet.id,
              name: variableSet.name,
            }))}
            rigs={rigs.rigs.map((rig) => ({
              id: rig.id,
              name: rig.name,
              image: rig.activeVersion?.image ?? null,
              available: rig.activeVersion !== null,
              verified: rig.activeVersionHealth?.checkHealth === "passing",
            }))}
            busyPackId={packBusyId}
            onRegisterPack={registerPackManifest}
            onPreviewPackInstall={previewPackInstallation}
            onInstallPack={installPack}
            onPreviewPackUninstall={previewPackUninstall}
            onUninstallPack={uninstallPack}
            onUnregisterPack={unregisterPack}
            onChanged={async () => {
              await refresh();
              onRuntimeChanged();
            }}
          />
        </div>
      </div>

      <CapabilityDetailSheet
        item={selectedItem}
        health={selectedHealth}
        logoSrc={selectedItem ? logoUrl(selectedItem) : null}
        open={selectedItem !== null}
        restoreFocusRef={sheetOpenerRef}
        restoreFocusFallbackRef={capabilityFocusFallbackRef}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setSheetError(null);
          }
        }}
        busy={busyId === selectedItem?.id}
        errorMessage={sheetError}
        socialConnections={selectedSocialConnections}
        canManageSocial={canManageSocial}
        canManageSkills={canManageSkills}
        onAction={handleAction}
      />

      <ConfirmDialog
        open={skillRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setSkillRemoval(null);
        }}
        title={skillRemoval ? `Remove Skill “${skillRemoval.item.name}”?` : "Remove Skill?"}
        description="This removes only the direct workspace installation. Plugin and Pack ownership is preserved, and no Connection or credential is deleted."
        confirmLabel="Remove Skill"
        cancelAutoFocus
        onConfirm={removeSelectedSkill}
      >
        {skillRemoval ? (
          <div className="rounded-lg border border-border bg-bg/50 p-3 text-xs leading-5 text-fg-muted">
            {skillRemoval.preview.removesRuntimeSkill
              ? "No other owner retains this Skill, so its reviewed instructions will stop loading for new agent runs."
              : `${skillRemoval.preview.remainingOwners.length} other owner${skillRemoval.preview.remainingOwners.length === 1 ? "" : "s"} will retain this Skill after the direct installation is removed.`}
          </div>
        ) : null}
      </ConfirmDialog>

      <AddCustomDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        busy={busyId === "add"}
        onSubmit={submitAddCustom}
      />

      <ConfirmDialog
        open={customApiRemoveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCustomApiRemoveTarget(null);
        }}
        title={
          customApiRemoveTarget
            ? `Remove ${customApiRemoveTarget.instance.displayName}?`
            : "Remove custom API?"
        }
        description={
          customApiRemoveTarget
            ? `This removes only this named instance${customApiRemoveTarget.removesDefinition ? " and its now-unused shared definition" : ""}. The authenticated Connection remains intact.`
            : ""
        }
        confirmLabel="Remove instance"
        destructive
        onConfirm={removeCustomApiInstance}
      />

      <Suspense fallback={null}>
        <CustomApiSetupDialog
          state={customApi}
          connections={connections}
          canManage={canManageApiIntegrationInstances}
          onOpenChange={(open) => dispatchCustomApi({ type: open ? "open" : "close" })}
          onDraftChange={(patch) => dispatchCustomApi({ type: "draft", patch })}
          onPreview={() => void previewCustomApi()}
          onAuthenticate={() => void authenticateCustomApi()}
          onInstall={() => void installCustomApi()}
          onBack={customApiBack}
          onToggleTool={toggleCustomApiTool}
        />
      </Suspense>
    </div>
  );
}

/**
 * True while this integration has a real mutation in flight, from the adapter's
 * own footer state - never inferred from a chip label.
 */
export function integrationRowBusy(model: Pick<IntegrationViewModel, "footer">): boolean {
  return model.footer.kind !== "locked" && model.footer.busy === true;
}

/**
 * The row-icon quick-connect action for an integration: only when it is
 * genuinely not connected, its adapter offers a one-click setup, and that
 * setup is neither disabled nor already running. Guarding on `busy` here is
 * what stops a double click from starting two OAuth redirects with two
 * different minted instance keys.
 */
export function integrationQuickConnect(
  model: Pick<IntegrationViewModel, "chip" | "footer">,
): (() => void) | undefined {
  const { chip, footer } = model;
  if (chip.tone !== "idle" || footer.kind !== "setup") return undefined;
  if (footer.disabled === true || footer.busy === true) return undefined;
  return footer.onSetup;
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function installedSkillVersion(item: CapabilityCatalogItem): number | null {
  const installedSkill = item.metadata.installedSkill;
  if (!installedSkill || typeof installedSkill !== "object" || Array.isArray(installedSkill)) {
    return null;
  }
  const value = (installedSkill as Record<string, unknown>).installationVersion;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
