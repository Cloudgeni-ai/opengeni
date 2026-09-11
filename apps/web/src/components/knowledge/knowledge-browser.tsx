import { KnowledgeReviewGroups } from "./knowledge-review-groups";
import { KnowledgeOriginalFile } from "./knowledge-original-file";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import type {
  KnowledgeEntryContent,
  KnowledgeEntryKind,
  KnowledgeEntryListRequest,
  KnowledgeEntryRecord,
  KnowledgeEntryScope,
  KnowledgeEntrySummary,
  KnowledgeReviewBatch,
} from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, FileTextIcon, FolderIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MetaChip } from "@/components/ui/meta-chip";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { BehaviorReviews } from "./behavior-reviews";
import { KNOWLEDGE_KIND_LABEL as KIND, KNOWLEDGE_KIND_HELP } from "./knowledge-labels";
import { FormDisclosure } from "@/components/ui/form-disclosure";

const SOURCE: Record<string, string> = {
  file: "File",
  slack: "Slack",
  conversation: "Conversation",
  repository: "Codebase",
  web: "Web",
  connector: "Connected source",
  manual: "Added directly",
  task_note: "Task note",
};
type View = "published" | "needs_review" | "archived";
type Selection = { id: string; revisionId?: string; view?: View };
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
function externalUrl(value?: string) {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function KnowledgeBrowser({
  workspaceId,
  personal = false,
  focusEntryId,
  fileId,
  initialKind,
  initialScope,
  sourceOnly = false,
}: {
  workspaceId: string;
  personal?: boolean;
  focusEntryId?: string;
  fileId?: string;
  initialKind?: KnowledgeEntryKind;
  initialScope?: KnowledgeEntryScope;
  sourceOnly?: boolean;
}) {
  const context = useAppContext();
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "documents:manage");
  const [reviewGroup, setReviewGroup] = useState<KnowledgeReviewBatch | null>(null);
  const [view, setView] = useState<View>("published");
  const [scope, setScope] = useState<KnowledgeEntryScope | "all">(
    initialScope ?? (personal ? "personal" : "all"),
  );
  const [kind, setKind] = useState<KnowledgeEntryKind | "all">(initialKind ?? "all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<{ id: string; title: string } | null>(null);
  const fileFilter = group ? undefined : fileId;
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(
    focusEntryId ? { id: focusEntryId } : null,
  );
  const [creating, setCreating] = useState<"note" | "group" | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copying, setCopying] = useState<KnowledgeEntryRecord | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const request: KnowledgeEntryListRequest = {
    view,
    limit: 50,
    ...(scope !== "all" ? { scope } : {}),
    ...(sourceOnly ? { kind: "source" as const } : kind !== "all" ? { kind } : {}),
    ...(group ? { groupId: group.id } : {}),
    ...(fileFilter ? { fileId: fileFilter } : {}),
    ...(search ? { query: search } : {}),
    ...(view === "needs_review" && reviewGroup ? { reviewBatchId: reviewGroup.id } : {}),
  };
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setEntries([]);
    setCursor(null);
    setError(null);
    setSelected(new Set());
    if (view === "needs_review" && !reviewGroup) {
      setLoading(false);
      return () => {
        current = false;
      };
    }
    void context.client
      .listKnowledgeEntries(workspaceId, JSON.parse(requestKey))
      .then((result) => {
        if (current) {
          setEntries(result.entries);
          setCursor(result.nextCursor);
        }
      })
      .catch((reason) => {
        if (current) setError(message(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, requestKey, refresh, view, reviewGroup]);
  async function loadMore() {
    if (!cursor || loading) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    setLoading(true);
    try {
      const result = await context.client.listKnowledgeEntries(workspaceId, { ...request, cursor });
      if (context.ownsWorkspaceInvocation(workspaceId, invocation)) {
        setEntries((prior) => [...prior, ...result.entries]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }
  async function review(decision: "approve" | "reject", all = false) {
    const chosen = all ? entries : entries.filter((entry) => selected.has(entry.id));
    if (!chosen.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await context.client.reviewKnowledgeEntries(workspaceId, {
        entries: chosen.map((entry) => ({
          operationId: crypto.randomUUID(),
          entryId: entry.id,
          revisionId: entry.revision.id,
          expectedVersion: entry.version,
          decision,
        })),
      });
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  function openGroup(entry: { id: string; title: string }) {
    setGroup(entry);
    setKind("all");
    setView("published");
    setQuery("");
    setSearch("");
    setSelection(null);
  }
  return (
    <div className="grid gap-5">
      {fileFilter ? (
        <div className="flex items-center gap-3 text-sm text-fg-muted">
          <span>Knowledge related to this file</span>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/workspaces/$workspaceId/state" params={{ workspaceId }} search={{}}>
              Show all knowledge
            </Link>
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {view !== "needs_review" || reviewGroup ? (
          <form
            className="flex min-w-48 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query);
            }}
          >
            <Input
              aria-label="Search knowledge"
              value={query}
              placeholder="Search knowledge"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="submit" variant="outline" size="icon" aria-label="Search">
              <SearchIcon className="size-4" />
            </Button>
          </form>
        ) : null}
        {!sourceOnly ? (
          <Select
            aria-label="Knowledge scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              setReviewGroup(null);
            }}
          >
            <option value="all">All available knowledge</option>
            <option value="workspace">Workspace</option>
            <option value="personal">Only me</option>
            <option value="organization">Company</option>
          </Select>
        ) : null}
        {!sourceOnly && (view !== "needs_review" || reviewGroup) ? (
          <Button
            variant="ghost"
            aria-expanded={filtersOpen}
            aria-controls="knowledge-type-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {kind === "all" ? "Filter by type" : `Type: ${KIND[kind]}`}
          </Button>
        ) : null}
        {canEdit && !sourceOnly ? (
          <>
            <Button variant="outline" onClick={() => setCreating("note")}>
              <PlusIcon className="size-4" />
              Add knowledge
            </Button>
            <Button variant="ghost" onClick={() => setCreating("group")}>
              <FolderIcon className="size-4" />
              New collection
            </Button>
          </>
        ) : null}
      </div>
      {filtersOpen && !sourceOnly && (view !== "needs_review" || reviewGroup) ? (
        <div id="knowledge-type-filters" className="grid gap-2 sm:max-w-md">
          <Select
            aria-label="Knowledge type"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="all">All types</option>
            {Object.entries(KIND).map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </Select>
          <p className="text-xs text-fg-muted">
            {kind === "all"
              ? "Agents choose a type to describe the content. All types are searchable together."
              : KNOWLEDGE_KIND_HELP[kind]}
          </p>
        </div>
      ) : null}
      {group ? (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setGroup(null)}>
            <ArrowLeftIcon className="size-4" />
            All knowledge
          </Button>
          <h2 className="text-base font-medium">{group.title}</h2>
        </div>
      ) : null}
      <Tabs
        value={view}
        onValueChange={(value) => {
          setView(value as View);
          setReviewGroup(null);
          setQuery("");
          setSearch("");
          setKind("all");
          setGroup(null);
        }}
      >
        <TabsList aria-label="Knowledge status">
          <TabsTrigger value="published">Saved</TabsTrigger>
          {!sourceOnly ? <TabsTrigger value="needs_review">Needs review</TabsTrigger> : null}
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
        {(["published", "needs_review", "archived"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            {tab === "needs_review" ? (
              <div className="mb-4 grid gap-3">
                {!reviewGroup ? (
                  <BehaviorReviews workspaceId={workspaceId} />
                ) : (
                  <div className="flex items-center gap-3">
                    <Button variant="ghost" size="sm" onClick={() => setReviewGroup(null)}>
                      <ArrowLeftIcon className="size-4" />
                      All reviews
                    </Button>
                    <h2 className="text-sm font-medium">
                      {reviewGroup.title ?? "Saved knowledge"}
                    </h2>
                  </div>
                )}
                <p className="text-sm text-fg-muted">
                  These changes are saved for review. Agents continue working; previously published
                  knowledge remains available.
                </p>
                {!reviewGroup && canEdit ? (
                  <KnowledgeReviewGroups
                    workspaceId={workspaceId}
                    scope={scope === "all" ? undefined : scope}
                    refresh={refresh}
                    onSelect={setReviewGroup}
                  />
                ) : null}
                {canEdit && reviewGroup && entries.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setSelected(new Set(entries.slice(0, 100).map((entry) => entry.id)))
                      }
                    >
                      {entries.length > 100 ? "Select first 100" : "Select loaded changes"}
                    </Button>
                    {!cursor && entries.length <= 100 && kind === "all" && !search ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void review("approve", true)}
                      >
                        Approve all ({entries.length})
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      disabled={busy || !selected.size}
                      onClick={() => void review("approve")}
                    >
                      Approve selected ({selected.size})
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !selected.size}
                      onClick={() => void review("reject")}
                    >
                      Reject selected
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="mb-3 text-sm text-status-error">
                {error}
                <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
                  Refresh
                </Button>
              </p>
            ) : null}
            <div className="divide-y divide-border border-y border-border">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 py-4">
                  {tab === "needs_review" && canEdit ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.revision.title}`}
                      className="mt-1 size-4"
                      checked={selected.has(entry.id)}
                      disabled={busy || (!selected.has(entry.id) && selected.size >= 100)}
                      onChange={(event) => {
                        setSelected((prior) => {
                          const next = new Set(prior);
                          if (event.target.checked) next.add(entry.id);
                          else next.delete(entry.id);
                          return next;
                        });
                      }}
                    />
                  ) : null}
                  {entry.revision.kind === "group" ? (
                    <FolderIcon className="mt-1 size-4 shrink-0 text-fg-muted" />
                  ) : (
                    <FileTextIcon className="mt-1 size-4 shrink-0 text-fg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="text-left text-sm font-medium hover:underline"
                      onClick={() =>
                        entry.revision.kind === "group" && tab === "published"
                          ? openGroup({ id: entry.id, title: entry.revision.title })
                          : setSelection({ id: entry.id, view: tab })
                      }
                    >
                      {entry.revision.title}
                    </button>
                    <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-fg-muted">
                      {entry.excerpts[0]?.text ?? entry.revision.preview}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {entry.revision.kind === "group" || entry.revision.kind === "source" ? (
                        <MetaChip>{KIND[entry.revision.kind]}</MetaChip>
                      ) : null}
                      <MetaChip>
                        {entry.scope === "personal"
                          ? "Only me"
                          : entry.scope === "organization"
                            ? "Company"
                            : "Workspace"}
                      </MetaChip>
                      {entry.revision.sourceKind ? (
                        <MetaChip>{SOURCE[entry.revision.sourceKind]}</MetaChip>
                      ) : null}
                      {entry.revision.change === "archive" ? (
                        <MetaChip>Archive requested</MetaChip>
                      ) : null}
                      <span className="text-xs text-fg-subtle">
                        {relativeTimeLabel(entry.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelection({ id: entry.id, view: tab })}
                  >
                    Inspect
                  </Button>
                </div>
              ))}
            </div>
            {loading ? (
              <p role="status" className="py-6 text-sm text-fg-muted">
                Loading knowledge…
              </p>
            ) : !entries.length && !error && (tab !== "needs_review" || reviewGroup) ? (
              <p className="py-8 text-sm text-fg-muted">
                {tab === "needs_review"
                  ? "Nothing needs review."
                  : tab === "archived"
                    ? "No archived knowledge."
                    : "No knowledge matches this view. Useful findings retained by agents will appear here."}
              </p>
            ) : null}
            {cursor ? (
              <Button
                variant="outline"
                className="mt-4"
                disabled={loading}
                onClick={() => void loadMore()}
              >
                Load more
              </Button>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
      <Sheet
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto bg-bg sm:max-w-2xl">
          {selection ? (
            <KnowledgeInspector
              key={`${selection.id}:${selection.revisionId ?? selection.view ?? "published"}`}
              workspaceId={workspaceId}
              selection={selection}
              canEdit={canEdit}
              onOpen={setSelection}
              onGroup={openGroup}
              onCopy={(entry) => {
                setSelection(null);
                setCopying(entry);
              }}
              onChanged={() => setRefresh((n) => n + 1)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      {copying ? (
        <CopyKnowledgeDialog
          key={copying.id}
          record={copying}
          workspaceId={workspaceId}
          onClose={() => setCopying(null)}
          onSaved={() => {
            setCopying(null);
            setRefresh((value) => value + 1);
          }}
        />
      ) : null}
      <Dialog
        open={creating !== null}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{creating === "group" ? "New collection" : "Add knowledge"}</DialogTitle>
            <DialogDescription>
              {creating === "group"
                ? "Collect related knowledge about a customer, product, system, or subject."
                : "Write what is useful to remember. You can organize or correct it later."}
            </DialogDescription>
          </DialogHeader>
          <KnowledgeEditor
            key={creating}
            workspaceId={workspaceId}
            scope={scope === "all" ? (personal ? "personal" : "workspace") : scope}
            initial={{
              title: "",
              kind: creating ?? "note",
              content: "",
              evidence: [],
              relationships: [],
              groupIds: group ? [group.id] : [],
            }}
            onSave={async (entry) => {
              await context.client.saveKnowledgeEntry(workspaceId, {
                operationId: crypto.randomUUID(),
                entryId: crypto.randomUUID(),
                expectedVersion: 0,
                scope: scope === "all" ? (personal ? "personal" : "workspace") : scope,
                entry,
              });
              setCreating(null);
              setRefresh((n) => n + 1);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CopyKnowledgeDialog({
  record,
  workspaceId,
  onClose,
  onSaved,
}: {
  record: KnowledgeEntryRecord;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const context = useAppContext();
  const targets = context.workspaces.filter(
    (workspace) =>
      workspace.kind !== "personal" &&
      hasWorkspacePermission(context.accessContext, workspace.id, "documents:manage"),
  );
  const [target, setTarget] = useState(
    () => targets.find((workspace) => workspace.id === workspaceId)?.id ?? targets[0]?.id ?? "",
  );
  const [entryId] = useState(() => crypto.randomUUID());
  const text = record.revision.entry;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy text to workspace</DialogTitle>
          <DialogDescription>
            Creates a separate entry everyone with Knowledge access in the selected workspace can
            read. Review the text below. Original files, private evidence and private groups are not
            included.
          </DialogDescription>
        </DialogHeader>
        {targets.length ? (
          <>
            <label className="grid gap-1 text-sm">
              Workspace
              <Select value={target} onChange={(event) => setTarget(event.target.value)}>
                {targets.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </Select>
            </label>
            <KnowledgeEditor
              key={target}
              workspaceId={target}
              scope="workspace"
              initial={{
                title: text.title,
                kind: text.kind,
                content: text.content,
                source: { kind: "manual" },
                evidence: [],
                relationships: [],
                groupIds: [],
              }}
              onCancel={onClose}
              onSave={async (entry) => {
                await context.client.saveKnowledgeEntry(target, {
                  operationId: crypto.randomUUID(),
                  entryId,
                  expectedVersion: 0,
                  scope: "workspace",
                  entry,
                });
                onSaved();
              }}
            />
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            You need Knowledge management access in a shared workspace to copy this entry.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function KnowledgeInspector(props: {
  workspaceId: string;
  selection: Selection;
  canEdit: boolean;
  onOpen: (selection: Selection) => void;
  onGroup: (group: { id: string; title: string }) => void;
  onChanged: () => void;
  onCopy: (record: KnowledgeEntryRecord) => void;
}) {
  const { client } = useAppContext();
  const [record, setRecord] = useState<KnowledgeEntryRecord | null>(null);
  const [history, setHistory] = useState<KnowledgeEntrySummary[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setRecord(null);
    setError(null);
    void (async () => {
      try {
        return await client.getKnowledgeEntry(props.workspaceId, props.selection.id, {
          ...(props.selection.revisionId ? { revisionId: props.selection.revisionId } : {}),
          ...(props.selection.view ? { view: props.selection.view } : {}),
        });
      } catch (reason) {
        // Related entries normally open their published content. A reviewer
        // may also follow a link to an entry whose first revision is pending.
        if (
          !props.selection.view &&
          !props.selection.revisionId &&
          props.canEdit &&
          reason instanceof OpenGeniApiError &&
          reason.status === 404
        )
          return client.getKnowledgeEntry(props.workspaceId, props.selection.id, {
            view: "needs_review",
          });
        throw reason;
      }
    })()
      .then((entry) => {
        if (current) setRecord(entry);
      })
      .catch((reason) => {
        if (current) setError(message(reason));
      });
    return () => {
      current = false;
    };
  }, [
    client,
    props.workspaceId,
    props.selection.id,
    props.selection.revisionId,
    props.selection.view,
    props.canEdit,
    refresh,
  ]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setEditing(false);
      props.onChanged();
      setRefresh((n) => n + 1);
      const outcome =
        result && typeof result === "object" && "outcome" in result ? result.outcome : null;
      props.onOpen(
        outcome === "archived"
          ? { id: props.selection.id, view: "archived" }
          : outcome === "rejected" && record
            ? { id: record.id, revisionId: record.revision.id }
            : { id: props.selection.id, view: "published" },
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function loadHistory(more = false) {
    setBusy(true);
    setError(null);
    try {
      const result = await client.listKnowledgeEntryHistory(
        props.workspaceId,
        props.selection.id,
        more && before ? before : undefined,
      );
      setHistory((prior) => (more ? [...prior, ...result.entries] : result.entries));
      setBefore(result.beforeRevision);
      setHistoryOpen(true);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const entry = record?.revision.entry;
  const pending = record?.revision.outcome === "pending";
  const historical = record && !pending && record.revision.id !== record.publishedRevisionId;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{entry?.title ?? "Knowledge entry"}</SheetTitle>
        <SheetDescription>
          {record
            ? `${KIND[record.revision.entry.kind]} · Revision ${record.revision.number} · ${record.scope === "personal" ? "Only me" : record.scope === "organization" ? "Company" : "Workspace"}`
            : "Loading entry…"}
        </SheetDescription>
      </SheetHeader>
      <div className="grid gap-5 px-4 pb-6">
        {error ? (
          <p role="alert" className="text-sm text-status-error">
            {error}
            <Button variant="ghost" onClick={() => setRefresh((n) => n + 1)}>
              Retry
            </Button>
          </p>
        ) : null}
        {record && entry ? (
          <>
            <p className="text-xs text-fg-muted">{KNOWLEDGE_KIND_HELP[entry.kind]}</p>
            {pending ? (
              <p className="text-sm text-fg-muted">
                {record.revision.change === "archive"
                  ? "Archive request awaiting review."
                  : "This proposal is awaiting review and is not used by future tasks."}
              </p>
            ) : null}
            {record.revision.outcome === "rejected" ? (
              <p className="text-sm text-fg-muted">
                This proposal was rejected. It remains in history and is not used by agents.
              </p>
            ) : historical ? (
              <p className="text-sm text-fg-muted">You are viewing an earlier revision.</p>
            ) : null}
            {editing ? (
              <KnowledgeEditor
                workspaceId={props.workspaceId}
                scope={record.scope}
                initial={entry}
                submitLabel={pending ? "Save and approve" : "Save"}
                onCancel={() => setEditing(false)}
                onSave={async (updated) => {
                  if (pending)
                    await client.reviewKnowledgeEntry(props.workspaceId, {
                      operationId: crypto.randomUUID(),
                      entryId: record.id,
                      revisionId: record.revision.id,
                      expectedVersion: record.version,
                      decision: "approve",
                      entry: updated,
                    });
                  else
                    await client.saveKnowledgeEntry(props.workspaceId, {
                      operationId: crypto.randomUUID(),
                      entryId: record.id,
                      expectedVersion: record.version,
                      entry: updated,
                    });
                  setEditing(false);
                  props.onChanged();
                  setRefresh((n) => n + 1);
                  props.onOpen({ id: record.id, view: "published" });
                }}
              />
            ) : (
              <div className="whitespace-pre-wrap break-words text-sm leading-6">
                {entry.content || "This collection brings together related knowledge."}
              </div>
            )}
            {entry.source ? (
              <section className="grid gap-2 border-t border-border pt-4">
                <h3 className="text-sm font-medium">Source</h3>
                <p className="text-sm text-fg-muted">
                  {SOURCE[entry.source.kind]}
                  {entry.source.retention === "passages"
                    ? " · Retained passages"
                    : entry.source.retention === "full_text"
                      ? " · Retained text"
                      : ""}
                </p>
                {externalUrl(entry.source.uri) ? (
                  <a
                    href={externalUrl(entry.source.uri)!}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-brand hover:underline"
                  >
                    Open original source
                  </a>
                ) : null}
                {entry.source.fileId ? (
                  <KnowledgeOriginalFile
                    key={`${record.id}:${record.revision.id}`}
                    workspaceId={props.workspaceId}
                    entryId={record.id}
                    revisionId={record.revision.id}
                  />
                ) : null}
              </section>
            ) : null}
            {entry.evidence.length ? (
              <section className="grid gap-3 border-t border-border pt-4">
                <h3 className="text-sm font-medium">Supporting information</h3>
                {entry.evidence.map((evidence) => (
                  <div key={JSON.stringify(evidence)} className="grid gap-1">
                    {evidence.quote ? (
                      <blockquote className="border-l-2 border-border pl-3 text-sm text-fg-muted">
                        {evidence.quote}
                      </blockquote>
                    ) : null}
                    <KnowledgeReference
                      workspaceId={props.workspaceId}
                      id={evidence.entryId}
                      revisionId={evidence.revisionId}
                      onClick={() =>
                        props.onOpen({ id: evidence.entryId, revisionId: evidence.revisionId })
                      }
                    />
                    {evidence.location.page ? (
                      <span className="text-xs text-fg-subtle">Page {evidence.location.page}</span>
                    ) : null}
                  </div>
                ))}
              </section>
            ) : null}
            {entry.groupIds.length ? (
              <section className="grid gap-2 border-t border-border pt-4">
                <h3 className="text-sm font-medium">Collections</h3>
                {entry.groupIds.map((id) => (
                  <KnowledgeReference
                    key={id}
                    workspaceId={props.workspaceId}
                    id={id}
                    onClick={(title) => props.onGroup({ id, title })}
                  />
                ))}
              </section>
            ) : null}
            {entry.relationships.length ? (
              <section className="grid gap-2 border-t border-border pt-4">
                <h3 className="text-sm font-medium">Related knowledge</h3>
                {entry.relationships.map((relation) => (
                  <div key={`${relation.entryId}:${relation.relation}`}>
                    <span className="mr-2 text-xs text-fg-subtle">
                      {relation.relation.replaceAll("_", " ")}
                    </span>
                    <KnowledgeReference
                      workspaceId={props.workspaceId}
                      id={relation.entryId}
                      onClick={() => props.onOpen({ id: relation.entryId })}
                    />
                  </div>
                ))}
              </section>
            ) : null}
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {props.canEdit && !editing && !historical ? (
                <>
                  {!record.archived && record.revision.change !== "archive" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditing(true)}
                    >
                      {pending ? "Edit and approve" : "Edit knowledge"}
                    </Button>
                  ) : null}
                  {record.scope === "personal" &&
                  !record.archived &&
                  !pending &&
                  entry.kind !== "group" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => props.onCopy(record)}
                    >
                      Copy text to workspace
                    </Button>
                  ) : null}
                  {pending ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void mutate(() =>
                            client.reviewKnowledgeEntry(props.workspaceId, {
                              operationId: crypto.randomUUID(),
                              entryId: record.id,
                              revisionId: record.revision.id,
                              expectedVersion: record.version,
                              decision: "approve",
                            }),
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void mutate(() =>
                            client.reviewKnowledgeEntry(props.workspaceId, {
                              operationId: crypto.randomUUID(),
                              entryId: record.id,
                              revisionId: record.revision.id,
                              expectedVersion: record.version,
                              decision: "reject",
                            }),
                          )
                        }
                      >
                        Reject
                      </Button>
                    </>
                  ) : !record.archived ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          client.archiveKnowledgeEntry(props.workspaceId, record.id, {
                            operationId: crypto.randomUUID(),
                            expectedVersion: record.version,
                          }),
                        )
                      }
                    >
                      Archive
                    </Button>
                  ) : null}
                </>
              ) : null}
              {(historical || record.archived) && props.canEdit ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      client.restoreKnowledgeEntry(props.workspaceId, {
                        operationId: crypto.randomUUID(),
                        entryId: record.id,
                        revisionId: record.revision.id,
                        expectedVersion: record.version,
                      }),
                    )
                  }
                >
                  Restore this revision
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadHistory()}>
                History
              </Button>
            </div>
            {historyOpen ? (
              <section className="grid gap-2">
                <h3 className="text-sm font-medium">Revision history</h3>
                {history.map((item) => (
                  <button
                    key={item.revision.id}
                    className="text-left text-sm text-fg-muted hover:text-fg"
                    onClick={() => props.onOpen({ id: item.id, revisionId: item.revision.id })}
                  >
                    Revision {item.revision.number} · {item.revision.outcome} ·{" "}
                    {relativeTimeLabel(item.revision.createdAt)}
                  </button>
                ))}
                {before ? (
                  <Button variant="ghost" disabled={busy} onClick={() => void loadHistory(true)}>
                    Earlier revisions
                  </Button>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

function KnowledgeReference(props: {
  workspaceId: string;
  id: string;
  revisionId?: string;
  onClick: (title: string) => void;
}) {
  const { client } = useAppContext();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client
      .getKnowledgeEntry(
        props.workspaceId,
        props.id,
        props.revisionId ? { revisionId: props.revisionId } : {},
      )
      .then((record) => {
        if (current) setTitle(record.revision.entry.title);
      })
      .catch(() => {
        if (current) setTitle(null);
      });
    return () => {
      current = false;
    };
  }, [client, props.workspaceId, props.id, props.revisionId]);
  return title ? (
    <button
      className="text-left text-sm text-brand hover:underline"
      onClick={() => props.onClick(title)}
    >
      {title}
    </button>
  ) : (
    <span className="text-sm text-fg-muted">Linked entry unavailable</span>
  );
}

function KnowledgeEditor(props: {
  workspaceId: string;
  scope: KnowledgeEntryScope;
  initial: KnowledgeEntryContent;
  onSave: (entry: KnowledgeEntryContent) => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const { client } = useAppContext();
  const [draft, setDraft] = useState(props.initial);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<KnowledgeEntrySummary[]>([]);
  const [groupQuery, setGroupQuery] = useState("");
  useEffect(() => {
    let current = true;
    void client
      .listKnowledgeEntries(props.workspaceId, {
        kind: "group",
        scope: props.scope,
        query: groupQuery,
        limit: 50,
      })
      .then((result) => {
        if (current) setGroups(result.entries);
      })
      .catch((reason) => {
        if (current) setError(message(reason));
      });
    return () => {
      current = false;
    };
  }, [client, props.workspaceId, props.scope, groupQuery]);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void props
          .onSave(draft)
          .catch((reason) => setError(message(reason)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="grid gap-1 text-sm">
        Title
        <Input
          value={draft.title}
          maxLength={1024}
          required
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <label className="grid gap-1 text-sm">
        Content
        <Textarea
          className="min-h-40"
          value={draft.content}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, content: event.target.value })}
        />
      </label>
      <FormDisclosure
        title="More options"
        summary={
          draft.kind === "note"
            ? "Choose a type or add to collections"
            : `${KIND[draft.kind]} · Collections`
        }
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
      >
        <label className="grid gap-1 text-sm">
          Type
          <Select
            value={draft.kind}
            disabled={busy || draft.kind === "source"}
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value as KnowledgeEntryKind })
            }
          >
            {Object.entries(KIND)
              .filter(([key]) => key !== "source" || draft.kind === "source")
              .map(([key, title]) => (
                <option key={key} value={key}>
                  {title}
                </option>
              ))}
          </Select>
        </label>
        <p className="text-xs text-fg-muted">{KNOWLEDGE_KIND_HELP[draft.kind]}</p>
        <fieldset disabled={busy} className="grid gap-2">
          <legend className="mb-2 text-sm font-medium">Collections</legend>
          <Input
            aria-label="Find collections"
            value={groupQuery}
            placeholder="Find a collection"
            onChange={(event) => setGroupQuery(event.target.value)}
          />
          <div className="max-h-40 overflow-y-auto">
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={draft.groupIds.includes(group.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      groupIds: event.target.checked
                        ? [...draft.groupIds, group.id]
                        : draft.groupIds.filter((id) => id !== group.id),
                    })
                  }
                />
                {group.revision.title}
              </label>
            ))}
          </div>
        </fieldset>
      </FormDisclosure>
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !draft.title.trim()}>
          {busy ? "Saving…" : (props.submitLabel ?? "Save")}
        </Button>
        {props.onCancel ? (
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
