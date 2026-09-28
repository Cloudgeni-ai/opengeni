import { useMemo, useState, type ReactNode } from "react";
import {
  BookOpenIcon,
  BrainCircuitIcon,
  ChevronLeftIcon,
  ListTreeIcon,
  PlugIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  LineTabs,
  LineTabsContent,
  LineTabsLink,
  LineTabsList,
  LineTabsNav,
  LineTabsTrigger,
  type LineTabsVariant,
} from "@/components/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList, type RowIndicatorKind } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Toolbar,
  ToolbarFilterChips,
  ToolbarFilterMenu,
  ToolbarGroup,
  ToolbarSearch,
  ToolbarSummary,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "@/components/ui/toolbar";

import {
  connectedCapabilities,
  knowledgeEntries,
  peopleCounts,
  popularCapabilities,
  reviewItems,
  sandboxEnvironments,
  skillCapabilities,
  type Capability,
} from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";

/* ----------------------------------------------------------------------------
   The Capabilities catalog on identical content, three ways.
   -------------------------------------------------------------------------- */

type CatalogTab = "all" | "connection" | "skill" | "plugin";

const CATALOG: Capability[] = [
  ...connectedCapabilities,
  ...popularCapabilities.slice(0, 4),
  ...skillCapabilities,
];

const TABS: Array<{ value: CatalogTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "connection", label: "Connections" },
  { value: "skill", label: "Skills" },
  { value: "plugin", label: "Plugins" },
];

const LOGOS: Record<string, string> = {
  github: "/capability-logos/github.svg",
  gmail: "/capability-logos/gmail.ico",
};

const STATUS_LABEL: Partial<Record<Capability["status"], string>> = {
  connected: "Connected",
  installed: "Installed",
  needs_reconnect: "Needs reconnect",
  unavailable: "Unavailable",
};

function countOf(tab: CatalogTab): number {
  return tab === "all" ? CATALOG.length : CATALOG.filter((item) => item.kind === tab).length;
}

function matches(item: Capability, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle);
}

function indicatorFor(
  item: Capability,
): RowIndicatorKind | { kind: RowIndicatorKind; label?: string } {
  switch (item.status) {
    case "connected":
    case "installed":
      return { kind: "added", label: STATUS_LABEL[item.status] };
    case "needs_reconnect":
      return { kind: "attention", label: "Needs reconnect" };
    case "unavailable":
      return { kind: "unavailable", label: "Unavailable" };
    default:
      return { kind: "add", label: `Add ${item.name}` };
  }
}

function CapabilityTile({ item }: { item: Capability }) {
  if (item.kind === "skill") {
    return <LogoTile name={item.name} icon={<BookOpenIcon />} />;
  }
  const src = item.logoKey ? LOGOS[item.logoKey] : undefined;
  return <LogoTile name={item.name} monogram={item.monogram} src={src} fit="contain" />;
}

function CatalogRows({ items, label }: { items: Capability[]; label: string }) {
  return (
    <RowList variant="catalog" label={label}>
      {items.map((item) => (
        <ListRow
          key={item.id}
          leading={<CapabilityTile item={item} />}
          title={item.name}
          description={item.description}
          indicator={indicatorFor(item)}
          onOpen={() => undefined}
        />
      ))}
    </RowList>
  );
}

function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <p className="py-6 text-sm text-fg-muted">
      Nothing matches "{query}".{" "}
      <button
        type="button"
        onClick={onClear}
        className="rounded-sm font-medium text-brand transition-colors hover:text-fg"
      >
        Clear search
      </button>
    </p>
  );
}

function EmptyPlugins() {
  return (
    <p className="py-6 text-sm text-fg-muted">
      No plugins in this workspace yet. A plugin bundles skills and connections for one product.
    </p>
  );
}

function AddButton({ size = "sm" }: { size?: "sm" | "default" }) {
  return (
    <Button size={size}>
      <PlusIcon aria-hidden="true" />
      Add
    </Button>
  );
}

function CatalogHeader() {
  return (
    <PageHeader
      icon={<PlugIcon />}
      title="Capabilities"
      description="Tools, skills, and plugins your agents can use."
    />
  );
}

/** A and B: search on its own line, then the tab row with Add on its rule. */
function TabbedCatalog({ variant, limit }: { variant: LineTabsVariant; limit?: number }) {
  const [tab, setTab] = useState<CatalogTab>("all");
  const [query, setQuery] = useState("");
  const pills = variant === "pill";

  return (
    <div className="min-w-0">
      <CatalogHeader />
      <div className="mt-6">
        <ToolbarSearch
          size="lg"
          value={query}
          onValueChange={setQuery}
          placeholder="Search connections, skills, and plugins"
        />
      </div>
      <LineTabs value={tab} onValueChange={(value) => setTab(value as CatalogTab)} className="mt-4">
        <LineTabsList variant={variant} aria-label="Capability types" trailing={<AddButton />}>
          {TABS.map((item) => (
            <LineTabsTrigger
              key={item.value}
              value={item.value}
              count={pills ? countOf(item.value) : undefined}
            >
              {item.label}
            </LineTabsTrigger>
          ))}
        </LineTabsList>
        {TABS.map((item) => {
          const items = CATALOG.filter(
            (entry) => (item.value === "all" || entry.kind === item.value) && matches(entry, query),
          ).slice(0, limit);
          return (
            <LineTabsContent key={item.value} value={item.value} className="mt-6">
              {items.length > 0 ? (
                <CatalogRows items={items} label={item.label} />
              ) : query ? (
                <NoResults query={query} onClear={() => setQuery("")} />
              ) : (
                <EmptyPlugins />
              )}
            </LineTabsContent>
          );
        })}
      </LineTabs>
    </div>
  );
}

const FILTER_GROUPS: ToolbarFilterGroup[] = [
  {
    id: "type",
    label: "Type",
    options: [
      { id: "connection", label: "Connections", count: countOf("connection") },
      { id: "skill", label: "Skills", count: countOf("skill") },
      { id: "plugin", label: "Plugins", count: countOf("plugin") },
    ],
  },
  {
    id: "status",
    label: "Status",
    options: [
      { id: "added", label: "Connected or installed" },
      { id: "needs_reconnect", label: "Needs reconnect" },
      { id: "available", label: "Available to add" },
    ],
  },
];

function statusGroup(item: Capability): string {
  if (item.status === "connected" || item.status === "installed") return "added";
  if (item.status === "needs_reconnect") return "needs_reconnect";
  return "available";
}

/** C: no tabs. Search, one Filter menu and Add keep one row; chips show what's applied. */
const NO_FILTERS: ToolbarFilterValue = {};

function FilteredCatalog({ initial = NO_FILTERS }: { initial?: ToolbarFilterValue }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ToolbarFilterValue>(initial);
  const items = useMemo(() => {
    const types = filters.type ?? [];
    const statuses = filters.status ?? [];
    return CATALOG.filter(
      (item) =>
        (types.length === 0 || types.includes(item.kind)) &&
        (statuses.length === 0 || statuses.includes(statusGroup(item))) &&
        matches(item, query),
    );
  }, [filters, query]);
  const filtered = items.length !== CATALOG.length;

  return (
    <div className="min-w-0">
      <CatalogHeader />
      <Toolbar className="mt-6">
        <ToolbarSearch
          value={query}
          onValueChange={setQuery}
          placeholder="Search connections, skills, and plugins"
        />
        <ToolbarGroup align="end">
          <ToolbarFilterMenu groups={FILTER_GROUPS} value={filters} onValueChange={setFilters} />
          <AddButton size="default" />
        </ToolbarGroup>
      </Toolbar>
      <div className="mt-3 flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <ToolbarFilterChips groups={FILTER_GROUPS} value={filters} onValueChange={setFilters} />
        <ToolbarSummary>
          {filtered ? `${items.length} of ${CATALOG.length}` : `${CATALOG.length} capabilities`}
        </ToolbarSummary>
      </div>
      <div className="mt-4">
        {items.length > 0 ? (
          <CatalogRows items={items} label="Capabilities" />
        ) : query ? (
          <NoResults query={query} onClear={() => setQuery("")} />
        ) : (
          <EmptyPlugins />
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   States for the recommended version A.
   -------------------------------------------------------------------------- */

const SCOPE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "workspace", label: "Workspace" },
  { value: "personal", label: "Only me" },
  { value: "organization", label: "Organization" },
] as const;

type Scope = (typeof SCOPE_OPTIONS)[number]["value"];

const KNOWLEDGE_FILTERS: ToolbarFilterGroup[] = [
  {
    id: "type",
    label: "Type",
    options: [
      { id: "decision", label: "Decision" },
      { id: "requirement", label: "Requirement" },
      { id: "incident", label: "Incident" },
      { id: "fact", label: "Fact" },
      { id: "note", label: "Note" },
    ],
  },
  {
    id: "source",
    label: "Source",
    options: [
      { id: "chat", label: "Chats" },
      { id: "file", label: "Files" },
    ],
  },
];

function KnowledgeTabs({
  value,
  children,
  trailing,
}: {
  value: string;
  children?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <LineTabs defaultValue={value}>
      <LineTabsList aria-label="Knowledge" trailing={trailing}>
        <LineTabsTrigger value="library">Library</LineTabsTrigger>
        <LineTabsTrigger value="instructions">Instructions</LineTabsTrigger>
        <LineTabsTrigger
          value="review"
          count={reviewItems.length}
          countTone="attention"
          countLabel={`${reviewItems.length} waiting for review`}
        >
          Review
        </LineTabsTrigger>
      </LineTabsList>
      {children}
    </LineTabs>
  );
}

function KnowledgeToolbar({ loading = false }: { loading?: boolean }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [filters, setFilters] = useState<ToolbarFilterValue>({});
  return (
    <Toolbar>
      <ToolbarSearch
        value={query}
        onValueChange={setQuery}
        placeholder="Search knowledge"
        disabled={loading}
      />
      <ToolbarGroup>
        <SegmentedControl
          aria-label="Scope"
          options={SCOPE_OPTIONS}
          value={scope}
          onValueChange={setScope}
          disabled={loading}
        />
      </ToolbarGroup>
      <ToolbarGroup align="end">
        <ToolbarFilterMenu
          groups={KNOWLEDGE_FILTERS}
          value={filters}
          onValueChange={setFilters}
          disabled={loading}
        />
        <Button variant="ghost" size="icon" aria-label="Show as a tree" disabled={loading}>
          <ListTreeIcon aria-hidden="true" />
        </Button>
      </ToolbarGroup>
    </Toolbar>
  );
}

const KNOWLEDGE_LINKS = [
  { id: "library", label: "Library" },
  { id: "instructions", label: "Instructions" },
  { id: "review", label: "Review" },
] as const;

/** The same row as links (Knowledge ?tab=...), clickable in the kit. */
function KnowledgeLinkTabs() {
  const [tab, setTab] = useState<(typeof KNOWLEDGE_LINKS)[number]["id"]>("review");
  return (
    <LineTabsNav aria-label="Knowledge">
      {KNOWLEDGE_LINKS.map((link) => (
        <LineTabsLink
          key={link.id}
          href={`?tab=${link.id}`}
          active={tab === link.id}
          onClick={(event) => {
            event.preventDefault();
            setTab(link.id);
          }}
          count={link.id === "review" ? reviewItems.length : undefined}
          countTone="attention"
          countLabel={`${reviewItems.length} waiting for review`}
        >
          {link.label}
        </LineTabsLink>
      ))}
    </LineTabsNav>
  );
}

const ENVIRONMENT_CHECKS = [
  { name: "Toolchain versions", detail: "Node 22.9 and Terraform 1.9", status: "succeeded" },
  { name: "Setup script", detail: "Finished in 42 s", status: "succeeded" },
  { name: "Integration tests", detail: "2 failed in billing-api", status: "failed" },
] as const;

const ENVIRONMENT_TABS = ["Overview", "Setup script", "Checks", "Versions", "Changes", "Activity"];

const PEOPLE_FILTERS = [
  { value: "all", label: "All", count: peopleCounts.all },
  { value: "invited", label: "Invited", count: peopleCounts.invited },
  { value: "suspended", label: "Suspended", count: peopleCounts.suspended },
] as const;

function PeopleToolbar() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof PEOPLE_FILTERS)[number]["value"]>("all");
  return (
    <Toolbar>
      <ToolbarSearch value={query} onValueChange={setQuery} placeholder="Search people" />
      <ToolbarGroup>
        <SegmentedControl
          aria-label="Show"
          options={PEOPLE_FILTERS}
          value={filter}
          onValueChange={setFilter}
        />
      </ToolbarGroup>
    </Toolbar>
  );
}

const firstEntries = knowledgeEntries.slice(0, 3);
const platformCi = sandboxEnvironments[0]!;

export default function TabsToolbarSection() {
  return (
    <KitSection sectionKey="tabs-toolbar">
      <Fork layout="stack">
        <Alternative id="a">
          <TabbedCatalog variant="underline" />
        </Alternative>
        <Alternative id="b">
          <TabbedCatalog variant="pill" />
        </Alternative>
        <Alternative id="c">
          <FilteredCatalog />
        </Alternative>
      </Fork>

      <StatesGrid columns={2} description="Version A: underline tabs, and a toolbar under them.">
        <StateCell
          label="Default: tabs, then the toolbar"
          note="Places in the tabs; search, scope and filters in one toolbar that keeps its order when it wraps."
          span="full"
          align="stretch"
        >
          <div className="min-w-0">
            <PageHeader
              icon={<BrainCircuitIcon />}
              title="Knowledge"
              description="What your agents know and how they learn."
              tabs={
                <KnowledgeTabs value="library">
                  <LineTabsContent value="library" className="mt-4">
                    <KnowledgeToolbar />
                    <ul className="mt-4 flex flex-col divide-y divide-border" aria-label="Library">
                      {firstEntries.map((entry) => (
                        <li key={entry.id} className="flex min-w-0 items-center gap-3 py-3">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                            {entry.title}
                          </span>
                          <span className="shrink-0 text-xs text-fg-subtle">
                            {entry.typeLabel} · {entry.updatedLabel}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </LineTabsContent>
                </KnowledgeTabs>
              }
            />
          </div>
        </StateCell>

        <StateCell
          label="Active"
          note="Full text and the 2px bar on the rule. Hover brings a tab to full text."
          align="stretch"
        >
          <KnowledgeTabs value="instructions" />
        </StateCell>

        <StateCell
          label="With count"
          note="Counts are 11px badges. Purple only when something waits for you."
          align="stretch"
        >
          <LineTabs defaultValue="connection">
            <LineTabsList aria-label="Capability types">
              <LineTabsTrigger value="all">All</LineTabsTrigger>
              <LineTabsTrigger value="connection" count={countOf("connection")}>
                Connections
              </LineTabsTrigger>
              <LineTabsTrigger value="skill" count={countOf("skill")}>
                Skills
              </LineTabsTrigger>
            </LineTabsList>
          </LineTabs>
        </StateCell>

        <StateCell
          label="With trailing action"
          note="Add sits on the tab rule, at the same place on every tab."
          align="stretch"
        >
          <LineTabs defaultValue="all">
            <LineTabsList aria-label="Capability types" trailing={<AddButton />}>
              {TABS.map((item) => (
                <LineTabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </LineTabsTrigger>
              ))}
            </LineTabsList>
          </LineTabs>
        </StateCell>

        <StateCell
          label="Segmented filter in the toolbar"
          note="Status filters are a segmented control, not a second tab row."
          align="stretch"
        >
          <PeopleToolbar />
        </StateCell>

        <StateCell
          label="Loading"
          note="Tabs and toolbar keep their shape; rows wait."
          align="stretch"
          span="full"
        >
          <div className="min-w-0">
            <KnowledgeTabs value="library">
              <LineTabsContent value="library" className="mt-4">
                <KnowledgeToolbar loading />
                <div className="mt-4">
                  <RowList variant="resource" label="Library" busy>
                    <ListRowSkeleton count={3} />
                  </RowList>
                </div>
              </LineTabsContent>
            </KnowledgeTabs>
          </div>
        </StateCell>

        <StateCell
          label="Disabled with reason"
          note="Focus or hover Add: Only workspace admins can add capabilities."
          align="stretch"
        >
          <LineTabs defaultValue="all">
            <LineTabsList
              aria-label="Capability types"
              trailing={
                <DisabledReason reason="Only workspace admins can add capabilities. Ask Maria Chen.">
                  <Button size="sm">
                    <PlusIcon aria-hidden="true" />
                    Add
                  </Button>
                </DisabledReason>
              }
            >
              {TABS.map((item) => (
                <LineTabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </LineTabsTrigger>
              ))}
            </LineTabsList>
          </LineTabs>
        </StateCell>

        <StateCell
          label="Error"
          note="Tabs stay usable; the panel says what failed."
          align="stretch"
        >
          <LineTabs defaultValue="skill">
            <LineTabsList aria-label="Capability types">
              {TABS.map((item) => (
                <LineTabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </LineTabsTrigger>
              ))}
            </LineTabsList>
            <LineTabsContent value="skill" className="mt-4">
              <Notice
                tone="failed"
                action={
                  <Button variant="outline" size="sm">
                    <RotateCcwIcon aria-hidden="true" />
                    Try again
                  </Button>
                }
              >
                Couldn't load skills from skills.sh.
              </Notice>
            </LineTabsContent>
          </LineTabs>
        </StateCell>

        <StateCell
          label="Long text"
          note="Labels never wrap or truncate; the row scrolls instead. Keep labels to one or two words."
          align="stretch"
        >
          <LineTabs defaultValue="review">
            <LineTabsList aria-label="Knowledge">
              <LineTabsTrigger value="library">Library</LineTabsTrigger>
              <LineTabsTrigger value="instructions">Workspace instructions</LineTabsTrigger>
              <LineTabsTrigger
                value="review"
                count={reviewItems.length}
                countTone="attention"
                countLabel={`${reviewItems.length} waiting for review`}
              >
                Waiting for your review
              </LineTabsTrigger>
            </LineTabsList>
          </LineTabs>
        </StateCell>

        <StateCell
          label="As links"
          note="Tabs that live in the URL are links; the current one has aria-current."
          align="stretch"
        >
          <KnowledgeLinkTabs />
        </StateCell>

        <StateCell
          label="Applied filters"
          note="Chips wrap under the toolbar; the toolbar itself never wraps on desktop."
          align="stretch"
          span="full"
        >
          <FilteredCatalog
            initial={{ type: ["connection"], status: ["added", "needs_reconnect"] }}
          />
        </StateCell>

        <StateCell
          label="Mobile 390: tabs scroll"
          note="Tabs scroll sideways with a fade; the active tab stays in view."
          width="mobile"
          align="stretch"
        >
          <LineTabs defaultValue="Checks">
            <PageHeader
              context={
                <a
                  href="#sandbox-environments"
                  onClick={(event) => event.preventDefault()}
                  className="-ml-0.5 inline-flex items-center gap-0.5 text-fg-subtle transition-colors hover:text-fg"
                >
                  <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
                  Sandbox environments
                </a>
              }
              title={platformCi.name}
              description={platformCi.description}
              tabs={
                <LineTabsList aria-label={platformCi.name}>
                  {ENVIRONMENT_TABS.map((label) => (
                    <LineTabsTrigger key={label} value={label}>
                      {label}
                    </LineTabsTrigger>
                  ))}
                </LineTabsList>
              }
            />
            <LineTabsContent value="Checks" className="mt-4">
              <RowList variant="resource" label="Checks">
                {ENVIRONMENT_CHECKS.map((check) => (
                  <ListRow
                    key={check.name}
                    title={check.name}
                    description={check.detail}
                    control={<StatusBadge status={check.status} variant="dot" />}
                  />
                ))}
              </RowList>
            </LineTabsContent>
          </LineTabs>
        </StateCell>

        <StateCell
          label="Mobile 390: catalog"
          note="Search on its own line; Add stays on the tab rule."
          width="mobile"
          align="stretch"
        >
          <TabbedCatalog variant="underline" limit={3} />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Tabs for places on one page: Library | Instructions | Review.",
          "One tab row per page. Counts as 11px badges; purple only when something waits for you.",
          "A toolbar for search, a 2-4 option segmented filter, a Filter menu and the page action.",
          "Tabs that live in the URL (Knowledge ?tab=review) render as LineTabsNav links.",
        ]}
        avoid={[
          "A second tab row for statuses. Put a segmented control in the toolbar.",
          "More than 6 tabs. Merge them, or move the rarely used ones into settings.",
          "Tabs in a dialog or sheet with fewer than 3 sections. Use Sections.",
          "Pill tabs for places. Pills read as filters.",
        ]}
      >
        The segmented control and the Filter menu follow the "which control when" table: 2-4 short
        options stay visible; more go in the Filter menu.
      </UsageNotes>
    </KitSection>
  );
}
