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
  PlusIcon,
  ShieldCheckIcon,
  SirenIcon,
  StickyNoteIcon,
  UploadIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFact,
  DetailFacts,
  DetailFooter,
  DetailHeader,
  DetailInline,
  DetailPage,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import { Disclosure } from "@/components/ui/disclosure";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  EmptyState,
  EmptyStateLink,
  EmptyStateTemplate,
  EmptyStateTemplates,
} from "@/components/ui/empty-state";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
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
  /** Rendered in place of the list for the inline detail pick. */
  renderInlineDetail: (entry: LibraryEntry) => ReactNode;
  /** A create form shown inline above the list (form pick C). */
  inlineForm?: ReactNode;
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
  renderInlineDetail,
  inlineForm,
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
  const inline = picks.detail === "inline" && picks.list !== "table";
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
        onOpen={() => onOpen(open && inline ? null : entry.id)}
        expanded={inline ? open : undefined}
        panel={inline && open ? renderInlineDetail(entry) : undefined}
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
      {inlineForm}
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
   One entry: the same parts in a sheet, a page or in place.
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
  onSave: (entry: LibraryEntry, patch: EntryPatch) => Promise<void>;
  onArchive: (entry: LibraryEntry) => void;
  onRestore: (entry: LibraryEntry) => void;
  onRestoreRevision: (entry: LibraryEntry, revision: Revision) => Promise<void>;
}

function whereLabel(scope: KnowledgeScope, organizationWord: string): string {
  if (scope === "workspace") return `Workspace · ${KNOWLEDGE_WORKSPACE.name}`;
  if (scope === "personal") return "Only me · Private to you";
  return `${organizationWord} · ${organization.name}`;
}

function EntryDetailParts({
  entry,
  picks,
  organizationWord,
  onClose,
  onSave,
  onArchive,
  onRestore,
  onRestoreRevision,
}: EntryDetailProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [type, setType] = useState<EntryType>(entry.type);
  const [errors, setErrors] = useState<{ title?: string; content?: string }>({});
  const [saving, setSaving] = useState(false);
  const Icon = TYPE_ICON[entry.type];
  const latest = entry.revisions[0];
  const unchanged =
    title.trim() === entry.title && content.trim() === entry.content && type === entry.type;

  const startEdit = () => {
    setTitle(entry.title);
    setContent(entry.content);
    setType(entry.type);
    setErrors({});
    setEditing(true);
  };

  const save = async () => {
    const next = {
      title: title.trim() ? undefined : "Add a title.",
      content: content.trim() ? undefined : "Add what agents should know.",
    };
    setErrors(next);
    if (next.title || next.content) return;
    setSaving(true);
    try {
      await onSave(entry, { title: title.trim(), content: content.trim(), type });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // One version is the entry itself; History appears once there's something to go back to.
  const showHistory = entry.revisions.length > 1;
  const historySummary = latest
    ? `${entry.revisions.length} versions · last by ${latest.author}`
    : undefined;

  return (
    <>
      <DetailHeader
        leading={<LogoTile icon={<Icon />} name={TYPE_LABEL[entry.type]} />}
        title={entry.title}
        subtitle={`${TYPE_LABEL[entry.type]} · ${scopeWords(organizationWord)[entry.scope]}`}
        status={
          entry.status === "published" ? undefined : (
            <StatusBadge variant={picks.status.header} tone="neutral" icon={<ArchiveIcon />}>
              {entry.status === "archived" ? "Archived" : "Rejected"}
            </StatusBadge>
          )
        }
      />
      <DetailBody>
        <DetailSection>
          {editing ? (
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
                <TextArea
                  rows={5}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
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
          ) : (
            <p className="text-sm leading-6 text-pretty whitespace-pre-line text-fg">
              {entry.content}
            </p>
          )}
        </DetailSection>
        <DetailSection title="Details">
          <DetailFacts>
            <DetailFact label="Where">{whereLabel(entry.scope, organizationWord)}</DetailFact>
            <DetailFact label="Collection">
              {entry.collection ?? <span className="text-fg-muted">None</span>}
            </DetailFact>
            <DetailFact label="Last updated">
              <RelativeTime date={entry.updatedAt} now={KIT_NOW} timeZone={KIT_TIME_ZONE} /> by{" "}
              {entry.author}
            </DetailFact>
          </DetailFacts>
        </DetailSection>
        {entry.source ? (
          <DetailSection title="Source">
            <div className="flex min-w-0 items-center gap-3">
              <LogoTile
                size="md"
                icon={entry.source.kind === "file" ? <FileTextIcon /> : <MessageSquareIcon />}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-5 font-medium text-fg">
                  {entry.source.name}
                </p>
                <p className="truncate text-xs leading-4.5 text-fg-muted">
                  {entry.source.kind === "file" ? "PDF · 3 pages · Added by Bendik Hansen" : "Chat"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => toast(`Opened ${entry.source?.name}`)}
                className="shrink-0 pointer-coarse:h-11"
              >
                Open
              </Button>
            </div>
          </DetailSection>
        ) : null}
        {showHistory ? (
        <DetailSection>
          <Disclosure
            variant={picks.disclosure}
            // The body already draws hairlines between sections.
            className={picks.disclosure === "inline" ? "border-y-0" : undefined}
            title="History"
            summary={historySummary}
            sheetDescription={entry.title}
          >
            <RevisionHistory
              revisions={entry.revisions}
              now={KIT_NOW}
              format="text"
              label={`History of ${entry.title}`}
              onRestore={(revision) => onRestoreRevision(entry, revision)}
            />
          </Disclosure>
        </DetailSection>
        ) : null}
      </DetailBody>
      {editing ? (
        <DetailFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={saving}
            className="pointer-coarse:h-11"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={unchanged || saving}
            className="pointer-coarse:h-11"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DetailFooter>
      ) : (
        <DetailFooter
          start={
            entry.status === "published" ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onArchive(entry)}
                className="-ml-3 text-fg-muted pointer-coarse:h-11"
              >
                <ArchiveIcon aria-hidden="true" />
                Archive
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onRestore(entry)}
                className="-ml-3 text-fg-muted pointer-coarse:h-11"
              >
                <ArchiveRestoreIcon aria-hidden="true" />
                Restore
              </Button>
            )
          }
        >
          {picks.detail === "sheet" ? (
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="pointer-coarse:h-11"
            >
              Done
            </Button>
          ) : null}
          <Button type="button" onClick={startEdit} className="pointer-coarse:h-11">
            Edit
          </Button>
        </DetailFooter>
      )}
    </>
  );
}

/** The entry in the picked presentation. Page and inline are placed by the caller. */
export function EntryDetail(
  props: EntryDetailProps & { presentation: "sheet" | "page" | "inline" },
) {
  const { presentation, ...rest } = props;
  // Remount per entry so an edit in progress never leaks into another entry.
  const parts = <EntryDetailParts key={rest.entry.id} {...rest} />;
  if (presentation === "page") {
    return (
      <DetailPage
        back={{ label: "Knowledge", onClick: rest.onClose }}
        className="px-0 pt-0 max-sm:px-0"
      >
        {parts}
      </DetailPage>
    );
  }
  if (presentation === "inline") {
    return <DetailInline className="mt-2 mb-3">{parts}</DetailInline>;
  }
  return parts;
}

/** The sheet shell, kept mounted so it can animate closed. */
export function EntrySheet({
  entry,
  open,
  onOpenChange,
  children,
}: {
  entry: LibraryEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DetailSheet open={open && entry !== null} onOpenChange={onOpenChange}>
      {entry ? <DetailSheetContent>{children}</DetailSheetContent> : null}
    </DetailSheet>
  );
}
