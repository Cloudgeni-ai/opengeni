// Capabilities: the workspace capability-management surface. Lifecycle views
// separate what agents can use now, work-oriented discovery, connection health,
// and advanced/custom configuration. Credentialed MCP servers still connect
// through the connections spine in a right-hand detail sheet, and the existing
// capability/pack mutation behavior remains authoritative underneath the new IA.
import {
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts/slack-bot-scopes";
import { usePacks, useVariableSets } from "@opengeni/react";
import {
  BlocksIcon,
  Building2Icon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  Layers3Icon,
  LibraryIcon,
  Loader2Icon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  WrenchIcon,
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
import {
  CapabilityDetailSheet,
  type ConnectAction,
} from "@/components/capabilities/capability-detail-sheet";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { CapabilityTile } from "@/components/capabilities/capability-tile";
import { PacksSection } from "@/components/capabilities/packs-section";
import { PersonalSlackAccountCard } from "@/components/capabilities/personal-slack-account-card";
import { SlackReactionSummonCard } from "@/components/capabilities/slack-reaction-summon-card";
import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import {
  apiKeyConnectionRef,
  capabilityConnectPlan,
  capabilityCounts,
  capabilityErrorToast,
  capabilityFilterLabel,
  capabilityInputFromForm,
  capabilityKindLabel,
  connectionHealth,
  connectionToReuseForApiKey,
  createInputFromCatalogItem,
  filterCapabilityCatalogItems,
  isMissingCredentialsError,
  normalizeProviderDomain,
  oauthConnectionRef,
  oauthConnectionOwnership,
  oauthResumeAction,
  preferredSocialConnection,
  registryResultsForQuery,
  resolveSheetItem,
  type CapabilityFilter,
  type CapabilityFormState,
  type ConnectionHealth,
  type SheetSelection,
} from "@/lib/capabilities";
import { listViewState } from "@/lib/load-state";
import { startMcpOAuthWithTimeout } from "@/lib/mcp-oauth";
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

const GoogleDriveConnectorCard = lazy(async () => {
  const module = await import("@/components/capabilities/google-drive-connector-card");
  return { default: module.GoogleDriveConnectorCard };
});
import type {
  AccessContext,
  CapabilityCatalogItem,
  CapabilityPack,
  ConnectionMetadata,
  ConnectionOwnership,
  SocialConnection,
} from "@/types";

const PAGE_SIZE = 48;
const FILTERS: CapabilityFilter[] = ["all", "pack", "mcp", "api", "skill", "plugin"];
const CAPABILITY_VIEWS = ["current", "discover", "connections", "custom"] as const;
const DISCOVERY_CATEGORIES = [
  "all",
  "work",
  "development",
  "knowledge",
  "marketing",
  "infrastructure",
] as const;

type CapabilityView = (typeof CAPABILITY_VIEWS)[number];
type DiscoveryCategory = (typeof DISCOVERY_CATEGORIES)[number];
type DiscoverySource = "all" | "opengeni" | "verified" | "community" | "custom";

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
  if (!canInstall) return null;

  if (hasConnection) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={() => onInstall(false)}>
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          Reinstall
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onInstall(true)}>
          Install in another workspace
        </Button>
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
        disabled={busy}
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
    </div>
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

  const [view, setView] = useState<CapabilityView>(
    initialSection === "packs" ? "discover" : "current",
  );
  const [filter, setFilter] = useState<CapabilityFilter>(
    initialSection === "packs" ? "pack" : "all",
  );
  const [category, setCategory] = useState<DiscoveryCategory>("all");
  const [sourceFilter, setSourceFilter] = useState<DiscoverySource>("all");
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

  // Public MCP registry search (only offered when the catalog has no matches).
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [registrySearched, setRegistrySearched] = useState<string | null>(null);

  const packs = usePacks({ workspaceId });
  const variableSets = useVariableSets({ workspaceId });

  const counts = useMemo(() => capabilityCounts(items), [items]);
  const catalogView = listViewState({ loading, error: loadError, count: items.length });

  const filtered = useMemo(
    () => filterCapabilityCatalogItems(items, filter, query).filter((item) => item.kind !== "pack"),
    [items, filter, query],
  );
  const enabledItems = useMemo(
    () => items.filter((item) => item.kind !== "pack" && item.enabled),
    [items],
  );
  const discoveryItems = useMemo(
    () =>
      filtered.filter(
        (item) =>
          matchesDiscoveryCategory(item, category) && matchesDiscoverySource(item, sourceFilter),
      ),
    [category, filtered, sourceFilter],
  );
  const visibleDiscover = discoveryItems.slice(0, visibleCount);
  const slackBotConnections = openGeniSlackBotConnections(connections ?? []);
  const slackBotConnection = preferredOpenGeniSlackBotConnection(slackBotConnections);
  const slackBotMetadata = slackBotConnection
    ? openGeniSlackBotUiMetadata(slackBotConnection)
    : null;
  const canInstallSlackBot = canInstallOpenGeniSlackBot(context.accessContext, workspaceId);
  const canManageSlackReaction = canManageSlackReactionSummon(context.accessContext, workspaceId);

  const showPacks =
    filter === "pack" || packs.loading || Boolean(packs.error) || packs.packs.length > 0;

  const logoUrl = useCallback(
    (item: CapabilityCatalogItem) => client.catalogAssetUrl(item.logoAssetPath),
    [client],
  );
  const connectionsLoaded = connections !== null;
  const personalSlackItem = personalSlackCapability(items);
  const personalSlackConnection = preferredPersonalSlackConnection(connections ?? []);
  const personalSlackStatus = personalSlackAccountState(personalSlackConnection, connectionsLoaded);
  const canManagePersonalSlack = canWriteWorkspaceConnections(context.accessContext, workspaceId);
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
  const selectedSocialConnection = selectedItem
    ? (() => {
        const plan = capabilityConnectPlan(selectedItem);
        return plan.mode === "social_oauth"
          ? preferredSocialConnection(socialConnections, plan.provider)
          : null;
      })()
    : null;
  const canManageSocial = canManageSlackReactionSummon(context.accessContext, workspaceId);
  const currentRows = useMemo(
    () =>
      enabledItems
        .map((item) => ({
          item,
          health: connectionHealth(item, connections ?? [], connectionsLoaded),
        }))
        .sort(compareCurrentCapabilityRows),
    [connections, connectionsLoaded, enabledItems],
  );
  const attentionRows = currentRows.filter((row) => row.health.state === "attention");
  const readyRows = currentRows.filter((row) => row.health.state !== "attention");
  const activeConnectionCount = (connections ?? []).filter(
    (connection) => connection.status === "active",
  ).length;
  const builtInCount = enabledItems.filter(
    (item) => item.source === "built_in" || item.source === "configured",
  ).length;
  const customItems = items.filter(
    (item) => item.source === "manual" || item.source === "configured",
  );

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
  useEffect(() => setVisibleCount(PAGE_SIZE), [category, filter, query, sourceFilter]);

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
      setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
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
      const item = itemId ? (items.find((candidate) => candidate.id === itemId) ?? null) : null;
      if (item) {
        setSheetError(
          reason ? `Couldn't connect: ${reason}.` : "Couldn't connect. Please try again.",
        );
        setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
      } else {
        toast.error("Connection failed", { description: reason ?? undefined });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
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
        setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
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

  async function enablePack(pack: CapabilityPack, variableSetId: string | undefined) {
    setBusyId(`pack:${pack.id}`);
    try {
      await client.enableCapability(
        workspaceId,
        `pack:${pack.id}`,
        variableSetId ? { variableSetId } : {},
      );
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(`Enabled ${pack.name}`);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to enable pack");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function disablePack(pack: CapabilityPack) {
    setBusyId(`pack:${pack.id}`);
    try {
      await client.disableCapability(workspaceId, `pack:${pack.id}`);
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(`Disabled ${pack.name}`);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to disable pack");
      toast.error(copy.title, { description: copy.description });
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={refreshAll}
              disabled={loading || packs.loading}
            >
              <RefreshCwIcon className={cn((loading || packs.loading) && "animate-spin")} />
              Refresh
            </Button>
          }
        />

        <Tabs
          value={view}
          onValueChange={(value) => setView(value as CapabilityView)}
          className="mt-5 gap-0"
        >
          <div className="sticky top-0 z-20 -mx-1 overflow-x-auto border-b border-border bg-bg/95 px-1 pt-1 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
            <TabsList variant="line" aria-label="Capability views" className="h-10 gap-1">
              <TabsTrigger value="current" className="px-3 text-xs">
                <Layers3Icon />
                Current
                {attentionRows.length > 0 ? (
                  <span
                    className="size-1.5 rounded-full bg-status-waiting"
                    aria-label="Needs attention"
                  />
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="discover" className="px-3 text-xs">
                <SparklesIcon />
                Discover
              </TabsTrigger>
              <TabsTrigger value="connections" className="px-3 text-xs">
                <PlugIcon />
                Connections
              </TabsTrigger>
              <TabsTrigger value="custom" className="px-3 text-xs">
                <WrenchIcon />
                Custom
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="current" className="mt-6 space-y-7">
            <section aria-labelledby="capability-summary-heading">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 id="capability-summary-heading" className="text-base font-semibold text-fg">
                    What agents can use now
                  </h2>
                  <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">
                    Workspace capabilities define what can be selected. Each session can narrow its
                    tools, while workspace policy and built-ins cannot be widened here.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setView("discover")}
                >
                  Explore capabilities
                  <ChevronRightIcon />
                </Button>
              </div>

              <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-surface/40 lg:grid-cols-4">
                <SummaryMetric
                  label="Ready now"
                  value={readyRows.length}
                  icon={<CheckCircle2Icon />}
                />
                <SummaryMetric
                  label="Needs attention"
                  value={attentionRows.length}
                  icon={<CircleAlertIcon />}
                  attention={attentionRows.length > 0}
                />
                <SummaryMetric
                  label="Active connections"
                  value={connectionsLoaded ? activeConnectionCount : "—"}
                  icon={<PlugIcon />}
                />
                <SummaryMetric label="Built in" value={builtInCount} icon={<ShieldCheckIcon />} />
              </div>
            </section>

            {catalogView === "loading" ? (
              <CapabilityRowSkeletons />
            ) : catalogView === "error" ? (
              <LoadErrorState
                title="Couldn't load capabilities"
                error={loadError}
                onRetry={() => void refresh()}
              />
            ) : currentRows.length === 0 ? (
              <EmptyState
                icon={<SparklesIcon className="size-4" />}
                title="Choose capabilities for the work ahead"
                description="OpenGeni's platform capabilities stay available. Discover a pack, connection, or specialist skill when you need it."
                action={
                  <Button type="button" size="sm" onClick={() => setView("discover")}>
                    Discover capabilities
                  </Button>
                }
              />
            ) : (
              <div className="space-y-7">
                {attentionRows.length > 0 ? (
                  <CapabilityListSection
                    title="Needs attention"
                    description="Repair these before relying on them in a new session."
                    rows={attentionRows}
                    logoUrl={logoUrl}
                    busyId={busyId}
                    onOpen={openItem}
                    onDisable={disableFromStrip}
                  />
                ) : null}
                {readyRows.length > 0 ? (
                  <CapabilityListSection
                    title="Available now"
                    description="Built-ins, configured tools, and workspace selections in one compact inventory."
                    rows={readyRows}
                    logoUrl={logoUrl}
                    busyId={busyId}
                    onOpen={openItem}
                    onDisable={disableFromStrip}
                  />
                ) : null}
              </div>
            )}
          </TabsContent>

          <TabsContent value="discover" className="mt-6 space-y-8">
            <section aria-labelledby="recommended-heading">
              <div>
                <h2 id="recommended-heading" className="text-base font-semibold text-fg">
                  Start with the work, not the technology
                </h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">
                  Recommendations keep common paths visible. The full catalog and technical formats
                  stay searchable below.
                </p>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <RecommendationCard
                  icon={<LibraryIcon />}
                  title="Work with company knowledge"
                  description="Documents, search, files, and connected sources."
                  action="Browse knowledge"
                  onClick={() => {
                    setCategory("knowledge");
                    setFilter("all");
                  }}
                />
                <RecommendationCard
                  icon={<BlocksIcon />}
                  title="Run a repeatable workflow"
                  description="Packs compose tools, skills, connections, and schedules."
                  action="Browse packs"
                  onClick={() => setFilter("pack")}
                />
                <RecommendationCard
                  icon={<Settings2Icon />}
                  title="Infrastructure and Terraform"
                  description="Specialist guidance, available intentionally rather than globally."
                  action="Browse infrastructure"
                  onClick={() => {
                    setCategory("infrastructure");
                    setFilter("skill");
                  }}
                />
              </div>
            </section>

            {showPacks ? (
              <PacksSection
                packs={packs}
                variableSets={variableSets.variableSets.map((variableSet) => ({
                  id: variableSet.id,
                  name: variableSet.name,
                }))}
                busyPackId={packBusyId}
                onRegister={registerPackManifest}
                onEnable={(pack, variableSetId) => void enablePack(pack, variableSetId)}
                onDisable={(pack) => void disablePack(pack)}
                onUnregister={unregisterPack}
              />
            ) : null}

            {filter !== "pack" ? (
              <section aria-labelledby="catalog-heading" className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 id="catalog-heading" className="text-base font-semibold text-fg">
                      Capability library
                    </h2>
                    <p className="mt-1 text-xs text-fg-muted">
                      {discoveryItems.length.toLocaleString()} matching capabilities
                      {filter === "all" && counts.pack > 0
                        ? ` · ${counts.pack.toLocaleString()} ${counts.pack === 1 ? "pack" : "packs"} managed separately`
                        : ""}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("custom")}>
                    <PlusIcon />
                    Add custom
                  </Button>
                </div>

                <div className="sticky top-11 z-10 rounded-xl border border-border bg-bg/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-bg/85">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="relative min-w-0 flex-1">
                      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search by task, product, or capability"
                        className="h-10 pl-9"
                        aria-label="Search capabilities"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:flex">
                      <Select
                        aria-label="Capability format"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value as CapabilityFilter)}
                        className="h-10 min-w-0 text-xs sm:w-36"
                      >
                        {FILTERS.map((kind) => (
                          <option key={kind} value={kind}>
                            {capabilityFilterLabel(kind)} · {counts[kind]}
                          </option>
                        ))}
                      </Select>
                      <Select
                        aria-label="Capability source"
                        value={sourceFilter}
                        onChange={(event) => setSourceFilter(event.target.value as DiscoverySource)}
                        className="h-10 min-w-0 text-xs sm:w-40"
                      >
                        <option value="all">All sources</option>
                        <option value="opengeni">OpenGeni</option>
                        <option value="verified">Verified library</option>
                        <option value="community">Community registry</option>
                        <option value="custom">Custom</option>
                      </Select>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5" aria-label="Categories">
                    {DISCOVERY_CATEGORIES.map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={category === value}
                        onClick={() => setCategory(value)}
                        className={cn(
                          "inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-xs font-medium transition-colors",
                          category === value
                            ? "border-brand/30 bg-brand/10 text-brand"
                            : "border-border bg-surface/40 text-fg-muted hover:border-border-strong hover:text-fg",
                        )}
                      >
                        {discoveryCategoryLabel(value)}
                      </button>
                    ))}
                  </div>
                </div>

                {catalogView === "loading" ? (
                  <CapabilityRowSkeletons />
                ) : catalogView === "error" ? (
                  <LoadErrorState
                    title="Couldn't load capabilities"
                    error={loadError}
                    onRetry={() => void refresh()}
                  />
                ) : discoveryItems.length === 0 ? (
                  <RegistryFallback
                    query={query}
                    busy={registryBusy}
                    searched={registrySearched}
                    results={visibleRegistry}
                    onSearch={() => void searchRegistry()}
                    logoUrl={logoUrl}
                    onOpen={(item) => openItem(item, true)}
                    emptyDefault={items.length === 0}
                  />
                ) : (
                  <>
                    <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
                      {visibleDiscover.map((item) => (
                        <CapabilityInventoryRow
                          key={item.id}
                          item={item}
                          health={connectionHealth(item, connections ?? [], connectionsLoaded)}
                          logoSrc={logoUrl(item)}
                          busy={busyId === item.id}
                          onOpen={() => openItem(item)}
                          onDisable={() => void disableFromStrip(item)}
                          focusTarget
                        />
                      ))}
                    </div>
                    {visibleCount < discoveryItems.length ? (
                      <LoadMoreSentinel
                        onReach={() =>
                          setVisibleCount((count) =>
                            Math.min(count + PAGE_SIZE, discoveryItems.length),
                          )
                        }
                      />
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
          </TabsContent>

          <TabsContent value="connections" className="mt-6 space-y-8">
            <section>
              <h2 className="text-base font-semibold text-fg">Connections and identities</h2>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">
                Connections provide credentials and provider identity. Workspace and personal
                principals are separate; connecting one never substitutes for the other.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <MetaChip dot="idle">
                  {connectionsLoaded ? `${activeConnectionCount} active` : "Health unavailable"}
                </MetaChip>
                <MetaChip>Workspace shared by default</MetaChip>
                <MetaChip>Personal access stays subject scoped</MetaChip>
              </div>
            </section>

            <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
              <GoogleDriveConnectorCard workspaceId={workspaceId} />
            </Suspense>

            <section aria-labelledby="slack-connections-heading">
              <div>
                <h2 id="slack-connections-heading" className="text-sm font-semibold text-fg">
                  Slack
                </h2>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-fg-muted">
                  Two explicit principals: your Slack identity and the workspace bot.
                </p>
              </div>

              <div className="mt-3 grid gap-4 xl:grid-cols-2">
                <PersonalSlackAccountCard
                  available={personalSlackItem !== null}
                  canManage={canManagePersonalSlack}
                  busy={personalSlackBusy}
                  accountState={personalSlackStatus}
                  onConnect={() => void startPersonalSlackOAuth()}
                  onReconnect={() => void startPersonalSlackOAuth()}
                  onDisconnect={() => setPersonalSlackDisconnectOpen(true)}
                />

                <section
                  className="rounded-xl border border-border bg-surface p-4"
                  aria-labelledby="workspace-slack-bot-heading"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-fg-muted/10 text-fg-muted">
                      <Building2Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3
                          id="workspace-slack-bot-heading"
                          className="text-sm font-semibold text-fg"
                        >
                          OpenGeni workspace bot
                        </h3>
                        <MetaChip>Workspace · bot identity</MetaChip>
                      </div>
                      <p className="mt-1 max-w-xl text-xs leading-5 text-fg-muted">
                        First-party Slack tools and explicitly bound scheduled tasks. It never uses
                        a person's Slack grant.
                      </p>
                    </div>
                  </div>

                  {slackBotConnection && slackBotMetadata ? (
                    <>
                      <div className="mt-4 flex items-start gap-3 rounded-lg border border-brand/20 bg-brand/5 p-3">
                        <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-brand" />
                        <div>
                          <p className="text-sm font-semibold text-fg">
                            {slackBotConnection.status === "active"
                              ? `Installed in ${slackBotMetadata.slackTeamName}`
                              : `Reinstall needed for ${slackBotMetadata.slackTeamName}`}
                          </p>
                          <p className="mt-0.5 text-xs text-fg-muted">
                            {slackBotConnection.status === "active"
                              ? "Ready for the workspace."
                              : "Reinstall to restore Slack access."}
                          </p>
                        </div>
                      </div>
                      <SlackReactionSummonCard
                        workspaceId={workspaceId}
                        connection={slackBotConnection}
                        canManage={canManageSlackReaction}
                        installBusy={slackBotBusy}
                        onReinstall={() => void installSlackBot(false)}
                      />
                      <details className="group mt-3 border-t border-border/70 pt-3">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
                          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
                          <span>Permissions and installation details</span>
                        </summary>
                        <div className="mt-3 rounded-md bg-bg/50 p-3">
                          <p className="text-2xs font-medium text-fg-muted">Required bot scopes</p>
                          <p className="mt-1 break-words font-mono text-2xs leading-relaxed text-fg-subtle">
                            {OPENGENI_SLACK_BOT_REQUIRED_SCOPES.join(", ")}
                          </p>
                          <SlackBotInstallControls
                            canInstall={canInstallSlackBot}
                            hasConnection
                            busy={slackBotBusy}
                            onInstall={(createNewConnection) =>
                              void installSlackBot(createNewConnection)
                            }
                          />
                          {slackBotConnection.status === "active" ? (
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
                        onInstall={(createNewConnection) =>
                          void installSlackBot(createNewConnection)
                        }
                      />
                      <details className="group mt-3">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-2xs text-fg-subtle transition-colors hover:text-fg-muted">
                          <ChevronDownIcon className="size-3 shrink-0 transition-transform group-open:rotate-180" />
                          <span>Permissions requested</span>
                        </summary>
                        <WorkspaceSlackBotRequestedScopes />
                      </details>
                    </>
                  )}
                </section>
              </div>
            </section>

            {currentRows.some((row) => row.item.connectionRef) ? (
              <CapabilityListSection
                title="Other connected capabilities"
                description="Connection-backed catalog items that are currently available."
                rows={currentRows.filter((row) => row.item.connectionRef)}
                logoUrl={logoUrl}
                busyId={busyId}
                onOpen={openItem}
                onDisable={disableFromStrip}
              />
            ) : null}
          </TabsContent>

          <TabsContent value="custom" className="mt-6 space-y-8">
            <section className="rounded-xl border border-border bg-surface/40 p-5 sm:flex sm:items-center sm:justify-between sm:gap-6">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-bg text-fg-muted">
                  <WrenchIcon className="size-4" />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-fg">
                    Build or add a custom capability
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
                    Add a remote MCP server, API, skill, or plugin. Catalog metadata does not make a
                    capability executable unless a compatible runtime adapter exists.
                  </p>
                </div>
              </div>
              <Button type="button" className="mt-4 sm:mt-0" onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add custom
              </Button>
            </section>

            <section aria-labelledby="custom-inventory-heading">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 id="custom-inventory-heading" className="text-sm font-semibold text-fg">
                    Custom inventory
                  </h2>
                  <p className="mt-1 text-xs text-fg-muted">
                    Configured deployment tools and items added by this workspace.
                  </p>
                </div>
                <MetaChip>{customItems.length} items</MetaChip>
              </div>
              {customItems.length > 0 ? (
                <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface/30">
                  {customItems.map((item) => (
                    <CapabilityInventoryRow
                      key={item.id}
                      item={item}
                      health={connectionHealth(item, connections ?? [], connectionsLoaded)}
                      logoSrc={logoUrl(item)}
                      busy={busyId === item.id}
                      onOpen={() => openItem(item)}
                      onDisable={() => void disableFromStrip(item)}
                      focusTarget
                    />
                  ))}
                </div>
              ) : (
                <div className="mt-3">
                  <EmptyState
                    icon={<WrenchIcon className="size-4" />}
                    title="No custom capabilities"
                    description="Use Add custom when a reviewed capability is not already in Discover."
                  />
                </div>
              )}
            </section>

            <section className="grid gap-3 md:grid-cols-2">
              <AdvancedBoundaryCard
                icon={<ShieldCheckIcon />}
                title="Workspace policy"
                description="Sessions and child agents may narrow access, but cannot override workspace-level denies or borrow another user's connection."
              />
              <AdvancedBoundaryCard
                icon={<Layers3Icon />}
                title="Skill and pack precedence"
                description="Session skills override packs, packs override curated selections, and curated selections override same-named bundled skills."
              />
            </section>
          </TabsContent>
        </Tabs>

        <ConfirmDialog
          open={personalSlackDisconnectOpen}
          onOpenChange={setPersonalSlackDisconnectOpen}
          title="Disconnect your Slack account?"
          description="OpenGeni will stop using this subject-owned grant. This does not disconnect the workspace bot or revoke provider-side access in Slack."
          confirmLabel="Disconnect my Slack account"
          cancelAutoFocus
          onConfirm={disconnectPersonalSlack}
        />
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
        socialConnection={selectedSocialConnection}
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

type CurrentCapabilityRow = {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
};

function SummaryMetric({
  label,
  value,
  icon,
  attention = false,
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  attention?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-r border-border p-3 last:border-r-0 lg:border-b-0 lg:p-4">
      <div
        className={cn(
          "flex items-center gap-2 text-2xs font-medium",
          attention ? "text-status-waiting" : "text-fg-subtle",
        )}
      >
        <span className="[&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-fg">{value}</div>
    </div>
  );
}

function CapabilityRowSkeletons() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
      {["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"].map((key) => (
        <div
          key={key}
          className="flex min-h-14 items-center gap-3 border-b border-border px-3 last:border-0"
        >
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="mt-1.5 h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-6 w-20 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function RecommendationCard({
  icon,
  title,
  description,
  action,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-32 flex-col rounded-xl border border-border bg-surface/40 p-4 text-left transition-colors hover:border-border-strong hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span className="grid size-8 place-items-center rounded-lg border border-border bg-bg text-fg-muted [&_svg]:size-4">
        {icon}
      </span>
      <span className="mt-3 text-sm font-semibold text-fg">{title}</span>
      <span className="mt-1 flex-1 text-xs leading-5 text-fg-muted">{description}</span>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted group-hover:text-fg">
        {action}
        <ChevronRightIcon className="size-3.5" />
      </span>
    </button>
  );
}

function CapabilityListSection({
  title,
  description,
  rows,
  logoUrl,
  busyId,
  onOpen,
  onDisable,
}: {
  title: string;
  description: string;
  rows: CurrentCapabilityRow[];
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  busyId: string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
  onDisable: (item: CapabilityCatalogItem) => void | Promise<void>;
}) {
  return (
    <section aria-labelledby={`capability-section-${slugId(title)}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`capability-section-${slugId(title)}`} className="text-sm font-semibold text-fg">
            {title}
          </h2>
          <p className="mt-1 text-xs text-fg-muted">{description}</p>
        </div>
        <MetaChip>{rows.length}</MetaChip>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface/30">
        {rows.map(({ item, health }) => (
          <CapabilityInventoryRow
            key={item.id}
            item={item}
            health={health}
            logoSrc={logoUrl(item)}
            busy={busyId === item.id}
            onOpen={() => onOpen(item)}
            onDisable={() => void onDisable(item)}
            focusTarget
          />
        ))}
      </div>
    </section>
  );
}

function CapabilityInventoryRow({
  item,
  health,
  logoSrc,
  busy,
  onOpen,
  onDisable,
  focusTarget = false,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  onOpen: () => void;
  onDisable?: () => void;
  focusTarget?: boolean;
}) {
  const needsAttention = health.state === "attention";
  const canDisable = item.source !== "built_in" && item.source !== "configured";
  const status = !item.enabled
    ? { label: capabilityUnavailableLabel(item), dot: "bg-fg-subtle/45", text: "text-fg-subtle" }
    : needsAttention
      ? { label: "Needs attention", dot: "bg-status-waiting", text: "text-status-waiting" }
      : item.stale
        ? { label: "No longer in registry", dot: "bg-fg-subtle/60", text: "text-fg-subtle" }
        : {
            label: capabilityAvailabilityLabel(item, health),
            dot: "bg-status-idle",
            text: "text-fg-subtle",
          };
  const scope = capabilityScopeLabel(item, health);
  const source = capabilitySourceShortLabel(item);

  return (
    <div className="group flex min-h-14 items-center gap-2 border-b border-border px-2 last:border-0 hover:bg-surface/60 sm:gap-3 sm:px-3">
      <button
        type="button"
        onClick={onOpen}
        data-capability-focus-target={focusTarget ? "" : undefined}
        data-capability-id={item.id}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
      >
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{item.name}</span>
            {item.tier === "verified" || item.source === "library" ? (
              <ShieldCheckIcon className="size-3.5 shrink-0 text-fg-subtle" aria-label="Verified" />
            ) : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-fg-subtle">
            <span className={cn("inline-flex min-w-0 items-center gap-1.5", status.text)}>
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              <span className="truncate">{status.label}</span>
            </span>
            <span aria-hidden className="text-fg-subtle/50">
              ·
            </span>
            <span className="truncate">{capabilityKindLabel(item.kind)}</span>
            <span aria-hidden className="hidden text-fg-subtle/50 sm:inline">
              ·
            </span>
            <span className="hidden truncate sm:inline">{scope}</span>
          </div>
        </div>
      </button>
      <div className="hidden shrink-0 items-center gap-1.5 lg:flex">
        <MetaChip>{source}</MetaChip>
        {scope !== source ? <MetaChip>{scope}</MetaChip> : null}
      </div>
      {item.enabled && canDisable && onDisable ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onDisable}
          className="shrink-0"
        >
          {busy ? <Loader2Icon className="animate-spin" /> : "Disable"}
        </Button>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${item.name} details`}
          className="grid size-10 shrink-0 place-items-center rounded-md text-fg-subtle opacity-70 transition-colors hover:bg-bg hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

function AdvancedBoundaryCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <article className="flex items-start gap-3 rounded-xl border border-border bg-surface/30 p-4">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-bg text-fg-muted [&_svg]:size-4">
        {icon}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-fg-muted">{description}</p>
      </div>
    </article>
  );
}

function compareCurrentCapabilityRows(left: CurrentCapabilityRow, right: CurrentCapabilityRow) {
  const leftAttention = left.health.state === "attention" ? 0 : 1;
  const rightAttention = right.health.state === "attention" ? 0 : 1;
  return (
    leftAttention - rightAttention ||
    capabilitySourceRank(left.item) - capabilitySourceRank(right.item) ||
    left.item.name.localeCompare(right.item.name)
  );
}

function capabilitySourceRank(item: CapabilityCatalogItem): number {
  if (item.source === "manual" || item.source === "library") return 0;
  if (item.source === "configured") return 1;
  return 2;
}

function capabilityAvailabilityLabel(
  item: CapabilityCatalogItem,
  health: ConnectionHealth,
): string {
  if (health.state === "connected") return "Connected";
  if (item.source === "built_in") return "Built in";
  if (item.source === "configured") return "Configured";
  if (item.source === "library") return "Selected for workspace";
  return "Added to workspace";
}

function capabilityUnavailableLabel(item: CapabilityCatalogItem): string {
  if (item.source === "library") return "Available to add";
  if (item.authKind === "oauth2" || item.authKind === "api_key") return "Connection required";
  if (!item.runtime.available) return "Metadata only";
  return "Available to add";
}

function capabilityScopeLabel(item: CapabilityCatalogItem, health: ConnectionHealth): string {
  if (item.connectionRef?.subjectScope === "subject") return "Only me";
  if (item.connectionRef?.subjectScope === "workspace" || health.state === "connected") {
    return health.state === "connected" && health.connection.subjectId !== null
      ? "Only me"
      : "Workspace";
  }
  if (item.source === "built_in" || item.source === "configured") return "Deployment";
  return "Workspace";
}

function capabilitySourceShortLabel(item: CapabilityCatalogItem): string {
  if (item.source === "built_in") return "OpenGeni";
  if (item.source === "library") return "Verified library";
  if (item.source === "configured") return "Deployment";
  if (item.source === "registry" || item.source === "public_registry") return "Community";
  return "Custom";
}

function matchesDiscoveryCategory(
  item: CapabilityCatalogItem,
  category: DiscoveryCategory,
): boolean {
  if (category === "all") return true;
  const haystack = [item.category, item.name, item.description, ...item.tags]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const terms: Record<Exclude<DiscoveryCategory, "all">, string[]> = {
    work: ["productivity", "communication", "project", "crm", "calendar", "slack", "linear"],
    development: ["development", "developer", "code", "github", "git", "database", "testing"],
    knowledge: ["knowledge", "document", "search", "files", "drive", "research"],
    marketing: ["marketing", "social", "sales", "content", "campaign"],
    infrastructure: ["infrastructure", "terraform", "checkov", "cloud", "devops", "security"],
  };
  return terms[category].some((term) => haystack.includes(term));
}

function matchesDiscoverySource(item: CapabilityCatalogItem, source: DiscoverySource): boolean {
  if (source === "all") return true;
  if (source === "opengeni") return item.source === "built_in" || item.source === "configured";
  if (source === "verified") return item.source === "library" || item.tier === "verified";
  if (source === "community") {
    return item.source === "registry" || item.source === "public_registry";
  }
  return item.source === "manual";
}

function discoveryCategoryLabel(category: DiscoveryCategory): string {
  switch (category) {
    case "all":
      return "All work";
    case "work":
      return "Work & productivity";
    case "development":
      return "Development";
    case "knowledge":
      return "Knowledge";
    case "marketing":
      return "Marketing";
    case "infrastructure":
      return "Infrastructure";
  }
}

function slugId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// Empty catalog results: offer the public MCP registry, then render registry
// hits as tiles that open the same connect sheet.
function RegistryFallback({
  query,
  busy,
  searched,
  results,
  onSearch,
  logoUrl,
  onOpen,
  emptyDefault,
}: {
  query: string;
  busy: boolean;
  searched: string | null;
  results: CapabilityCatalogItem[];
  onSearch: () => void;
  logoUrl: (item: CapabilityCatalogItem) => string | null;
  onOpen: (item: CapabilityCatalogItem) => void;
  emptyDefault: boolean;
}) {
  const term = query.trim();

  if (results.length > 0) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-fg-subtle">From the public MCP registry</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {results.map((item) => (
            <CapabilityTile
              key={item.id}
              item={item}
              logoSrc={logoUrl(item)}
              onOpen={() => onOpen(item)}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!term) {
    return (
      <EmptyState
        icon={<PlugIcon className="size-4" />}
        title={emptyDefault ? "Nothing here yet" : "No matches for this filter"}
        description={
          emptyDefault
            ? "Search the catalog above, or add a custom MCP server, API, skill, or plugin."
            : "Try a different filter or search term."
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<GlobeIcon className="size-4" />}
      title={
        searched && searched === term
          ? `No registry servers match “${term}”`
          : `No catalog matches for “${term}”`
      }
      description="Search the public MCP registry for a server to connect."
      action={
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onSearch}>
          {busy ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
          Search the public MCP registry
        </Button>
      }
    />
  );
}

// A sentinel that loads the next window of tiles when scrolled into view. The
// observer is created ONCE per mount and reads the latest callback through a
// ref — the parent passes a fresh inline onReach every render, and rebuilding
// the observer each time would re-fire the intersection immediately while the
// sentinel is still in view, defeating the windowing (a runaway page load).
function LoadMoreSentinel({ onReach }: { onReach: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onReachRef = useRef(onReach);
  useEffect(() => {
    onReachRef.current = onReach;
  }, [onReach]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="h-1" aria-hidden />;
}
