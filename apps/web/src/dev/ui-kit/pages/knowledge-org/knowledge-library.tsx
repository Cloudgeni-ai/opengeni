import { useMemo, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BrainCircuitIcon,
  Building2Icon,
  FileTextIcon,
  FolderIcon,
  FolderTreeIcon,
  GavelIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  SirenIcon,
  StickyNoteIcon,
  UploadIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@/components/ui/detail-page";
import { DetailSection } from "@/components/ui/detail-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EmptyState,
  EmptyStateLink,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@/components/ui/empty-state";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { RevisionHistory, type Revision } from "@/components/ui/revision-history";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
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

import { KIT_NOW, KIT_TIME_ZONE, organization, type KnowledgeScope } from "../../fixtures";
import {
  ENTRY_TYPES,
  KNOWLEDGE_WORKSPACE,
  SCOPE_LABEL,
  TYPE_LABEL,
  type EntryType,
  type LibraryEntry,
} from "./knowledge-data";
import { useElementWidth } from "./frame";
import type { KnowledgeTemplate } from "./knowledge-forms";
import type { PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   Library tab: one toolbar that never reflows, rows that open one detail
   view, archived and rejected entries behind the Status filter.
   -------------------------------------------------------------------------- */

export const TYPE_ICON: Record<EntryType, LucideIcon> = {
  decision: GavelIcon,
  requirement: ShieldCheckIcon,
  incident: SirenIcon,
  fact: LightbulbIcon,
  note: StickyNoteIcon,
  general: FileTextIcon,
};

export type ScopeFilter = "all" | KnowledgeScope;
export type LibraryLayout = "list" | "collections";

export interface LibraryView {
  query: string;
  scope: ScopeFilter;
  filters: ToolbarFilterValue;
  layout: LibraryLayout;
}

export const INITIAL_LIBRARY_VIEW: LibraryView = {
  query: "",
  scope: "all",
  filters: {},
  layout: "list",
};

function scopeWords(organizationWord: string): Record<KnowledgeScope, string> {
  return { ...SCOPE_LABEL, organization: organizationWord };
}

function filterGroups(
  entries: LibraryEntry[],
  scopeInMenu: boolean,
  organizationWord: string,
): ToolbarFilterGroup[] {
  const count = (predicate: (entry: LibraryEntry) => boolean) => entries.filter(predicate).length;
  // Type, source and scope count what the list shows; Status counts what it adds.
  const published = (predicate: (entry: LibraryEntry) => boolean) =>
    count((entry) => entry.status === "published" && predicate(entry));
  const types: EntryType[] = ["decision", "requirement", "incident", "fact", "note", "general"];
  const groups: ToolbarFilterGroup[] = [
    {
      id: "type",
      label: "Type",
      options: types
        .filter((type) => entries.some((entry) => entry.type === type))
        .map((type) => ({
          id: type,
          label: TYPE_LABEL[type],
          count: published((entry) => entry.type === type),
        })),
    },
    {
      id: "source",
      label: "Source",
      options: [
        { id: "file", label: "Files", count: published((entry) => entry.source?.kind === "file") },
        { id: "chat", label: "Chats", count: published((entry) => entry.source?.kind === "chat") },
        { id: "person", label: "Added by people", count: published((entry) => !entry.source) },
      ],
    },
    {
      id: "status",
      label: "Status",
      options: [
        { id: "archived", label: "Archived", count: count((entry) => entry.status === "archived") },
        { id: "rejected", label: "Rejected", count: count((entry) => entry.status === "rejected") },
      ],
    },
  ];
  if (scopeInMenu) {
    const words = scopeWords(organizationWord);
    groups.unshift({
      id: "scope",
      label: "Where",
      options: (["workspace", "personal", "organization"] as const).map((scope) => ({
        id: scope,
        label: words[scope],
        count: published((entry) => entry.scope === scope),
      })),
    });
  }
  return groups;
}

function sourceKind(entry: LibraryEntry): "file" | "chat" | "person" {
  return entry.source?.kind ?? "person";
}

/** Entries the current view shows. Published only, unless Status asks for more. */
export function visibleEntries(entries: LibraryEntry[], view: LibraryView): LibraryEntry[] {
  const statuses = view.filters.status ?? [];
  const types = view.filters.type ?? [];
  const sources = view.filters.source ?? [];
  const scopes = view.filters.scope ?? [];
  const query = view.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    const statusOk =
      entry.status === "published" ? statuses.length === 0 : statuses.includes(entry.status);
    if (!statusOk) return false;
    if (types.length > 0 && !types.includes(entry.type)) return false;
    if (sources.length > 0 && !sources.includes(sourceKind(entry))) return false;
    if (view.scope !== "all" && entry.scope !== view.scope) return false;
    if (scopes.length > 0 && !scopes.includes(entry.scope)) return false;
    if (!query) return true;
    return [entry.title, entry.content, entry.collection ?? "", entry.source?.name ?? ""]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  });
}

/** A short excerpt around the first match, with the match marked. */
function Excerpt({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLocaleLowerCase();
  const at = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
  if (at < 0) return <>{text}</>;
  const start = Math.max(0, at - 32);
  const before = `${start > 0 ? "…" : ""}${text.slice(start, at)}`;
  const match = text.slice(at, at + needle.length);
  const after = text.slice(at + needle.length);
  return (
    <>
      {before}
      <mark className="rounded-[3px] bg-brand/15 px-0.5 text-fg">{match}</mark>
      {after}
    </>
  );
}

function ScopeTag({
  scope,
  organizationWord,
}: {
  scope: KnowledgeScope;
  organizationWord: string;
}) {
  if (scope === "workspace") return null;
  const Icon = scope === "personal" ? LockIcon : Building2Icon;
  return (
    <MetaChip variant="text" icon={<Icon />}>
      {scopeWords(organizationWord)[scope]}
    </MetaChip>
  );
}

function EntryStatus({
  entry,
  variant,
}: {
  entry: LibraryEntry;
  variant: PagePicks["status"]["row"];
}) {
  if (entry.status === "published") return null;
  return entry.status === "archived" ? (
    <StatusBadge variant={variant} tone="neutral" icon={<ArchiveIcon />}>
      Archived
    </StatusBadge>
  ) : (
    <StatusBadge variant={variant} tone="neutral" icon={<ArchiveIcon />}>
      Rejected
    </StatusBadge>
  );
}

export interface LibraryTabProps {
  picks: PagePicks;
  entries: LibraryEntry[];
  collections: string[];
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  state: "filled" | "empty" | "loading";
  organizationWord: string;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onArchive: (entry: LibraryEntry) => void;
  onRestore: (entry: LibraryEntry) => void;
  onAddKnowledge: (template?: KnowledgeTemplate) => void;
  onUpload: () => void;
}

// The values explain themselves ("Decision", "8 days ago"); tables still show the headers.
const COLUMNS: RowListColumn[] = [
  { id: "type", label: "Type", width: 112, hideLabel: true },
  { id: "updated", label: "Updated", width: 112, hideLabel: true },
];

export function LibraryTab({
  picks,
  entries,
  collections,
  view,
  onViewChange,
  state,
  organizationWord,
  openId,
  onOpen,
  onArchive,
  onRestore,
  onAddKnowledge,
  onUpload,
}: LibraryTabProps) {
  const loading = state === "loading";
  const empty = state === "empty";
  const [ref, width] = useElementWidth<HTMLDivElement>();
  // On a phone the four scopes don't fit next to Filter; they join its menu.
  const narrow = width > 0 && width < 560;
  const scopeInMenu = picks.tabs === "filter-menu" || narrow;
  const groups = useMemo(
    () => filterGroups(entries, scopeInMenu, organizationWord),
    [entries, scopeInMenu, organizationWord],
  );
  const shown = empty ? [] : visibleEntries(entries, view);
  const searching = view.query.trim().length > 0;
  const words = scopeWords(organizationWord);
  const columns = picks.list === "catalog" ? undefined : COLUMNS;
  const set = (patch: Partial<LibraryView>) => onViewChange({ ...view, ...patch });
  const filtered =
    searching || view.scope !== "all" || Object.values(view.filters).some((ids) => ids.length > 0);

  const renderRow = (entry: LibraryEntry) => {
    const Icon = TYPE_ICON[entry.type];
    const catalog = picks.list === "catalog";
    const sourceLine = entry.source
      ? entry.source.kind === "file"
        ? `From ${entry.source.name}`
        : `From chat ${entry.source.name}`
      : null;
    const statusNode = <EntryStatus entry={entry} variant={picks.status.row} />;
    const updated = <RelativeTime date={entry.updatedAt} now={KIT_NOW} timeZone={KIT_TIME_ZONE} />;
    const open = openId === entry.id;
    return (
      <ListRow
        key={entry.id}
        leading={<LogoTile icon={<Icon />} name={TYPE_LABEL[entry.type]} />}
        title={entry.title}
        titleAddon={<ScopeTag scope={entry.scope} organizationWord={organizationWord} />}
        description={<Excerpt text={entry.content} query={view.query} />}
        meta={[
          catalog ? TYPE_LABEL[entry.type] : null,
          entry.collection && view.layout === "list" ? `In ${entry.collection}` : null,
          sourceLine,
          entry.status === "published" ? null : statusNode,
          catalog ? <span key="updated">Updated {updated}</span> : null,
        ].filter(Boolean)}
        cells={catalog ? undefined : { type: TYPE_LABEL[entry.type], updated }}
        selected={open}
        onOpen={() => onOpen(entry.id)}
        menu={
          <>
            <DropdownMenuItem onSelect={() => onOpen(entry.id)}>
              <FileTextIcon />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => toast("Copied a link to this entry")}>
              <LinkIcon />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {entry.status === "published" ? (
              <DropdownMenuItem onSelect={() => onArchive(entry)}>
                <ArchiveIcon />
                Archive
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onRestore(entry)}>
                <ArchiveRestoreIcon />
                Restore
              </DropdownMenuItem>
            )}
          </>
        }
        menuLabel={`More actions for ${entry.title}`}
      />
    );
  };

  const list = (items: LibraryEntry[], label: string) => (
    <RowList variant={picks.list} columns={columns} label={label}>
      {items.map(renderRow)}
    </RowList>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <RowList variant={picks.list} columns={columns} label="Knowledge" busy>
        <ListRowSkeleton count={5} />
      </RowList>
    );
  } else if (empty) {
    body = (
      <EmptyState
        variant={picks.empty.variant}
        icon={<BrainCircuitIcon />}
        title="No knowledge yet"
        description={
          picks.empty.variant === "inline"
            ? "Agents add facts and decisions here as they work."
            : "Facts, decisions and runbooks your agents look up when they're relevant. Agents add to it as they work, or you can add it yourself."
        }
        action={
          picks.empty.variant === "inline" ? (
            <EmptyStateLink onClick={() => onAddKnowledge()}>Add knowledge</EmptyStateLink>
          ) : (
            <>
              <Button
                type="button"
                onClick={() => onAddKnowledge()}
                className="pointer-coarse:h-11"
              >
                <PlusIcon aria-hidden="true" />
                Add knowledge
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onUpload}
                className="pointer-coarse:h-11"
              >
                <UploadIcon aria-hidden="true" />
                Upload files
              </Button>
            </>
          )
        }
        templates={
          picks.empty.templates ? (
            <EmptyStateTemplates label="Or start with one of these">
              <EmptyStateTemplate
                icon={<GavelIcon />}
                title="Record a decision"
                description="Production deploys need a second reviewer."
                meta="Decision"
                onSelect={() =>
                  onAddKnowledge({
                    type: "decision",
                    title: "Production deploys need a second reviewer",
                    content:
                      "Every deploy to production needs approval from a second engineer. The on-call engineer can approve their own hotfix.",
                  })
                }
              />
              <EmptyStateTemplate
                icon={<ShieldCheckIcon />}
                title="Add a requirement"
                description="EU customer data stays in eu-north-1."
                meta="Requirement"
                onSelect={() =>
                  onAddKnowledge({
                    type: "requirement",
                    title: "EU customer data stays in eu-north-1",
                    content:
                      "Customer data for EU accounts is stored and processed only in eu-north-1.",
                  })
                }
              />
              <EmptyStateTemplate
                icon={<UploadIcon />}
                title="Upload a runbook"
                description="PDFs and text files. Agents read them when relevant."
                meta="File"
                onSelect={onUpload}
              />
            </EmptyStateTemplates>
          ) : undefined
        }
      />
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState
        variant="inline"
        title={
          searching ? `No matches for "${view.query.trim()}".` : "Nothing matches these filters."
        }
        action={
          <EmptyStateLink
            onClick={() =>
              onViewChange(
                searching
                  ? { ...view, query: "" }
                  : { ...INITIAL_LIBRARY_VIEW, layout: view.layout },
              )
            }
          >
            {searching ? "Clear search" : "Clear filters"}
          </EmptyStateLink>
        }
      />
    );
  } else if (view.layout === "collections" && !searching) {
    const grouped = [
      ...collections.map((name) => ({
        name,
        items: shown.filter((entry) => entry.collection === name),
      })),
      { name: null as string | null, items: shown.filter((entry) => !entry.collection) },
    ];
    body = (
      <div className="flex min-w-0 flex-col gap-6">
        {grouped.map((group) => (
          <section
            key={group.name ?? "none"}
            aria-label={group.name ?? "Not in a collection"}
            className="min-w-0"
          >
            <div className="flex min-w-0 items-center gap-2 px-3 pb-1.5 text-xs leading-4.5 font-medium text-fg-subtle">
              <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{group.name ?? "Not in a collection"}</span>
              <span className="tabular-nums">{group.items.length}</span>
            </div>
            {group.items.length > 0 ? (
              list(group.items, group.name ?? "Not in a collection")
            ) : (
              <p className="border-t border-border px-3 py-3 text-sm text-fg-muted">
                Empty. Add entries from their ⋯ menu or when you create them.
              </p>
            )}
          </section>
        ))}
      </div>
    );
  } else {
    body = list(shown, "Knowledge");
  }

  // A count only while the list is narrowed; the full list speaks for itself.
  const summary =
    loading || empty || !filtered ? null : searching ? (
      <>
        {shown.length} {shown.length === 1 ? "result" : "results"} for "{view.query.trim()}"
      </>
    ) : (
      <>
        {shown.length} of {entries.filter((entry) => entry.status === "published").length} entries
      </>
    );

  return (
    <div ref={ref} className="flex min-w-0 flex-col gap-4 pt-6">
      {empty && picks.empty.variant === "page" ? null : (
        <div className="flex min-w-0 flex-col gap-3">
          <Toolbar>
            <ToolbarSearch
              value={view.query}
              onValueChange={(query) => set({ query })}
              placeholder="Search knowledge"
              disabled={loading || empty}
            />
            {scopeInMenu ? null : (
              <ToolbarGroup>
                <SegmentedControl<ScopeFilter>
                  aria-label="Where"
                  variant={picks.segmented}
                  disabled={loading || empty}
                  options={[
                    { value: "all", label: "All" },
                    { value: "workspace", label: words.workspace },
                    { value: "personal", label: words.personal },
                    { value: "organization", label: words.organization },
                  ]}
                  value={view.scope}
                  onValueChange={(scope) => set({ scope })}
                />
              </ToolbarGroup>
            )}
            <ToolbarGroup align={narrow ? "start" : "end"}>
              <ToolbarFilterMenu
                groups={groups}
                value={view.filters}
                onValueChange={(filters) => set({ filters })}
                disabled={loading || empty}
              />
              <SegmentedControl<LibraryLayout>
                aria-label="Show"
                variant={picks.segmented === "underline" ? "filled" : picks.segmented}
                disabled={loading || empty}
                options={[
                  { value: "list", label: "List", icon: <ListIcon />, iconOnly: true },
                  {
                    value: "collections",
                    label: "By collection",
                    icon: <FolderTreeIcon />,
                    iconOnly: true,
                  },
                ]}
                value={view.layout}
                onValueChange={(layout) => set({ layout })}
              />
            </ToolbarGroup>
          </Toolbar>
          {Object.values(view.filters).some((ids) => ids.length > 0) || summary ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <ToolbarFilterChips
                groups={groups}
                value={view.filters}
                onValueChange={(filters) => set({ filters })}
              />
              {summary ? <ToolbarSummary className="ml-auto">{summary}</ToolbarSummary> : null}
            </div>
          ) : null}
        </div>
      )}
      <div className="min-w-0">{body}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   One entry: its own page, like a skill in Claude's settings. Back link,
   tile, title with its scope, a "by · in · updated" line, Overview and
   History tabs, the text in the main column and the facts in a quiet card.
   Edit is its own page too.
   -------------------------------------------------------------------------- */

export interface EntryPatch {
  title: string;
  content: string;
  type: EntryType;
}

export interface EntryDetailProps {
  entry: LibraryEntry;
  picks: PagePicks;
  organizationWord: string;
  onClose: () => void;
  onEdit: (entry: LibraryEntry) => void;
  onArchive: (entry: LibraryEntry) => void;
  onRestore: (entry: LibraryEntry) => void;
  onRestoreRevision: (entry: LibraryEntry, revision: Revision) => Promise<void>;
}

function whereLabel(scope: KnowledgeScope, organizationWord: string): string {
  if (scope === "workspace") return `Workspace · ${KNOWLEDGE_WORKSPACE.name}`;
  if (scope === "personal") return "Only me · Private to you";
  return `${organizationWord} · ${organization.name}`;
}

type EntryTab = "overview" | "history";

function EntryDetailPage({
  entry,
  picks,
  organizationWord,
  onClose,
  onEdit,
  onArchive,
  onRestore,
  onRestoreRevision,
}: EntryDetailProps) {
  const [tab, setTab] = useState<EntryTab>("overview");
  const Icon = TYPE_ICON[entry.type];
  const words = scopeWords(organizationWord);
  const published = entry.status === "published";

  const aside = (
    <DetailAside label={`About ${entry.title}`}>
      <DetailAsideItem label="Created by" icon={<UserRoundIcon />}>
        {entry.revisions.at(-1)?.author ?? entry.author}
      </DetailAsideItem>
      <DetailAsideItem
        label="Where"
        icon={entry.scope === "personal" ? <LockIcon /> : <Building2Icon />}
      >
        {whereLabel(entry.scope, organizationWord)}
      </DetailAsideItem>
      <DetailAsideItem label="Type" icon={<Icon />}>
        {TYPE_LABEL[entry.type]}
      </DetailAsideItem>
      <DetailAsideItem label="Collection" icon={<FolderIcon />}>
        {entry.collection ?? <span className="text-fg-muted">None</span>}
      </DetailAsideItem>
      {entry.source ? (
        <DetailAsideItem
          label="Source"
          icon={entry.source.kind === "file" ? <FileTextIcon /> : <MessageSquareIcon />}
        >
          <button
            type="button"
            onClick={() => toast(`Opened ${entry.source?.name}`)}
            className="max-w-full truncate rounded-[4px] text-left underline-offset-2 hover:underline pointer-coarse:min-h-11"
          >
            {entry.source.name}
          </button>
        </DetailAsideItem>
      ) : null}
    </DetailAside>
  );

  return (
    <DetailPage back={{ label: "Knowledge", onClick: onClose }}>
      <LineTabs
        value={tab}
        onValueChange={(value) => setTab(value as EntryTab)}
        className="min-w-0"
      >
        <DetailPageHeader
          leading={<LogoTile icon={<Icon />} name={TYPE_LABEL[entry.type]} />}
          title={entry.title}
          chips={
            <>
              <MetaChip variant="soft">{words[entry.scope]}</MetaChip>
              <EntryStatus entry={entry} variant={picks.status.header} />
            </>
          }
          meta={[
            `by ${entry.author}`,
            entry.collection ? `in ${entry.collection}` : null,
            <span key="updated">
              updated{" "}
              <RelativeTime
                date={entry.updatedAt}
                now={KIT_NOW}
                timeZone={KIT_TIME_ZONE}
                inSentence
              />
            </span>,
          ]}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onEdit(entry)}
                className="pointer-coarse:h-11"
              >
                <PencilIcon aria-hidden="true" />
                Edit
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`More actions for ${entry.title}`}
                    className="text-fg-muted hover:text-fg pointer-coarse:size-11"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem onSelect={() => toast("Copied a link to this entry")}>
                    <LinkIcon />
                    Copy link
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {published ? (
                    <DropdownMenuItem onSelect={() => onArchive(entry)}>
                      <ArchiveIcon />
                      Archive
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => onRestore(entry)}>
                      <ArchiveRestoreIcon />
                      Restore
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
          tabs={
            <LineTabsList variant={picks.tabVariant} aria-label={entry.title}>
              <LineTabsTrigger value="overview">Overview</LineTabsTrigger>
              <LineTabsTrigger
                value="history"
                count={entry.revisions.length}
                countLabel={`${entry.revisions.length} versions`}
              >
                History
              </LineTabsTrigger>
            </LineTabsList>
          }
        />
        <LineTabsContent value="overview">
          <DetailPageBody aside={aside}>
            {published ? null : (
              <DetailSection>
                <Notice
                  tone="muted"
                  icon={<ArchiveIcon className="size-4" />}
                  title={entry.status === "archived" ? "Archived" : "Rejected"}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onRestore(entry)}
                    >
                      Restore
                    </Button>
                  }
                  actionLayout="responsive"
                >
                  Agents don't use it. Restore it to make it available again.
                </Notice>
              </DetailSection>
            )}
            <DetailSection title="What agents know">
              <p className="text-sm leading-6 text-pretty whitespace-pre-line text-fg">
                {entry.content}
              </p>
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
        <LineTabsContent value="history">
          <DetailPageBody>
            <DetailSection description="Restoring saves that version again as the newest one, so you can always go back.">
              <RevisionHistory
                revisions={entry.revisions}
                now={KIT_NOW}
                format="text"
                label={`History of ${entry.title}`}
                onRestore={(revision) => onRestoreRevision(entry, revision)}
              />
            </DetailSection>
          </DetailPageBody>
        </LineTabsContent>
      </LineTabs>
    </DetailPage>
  );
}

/** The entry's page. Remounts per entry so a tab choice never leaks into another entry. */
export function EntryDetail(props: EntryDetailProps) {
  return <EntryDetailPage key={props.entry.id} {...props} />;
}

/** Edit an entry: its own page, back to the entry. */
export function EntryEditPage({
  entry,
  picks,
  onClose,
  onSave,
}: {
  entry: LibraryEntry;
  picks: PagePicks;
  onClose: () => void;
  onSave: (entry: LibraryEntry, patch: EntryPatch) => Promise<void>;
}) {
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [type, setType] = useState<EntryType>(entry.type);
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  const unchanged =
    title.trim() === entry.title && content.trim() === entry.content && type === entry.type;

  return (
    <FormPage
      title={`Edit ${entry.title}`}
      description="Agents use the new text from the next message. The old version stays in History."
      back={{ label: entry.title, onClick: onClose }}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      submitDisabled={unchanged}
      onCancel={onClose}
      onSubmitted={onClose}
      onSubmit={async () => {
        const next = {
          title: title.trim() ? undefined : "Add a title.",
          content: content.trim() ? undefined : "Add what agents should know.",
        };
        setErrors(next);
        if (next.title || next.content) return false;
        await onSave(entry, { title: title.trim(), content: content.trim(), type });
        return true;
      }}
      className="flex-1"
    >
      <FieldStack>
        <Field label="Title" error={errors.title}>
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            suppressAutofill
          />
        </Field>
        <Field
          label="What agents should know"
          hint="Keep it to one fact or decision. Rules for how agents work go in Instructions."
          error={errors.content}
        >
          <TextArea rows={6} value={content} onChange={(event) => setContent(event.target.value)} />
        </Field>
        <Field label="Type">
          <SelectMenu<EntryType>
            variant={picks.select}
            size="md"
            options={ENTRY_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] }))}
            value={type}
            onValueChange={setType}
            className="w-full max-w-60"
            searchPlaceholder="Search types"
          />
        </Field>
      </FieldStack>
    </FormPage>
  );
}
