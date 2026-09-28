import { useNavigate } from "@tanstack/react-router";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import {
  ImageIcon,
  LayoutGridIcon,
  LinkIcon,
  ListIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelsTopLeftIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useAppContext } from "@/context";
import {
  artifactKey,
  artifactKindLabel,
  artifactKinds,
  artifactPath,
  artifactRoute,
  type ArtifactCatalogFilters,
  type ArtifactKind,
} from "@/lib/artifact-catalog";
import {
  artifactExtension,
  readArtifactView,
  rememberArtifactView,
  type ArtifactView,
} from "@/lib/artifact-library-view";
import { cn } from "@/lib/utils";
import { ArtifactTypeIcon } from "./artifact-page-chrome";

const InlineChatImage = lazy(() =>
  import("./inline-chat-image").then((module) => ({ default: module.InlineChatImage })),
);

const IMAGE_GLYPH = <ImageIcon className="size-4 text-fg-subtle" aria-hidden />;

/** Mount retained-image loaders only near the viewport, not merely their img elements. */
export function ArtifactThumbnail({
  children,
  placeholder = IMAGE_GLYPH,
}: {
  children: ReactNode;
  placeholder?: ReactNode;
}) {
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
      {visible ? children : placeholder}
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

/** Opening an artifact: its own page in the router, or the caller's handler. */
function useArtifactOpen(
  workspaceId: string,
  item: ArtifactCatalogItem,
  sessionId?: string,
  onSelect?: (item: ArtifactCatalogItem) => void,
) {
  const navigate = useNavigate();
  const open = () =>
    onSelect
      ? onSelect(item)
      : void navigate({
          to: artifactRoute(item.kind),
          params: { workspaceId, artifactId: item.id },
          search: sessionId ? { fromSession: sessionId } : {},
        });
  const menu = (
    <>
      <DropdownMenuItem onSelect={open}>
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
  );
  return {
    open,
    menu,
    // Links keep a real href (new tab, copy); a plain click stays in the router.
    link: onSelect
      ? null
      : {
          href: artifactPath(workspaceId, item, sessionId),
          onClick: (event: MouseEvent<HTMLElement>) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            open();
          },
        },
  };
}

/** "updated 3 days ago", the one fact after the type in every meta line. */
function updatedMeta(item: ArtifactCatalogItem) {
  return (
    <span key="updated">
      updated <RelativeTime date={item.updatedAt} inSentence focusable={false} />
    </span>
  );
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
  const { open, menu, link } = useArtifactOpen(workspaceId, item, sessionId, onSelect);
  const archived = item.status === "archived";
  return (
    <ListRow
      // Types are words; only an image shows its own pixels.
      leading={item.kind === "image" ? <ImageTile workspaceId={workspaceId} item={item} /> : null}
      title={item.title}
      meta={[
        artifactKindLabel[item.kind],
        updatedMeta(item),
        item.kind === "file" && item.filename && item.filename !== item.title
          ? item.filename
          : null,
        archived ? (
          <StatusBadge key="status" variant="dot" tone="neutral">
            Archived
          </StatusBadge>
        ) : null,
      ].filter(Boolean)}
      {...(link ? { href: link.href, onOpen: link.onClick } : { onOpen: open })}
      menu={menu}
      menuLabel={`More actions for ${item.title}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

/*
 * A Site's card shows its published HTML as a still: a srcdoc frame with an
 * empty sandbox (no scripts, forms, popups or same-origin) and a policy that
 * blocks every network request, so a card never runs Site code or phones
 * home. The first element of the document is the policy, so it always lands
 * in <head> whatever the Site's own markup.
 */
const SITE_STILL_POLICY =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'";
export function siteStillDocument(html: string) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SITE_STILL_POLICY}"><meta name="color-scheme" content="light">${html}`;
}

// Display HTML per published version, shared across remounts (tabs, search).
const siteHtmlCache = new Map<string, Promise<string>>();
const SITE_HTML_CACHE_LIMIT = 48;

function useSiteHtml(workspaceId: string, item: ArtifactCatalogItem) {
  const { client, accessKeyVersion } = useAppContext();
  const versionId = item.versionId;
  const [state, setState] = useState<{ key: string; html: string | null } | null>(null);
  const key = `${accessKeyVersion}:${workspaceId}:${item.id}:${versionId}`;
  useEffect(() => {
    if (!versionId) return;
    let active = true;
    let request = siteHtmlCache.get(key);
    if (!request) {
      request = client.getWorkspaceArtifactHtml(workspaceId, item.id, { versionId });
      siteHtmlCache.set(key, request);
      if (siteHtmlCache.size > SITE_HTML_CACHE_LIMIT)
        siteHtmlCache.delete(siteHtmlCache.keys().next().value!);
      request.catch(() => siteHtmlCache.delete(key));
    }
    request.then(
      (html) => active && setState({ key, html }),
      () => active && setState({ key, html: null }),
    );
    return () => {
      active = false;
    };
  }, [client, item.id, key, versionId, workspaceId]);
  return state?.key === key ? state.html : undefined;
}

function SiteStill({
  workspaceId,
  item,
  placeholder,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  placeholder: ReactNode;
}) {
  const html = useSiteHtml(workspaceId, item);
  if (!html) return placeholder;
  return (
    // Drawn at three times the card's width and scaled down, like a screenshot;
    // a touch dimmer in dark so a white page doesn't glare.
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden bg-white dark:brightness-[0.88]"
      inert
    >
      <iframe
        title={`Preview of ${item.title}`}
        sandbox=""
        srcDoc={siteStillDocument(html)}
        loading="lazy"
        tabIndex={-1}
        aria-hidden
        className="absolute top-0 left-0 h-[300%] w-[300%] origin-top-left scale-[0.3333] border-0 bg-white"
      />
    </div>
  );
}

/** Types without a still: the type glyph on a quiet tile, and a file's extension. */
function PreviewPlaceholder({ item }: { item: ArtifactCatalogItem }) {
  const extension = item.kind === "file" ? artifactExtension(item) : null;
  return (
    <span className="flex flex-col items-center gap-2 text-fg-subtle">
      <span className="grid size-10 place-items-center rounded-[10px] border border-border bg-surface text-fg-muted">
        <ArtifactTypeIcon kind={item.kind} className="size-5" />
      </span>
      {extension ? (
        <span className="text-2xs leading-4 font-medium text-fg-subtle">.{extension}</span>
      ) : null}
    </span>
  );
}

function ArtifactPreview({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
}) {
  const placeholder = <PreviewPlaceholder item={item} />;
  if (item.kind === "image")
    return (
      <div className="absolute inset-0 [&_img]:size-full [&_img]:object-cover">
        <ArtifactThumbnail placeholder={placeholder}>
          <Suspense fallback={placeholder}>
            <InlineChatImage
              workspaceId={workspaceId}
              artifactId={item.id}
              alt={item.title}
              thumbnail
            />
          </Suspense>
        </ArtifactThumbnail>
      </div>
    );
  if (item.kind === "site" && item.versionId)
    return (
      <div className="absolute inset-0">
        <ArtifactThumbnail placeholder={placeholder}>
          <SiteStill workspaceId={workspaceId} item={item} placeholder={placeholder} />
        </ArtifactThumbnail>
      </div>
    );
  return <div className="absolute inset-0 grid place-items-center">{placeholder}</div>;
}

export function ArtifactCard({
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
  const { open, menu, link } = useArtifactOpen(workspaceId, item, sessionId, onSelect);
  const titleId = useId();
  const archived = item.status === "archived";
  // The title is the card's action, stretched over the whole card; the menu sits above it.
  const actionProps = {
    "aria-labelledby": titleId,
    style: { outline: "none" },
    className:
      "block min-w-0 truncate text-sm leading-5 font-medium text-fg after:absolute after:inset-0 after:z-0 after:rounded-[14px] after:content-['']",
  };
  return (
    <li
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface",
        "transition-colors duration-[120ms] hover:border-border-strong",
        "has-[[data-card-action]:focus-visible]:outline-2 has-[[data-card-action]:focus-visible]:outline-offset-2 has-[[data-card-action]:focus-visible]:outline-brand/55",
      )}
    >
      <div
        className={cn(
          "relative aspect-[16/10] w-full overflow-hidden border-b border-border bg-surface-2",
          archived && "opacity-70 grayscale",
        )}
      >
        <ArtifactPreview workspaceId={workspaceId} item={item} />
      </div>
      {archived ? (
        // On the preview, so the meta line keeps its one fact whole.
        <span className="absolute top-2.5 left-2.5 rounded-full bg-surface">
          <StatusBadge tone="neutral" icon="auto">
            Archived
          </StatusBadge>
        </span>
      ) : null}
      <div className="flex min-w-0 items-start gap-2 px-3.5 pt-3 pb-3.5">
        <div className="min-w-0 flex-1">
          {link ? (
            <a {...actionProps} data-card-action="" href={link.href} onClick={link.onClick}>
              <span id={titleId}>{item.title}</span>
            </a>
          ) : (
            <button
              {...actionProps}
              data-card-action=""
              type="button"
              onClick={open}
              className={cn(actionProps.className, "w-full cursor-pointer text-left")}
            >
              <span id={titleId}>{item.title}</span>
            </button>
          )}
          <p className="mt-0.5 truncate text-xs leading-4.5 text-fg-subtle">
            {artifactKindLabel[item.kind]} · {updatedMeta(item)}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More actions for ${item.title}`}
              className={cn(
                "relative z-10 -mt-1 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-[10px] text-fg-subtle transition-[color,background-color,opacity] duration-[120ms] hover:bg-surface-3 hover:text-fg data-[state=open]:bg-surface-3 data-[state=open]:text-fg pointer-coarse:size-11",
                // Quiet until the card is hovered or focused; always there for touch.
                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100",
              )}
            >
              <MoreHorizontalIcon aria-hidden="true" className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

const GALLERY_GRID =
  "grid min-w-0 grid-cols-1 gap-4 @[560px]:grid-cols-2 @[820px]:grid-cols-3 @[1060px]:grid-cols-4";

function GallerySkeleton() {
  return (
    <ul aria-hidden className={GALLERY_GRID}>
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className="overflow-hidden rounded-[14px] border border-border bg-surface">
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <div className="space-y-2 px-3.5 pt-3 pb-3.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

const VIEW_OPTIONS = [
  { value: "gallery", label: "Gallery", icon: <LayoutGridIcon />, iconOnly: true },
  { value: "list", label: "List", icon: <ListIcon />, iconOnly: true },
] as const;

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
  const [view, setView] = useState<ArtifactView>(readArtifactView);
  const changeView = (next: ArtifactView) => {
    setView(next);
    rememberArtifactView(next);
  };
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
        {view === "gallery" ? (
          <GallerySkeleton />
        ) : (
          <RowList label="Artifacts" busy>
            <ListRowSkeleton count={4} />
          </RowList>
        )}
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
        {view === "gallery" ? (
          <ul
            aria-label={searching ? "Search results" : "Artifacts"}
            aria-busy={loading || undefined}
            className={GALLERY_GRID}
          >
            {items.map((item) => (
              <ArtifactCard
                key={artifactKey(item)}
                workspaceId={workspaceId}
                item={item}
                sessionId={sessionId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : (
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
        )}
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
      className="@container flex min-w-0 flex-col gap-4"
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
            <SegmentedControl<ArtifactView>
              aria-label="Show"
              options={VIEW_OPTIONS}
              value={view}
              onValueChange={changeView}
            />
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
