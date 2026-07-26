// The workspace-memory audit pane on the Documents page: humans browse, seed,
// pin, correct, and hybrid-search the long-lived memory that agents read and
// write across sessions. It stays usable whether or not the workspace has the
// memory setting enabled — when disabled it leads with a short explanation and
// a link to turn it on, but the audit/seed lane below stays open.
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BrainCircuitIcon,
  CheckCircle2Icon,
  CheckIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import type {
  KnowledgeMemory,
  KnowledgeMemoryKind,
  KnowledgeMemoryStatus,
  WorkspaceMemorySearchResult,
} from "@/types";

// Human labels — no raw enum slugs ever reach the UI. Chips read as singular
// nouns; the injected working-set block uses the plural section names.
const KIND_LABEL: Record<KnowledgeMemoryKind, string> = {
  preference: "Preference",
  semantic: "Fact",
  procedural: "Procedure",
  decision: "Decision",
  episodic: "History",
};
const STATUS_LABEL: Record<KnowledgeMemoryStatus, string> = {
  active: "Active",
  proposed: "Proposed",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
  archived: "Archived",
};

const kindFilterOptions: KnowledgeMemoryKind[] = [
  "preference",
  "semantic",
  "procedural",
  "decision",
  "episodic",
];
// The statuses worth browsing; "active" is the default working set an agent sees.
const statusFilterOptions: KnowledgeMemoryStatus[] = [
  "active",
  "proposed",
  "approved",
  "archived",
  "superseded",
];

const selectClass =
  "h-8 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 text-xs text-[color:var(--color-fg)]";

/** Pinned first, then most-recently-updated — mirrors the working-set render order. */
function sortMemories(memories: KnowledgeMemory[]): KnowledgeMemory[] {
  return [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export function MemoryPane({
  workspaceId,
  memoryEnabled,
  focusMemoryId,
}: {
  workspaceId: string;
  memoryEnabled: boolean;
  /** A memory record to reveal + highlight, deep-linked from a timeline memory step (`?memory=<id>`). */
  focusMemoryId?: string | undefined;
}) {
  const client = useAppContext().client;

  const [memories, setMemories] = useState<KnowledgeMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [statusFilter, setStatusFilter] = useState<KnowledgeMemoryStatus>("active");
  const [kindFilter, setKindFilter] = useState<KnowledgeMemoryKind | "">("");

  // Deep-link focus (from `?memory=<id>`): reveal the record even when the
  // filters would hide it, scroll it into view, and ring it briefly. `pending`
  // is the id awaiting reveal; `focusedId` drives the transient highlight;
  // `fallback` is the fetched record we inject if it lands outside the list.
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusFallback, setFocusFallback] = useState<KnowledgeMemory | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // null = browsing filters; an array (possibly empty) = showing search results.
  const [searchResults, setSearchResults] = useState<WorkspaceMemorySearchResult[] | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");

  const [adding, setAdding] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftKind, setDraftKind] = useState<KnowledgeMemoryKind>("semantic");
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void refresh();
    // Reset transient view state when the workspace changes.
    setSearchResults(null);
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, statusFilter, kindFilter]);

  // A deep-link arrived: leave any search, fetch the record to learn its
  // status/kind, and align the browse filters so it comes into view. Filter
  // changes ride the effect above (which refetches the list).
  useEffect(() => {
    if (!focusMemoryId) {
      // The deep-link was cleared (or we switched workspace): drop any pending
      // focus so a stale id can't highlight or inject into the new list.
      setPendingFocusId(null);
      setFocusFallback(null);
      return;
    }
    let cancelled = false;
    setSearchResults(null);
    setPendingFocusId(focusMemoryId);
    setFocusFallback(null);
    void (async () => {
      try {
        const record = await client.getKnowledgeMemory(workspaceId, focusMemoryId);
        if (cancelled) return;
        setFocusFallback(record);
        setKindFilter((current) => (current && current !== record.kind ? "" : current));
        setStatusFilter((current) => (current !== record.status ? record.status : current));
      } catch {
        // Not found / no access — drop the pending focus so nothing dead-highlights.
        if (!cancelled) setPendingFocusId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMemoryId, workspaceId]);

  // Once the list has settled, scroll the focused card into view and ring it. If
  // the record fell outside the (filtered, capped) list, inject the fetched copy
  // so the deep-link never dead-ends, then this effect re-runs and reveals it.
  useEffect(() => {
    if (!pendingFocusId || loading || searchResults !== null) return;
    const node = cardRefs.current.get(pendingFocusId);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setFocusedId(pendingFocusId);
      setPendingFocusId(null);
      return;
    }
    // Inject the fetched copy only when it belongs to THIS workspace — guard
    // against a fallback fetched for a workspace we've since navigated away from.
    if (
      focusFallback &&
      focusFallback.id === pendingFocusId &&
      focusFallback.workspaceId === workspaceId
    ) {
      setMemories((current) =>
        current.some((item) => item.id === pendingFocusId)
          ? current
          : sortMemories([focusFallback, ...current]),
      );
    }
  }, [pendingFocusId, loading, memories, searchResults, focusFallback, workspaceId]);

  // The highlight ring is transient — fade it after ~2s.
  useEffect(() => {
    if (!focusedId) return;
    const timer = setTimeout(() => setFocusedId(null), 2000);
    return () => clearTimeout(timer);
  }, [focusedId]);

  async function refresh() {
    setLoading(true);
    try {
      const next = await client.listKnowledgeMemories(workspaceId, {
        status: statusFilter,
        ...(kindFilter ? { kind: kindFilter } : {}),
        limit: 50,
      });
      setMemories(sortMemories(next));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearching(true);
    try {
      const response = await client.searchWorkspaceMemories(workspaceId, {
        query: trimmed,
        mode: "hybrid",
        limit: 10,
      });
      setSearchResults(response.results);
      setSearchedQuery(trimmed);
    } catch (caught) {
      toast.error("Memory search failed", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setSearchResults(null);
    setSearchedQuery("");
    setQuery("");
  }

  async function handleCreate() {
    const text = draftText.trim();
    if (!text) return;
    setCreating(true);
    try {
      // No explicit status ⇒ the server's active default, routed through the one
      // write gate (dedup, sanitize, redact).
      const created = await client.createKnowledgeMemory(workspaceId, { text, kind: draftKind });
      setDraftText("");
      setAdding(false);
      toast.success("Memory saved");
      // Only surface it in place if it belongs in the current view.
      if (statusFilter === created.status && (!kindFilter || kindFilter === created.kind)) {
        setMemories((current) =>
          sortMemories([created, ...current.filter((item) => item.id !== created.id)]),
        );
      }
    } catch (caught) {
      toast.error("Couldn't save memory", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setCreating(false);
    }
  }

  function withBusy(id: string, on: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Patch a record in whichever view(s) currently show it.
  function patchLists(updated: KnowledgeMemory) {
    setMemories((current) =>
      sortMemories(current.map((item) => (item.id === updated.id ? updated : item))),
    );
    setSearchResults((current) =>
      current === null
        ? null
        : current.map((result) =>
            result.memory.id === updated.id ? { ...result, memory: updated } : result,
          ),
    );
  }

  // A status change (archive/approve/reject) can move a record out of the active
  // browse filter, so refetch that list for accuracy; pin/text edits patch in place.
  async function runUpdate(
    memory: KnowledgeMemory,
    patch: Parameters<typeof client.updateKnowledgeMemory>[2],
    successMessage: string,
    statusChange: boolean,
  ) {
    withBusy(memory.id, true);
    try {
      const updated = await client.updateKnowledgeMemory(workspaceId, memory.id, patch);
      toast.success(successMessage);
      if (statusChange && searchResults === null) {
        await refresh();
      } else {
        patchLists(updated);
      }
    } catch (caught) {
      toast.error("Couldn't update memory", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      withBusy(memory.id, false);
    }
  }

  async function saveEdit(memory: KnowledgeMemory) {
    const text = editText.trim();
    if (!text || text === memory.text) {
      setEditingId(null);
      return;
    }
    withBusy(memory.id, true);
    try {
      const updated = await client.updateKnowledgeMemory(workspaceId, memory.id, { text });
      patchLists(updated);
      setEditingId(null);
      toast.success("Memory updated");
    } catch (caught) {
      toast.error("Couldn't update memory", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      withBusy(memory.id, false);
    }
  }

  const renderMemoryCard = (memory: KnowledgeMemory) => (
    <MemoryCard
      key={memory.id}
      workspaceId={workspaceId}
      memory={memory}
      highlighted={focusedId === memory.id}
      innerRef={(el) => {
        const map = cardRefs.current;
        if (el) map.set(memory.id, el);
        else map.delete(memory.id);
      }}
      busy={busyIds.has(memory.id)}
      editing={editingId === memory.id}
      editText={editText}
      onEditTextChange={setEditText}
      onStartEdit={() => {
        setEditingId(memory.id);
        setEditText(memory.text);
      }}
      onCancelEdit={() => setEditingId(null)}
      onSaveEdit={() => void saveEdit(memory)}
      onTogglePin={() =>
        void runUpdate(
          memory,
          { pinned: !memory.pinned },
          memory.pinned ? "Unpinned" : "Pinned",
          false,
        )
      }
      onArchive={() => void runUpdate(memory, { status: "archived" }, "Memory archived", true)}
      onApprove={() => void runUpdate(memory, { status: "approved" }, "Memory approved", true)}
      onReject={() => void runUpdate(memory, { status: "rejected" }, "Memory rejected", true)}
    />
  );

  return (
    <div className="mt-6 border-t border-[color:var(--color-border)] pt-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BrainCircuitIcon className="size-4 text-[color:var(--color-brand)]" />
          Memory
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setAdding((current) => !current)}
            aria-label="Add memory"
            title="Add a memory"
          >
            <PlusIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh memories"
            title="Refresh"
          >
            {loading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>

      <p className="mt-1 text-xs leading-5 text-[color:var(--color-fg-muted)]">
        Durable facts agents carry across sessions in this workspace.
      </p>

      {!memoryEnabled ? (
        <Notice
          tone="info"
          className="mt-3"
          title="Memory is off for this workspace"
          action={
            <Button asChild type="button" variant="secondary" size="xs">
              <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }}>
                Settings
              </Link>
            </Button>
          }
        >
          Agents won't read or write memory until it's enabled. You can still browse and seed
          records here.
        </Notice>
      ) : null}

      {adding ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3">
          <Textarea
            autoFocus
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            placeholder="A durable fact, preference, decision, or procedure for this workspace"
            className="min-h-20 text-xs"
          />
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <select
              value={draftKind}
              onChange={(event) => setDraftKind(event.target.value as KnowledgeMemoryKind)}
              className={selectClass}
            >
              {kindFilterOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => {
                setAdding(false);
                setDraftText("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={creating || !draftText.trim()}
              onClick={() => void handleCreate()}
            >
              {creating ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <CheckIcon className="size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memory"
          className="h-8 text-xs"
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSearch();
          }}
        />
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0"
          disabled={searching || !query.trim()}
          onClick={() => void handleSearch()}
        >
          {searching ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <SearchIcon className="size-3.5" />
          )}
          Search
        </Button>
      </div>

      {searchResults !== null ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-2xs uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
              {searchResults.length} {searchResults.length === 1 ? "match" : "matches"} for “
              {searchedQuery}”
            </div>
            <Button type="button" variant="ghost" size="xs" onClick={clearSearch}>
              <ArrowLeftIcon className="size-3" />
              Back
            </Button>
          </div>
          <div className="mt-2 space-y-2">
            {searchResults.length > 0 ? (
              searchResults.map((result) => (
                <MemoryCard
                  key={result.memory.id}
                  workspaceId={workspaceId}
                  memory={result.memory}
                  score={result.score}
                  busy={busyIds.has(result.memory.id)}
                  editing={editingId === result.memory.id}
                  editText={editText}
                  onEditTextChange={setEditText}
                  onStartEdit={() => {
                    setEditingId(result.memory.id);
                    setEditText(result.memory.text);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={() => void saveEdit(result.memory)}
                  onTogglePin={() =>
                    void runUpdate(
                      result.memory,
                      { pinned: !result.memory.pinned },
                      result.memory.pinned ? "Unpinned" : "Pinned",
                      false,
                    )
                  }
                  onArchive={() =>
                    void runUpdate(result.memory, { status: "archived" }, "Memory archived", true)
                  }
                  onApprove={() =>
                    void runUpdate(result.memory, { status: "approved" }, "Memory approved", true)
                  }
                  onReject={() =>
                    void runUpdate(result.memory, { status: "rejected" }, "Memory rejected", true)
                  }
                />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                No memory matched “{searchedQuery}”.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as KnowledgeMemoryStatus)}
              className={selectClass}
            >
              {statusFilterOptions.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as KnowledgeMemoryKind | "")}
              className={selectClass}
            >
              <option value="">All kinds</option>
              {kindFilterOptions.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABEL[kind]}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-[color:var(--color-border)] p-6 text-xs text-[color:var(--color-fg-muted)]">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading memory
              </div>
            ) : (
              <>
                {/* A list error is a banner, not a takeover: cards below still
                    render — so a deep-linked record (injected even when the
                    browse list fails) still mounts, scrolls, and highlights. */}
                {error ? (
                  <Notice
                    tone="failed"
                    title="Couldn't load memory"
                    action={
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => void refresh()}
                      >
                        Retry
                      </Button>
                    }
                  >
                    {error.message}
                  </Notice>
                ) : null}
                {memories.length > 0 ? (
                  memories.map(renderMemoryCard)
                ) : error ? null : (
                  <div className="rounded-lg border border-dashed border-[color:var(--color-border)] p-4 text-xs leading-5 text-[color:var(--color-fg-muted)]">
                    {statusFilter === "active"
                      ? "No memory yet. Agents add facts as they work, or seed one with the + above."
                      : `No ${STATUS_LABEL[statusFilter].toLowerCase()} memory${kindFilter ? ` of this kind` : ""}.`}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MemoryCard(props: {
  workspaceId: string;
  memory: KnowledgeMemory;
  score?: number;
  /** Ring the card briefly — set while it is the deep-link's focused record. */
  highlighted?: boolean;
  /** Registers the card node so the pane can scroll it into view on a deep-link. */
  innerRef?: (el: HTMLDivElement | null) => void;
  busy: boolean;
  editing: boolean;
  editText: string;
  onEditTextChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { memory, busy, editing } = props;
  const faded =
    memory.status === "superseded" || memory.status === "archived" || memory.status === "rejected";
  const canArchive =
    memory.status === "active" || memory.status === "approved" || memory.status === "proposed";

  return (
    <div
      ref={props.innerRef}
      className={cn(
        "scroll-mt-4 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/35 p-3 transition-shadow duration-300",
        faded && "opacity-70",
        props.highlighted &&
          "ring-2 ring-[color:var(--color-brand)] ring-offset-2 ring-offset-[color:var(--color-bg)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {memory.pinned ? (
            <PinIcon className="size-3 shrink-0 text-[color:var(--color-brand)]" />
          ) : null}
          <MetaChip>{KIND_LABEL[memory.kind]}</MetaChip>
          {memory.status !== "active" ? (
            <span className="shrink-0 text-2xs text-[color:var(--color-fg-subtle)]">
              {STATUS_LABEL[memory.status]}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.score !== undefined ? (
            <span className="text-2xs text-[color:var(--color-fg-subtle)]">
              {Math.round(props.score * 100)}%
            </span>
          ) : null}
          {busy ? (
            <Loader2Icon className="size-4 animate-spin text-[color:var(--color-fg-subtle)]" />
          ) : !editing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Memory actions">
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={6}
                className="w-40 rounded-xl border-border bg-surface p-1.5 shadow-xl"
              >
                <DropdownMenuItem
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs"
                  onSelect={() => props.onTogglePin()}
                >
                  {memory.pinned ? (
                    <PinOffIcon className="size-3.5 text-fg-subtle" />
                  ) : (
                    <PinIcon className="size-3.5 text-fg-subtle" />
                  )}
                  {memory.pinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs"
                  onSelect={() => props.onStartEdit()}
                >
                  <PencilIcon className="size-3.5 text-fg-subtle" />
                  Edit text
                </DropdownMenuItem>
                {canArchive ? (
                  <DropdownMenuItem
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-xs"
                    onSelect={() => props.onArchive()}
                  >
                    <ArchiveIcon className="size-3.5 text-fg-subtle" />
                    Archive
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-2 grid gap-2">
          <Textarea
            value={props.editText}
            onChange={(event) => props.onEditTextChange(event.target.value)}
            className="min-h-20 text-xs"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="xs" onClick={props.onCancelEdit}>
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={busy || !props.editText.trim()}
              onClick={props.onSaveEdit}
            >
              <CheckIcon className="size-3" />
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[color:var(--color-fg-muted)]">
          {memory.text}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[color:var(--color-fg-subtle)]">
        <span>{relativeTimeLabel(memory.updatedAt)}</span>
        {memory.usageCount > 0 ? (
          <span>
            · {memory.usageCount} {memory.usageCount === 1 ? "use" : "uses"}
          </span>
        ) : null}
        {memory.createdBySessionId ? (
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId: props.workspaceId, sessionId: memory.createdBySessionId }}
            className="hover:text-[color:var(--color-fg)]"
            title="Open the session that created this memory"
          >
            <MetaChip className="hover:border-border-strong">From session</MetaChip>
          </Link>
        ) : null}
      </div>

      {memory.status === "proposed" ? (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 flex-1"
            disabled={busy}
            onClick={props.onApprove}
          >
            <CheckCircle2Icon className="size-3.5" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 flex-1"
            disabled={busy}
            onClick={props.onReject}
          >
            <XCircleIcon className="size-3.5" />
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}
