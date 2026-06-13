// Capabilities: the workspace catalog (packs, MCPs, APIs, skills, plugins)
// plus the public MCP registry search and manual capability tracking.
import {
  CheckIcon,
  ChevronDownIcon,
  FilesIcon,
  GlobeIcon,
  Loader2Icon,
  PackageIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SparkleIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import type { CapabilityCatalogItem } from "@/types";

export function CapabilitiesRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const client = context.client;
  const onRuntimeChanged = () => void context.refreshWorkspaceMcpServers(workspaceId);
  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [query, setQuery] = useState("");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryBusy, setRegistryBusy] = useState(false);
  const [registryResults, setRegistryResults] = useState<CapabilityCatalogItem[]>([]);
  const [addForm, setAddForm] = useState<CapabilityFormState>(() => emptyCapabilityForm());
  const visibleItems = useMemo(() => filterCapabilityCatalogItems(items, filter, query), [items, filter, query]);
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
                <SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-[color:var(--color-fg-subtle)]" />
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
              <span className="ml-1 rounded-full border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{counts[kind]}</span>
            </Button>
          ))}
        </div>

        <div className="mt-5 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="min-w-0">
            {catalogView === "loading" ? (
              <div className="flex items-center gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-4 text-sm text-[color:var(--color-fg-muted)]">
                <Loader2Icon className="size-4 animate-spin" />
                Loading capabilities
              </div>
            ) : catalogView === "error" ? (
              <LoadErrorState title="Couldn't load capabilities" error={loadError} onRetry={() => void refresh()} />
            ) : visibleItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-6 text-center text-sm text-[color:var(--color-fg-muted)]">
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

          <aside className="min-w-0 space-y-4 border-t border-[color:var(--color-border)] pt-4 xl:border-t-0 xl:border-l xl:pl-4 xl:pt-0">
            <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <GlobeIcon className="size-4 text-[color:var(--color-brand)]" />
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
                  <div className="rounded-md border border-dashed border-[color:var(--color-border)] p-3 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                    Search returns public remote MCP servers that expose streamable HTTP endpoints.
                  </div>
                ) : registryResults.map((item) => (
                  <div key={item.id} className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]/35 p-2">
                    <div className="min-w-0 truncate text-xs font-medium">{item.name}</div>
                    {item.description ? <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[color:var(--color-fg-muted)]">{item.description}</p> : null}
                    <div className="mt-2 truncate font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{item.endpointUrl}</div>
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

            <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <PlusIcon className="size-4 text-[color:var(--color-brand)]" />
                Add Capability
              </div>
              <div className="mt-3 grid gap-2">
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                  <select
                    className="h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs"
                    value={addForm.kind}
                    onChange={(event) => setAddForm((current) => ({ ...current, kind: event.target.value as CapabilityFormState["kind"] }))}
                  >
                    <option value="mcp">MCP</option>
                    <option value="api">API</option>
                    <option value="skill">Skill</option>
                    <option value="plugin">Plugin</option>
                  </select>
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
                  className="min-h-16 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-xs"
                />
                <label className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
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
    <article className="grid min-w-0 gap-3 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-brand)]">
            {capabilityKindIcon(item.kind)}
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-medium">{item.name}</h3>
              <CapabilityStatusPill enabled={item.enabled} source={item.source} reason={item.enabledReason} />
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap gap-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
              <span>{item.kind}</span>
              <span>{item.source.replaceAll("_", " ")}</span>
              <span>{item.category}</span>
              {item.runtime.mcpServerId ? <span className="font-mono">{item.runtime.mcpServerId}</span> : null}
            </div>
          </div>
        </div>
        {item.description ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[color:var(--color-fg-muted)]">{item.description}</p> : null}
        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
          {item.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{tag}</span>
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
    <div className="grid gap-3 border-t border-[color:var(--color-border)] pt-3 lg:col-span-2 md:grid-cols-2">
      <PackContentsSection title="MCPs">
        {contents.mcpServerIds.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.mcpServerIds.map((id) => (
              <span key={id} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">{id}</span>
            ))}
          </div>
        ) : <PackEmptyText />}
        {contents.firstPartyMcpTools.length > 0 ? (
          <div className="mt-2 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
            Tools: {contents.firstPartyMcpTools.join(", ")}
          </div>
        ) : null}
      </PackContentsSection>

      <PackContentsSection title="Skills">
        {contents.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {contents.skills.map((skill) => (
              <span key={skill} className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-subtle)]">{skill}</span>
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
                  {connector.required ? <span className="rounded border border-amber-500/30 px-1.5 py-0.5 text-[10px] text-amber-300">required</span> : null}
                </div>
                <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">
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
                {knowledge.description ? <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{knowledge.description}</div> : null}
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
                <div className="mt-0.5 text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">{template.scheduleSummary}</div>
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
      <div className="mb-1.5 text-[11px] font-semibold text-[color:var(--color-fg-subtle)]">{title}</div>
      {children}
    </section>
  );
}

function PackEmptyText() {
  return <div className="text-[11px] leading-4 text-[color:var(--color-fg-subtle)]">None declared.</div>;
}

function CapabilityStatusPill(props: { enabled: boolean; source: string; reason: string | null }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        props.enabled
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[color:var(--color-fg-subtle)]",
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
    <a href={href} target="_blank" rel="noreferrer noopener" className="max-w-full truncate rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-brand)] hover:bg-[color:var(--color-surface-2)]">
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
