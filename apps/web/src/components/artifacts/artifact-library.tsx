import { useNavigate } from "@tanstack/react-router";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { ImageIcon, LinkIcon, MessageSquareIcon, PanelsTopLeftIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  Toolbar,
  ToolbarFilterChips,
  ToolbarFilterMenu,
  ToolbarGroup,
  ToolbarSearch,
  type ToolbarFilterGroup,
  type ToolbarFilterValue,
} from "@/components/ui/toolbar";
import {
  artifactKey,
  artifactKindLabel,
  artifactKinds,
  artifactPath,
  artifactRoute,
  type ArtifactCatalogFilters,
  type ArtifactKind,
} from "@/lib/artifact-catalog";

const InlineChatImage = lazy(() =>
  import("./inline-chat-image").then((module) => ({ default: module.InlineChatImage })),
);

/** Mount retained-image loaders only near the viewport, not merely their img elements. */
export function ArtifactThumbnail({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="flex h-full w-full items-center justify-center">
      {visible ? children : <ImageIcon className="size-4 text-fg-subtle" aria-hidden />}
    </div>
  );
}

/** An image's own pixels in the 32px row tile, loaded only near the viewport. */
function ImageTile({ workspaceId, item }: { workspaceId: string; item: ArtifactCatalogItem }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-surface-2 [&_img]:size-full [&_img]:object-cover">
      <ArtifactThumbnail>
        <Suspense fallback={<ImageIcon className="size-4 text-fg-subtle" aria-hidden />}>
          <InlineChatImage
            workspaceId={workspaceId}
            artifactId={item.id}
            alt={item.title}
            thumbnail
          />
        </Suspense>
      </ArtifactThumbnail>
    </span>
  );
}

const TYPE_GROUP: ToolbarFilterGroup = {
  id: "type",
  label: "Type",
  options: artifactKinds
    .filter(([kind]) => kind !== "all")
    .map(([kind, label]) => ({ id: kind, label })),
};
const STATUS_GROUP: ToolbarFilterGroup = {
  id: "status",
  label: "Status",
  options: [{ id: "archived", label: "Archived" }],
};
const SORT_GROUP: ToolbarFilterGroup = {
  id: "sort",
  label: "Sort",
  options: [
    { id: "newest", label: "Newest first" },
    { id: "title", label: "Title" },
  ],
};

/** The toolbar's filter value for the catalog filters (defaults are no filter). */
function filterValueFor(filters: ArtifactCatalogFilters, withType: boolean): ToolbarFilterValue {
  return {
    ...(withType && filters.kind !== "all" ? { type: [filters.kind] } : {}),
    ...(filters.status === "archived" ? { status: ["archived"] } : {}),
    ...(filters.sort !== "updated" ? { sort: [filters.sort] } : {}),
  };
}

/** Every group is one value: keep the option picked last. */
function lastPicked(previous: ToolbarFilterValue, next: ToolbarFilterValue, group: string) {
  const ids = next[group] ?? [];
  if (ids.length <= 1) return ids[0];
  const before = previous[group] ?? [];
  return ids.filter((id) => !before.includes(id)).at(-1);
}

function isPlainClick(event: MouseEvent<HTMLElement>) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function ArtifactRow({
  workspaceId,
  item,
  sessionId,
  onSelect,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  sessionId?: string;
  onSelect?: (item: ArtifactCatalogItem) => void;
}) {
  const navigate = useNavigate();
  const search = sessionId ? { fromSession: sessionId } : {};
  const href = artifactPath(workspaceId, item, sessionId);
  const open = () =>
    void navigate({
      to: artifactRoute(item.kind),
      params: { workspaceId, artifactId: item.id },
      search,
    });
  const archived = item.status === "archived";
  return (
    <ListRow
      // Types are words; only an image shows its own pixels.
      leading={item.kind === "image" ? <ImageTile workspaceId={workspaceId} item={item} /> : null}
      title={item.title}
      meta={[
        artifactKindLabel[item.kind],
        <span key="updated">
          updated <RelativeTime date={item.updatedAt} inSentence />
        </span>,
        item.kind === "file" && item.filename && item.filename !== item.title
          ? item.filename
          : null,
        archived ? (
          <StatusBadge key="status" variant="dot" tone="neutral">
            Archived
          </StatusBadge>
        ) : null,
      ].filter(Boolean)}
      {...(onSelect
        ? { onOpen: () => onSelect(item) }
        : {
            href,
            onOpen: (event: MouseEvent<HTMLElement>) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              open();
            },
          })}
      menu={
        <>
          <DropdownMenuItem onSelect={() => (onSelect ? onSelect(item) : open())}>
            <PanelsTopLeftIcon />
            Open
          </DropdownMenuItem>
          {item.sourceSessionId && item.sourceSessionId !== sessionId ? (
            <DropdownMenuItem
              onSelect={() =>
                void navigate({
                  to: "/workspaces/$workspaceId/sessions/$sessionId",
                  params: { workspaceId, sessionId: item.sourceSessionId! },
                })
              }
            >
              <MessageSquareIcon />
              Open source session
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard
                ?.writeText(new URL(artifactPath(workspaceId, item), window.location.origin).href)
                .then(() => toast("Copied a link to this artifact"))
                .catch(() => toast.error("Couldn't copy the link"));
            }}
          >
            <LinkIcon />
            Copy link
          </DropdownMenuItem>
        </>
      }
      menuLabel={`More actions for ${item.title}`}
    />
  );
}

export function ArtifactLibrary({
  workspaceId,
  sessionId,
  items,
  filters,
  onFiltersChange,
  loading,
  error,
  onRetry,
  nextCursor,
  onLoadMore,
  onSelect,
  compact = false,
  emptyAction,
  onEmptyChange,
}: {
  workspaceId: string;
  sessionId?: string;
  items: readonly ArtifactCatalogItem[];
  filters: ArtifactCatalogFilters;
  onFiltersChange: (filters: ArtifactCatalogFilters) => void;
  loading: boolean;
  error?: Error | null;
  onRetry: () => void;
  nextCursor?: string | null;
  onLoadMore?: () => void;
  onSelect?: (item: ArtifactCatalogItem) => void;
  /**
   * The session's artifact panel: no page tabs, so the type filter joins the
   * Filter menu.
   */
  compact?: boolean;
  /** The one action of the first-run empty state ("New artifact"). */
  emptyAction?: ReactNode;
  /** Nothing at all yet: the page hides its header action, the empty state has it. */
  onEmptyChange?: (empty: boolean) => void;
}) {
  const groups = compact ? [TYPE_GROUP, STATUS_GROUP, SORT_GROUP] : [STATUS_GROUP, SORT_GROUP];
  const filterValue = filterValueFor(filters, compact);
  const setFilterValue = (next: ToolbarFilterValue) => {
    const kind = compact ? lastPicked(filterValue, next, "type") : undefined;
    const status = lastPicked(filterValue, next, "status");
    const sort = lastPicked(filterValue, next, "sort");
    onFiltersChange({
      ...filters,
      ...(compact ? { kind: (kind as ArtifactKind | undefined) ?? "all" } : {}),
      status: status === "archived" ? "archived" : "active",
      sort: (sort as ArtifactCatalogFilters["sort"] | undefined) ?? "updated",
    });
  };
  const searching = filters.q.trim().length > 0;
  const narrowed =
    searching ||
    filters.kind !== "all" ||
    filters.status !== "active" ||
    filters.sort !== "updated";
  const nothingAtAll = !loading && !error && items.length === 0 && !narrowed;
  useEffect(() => onEmptyChange?.(nothingAtAll), [nothingAtAll, onEmptyChange]);
  const kindLabel =
    filters.kind === "all"
      ? "artifacts"
      : (artifactKinds.find(([kind]) => kind === filters.kind)?.[1] ?? "").toLocaleLowerCase();

  let body: ReactNode;
  if (error && items.length === 0) {
    body = (
      <Notice
        tone="failed"
        title="Couldn't load artifacts"
        action={
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
        actionLayout="responsive"
      >
        {error.message}
      </Notice>
    );
  } else if (loading && items.length === 0) {
    body = (
      <div role="status" aria-label="Loading artifacts">
        <RowList label="Artifacts" busy>
          <ListRowSkeleton count={4} />
        </RowList>
      </div>
    );
  } else if (nothingAtAll) {
    body = (
      <EmptyState
        variant={compact ? "inline" : "page"}
        icon={<PanelsTopLeftIcon />}
        title="No artifacts yet"
        description="Sites, images, documents, spreadsheets and presentations Geni makes show up here."
        action={emptyAction}
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        variant="inline"
        title={
          searching
            ? `No ${kindLabel} match "${filters.q.trim()}".`
            : filters.status === "archived"
              ? `No archived ${kindLabel}. Archived Sites keep their versions and can be restored.`
              : `No ${kindLabel} yet.`
        }
        action={
          searching || filters.status !== "active" || (compact && filters.kind !== "all") ? (
            <EmptyStateLink
              onClick={() =>
                onFiltersChange(
                  searching
                    ? { ...filters, q: "" }
                    : {
                        ...filters,
                        q: "",
                        status: "active",
                        ...(compact ? { kind: "all" as const } : {}),
                      },
                )
              }
            >
              {searching ? "Clear search" : "Clear filters"}
            </EmptyStateLink>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        <RowList label={searching ? "Search results" : "Artifacts"} busy={loading}>
          {items.map((item) => (
            <ArtifactRow
              key={artifactKey(item)}
              workspaceId={workspaceId}
              item={item}
              sessionId={sessionId}
              onSelect={onSelect}
            />
          ))}
        </RowList>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error.message}
          </p>
        ) : null}
        {nextCursor && onLoadMore ? (
          <Button
            type="button"
            variant="outline"
            className="self-start pointer-coarse:h-11"
            disabled={loading}
            onClick={onLoadMore}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-label={sessionId ? "Session artifact library" : "Artifact library"}
    >
      <div className={nothingAtAll ? "hidden" : "flex min-w-0 flex-col gap-3"}>
        <Toolbar>
          <ToolbarSearch
            value={filters.q}
            onValueChange={(q) => onFiltersChange({ ...filters, q })}
            placeholder="Search artifacts"
            aria-label="Search artifacts by title"
            maxLength={200}
          />
          <ToolbarGroup align="end">
            <ToolbarFilterMenu groups={groups} value={filterValue} onValueChange={setFilterValue} />
          </ToolbarGroup>
        </Toolbar>
        {Object.keys(filterValue).length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <ToolbarFilterChips
              groups={groups}
              value={filterValue}
              onValueChange={setFilterValue}
            />
          </div>
        ) : null}
      </div>
      <div className="min-w-0">{body}</div>
    </section>
  );
}
