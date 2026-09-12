import type {
  KnowledgeEntryListRequest,
  KnowledgeEntryScope,
  KnowledgeEntrySummary,
} from "@opengeni/sdk";
import {
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";
import { relativeTimeLabel } from "@/lib/sessions-group";

import { KNOWLEDGE_SOURCE_LABEL as SOURCE } from "./knowledge-labels";

export type KnowledgeCollection = {
  id: string;
  title: string;
  scope: KnowledgeEntryScope;
};

/** The same compact row is used for tree nodes and flat search/review results. */
export function KnowledgeRow({
  entry,
  description,
  expanded,
  tree = false,
  onClick,
}: {
  entry: KnowledgeEntrySummary;
  description?: string;
  expanded?: boolean;
  tree?: boolean;
  onClick: () => void;
}) {
  const folder = entry.revision.kind === "group";
  const Icon = folder ? (expanded ? FolderOpenIcon : FolderIcon) : FileTextIcon;
  return (
    <button
      type="button"
      data-knowledge-row
      tabIndex={tree ? -1 : undefined}
      aria-label={entry.revision.title}
      onClick={onClick}
      className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:min-h-11"
    >
      {tree ? (
        folder ? (
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-fg-subtle", expanded && "rotate-90")}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )
      ) : null}
      <Icon
        aria-hidden
        className={cn("size-4 shrink-0", folder ? "text-fg-muted" : "text-fg-subtle")}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", folder && "font-medium")}>
          {entry.revision.title}
        </span>
        {description ? (
          <span className="mt-0.5 block truncate text-xs font-normal text-fg-muted">
            {description}
          </span>
        ) : null}
      </span>
      {entry.revision.change === "archive" ? (
        <span className="shrink-0 text-xs text-fg-muted">Archive requested</span>
      ) : null}
      {entry.revision.sourceKind ? (
        <span className="hidden w-24 shrink-0 truncate text-xs text-fg-subtle lg:block">
          {SOURCE[entry.revision.sourceKind]}
        </span>
      ) : (
        <span className="hidden w-24 shrink-0 lg:block" />
      )}
      <span className="hidden w-20 shrink-0 text-xs text-fg-subtle sm:block">
        {entry.scope === "personal"
          ? "Only me"
          : entry.scope === "organization"
            ? "Company"
            : "Workspace"}
      </span>
      <span className="hidden w-10 shrink-0 text-right text-xs text-fg-subtle sm:block">
        {relativeTimeLabel(entry.updatedAt)}
      </span>
    </button>
  );
}

type TreeProps = {
  workspaceId: string;
  entries: KnowledgeEntrySummary[];
  scope?: KnowledgeEntryScope;
  refresh: number;
  canEdit: boolean;
  canWriteOrganization?: boolean;
  onOpen: (entry: KnowledgeEntrySummary) => void;
  onCreate: (kind: "note" | "group", parent: KnowledgeCollection) => void;
};
type TreeState = TreeProps & {
  expanded: Set<string>;
  active: string;
  setActive: (path: string) => void;
  toggle: (path: string) => void;
};

export function KnowledgeTree(props: TreeProps) {
  // Paths, rather than IDs: a record can belong to several collections.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState("");
  const tree = useRef<HTMLDivElement>(null);
  const roots = treeOrder(props.entries);
  const state: TreeState = {
    ...props,
    expanded,
    active: active || roots[0]?.id || "",
    setActive,
    toggle: (path) =>
      setExpanded((prior) => {
        const next = new Set(prior);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
  };
  // Keep the single keyboard entry point valid after editing/moving a node.
  useEffect(() => {
    const nodes = tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]');
    if (nodes?.length && ![...nodes].some((node) => node.dataset.path === active)) {
      setActive(nodes[0]!.dataset.path!);
    }
  }, [props.entries, active, expanded]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const current = target.closest<HTMLElement>('[role="treeitem"]');
    if (!current || (target !== current && !target.closest("[data-knowledge-row]"))) return;
    const nodes = [
      ...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"][data-path]') ?? []),
    ];
    const index = nodes.indexOf(current);
    const path = current.dataset.path!;
    const folder = current.hasAttribute("aria-expanded");
    const open = current.getAttribute("aria-expanded") === "true";
    let destination: HTMLElement | undefined;
    if (event.key === "ArrowDown") destination = nodes[index + 1];
    else if (event.key === "ArrowUp") destination = nodes[index - 1];
    else if (event.key === "Home") destination = nodes[0];
    else if (event.key === "End") destination = nodes.at(-1);
    else if (event.key === "ArrowRight") {
      if (folder && !open) state.toggle(path);
      else if (folder)
        destination =
          current.querySelector<HTMLElement>('[role="treeitem"][data-path]') ?? undefined;
    } else if (event.key === "ArrowLeft") {
      if (folder && open) state.toggle(path);
      else
        destination = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined;
    } else if (event.key === "Enter" || event.key === " ") {
      current.querySelector<HTMLButtonElement>("[data-knowledge-row]")?.click();
    } else if (event.key === "F10" && event.shiftKey) {
      current.querySelector<HTMLButtonElement>("[data-collection-actions]")?.click();
    } else return;
    event.preventDefault();
    if (destination) {
      setActive(destination.dataset.path!);
      destination.focus();
    }
  }
  if (!props.entries.length) return null;
  return (
    <div
      ref={tree}
      role="tree"
      aria-label="Knowledge"
      onKeyDown={onKeyDown}
      className="min-w-0 rounded-lg border border-border/60 p-1.5"
    >
      {roots.map((entry) => (
        <TreeNode key={entry.id} entry={entry} path={entry.id} ancestors={[]} state={state} />
      ))}
    </div>
  );
}

function TreeNode({
  entry,
  path,
  ancestors,
  state,
}: {
  entry: KnowledgeEntrySummary;
  path: string;
  ancestors: string[];
  state: TreeState;
}) {
  const labelId = useId();
  const folder = entry.revision.kind === "group";
  const open = state.expanded.has(path);
  const [menuOpen, setMenuOpen] = useState(false);
  const parent: KnowledgeCollection = {
    id: entry.id,
    title: entry.revision.title,
    scope: entry.scope,
  };
  return (
    <div
      role="treeitem"
      data-path={path}
      aria-label={entry.revision.title}
      aria-describedby={folder && entry.revision.preview ? labelId : undefined}
      aria-expanded={folder ? open : undefined}
      tabIndex={state.active === path ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) state.setActive(path);
      }}
      className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
    >
      {folder && entry.revision.preview ? (
        <span id={labelId} className="sr-only">
          {entry.revision.preview}
        </span>
      ) : null}
      <div className="group/row flex min-w-0 items-center rounded-md hover:bg-surface-2/40">
        <KnowledgeRow
          entry={entry}
          description={folder ? entry.revision.preview : undefined}
          expanded={open}
          tree
          onClick={() => {
            state.setActive(path);
            if (folder) state.toggle(path);
            else state.onOpen(entry);
          }}
        />
        {folder ? (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                data-collection-actions
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${entry.revision.title}`}
                className="size-8 shrink-0 text-fg-subtle pointer-coarse:size-11"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => state.onOpen(entry)}>
                Collection details
              </DropdownMenuItem>
              {state.canEdit && (entry.scope !== "organization" || state.canWriteOrganization) ? (
                <>
                  <DropdownMenuItem onSelect={() => state.onCreate("note", parent)}>
                    Add knowledge here
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => state.onCreate("group", parent)}>
                    New collection here
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="w-8 shrink-0 pointer-coarse:w-11" />
        )}
      </div>
      {folder && open ? (
        <CollectionChildren
          entry={entry}
          path={path}
          ancestors={[...ancestors, entry.id]}
          state={state}
        />
      ) : null}
    </div>
  );
}

function CollectionChildren({
  entry,
  path,
  ancestors,
  state,
}: {
  entry: KnowledgeEntrySummary;
  path: string;
  ancestors: string[];
  state: TreeState;
}) {
  const { client } = useAppContext();
  const [entries, setEntries] = useState<KnowledgeEntrySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const request: KnowledgeEntryListRequest = {
    groupId: entry.id,
    scope: state.scope,
    view: "published",
    limit: 50,
  };
  const requestKey = JSON.stringify(request);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    setEntries([]);
    setCursor(null);
    void client
      .listKnowledgeEntries(state.workspaceId, JSON.parse(requestKey))
      .then((result) => {
        if (generation.current !== current) return;
        setEntries(result.entries);
        setCursor(result.nextCursor);
      })
      .catch((reason) => {
        if (generation.current === current)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- invalidate pending pages on unmount
      ++generation.current;
    };
  }, [client, state.workspaceId, requestKey, state.refresh, retry]);
  async function more() {
    if (!cursor || loading) return;
    const current = generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await client.listKnowledgeEntries(state.workspaceId, {
        ...request,
        cursor,
      });
      if (generation.current === current) {
        setEntries((prior) => [...prior, ...result.entries]);
        setCursor(result.nextCursor);
      }
    } catch (reason) {
      if (generation.current === current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }
  const visible = treeOrder(entries.filter((child) => !ancestors.includes(child.id)));
  const status = (content: ReactNode) => (
    <div
      role="treeitem"
      aria-disabled="true"
      className="flex flex-wrap items-center gap-2 px-9 py-2 text-xs text-fg-muted"
    >
      {content}
    </div>
  );
  return (
    <div role="group" className="ml-[15px] min-w-0 border-l border-border/70 pl-1 sm:ml-[19px]">
      {visible.map((child) => (
        <TreeNode
          key={child.id}
          entry={child}
          path={`${path}/${child.id}`}
          ancestors={ancestors}
          state={state}
        />
      ))}
      {loading ? status(<span role="status">Loading collection…</span>) : null}
      {error
        ? status(
            <>
              <span role="alert">{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => (cursor ? void more() : setRetry((value) => value + 1))}
              >
                Retry
              </Button>
            </>,
          )
        : null}
      {!loading && !error && !entries.length ? status("This collection is empty.") : null}
      {visible.length !== entries.length ? status("A circular collection link was skipped.") : null}
      {cursor && !error
        ? status(
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void more()}>
              Load more in {entry.revision.title}
            </Button>,
          )
        : null}
    </div>
  );
}

function treeOrder(entries: KnowledgeEntrySummary[]) {
  return [...entries].sort(
    (a, b) =>
      Number(b.revision.kind === "group") - Number(a.revision.kind === "group") ||
      a.revision.title.localeCompare(b.revision.title, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
  );
}
