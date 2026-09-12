import { notifyKnowledgeReviewUpdated } from "@/components/rail/use-knowledge-review-indicator";
import { firstReviewableEntry } from "./knowledge-review-order";
import { KnowledgeReviewSummary } from "./knowledge-review-summary";
import { KnowledgeEvidenceEditor } from "./knowledge-evidence-editor";
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
import {
  ArrowLeftIcon,
  FolderIcon,
  FileTextIcon,
  QuoteIcon,
  LinkIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAppContext } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { BehaviorReviews } from "./behavior-reviews";
import {
  KNOWLEDGE_KIND_LABEL as KIND,
  KNOWLEDGE_KIND_HELP,
  KNOWLEDGE_SOURCE_LABEL as SOURCE,
} from "./knowledge-labels";
import { KnowledgeTree, KnowledgeRow, type KnowledgeCollection } from "./knowledge-tree";
import { FormDisclosure } from "@/components/ui/form-disclosure";

type View = "published" | "needs_review" | "archived" | "rejected";
type Selection = { id: string; revisionId?: string; view?: View; requiredFor?: string };
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
  initialReview = false,
}: {
  workspaceId: string;
  personal?: boolean;
  focusEntryId?: string;
  fileId?: string;
  initialKind?: KnowledgeEntryKind;
  initialScope?: KnowledgeEntryScope;
  sourceOnly?: boolean;
  initialReview?: boolean;
}) {
  const context = useAppContext();
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "documents:manage");
  const workspace = context.workspaces.find((item) => item.id === workspaceId);
  const canWriteOrganization = Boolean(
    workspace && hasAccountPermission(context.accessContext, workspace.accountId, "account:admin"),
  );
  const [reviewGroup, setReviewGroup] = useState<KnowledgeReviewBatch | null>(null);
  const [view, setView] = useState<View>(initialReview ? "needs_review" : "published");
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
  const [trail, setTrail] = useState<Selection[]>([]);
  const startReview = useRef<string | null>(null);
  const [reviewTransition, setReviewTransition] = useState(false);
  const reviewPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (view === "needs_review" && selection) {
      reviewPanel.current?.focus();
      reviewPanel.current?.scrollIntoView({ block: "start" });
    }
  }, [view, selection]);
  const [bulkReview, setBulkReview] = useState(false);
  function openRelated(next: Selection) {
    if (selection) setTrail((prior) => [...prior, selection]);
    setSelection(next);
  }
  function beginReview(batch: KnowledgeReviewBatch) {
    setKind("all");
    setQuery("");
    setSearch("");
    setGroup(null);
    setEntries([]);
    setTrail([]);
    setBulkReview(false);
    setReviewGroup(batch);
    startReview.current = batch.id;
    setReviewTransition(true);
  }
  function finishReview() {
    notifyKnowledgeReviewUpdated();
    setKind("all");
    setQuery("");
    setSearch("");
    setTrail([]);
    setSelection(null);
    if (reviewGroup) {
      startReview.current = reviewGroup.id;
      setReviewTransition(true);
    }
    setRefresh((n) => n + 1);
  }
  const [creating, setCreating] = useState<"note" | "group" | null>(null);
  const [createParent, setCreateParent] = useState<KnowledgeCollection | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [copying, setCopying] = useState<KnowledgeEntryRecord | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const treeView = view === "published" && !sourceOnly && !fileFilter && !search && kind === "all";
  const createScope =
    createParent?.scope ?? (scope === "all" ? (personal ? "personal" : "workspace") : scope);
  const request: KnowledgeEntryListRequest = {
    view,
    limit: 50,
    ...(scope !== "all" ? { scope } : {}),
    ...(sourceOnly ? { kind: "source" as const } : kind !== "all" ? { kind } : {}),
    ...(group ? { groupId: group.id } : treeView ? { rootOnly: true } : {}),
    ...(fileFilter ? { fileId: fileFilter } : {}),
    ...(search ? { query: search } : {}),
    ...(view === "needs_review" && reviewGroup ? { reviewBatchId: reviewGroup.id } : {}),
  };
  const requestKey = JSON.stringify(request);
  const requestGeneration = useRef(0);
  useEffect(() => {
    let current = true;
    ++requestGeneration.current;
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
      .then(async (result) => {
        if (current) {
          setEntries(result.entries);
          setCursor(result.nextCursor);
          if (startReview.current && reviewGroup?.id === startReview.current) {
            const first = result.entries[0]
              ? await firstReviewableEntry(result.entries[0].id, (id, options) =>
                  context.client.getKnowledgeEntry(workspaceId, id, options),
                )
              : null;
            if (!current || startReview.current !== reviewGroup.id) return;
            startReview.current = null;
            setReviewTransition(false);
            if (first)
              setSelection({
                id: first.id,
                view: "needs_review",
                ...(first.id !== result.entries[0]?.id
                  ? { requiredFor: result.entries[0]?.revision.title }
                  : {}),
              });
            else setReviewGroup(null);
          }
        }
      })
      .catch((reason) => {
        if (current) {
          setError(message(reason));
          setReviewTransition(false);
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate pending pages on unmount
      ++requestGeneration.current;
    };
  }, [context.client, workspaceId, requestKey, refresh, view, reviewGroup]);
  async function loadMore() {
    if (!cursor || loading) return;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return;
    const generation = requestGeneration.current;
    const isCurrent = () =>
      generation === requestGeneration.current &&
      context.ownsWorkspaceInvocation(workspaceId, invocation);
    setLoading(true);
    try {
      const result = await context.client.listKnowledgeEntries(workspaceId, {
        ...request,
        cursor,
      });
      if (isCurrent()) {
        setEntries((prior) => [...prior, ...result.entries]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      if (isCurrent()) setError(message(reason));
    } finally {
      if (isCurrent()) setLoading(false);
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
      notifyKnowledgeReviewUpdated();
      setRefresh((value) => value + 1);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  function renderEntry(entry: KnowledgeEntrySummary, tab: View) {
    return (
      <div key={entry.id} className="flex min-w-0 items-center gap-2">
        {tab === "needs_review" && canEdit && bulkReview ? (
          <input
            type="checkbox"
            aria-label={`Select ${entry.revision.title}`}
            className="ml-2 size-4 shrink-0"
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
        <KnowledgeRow
          entry={entry}
          description={
            search
              ? (entry.excerpts[0]?.text ?? entry.revision.preview)
              : entry.revision.kind === "group"
                ? entry.revision.preview
                : undefined
          }
          onClick={() => {
            setTrail([]);
            setSelection({ id: entry.id, view: tab });
          }}
        />
      </div>
    );
  }
  function startCreating(entryKind: "note" | "group", parent: KnowledgeCollection | null = null) {
    setCreateParent(parent);
    setCreating(entryKind);
  }
  function openGroup(entry: { id: string; title: string }) {
    setGroup(entry);
    setKind("all");
    setView("published");
    setQuery("");
    setSearch("");
    setSelection(null);
  }
  const inlineReview = view === "needs_review" && (selection !== null || reviewTransition);
  const inspection = (
    <>
      {reviewTransition ? (
        <div>
          <h2 className="text-lg font-semibold">Review knowledge</h2>
          <p role="status" className="text-sm text-fg-muted">
            Loading next item…
          </p>
        </div>
      ) : null}
      {trail.length ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => {
            setSelection(trail.at(-1)!);
            setTrail((prior) => prior.slice(0, -1));
          }}
        >
          <ArrowLeftIcon className="size-4" />
          {trail.at(-1)?.view === "needs_review" ? "Back to review" : "Back"}
        </Button>
      ) : null}
      {selection?.requiredFor ? (
        <p className="text-sm text-fg-muted">
          Review this supporting change before “{selection.requiredFor}”.
        </p>
      ) : null}
      {selection ? (
        <KnowledgeInspector
          key={`${selection.id}:${selection.revisionId ?? selection.view ?? "published"}`}
          workspaceId={workspaceId}
          selection={selection}
          canEdit={canEdit}
          inline={inlineReview}
          onOpen={openRelated}
          onReplace={setSelection}
          onReviewed={finishReview}
          continueReview={Boolean(reviewGroup)}
          onGroup={(target) =>
            selection.view === "needs_review" || trail.length
              ? openRelated({ id: target.id })
              : openGroup(target)
          }
          onCopy={(entry) => {
            setSelection(null);
            setCopying(entry);
          }}
          onChanged={() => setRefresh((n) => n + 1)}
        />
      ) : null}
    </>
  );
  if (inlineReview) {
    return (
      <section
        ref={reviewPanel}
        tabIndex={-1}
        aria-label="Review knowledge"
        className="grid min-w-0 gap-6 outline-none"
      >
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelection(null);
              setTrail([]);
              setReviewGroup(null);
              startReview.current = null;
              setReviewTransition(false);
            }}
          >
            <ArrowLeftIcon className="size-4" />
            All reviews
          </Button>
          {reviewGroup?.title ? (
            <span className="truncate text-sm text-fg-muted">{reviewGroup.title}</span>
          ) : null}
        </div>
        <div className="grid min-w-0 items-start gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
          <nav aria-label="Pending knowledge" className="grid min-w-0 gap-2 md:sticky md:top-4">
            <h2 className="px-2 text-xs font-medium text-fg-muted">Needs review</h2>
            <div className="grid max-h-56 gap-1 overflow-y-auto md:max-h-[65vh]">
              {entries.map((item) => {
                const active = (trail[0]?.id ?? selection?.id) === item.id;
                return (
                  <button
                    key={item.id}
                    aria-current={active ? "true" : undefined}
                    className={`flex min-w-0 items-start gap-2 rounded-md border-l-2 px-3 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "border-brand bg-brand/10 text-fg" : "border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg"}`}
                    onClick={() => {
                      startReview.current = null;
                      setReviewTransition(false);
                      setTrail([]);
                      setSelection({ id: item.id, view: "needs_review" });
                    }}
                  >
                    {item.revision.kind === "group" ? (
                      <FolderIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    ) : (
                      <FileTextIcon className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="grid min-w-0 gap-1">
                      <span className="break-words font-medium">{item.revision.title}</span>
                      {item.revision.preview ? (
                        <span className="line-clamp-2 text-xs leading-5 text-fg-muted">
                          {item.revision.preview}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
              {loading && !entries.length ? (
                <p role="status" className="px-3 text-sm text-fg-muted">
                  Loading items…
                </p>
              ) : null}
              {cursor ? (
                <Button variant="ghost" disabled={loading} onClick={() => void loadMore()}>
                  Show more
                </Button>
              ) : null}
            </div>
          </nav>
          <div className="grid min-w-0 gap-5 border-t border-border pt-6 md:border-l md:border-t-0 md:pl-6 md:pt-0">
            {inspection}
          </div>
        </div>
      </section>
    );
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
            className="relative min-w-48 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query);
            }}
          >
            <Input
              aria-label="Search knowledge"
              className="pl-10"
              value={query}
              placeholder="Search knowledge"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="absolute inset-y-0 left-0"
              aria-label="Search"
            >
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
            size="icon"
            aria-label={kind === "all" ? "Filter knowledge" : `Filter knowledge: ${KIND[kind]}`}
            title="Filter knowledge"
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? "knowledge-type-filters" : undefined}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontalIcon className="size-4" />
          </Button>
        ) : null}
        {canEdit && !sourceOnly && (scope !== "organization" || canWriteOrganization) ? (
          <Button className="pointer-coarse:min-h-10" onClick={() => startCreating("note")}>
            <PlusIcon className="size-4" />
            Add knowledge
          </Button>
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
          {kind !== "all" ? (
            <p className="text-xs text-fg-muted">{KNOWLEDGE_KIND_HELP[kind]}</p>
          ) : null}
        </div>
      ) : null}
      {group ? (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setGroup(null)}>
            <ArrowLeftIcon className="size-4" />
            All knowledge
          </Button>
          <h2 className="min-w-0 flex-1 text-base font-semibold">{group.title}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelection({ id: group.id, view: "published" })}
          >
            Collection details
          </Button>
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
        <TabsList variant="line" aria-label="Knowledge status" className="gap-4 p-0">
          <TabsTrigger value="published" className="rounded-none border-0 px-0 shadow-none">
            All knowledge
          </TabsTrigger>
          {!sourceOnly ? (
            <TabsTrigger value="needs_review" className="rounded-none border-0 px-0 shadow-none">
              Needs review
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="archived" className="rounded-none border-0 px-0 shadow-none">
            Archived
          </TabsTrigger>
          {!sourceOnly ? (
            <TabsTrigger value="rejected" className="rounded-none border-0 px-0 shadow-none">
              Rejected
            </TabsTrigger>
          ) : null}
        </TabsList>
        {(["published", "needs_review", "archived", "rejected"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            {tab === "needs_review" ? (
              <div className="mb-4 grid gap-3">
                {!reviewGroup ? (
                  <BehaviorReviews
                    workspaceId={workspaceId}
                    scope={scope === "all" ? undefined : scope}
                  />
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
                {!reviewGroup && canEdit ? (
                  <KnowledgeReviewGroups
                    workspaceId={workspaceId}
                    scope={scope === "all" ? undefined : scope}
                    refresh={refresh}
                    onSelect={beginReview}
                  />
                ) : null}
                {canEdit && reviewGroup && entries.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      disabled={loading}
                      onClick={() => {
                        setTrail([]);
                        startReview.current = reviewGroup.id;
                        setReviewTransition(true);
                        setRefresh((n) => n + 1);
                      }}
                    >
                      Continue review
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setBulkReview((value) => !value)}
                    >
                      {bulkReview ? "Hide selection" : "Select items"}
                    </Button>
                  </div>
                ) : null}
                {canEdit && reviewGroup && entries.length && bulkReview ? (
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
            {treeView && tab === "published" ? (
              <section aria-label="Knowledge tree" className="grid min-w-0 gap-2">
                <div className="flex min-w-0 items-center justify-end gap-2">
                  {canEdit && (scope !== "organization" || canWriteOrganization) ? (
                    <Button variant="ghost" size="sm" onClick={() => startCreating("group")}>
                      <PlusIcon className="size-4" />
                      New collection
                    </Button>
                  ) : null}
                </div>
                <KnowledgeTree
                  key={`${workspaceId}:${requestKey}`}
                  workspaceId={workspaceId}
                  entries={entries}
                  scope={scope === "all" ? undefined : scope}
                  refresh={refresh}
                  canEdit={canEdit}
                  canWriteOrganization={canWriteOrganization}
                  onOpen={(entry) => setSelection({ id: entry.id, view: "published" })}
                  onCreate={startCreating}
                />
              </section>
            ) : entries.length ? (
              <section
                aria-label={search ? "Search results" : "Knowledge entries"}
                className="min-w-0 rounded-lg border border-border/60 p-1.5"
              >
                {entries.map((entry) => renderEntry(entry, tab))}
              </section>
            ) : null}
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
      <Dialog
        open={selection !== null || reviewTransition}
        onOpenChange={(open) => {
          if (!open) {
            setSelection(null);
            setTrail([]);
            startReview.current = null;
            setReviewTransition(false);
          }
        }}
      >
        <DialogContent
          className="min-w-0 bg-surface sm:max-w-3xl"
          style={{ borderColor: "var(--color-border-strong)" }}
        >
          {inspection}
        </DialogContent>
      </Dialog>
      {copying ? (
        <CopyKnowledgeDialog
          key={copying.id}
          record={copying}
          workspaceId={workspaceId}
          onClose={() => setCopying(null)}
          onSaved={() => {
            setCopying(null);
            notifyKnowledgeReviewUpdated();
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
              {createParent ? `In ${createParent.title}. ` : ""}
              {creating === "group"
                ? "Collect related knowledge about a customer, product, system, or subject."
                : "Write what is useful to remember. You can organize or correct it later."}
            </DialogDescription>
          </DialogHeader>
          <KnowledgeEditor
            key={`${creating}:${createParent?.id ?? group?.id ?? "root"}`}
            workspaceId={workspaceId}
            scope={createScope}
            initial={{
              title: "",
              kind: creating ?? "note",
              content: "",
              evidence: [],
              relationships: [],
              groupIds: createParent ? [createParent.id] : group ? [group.id] : [],
            }}
            onSave={async (entry) => {
              await context.client.saveKnowledgeEntry(workspaceId, {
                operationId: crypto.randomUUID(),
                entryId: crypto.randomUUID(),
                expectedVersion: 0,
                scope: createScope,
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
          <DialogTitle>Share with a workspace</DialogTitle>
          <DialogDescription>
            Share the text below as a new knowledge entry in the selected workspace. People and
            agents with access to its knowledge can read it. Your personal entry stays private.
            Attached files and private source links are not shared.
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
              submitLabel="Share copy"
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
  inline?: boolean;
  workspaceId: string;
  selection: Selection;
  canEdit: boolean;
  onOpen: (selection: Selection) => void;
  onReplace: (selection: Selection) => void;
  onReviewed: () => void;
  continueReview: boolean;
  onGroup: (group: { id: string; title: string }) => void;
  onChanged: () => void;
  onCopy: (record: KnowledgeEntryRecord) => void;
}) {
  const { client } = useAppContext();
  const [record, setRecord] = useState<KnowledgeEntryRecord | null>(null);
  const [history, setHistory] = useState<KnowledgeEntrySummary[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyRequest = useRef(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef(0);
  useEffect(() => {
    ++lifetime.current;
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate async completions, not a DOM ref
      ++lifetime.current;
    };
  }, [props.workspaceId, props.selection.id, props.selection.revisionId, props.selection.view]);
  useEffect(() => {
    let current = true;
    setRecord(null);
    ++historyRequest.current;
    setHistory([]);
    setBefore(null);
    setHistoryLoading(false);
    setHistoryError(null);
    setError(null);
    void (async () => {
      try {
        const loaded = await client.getKnowledgeEntry(props.workspaceId, props.selection.id, {
          ...(props.selection.revisionId ? { revisionId: props.selection.revisionId } : {}),
          ...(props.selection.view ? { view: props.selection.view } : {}),
        });
        return loaded.revision.outcome === "pending" && props.selection.view !== "needs_review"
          ? client.getKnowledgeEntry(props.workspaceId, loaded.id, {
              revisionId: loaded.revision.id,
              view: "needs_review",
            })
          : loaded;
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
    const generation = lifetime.current;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (generation !== lifetime.current) return;
      setEditing(false);
      if (record?.revision.outcome === "pending") {
        props.onReviewed();
        return;
      }
      props.onChanged();
      setRefresh((n) => n + 1);
      const outcome =
        result && typeof result === "object" && "outcome" in result ? result.outcome : null;
      props.onReplace(
        outcome === "archived"
          ? { id: props.selection.id, view: "archived" }
          : outcome === "rejected" && record
            ? { id: record.id, revisionId: record.revision.id }
            : { id: props.selection.id, view: "published" },
      );
    } catch (reason) {
      if (generation === lifetime.current) setError(message(reason));
    } finally {
      if (generation === lifetime.current) setBusy(false);
    }
  }
  async function loadHistory(more = false) {
    const generation = lifetime.current;
    const request = ++historyRequest.current;
    const isCurrent = () => generation === lifetime.current && request === historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await client.listKnowledgeEntryHistory(
        props.workspaceId,
        props.selection.id,
        more && before ? before : undefined,
      );
      if (!isCurrent()) return;
      setHistory((prior) => (more ? [...prior, ...result.entries] : result.entries));
      setBefore(result.beforeRevision);
    } catch (reason) {
      if (isCurrent()) setHistoryError(message(reason));
    } finally {
      if (isCurrent()) setHistoryLoading(false);
    }
  }
  const Header = props.inline ? "header" : DialogHeader;
  const Title = props.inline ? "h2" : DialogTitle;
  const Description = props.inline ? "p" : DialogDescription;
  const entry = record?.revision.entry;
  const pending = record?.revision.outcome === "pending";
  const historical = record && !pending && record.revision.id !== record.publishedRevisionId;
  return (
    <>
      <Header className="grid min-w-0 gap-2 pr-6 text-left">
        <Title className="break-words text-lg font-semibold leading-snug">
          {entry?.title ?? "Knowledge entry"}
        </Title>
        <Description className="text-sm text-fg-muted">
          {record
            ? `${pending ? (record.revision.change === "archive" ? "Archive request" : record.publishedRevisionId ? "Review update" : entry?.kind === "group" ? "New collection" : "New knowledge") : KIND[record.revision.entry.kind]} · ${record.scope === "personal" ? "Only me" : record.scope === "organization" ? "Company" : "Workspace"}`
            : "Loading entry…"}
        </Description>
      </Header>
      <div className="grid min-w-0 gap-5">
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
                  const generation = lifetime.current;
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
                  if (generation !== lifetime.current) return;
                  setEditing(false);
                  if (pending) {
                    props.onReviewed();
                    return;
                  }
                  props.onChanged();
                  setRefresh((n) => n + 1);
                  props.onReplace({ id: record.id, view: "published" });
                }}
              />
            ) : pending ? (
              <KnowledgeReviewSummary workspaceId={props.workspaceId} record={record} />
            ) : (
              <div className="whitespace-pre-wrap break-words text-sm leading-6">
                {entry.content || "This collection brings together related knowledge."}
              </div>
            )}
            {(entry.source && entry.source.kind !== "manual") ||
            entry.evidence.length ||
            entry.groupIds.length ||
            entry.relationships.length ? (
              <details
                className="group/details rounded-lg border border-border bg-bg/60 px-4 py-3"
                open={pending ? undefined : true}
              >
                <summary className="cursor-pointer text-sm font-medium text-fg">Details</summary>
                <div className="mt-3 grid gap-4">
                  {(entry.source && entry.source.kind !== "manual") || entry.evidence.length ? (
                    <section aria-label="Sources" className="grid gap-3">
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-fg-muted">
                        <QuoteIcon className="size-4 text-brand" />
                        Sources
                      </h3>
                      {entry.source ? (
                        <div className="grid gap-2">
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
                          {entry.source.kind === "conversation" && entry.source.sessionId ? (
                            <a
                              href={`/workspaces/${props.workspaceId}/sessions/${entry.source.sessionId}`}
                              className="text-sm text-brand hover:underline"
                            >
                              Open conversation
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
                        </div>
                      ) : null}
                      {entry.evidence.length ? (
                        <div className="grid gap-3">
                          {entry.evidence.map((evidence) => (
                            <div key={JSON.stringify(evidence)} className="grid gap-1">
                              {evidence.quote ? (
                                <blockquote className="border-l-2 border-brand/40 pl-3 text-sm text-fg">
                                  {evidence.quote}
                                </blockquote>
                              ) : null}
                              <KnowledgeReference
                                workspaceId={props.workspaceId}
                                id={evidence.entryId}
                                revisionId={evidence.revisionId}
                                onClick={() =>
                                  props.onOpen({
                                    id: evidence.entryId,
                                    revisionId: evidence.revisionId,
                                  })
                                }
                              />
                              {evidence.location.page ? (
                                <span className="text-xs text-fg-subtle">
                                  Page {evidence.location.page}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  {entry.groupIds.length ? (
                    <section
                      aria-label="Collection placement"
                      className={`grid gap-2 ${entry.source || entry.evidence.length ? "border-t border-border pt-4" : ""}`}
                    >
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-fg-muted">
                        <FolderIcon className="size-4 text-amber-600 dark:text-amber-400" />
                        {pending && record.revision.change !== "archive" ? "Save in" : "Saved in"}
                      </h3>
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
                      <h3 className="flex items-center gap-2 text-xs font-semibold text-fg-muted">
                        <LinkIcon className="size-4" />
                        Related knowledge
                      </h3>
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
                </div>
              </details>
            ) : null}
            <details
              className="rounded-lg border border-border bg-bg/60 px-4 py-3"
              key={`history:${record.version}`}
              onToggle={(event) => {
                if (event.currentTarget.open && !historyLoading) void loadHistory();
              }}
            >
              <summary className="cursor-pointer text-sm font-medium text-fg">History</summary>
              <section aria-label="Revision history" className="mt-3 grid gap-2">
                {historyLoading ? (
                  <p role="status" className="text-sm text-fg-muted">
                    Loading revisions…
                  </p>
                ) : null}
                {historyError ? (
                  <div role="alert" className="text-sm text-status-error">
                    {historyError}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={historyLoading}
                      onClick={() => void loadHistory()}
                    >
                      Retry history
                    </Button>
                  </div>
                ) : null}
                {history.map((item) => (
                  <button
                    key={item.revision.id}
                    className="text-left text-sm text-fg-muted hover:text-fg"
                    onClick={() =>
                      props.onOpen({
                        id: item.id,
                        revisionId: item.revision.id,
                      })
                    }
                  >
                    Revision {item.revision.number} · {item.revision.outcome} ·{" "}
                    {relativeTimeLabel(item.revision.createdAt)}
                  </button>
                ))}
                {before ? (
                  <Button
                    variant="ghost"
                    disabled={historyLoading}
                    onClick={() => void loadHistory(true)}
                  >
                    Earlier revisions
                  </Button>
                ) : null}
              </section>
            </details>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {props.canEdit && !editing && !historical ? (
                <>
                  {!pending && !record.archived && record.revision.change !== "archive" ? (
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
                      Share with workspace
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
                        {props.continueReview ? "Approve and next" : "Approve"}
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
                        {props.continueReview ? "Reject and next" : "Reject"}
                      </Button>
                      {record.revision.change !== "archive" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(true)}
                        >
                          Edit first
                        </Button>
                      ) : null}
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
              {(historical || record.archived || record.revision.outcome === "rejected") &&
              props.canEdit ? (
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
            </div>
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
      {draft.evidence.length ? (
        <KnowledgeEvidenceEditor
          workspaceId={props.workspaceId}
          evidence={draft.evidence}
          disabled={busy}
          onChange={(evidence) => setDraft({ ...draft, evidence })}
        />
      ) : null}
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
              setDraft({
                ...draft,
                kind: event.target.value as KnowledgeEntryKind,
              })
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
