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
  FolderTreeIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  PlusIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
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

import { errorText, scopeFilterValue, useKnowledgeList } from "./knowledge-data";
import { KnowledgeSearchFallback, knowledgeIndexLabel } from "./knowledge-index-status";
import {
  KNOWLEDGE_KIND_LABEL,
  KNOWLEDGE_SCOPE_LABEL,
  KNOWLEDGE_SOURCE_LABEL,
  knowledgeKindIcon,
} from "./knowledge-labels";

/* ----------------------------------------------------------------------------
   Library: every entry agents can look up. One toolbar that keeps its shape,
   rows that open the entry's own page, archived and rejected entries behind
   the Status filter, and files as a Type filter.
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
  "group",
];

const FILTER_GROUPS: ToolbarFilterGroup[] = [
  {
    id: "type",
    label: "Type",
    options: TYPE_FILTERS.map((kind) => ({
      id: kind,
      label:
        kind === "source" ? "Files" : kind === "group" ? "Collections" : KNOWLEDGE_KIND_LABEL[kind],
    })),
  },
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

/** Type and Status are one value each (the API filters one kind and one view). */
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

function libraryRequest(
  view: LibraryView,
  search: string,
  fileId: string | undefined,
): KnowledgeEntryListRequest {
  const kind = view.filters.type?.[0] as KnowledgeEntryKind | undefined;
  const status = view.filters.status?.[0] as "archived" | "rejected" | undefined;
  const evidence = (view.filters.show ?? []).includes("evidence");
  const scope = scopeFilterValue(view.scope);
  return {
    view: status ?? "published",
    limit: 50,
    ...(scope ? { scope } : {}),
    ...(kind ? { kind } : {}),
    ...(evidence || kind === "source" || fileId ? { includeEvidence: true } : {}),
    ...(fileId ? { fileId } : {}),
    ...(search ? { query: search } : {}),
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

/** The date column every knowledge list ends with, before the ⋯ menu. */
export const ENTRY_COLUMNS: RowListColumn[] = [
  { id: "updated", label: "Updated", width: 112, align: "end", hideLabel: true },
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
}: {
  entry: KnowledgeEntrySummary;
  actions: EntryRowActions;
  searching?: boolean;
  status?: "archived" | "rejected";
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
      cells={{ updated: <RelativeTime date={entry.updatedAt} /> }}
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
}: {
  label: string;
  entries: KnowledgeEntrySummary[];
  actions: EntryRowActions;
  searching?: boolean;
  status?: "archived" | "rejected";
  busy?: boolean;
  /** Tiles and titles line up with the page's edge (the default). */
  flush?: boolean;
}) {
  return (
    <RowList label={label} busy={busy} flush={flush} columns={ENTRY_COLUMNS}>
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          actions={actions}
          searching={searching}
          status={status}
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
  onEmptyChange,
  personal = false,
}: LibraryTabProps) {
  const search = useDebounced(view.query.trim(), 450);
  const searching = search.length > 0;
  const status = view.filters.status?.[0] as "archived" | "rejected" | undefined;
  const narrowed = Object.values(view.filters).some((ids) => ids.length > 0) || Boolean(fileId);
  const collections = view.layout === "collections" && !searching && !narrowed;
  const request = useMemo(
    () => (collections ? null : libraryRequest(view, search, fileId)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the query is debounced into `search`
    [collections, view.scope, view.filters, search, fileId],
  );
  const list = useKnowledgeList(workspaceId, request, refresh);
  const set = (patch: Partial<LibraryView>) => onViewChange({ ...view, ...patch });
  const narrow = useNarrow();
  const groups = narrow ? [SCOPE_GROUP, ...FILTER_GROUPS] : FILTER_GROUPS;
  const filterValue: ToolbarFilterValue = narrow
    ? { ...view.filters, scope: view.scope === "all" ? [] : [view.scope] }
    : view.filters;
  const setFilters = (next: ToolbarFilterValue) => {
    const picked = singleChoice(filterValue, next);
    const { scope, ...filters } = picked;
    set({
      filters,
      ...(narrow ? { scope: (scope?.[0] as LibraryScope | undefined) ?? "all" } : {}),
    });
  };
  const filtered = searching || view.scope !== initialLibraryView(personal).scope || narrowed;
  const nothingAtAll =
    !collections && !list.loading && !list.error && list.entries.length === 0 && !filtered;
  useEffect(() => onEmptyChange?.(nothingAtAll), [nothingAtAll, onEmptyChange]);

  let body: ReactNode;
  if (collections) {
    body = (
      <CollectionsLayout
        workspaceId={workspaceId}
        scope={view.scope}
        refresh={refresh}
        actions={actions}
        empty={
          <LibraryEmpty canAdd={canAdd} canUpload={canUpload} onAdd={onAdd} onUpload={onUpload} />
        }
      />
    );
  } else if (list.loading && list.entries.length === 0) {
    body = (
      <RowList label="Knowledge" columns={ENTRY_COLUMNS} flush busy>
        <ListRowSkeleton count={5} />
      </RowList>
    );
  } else if (list.error && list.entries.length === 0) {
    body = (
      <Notice
        tone="failed"
        title="Couldn't load the Library"
        action={
          <Button type="button" size="sm" variant="outline" onClick={list.reload}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {list.error}
      </Notice>
    );
  } else if (nothingAtAll) {
    body = <LibraryEmpty canAdd={canAdd} canUpload={canUpload} onAdd={onAdd} onUpload={onUpload} />;
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
                  : { ...view, query: "", filters: {}, scope: view.scope },
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
          label={searching ? "Search results" : "Knowledge"}
          entries={list.entries}
          actions={actions}
          searching={searching}
          status={status}
          busy={list.loading}
        />
        {list.error ? (
          <p role="alert" className="text-sm text-danger">
            {list.error}
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
    !collections && !list.loading && filtered && list.entries.length > 0 ? (
      searching ? (
        <>
          {list.entries.length}
          {list.cursor ? "+" : ""} {list.entries.length === 1 ? "result" : "results"} for "{search}"
        </>
      ) : (
        <>
          {list.entries.length}
          {list.cursor ? "+" : ""} {list.entries.length === 1 ? "entry" : "entries"}
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

/* ----------------------------------------------------------------------------
   By collection: each top-level collection with its sub-collections (rows that
   open their own page) and then its entries, and finally everything that
   isn't in a collection. A nested collection appears once, inside its parent.
   -------------------------------------------------------------------------- */

function CollectionsLayout({
  workspaceId,
  scope,
  refresh,
  actions,
  empty,
}: {
  workspaceId: string;
  scope: LibraryScope;
  refresh: number;
  actions: EntryRowActions;
  empty: ReactNode;
}) {
  const scoped = scopeFilterValue(scope);
  // Only collections without a visible parent in this scope get a section.
  const groups = useKnowledgeList(
    workspaceId,
    {
      kind: "group",
      rootOnly: true,
      view: "published",
      limit: 50,
      ...(scoped ? { scope: scoped } : {}),
    },
    refresh,
  );
  const roots = useKnowledgeList(
    workspaceId,
    { rootOnly: true, view: "published", limit: 50, ...(scoped ? { scope: scoped } : {}) },
    refresh,
  );
  const loose = roots.entries.filter((entry) => entry.revision.kind !== "group");
  if ((groups.loading && !groups.entries.length) || (roots.loading && !roots.entries.length)) {
    return (
      <RowList label="Knowledge" columns={ENTRY_COLUMNS} flush busy>
        <ListRowSkeleton count={5} />
      </RowList>
    );
  }
  const error = groups.error ?? roots.error;
  if (error && !groups.entries.length && !roots.entries.length) {
    return (
      <Notice
        tone="failed"
        title="Couldn't load the Library"
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              groups.reload();
              roots.reload();
            }}
          >
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {error}
      </Notice>
    );
  }
  if (!groups.entries.length && !loose.length) return <>{empty}</>;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {groups.entries.map((group) => (
        <CollectionSection
          key={group.id}
          workspaceId={workspaceId}
          group={group}
          scope={scoped}
          refresh={refresh}
          actions={actions}
        />
      ))}
      {groups.cursor ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={groups.loading}
          onClick={() => void groups.loadMore()}
        >
          More collections
        </Button>
      ) : null}
      {loose.length ? (
        <section aria-label="Not in a collection" className="min-w-0">
          <GroupHeading
            name="Not in a collection"
            count={loose.length}
            more={Boolean(roots.cursor)}
          />
          <EntryList label="Not in a collection" entries={loose} actions={actions} />
          {roots.cursor ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              disabled={roots.loading}
              onClick={() => void roots.loadMore()}
            >
              Load more
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function GroupHeading({
  name,
  count,
  more,
  onOpen,
}: {
  name: string;
  count: number | null;
  more?: boolean;
  onOpen?: () => void;
}) {
  const label = (
    <>
      <span className="min-w-0 truncate">{name}</span>
      {count !== null ? (
        <span className="font-normal text-fg-subtle tabular-nums">
          {count}
          {more ? "+" : ""}
        </span>
      ) : null}
    </>
  );
  const className =
    "flex min-w-0 items-center gap-2 pb-1 text-left text-sm leading-5 font-medium text-fg";
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={`${className} rounded-[6px] underline-offset-4 hover:underline pointer-coarse:min-h-11`}
    >
      {label}
    </button>
  ) : (
    <h3 className={className}>{label}</h3>
  );
}

function CollectionSection({
  workspaceId,
  group,
  scope,
  refresh,
  actions,
}: {
  workspaceId: string;
  group: KnowledgeEntrySummary;
  scope: KnowledgeEntryScope | undefined;
  refresh: number;
  actions: EntryRowActions;
}) {
  const members = useCollectionMembers(workspaceId, group.id, scope, refresh);
  const rows = [...members.subCollections, ...members.entries];
  return (
    <section aria-label={group.revision.title} className="min-w-0">
      <GroupHeading
        name={group.revision.title}
        count={members.loading && !rows.length ? null : rows.length}
        more={Boolean(members.cursor || members.subCursor)}
        onOpen={() => actions.onOpen(group)}
      />
      {members.loading && !rows.length ? (
        <RowList label={group.revision.title} columns={ENTRY_COLUMNS} flush busy>
          <ListRowSkeleton count={1} />
        </RowList>
      ) : members.error && !rows.length ? (
        <p role="alert" className="py-3 text-sm text-danger">
          {errorText(members.error)}{" "}
          <button type="button" className="underline" onClick={members.reload}>
            Try again
          </button>
        </p>
      ) : rows.length ? (
        <EntryList label={group.revision.title} entries={rows} actions={actions} />
      ) : (
        <p className="py-3 text-sm text-fg-muted">Empty. Add entries to it from their Edit page.</p>
      )}
      {members.subCursor || members.cursor ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {members.subCursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={members.loading}
              onClick={() => void members.loadMoreSubs()}
            >
              More collections
            </Button>
          ) : null}
          {members.cursor ? (
            <Button
              type="button"
              variant="outline"
              disabled={members.loading}
              onClick={() => void members.loadMore()}
            >
              Load more
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
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
