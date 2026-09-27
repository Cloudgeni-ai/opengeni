import type { SkillSummary } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { sortConnectorsForPresentation } from "@/components/capabilities/catalog-presentation";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ConnectionCatalog, McpConnectionCard } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import { CapabilityMark } from "@/components/capabilities/capability-page";
import { CatalogItemPage } from "@/components/capabilities/catalog-item-page";
import {
  CapabilityPageSlotContext,
  type CapabilityPageSlotValue,
} from "@/components/capabilities/capability-page-slot";
import { IntegrationPage } from "@/components/capabilities/integration-page";
import { ProviderPage, type ProviderMode } from "@/components/capabilities/provider-page";
import {
  capabilityDescription,
  isCommunityCapability,
  OWNERSHIP_HELP,
  personalOnlyCapability,
} from "@/components/capabilities/capability-copy";
import { ConnectionAccessNotice } from "@/components/capabilities/connection-access-notice";
import {
  catalogServiceIdentity,
  mergeConnectionServices,
  partitionConnectionServices,
} from "@/components/capabilities/connection-services";
import { capabilityStateChip } from "@/lib/capabilities";
import { CatalogHeader, CatalogActionContext } from "@/components/capabilities/catalog-header";
import { performCapabilityAction } from "@/components/capabilities/perform-capability-action";

// Capabilities has one overview and dedicated Connections, Skills, and Plugins
// tabs. Connections group provider accounts and use the normal connection
// authorization flow. Imported Skills and Plugins retain their own lifecycle
// controls; they are not projected into the connector catalog.

import { PlugIcon, PlusIcon } from "lucide-react";

import { CapabilitiesLegacyRedirect } from "@/routes/capabilities-legacy-redirect";
import {
  Fragment,
  Suspense,
  useLayoutEffect,
  type ReactNode,
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SkillsPanel } from "./skills-panel";
import { skillReleaseMessage } from "@/components/capabilities/skill-release-message";
import { PluginSearch } from "@/components/capabilities/capability-catalog-sections";
import { capabilityLogoSource } from "@/components/capabilities/capability-logo-source";
import { type ConnectAction } from "@/components/capabilities/capability-detail-sheet";
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
import { featuredConnectors } from "@/components/capabilities/featured-connectors";
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
import { PrReviewSetupCard } from "@/components/capabilities/pr-review-setup-card";
import { Button } from "@/components/ui/button";
import { DetailPage } from "@/components/ui/detail-page";
import { DetailSkeleton } from "@/components/ui/detail-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAppContext } from "@/context";
import {
  capabilityConnectPlan,
  capabilityErrorToast,
  capabilityInputFromForm,
  connectionHealth,
  isConnectorCatalogItem,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthConnectionRef,
  catalogConnectionAccountSelection,
  oauthConnectionOwnership,
  oauthResumeAction,
  registryResultsForQuery,
  resolveSheetItem,
  type CapabilityFilter,
  type CapabilityFormState,
  type ConnectionHealth,
  type SheetSelection,
} from "@/lib/capabilities";
import {
  mcpOAuthCallbackFailureMessage,
  oauthCallbackReasonMessage,
} from "@/lib/oauth-callback-messages";
import {
  personalGitHubOAuthFailureMessage,
  personalGitHubOAuthReturn,
} from "@/lib/personal-github-oauth";
import { hasWorkspacePermission } from "@/lib/permissions";
import { request } from "@/api";

// Custom API creation is a fundamentally different "define a new connector
// from a spec" flow (paste a URL, preview, pick tools, authenticate, create),
// not a catalog connect - its own multi-phase dialog stays lazy since it is
// only needed once a workspace admin opens "Add custom API".
const CustomApiSetupDialog = lazy(async () => {
  const module = await import("@/components/capabilities/custom-api-setup-dialog");
  return { default: module.CustomApiSetupDialog };
});

import {
  catalogStatusForChip,
  connectionAccessChip,
  connectionAccessModel,
  type IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";

import type {
  AccessContext,
  ApiIntegrationInstallationSummary,
  CapabilityCatalogItem,
  ConnectionMetadata,
  ConnectionOwnership,
  SkillUninstallPreview,
} from "@/types";

// Served from this chunk so `/integrations` adds no route chunk of its own.
export { IntegrationsReturnRoute } from "@/routes/capabilities-legacy-redirect";

/** About 30 popular providers before search; the registry long tail needs a search. */
const POPULAR_LIMIT = 30;

/** Row copy for integrations whose adapter description is written for the page, not the row. */
const INTEGRATION_ROW_COPY: Record<string, string> = {
  github: "Work on repositories, issues, and pull requests.",
  "google-drive": "Let agents read the Drive folders you choose.",
};

/** One row per provider: the outcome sentence for providers with several modes. */
const SERVICE_ROW_COPY: Record<string, string> = {
  slack: "Chat with OpenGeni in Slack, or let it read and send messages as you.",
  atlassian: "Read and update the issues and pages you can already see.",
};

/** The modes of a multi-mode provider, as outcomes. Keyed by service, then option id. */
function providerModeCopy(
  serviceId: string,
  optionName: string,
): { title: string; description: string } | null {
  if (serviceId === "slack") {
    return optionName === "OpenGeni bot"
      ? {
          title: "Add OpenGeni to Slack",
          description: "Everyone can mention or message OpenGeni in your Slack workspace.",
        }
      : {
          title: "Connect your own Slack",
          description: "Agents read and send messages as you. Only work you start can use it.",
        };
  }
  if (serviceId === "atlassian") {
    return optionName === "Knowledge sync"
      ? {
          title: "Sync Jira and Confluence",
          description: "Keep chosen projects and spaces searchable as workspace knowledge.",
        }
      : {
          title: "Let agents work in Jira and Confluence",
          description: "Read and update the issues and pages you can already see in Atlassian.",
        };
  }
  return null;
}

/** Keep the OAuth-return connection read alive even when the catalog read fails. */
export function fetchOAuthReturnRows(
  client: Pick<OpenGeniBrowserClient, "listCapabilities">,
  workspaceId: string,
  fetchConnections: () => Promise<ConnectionMetadata[] | null>,
) {
  return Promise.all([client.listCapabilities(workspaceId), fetchConnections()]);
}

export function canManageApiIntegrations(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  return hasWorkspacePermission(accessContext, workspaceId, "capabilities:manage");
}

type CapabilitiesRouteProps = {
  workspaceId: string;
  initialSection?: "skills";
  slackLinkToken?: string;
  legacyRedirect?: boolean;
};

export function CapabilitiesRoute(props: CapabilitiesRouteProps) {
  return props.legacyRedirect ? (
    <CapabilitiesLegacyRedirect workspaceId={props.workspaceId} section={props.initialSection} />
  ) : (
    <CapabilitiesBody {...props} />
  );
}

function CapabilitiesBody({ workspaceId, initialSection, slackLinkToken }: CapabilitiesRouteProps) {
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
    connectionsAccessDenied,
    replaceConnection,
    fetchConnections,
    apiIntegrationDefinitions,
    apiIntegrationInstances,
    socialConnections,
    slackInstallationBindings,
    loading,
    loadError,
    refresh,
  } = catalogData;
  const [catalogActionTarget, setCatalogActionTarget] = useState<HTMLDivElement | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Connectors-only discovery: the chips offer exactly the kinds that grid can

  // now, so it scrolls that section into view instead.
  const [filter] = useState<CapabilityFilter>("all");
  const [activeTab, setActiveTab] = useState(initialSection === "skills" ? "skills" : "all");
  const [query, setQuery] = useState("");
  const hasQuery = query.trim().length > 0;
  const searchingAll = activeTab === "all";

  // Detail/connect sheet. We store the id (+ registry flag + a snapshot for
  // registry items not yet in the catalog), NOT the item object: the rendered
  // item is derived from the LIVE `items` list by id, so any mutation + refresh

  // of leaving it on a stale snapshot that could re-enable what was just disabled.
  // Every row opens its own page inside this route, addressed by `?open=`:
  //   integration:<id>  an integration OpenGeni runs (Slack bot, GitHub, Drive)
  //   item:<id>         a catalog entry (connection, first-party API, skill)
  //   service:<id>      one provider with several ways to use it (Slack, Jira)
  // The catalog stays mounted underneath, so Back returns to the same tab,
  // search and scroll position.
  const navigate = useNavigate();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const openKey = new URLSearchParams(searchStr).get("open");
  const goTo = useCallback(
    (key: string | null, replace = false) => {
      const url = new URL(window.location.href);
      if (key) url.searchParams.set("open", key);
      else url.searchParams.delete("open");
      void navigate({ href: `${url.pathname}${url.search}${url.hash}`, replace });
    },
    [navigate],
  );
  // Strip one-shot return parameters (OAuth outcomes) but keep the open page.
  const clearReturnParams = useCallback(() => {
    const open = new URLSearchParams(window.location.search).get("open");
    const next = open ? `?open=${encodeURIComponent(open)}` : "";
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${next}`);
    void navigate({ href: `${window.location.pathname}${next}`, replace: true });
  }, [navigate]);
  const [selectionSnapshot, setSelectionSnapshot] = useState<SheetSelection | null>(null);
  const itemKey = openKey?.startsWith("item:") ? openKey.slice("item:".length) : null;
  const selected: SheetSelection | null = useMemo(() => {
    if (!itemKey) return null;
    if (selectionSnapshot?.id === itemKey) return selectionSnapshot;
    const live = items.find((entry) => entry.id === itemKey);
    return live ? { id: live.id, registry: false, snapshotFallback: false, snapshot: live } : null;
  }, [itemKey, selectionSnapshot, items]);
  const setSelected = useCallback(
    (next: SheetSelection | null, replace = false) => {
      if (next) {
        setSelectionSnapshot(next);
        goTo(`item:${next.id}`, replace);
        return;
      }
      setSelectionSnapshot(null);
      const open = new URLSearchParams(window.location.search).get("open");
      if (open?.startsWith("item:")) goTo(null, replace);
    },
    [goTo],
  );
  const [accountConnectOpen, setAccountConnectOpen] = useState(false);
  // The catalog's scroll position, restored when a page closes.
  const catalogScroll = useRef(0);
  const captureCatalogScroll = () => {
    if (!new URLSearchParams(window.location.search).get("open")) {
      catalogScroll.current = capabilityFocusFallbackRef.current?.scrollTop ?? 0;
    }
  };
  useEffect(() => setAccountConnectOpen(false), [itemKey]);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  // The element that opened the integration sheet, captured synchronously so
  // closing it returns focus to that row instead of dropping it on the body.
  const integrationOpenerRef = useRef<HTMLElement | null>(null);
  const capabilityFocusFallbackRef = useRef<HTMLDivElement | null>(null);

  // Bundles now, so that deep link scrolls the Bundles section into view
  // instead of selecting a kind filter the Connectors grid no longer offers.
  const bundlesRef = useRef<HTMLDivElement | null>(null);
  const [skillsRevision, setSkillsRevision] = useState(0);
  const [canonicalSkills, setCanonicalSkills] = useState<SkillSummary[]>([]);
  const openSkillRef = useRef<((id: string) => void) | null>(null);
  const importSkillRef = useRef<(() => void) | null>(null);

  const catalogToolbar = useMemo(
    () => ({
      target: catalogActionTarget,
      activeTitle: searchingAll
        ? ""
        : activeTab === "connections"
          ? "Connections"
          : activeTab === "skills"
            ? "Skills"
            : "Plugins",
    }),
    [catalogActionTarget, searchingAll, activeTab],
  );
  const [sheetError, setSheetError] = useState<string | null>(null);
  // A callback outcome that names no catalog item (for example a stale link
  // forwarded from `/integrations`) stays on the page until dismissed, so the
  // explanation and the way to retry don't vanish with a toast.
  const [callbackNotice, setCallbackNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // Which integration's page is open.
  const openIntegration = openKey?.startsWith("integration:")
    ? openKey.slice("integration:".length)
    : null;
  const setOpenIntegration = useCallback(
    (id: string | null, replace = false) => goTo(id ? `integration:${id}` : null, replace),
    [goTo],
  );
  const openService = openKey?.startsWith("service:") ? openKey.slice("service:".length) : null;
  // Older links (Slack install return, `?integration=slack`) open the Slack page.
  const legacySlackLinkHandled = useRef(false);
  useEffect(() => {
    if (legacySlackLinkHandled.current) return;
    legacySlackLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("open") && (params.get("integration") === "slack" || params.has("slack"))) {
      setOpenIntegration("slack", true);
    }
  }, [setOpenIntegration]);
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

  // Public MCP registry search (only offered when the catalog has no matches).
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [registrySearched, setRegistrySearched] = useState<string | null>(null);

  // The Connectors surface owns exactly MCP servers and API connectors. Skills,

  // filtered by the chips) so no Enabled, Browse, or search result can ever
  // contain one, and so the chip counts describe what this grid can show.
  const connectorItems = useMemo(() => items.filter(isConnectorCatalogItem), [items]);
  // The Featured strip shows curated connectors when nothing narrows the list;
  // the grid then carries the long tail. A search or a non-MCP filter hides the
  // strip and the grid shows every match again. The partition is stable, so
  // within the featured and non-featured groups the server order (kind,
  // category, name) is preserved.
  const featured = useMemo(() => featuredConnectors(connectorItems), [connectorItems]);
  // One placement per integration: a featured tile carries its own Enabled
  // badge, so an enabled featured item stays in the strip and is excluded from
  // the Enabled section; everything else enabled lives in the Enabled section
  // and Browse shows only the rest of the catalog.
  // Custom APIs answer the same search as every other connector: a query that
  // matches nothing here must not still list every workspace-defined API.
  const visibleCustomApiInstances = useMemo(
    () => filterCustomApiInstances(customApiInstances, query),
    [customApiInstances, query],
  );

  // Community entries never hotlink a third-party logo: many are blank or
  // white-on-transparent marks, and each row would call out to the registry.
  const logoUrl = useCallback(
    (item: CapabilityCatalogItem) =>
      isCommunityCapability(item)
        ? item.logoAssetPath
          ? client.catalogAssetUrl(item.logoAssetPath)
          : null
        : capabilityLogoSource(item, (path) => client.catalogAssetUrl(path)),
    [client],
  );
  const connectionsLoaded = connections !== null;
  const connectionsRetryable = connectionsLoadFailed && !connectionsAccessDenied;
  const canManageApiIntegrationInstances = canManageApiIntegrations(
    context.accessContext,
    workspaceId,
  );
  const canManageSkills = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "capabilities:manage",
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
    connectionsLoadFailed: connectionsRetryable,
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
    connectionsLoadFailed: connectionsRetryable,
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
    { ...slack, model: connectionAccessModel(slack.model, connectionsAccessDenied) },
    github,
    { ...googleDrive, model: connectionAccessModel(googleDrive.model, connectionsAccessDenied) },
    { ...atlassian, model: connectionAccessModel(atlassian.model, connectionsAccessDenied) },
    outlookMail,
    outlookCalendar,
    outlookContacts,
    oneDrive,
  ];
  const connectorChip = (item: CapabilityCatalogItem) =>
    connectionAccessChip(
      capabilityStateChip(item, connectionHealth(item, connections ?? [], connectionsLoaded)),
      connectionsAccessDenied,
    );
  const openIntegrationFrom = () => {
    integrationOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    captureCatalogScroll();
  };
  const slackBotMode = slack.catalogName === "OpenGeni bot";
  const allConnectionServices = mergeConnectionServices([
    ...integrations.map(({ model }) => ({
      id: model.id,
      name: model.name,
      logo: (
        <CapabilityMark
          src={"logoSrc" in model.mark ? model.mark.logoSrc : null}
          name={model.name}
        />
      ),
      options: [
        {
          id: model.id,
          name:
            model.id === "slack"
              ? slack.catalogName
              : model.id === "atlassian"
                ? "Knowledge sync"
                : model.name,
          description: INTEGRATION_ROW_COPY[model.id] ?? model.description,
          status: model.chip.label,
          state: catalogStatusForChip(model.chip),
          connected: model.chip.label === "Connected" || model.chip.label === "Needs attention",
          onOpen: () => {
            openIntegrationFrom();
            setOpenIntegration(model.id);
          },
        },
      ],
    })),
    ...sortConnectorsForPresentation(connectorItems)
      // Without the bot, the Slack integration already is "your account".
      .filter(
        (item) =>
          !(
            !slackBotMode &&
            catalogServiceIdentity(item.id, item.name, item.providerDomain).id === "slack"
          ),
      )
      .map((item) => ({
        ...catalogServiceIdentity(item.id, item.name, item.providerDomain),
        logo: <CapabilityMark src={logoUrl(item)} name={item.name} />,
        options: [
          {
            id: item.id,
            name:
              catalogServiceIdentity(item.id, item.name, item.providerDomain).id === "slack"
                ? "Your account"
                : "Agent tools",
            description: capabilityDescription(item) ?? undefined,
            status: connectorChip(item).label,
            state: catalogStatusForChip(connectorChip(item)),
            connected: item.enabled,
            onOpen: () => openItem(item),
          },
        ],
      })),
  ]);
  // One row per provider: a provider with several modes opens its own page,
  // where the mode is chosen as an outcome.
  const connectionServices = allConnectionServices.map((service) => {
    if (service.options.length < 2) return service;
    const attention = service.options.find((option) => option.state === "attention");
    const working = service.options.some((option) => option.state === "loading");
    const connected = service.options.some((option) => option.connected);
    return {
      ...service,
      options: [
        {
          id: service.id,
          name: service.name,
          description: SERVICE_ROW_COPY[service.id] ?? service.options[0]?.description,
          status: attention?.status ?? (connected ? "Connected" : "Not connected"),
          state: attention
            ? ("attention" as const)
            : working
              ? ("loading" as const)
              : connected
                ? ("added" as const)
                : ("available" as const),
          connected,
          onOpen: () => {
            openIntegrationFrom();
            goTo(`service:${service.id}`);
          },
        },
      ],
    };
  });
  const { featuredServices, remainingServices } = partitionConnectionServices(
    connectionServices,
    true,
    featured,
    integrations.map(({ model }) => model.id),
    connectorItems,
  );
  // Connected first, then about 30 popular providers. The long tail of the
  // public registry is reached only by searching, labelled Community.
  const connectedServices = connectionServices.filter((service) =>
    service.options.some((option) => option.connected || option.state === "attention"),
  );
  const popularServices = featuredServices
    .filter((service) => !connectedServices.includes(service))
    .slice(0, POPULAR_LIMIT);
  const communityServices = remainingServices.filter(
    (service) => !connectedServices.includes(service),
  );
  const openIntegrationModel =
    integrations.find((adapter) => adapter.model.id === openIntegration)?.model ?? null;
  // The item the sheet renders, always from the live catalog. Registry items
  // aren't in `items` until persisted, so they fall back to their snapshot; a
  // non-registry selection with no live row resolves to null and the effect
  // below closes the sheet rather than render a ghost.
  const [authInspection, setAuthInspection] = useState<{
    id: string;
    url: string;
    kind: "oauth2" | "none" | "unknown";
  } | null>(null);
  const rawSelectedItem: CapabilityCatalogItem | null = useMemo(
    () => resolveSheetItem(selected, items),
    [selected, items],
  );
  const inspectUrl = rawSelectedItem?.mcpUrl ?? rawSelectedItem?.endpointUrl;
  const selectedItemId = rawSelectedItem?.id;
  const needsAuthInspection =
    rawSelectedItem?.kind === "mcp" &&
    !rawSelectedItem.enabled &&
    capabilityConnectPlan(rawSelectedItem).mode === "setup_required" &&
    Boolean(inspectUrl);
  useEffect(() => {
    if (!needsAuthInspection || !selectedItemId || !inspectUrl) return;
    let active = true;
    const id = selectedItemId;
    setAuthInspection(null);
    void client.inspectMcpAuthentication(workspaceId, inspectUrl).then(
      (result) => {
        if (active) setAuthInspection({ id, url: inspectUrl, kind: result.kind });
      },
      () => {
        if (active) setAuthInspection({ id, url: inspectUrl, kind: "unknown" });
      },
    );
    return () => {
      active = false;
    };
  }, [client, workspaceId, selectedItemId, inspectUrl, needsAuthInspection]);
  const inspection =
    authInspection?.id === rawSelectedItem?.id && authInspection?.url === inspectUrl
      ? authInspection
      : null;
  const selectedItem =
    rawSelectedItem && needsAuthInspection
      ? {
          ...rawSelectedItem,
          authKind:
            inspection?.kind === "oauth2"
              ? ("oauth2" as const)
              : inspection?.kind === "none"
                ? ("none" as const)
                : null,
          metadata: { ...rawSelectedItem.metadata, authDiscovery: inspection?.kind ?? "checking" },
        }
      : rawSelectedItem;
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
  const canReadConnections =
    context.accessContext === null
      ? null
      : hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, canReadConnections]);

  const fikenOAuthHandled = useRef(false);
  useEffect(() => {
    if (fikenOAuthHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("fiken");
    if (!outcome) return;
    fikenOAuthHandled.current = true;
    const reason = params.get("reason");
    clearReturnParams();
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
              : // An expired or reused link is not a reason to switch to a token.
                (oauthCallbackReasonMessage(reason) ??
                "Try again, or connect with a personal API token instead."),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const slackUserLinkHandled = useRef(false);
  useEffect(() => {
    if (!slackLinkToken || slackUserLinkHandled.current) return;
    slackUserLinkHandled.current = true;
    clearReturnParams();
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
  }, [slackLinkToken, workspaceId, clearReturnParams]);

  // Close the page if a live-bound selection vanished from the catalog after a
  // refresh (deleted/unregistered elsewhere) - never leave a ghost open. A
  // snapshot-fallback selection (registry result, or a just-created item not yet
  // in `items`, e.g. after a failed refresh) legitimately isn't in the catalog
  // yet, so it renders from its snapshot instead of being closed here.
  useEffect(() => {
    if (loading || !itemKey) return;
    if (selected?.snapshotFallback) return;
    if (!items.some((entry) => entry.id === itemKey)) {
      setSelected(null, true);
      setSheetError(null);
    }
  }, [itemKey, selected, items, loading, setSelected]);

  // Registry hits stay in state after a search; gate them on the searched term
  // still matching the live query so an old search never renders against a new
  // one (invalidation without a clearing effect that flashes stale tiles first).
  const visibleRegistry = registryResultsForQuery(query, registrySearched, registryResults);

  // `snapshotFallback` defaults to `registry` (a registry result renders from its
  // snapshot until persisted); the add-custom flow passes it explicitly for a
  // just-created item whose row may not be in `items` yet.
  function openItem(item: CapabilityCatalogItem, registry = false, snapshotFallback = registry) {
    const active = document.activeElement;
    sheetOpenerRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setSheetError(null);
    captureCatalogScroll();
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

  // --- Connect flows ---------------------------------------------------------

  async function handleAction(action: ConnectAction) {
    if (!selected || !selectedItem || busyId !== null) return;
    setBusyId(selectedItem.id);
    setSheetError(null);
    try {
      await performCapabilityAction(
        {
          client,
          workspaceId,
          item: selectedItem,
          registry: selected.registry,
          connections: connectionsLoadFailed ? null : connections,
          canManageSkills,
          refresh,
          onRuntimeChanged,
          // The page stays open and shows the new state.
          onComplete: () => setSheetError(null),
          onSkillRemoval: setSkillRemoval,
          connectReturnUrl: window.location.href,
          returnPathFor: (id) =>
            `${window.location.pathname}?connect_item=${encodeURIComponent(id)}`,
          redirect: (url) => window.location.assign(url),
        },
        action,
      );
    } catch (error) {
      await refresh();
      const copy = capabilityErrorToast(error, "Something went wrong");
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
          skillReleaseMessage(result.skillReleases) ??
          (result.status === "retained_by_other_owners"
            ? "Another Plugin still owns this Skill, so it remains available."
            : "The Skill is no longer active in this workspace."),
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

  const personalGitHubOAuthHandled = useRef(false);
  useEffect(() => {
    if (personalGitHubOAuthHandled.current) return;
    const result = personalGitHubOAuthReturn(window.location.search);
    if (!result) return;
    personalGitHubOAuthHandled.current = true;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${result.cleanedSearch}${window.location.hash}`,
    );
    setOpenIntegration("github", true);
    if (result.outcome === "success") {
      void context.refreshPersonalGitHub(workspaceId).then(() => {
        toast.success("Your GitHub identity is connected");
      });
      return;
    }
    toast.error("Couldn't connect your GitHub identity", {
      description: personalGitHubOAuthFailureMessage(result.reason),
    });
  }, [context, workspaceId, setOpenIntegration]);

  const socialOAuthHandled = useRef(false);
  useEffect(() => {
    if (socialOAuthHandled.current || loading) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("social_oauth");
    if (!outcome) return;
    socialOAuthHandled.current = true;
    const itemId = params.get("connect_item");
    const accountHandle = params.get("accountHandle");
    clearReturnParams();
    if (outcome === "success") {
      void refresh();
      toast.success(accountHandle ? `Connected @${accountHandle}` : "Social account connected");
      return;
    }
    const reason = params.get("reason");
    const item = itemId ? (items.find((candidate) => candidate.id === itemId) ?? null) : null;
    const message =
      oauthCallbackReasonMessage(reason) ??
      (reason ? `Couldn't connect: ${reason}.` : "Couldn't connect. Please try again.");
    if (item) {
      setSheetError(message);
      setSelected(
        {
          id: item.id,
          registry: false,
          snapshotFallback: false,
          snapshot: item,
        },
        true,
      );
    } else {
      setCallbackNotice(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items, setQuery]);

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
    clearReturnParams();

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
        setSelected(
          {
            id: item.id,
            registry: false,
            snapshotFallback: false,
            snapshot: item,
          },
          true,
        );
      } else {
        setCallbackNotice(message);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items, setQuery]);

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
    clearReturnParams();
    const item = items.find((candidate) => candidate.id === capabilityId);
    if (item) {
      setSelected(
        {
          id: item.id,
          registry: false,
          snapshotFallback: false,
          snapshot: item,
        },
        true,
      );
    } else {
      setQuery(capabilityId.replace(/^[^:]+:/, ""));
      toast.error("That recommended capability is no longer available");
    }
  }, [loading, items, setQuery, setSelected, clearReturnParams]);

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
    clearReturnParams();
    const target = normalizeProviderDomain(domain);
    const item = items.find(
      (candidate) =>
        candidate.enabled &&
        candidate.connectionRef &&
        normalizeProviderDomain(candidate.connectionRef.providerDomain) === target,
    );
    if (item) {
      setSelected(
        {
          id: item.id,
          registry: false,
          snapshotFallback: false,
          snapshot: item,
        },
        true,
      );
    } else {
      setQuery(domain);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items, setQuery]);

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
      const [catalog, conns] = await fetchOAuthReturnRows(client, workspaceId, fetchConnections);
      freshItems = catalog.items;
      setItems(catalog.items);
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
        connectionRef: oauthConnectionRef(
          resolvedOwnership,
          connectionId!,
          refDomain,
          catalogConnectionAccountSelection(item!),
        ),
      });
      await refresh();
      onRuntimeChanged();
      // An already-enabled item reached here only because its old connection row
      // was gone and OAuth minted a new one - that's a reconnect, not a first enable.
      toast.success(
        item!.enabled ? `Reconnected ${item!.name}` : `Connected and enabled ${item!.name}`,
      );
    } catch (error) {
      const copy = capabilityErrorToast(error, "Couldn't finish connecting");
      setSheetError(copy.description);
      // Reopen the sheet on the item so the failure has a Retry, when resolvable.
      const item = itemId
        ? ((freshItems ?? items).find((candidate) => candidate.id === itemId) ?? null)
        : null;
      if (item)
        setSelected(
          {
            id: item.id,
            registry: false,
            snapshotFallback: false,
            snapshot: item,
          },
          true,
        );
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

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

  // Search matches the same text the catalog rows show.
  const searchTerm = query.trim().toLowerCase();
  const serviceMatches = (service: (typeof connectionServices)[number]) =>
    [service.name, ...service.options.flatMap((option) => [option.name, option.description ?? ""])]
      .join(" ")
      .toLowerCase()
      .includes(searchTerm);
  const searchReviewed = hasQuery
    ? [
        ...connectedServices,
        ...featuredServices.filter((service) => !connectedServices.includes(service)),
      ].filter(serviceMatches)
    : [];
  const searchCommunity = hasQuery ? communityServices.filter(serviceMatches) : [];

  // --- The page for whatever row was opened ----------------------------------
  const serviceOf = (optionId: string) =>
    allConnectionServices.find(
      (service) =>
        service.options.length > 1 && service.options.some((option) => option.id === optionId),
    ) ?? null;
  const backFrom = (optionId: string) => {
    const service = serviceOf(optionId);
    return service
      ? { label: service.name, onBack: () => goTo(`service:${service.id}`) }
      : { label: "Capabilities", onBack: () => goTo(null) };
  };
  const servicePage = openService
    ? (allConnectionServices.find(
        (service) => service.id === openService && service.options.length > 1,
      ) ?? null)
    : null;
  const pageOpen = openKey !== null;
  let detailPage: ReactNode = null;
  if (openIntegrationModel) {
    const back = backFrom(openIntegrationModel.id);
    detailPage = (
      <IntegrationPage
        model={openIntegrationModel}
        onBack={back.onBack}
        backLabel={back.label}
        setupLabel={
          openIntegrationModel.id === "slack"
            ? slackBotMode
              ? "Add OpenGeni to Slack"
              : "Connect your Slack"
            : undefined
        }
      />
    );
  } else if (selectedItem) {
    const back = backFrom(selectedItem.id);
    detailPage = (
      <CatalogItemPage
        key={selectedItem.id}
        workspaceId={workspaceId}
        item={selectedItem}
        health={selectedHealth}
        logoSrc={logoUrl(selectedItem)}
        busy={busyId === selectedItem.id}
        errorMessage={sheetError}
        socialConnections={selectedSocialConnections}
        canManageSocial={canManageSocial}
        canManageSkills={canManageSkills}
        onAction={(action) => void handleAction(action)}
        onConnectAccount={() => setAccountConnectOpen(true)}
        onBack={() => {
          setSheetError(null);
          back.onBack();
        }}
        backLabel={back.label}
      />
    );
  } else if (servicePage) {
    const modes: ProviderMode[] = servicePage.options.map((option) => {
      const copy = providerModeCopy(servicePage.id, option.name);
      return {
        id: option.id,
        title: copy?.title ?? option.name,
        description: copy?.description ?? option.description ?? "",
        status: option.status,
        onOpen: option.onOpen,
      };
    });
    detailPage = (
      <ProviderPage
        name={servicePage.name}
        mark={servicePage.logo}
        description={SERVICE_ROW_COPY[servicePage.id] ?? ""}
        modes={modes}
        onBack={() => goTo(null)}
      />
    );
  } else if (
    pageOpen &&
    (openKey.startsWith("item:") ||
      openKey.startsWith("integration:") ||
      openKey.startsWith("service:"))
  ) {
    detailPage = (
      <DetailPage back={{ label: "Capabilities", onClick: () => goTo(null) }}>
        {loading ? (
          <DetailSkeleton />
        ) : (
          <EmptyState
            variant="page"
            icon={<PlugIcon />}
            title="This isn't available here"
            description="It may have been removed from the catalog, or you may not have access to it."
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => goTo(null)}>
                Back to Capabilities
              </Button>
            }
          />
        )}
      </DetailPage>
    );
  }

  const [pageSlotTarget, setPageSlotTarget] = useState<HTMLDivElement | null>(null);
  const pageSlot = useMemo<CapabilityPageSlotValue>(
    () => ({
      target: pageSlotTarget,
      openKey,
      open: (key, options) => {
        const active = document.activeElement;
        sheetOpenerRef.current =
          active instanceof HTMLElement && active !== document.body ? active : null;
        captureCatalogScroll();
        goTo(key, options?.replace);
      },
      close: (options) => goTo(null, options?.replace),
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- captureCatalogScroll reads refs only
    [pageSlotTarget, openKey, goTo],
  );

  // Back on the catalog: the same scroll position, focus on the row that opened the page.
  const wasPageOpen = useRef(pageOpen);
  useLayoutEffect(() => {
    if (wasPageOpen.current && !pageOpen) {
      const root = capabilityFocusFallbackRef.current;
      if (root) root.scrollTop = catalogScroll.current;
      const opener = [sheetOpenerRef.current, integrationOpenerRef.current].find(
        (element) => element?.isConnected,
      );
      opener?.focus({ preventScroll: true });
      sheetOpenerRef.current = null;
      integrationOpenerRef.current = null;
    }
    wasPageOpen.current = pageOpen;
  }, [pageOpen]);

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
      <CapabilityPageSlotContext.Provider value={pageSlot}>
        {pageOpen ? detailPage : null}
        <div ref={setPageSlotTarget} data-capability-page-slot="" />
        <div hidden={pageOpen} className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
          <PageHeader
            icon={<PlugIcon className="size-4" />}
            title="Capabilities"
            description="Tools, skills, and plugins your agents can use."
          />

          {(connectionsAccessDenied ||
            (context.accessContext?.workspaceGrants.some(
              (grant) => grant.workspaceId === workspaceId,
            ) &&
              !hasWorkspacePermission(context.accessContext, workspaceId, "connections:read"))) && (
            <ConnectionAccessNotice />
          )}

          {callbackNotice ? (
            <Notice tone="failed" title="Couldn't finish connecting" className="mt-4">
              <p role="alert">{callbackNotice}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCallbackNotice(null);
                    setQuery("");
                    setActiveTab("connections");
                  }}
                >
                  Show connections
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setCallbackNotice(null)}
                >
                  Dismiss
                </Button>
              </div>
            </Notice>
          ) : null}

          <PluginSearch query={query} onQueryChange={setQuery} scope={activeTab} />
          <CatalogActionContext.Provider value={catalogToolbar}>
            <Tabs
              className="capabilities-tabs"
              value={activeTab}
              onValueChange={(value) => {
                setActiveTab(value);
              }}
            >
              <div className="capabilities-tab-bar">
                <TabsList variant="line" aria-label="Capability types">
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="connections">Connections</TabsTrigger>
                  <TabsTrigger value="skills">Skills</TabsTrigger>
                  <TabsTrigger value="plugins">Plugins</TabsTrigger>
                </TabsList>
                <div ref={setCatalogActionTarget} className="capabilities-tab-action" />
              </div>

              <TabsContent value={activeTab} forceMount>
                <div hidden={!searchingAll && activeTab !== "connections"}>
                  {!searchingAll ? (
                    <CatalogHeader
                      title="Connections"
                      action={
                        <Button type="button" onClick={() => setAddOpen(true)}>
                          <PlusIcon />
                          Add connection
                        </Button>
                      }
                    />
                  ) : null}

                  {loading && items.length === 0 ? (
                    <p role="status" className="mt-6 text-sm text-fg-muted">
                      Loading connections…
                    </p>
                  ) : hasQuery ? (
                    <>
                      {searchReviewed.length > 0 ? (
                        <section aria-label="Connections" className="mt-6">
                          <h2 className="mb-2 text-sm font-semibold">Connections</h2>
                          <ConnectionCatalog
                            grouped={false}
                            columns={2}
                            {...(searchingAll
                              ? { resultLimit: 6, onShowMore: () => setActiveTab("connections") }
                              : {})}
                            services={
                              searchingAll
                                ? [...searchReviewed, ...searchCommunity]
                                : searchReviewed
                            }
                          />
                        </section>
                      ) : null}
                      {!searchingAll && searchCommunity.length > 0 ? (
                        <section aria-label="Community" className="mt-6">
                          <h2 className="text-sm font-semibold">Community</h2>
                          <p className="mt-1 mb-2 text-xs leading-4.5 text-fg-muted">
                            From the public registry. Not reviewed by OpenGeni.
                          </p>
                          <ConnectionCatalog
                            grouped={false}
                            columns={2}
                            services={searchCommunity}
                          />
                        </section>
                      ) : null}
                      {searchReviewed.length === 0 &&
                      (searchingAll || searchCommunity.length === 0) ? (
                        searchingAll && searchCommunity.length > 0 ? (
                          <section aria-label="Connections" className="mt-6">
                            <h2 className="mb-2 text-sm font-semibold">Connections</h2>
                            <ConnectionCatalog
                              grouped={false}
                              columns={2}
                              resultLimit={6}
                              onShowMore={() => setActiveTab("connections")}
                              services={searchCommunity}
                            />
                          </section>
                        ) : (
                          <p role="status" className="mt-6 text-sm leading-5 text-fg-muted">
                            {`No connections match "${query.trim()}". `}
                            <button
                              type="button"
                              className="font-medium text-brand hover:underline"
                              onClick={() => setQuery("")}
                            >
                              Clear search
                            </button>
                          </p>
                        )
                      ) : null}
                    </>
                  ) : searchingAll ? (
                    <section aria-label="Connections" className="mt-6">
                      <h2 className="mb-2 text-sm font-semibold">Connections</h2>
                      <ConnectionCatalog
                        grouped={false}
                        columns={2}
                        resultLimit={6}
                        onShowMore={() => setActiveTab("connections")}
                        services={[...connectedServices, ...popularServices]}
                      />
                    </section>
                  ) : (
                    <>
                      {connectedServices.length > 0 ? (
                        <section aria-label="Connected" className="mt-6">
                          <h2 className="mb-2 text-sm font-semibold">Connected</h2>
                          <ConnectionCatalog
                            grouped={false}
                            columns={2}
                            services={connectedServices}
                          />
                        </section>
                      ) : null}
                      <section aria-label="Popular" className="mt-6">
                        <h2 className="mb-2 text-sm font-semibold">Popular</h2>
                        <ConnectionCatalog grouped={false} columns={2} services={popularServices} />
                        {communityServices.length > 0 ? (
                          <p className="mt-4 text-xs leading-4.5 text-fg-muted">
                            {`Search to find ${communityServices.length} more community connections from the public registry.`}
                          </p>
                        ) : null}
                      </section>
                    </>
                  )}

                  {/*
          One <section> per top-level surface. Featured, the discovery controls,
          Enabled, Custom APIs, and Browse are all Connectors, so they live
          inside this element rather than beside it: otherwise the accessibility
          tree says they belong to no section at all.
        */}
                  {!searchingAll &&
                  (filter === "all" || filter === "api") &&
                  visibleCustomApiInstances.length > 0 ? (
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

                  {hasQuery && !searchingAll ? (
                    <div className="mt-4">
                      <p className="mb-3 text-xs leading-5 text-fg-muted">
                        Still can’t find it?{" "}
                        <button
                          type="button"
                          className="rounded-sm font-medium text-fg underline decoration-current/30 underline-offset-4 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-wait disabled:opacity-60"
                          disabled={registryBusy}
                          onClick={() => void searchRegistry()}
                        >
                          {registryBusy ? "Searching…" : "Search the whole public registry"}
                        </button>
                      </p>
                      {visibleRegistry.length ? (
                        <ConnectionCatalog
                          grouped={false}
                          columns={2}
                          services={visibleRegistry.map((item) => ({
                            id: item.id,
                            name: item.name,
                            logo: <CapabilityMark src={logoUrl(item)} name={item.name} />,
                            options: [
                              {
                                id: item.id,
                                name: "Community",
                                description: item.description ?? undefined,
                                status: "Available",
                                connected: false,
                                state: "available",
                                onOpen: () => openItem(item, true),
                              },
                            ],
                          }))}
                        />
                      ) : registrySearched === query.trim() ? (
                        <p className="text-sm text-fg-muted">
                          Nothing else found. Connections that need a local install aren’t included.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {loadError ? (
                    <p role="alert">
                      {loadError.message}
                      <button type="button" onClick={() => void refresh()}>
                        Retry
                      </button>
                    </p>
                  ) : null}
                </div>
                <div
                  className={searchingAll ? "capability-search-section" : undefined}
                  hidden={activeTab !== "skills"}
                >
                  <SkillsPanel
                    refreshRevision={skillsRevision}
                    onSkillsChange={setCanonicalSkills}
                    openSkillRef={openSkillRef}
                    key={workspaceId}
                    workspaceId={workspaceId}
                    query={query}
                    onImportSkill={() => importSkillRef.current?.()}
                    onFindSkill={() => {
                      const search =
                        capabilityFocusFallbackRef.current?.querySelector<HTMLInputElement>(
                          'input[type="search"]',
                        );
                      search?.scrollIntoView({ block: "center", behavior: "smooth" });
                      search?.focus({ preventScroll: true });
                    }}
                  />
                </div>
                <div
                  ref={bundlesRef}
                  className={searchingAll ? "capability-search-section" : undefined}
                  hidden={!searchingAll && activeTab === "connections"}
                >
                  <BundlesSection
                    overviewSkills={canonicalSkills
                      .filter((skill) =>
                        `${skill.title} ${skill.stableKey} ${skill.description ?? ""}`
                          .toLowerCase()
                          .includes(query.trim().toLowerCase()),
                      )
                      .map((skill) => ({
                        id: skill.id,
                        name: skill.title || skill.stableKey,
                        status: skill.pendingRevisionIds.length
                          ? "attention"
                          : skill.activeRevisionId
                            ? "added"
                            : "unavailable",
                        statusLabel: skill.pendingRevisionIds.length
                          ? "Pending changes"
                          : skill.activeRevisionId
                            ? "Installed"
                            : "Inactive",
                        ...(skill.description ? { description: skill.description } : {}),
                        onOpen: () => {
                          setActiveTab("skills");
                          openSkillRef.current?.(skill.id);
                        },
                      }))}
                    discoveryEnabled={activeTab !== "connections"}
                    {...(searchingAll
                      ? {
                          onShowCategory: (category: "skills" | "plugins") =>
                            setActiveTab(category),
                        }
                      : {})}
                    onSearchSkills={() => {
                      const search =
                        capabilityFocusFallbackRef.current?.querySelector<HTMLInputElement>(
                          'input[type="search"]',
                        );
                      search?.scrollIntoView({ block: "center", behavior: "smooth" });
                      search?.focus({ preventScroll: true });
                    }}
                    importSkillRef={importSkillRef}
                    section={searchingAll ? "all" : activeTab === "skills" ? "skills" : "plugins"}
                    query={query}
                    client={client}
                    workspaceId={workspaceId}
                    connections={connections}
                    canManage={canManageSkills}
                    items={items}
                    logoUrl={logoUrl}
                    busyCatalogId={busyId}
                    onOpenCatalogItem={(item) => openItem(item, false, true)}
                    onChanged={async () => {
                      setSkillsRevision((value) => value + 1);
                      await refresh();
                      onRuntimeChanged();
                    }}
                  />
                  {activeTab === "plugins" ? (
                    <div className="mt-6">
                      <PrReviewSetupCard
                        client={client}
                        workspaceId={workspaceId}
                        canManage={
                          canManageApiIntegrationInstances &&
                          hasWorkspacePermission(
                            context.accessContext,
                            workspaceId,
                            "secrets:write",
                          )
                        }
                      />
                    </div>
                  ) : null}
                </div>
              </TabsContent>
            </Tabs>
          </CatalogActionContext.Provider>
        </div>

        {integrations.map((adapter) => (
          <Fragment key={adapter.model.id}>{adapter.dialogs}</Fragment>
        ))}

        {accountConnectOpen &&
        rawSelectedItem?.kind === "mcp" &&
        rawSelectedItem.authKind === "oauth2" &&
        !rawSelectedItem.enabled ? (
          <McpConnectionCard
            client={client}
            workspaceId={workspaceId}
            capabilityId={rawSelectedItem.id}
            name={rawSelectedItem.name}
            returnUrl={window.location.href}
            dialogOnly
            personalOnly={personalOnlyCapability(rawSelectedItem)}
            connectLabel={`Connect ${rawSelectedItem.name}`}
            dialogSubtitle="Review access, then sign in"
            description={capabilityDescription(rawSelectedItem) ?? undefined}
            logoSrc={logoUrl(rawSelectedItem)}
            ownershipCopy={{
              legend: "Who can use it?",
              workspace: OWNERSHIP_HELP.workspace,
              personal: OWNERSHIP_HELP.personal,
            }}
            onConfigured={refresh}
            onClose={() => {
              setAccountConnectOpen(false);
              setSheetError(null);
            }}
          />
        ) : null}

        <ConfirmDialog
          open={skillRemoval !== null}
          onOpenChange={(open) => {
            if (!open) setSkillRemoval(null);
          }}
          title={skillRemoval ? `Remove Skill “${skillRemoval.item.name}”?` : "Remove Skill?"}
          description="This removes only the direct workspace installation. Skills used by Plugins are kept. Connections and credentials are unchanged."
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
          onCustomApi={(protocol) => {
            setAddOpen(false);
            dispatchCustomApi({ type: "new", draft: { protocol, advanced: true } });
          }}
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
      </CapabilityPageSlotContext.Provider>
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
