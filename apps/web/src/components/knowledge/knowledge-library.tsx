import type {
  KnowledgeEntryKind,
  KnowledgeEntryListRequest,
  KnowledgeEntryScope,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BrainCircuitIcon,
  Building2Icon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@opengeni/react/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { apiErrorDetails, userErrorTextWithoutReference } from "@opengeni/react/ui/api-error";
import {
  Toolbar,
  ToolbarFilterChips,
  ToolbarFilterMenu,
  ToolbarGroup,
  ToolbarSearch,
  ToolbarSummary,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "@opengeni/react/ui/toolbar";

import { scopeFilterValue, useKnowledgeList } from "./knowledge-data";
import { KnowledgeSearchFallback, knowledgeIndexLabel } from "./knowledge-index-status";
import {
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_SCOPE_LABEL,
  KNOWLEDGE_SOURCE_LABEL,
  knowledgeKindIcon,
} from "./knowledge-labels";

/* ----------------------------------------------------------------------------
   Library: every entry agents can look up, newest change first. One toolbar
   that keeps its shape, rows that open the entry's own page, archived and
   rejected entries behind the Status filter, and files as a Type filter.
   Entries | Collections switches the list to the top-level collections, each
   as recent as the newest change inside it.
   -------------------------------------------------------------------------- */

export type LibraryScope = KnowledgeEntryScope | "all";
export type LibraryLayout = "list" | "collections";

export interface LibraryView {
  query: string;
  scope: LibraryScope;
  filters: ToolbarFilterValue;
  layout: LibraryLayout;
}

export function initialLibraryView(personal: boolean): LibraryView {
  return { query: "", scope: personal ? "personal" : "all", filters: {}, layout: "list" };
}

const TYPE_FILTERS: KnowledgeEntryKind[] = [
  "source",
  "fact",
  "decision",
  "requirement",
  "incident",
  "note",
];

const ADDED_GROUP: ToolbarFilterGroup = {
  id: "added",
  label: "Added",
  options: [
    { id: "day", label: "Last 24 hours" },
    { id: "week", label: "Last 7 days" },
    { id: "month", label: "Last 30 days" },
  ],
};

/** Collections have their own view, so Type lists only entry kinds. */
const TYPE_GROUP: ToolbarFilterGroup = {
  id: "type",
  label: "Type",
  options: TYPE_FILTERS.map((kind) => ({
    id: kind,
    label: kind === "source" ? "Files" : KNOWLEDGE_KIND_LABEL[kind],
  })),
};

const STATUS_GROUPS: ToolbarFilterGroup[] = [
  {
    id: "status",
    label: "Status",
    options: [
      { id: "archived", label: "Archived" },
      { id: "rejected", label: "Rejected" },
    ],
  },
  {
    id: "show",
    label: "Also show",
    options: [{ id: "evidence", label: "Supporting sources" }],
  },
];

function filterGroups(layout: LibraryLayout): ToolbarFilterGroup[] {
  return layout === "collections"
    ? [ADDED_GROUP, STATUS_GROUPS[0]!]
    : [ADDED_GROUP, TYPE_GROUP, ...STATUS_GROUPS];
}

/** Filters that apply to what the layout shows: Collections has no Type or supporting sources. */
function layoutFilters(view: LibraryView): ToolbarFilterValue {
  if (view.layout !== "collections") return view.filters;
  const { type: _type, show: _show, ...filters } = view.filters;
  return filters;
}

/** Entries-only filters that wait, hidden, while Collections shows. */
function hiddenFilters(view: LibraryView): ToolbarFilterValue {
  if (view.layout !== "collections") return {};
  return { type: view.filters.type ?? [], show: view.filters.show ?? [] };
}

/** The Library showing files (after an upload, or from an old Files link):
 *  files are entries, so this leaves Collections. */
export function libraryFilesView(view: LibraryView): LibraryView {
  return { ...view, layout: "list", filters: { type: ["source"] } };
}

/** Added, Type and Status each take one value; supporting sources is independent. */
function singleChoice(previous: ToolbarFilterValue, next: ToolbarFilterValue): ToolbarFilterValue {
  const result: ToolbarFilterValue = {};
  for (const [group, ids] of Object.entries(next)) {
    if (group === "show" || ids.length <= 1) {
      result[group] = ids;
      continue;
    }
    const before = previous[group] ?? [];
    result[group] = ids.filter((id) => !before.includes(id)).slice(-1);
  }
  return result;
}

/** Rolling windows use the original entry date, never the latest edit date. */
export function knowledgeAddedSince(
  period: string | undefined,
  now = Date.now(),
): string | undefined {
  const days = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : undefined;
  return days === undefined ? undefined : new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

function libraryRequest(
  view: LibraryView,
  search: string,
  fileId: string | undefined,
  createdSince: string | undefined,
): KnowledgeEntryListRequest {
  const filters = layoutFilters(view);
  const collections = view.layout === "collections";
  const kind = collections ? "group" : (filters.type?.[0] as KnowledgeEntryKind | undefined);
  const status = filters.status?.[0] as "archived" | "rejected" | undefined;
  const evidence = (filters.show ?? []).includes("evidence");
  const scope = scopeFilterValue(view.scope);
  // Collections start at the top level; nested ones open from their parent.
  // Search, filters and a file show every matching collection.
  const rootOnly =
    collections && !search && !fileId && Object.values(filters).every((ids) => !ids.length);
  return {
    view: status ?? "published",
    limit: 50,
    ...(scope ? { scope } : {}),
    ...(kind ? { kind } : {}),
    ...(rootOnly ? { rootOnly: true } : {}),
    ...(evidence || kind === "source" || fileId ? { includeEvidence: true } : {}),
    ...(fileId ? { fileId } : {}),
    ...(search ? { query: search } : {}),
    ...(createdSince ? { createdSince } : {}),
  };
}

/** True on phone widths, where the four scopes move into the Filter menu. */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

const SCOPE_GROUP: ToolbarFilterGroup = {
  id: "scope",
  label: "Where",
  options: (["workspace", "personal", "organization"] as const).map((scope) => ({
    id: scope,
    label: KNOWLEDGE_SCOPE_LABEL[scope],
  })),
};

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function ScopeTag({ scope }: { scope: KnowledgeEntryScope }) {
  if (scope === "workspace") return null;
  const Icon = scope === "personal" ? LockIcon : Building2Icon;
  return (
    <MetaChip variant="text" icon={<Icon />}>
      {KNOWLEDGE_SCOPE_LABEL[scope]}
    </MetaChip>
  );
}

/** A folder for collections, a file for files, and one entry tile for every other kind. */
export function KindTile({ kind }: { kind: KnowledgeEntryKind }) {
  const Icon = knowledgeKindIcon(kind);
  return <LogoTile icon={<Icon />} name={KNOWLEDGE_KIND_LABEL[kind]} />;
}

/** The date column every knowledge list ends with, before the ⋯ menu: what the list is ordered by. */
export const ENTRY_COLUMNS: RowListColumn[] = [
  { id: "updated", label: "Updated", width: 112, align: "end", hideLabel: true },
];

const ADDED_COLUMNS: RowListColumn[] = [
  { id: "updated", label: "Added", width: 112, align: "end", hideLabel: true },
];

export interface EntryRowActions {
  canEdit: (entry: KnowledgeEntrySummary) => boolean;
  onOpen: (entry: KnowledgeEntrySummary) => void;
  onArchive: (entry: KnowledgeEntrySummary) => void;
  onRestore: (entry: KnowledgeEntrySummary) => void;
  linkFor: (entry: KnowledgeEntrySummary) => string;
}

function sourceLine(entry: KnowledgeEntrySummary): string | null {
  const kind = entry.revision.sourceKind;
  if (!kind || kind === "manual") return null;
  if (entry.revision.kind === "source") return knowledgeIndexLabel(entry.indexStatus) ?? null;
  return `From ${KNOWLEDGE_SOURCE_LABEL[kind]?.toLocaleLowerCase() ?? "a source"}`;
}

function describe(entry: KnowledgeEntrySummary, searching: boolean): string | undefined {
  if (searching) return entry.excerpts[0]?.text ?? entry.revision.preview;
  return entry.revision.preview || undefined;
}

export function EntryRow({
  entry,
  actions,
  searching = false,
  status,
  added = false,
}: {
  entry: KnowledgeEntrySummary;
  actions: EntryRowActions;
  searching?: boolean;
  status?: "archived" | "rejected";
  added?: boolean;
}) {
  const editable = actions.canEdit(entry);
  const state = status
    ? status === "archived"
      ? "Archived"
      : "Rejected"
    : entry.revision.change === "archive"
      ? "Archive requested"
      : null;
  return (
    <ListRow
      leading={<KindTile kind={entry.revision.kind} />}
      title={entry.revision.title}
      titleAddon={<ScopeTag scope={entry.scope} />}
      // One quiet line: the type in words, where it came from, then the text.
      meta={[
        KNOWLEDGE_KIND_LABEL[entry.revision.kind],
        sourceLine(entry),
        describe(entry, searching),
      ].filter((part): part is string => Boolean(part))}
      status={
        state ? (
          <StatusBadge variant="dot" tone="neutral">
            {state}
          </StatusBadge>
        ) : undefined
      }
      cells={{
        updated: (
          <RelativeTime
            date={added ? entry.createdAt : (entry.lastChangedAt ?? entry.updatedAt)}
            // Without its latest change inside, a collection's date is its own edit.
            prefix={
              !added && entry.revision.kind === "group" && !entry.lastChangedAt
                ? "Edited"
                : undefined
            }
          />
        ),
      }}
      onOpen={() => actions.onOpen(entry)}
      menu={
        <>
          <DropdownMenuItem onSelect={() => actions.onOpen(entry)}>
            <FileTextIcon />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard
                ?.writeText(new URL(actions.linkFor(entry), window.location.origin).href)
                .then(() => toast("Copied a link to this entry"))
                .catch(() => toast.error("Couldn't copy the link"));
            }}
          >
            <LinkIcon />
            Copy link
          </DropdownMenuItem>
          {editable && entry.revision.change !== "archive" ? (
            <>
              <DropdownMenuSeparator />
              {status ? (
                <DropdownMenuItem onSelect={() => actions.onRestore(entry)}>
                  <ArchiveRestoreIcon />
                  Restore
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => actions.onArchive(entry)}>
                  <ArchiveIcon />
                  Archive
                </DropdownMenuItem>
              )}
            </>
          ) : null}
        </>
      }
      menuLabel={`More actions for ${entry.revision.title}`}
    />
  );
}

export function EntryList({
  label,
  entries,
  actions,
  searching,
  status,
  busy,
  flush = true,
  added = false,
}: {
  label: string;
  entries: KnowledgeEntrySummary[];
  actions: EntryRowActions;
  searching?: boolean;
  status?: "archived" | "rejected";
  busy?: boolean;
  /** Tiles and titles line up with the page's edge (the default). */
  flush?: boolean;
  added?: boolean;
}) {
  return (
    <RowList
      label={label}
      busy={busy}
      flush={flush}
      columns={added ? ADDED_COLUMNS : ENTRY_COLUMNS}
    >
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          actions={actions}
          searching={searching}
          status={status}
          added={added}
        />
      ))}
    </RowList>
  );
}

export interface LibraryTabProps {
  workspaceId: string;
  view: LibraryView;
  onViewChange: (view: LibraryView) => void;
  fileId?: string;
  onClearFile: () => void;
  refresh: number;
  actions: EntryRowActions;
  canAdd: boolean;
  canUpload: boolean;
  onAdd: () => void;
  onUpload: () => void;
  /** Creates a collection, from the empty Collections view. */
  onNewCollection?: () => void;
  /** The Library has nothing at all: the page hides its Add menu, the empty state has it. */
  onEmptyChange?: (empty: boolean) => void;
  /** A Personal workspace starts on "Only me"; that is not a filter the person chose. */
  personal?: boolean;
}

export function LibraryTab({
  workspaceId,
  view,
  onViewChange,
  fileId,
  onClearFile,
  refresh,
  actions,
  canAdd,
  canUpload,
  onAdd,
  onUpload,
  onNewCollection,
  onEmptyChange,
  personal = false,
}: LibraryTabProps) {
  const search = useDebounced(view.query.trim(), 450);
  const searching = search.length > 0;
  const collections = view.layout === "collections";
  const activeFilters = layoutFilters(view);
  const status = activeFilters.status?.[0] as "archived" | "rejected" | undefined;
  const narrowed = Object.values(activeFilters).some((ids) => ids.length > 0) || Boolean(fileId);
  const addedPeriod = activeFilters.added?.[0];
  // Freeze the cutoff across search, other filters and Load more. A page refresh
  // intentionally starts a fresh window and resets the list's cursor.
  const createdSince = useMemo(
    () => knowledgeAddedSince(addedPeriod),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- refresh starts a fresh time window
    [addedPeriod, refresh],
  );
  const request = useMemo(
    () => libraryRequest(view, search, fileId, createdSince),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the query is debounced into `search`
    [view.layout, view.scope, view.filters, search, fileId, createdSince],
  );
  const list = useKnowledgeList(workspaceId, request, refresh);
  const set = (patch: Partial<LibraryView>) => onViewChange({ ...view, ...patch });
  const narrow = useNarrow();
  const groups = narrow ? [SCOPE_GROUP, ...filterGroups(view.layout)] : filterGroups(view.layout);
  const filterValue: ToolbarFilterValue = narrow
    ? { ...activeFilters, scope: view.scope === "all" ? [] : [view.scope] }
    : activeFilters;
  const setFilters = (next: ToolbarFilterValue) => {
    const picked = singleChoice(filterValue, next);
    const { scope, ...filters } = picked;
    set({
      // Type and supporting sources wait, hidden, while Collections shows.
      filters: { ...filters, ...hiddenFilters(view) },
      ...(narrow ? { scope: (scope?.[0] as LibraryScope | undefined) ?? "all" } : {}),
    });
  };
  const filtered = searching || view.scope !== initialLibraryView(personal).scope || narrowed;
  const nothingAtAll =
    !collections && !list.loading && !list.error && list.entries.length === 0 && !filtered;
  useEffect(() => onEmptyChange?.(nothingAtAll), [nothingAtAll, onEmptyChange]);
  const noun = (count: number) =>
    collections ? (count === 1 ? "collection" : "collections") : count === 1 ? "entry" : "entries";

  let body: ReactNode;
  if (list.loading && list.entries.length === 0) {
    body = (
      <RowList label="Knowledge" columns={ENTRY_COLUMNS} flush busy>
        <ListRowSkeleton count={5} />
      </RowList>
    );
  } else if (list.error && list.entries.length === 0) {
    body = (
      <ErrorMessage
        title="Couldn't load the Library"
        {...apiErrorDetails(list.errorCause)}
        action={
          <Button type="button" size="sm" variant="outline" onClick={list.reload}>
            Try again
          </Button>
        }
      >
        {userErrorTextWithoutReference(list.errorCause)}
      </ErrorMessage>
    );
  } else if (nothingAtAll) {
    body = <LibraryEmpty canAdd={canAdd} canUpload={canUpload} onAdd={onAdd} onUpload={onUpload} />;
  } else if (collections && list.entries.length === 0 && !filtered) {
    body = (
      <EmptyState
        variant="inline"
        title="No collections yet."
        action={
          onNewCollection ? (
            <EmptyStateLink onClick={onNewCollection}>New collection</EmptyStateLink>
          ) : undefined
        }
      />
    );
  } else if (list.entries.length === 0) {
    body = (
      <EmptyState
        variant="inline"
        title={
          searching
            ? `No matches for "${search}".`
            : status === "archived"
              ? "Nothing is archived. Archived knowledge isn't used by agents, and you can restore it anytime."
              : status === "rejected"
                ? "No rejected changes."
                : "Nothing matches these filters."
        }
        action={
          <EmptyStateLink
            onClick={() => {
              if (fileId) onClearFile();
              onViewChange(
                searching
                  ? { ...view, query: "" }
                  : { ...view, query: "", filters: hiddenFilters(view), scope: view.scope },
              );
            }}
          >
            {searching ? "Clear search" : "Clear filters"}
          </EmptyStateLink>
        }
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        <EntryList
          label={searching ? "Search results" : collections ? "Collections" : "Knowledge"}
          entries={list.entries}
          actions={actions}
          searching={searching}
          status={status}
          busy={list.loading}
          added={Boolean(createdSince)}
        />
        {list.error ? (
          <p role="alert" className="text-sm text-danger">
            Couldn't load more entries. {list.error}
          </p>
        ) : null}
        {list.cursor ? (
          <Button
            type="button"
            variant="outline"
            className="self-start pointer-coarse:h-11"
            disabled={list.loading}
            onClick={() => void list.loadMore()}
          >
            {list.loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    );
  }

  const summary =
    !list.loading && filtered && list.entries.length > 0 ? (
      searching ? (
        <>
          {list.entries.length}
          {list.cursor ? "+" : ""} {list.entries.length === 1 ? "result" : "results"} for "{search}"
        </>
      ) : (
        <>
          {list.entries.length}
          {list.cursor ? "+" : ""} {noun(list.entries.length)}
        </>
      )
    ) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-6">
      <div className={nothingAtAll ? "hidden" : "flex min-w-0 flex-col gap-3"}>
        <Toolbar>
          <ToolbarSearch
            value={view.query}
            onValueChange={(query) => set({ query })}
            placeholder="Search knowledge"
          />
          <ToolbarGroup className="max-sm:hidden">
            <SegmentedControl<LibraryScope>
              aria-label="Where"
              options={[
                { value: "all", label: "All" },
                { value: "workspace", label: KNOWLEDGE_SCOPE_LABEL.workspace },
                { value: "personal", label: KNOWLEDGE_SCOPE_LABEL.personal },
                { value: "organization", label: KNOWLEDGE_SCOPE_LABEL.organization },
              ]}
              value={view.scope}
              onValueChange={(scope) => set({ scope })}
            />
          </ToolbarGroup>
          <ToolbarGroup align="end">
            <ToolbarFilterMenu groups={groups} value={filterValue} onValueChange={setFilters} />
            <SegmentedControl<LibraryLayout>
              aria-label="Show"
              options={[
                { value: "list", label: "Entries", icon: <ListIcon />, iconOnly: narrow },
                {
                  value: "collections",
                  label: "Collections",
                  icon: <FolderIcon />,
                  iconOnly: narrow,
                },
              ]}
              value={view.layout}
              onValueChange={(layout) => set({ layout })}
            />
          </ToolbarGroup>
        </Toolbar>
        {Object.values(filterValue).some((ids) => ids.length > 0) || summary || fileId ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {fileId ? <FileChip onClear={onClearFile} /> : null}
              <ToolbarFilterChips groups={groups} value={filterValue} onValueChange={setFilters} />
            </div>
            {summary ? <ToolbarSummary className="ml-auto">{summary}</ToolbarSummary> : null}
          </div>
        ) : null}
        {searching && list.fallbackReason ? (
          <KnowledgeSearchFallback reason={list.fallbackReason} workspaceId={workspaceId} />
        ) : null}
      </div>
      <div className="min-w-0">{body}</div>
    </div>
  );
}

function FileChip({ onClear }: { onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface pr-1 pl-2.5 text-xs font-medium text-fg pointer-coarse:h-9">
      <span className="text-fg-subtle">From:</span>
      One file
      <button
        type="button"
        aria-label="Show all knowledge"
        onClick={onClear}
        className="grid size-5 place-items-center rounded-full text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg pointer-coarse:size-8"
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

function LibraryEmpty({
  canAdd,
  canUpload,
  onAdd,
  onUpload,
}: {
  canAdd: boolean;
  canUpload: boolean;
  onAdd: () => void;
  onUpload: () => void;
}) {
  return (
    <EmptyState
      variant="page"
      icon={<BrainCircuitIcon />}
      title="No knowledge yet"
      description="Facts, decisions and files your agents look up when they're relevant. Agents add to it as they work, or you can add it yourself."
      action={
        canAdd || canUpload ? (
          <>
            {canAdd ? (
              <Button type="button" onClick={onAdd} className="pointer-coarse:h-11">
                <PlusIcon aria-hidden="true" />
                Add knowledge
              </Button>
            ) : null}
            {canUpload ? (
              <Button
                type="button"
                variant="outline"
                onClick={onUpload}
                className="pointer-coarse:h-11"
              >
                <UploadIcon aria-hidden="true" />
                Upload files
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}

/**
 * A collection's direct members, split so sub-collections can lead: the
 * sub-collections come from their own query, so one on a later page of the
 * members still shows first. Load more pages the entries.
 */
export function useCollectionMembers(
  workspaceId: string,
  collectionId: string,
  scope: KnowledgeEntryScope | undefined,
  refresh: number,
) {
  const subs = useKnowledgeList(
    workspaceId,
    {
      groupId: collectionId,
      kind: "group",
      view: "published",
      limit: 50,
      ...(scope ? { scope } : {}),
    },
    refresh,
  );
  const members = useKnowledgeList(
    workspaceId,
    { groupId: collectionId, view: "published", limit: 50, ...(scope ? { scope } : {}) },
    refresh,
  );
  const subCollections = subs.entries.filter((entry) => entry.id !== collectionId);
  const entries = members.entries.filter(
    (entry) => entry.id !== collectionId && entry.revision.kind !== "group",
  );
  return {
    subCollections,
    entries,
    subCursor: subs.cursor,
    loadMoreSubs: subs.loadMore,
    loading: subs.loading || members.loading,
    error: subs.error ?? members.error,
    cursor: members.cursor,
    reload: () => {
      subs.reload();
      members.reload();
    },
    loadMore: members.loadMore,
  };
}
