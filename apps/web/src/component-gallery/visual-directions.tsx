import { useId, useState, type ReactNode } from "react";
import {
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  LayoutGridIcon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  Volume2Icon,
  ArrowDownAZIcon,
  ListFilterIcon,
  PlugIcon,
} from "lucide-react";
import { CapabilityCatalogRow } from "../../../../packages/react/src/capability-catalog-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSwitch } from "@/components/ui/settings-patterns";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { RowItem } from "./candidates";
import { catalogLogos } from "./catalog-logos";

export const visualConnections = [
  {
    id: "linear",
    name: "Linear",
    detail: "Issues, projects and roadmaps",
    status: "Connected",
    logo: catalogLogos.linear,
    category: "Development",
  },
  {
    id: "slack",
    name: "Slack",
    detail: "Messages and team conversations",
    status: "Connected",
    logo: catalogLogos.slack,
    category: "Communication",
  },
  {
    id: "notion",
    name: "Notion",
    detail: "Documents, notes and knowledge",
    status: "Not connected",
    logo: catalogLogos.notion,
    category: "Knowledge",
  },
];
export type VisualConnection = (typeof visualConnections)[number];
export function ConnectorMark({
  item,
  large = false,
}: {
  item: VisualConnection;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2",
        large ? "size-14" : "size-10",
      )}
      aria-hidden="true"
    >
      <img src={item.logo} alt="" className="size-full object-contain" />
    </span>
  );
}
/** Same real catalog component as Capabilities; only the gallery composition varies. */
export function ConnectorCollection({
  variant,
  items,
  onOpen,
}: {
  variant: "simple" | "metadata" | "table";
  items: VisualConnection[];
  onOpen: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState("linear");
  const active = items.find((item) => item.id === activeId) ?? items[0];
  if (!active)
    return (
      <EmptyState
        title="No matching connections"
        description="Try another search or change the filter."
      />
    );
  const catalogItem = (item: VisualConnection, card = false) => (
    <CapabilityCatalogRow
      key={item.id}
      name={item.name}
      description={item.detail}
      icon={<ConnectorMark item={item} />}
      status={item.status === "Connected" ? "added" : "available"}
      statusLabel={
        item.status === "Connected"
          ? "Connected — open details"
          : "Add connection — open setup preview"
      }
      onOpen={() => onOpen(item.id)}
      className={card ? "connector-tile" : "connector-quiet-row"}
    />
  );
  if (variant === "simple")
    return (
      <div className="connector-tile-grid">{items.map((item) => catalogItem(item, true))}</div>
    );
  if (variant === "metadata")
    return (
      <div className="connector-quiet-list">
        <div className="mb-2 flex items-center justify-between px-3">
          <span className="text-2xs font-medium uppercase tracking-wider text-fg-muted">
            Your tools
          </span>
          <span className="text-xs text-fg-muted">{items.length}</span>
        </div>
        {items.map((item) => catalogItem(item))}
      </div>
    );
  return (
    <div className="connector-browser">
      <nav aria-label="Choose a connection" className="connector-browser-rail">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-label={item.name}
            aria-current={item.id === active.id ? "true" : undefined}
            onClick={() => setActiveId(item.id)}
            className={cn("connector-browser-link", item.id === active.id && "is-active")}
          >
            <ConnectorMark item={item} />
            <span className="text-xs">{item.name}</span>
            {item.status === "Connected" ? (
              <CheckIcon aria-label="Connected" className="size-3 text-brand" />
            ) : (
              <PlusIcon aria-label="Available to add" className="size-3 text-fg-muted" />
            )}
          </button>
        ))}
      </nav>
      <div className="connector-browser-detail">
        <ConnectorMark item={active} large />
        <p className="mt-5 text-lg font-semibold tracking-tight">{active.name}</p>
        <p className="mt-1 text-2xs uppercase tracking-wider text-fg-muted">{active.category}</p>
        <p className="mt-4 text-sm leading-6 text-fg-muted">{active.detail}</p>
        <Button variant="outline" className="mt-6 w-full" onClick={() => onOpen(active.id)}>
          {active.status === "Connected" ? <CheckIcon /> : <PlusIcon />}
          {active.status === "Connected" ? "Manage" : "Add connection"}
        </Button>
      </div>
    </div>
  );
}

const preferenceIcons = { voice: MicIcon, notifications: BellIcon, sound: Volume2Icon };
export function PreferenceDirections({
  variant,
  items,
  onChange,
  disabled,
}: {
  variant: "compact" | "comfortable" | "grouped";
  items: RowItem[];
  onChange: (id: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [activeId, setActiveId] = useState("voice");
  const active = items.find((item) => item.id === activeId) ?? items[0]!;
  if (variant === "compact")
    return (
      <div className="preference-tile-grid">
        {items.map((item) => {
          const Icon = preferenceIcons[item.id as keyof typeof preferenceIcons] ?? BellIcon;
          return (
            <button
              type="button"
              key={item.id}
              role="switch"
              aria-label={item.title}
              aria-checked={item.checked}
              aria-describedby={`${id}-${item.id}`}
              disabled={disabled}
              onClick={() => onChange(item.id, !item.checked)}
              className={cn("preference-tile", item.checked && "is-active")}
            >
              <span className="flex items-center justify-between">
                <Icon aria-hidden="true" className="size-5 text-fg-muted" />
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full",
                    item.checked ? "bg-brand text-bg" : "border border-border-strong text-fg-muted",
                  )}
                >
                  {item.checked ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                </span>
              </span>
              <span className="mt-5 block text-sm font-medium">{item.title}</span>
              <span id={`${id}-${item.id}`} className="mt-2 block text-xs leading-5 text-fg-muted">
                {item.description}
              </span>
            </button>
          );
        })}
      </div>
    );
  const form = (item: RowItem) => (
    <div key={item.id} className="flex items-center gap-4 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p id={`${id}-${item.id}`} className="mt-1 text-xs leading-5 text-fg-muted">
          {item.description}
        </p>
      </div>
      <SettingsSwitch
        aria-label={item.title}
        aria-describedby={`${id}-${item.id}`}
        checked={item.checked}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(item.id, checked)}
      />
    </div>
  );
  if (variant === "comfortable")
    return (
      <div className="rounded-2xl bg-surface-2/30 px-5">
        <p className="pt-5 text-xs text-fg-muted">Conversation preferences</p>
        <div className="divide-y divide-border/60">{items.map(form)}</div>
      </div>
    );
  const ActiveIcon = preferenceIcons[active.id as keyof typeof preferenceIcons] ?? BellIcon;
  return (
    <div className="preference-editor">
      <nav aria-label="Choose a preference" className="preference-editor-menu">
        {items.map((item) => {
          const Icon = preferenceIcons[item.id as keyof typeof preferenceIcons] ?? BellIcon;
          return (
            <button
              type="button"
              key={item.id}
              aria-current={item.id === active.id ? "true" : undefined}
              onClick={() => setActiveId(item.id)}
              className={cn("preference-editor-link", item.id === active.id && "is-active")}
            >
              <Icon className="size-4" />
              <span className="flex-1 text-left text-xs">{item.title}</span>
              <ChevronRightIcon className="size-3" />
            </button>
          );
        })}
      </nav>
      <div className="p-5">
        <ActiveIcon className="mb-4 size-7 text-brand" />
        <p className="text-xs text-fg-muted">{active.group}</p>
        {form(active)}
        <p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-fg-muted">
          Select a preference to focus on its controls. The values are shared across all three
          examples.
        </p>
      </div>
    </div>
  );
}

export function NavigationDirections({
  variant,
  value,
  onChange,
  children,
}: {
  variant: "line" | "segmented";
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={onChange}
      orientation={variant === "segmented" ? "vertical" : "horizontal"}
      className={variant === "segmented" ? "visual-vertical-tabs" : "visual-pill-tabs"}
    >
      <TabsList aria-label="Connection views" variant="line" className="visual-tab-list">
        {[
          { id: "all", label: "All tools", icon: LayoutGridIcon },
          { id: "connected", label: "My tools", icon: PlugIcon },
        ].map((item) => (
          <TabsTrigger key={item.id} value={item.id} className="visual-tab-trigger">
            <item.icon className="size-4" />
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value} className="min-w-0 pt-3">
        {children}
      </TabsContent>
    </Tabs>
  );
}
export function SearchDirections({
  variant,
  query,
  onQuery,
  view,
  onView,
  status,
  onStatus,
  children,
}: {
  variant: "above" | "below";
  query: string;
  onQuery: (value: string) => void;
  view: string;
  onView: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  children: ReactNode;
}) {
  const search = (
    <div className={cn("relative", variant === "above" && "catalog-search-hero")}>
      <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-fg-muted" />
      <Input
        aria-label="Search connections"
        type="search"
        placeholder="Find your next connection…"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        className={cn(
          "pl-12",
          variant === "above"
            ? "h-14 rounded-2xl border-transparent bg-surface-2/60"
            : "h-10 rounded-full bg-bg",
        )}
      />
    </div>
  );
  const filters = (
    <div className="flex flex-wrap gap-2">
      {[
        { id: "all", label: "All" },
        { id: "Connected", label: "Added" },
        { id: "Not connected", label: "Available" },
      ].map((item) => (
        <button
          type="button"
          key={item.id}
          aria-pressed={status === item.id}
          onClick={() => onStatus(item.id)}
          className={cn(
            "rounded-full px-3 py-2 text-xs focus-visible:ring-2 focus-visible:ring-brand",
            status === item.id ? "bg-fg text-bg" : "bg-surface-2/50 text-fg-muted hover:text-fg",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
  if (variant === "above")
    return (
      <div>
        <p className="mb-3 text-lg font-semibold tracking-tight">What will you connect?</p>
        {search}
        <div className="my-5">{filters}</div>
        {children}
      </div>
    );
  return (
    <div className="search-workbench">
      <div className="search-workbench-toolbar">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium"
          aria-pressed={view === "connected"}
          onClick={() => onView(view === "all" ? "connected" : "all")}
        >
          <LayoutGridIcon className="size-4" />
          {view === "all" ? "All tools" : "My tools"}
          <ChevronRightIcon className="size-3" />
        </button>
        {search}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ListFilterIcon aria-hidden="true" className="size-4 text-fg-muted" />
        {filters}
      </div>
      {children}
    </div>
  );
}
export function ChoiceTiles({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-4 text-sm font-medium">Sort connections</legend>
      <div className="choice-tiles">
        {[
          { id: "recent", title: "Recent", description: "Last used first", icon: ClockIcon },
          { id: "name", title: "A–Z", description: "Alphabetical order", icon: ArrowDownAZIcon },
          { id: "status", title: "Availability", description: "Group by status", icon: PlugIcon },
        ].map((item) => (
          <label key={item.id} className={cn("choice-tile", value === item.id && "is-active")}>
            <input
              type="radio"
              name={name}
              value={item.id}
              checked={value === item.id}
              onChange={() => onChange(item.id)}
              className="sr-only"
            />
            <item.icon aria-hidden="true" className="mb-4 size-6" />
            <span className="block text-sm font-medium">{item.title}</span>
            <span className="mt-1 block text-xs text-fg-muted">{item.description}</span>
            {value === item.id && (
              <CheckIcon
                aria-hidden="true"
                className="absolute right-3 top-3 size-3.5 text-brand"
              />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function ConnectionSelection({
  variant,
  selected,
  onChange,
}: {
  variant: "visible" | "disclosed";
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const available = visualConnections.filter((item) =>
    item.name.toLowerCase().includes(query.toLowerCase()),
  );
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  if (variant === "visible")
    return (
      <fieldset>
        <legend className="mb-4 text-sm font-medium">Include connections</legend>
        <div className="connector-tile-grid">
          {visualConnections.map((item) => (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected.includes(item.id)}
              aria-label={item.name}
              key={item.id}
              onClick={() => toggle(item.id)}
              className={cn("selection-connector-tile", selected.includes(item.id) && "is-active")}
            >
              <ConnectorMark item={item} />
              <span className="mt-4 block text-sm font-medium">{item.name}</span>
              <span className="absolute right-3 top-3 text-brand">
                {selected.includes(item.id) ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <PlusIcon className="size-4 text-fg-muted" />
                )}
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    );
  return (
    <div>
      <p className="mb-3 text-sm font-medium">Include connections</p>
      <div className="mb-4 flex min-h-12 flex-wrap gap-2 rounded-2xl bg-surface-2/30 p-3">
        {selected.length ? (
          visualConnections
            .filter((item) => selected.includes(item.id))
            .map((item) => (
              <Button
                key={item.id}
                size="sm"
                variant="secondary"
                aria-label={`Remove ${item.name}`}
                onClick={() => toggle(item.id)}
              >
                <img src={item.logo} alt="" className="size-4 rounded" />
                {item.name}
                <span aria-hidden="true">×</span>
              </Button>
            ))
        ) : (
          <span className="text-xs text-fg-muted">Choose tools from the results below.</span>
        )}
      </div>
      <Input
        type="search"
        aria-label="Find connections to include"
        placeholder="Add a connection…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {available.map((item) => (
        <button
          type="button"
          key={item.id}
          role="checkbox"
          aria-checked={selected.includes(item.id)}
          aria-label={item.name}
          onClick={() => toggle(item.id)}
          className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-surface-2"
        >
          <ConnectorMark item={item} />
          <span className="flex-1 text-sm">{item.name}</span>
          {selected.includes(item.id) ? (
            <CheckIcon className="size-4 text-brand" />
          ) : (
            <PlusIcon className="size-4 text-fg-muted" />
          )}
        </button>
      ))}
      {!available.length && <p className="py-4 text-xs text-fg-muted">No matching connections.</p>}
    </div>
  );
}
