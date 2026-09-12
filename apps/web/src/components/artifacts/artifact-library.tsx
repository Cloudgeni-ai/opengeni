import { Link } from "@tanstack/react-router";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import {
  FileIcon,
  FileTextIcon,
  Globe2Icon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
  PresentationIcon,
  SearchIcon,
  Table2Icon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, LoadErrorState } from "@/components/common";
import { cn } from "@/lib/utils";
import {
  artifactKey,
  artifactKindLabel,
  artifactKinds,
  artifactRoute,
  readArtifactView,
  rememberArtifactView,
  type ArtifactCatalogFilters,
  type ArtifactKind,
} from "@/lib/artifact-catalog";
const InlineChatImage = lazy(() =>
  import("./inline-chat-image").then((module) => ({ default: module.InlineChatImage })),
);

const icons = {
  site: Globe2Icon,
  image: ImageIcon,
  document: FileTextIcon,
  spreadsheet: Table2Icon,
  presentation: PresentationIcon,
  file: FileIcon,
};
export function ArtifactTypeIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const Icon = icons[kind];
  return <Icon className={className ?? "size-4"} aria-hidden />;
}

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
      {visible ? children : <ImageIcon className="size-5 text-fg-subtle" aria-hidden />}
    </div>
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
  compact?: boolean;
}) {
  const [view, setView] = useState(readArtifactView);
  const update = (patch: Partial<ArtifactCatalogFilters>) =>
    onFiltersChange({ ...filters, ...patch });
  return (
    <section
      className="@container min-w-0"
      aria-label={sessionId ? "Session artifact library" : "Artifact library"}
    >
      <div className="mb-5 flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <Input
              type="search"
              maxLength={200}
              aria-label="Search artifacts by title"
              placeholder="Search artifacts"
              value={filters.q}
              onChange={(event) => update({ q: event.target.value })}
              className="h-10 pl-9"
            />
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Artifact view">
            {(
              [
                ["grid", LayoutGridIcon],
                ["list", ListIcon],
              ] as const
            ).map(([mode, Icon]) => (
              <Button
                key={mode}
                variant={view === mode ? "secondary" : "ghost"}
                size="icon"
                className="size-10"
                aria-label={`${mode === "grid" ? "Grid" : "List"} view`}
                aria-pressed={view === mode}
                onClick={() => {
                  setView(mode);
                  rememberArtifactView(mode);
                }}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex min-w-full flex-1 flex-wrap gap-1 @4xl:min-w-0"
            role="group"
            aria-label="Artifact type"
          >
            {artifactKinds.map(([kind, label]) => (
              <Button
                key={kind}
                size="sm"
                variant={filters.kind === kind ? "secondary" : "ghost"}
                className="min-h-9 px-2.5"
                aria-pressed={filters.kind === kind}
                onClick={() => update({ kind })}
              >
                {label}
              </Button>
            ))}
          </div>
          <Select
            aria-label="Artifact status"
            className="h-10 text-xs"
            value={filters.status}
            onChange={(event) =>
              update({ status: event.target.value as ArtifactCatalogFilters["status"] })
            }
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
          <Select
            aria-label="Sort artifacts"
            className="h-10 text-xs"
            value={filters.sort}
            onChange={(event) =>
              update({ sort: event.target.value as ArtifactCatalogFilters["sort"] })
            }
          >
            <option value="updated">Recently updated</option>
            <option value="newest">Newest first</option>
            <option value="title">Title</option>
          </Select>
        </div>
      </div>
      {error ? (
        <LoadErrorState title="Couldn't load artifacts" error={error} onRetry={onRetry} />
      ) : null}
      {loading && items.length === 0 ? (
        <div
          role="status"
          aria-label="Loading artifacts"
          className={cn("grid gap-4", compact ? "grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3")}
        >
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className={view === "grid" ? "h-56" : "h-16"} />
          ))}
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState>
          {filters.q || filters.kind !== "all"
            ? "No matching artifacts. Try another title or type."
            : filters.status === "archived"
              ? "No archived artifacts."
              : "No artifacts yet. Ask Geni to create a Site, image, document, spreadsheet, or presentation."}
        </EmptyState>
      ) : null}
      <ul
        aria-label="Artifacts"
        aria-busy={loading}
        className={
          view === "grid"
            ? cn(
                "grid min-w-0 gap-4",
                compact ? "grid-cols-1 @[360px]:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-3",
              )
            : "divide-y divide-border"
        }
      >
        {items.map((item) => {
          const contents = (
            <>
              <div
                className={cn(
                  "flex shrink-0 items-center justify-center overflow-hidden bg-surface-2",
                  view === "grid" ? "aspect-[16/10] w-full rounded-lg" : "size-12 rounded-md",
                )}
              >
                {item.kind === "image" ? (
                  <ArtifactThumbnail>
                    <Suspense
                      fallback={
                        <span role="status" className="p-2 text-xs text-fg-subtle">
                          Loading image…
                        </span>
                      }
                    >
                      <InlineChatImage
                        workspaceId={workspaceId}
                        artifactId={item.id}
                        alt={item.title}
                        thumbnail
                      />
                    </Suspense>
                  </ArtifactThumbnail>
                ) : (
                  <div
                    className={cn(
                      "flex min-w-0 flex-col items-center gap-3 px-5 text-center text-fg-subtle",
                      view === "list" && "gap-0 px-0",
                    )}
                  >
                    <ArtifactTypeIcon
                      kind={item.kind}
                      className={view === "grid" ? "size-8 stroke-[1.25]" : "size-5"}
                    />
                    {view === "grid" ? (
                      <>
                        <span className="text-sm text-fg-muted">
                          {artifactKindLabel[item.kind]}
                        </span>
                        <span className="text-xs">
                          {item.kind === "file"
                            ? item.filename || "Download file"
                            : item.versionId
                              ? "Preview not available"
                              : "No published preview"}
                        </span>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
              <div className={cn("min-w-0", view === "grid" ? "px-1 pb-1 pt-3" : "flex-1")}>
                <h2 className="truncate text-sm font-medium text-fg" title={item.title}>
                  {item.title}
                </h2>
                <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-fg-subtle">
                  <span>{artifactKindLabel[item.kind]}</span>
                  {item.status === "archived" ? <span>Archived</span> : null}
                  <time dateTime={item.updatedAt}>Updated {formatCatalogDate(item.updatedAt)}</time>
                </p>
              </div>
            </>
          );
          const className = cn(
            "group block min-w-0 w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            view === "grid"
              ? "hover:bg-surface/60"
              : "flex items-center gap-3 px-2 py-3 hover:bg-surface/60",
          );
          return (
            <li key={artifactKey(item)} className="min-w-0">
              {onSelect ? (
                <button
                  type="button"
                  className={className}
                  aria-label={`Open ${item.title}`}
                  onClick={() => onSelect(item)}
                >
                  {contents}
                </button>
              ) : (
                <Link
                  to={artifactRoute(item.kind)}
                  params={{ workspaceId, artifactId: item.id }}
                  search={sessionId ? { fromSession: sessionId } : {}}
                  className={className}
                  aria-label={`Open ${item.title}`}
                >
                  {contents}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {nextCursor && onLoadMore ? (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading artifacts…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function formatCatalogDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
