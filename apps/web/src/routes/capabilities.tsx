// Capabilities: the workspace catalog (packs, MCPs, APIs, skills, plugins)
// plus the public MCP registry search and manual capability tracking. Packs —
// the heaviest, workspace-runtime-altering capability — render as a dedicated
// first-class subsection at the top, with register/enable-with-environment/
// disable/unregister. Pack enable rides the unified capability-enable path
// (pack:{id}), passing the initial environment attachment.
import { useEnvironments, usePacks } from "@opengeni/react";
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  ContainerIcon,
  FileCode2Icon,
  FilesIcon,
  GlobeIcon,
  Loader2Icon,
  PackageIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparkleIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import {
  capabilityCounts,
  capabilityErrorToast,
  capabilityFilterLabel,
  capabilityInputFromForm,
  createInputFromCatalogItem,
  emptyCapabilityForm,
  filterCapabilityCatalogItems,
  summarizePackContents,
  type CapabilityFilter,
  type CapabilityFormState,
  type PackContentsSummary,
} from "@/lib/capabilities";
import { listViewState } from "@/lib/load-state";
import { scheduleLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem, CapabilityPack, PackInstallation } from "@/types";

export function CapabilitiesRoute({ workspaceId, initialSection }: { workspaceId: string; initialSection?: "packs" }) {
  const context = useAppContext();
  const client = context.client;
  const onRuntimeChanged = () => void context.refreshWorkspaceMcpServers(workspaceId);
  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // The legacy /packs redirect lands here with section=packs, so open on the
  // Packs filter to keep that surface front-and-center.
  const [filter, setFilter] = useState<CapabilityFilter>(initialSection === "packs" ? "pack" : "all");
  const [query, setQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [addForm, setAddForm] = useState<CapabilityFormState>(() => emptyCapabilityForm());
  // Packs are their own data source (manifests + installations) so the rich
  // subsection can register/unregister and attach environments; the generic
  // catalog rows below render every other capability kind.
  const packs = usePacks({ workspaceId });
  const environments = useEnvironments({ workspaceId });
  const showPacks = filter === "all" || filter === "pack";
  const visibleItems = useMemo(
    // Packs render in the rich subsection, never as generic catalog rows.
    () => filterCapabilityCatalogItems(items, filter, query).filter((item) => item.kind !== "pack"),
    [items, filter, query],
  );
  const counts = useMemo(() => capabilityCounts(items), [items]);
  // Honest list state: a failed catalog load renders as an error with retry,
  // never as "No capabilities match this filter."; a catalog already on
  // screen keeps rendering through a background refresh.
  const catalogView = listViewState({ loading, error: loadError, count: items.length });

  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  async function refresh() {
    if (!workspaceId) {
      return;
    }
    setLoading(true);
    try {
      const catalog = await client.listCapabilities(workspaceId);
      setItems(catalog.items);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Failed to load capabilities", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  async function toggleCapability(item: CapabilityCatalogItem) {
    setBusyId(item.id);
    try {
      if (item.enabled && item.source !== "built_in" && item.source !== "configured") {
        await client.disableCapability(workspaceId, item.id);
        toast.success(item.kind === "pack" || item.kind === "mcp" ? "Capability disabled" : "Capability untracked");
      } else if (!item.enabled) {
        await client.enableCapability(workspaceId, item.id);
        toast.success(item.kind === "pack" || item.kind === "mcp" ? "Capability enabled" : "Capability tracked");
      }
      await refresh();
      if (item.kind === "mcp") {
        onRuntimeChanged();
      }
    } catch (error) {
      const copy = capabilityErrorToast(error, "Capability update failed");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function searchRegistry() {
    setRegistryBusy(true);
    try {
      const response = await client.discoverMcpCapabilities(workspaceId, { query: registryQuery, limit: 30 });
      setRegistryResults(response.items);
    } catch (error) {
      toast.error("MCP Registry search failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegistryBusy(false);
    }
  }

  async function addRegistryItem(item: CapabilityCatalogItem, enableAfterAdd: boolean) {
    setBusyId(item.id);
    try {
      const created = await client.createCapability(workspaceId, createInputFromCatalogItem(item));
      if (enableAfterAdd) {
        await client.enableCapability(workspaceId, created.id);
      }
      await refresh();
      if (enableAfterAdd) {
        onRuntimeChanged();
      }
      toast.success(enableAfterAdd ? "Public MCP added and enabled" : "Public MCP added");
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to add public MCP");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function submitManualCapability() {
    const input = capabilityInputFromForm(addForm);
    if (!input) {
      toast.error("Capability name is required");
      return;
    }
    setBusyId("new");
    try {
      const created = await client.createCapability(workspaceId, input);
      if (addForm.enableAfterAdd) {
        await client.enableCapability(workspaceId, created.id);
      }
      setAddForm(emptyCapabilityForm());
      await refresh();
      if (created.kind === "mcp" && addForm.enableAfterAdd) {
        onRuntimeChanged();
      }
      toast.success(addForm.enableAfterAdd
        ? created.kind === "pack" || created.kind === "mcp" ? "Capability added and enabled" : "Capability added and tracked"
        : "Capability added");
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to add capability");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  // --- Packs subsection actions ------------------------------------------------------------

  async function registerPackManifest(manifestDraft: string): Promise<boolean> {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestDraft);
    } catch {
      toast.error("Manifest must be valid JSON");
      return false;
    }
    const registered = await packs.register(manifest as Parameters<typeof packs.register>[0]);
    if (registered) {
      toast.success(`Pack ${registered.pack.id}@${registered.pack.version} registered`);
      await refresh();
      return true;
    }
    if (packs.mutationError) {
      const copy = capabilityErrorToast(packs.mutationError, "Failed to register pack");
      toast.error(copy.title, { description: copy.description });
      packs.clearMutationError();
    }
    return false;
  }

  async function enablePack(pack: CapabilityPack, environmentId: string | undefined) {
    setBusyId(`pack:${pack.id}`);
    try {
      // Pack enable rides the unified capability-enable path, which now accepts
      // and persists the initial environment attachment (env-on-enable).
      await client.enableCapability(workspaceId, `pack:${pack.id}`, environmentId ? { environmentId } : {});
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(`Pack ${pack.name} enabled`);
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
      // Disable rides the capability installation (pack:{id}), same as before.
      await client.disableCapability(workspaceId, `pack:${pack.id}`);
      await Promise.all([packs.refresh(), refresh()]);
      onRuntimeChanged();
      toast.success(`Pack ${pack.name} disabled`);
    } catch (error) {
      const copy = capabilityErrorToast(error, "Failed to disable pack");
      toast.error(copy.title, { description: copy.description });
    } finally {
      setBusyId(null);
    }
  }

  async function unregisterPack(pack: CapabilityPack) {
    setBusyId(`pack:${pack.id}`);
    try {
      const removed = await packs.remove(pack.id);
      if (removed) {
        toast.success(`Pack ${pack.id} unregistered`);
        await refresh();
      } else if (packs.mutationError) {
        const copy = capabilityErrorToast(packs.mutationError, "Failed to unregister pack");
        toast.error(copy.title, { description: copy.description });
        packs.clearMutationError();
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-4 py-5 sm:px-6 lg:px-8">
      <section className="flex min-h-0 flex-1 flex-col text-left">
        <PageHeader
          icon={<PlugIcon className="size-4" />}
          title="Capabilities"
          description="Enable runtime packs and MCPs, and track APIs, skills, and plugins for this workspace."
          actions={(
            <>
              <div className="relative min-w-56 flex-1 sm:flex-none">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search catalog" className="h-9 pl-8 text-sm" />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading} className="h-9">
                <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
                Refresh
              </Button>
            </>
          )}
        />

        <div className="mt-4 flex flex-wrap gap-2">
          {(["all", "pack", "mcp", "api", "skill", "plugin"] as CapabilityFilter[]).map((kind) => (
            <Button
              key={kind}
              type="button"
              variant={filter === kind ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setFilter(kind)}
              className="h-8 text-xs"
            >
              {capabilityKindIcon(kind)}
              {capabilityFilterLabel(kind)}
              <span className="ml-1 rounded-full border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">{counts[kind]}</span>
            </Button>
          ))}
        </div>

        <div className="mt-5 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="min-w-0 space-y-4">
            {showPacks ? (
              <PacksSection
                packs={packs}
                environments={environments.environments.map((environment) => ({ id: environment.id, name: environment.name }))}
                busyPackId={busyId?.startsWith("pack:") ? busyId.slice("pack:".length) : null}
                onRegister={registerPackManifest}
                onEnable={(pack, environmentId) => void enablePack(pack, environmentId)}
                onDisable={(pack) => void disablePack(pack)}
                onUnregister={(pack) => void unregisterPack(pack)}
              />
            ) : null}

            {filter === "pack" ? null : catalogView === "loading" ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-surface/45 p-4 text-sm text-fg-muted">
                <Loader2Icon className="size-4 animate-spin" />
                Loading capabilities
              </div>
            ) : catalogView === "error" ? (
              <LoadErrorState title="Couldn't load capabilities" error={loadError} onRetry={() => void refresh()} />
            ) : visibleItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-fg-muted">
                {catalogView === "empty" ? "No capabilities in this workspace yet." : "No capabilities match this filter."}
              </div>
            ) : (
              <div className="grid gap-2">
                {visibleItems.map((item) => (
                  <CapabilityRow
                    key={item.id}
                    item={item}
                    busy={busyId === item.id}
                    onToggle={() => void toggleCapability(item)}
                  />
                ))}
              </div>
            )}
          </div>

          <aside className="min-w-0 space-y-4 border-t border-border pt-4 xl:border-t-0 xl:border-l xl:pl-4 xl:pt-0">
            <section className="rounded-lg border border-border bg-surface/45 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GlobeIcon className="size-4 text-brand" />
                Public MCP Registry
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  value={registryQuery}
                  onChange={(event) => setRegistryQuery(event.target.value)}
                  placeholder="Search remote MCPs"
                  className="h-8 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void searchRegistry();
                  }}
                />
                <Button type="button" size="sm" disabled={registryBusy} onClick={() => void searchRegistry()} className="h-8 shrink-0 text-xs">
                  {registryBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SearchIcon className="size-3.5" />}
                  Search
                </Button>
              </div>
              <div className="mt-3 max-h-[28rem] space-y-2 overflow-auto pr-1">
                {registryResults.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-3 text-xs leading-5 text-fg-muted">
                    Search returns public remote MCP servers that expose streamable HTTP endpoints.
                  </div>
                ) : registryResults.map((item) => (
                  <div key={item.id} className="rounded-md border border-border bg-bg/35 p-2">
                    <div className="min-w-0 truncate text-xs font-medium">{item.name}</div>
                    {item.description ? <p className="mt-1 line-clamp-2 text-2xs text-fg-muted">{item.description}</p> : null}
                    <div className="mt-2 truncate font-mono text-2xs text-fg-subtle">{item.endpointUrl}</div>
                    <div className="mt-2 flex justify-end gap-1.5">
                      <Button type="button" variant="ghost" size="xs" disabled={busyId === item.id} onClick={() => void addRegistryItem(item, false)}>
                        <PlusIcon className="size-3" />
                        Add
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        disabled={busyId === item.id || !item.runtime.available}
                        title={!item.runtime.available ? item.runtime.notes ?? "This MCP is not available for runtime use yet." : undefined}
                        onClick={() => void addRegistryItem(item, true)}
                      >
                        {busyId === item.id ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
                        Enable
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-surface/45 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <PlusIcon className="size-4 text-brand" />
                Add Capability
              </div>
              <div className="mt-3 grid gap-2">
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                  <Select
                    className="h-8 text-xs"
                    value={addForm.kind}
                    onChange={(event) => setAddForm((current) => ({ ...current, kind: event.target.value as CapabilityFormState["kind"] }))}
                  >
                    <option value="mcp">MCP</option>
                    <option value="api">API</option>
                    <option value="skill">Skill</option>
                    <option value="plugin">Plugin</option>
                  </Select>
                  <Input value={addForm.name} onChange={(event) => setAddForm((current) => ({ ...current, name: event.target.value }))} placeholder="Name" className="h-8 text-xs" />
                </div>
                <Input value={addForm.endpointUrl} onChange={(event) => setAddForm((current) => ({ ...current, endpointUrl: event.target.value }))} placeholder="Endpoint URL" className="h-8 text-xs" />
                <Input value={addForm.homepageUrl} onChange={(event) => setAddForm((current) => ({ ...current, homepageUrl: event.target.value }))} placeholder="Homepage URL" className="h-8 text-xs" />
                <Input value={addForm.installUrl} onChange={(event) => setAddForm((current) => ({ ...current, installUrl: event.target.value }))} placeholder="Install URL" className="h-8 text-xs" />
                <Input value={addForm.category} onChange={(event) => setAddForm((current) => ({ ...current, category: event.target.value }))} placeholder="Category" className="h-8 text-xs" />
                <Input value={addForm.tags} onChange={(event) => setAddForm((current) => ({ ...current, tags: event.target.value }))} placeholder="Tags, comma separated" className="h-8 text-xs" />
                <textarea
                  value={addForm.description}
                  onChange={(event) => setAddForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Description"
                  className="min-h-16 rounded-md border border-border bg-bg px-3 py-2 text-xs"
                />
                <label className="flex items-center gap-2 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={addForm.enableAfterAdd}
                    onChange={(event) => setAddForm((current) => ({ ...current, enableAfterAdd: event.target.checked }))}
                  />
                  Enable or track after adding
                </label>
                <Button type="button" onClick={() => void submitManualCapability()} disabled={busyId === "new"} className="h-8">
                  {busyId === "new" ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlusIcon className="size-3.5" />}
                  Add capability
                </Button>
              </div>
            </section>
          </aside>
        </div>
      </section>
    </div>
  );
}

function CapabilityRow({ item, busy, onToggle }: {
  item: CapabilityCatalogItem;
  busy: boolean;
  onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const canToggle = item.enabled
    ? item.kind === "pack" || (item.source !== "built_in" && item.source !== "configured")
    : item.kind !== "mcp" || item.runtime.available;
  const toggleTitle = !canToggle && item.kind === "mcp"
    ? item.runtime.notes ?? "This MCP is not available for runtime use yet."
    : undefined;
  const packContents = summarizePackContents(item);
  return (
    <article className="grid min-w-0 gap-3 rounded-lg border border-border bg-surface/45 p-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-brand">
            {capabilityKindIcon(item.kind)}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-medium">{item.name}</h3>
              <CapabilityStatusPill enabled={item.enabled} source={item.source} reason={item.enabledReason} />
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap gap-1.5 text-2xs text-fg-subtle">
              <span>{item.kind}</span>
              <span>{item.source.replaceAll("_", " ")}</span>
              <span>{item.category}</span>
              {item.runtime.mcpServerId ? <span className="font-mono">{item.runtime.mcpServerId}</span> : null}
            </div>
          </div>
        </div>
        {item.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-fg-muted">{item.description}</p> : null}
        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
          {item.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="max-w-full truncate rounded border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">{tag}</span>
          ))}
          {item.endpointUrl ? <CapabilityLink href={item.endpointUrl} label="endpoint" /> : null}
          {item.homepageUrl ? <CapabilityLink href={item.homepageUrl} label="home" /> : null}
          {item.installUrl && item.installUrl !== item.homepageUrl ? <CapabilityLink href={item.installUrl} label="install" /> : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {packContents?.hasContents ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
            className="h-8 text-xs"
            aria-expanded={expanded}
          >
            <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
            Contents
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={item.enabled ? "secondary" : "default"}
          disabled={busy || !canToggle}
          onClick={onToggle}
          className="h-8 min-w-24 text-xs"
          title={toggleTitle}
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : item.enabled ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
          {capabilityToggleLabel(item, canToggle)}
        </Button>
      </div>
      {packContents && expanded ? <PackContentsPanel contents={packContents} /> : null}
    </article>
  );
}

function PackContentsPanel({ contents }: { contents: PackContentsSummary }) {
  return (
    <div className="grid gap-3 border-t border-border pt-3 lg:col-span-2 md:grid-cols-2">
      <PackContentsSection title="MCPs">
        {contents.mcpServerIds.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.mcpServerIds.map((id) => (
              <span key={id} className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle">{id}</span>
            ))}
          </div>
        ) : <PackEmptyText />}
        {contents.firstPartyMcpTools.length > 0 ? (
          <div className="mt-2 text-2xs text-fg-subtle">
            Tools: {contents.firstPartyMcpTools.join(", ")}
          </div>
        ) : null}
      </PackContentsSection>

      <PackContentsSection title="Skills">
        {contents.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.skills.map((skill) => (
              <span key={skill} className="rounded border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">{skill}</span>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Connectors">
        {contents.connectors.length > 0 ? (
          <div className="grid gap-2">
            {contents.connectors.map((connector) => (
              <div key={connector.id} className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{connector.name}</span>
                  {connector.required ? <span className="rounded border border-status-waiting/30 px-1.5 py-0.5 text-2xs text-status-waiting">required</span> : null}
                </div>
                <div className="mt-0.5 text-2xs text-fg-subtle">
                  {[connector.authModel, connector.providers.join(", "), connector.scopes.length ? `${connector.scopes.length} scopes` : null].filter(Boolean).join(" / ")}
                </div>
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Knowledge">
        {contents.knowledge.length > 0 ? (
          <div className="grid gap-2">
            {contents.knowledge.map((knowledge) => (
              <div key={knowledge.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{knowledge.name}</div>
                {knowledge.description ? <div className="mt-0.5 line-clamp-2 text-2xs text-fg-subtle">{knowledge.description}</div> : null}
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>

      <PackContentsSection title="Schedules">
        {contents.scheduledTaskTemplates.length > 0 ? (
          <div className="grid gap-2">
            {contents.scheduledTaskTemplates.map((template) => (
              <div key={template.id} className="min-w-0">
                <div className="truncate text-xs font-medium">{template.name}</div>
                <div className="mt-0.5 text-2xs text-fg-subtle">{template.scheduleSummary}</div>
              </div>
            ))}
          </div>
        ) : <PackEmptyText />}
      </PackContentsSection>
    </div>
  );
}

function PackContentsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 text-2xs font-semibold text-fg-subtle">{title}</div>
      {children}
    </section>
  );
}

function PackEmptyText() {
  return <div className="text-2xs text-fg-subtle">None declared.</div>;
}

function CapabilityStatusPill(props: { enabled: boolean; source: string; reason: string | null }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-0.5 text-2xs font-medium",
        props.enabled
          ? "border-status-idle/30 bg-status-idle/10 text-status-idle"
          : "border-border bg-bg text-fg-subtle",
      )}
    >
      {props.enabled ? props.reason ?? "enabled" : props.source === "manual" ? "added" : "available"}
    </span>
  );
}

function capabilityToggleLabel(item: CapabilityCatalogItem, canToggle: boolean): string {
  if (item.kind !== "pack" && item.kind !== "mcp") {
    if (!item.enabled) {
      return "Track";
    }
    return canToggle ? "Untrack" : "Tracked";
  }
  return item.enabled ? canToggle ? "Disable" : "Ready" : "Enable";
}

function CapabilityLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="max-w-full truncate rounded border border-border px-1.5 py-0.5 text-2xs text-brand hover:bg-surface-2">
      {label}
    </a>
  );
}

function capabilityKindIcon(kind: CapabilityFilter): ReactNode {
  const className = "size-3.5";
  if (kind === "pack") return <PackageIcon className={className} />;
  if (kind === "mcp") return <PlugIcon className={className} />;
  if (kind === "api") return <GlobeIcon className={className} />;
  if (kind === "skill") return <SparkleIcon className={className} />;
  if (kind === "plugin") return <WrenchIcon className={className} />;
  return <FilesIcon className={className} />;
}

// --- Packs subsection ----------------------------------------------------------------------
// Packs are the heaviest, workspace-runtime-altering capability (a sandbox
// image + skills + tools + connectors + knowledge + schedule templates that
// enable as one unit), so they get a first-class subsection at the top of the
// catalog with register/enable-with-environment/disable/unregister.

function PacksSection(props: {
  packs: ReturnType<typeof usePacks>;
  environments: Array<{ id: string; name: string }>;
  busyPackId: string | null;
  onRegister: (manifestDraft: string) => Promise<boolean>;
  onEnable: (pack: CapabilityPack, environmentId: string | undefined) => void;
  onDisable: (pack: CapabilityPack) => void;
  onUnregister: (pack: CapabilityPack) => void;
}) {
  const { packs } = props;
  const [registerOpen, setRegisterOpen] = useState(false);
  const [manifestDraft, setManifestDraft] = useState("");
  // Honest list state: a failed load renders as an error with retry, never as
  // the "No packs are available…" empty state.
  const packsView = listViewState({ loading: packs.loading, error: packs.error, count: packs.packs.length });

  async function register() {
    const registered = await props.onRegister(manifestDraft);
    if (registered) {
      setRegisterOpen(false);
      setManifestDraft("");
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface/45 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <PackageIcon className="size-4 text-brand" />
            Packs
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Complete agent capabilities: a sandbox image, skills, tools, connectors, knowledge, and schedule templates that enable as one unit.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={() => void packs.refresh()} disabled={packs.loading} className="h-8 text-xs">
            <RefreshCwIcon className={cn("size-3.5", packs.loading && "animate-spin")} />
            Refresh
          </Button>
          <Button type="button" size="sm" onClick={() => setRegisterOpen((open) => !open)} className="h-8 text-xs">
            <PlusIcon className="size-3.5" />
            Register manifest
          </Button>
        </div>
      </div>

      {registerOpen ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-border bg-bg/35 p-3">
          <textarea
            value={manifestDraft}
            onChange={(event) => setManifestDraft(event.target.value)}
            placeholder='{"id": "my-pack", "name": "My pack", "description": "...", "role": "...", "category": "...", "version": "1.0.0", ...}'
            className="min-h-40 rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs leading-5"
            aria-label="Pack manifest JSON"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setRegisterOpen(false)}>Cancel</Button>
            <Button type="button" size="sm" disabled={packs.mutating || !manifestDraft.trim()} onClick={() => void register()}>
              {packs.mutating ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
              Register
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3">
        {packsView === "loading" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/35 p-4 text-sm text-fg-muted">
            <Loader2Icon className="size-4 animate-spin" />
            Loading packs
          </div>
        ) : packsView === "error" ? (
          <LoadErrorState title="Couldn't load packs" error={packs.error} onRetry={() => void packs.refresh()} />
        ) : packsView === "empty" ? (
          <EmptyState>No packs are available to this workspace.</EmptyState>
        ) : (
          packs.packs.map((pack) => (
            <PackCard
              key={pack.id}
              pack={pack}
              installation={packs.installationFor(pack.id)}
              environments={props.environments}
              busy={props.busyPackId === pack.id}
              onEnable={(environmentId) => props.onEnable(pack, environmentId)}
              onDisable={() => props.onDisable(pack)}
              onUnregister={() => props.onUnregister(pack)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PackCard(props: {
  pack: CapabilityPack;
  installation: PackInstallation | null;
  environments: Array<{ id: string; name: string }>;
  busy: boolean;
  onEnable: (environmentId: string | undefined) => void;
  onDisable: () => void;
  onUnregister: () => void;
}) {
  const { pack, installation } = props;
  const enabled = installation?.status === "active";
  const [expanded, setExpanded] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const needsEnvironment = pack.environment?.required === true;

  return (
    <article className="rounded-lg border border-border bg-bg/35 p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium">{pack.name}</h3>
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle">v{pack.version}</span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5 text-2xs font-medium",
                enabled
                  ? "border-status-idle/30 bg-status-idle/10 text-status-idle"
                  : "border-border bg-bg text-fg-subtle",
              )}
            >
              {enabled ? "enabled" : installation ? "disabled" : "available"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{pack.description}</p>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
            <span>{pack.role}</span>
            <span>{pack.category}</span>
            {pack.sandboxImage ? (
              <span className="flex min-w-0 items-center gap-1" title={pack.sandboxImage}>
                <ContainerIcon className="size-3 shrink-0" />
                <span className="max-w-72 truncate font-mono text-2xs">{pack.sandboxImage}</span>
              </span>
            ) : null}
          </div>
          {pack.skills.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pack.skills.map((skill) => (
                <span key={skill.name} title={skill.description} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-2xs text-fg-subtle">
                  <SparkleIcon className="size-3" />
                  {skill.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
              <ChevronDownIcon className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
              Contents
            </Button>
            {enabled ? (
              <Button type="button" variant="secondary" size="sm" className="h-8 min-w-24 text-xs" disabled={props.busy} onClick={props.onDisable}>
                {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
                Disable
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-8 min-w-24 text-xs"
                disabled={props.busy || (needsEnvironment && !environmentId)}
                title={needsEnvironment && !environmentId ? "This pack requires an environment attachment" : undefined}
                onClick={() => props.onEnable(environmentId || undefined)}
              >
                {props.busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
                Enable
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Unregister pack ${pack.id}`}
              className="hover:text-status-failed"
              disabled={props.busy}
              title="Unregister this workspace pack (built-ins cannot be removed)"
              onClick={props.onUnregister}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
          {pack.environment ? (
            <div className="flex items-center gap-1.5">
              <Select
                value={environmentId}
                onChange={(event) => setEnvironmentId(event.target.value)}
                aria-label={`Environment for ${pack.name}`}
                className="h-8 text-xs"
              >
                <option value="">{needsEnvironment ? "Choose environment (required)" : "No environment"}</option>
                {props.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{environment.name}</option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-2">
          <PackSection title="Tools" icon={<PlugIcon className="size-3" />}>
            {pack.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {pack.tools.map((tool) => (
                  <span key={`${tool.kind}:${tool.id}`} className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle">{tool.id}</span>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Skills" icon={<FileCode2Icon className="size-3" />}>
            {pack.skills.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.skills.map((skill) => (
                  <div key={skill.name} className="min-w-0">
                    <div className="truncate text-xs font-medium">{skill.name}</div>
                    <div className="text-2xs text-fg-subtle">
                      {skill.description ?? "No description"} · {skill.files.length} file{skill.files.length === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Connectors" icon={<PlugIcon className="size-3" />}>
            {pack.connectors.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.connectors.map((connector) => (
                  <div key={connector.id} className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{connector.name}</span>
                      {connector.required ? <span className="rounded border border-status-waiting/30 px-1.5 py-0.5 text-2xs text-status-waiting">required</span> : null}
                    </div>
                    <div className="text-2xs text-fg-subtle">
                      {[connector.authModel, connector.providers.join(", "), connector.scopes.length ? `${connector.scopes.length} scopes` : null].filter(Boolean).join(" / ")}
                    </div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Knowledge" icon={<FileCode2Icon className="size-3" />}>
            {pack.knowledge.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.knowledge.map((knowledge) => (
                  <div key={knowledge.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{knowledge.name}</div>
                    {knowledge.description ? <div className="line-clamp-2 text-2xs text-fg-subtle">{knowledge.description}</div> : null}
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          <PackSection title="Schedule templates" icon={<CalendarClockIcon className="size-3" />}>
            {pack.scheduledTaskTemplates.length > 0 ? (
              <div className="grid gap-1.5">
                {pack.scheduledTaskTemplates.map((template) => (
                  <div key={template.id} className="min-w-0">
                    <div className="truncate text-xs font-medium">{template.name}</div>
                    <div className="text-2xs text-fg-subtle">{scheduleLabel(template.defaultSchedule)}</div>
                  </div>
                ))}
              </div>
            ) : <PackNone />}
          </PackSection>

          {pack.environment ? (
            <PackSection title="Environment" icon={<ContainerIcon className="size-3" />}>
              <div className="text-2xs text-fg-subtle">{pack.environment.description}</div>
              {pack.environment.requiredVariables.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {pack.environment.requiredVariables.map((name) => (
                    <span key={name} className="rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-fg-subtle">{name}</span>
                  ))}
                </div>
              ) : null}
            </PackSection>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function PackSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold text-fg-subtle">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function PackNone() {
  return <div className="text-2xs text-fg-subtle">None declared.</div>;
}
