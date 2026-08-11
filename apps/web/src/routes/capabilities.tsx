// Capabilities: the workspace integrations marketplace. A single scrollable
// page — a large search, kind filters, an "Enabled" strip the user manages
// daily, and a logo tile grid over the full catalog (1,000+ items, rendered
// incrementally). Credentialed MCP servers connect through the connections
// spine (OAuth redirect or an API-key form) in a right-hand detail sheet, never
// by hand-editing enable headers. Packs keep their first-class register/enable/
// disable/unregister surface, restyled flat.
import {
  ATLASSIAN_APP_DESCRIPTION,
  atlassianStatus,
  localConnectedAtlassianPreview,
  preferredAtlassianConnection,
} from "@/lib/atlassian-connection";
import {
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts/slack-bot-scopes";
import { usePacks, useRigs, useVariableSets } from "@opengeni/react";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  GlobeIcon,
  HardDriveIcon,
  Loader2Icon,
  MessagesSquareIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { AddCustomDialog } from "@/components/capabilities/add-custom-dialog";
import { AtlassianConnectorCard } from "@/components/capabilities/atlassian-connector-card";
import {
  CapabilityBrowseSection,
  CapabilityDiscoveryControls,
  EnabledCapabilitiesSection,
} from "@/components/capabilities/capability-catalog-sections";
import {
  CapabilityDetailSheet,
  type ConnectAction,
} from "@/components/capabilities/capability-detail-sheet";
import { PacksSection } from "@/components/capabilities/packs-section";
import { PersonalSlackAccountCard } from "@/components/capabilities/personal-slack-account-card";
import { SlackReactionSummonCard } from "@/components/capabilities/slack-reaction-summon-card";
import { isWorkspaceImportedSkill } from "@/components/capabilities/source-import-flow";
import { SourcePackagesSection } from "@/components/capabilities/source-packages-section";
import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
  apiKeyConnectionRef,
  capabilityConnectPlan,
  capabilityCounts,
  capabilityErrorToast,
  capabilityInputFromForm,
  connectionHealth,
  connectionToReuseForApiKey,
  createInputFromCatalogItem,
  filterCapabilityCatalogItems,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthConnectionRef,
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
  GOOGLE_DRIVE_APP_DESCRIPTION,
  googleDriveAccountState,
  localConnectedGoogleDrivePreview,
  preferredGoogleDriveConnection,
} from "@/lib/google-drive-connection";
import { listViewState } from "@/lib/load-state";
import { mcpOAuthCallbackFailureMessage, startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import {
  personalSlackAccountState,
  personalSlackCapability,
  personalSlackOAuthTarget,
  preferredPersonalSlackConnection,
} from "@/lib/personal-slack";
import {
  openGeniSlackBotConnections,
  openGeniSlackBotInstallInput,
  openGeniSlackBotUiMetadata,
  preferredOpenGeniSlackBotConnection,
} from "@/lib/slack-bot";
import { cn } from "@/lib/utils";
import { request } from "@/api";

const IntegrationControlCenter = lazy(async () => {
  const module = await import("@/components/capabilities/integration-control-center");
  return { default: module.IntegrationControlCenter };
});
const GoogleDriveConnectorCard = lazy(async () => {
  const module = await import("@/components/capabilities/google-drive-connector-card");
  return { default: module.GoogleDriveConnectorCard };
});
const MemorySlackPublicationCard = lazy(async () => {
  const module = await import("@/components/capabilities/memory-slack-publication-card");
  return { default: module.MemorySlackPublicationCard };
});

import type {
  AccessContext,
  CapabilityCatalogItem,
  CapabilityInstallation,
  CapabilityPack,
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
  ConnectionOwnership,
  PackInstallationPreview,
  PackUninstallPreview,
  SocialConnection,
} from "@/types";

const PAGE_SIZE = 48;

export function googleDriveStatusLabel(
  state: ReturnType<typeof googleDriveAccountState>["state"],
): string {
  if (state === "connected") return "Connected";
  if (state === "paused") return "Paused";
  if (state === "not_connected" || state === "disconnected") return "Not connected";
  if (state === "unverified") return "Loading";
  return "Needs attention";
}

export function atlassianStatusLabel(status: ReturnType<typeof atlassianStatus>): string {
  if (status === "connected") return "Connected";
  if (status === "paused") return "Paused";
  if (status === "loading") return "Loading";
  if (status === "not_connected") return "Not connected";
  return "Needs attention";
}

export function localConnectedSlackPreview(
  search: string,
  workspaceId: string,
  enabled = import.meta.env.DEV,
) {
  if (!enabled || new URLSearchParams(search).get("previewSlack") !== "connected") return null;
  const now = new Date().toISOString();
  const shared = {
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId,
    providerDomain: "slack.com",
    status: "active" as const,
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    createdBySubjectId: "preview-user",
    updatedBySubjectId: "preview-user",
    createdAt: now,
    updatedAt: now,
  };
  const personal: ConnectionMetadata = {
    ...shared,
    id: "00000000-0000-4000-8000-000000000002",
    subjectId: "preview-user",
    kind: "oauth2",
    grantedScopes: ["search:read.public", "channels:history", "chat:write"],
    metadata: {},
  };
  return {
    bot: {
      ...shared,
      id: "00000000-0000-4000-8000-000000000003",
      subjectId: null,
      kind: "app_install" as const,
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
      verifiedInstallAt: now,
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: "opengeni_slack_bot",
        credentialLabel: "OpenGeni Slack bot",
        slackTeamId: "T_CLOUDGENI_PREVIEW",
        slackTeamName: "CloudGeni",
        botDisplayName: "OpenGeni",
      },
    } satisfies ConnectionMetadata,
    personal: {
      state: "connected" as const,
      connection: personal,
      accessTokenRefreshDue: false,
    },
  };
}

export function canWriteWorkspaceConnections(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  const grant = accessContext?.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  return Boolean(
    grant &&
    (grant.permissions.includes("connections:write") ||
      grant.permissions.includes("workspace:admin")),
  );
}

export function canInstallOpenGeniSlackBot(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  return canWriteWorkspaceConnections(accessContext, workspaceId);
}

export function canManageSlackReactionSummon(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  const grant = accessContext?.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  return grant?.permissions.includes("workspace:admin") === true;
}

export function canManageApiIntegrations(
  accessContext: AccessContext | null,
  workspaceId: string,
): boolean {
  return hasWorkspacePermission(accessContext, workspaceId, "workspace:admin");
}

export function WorkspaceSlackBotRequestedScopes() {
  return (
    <p className="mt-2 max-w-3xl break-words font-mono text-2xs leading-relaxed text-fg-subtle">
      {OPENGENI_SLACK_BOT_REQUESTED_SCOPES.join(", ")}
    </p>
  );
}

export function SlackBotInstallControls({
  canInstall,
  hasConnection,
  busy,
  onInstall,
}: {
  canInstall: boolean;
  hasConnection: boolean;
  busy: boolean;
  onInstall: (createNewConnection: boolean) => void;
}) {
  if (hasConnection) {
    return (
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!canInstall || busy}
            onClick={() => onInstall(false)}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}
            Reconnect
          </Button>
          {canInstall ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onInstall(true)}>
              Install in another workspace
            </Button>
          ) : null}
        </div>
        {!canInstall ? <SlackBotInstallPermissionNotice /> : null}
      </div>
    );
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        aria-busy={busy}
        aria-label="Install OpenGeni in Slack"
        data-opengeni-slack-install
        className="relative inline-flex h-10 w-[139px] items-center justify-center overflow-hidden rounded-md outline-none ring-focus transition-opacity focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!canInstall || busy}
        onClick={() => onInstall(false)}
      >
        <img
          src="https://platform.slack-edge.com/img/add_to_slack.png"
          srcSet="https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
          alt=""
          aria-hidden="true"
          width={139}
          height={40}
          className="h-10 w-[139px]"
        />
        {busy ? (
          <span className="absolute inset-0 grid place-items-center bg-bg/75" aria-hidden="true">
            <Loader2Icon className="animate-spin" />
          </span>
        ) : null}
      </button>
      {!canInstall ? <SlackBotInstallPermissionNotice /> : null}
    </div>
  );
}

function SlackBotInstallPermissionNotice() {
  return (
    <p className="mt-2 max-w-xl text-xs leading-5 text-fg-muted">
      Ask a workspace administrator or connection manager to install the OpenGeni Slack bot.
    </p>
  );
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

  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [installations, setInstallations] = useState<CapabilityInstallation[]>([]);
  // null = connections have not loaded (or the load failed, e.g. the grant lacks
  // connections:read); an array = loaded, even when empty. Health must not treat a
  // failed load as "every connection was deleted".
  const [connections, setConnections] = useState<ConnectionMetadata[] | null>(null);
  const [socialConnections, setSocialConnections] = useState<SocialConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [personalSlackBusy, setPersonalSlackBusy] = useState(false);
  const [personalSlackDisconnectOpen, setPersonalSlackDisconnectOpen] = useState(false);
  const [slackBotBusy, setSlackBotBusy] = useState(false);
  const [slackDestinationBusy, setSlackDestinationBusy] = useState(false);
  const [slackDestinationAuthority, setSlackDestinationAuthority] =
    useState<ConnectorDocumentDestinationAuthority>("workspace");
  const [savedSlackDestinationAuthority, setSavedSlackDestinationAuthority] =
    useState<ConnectorDocumentDestinationAuthority>("workspace");

  const [filter, setFilter] = useState<CapabilityFilter>(
    initialSection === "packs" ? "pack" : "all",
  );
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Detail/connect sheet. We store the id (+ registry flag + a snapshot for
  // registry items not yet in the catalog), NOT the item object: the rendered
  // item is derived from the LIVE `items` list by id, so any mutation + refresh
  // (strip disable, pack disable, background reload) re-derives the sheet instead
  // of leaving it on a stale snapshot that could re-enable what was just disabled.
  const [selected, setSelected] = useState<SheetSelection | null>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);
  const capabilityFocusFallbackRef = useRef<HTMLDivElement | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [managedApp, setManagedApp] = useState<"google-drive" | "atlassian" | "slack" | null>(null);

  // Public MCP registry search (only offered when the catalog has no matches).
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [registrySearched, setRegistrySearched] = useState<string | null>(null);

  const packs = usePacks({ workspaceId });
  const rigs = useRigs({ workspaceId });
  const variableSets = useVariableSets({ workspaceId });

  const counts = useMemo(() => capabilityCounts(items), [items]);
  const catalogView = listViewState({
    loading,
    error: loadError,
    count: items.length,
  });

  const filtered = useMemo(
    () =>
      filterCapabilityCatalogItems(items, filter, query).filter(
        (item) => item.kind !== "pack" && !isWorkspaceImportedSkill(item),
      ),
    [items, filter, query],
  );
  // The Enabled strip is the daily-management surface; Browse shows the rest of
  // the catalog so an enabled item never appears in both places.
  const enabledItems = useMemo(() => filtered.filter((item) => item.enabled), [filtered]);
  const browseItems = useMemo(() => filtered.filter((item) => !item.enabled), [filtered]);
  const visibleBrowse = browseItems.slice(0, visibleCount);
  const slackBotConnections = openGeniSlackBotConnections(connections ?? []);
  const slackBotConnection = preferredOpenGeniSlackBotConnection(slackBotConnections);
  const slackWorkspaceGrant = context.accessContext?.workspaceGrants.find(
    (grant) => grant.workspaceId === workspaceId,
  );
  const canManageSlackWorkspaceDestination = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const canManageSlackOrganizationDestination = Boolean(
    slackWorkspaceGrant &&
    hasAccountPermission(context.accessContext, slackWorkspaceGrant.accountId, "account:admin"),
  );
  const canInstallSlackBot = canInstallOpenGeniSlackBot(context.accessContext, workspaceId);
  const canManageSlackReaction = canManageSlackReactionSummon(context.accessContext, workspaceId);

  const showPacks = filter === "all" || filter === "pack";
  const showSourcePackages = filter === "all" || filter === "skill" || filter === "plugin";
  const showCatalog = filter !== "pack";

  const logoUrl = useCallback(
    (item: CapabilityCatalogItem) => client.catalogAssetUrl(item.logoAssetPath),
    [client],
  );
  const connectionsLoaded = connections !== null;
  const googleDrivePreviewConnection = localConnectedGoogleDrivePreview(
    window.location.search,
    workspaceId,
  );
  const googleDriveConnection =
    googleDrivePreviewConnection ?? preferredGoogleDriveConnection(connections ?? []);
  const googleDriveState = googleDriveAccountState(
    googleDriveConnection,
    googleDrivePreviewConnection !== null || connectionsLoaded,
  );
  const atlassianPreviewConnection = localConnectedAtlassianPreview(
    window.location.search,
    workspaceId,
  );
  const atlassianConnection =
    atlassianPreviewConnection ?? preferredAtlassianConnection(connections ?? []);
  const atlassianConnectionStatus = atlassianStatus(
    atlassianConnection,
    atlassianPreviewConnection !== null || connectionsLoaded,
  );
  const slackPreview = localConnectedSlackPreview(window.location.search, workspaceId);
  const personalSlackItem = personalSlackCapability(items);
  const personalSlackConnection = preferredPersonalSlackConnection(connections ?? []);
  const personalSlackStatus = personalSlackAccountState(personalSlackConnection, connectionsLoaded);
  const visiblePersonalSlackStatus = slackPreview?.personal ?? personalSlackStatus;
  const visibleSlackBotConnection = slackPreview?.bot ?? slackBotConnection;
  const visibleSlackBotMetadata = visibleSlackBotConnection
    ? openGeniSlackBotUiMetadata(visibleSlackBotConnection)
    : null;
  const canManagePersonalSlack = canWriteWorkspaceConnections(context.accessContext, workspaceId);
  const canManageApiIntegrationInstances = canManageApiIntegrations(
    context.accessContext,
    workspaceId,
  );
  const slackAppStatus = visibleSlackBotConnection
    ? visibleSlackBotConnection.status === "active"
      ? "Connected"
      : "Needs attention"
    : visiblePersonalSlackStatus.state === "connected"
      ? "Connected"
      : connectionsLoaded
        ? "Not connected"
        : "Loading";

  useEffect(() => {
    const authority = slackBotDocumentDestinationAuthority(slackBotConnection?.metadata);
    setSlackDestinationAuthority(authority);
    setSavedSlackDestinationAuthority(authority);
  }, [slackBotConnection?.id, slackBotConnection?.metadata]);
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

  const slackInstallHandled = useRef(false);
  useEffect(() => {
    if (slackInstallHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("slack");
    if (!outcome) return;
    slackInstallHandled.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (outcome === "connected") {
      void refresh();
      toast.success("OpenGeni installed in Slack");
    } else {
      toast.error("Couldn't install OpenGeni in Slack", {
        description: "Try again, or install another Slack workspace/bot as a new connection.",
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

  // Close the sheet if a live-bound selection vanished from the catalog after a
  // refresh (deleted/unregistered elsewhere) — never leave a ghost open. A
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

  async function refresh() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [catalog, conns, socials] = await Promise.all([
        client.listCapabilities(workspaceId),
        // null (not []) on failure so health can tell "didn't load" from "loaded empty".
        client.listConnections(workspaceId).catch(() => null),
        client.listSocialConnections(workspaceId).catch(() => null),
      ]);
      setItems(catalog.items);
      setInstallations(catalog.installations);
      // Don't clobber previously-loaded connections with null on a failed refetch
      // (that would flip healthy items to "unverified" until the next reload); a
      // first-load failure leaves the prior null = "not loaded", which is correct.
      if (conns !== null) setConnections(conns);
      if (socials !== null) setSocialConnections(socials);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load capabilities", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }

  function refreshAll() {
    void refresh();
    void packs.refresh();
  }

  async function startPersonalSlackOAuth() {
    const target = personalSlackOAuthTarget(personalSlackItem);
    if (!personalSlackItem || !target) {
      toast.error("Personal Slack is unavailable", {
        description: "The official hosted Slack integration is not present in this catalog.",
      });
      return;
    }
    setPersonalSlackBusy(true);
    try {
      const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(personalSlackItem.id)}`;
      const response = await startMcpOAuthWithTimeout(client, workspaceId, {
        ...target,
        ...(personalSlackConnection ? { connectionId: personalSlackConnection.id } : {}),
        returnPath,
      });
      if (!response.authorizationUrl) {
        throw new Error("Slack did not return an authorization link.");
      }
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      toast.error("Couldn't connect your Slack account", {
        description: error instanceof Error ? error.message : String(error),
      });
      setPersonalSlackBusy(false);
    }
  }

  async function disconnectPersonalSlack(): Promise<boolean> {
    if (!personalSlackConnection) return true;
    setPersonalSlackBusy(true);
    try {
      await client.deleteConnection(workspaceId, personalSlackConnection.id);
      await refresh();
      onRuntimeChanged();
      toast.success("Personal Slack account disconnected");
      return true;
    } catch (error) {
      toast.error("Couldn't disconnect your Slack account", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setPersonalSlackBusy(false);
    }
  }

  async function installSlackBot(createNewConnection = false) {
    setSlackBotBusy(true);
    try {
      const installation = await client.startOpenGeniSlackBotInstall(
        workspaceId,
        openGeniSlackBotInstallInput(slackBotConnection, createNewConnection),
      );
      window.location.assign(installation.authorizationUrl);
    } catch (error) {
      toast.error("Couldn't start the OpenGeni Slack installation", {
        description: error instanceof Error ? error.message : String(error),
      });
      setSlackBotBusy(false);
    }
  }

  async function disconnectSlackBot() {
    if (!slackBotConnection) return;
    setSlackBotBusy(true);
    try {
      await client.deleteConnection(workspaceId, slackBotConnection.id);
      await refresh();
      toast.success("OpenGeni Slack bot disconnected");
    } catch (error) {
      toast.error("Couldn't disconnect the OpenGeni Slack bot", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSlackBotBusy(false);
    }
  }

  async function saveSlackBotDestination() {
    if (!slackBotConnection) return;
    setSlackDestinationBusy(true);
    try {
      await client.updateConnection(workspaceId, slackBotConnection.id, {
        metadata: {
          documentDestination: {
            authorityKind: slackDestinationAuthority,
            collectionId: null,
          },
        },
      });
      setSavedSlackDestinationAuthority(slackDestinationAuthority);
      toast.success("Slack knowledge destination saved");
    } catch (error) {
      toast.error("Couldn't save the Slack knowledge destination", {
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setSlackDestinationBusy(false);
    }
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
    // snapshot — a mutation elsewhere may have changed it since the sheet opened.
    if (!selected || !selectedItem) return;
    const item = selectedItem;
    setBusyId(item.id);
    setSheetError(null);
    try {
      // The plan is derived from the current catalog/registry item (it carries
      // authKind/mcpUrl/providerDomain); connect calls use the persisted id.
      const plan = capabilityConnectPlan(item);

      if (action.type === "disable") {
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

      // Reconnect an already-enabled item whose credential lapsed. When the
      // connection row survives, OAuth reuses it (pass connectionId) and the
      // return handler just refreshes; when it was deleted (null id), OAuth
      // mints a fresh row and the return handler re-enables against it. API-key
      // reactivates the surviving row in place, or mints + re-enables if gone.
      if (action.type === "reconnect_oauth") {
        // Trust the installation's connectionRef.kind (the sheet already chose this
        // branch from it), not the catalog plan — on drift plan.mode can read
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
          // The existing row went inactive — rewrite its credential and
          // reactivate it in place; the installation ref already points at it.
          await client.updateConnection(workspaceId, action.connectionId, {
            credential: { headers: action.headers },
            status: "active",
          });
        } else {
          // The row was deleted — mint a fresh connection and re-enable the
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
        // catalog domain — the API may canonicalize providerDomain, and the row
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
    // Provider-preset API integrations have their own immutable preview/install
    // continuation. Leave those callback parameters intact for the control
    // center instead of treating them as a legacy MCP catalog connection.
    if (params.has("api_integration_preset")) return;
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
      setInstallations(catalog.installations);
      // Don't clobber previously-loaded connections with null on a failed refetch
      // (that would flip healthy items to "unverified" until the next reload).
      if (conns !== null) setConnections(conns);
      const item =
        (itemId ? catalog.items.find((candidate) => candidate.id === itemId) : undefined) ?? null;
      const action = oauthResumeAction(item, connectionId);

      if (action === "missing") {
        // Connection was created but the catalog row is gone — never leave the
        // success half-handled silently; say plainly it wasn't enabled.
        toast.success(
          "Connected — but this integration is no longer in the catalog, so it wasn't enabled.",
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
      // values — the callback carries the canonical providerDomain alongside the
      // connectionId — so enabling never depends on listConnections succeeding
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
      // was gone and OAuth minted a new one — that's a reconnect, not a first enable.
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

  // --- Enabled-strip disable (no sheet needed) -------------------------------
  async function disableFromStrip(item: CapabilityCatalogItem) {
    setBusyId(item.id);
    try {
      await client.disableCapability(workspaceId, item.id);
      await refresh();
      onRuntimeChanged();
      toast.success(`Disabled ${item.name}`);
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
          // a failed refresh must not drop the connect sheet — render from the
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
    // flex column, so the PAGE never body-scrolls — the route must own its own
    // vertical scroll. This root IS that scroll viewport (min-h-0 so it can
    // shrink inside the flex parent, overflow-y-auto so the tall catalog grid
    // scrolls); the centered max-width column lives inside it.
    <div
      ref={capabilityFocusFallbackRef}
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

        <section className="mt-6 space-y-3" aria-labelledby="apps-heading">
          <div>
            <h2 id="apps-heading" className="text-sm font-semibold text-fg">
              Apps
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Connect the services your team and agents use most.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ManagedAppTile
              icon={<AppLogo app="googleDrive" />}
              name="Google Drive"
              description={GOOGLE_DRIVE_APP_DESCRIPTION}
              status={googleDriveStatusLabel(googleDriveState.state)}
              onOpen={() => setManagedApp("google-drive")}
            />
            <ManagedAppTile
              icon={<AppLogo app="slack" />}
              name="Slack"
              description="Chat with OpenGeni and start work from Slack."
              status={slackAppStatus}
              onOpen={() => setManagedApp("slack")}
            />
            <ManagedAppTile
              icon={<AppLogo app="atlassian" />}
              name="Jira & Confluence"
              description={ATLASSIAN_APP_DESCRIPTION}
              status={atlassianStatusLabel(atlassianConnectionStatus)}
              onOpen={() => setManagedApp("atlassian")}
            />
          </div>
        </section>

        <Sheet
          open={managedApp === "google-drive"}
          onOpenChange={(open) => !open && setManagedApp(null)}
        >
          <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
            <SheetHeader className="border-b border-border px-5 py-4 pr-12">
              <SheetTitle>Google Drive</SheetTitle>
              <SheetDescription>
                Choose what OpenGeni can index, who can use it, and which accounts agents may act
                through.
              </SheetDescription>
            </SheetHeader>
            <div className="px-5 pb-6">
              <Suspense fallback={<Skeleton className="mt-3 h-40 rounded-xl" />}>
                <GoogleDriveConnectorCard workspaceId={workspaceId} embedded />
              </Suspense>
              <details className="group mt-4 rounded-xl border border-border bg-surface p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-fg">
                  <span>Agent file access and additional accounts</span>
                  <ChevronDownIcon className="size-4 text-fg-subtle transition-transform group-open:rotate-180" />
                </summary>
                <p className="mt-2 text-xs leading-5 text-fg-muted">
                  Add named Personal or workspace accounts for live file discovery and agent file
                  actions. Scheduled knowledge sync above remains independently governed.
                </p>
                <Suspense fallback={<Skeleton className="mt-3 h-40 rounded-xl" />}>
                  <IntegrationControlCenter
                    workspaceId={workspaceId}
                    connections={connections}
                    canManage={canManageApiIntegrationInstances}
                    presetIds={["google-drive"]}
                    showCustomApis={false}
                    embedded
                    onChanged={async () => {
                      await refresh();
                      onRuntimeChanged();
                    }}
                  />
                </Suspense>
              </details>
            </div>
          </SheetContent>
        </Sheet>

        <Sheet
          open={managedApp === "atlassian"}
          onOpenChange={(open) => !open && setManagedApp(null)}
        >
          <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
            <SheetHeader className="sr-only">
              <SheetTitle>Jira & Confluence</SheetTitle>
              <SheetDescription>Atlassian connection settings.</SheetDescription>
            </SheetHeader>
            <Suspense fallback={<Skeleton className="m-5 h-40 rounded-xl" />}>
              <AtlassianConnectorCard workspaceId={workspaceId} />
            </Suspense>
          </SheetContent>
        </Sheet>

        <Suspense fallback={<Skeleton className="mt-6 h-64 w-full rounded-xl" />}>
          <IntegrationControlCenter
            workspaceId={workspaceId}
            connections={connections}
            canManage={canManageApiIntegrationInstances}
            excludedPresetIds={["google-drive"]}
            onChanged={async () => {
              await refresh();
              onRuntimeChanged();
            }}
          />
        </Suspense>

        <Sheet open={managedApp === "slack"} onOpenChange={(open) => !open && setManagedApp(null)}>
          <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
            <SheetHeader className="border-b border-border px-5 py-4 pr-12">
              <SheetTitle>Slack</SheetTitle>
              <SheetDescription>
                Chat with OpenGeni, start work, and choose which Slack identity agents may use.
              </SheetDescription>
            </SheetHeader>
            <section className="space-y-3 px-5 pb-6" aria-label="Slack settings">
              <section className="mt-3 rounded-xl border border-border bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-bg">
                      <AppLogo app="slack" className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-fg">Your Slack account</p>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        Let agents act through your personal Slack identity.
                      </p>
                    </div>
                  </div>
                  <PersonalSlackAccountCard
                    available={personalSlackItem !== null || slackPreview !== null}
                    canManage={canManagePersonalSlack}
                    busy={personalSlackBusy}
                    accountState={visiblePersonalSlackStatus}
                    embedded
                    readOnly={slackPreview !== null}
                    onConnect={() => void startPersonalSlackOAuth()}
                    onReconnect={() => void startPersonalSlackOAuth()}
                    onDisconnect={() => setPersonalSlackDisconnectOpen(true)}
                  />
                </div>
              </section>

              <section
                className="rounded-xl border border-border bg-surface p-4"
                aria-labelledby="workspace-slack-bot-heading"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-bg">
                      <AppLogo app="slack" className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3
                          id="workspace-slack-bot-heading"
                          className="text-sm font-semibold text-fg"
                        >
                          OpenGeni workspace bot
                        </h3>
                        <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-2xs font-medium text-fg-muted">
                          Workspace shared · bot identity
                        </span>
                      </div>
                      <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
                        Install a separate bot principal for first-party Slack tools and explicitly
                        bound scheduled tasks. Linked users can mention @OpenGeni in a member
                        channel, run /opengeni, DM the bot, or use the Open in OpenGeni message
                        shortcut. A shortcut from a human DM creates a private task and continues in
                        the invoking user's bot DM; it never joins or exposes workspace output in
                        the source DM. It never uses a person's Slack OAuth grant.
                      </p>
                    </div>
                  </div>
                </div>

                {visibleSlackBotConnection && visibleSlackBotMetadata ? (
                  <>
                    <div className="mt-4 flex items-start gap-3 rounded-lg border border-brand/20 bg-brand/5 p-3">
                      <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-brand" />
                      <div>
                        <p className="text-sm font-semibold text-fg">
                          {visibleSlackBotConnection.status === "active"
                            ? `Installed in ${visibleSlackBotMetadata.slackTeamName}`
                            : `Reinstall needed for ${visibleSlackBotMetadata.slackTeamName}`}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-muted">
                          {visibleSlackBotConnection.status === "active"
                            ? "The workspace bot is ready to use in this Slack workspace."
                            : "Reinstall the workspace bot to restore its Slack access."}
                        </p>
                      </div>
                    </div>

                    <details className="group mt-3 rounded-lg border border-border bg-bg/40 p-3">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-medium text-fg">
                        <span>Settings</span>
                        <ChevronDownIcon className="size-3.5 text-fg-subtle transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="mt-3 border-t border-border/70 pt-3">
                        <div className="flex flex-wrap items-end justify-between gap-3">
                          <div>
                            <p className="text-xs font-semibold text-fg">
                              Slack knowledge destination
                            </p>
                            <p className="mt-1 text-2xs leading-4 text-fg-muted">
                              Saved as {slackBotDestinationLabel(savedSlackDestinationAuthority)}.
                              No user-created collection is required.
                            </p>
                          </div>
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="grid gap-1 text-2xs font-medium text-fg-muted">
                              Destination
                              <Select
                                aria-label="Slack knowledge destination"
                                value={slackDestinationAuthority}
                                disabled={!canInstallSlackBot || slackDestinationBusy}
                                onChange={(event) =>
                                  setSlackDestinationAuthority(
                                    event.target.value as ConnectorDocumentDestinationAuthority,
                                  )
                                }
                              >
                                <option value="personal">My knowledge</option>
                                <option
                                  value="workspace"
                                  disabled={!canManageSlackWorkspaceDestination}
                                >
                                  Workspace knowledge
                                </option>
                                <option
                                  value="organization"
                                  disabled={!canManageSlackOrganizationDestination}
                                >
                                  Organization knowledge
                                </option>
                              </Select>
                            </label>
                            <Button
                              type="button"
                              size="sm"
                              disabled={
                                !canInstallSlackBot ||
                                slackDestinationBusy ||
                                (slackDestinationAuthority === "workspace" &&
                                  !canManageSlackWorkspaceDestination) ||
                                (slackDestinationAuthority === "organization" &&
                                  !canManageSlackOrganizationDestination)
                              }
                              onClick={() => void saveSlackBotDestination()}
                            >
                              {slackDestinationBusy ? (
                                <Loader2Icon className="size-3.5 animate-spin" />
                              ) : null}
                              Save destination
                            </Button>
                          </div>
                        </div>
                      </div>

                      <SlackReactionSummonCard
                        workspaceId={workspaceId}
                        connection={visibleSlackBotConnection}
                        canManage={canManageSlackReaction}
                        installBusy={slackBotBusy}
                        onUpdatePermissions={() => void installSlackBot(false)}
                      />

                      <Suspense fallback={null}>
                        <MemorySlackPublicationCard
                          workspaceId={workspaceId}
                          connections={slackBotConnections}
                          canManage={canManageSlackReaction}
                        />
                      </Suspense>

                      <details className="group mt-3 border-t border-border/70 pt-3">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
                          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
                          <span>Workspace bot permissions and installation details</span>
                        </summary>
                        <div className="mt-3 rounded-md bg-bg/50 p-3">
                          <p className="text-2xs font-medium text-fg-muted">Required bot scopes</p>
                          <p className="mt-1 break-words font-mono text-2xs leading-relaxed text-fg-subtle">
                            {OPENGENI_SLACK_BOT_REQUIRED_SCOPES.join(", ")}
                          </p>
                          <p className="mt-2 text-2xs text-fg-subtle">
                            Bot connection ID:{" "}
                            <span className="font-mono">{visibleSlackBotConnection.id}</span>
                            {slackBotConnections.length > 1
                              ? ` · ${slackBotConnections.length} Slack installations`
                              : ""}
                          </p>
                          <SlackBotInstallControls
                            canInstall={canInstallSlackBot}
                            hasConnection
                            busy={slackBotBusy}
                            onInstall={(createNewConnection) =>
                              void installSlackBot(createNewConnection)
                            }
                          />
                          {visibleSlackBotConnection.status === "active" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="mt-1"
                              disabled={slackBotBusy}
                              onClick={() => void disconnectSlackBot()}
                            >
                              Disconnect workspace bot
                            </Button>
                          ) : null}
                        </div>
                      </details>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="mt-4 max-w-2xl text-xs text-fg-muted">
                      Install the OpenGeni bot in a Slack workspace to get started.
                    </p>
                    <SlackBotInstallControls
                      canInstall={canInstallSlackBot}
                      hasConnection={false}
                      busy={slackBotBusy}
                      onInstall={(createNewConnection) => void installSlackBot(createNewConnection)}
                    />
                    <details className="group mt-3">
                      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
                        <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
                        <span>Workspace bot permissions requested</span>
                      </summary>
                      <WorkspaceSlackBotRequestedScopes />
                    </details>
                  </>
                )}
              </section>
            </section>
          </SheetContent>
        </Sheet>

        <ConfirmDialog
          open={personalSlackDisconnectOpen}
          onOpenChange={setPersonalSlackDisconnectOpen}
          title="Disconnect your Slack account?"
          description="OpenGeni will stop using this subject-owned grant. This does not disconnect the workspace bot or revoke provider-side access in Slack."
          confirmLabel="Disconnect my Slack account"
          cancelAutoFocus
          onConfirm={disconnectPersonalSlack}
        />

        <CapabilityDiscoveryControls
          query={query}
          filter={filter}
          counts={counts}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
        />

        <div className="mt-8 space-y-10">
          {showCatalog ? (
            <EnabledCapabilitiesSection
              items={enabledItems}
              busyId={busyId}
              connectionHealth={(item) =>
                connectionHealth(item, connections ?? [], connectionsLoaded)
              }
              logoUrl={logoUrl}
              onOpen={openItem}
              onDisable={(item) => void disableFromStrip(item)}
            />
          ) : null}

          {showSourcePackages ? (
            <SourcePackagesSection
              client={client}
              workspaceId={workspaceId}
              items={items}
              installations={installations}
              connections={connections}
              canManage={canManageApiIntegrationInstances}
              filter={filter}
              query={query}
              onChanged={async () => {
                await refresh();
                onRuntimeChanged();
              }}
            />
          ) : null}

          {/* Packs. */}
          {showPacks ? (
            <PacksSection
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
              onRegister={registerPackManifest}
              onPreviewInstall={previewPackInstallation}
              onInstall={installPack}
              onPreviewUninstall={previewPackUninstall}
              onUninstall={uninstallPack}
              onUnregister={unregisterPack}
            />
          ) : null}

          {showCatalog ? (
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
              onRetry={() => void refresh()}
              onOpen={openItem}
              onOpenRegistry={(item) => openItem(item, true)}
              onSearchRegistry={() => void searchRegistry()}
              onLoadMore={() =>
                setVisibleCount((count) => Math.min(count + PAGE_SIZE, browseItems.length))
              }
            />
          ) : null}
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
        onAction={handleAction}
      />

      <AddCustomDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        busy={busyId === "add"}
        onSubmit={submitAddCustom}
      />
    </div>
  );
}

const APP_LOGO_URLS = {
  googleDrive:
    "https://www.gstatic.com/images/branding/productlogos/drive_2026/v2/web-64dp/logo_drive_2026_color_2x_web_64dp.png",
  atlassian: "https://wac-cdn.atlassian.com/assets/img/favicons/atlassian/favicon.png",
  slack: "https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png",
} as const;

function AppLogo({ app, className }: { app: keyof typeof APP_LOGO_URLS; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    const FallbackIcon =
      app === "googleDrive" ? HardDriveIcon : app === "slack" ? MessagesSquareIcon : GlobeIcon;
    return <FallbackIcon className={cn("size-5 text-fg-muted", className)} aria-hidden="true" />;
  }
  return (
    <img
      src={APP_LOGO_URLS[app]}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("size-6 object-contain", className)}
    />
  );
}

function ManagedAppTile({
  icon,
  name,
  description,
  status,
  onOpen,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  status: string;
  onOpen: () => void;
}) {
  const connected = status === "Connected";
  const attention = status === "Needs attention";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface p-3 text-left hover:border-border-strong hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-bg text-fg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{name}</span>
        <span className="mt-0.5 block truncate text-xs text-fg-muted">{description}</span>
      </span>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-2xs",
          attention ? "text-status-waiting" : "text-fg-muted",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            connected ? "bg-status-idle" : attention ? "bg-status-waiting" : "bg-fg-subtle/50",
          )}
        />
        {status}
      </span>
    </button>
  );
}

export function slackBotDocumentDestinationAuthority(
  metadata: Record<string, unknown> | undefined,
): ConnectorDocumentDestinationAuthority {
  const destination = metadata?.documentDestination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    return "workspace";
  }
  const authorityKind = (destination as Record<string, unknown>).authorityKind;
  return authorityKind === "organization" || authorityKind === "workspace"
    ? authorityKind
    : "workspace";
}

export function slackBotDestinationLabel(
  authorityKind: ConnectorDocumentDestinationAuthority,
): string {
  if (authorityKind === "organization") return "organization knowledge";
  if (authorityKind === "personal") return "your personal knowledge";
  return "workspace knowledge";
}
