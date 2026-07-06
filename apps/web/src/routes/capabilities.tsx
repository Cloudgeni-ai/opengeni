// Capabilities: the workspace integrations marketplace. A single scrollable
// page — a large search, kind filters, an "Enabled" strip the user manages
// daily, and a logo tile grid over the full catalog (1,000+ items, rendered
// incrementally). Credentialed MCP servers connect through the connections
// spine (OAuth redirect or an API-key form) in a right-hand detail sheet, never
// by hand-editing enable headers. Packs keep their first-class register/enable/
// disable/unregister surface, restyled flat.
import { useEnvironments, usePacks } from "@opengeni/react";
import { GlobeIcon, Loader2Icon, PlugIcon, PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AddCustomDialog } from "@/components/capabilities/add-custom-dialog";
import { CapabilityDetailSheet, type ConnectAction } from "@/components/capabilities/capability-detail-sheet";
import { CapabilityLogo } from "@/components/capabilities/capability-logo";
import { CapabilityTile } from "@/components/capabilities/capability-tile";
import { PacksSection } from "@/components/capabilities/packs-section";
import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import {
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
  oauthResumeAction,
  registryResultsForQuery,
  resolveSheetItem,
  type CapabilityFilter,
  type CapabilityFormState,
  type ConnectionHealth,
  type SheetSelection,
} from "@/lib/capabilities";
import { listViewState } from "@/lib/load-state";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem, CapabilityPack, ConnectionMetadata } from "@/types";

const PAGE_SIZE = 48;
const FILTERS: CapabilityFilter[] = ["all", "pack", "mcp", "api", "skill", "plugin"];

export function CapabilitiesRoute({ workspaceId, initialSection }: { workspaceId: string; initialSection?: "packs" }) {
  const context = useAppContext();
  const client = context.client;
  const onRuntimeChanged = useCallback(() => void context.refreshWorkspaceMcpServers(workspaceId), [context, workspaceId]);

  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  // null = connections have not loaded (or the load failed, e.g. the grant lacks
  // connections:read); an array = loaded, even when empty. Health must not treat a
  // failed load as "every connection was deleted".
  const [connections, setConnections] = useState<ConnectionMetadata[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [filter, setFilter] = useState<CapabilityFilter>(initialSection === "packs" ? "pack" : "all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Detail/connect sheet. We store the id (+ registry flag + a snapshot for
  // registry items not yet in the catalog), NOT the item object: the rendered
  // item is derived from the LIVE `items` list by id, so any mutation + refresh
  // (strip disable, pack disable, background reload) re-derives the sheet instead
  // of leaving it on a stale snapshot that could re-enable what was just disabled.
  const [selected, setSelected] = useState<SheetSelection | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Public MCP registry search (only offered when the catalog has no matches).
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [registrySearched, setRegistrySearched] = useState<string | null>(null);

  const packs = usePacks({ workspaceId });
  const environments = useEnvironments({ workspaceId });

  const counts = useMemo(() => capabilityCounts(items), [items]);
  const catalogView = listViewState({ loading, error: loadError, count: items.length });

  const filtered = useMemo(
    () => filterCapabilityCatalogItems(items, filter, query).filter((item) => item.kind !== "pack"),
    [items, filter, query],
  );
  // The Enabled strip is the daily-management surface; Browse shows the rest of
  // the catalog so an enabled item never appears in both places.
  const enabledItems = useMemo(() => filtered.filter((item) => item.enabled), [filtered]);
  const browseItems = useMemo(() => filtered.filter((item) => !item.enabled), [filtered]);
  const visibleBrowse = browseItems.slice(0, visibleCount);

  const showPacks = filter === "all" || filter === "pack";
  const showCatalog = filter !== "pack";

  const logoUrl = useCallback((item: CapabilityCatalogItem) => client.catalogAssetUrl(item.logoAssetPath), [client]);
  const connectionsLoaded = connections !== null;
  // The item the sheet renders, always from the live catalog. Registry items
  // aren't in `items` until persisted, so they fall back to their snapshot; a
  // non-registry selection with no live row resolves to null and the effect
  // below closes the sheet rather than render a ghost.
  const selectedItem: CapabilityCatalogItem | null = useMemo(() => resolveSheetItem(selected, items), [selected, items]);
  const selectedHealth: ConnectionHealth = selectedItem
    ? connectionHealth(selectedItem, connections ?? [], connectionsLoaded)
    : { state: "none" };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Reset the incremental window whenever the result set changes.
  useEffect(() => setVisibleCount(PAGE_SIZE), [filter, query]);

  // Close the sheet if a live-bound selection vanished from the catalog after a
  // refresh (deleted/unregistered elsewhere) — never leave a ghost open. A
  // snapshot-fallback selection (registry result, or a just-created item not yet
  // in `items`, e.g. after a failed refresh) legitimately isn't in the catalog
  // yet, so it renders from its snapshot instead of being closed here.
  useEffect(() => {
    if (selected && !selected.snapshotFallback && !loading && !items.some((entry) => entry.id === selected.id)) {
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
      const [catalog, conns] = await Promise.all([
        client.listCapabilities(workspaceId),
        // null (not []) on failure so health can tell "didn't load" from "loaded empty".
        client.listConnections(workspaceId).catch(() => null),
      ]);
      setItems(catalog.items);
      setConnections(conns);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load capabilities", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  function refreshAll() {
    void refresh();
    void packs.refresh();
  }

  // `snapshotFallback` defaults to `registry` (a registry result renders from its
  // snapshot until persisted); the add-custom flow passes it explicitly for a
  // just-created item whose row may not be in `items` yet.
  function openItem(item: CapabilityCatalogItem, registry = false, snapshotFallback = registry) {
    setSheetError(null);
    setSelected({ id: item.id, registry, snapshotFallback, snapshot: item });
  }

  // --- Connect flows ---------------------------------------------------------

  // Registry items aren't persisted; create the catalog row before connecting so
  // enable/OAuth have a real capability id to reference.
  async function persistIfRegistry(item: CapabilityCatalogItem, registry: boolean): Promise<CapabilityCatalogItem> {
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

      // Reconnect an already-enabled item whose credential lapsed. When the
      // connection row survives, OAuth reuses it (pass connectionId) and the
      // return handler just refreshes; when it was deleted (null id), OAuth
      // mints a fresh row and the return handler re-enables against it. API-key
      // reactivates the surviving row in place, or mints + re-enables if gone.
      if (action.type === "reconnect_oauth") {
        // Trust the installation's connectionRef.kind (the sheet already chose this
        // branch from it), not the catalog plan — on drift plan.mode can read
        // "enable", so fall back to the ref's domain and the item's own MCP URL.
        const providerDomain = plan.mode === "oauth" ? plan.providerDomain : item.connectionRef?.providerDomain ?? null;
        const mcpUrl = plan.mode === "oauth" ? plan.mcpUrl : item.mcpUrl ?? item.endpointUrl ?? null;
        const returnPath = `${window.location.pathname}?connect_item=${encodeURIComponent(item.id)}`;
        const response = await client.startConnectionOAuth(workspaceId, {
          ...(mcpUrl ? { mcpUrl } : {}),
          ...(providerDomain ? { providerDomain } : {}),
          // Reuse the existing row when it survives; a null id means the row was
          // deleted, so OAuth mints a fresh connection and the return handler
          // re-enables against it.
          ...(action.connectionId ? { connectionId: action.connectionId } : {}),
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
          const providerDomain = plan.mode === "enable" ? item.connectionRef?.providerDomain ?? "" : plan.providerDomain;
          const connection = await client.createConnection(workspaceId, {
            providerDomain,
            kind: "api_key",
            credential: { headers: action.headers },
          });
          await client.enableCapability(workspaceId, item.id, {
            connectionRef: { connectionId: connection.id, providerDomain: connection.providerDomain, kind: "api_key" },
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
        const response = await client.startConnectionOAuth(workspaceId, {
          ...(plan.mcpUrl ? { mcpUrl: plan.mcpUrl } : {}),
          ...(plan.providerDomain ? { providerDomain: plan.providerDomain } : {}),
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
        // Reuse an existing workspace connection rather than creating a duplicate
        // on a retry; only mint a new one when none exists.
        const reuseId = connectionToReuseForApiKey(item, connections ?? [], plan.providerDomain);
        const connection = reuseId
          ? await client.updateConnection(workspaceId, reuseId, {
              credential: { headers: action.headers },
              status: "active",
            })
          : await client.createConnection(workspaceId, {
              providerDomain: plan.providerDomain,
              kind: "api_key",
              credential: { headers: action.headers },
            });
        // Build the enable ref from the connection row the API returns, never the
        // catalog domain — the API may canonicalize providerDomain, and the row
        // is the authoritative match the enable path validates against.
        await client.enableCapability(workspaceId, persisted.id, {
          connectionRef: { connectionId: connection.id, providerDomain: connection.providerDomain, kind: "api_key" },
        });
        await refresh();
        onRuntimeChanged();
        toast.success(`Connected and enabled ${persisted.name}`);
        setSelected(null);
        return;
      }

      // Plain enable / track (no credentials).
      await client.enableCapability(workspaceId, persisted.id);
      await refresh();
      if (persisted.kind === "mcp") onRuntimeChanged();
      toast.success(persisted.kind === "mcp" ? `Enabled ${persisted.name}` : `Tracking ${persisted.name}`);
      setSelected(null);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Something went wrong");
      // In-sheet human copy; the raw missing-credentials 422 becomes a prompt to
      // connect rather than an error string.
      setSheetError(isMissingCredentialsError(error) ? "This integration needs credentials before it can be enabled." : copy.description);
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

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
      void resumeOAuthConnect(itemId, params.get("connectionId"));
    } else {
      const reason = params.get("reason");
      const item = itemId ? items.find((candidate) => candidate.id === itemId) ?? null : null;
      if (item) {
        setSheetError(reason ? `Couldn't connect: ${reason}.` : "Couldn't connect. Please try again.");
        setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
      } else {
        toast.error("Connection failed", { description: reason ?? undefined });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, items]);

  async function resumeOAuthConnect(itemId: string | null, connectionId: string | null) {
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
      setConnections(conns);
      const item = (itemId ? catalog.items.find((candidate) => candidate.id === itemId) : undefined) ?? null;
      const action = oauthResumeAction(item, connectionId);

      if (action === "missing") {
        // Connection was created but the catalog row is gone — never leave the
        // success half-handled silently; say plainly it wasn't enabled.
        toast.success("Connected — but this integration is no longer in the catalog, so it wasn't enabled.");
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

      // Enable against the AUTHORITATIVE connection row (matched by the id from
      // the redirect), never a domain reconstructed from catalog data — the API
      // canonicalizes providerDomain, and the row is what the enable path
      // validates against. A missing row means we can't enable safely.
      const connection = conns?.find((candidate) => candidate.id === connectionId) ?? null;
      if (!connection) {
        toast.success(`Connected ${item!.name}. Open it to finish enabling.`);
        return;
      }
      await client.enableCapability(workspaceId, item!.id, {
        connectionRef: { connectionId: connection.id, providerDomain: connection.providerDomain, kind: "oauth2" },
      });
      await refresh();
      onRuntimeChanged();
      // An already-enabled item reached here only because its old connection row
      // was gone and OAuth minted a new one — that's a reconnect, not a first enable.
      toast.success(item!.enabled ? `Reconnected ${item!.name}` : `Connected and enabled ${item!.name}`);
      setSelected(null);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Couldn't finish connecting");
      setSheetError(copy.description);
      // Reopen the sheet on the item so the failure has a Retry, when resolvable.
      const item = itemId ? (freshItems ?? items).find((candidate) => candidate.id === itemId) ?? null : null;
      if (item) setSelected({ id: item.id, registry: false, snapshotFallback: false, snapshot: item });
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
          toast.success(created.kind === "mcp" ? `Added and enabled ${created.name}` : `Added and tracking ${created.name}`);
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
      const response = await client.discoverMcpCapabilities(workspaceId, { query: term, limit: 30 });
      setRegistryResults(response.items);
      setRegistrySearched(term);
    } catch (error) {
      setRegistryResults([]);
      setRegistrySearched(null);
      toast.error("Registry search failed", { description: error instanceof Error ? error.message : String(error) });
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
      const registered = await client.registerPack(workspaceId, manifest as Parameters<typeof client.registerPack>[1]);
      await Promise.all([packs.refresh(), refresh()]);
      toast.success(`Registered ${registered.pack.name} v${registered.pack.version}`);
      return true;
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to register pack");
      toast.error(copy.title, { description: copy.description });
      return false;
    }
  }

  async function enablePack(pack: CapabilityPack, environmentId: string | undefined) {
    setBusyId(`pack:${pack.id}`);
    try {
      await client.enableCapability(workspaceId, `pack:${pack.id}`, environmentId ? { environmentId } : {});
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
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={<PlugIcon className="size-4" />}
        title="Capabilities"
        description="Connect integrations and enable the tools, packs, and skills your agents can use."
        actions={(
          <>
            <Button type="button" variant="ghost" size="sm" onClick={refreshAll} disabled={loading || packs.loading}>
              <RefreshCwIcon className={cn((loading || packs.loading) && "animate-spin")} />
              Refresh
            </Button>
            <Button type="button" onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add custom
            </Button>
          </>
        )}
      />

      {/* Primary search — front and center. */}
      <div className="relative mt-6">
        <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search integrations, tools, and skills"
          className="h-12 rounded-xl pl-11 text-base"
          aria-label="Search capabilities"
        />
      </div>

      {/* Kind filters with counts. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setFilter(kind)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              filter === kind
                ? "border-brand/40 bg-brand/10 text-brand"
                : "border-border bg-surface/50 text-fg-muted hover:border-border-strong hover:text-fg",
            )}
          >
            {capabilityFilterLabel(kind)}
            <span className={cn("text-2xs", filter === kind ? "text-brand/70" : "text-fg-subtle")}>{counts[kind]}</span>
          </button>
        ))}
      </div>

      <div className="mt-8 space-y-10">
        {/* Enabled strip. */}
        {showCatalog && enabledItems.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-fg">Enabled</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {enabledItems.map((item) => (
                <EnabledCard
                  key={item.id}
                  item={item}
                  health={connectionHealth(item, connections ?? [], connectionsLoaded)}
                  logoSrc={logoUrl(item)}
                  busy={busyId === item.id}
                  onOpen={() => openItem(item)}
                  onDisable={() => void disableFromStrip(item)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* Packs. */}
        {showPacks ? (
          <PacksSection
            packs={packs}
            environments={environments.environments.map((environment) => ({ id: environment.id, name: environment.name }))}
            busyPackId={packBusyId}
            onRegister={registerPackManifest}
            onEnable={(pack, environmentId) => void enablePack(pack, environmentId)}
            onDisable={(pack) => void disablePack(pack)}
            onUnregister={unregisterPack}
          />
        ) : null}

        {/* Browse grid. */}
        {showCatalog ? (
          <section className="space-y-4">
            {filter === "all" || enabledItems.length > 0 ? (
              <h2 className="text-sm font-semibold text-fg">Browse</h2>
            ) : null}

            {catalogView === "loading" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, index) => (
                  <div key={index} className="rounded-xl border border-border bg-surface/50 p-4">
                    <Skeleton className="size-10 rounded-lg" />
                    <Skeleton className="mt-3 h-4 w-24" />
                    <Skeleton className="mt-2 h-3 w-full" />
                    <Skeleton className="mt-1.5 h-3 w-2/3" />
                  </div>
                ))}
              </div>
            ) : catalogView === "error" ? (
              <LoadErrorState title="Couldn't load capabilities" error={loadError} onRetry={() => void refresh()} />
            ) : browseItems.length === 0 ? (
              <RegistryFallback
                query={query}
                busy={registryBusy}
                searched={registrySearched}
                results={visibleRegistry}
                onSearch={() => void searchRegistry()}
                logoUrl={logoUrl}
                onOpen={(item) => openItem(item, true)}
                emptyDefault={enabledItems.length === 0}
              />
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleBrowse.map((item) => (
                    <CapabilityTile key={item.id} item={item} logoSrc={logoUrl(item)} onOpen={() => openItem(item)} />
                  ))}
                </div>
                {visibleCount < browseItems.length ? (
                  <LoadMoreSentinel onReach={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, browseItems.length))} />
                ) : null}
              </>
            )}
          </section>
        ) : null}
      </div>

      <CapabilityDetailSheet
        item={selectedItem}
        health={selectedHealth}
        logoSrc={selectedItem ? logoUrl(selectedItem) : null}
        open={selectedItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setSheetError(null);
          }
        }}
        busy={busyId === selectedItem?.id}
        errorMessage={sheetError}
        onAction={handleAction}
      />

      <AddCustomDialog open={addOpen} onOpenChange={setAddOpen} busy={busyId === "add"} onSubmit={submitAddCustom} />
    </div>
  );
}

// A compact managed card in the Enabled strip.
function EnabledCard({
  item,
  health,
  logoSrc,
  busy,
  onOpen,
  onDisable,
}: {
  item: CapabilityCatalogItem;
  health: ConnectionHealth;
  logoSrc: string | null;
  busy: boolean;
  onOpen: () => void;
  onDisable: () => void;
}) {
  // Health is resolved by the installation's connection id: "attention" means the
  // row is missing or inactive; "none" means no connection is involved;
  // "unverified" means connections didn't load, so stay neutral (never amber).
  const needsAttention = health.state === "attention";
  const canDisable = item.source !== "built_in" && item.source !== "configured";
  // A broken connection ("Needs attention") is the actionable state, so it wins
  // the single status slot over staleness — which only gates discovery, still
  // runs fine, and so reads as quiet neutral text, never an amber alert.
  const status = needsAttention
    ? { label: "Needs attention", dot: "bg-status-waiting", text: "text-status-waiting" }
    : item.stale
      ? { label: "No longer in registry", dot: "bg-fg-subtle/60", text: "text-fg-subtle" }
      : { label: health.state === "connected" ? "Connected" : "Enabled", dot: "bg-status-idle", text: "text-fg-subtle" };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 p-3">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <CapabilityLogo src={logoSrc} name={item.name} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{item.name}</div>
          <div className={cn("flex items-center gap-1.5 text-2xs", status.text)}>
            <span className={cn("size-1.5 rounded-full", status.dot)} />
            {status.label}
            <span aria-hidden className="text-fg-subtle/50">·</span>
            <span className="truncate">{capabilityKindLabel(item.kind)}</span>
          </div>
        </div>
      </button>
      {canDisable ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDisable} className="shrink-0">
          {busy ? <Loader2Icon className="animate-spin" /> : "Disable"}
        </Button>
      ) : (
        <span className="shrink-0 px-2 text-2xs text-fg-subtle">Built in</span>
      )}
    </div>
  );
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
            <CapabilityTile key={item.id} item={item} logoSrc={logoUrl(item)} onOpen={() => onOpen(item)} />
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
        description={emptyDefault
          ? "Search the catalog above, or add a custom MCP server, API, skill, or plugin."
          : "Try a different filter or search term."}
      />
    );
  }

  return (
    <EmptyState
      icon={<GlobeIcon className="size-4" />}
      title={searched && searched === term ? `No registry servers match “${term}”` : `No catalog matches for “${term}”`}
      description="Search the public MCP registry for a server to connect."
      action={(
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onSearch}>
          {busy ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
          Search the public MCP registry
        </Button>
      )}
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
