import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactCatalogItem } from "@opengeni/sdk";

import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { artifactRoute, type ArtifactCatalogFilters } from "@/lib/artifact-catalog";
import { artifactLibraryFilters, artifactLibrarySearch } from "@/lib/artifact-library-navigation";
import { useArtifactCatalog } from "@/lib/use-artifact-catalog";
import type { ArtifactReturnSearch } from "@/lib/routes";

type BrowseProps = { workspaceId: string; artifactId: string; fromSession?: string };

const keyboardBoundary = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="grid"]',
  '[role="treegrid"]',
  '[role="tablist"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  "dialog",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
].join(",");

function hasOpenDialog() {
  return [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]',
    ),
  ].some((element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"], [data-state="closed"]'))
      return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Only list-origin artifact pages participate; direct/chat links do not fetch a list. */
export function ArtifactBrowseControls({ workspaceId, artifactId, fromSession }: BrowseProps) {
  const search = useSearch({ strict: false }) as ArtifactReturnSearch;
  if (search.browse !== true) return null;
  return (
    <BrowseControls
      workspaceId={workspaceId}
      artifactId={artifactId}
      fromSession={fromSession ?? search.fromSession}
      filters={artifactLibraryFilters(search)}
    />
  );
}

function BrowseControls({
  workspaceId,
  artifactId,
  fromSession,
  filters,
}: BrowseProps & { filters: ArtifactCatalogFilters }) {
  const { client, accessKeyVersion } = useAppContext();
  const catalog = useArtifactCatalog(client, workspaceId, filters, accessKeyVersion);
  const { loadMore, nextCursor } = catalog;
  const { kind, q, sort, status } = filters;
  const location = useLocation();
  const navigate = useNavigate();
  const controls = useRef<HTMLElement>(null);
  const search = useMemo(
    () => artifactLibrarySearch({ kind, q, sort, status }, fromSession, true),
    [kind, q, sort, status, fromSession],
  );
  const contextKey = JSON.stringify([
    workspaceId,
    artifactId,
    location.href,
    accessKeyVersion,
    search,
  ]);
  const [pendingNext, setPendingNext] = useState<{
    contextKey: string;
    client: typeof client;
    cursors: string[];
  } | null>(null);
  // IDs can collide across Site, retained-file and editable-artifact stores.
  const index = catalog.items.findIndex(
    (item) =>
      item.id === artifactId &&
      location.pathname.replace(/\/$/, "") ===
        artifactRoute(item.kind)
          .replace("$workspaceId", encodeURIComponent(workspaceId))
          .replace("$artifactId", encodeURIComponent(artifactId)),
  );
  const previous = index > 0 ? catalog.items[index - 1] : undefined;
  const next = index >= 0 ? catalog.items[index + 1] : undefined;
  const waiting = pendingNext?.contextKey === contextKey && pendingNext.client === client;
  const busy = catalog.loading || waiting;
  const navigateTo = useCallback(
    (item: ArtifactCatalogItem) =>
      void navigate({
        to: artifactRoute(item.kind),
        params: { workspaceId, artifactId: item.id },
        search,
        replace: true,
      }),
    [navigate, workspaceId, search],
  );

  // loadMore returns void: navigate from the committed list, never an async
  // closure. Unmounting removes this effect; route/filter/authority changes
  // invalidate the captured context before a delayed page can navigate.
  useEffect(() => {
    if (!pendingNext) return;
    if (pendingNext.contextKey !== contextKey || pendingNext.client !== client) {
      setPendingNext(null);
      return;
    }
    if (catalog.loading) return;
    // An empty/duplicate-only page is not EOF. Follow each new cursor until
    // an ordered sibling arrives; never spin on a cursor the server repeated.
    if (
      !catalog.error &&
      !next &&
      index >= 0 &&
      nextCursor &&
      !pendingNext.cursors.includes(nextCursor)
    ) {
      setPendingNext({ ...pendingNext, cursors: [...pendingNext.cursors, nextCursor] });
      loadMore();
      return;
    }
    setPendingNext(null);
    if (!catalog.error && next) navigateTo(next);
  }, [
    pendingNext,
    contextKey,
    client,
    catalog.loading,
    catalog.error,
    next,
    index,
    nextCursor,
    loadMore,
    navigateTo,
  ]);

  const move = useCallback(
    (direction: "previous" | "next") => {
      if (busy || index < 0) return false;
      const item = direction === "previous" ? previous : next;
      if (item) navigateTo(item);
      else if (direction === "next" && nextCursor) {
        setPendingNext({ contextKey, client, cursors: [nextCursor] });
        loadMore();
      } else return false;
      return true;
    },
    [busy, index, previous, next, navigateTo, nextCursor, loadMore, contextKey, client],
  );

  useEffect(() => {
    const pageOrControls = (target: EventTarget | null) =>
      target === window ||
      target === document ||
      target === document.body ||
      target === document.documentElement ||
      (target instanceof Element && target.matches('[data-slot="detail-page-title"]')) ||
      (target instanceof Node && Boolean(controls.current?.contains(target)));
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      if (
        !pageOrControls(event.target) ||
        !pageOrControls(document.activeElement) ||
        event
          .composedPath()
          .some((target) => target instanceof Element && target.closest(keyboardBoundary)) ||
        document.activeElement?.closest(keyboardBoundary) ||
        hasOpenDialog()
      )
        return;
      if (move(event.key === "ArrowLeft" ? "previous" : "next")) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [move]);

  const unavailable = busy
    ? waiting
      ? "Loading more artifacts…"
      : "Loading artifact list…"
    : index < 0
      ? catalog.error
        ? "Artifact list could not be loaded. Return to Artifacts to retry."
        : "This artifact is not in the loaded list."
      : undefined;
  const position =
    index >= 0
      ? `${index + 1} of ${catalog.items.length}${catalog.nextCursor ? " loaded" : ""}`
      : catalog.loading
        ? "Loading artifacts…"
        : catalog.error
          ? "List unavailable"
          : "Not in loaded list";
  const buttonClass = "pointer-coarse:min-h-11";
  return (
    <nav
      ref={controls}
      aria-label="Browse artifacts"
      aria-busy={busy}
      className="flex flex-wrap items-center gap-2"
    >
      {previous && !busy ? (
        <Button asChild variant="outline" size="sm" className={buttonClass}>
          <Link
            to={artifactRoute(previous.kind)}
            params={{ workspaceId, artifactId: previous.id }}
            search={search}
            replace
            aria-label="Previous artifact"
            aria-keyshortcuts="ArrowLeft"
            title="Previous artifact (←)"
          >
            <ArrowLeftIcon aria-hidden /> Previous
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={buttonClass}
          disabled
          aria-label="Previous artifact"
          title={unavailable ?? "First artifact in this list."}
        >
          <ArrowLeftIcon aria-hidden /> Previous
        </Button>
      )}
      <span role="status" aria-atomic="true" className="text-xs tabular-nums text-fg-muted">
        {position}
      </span>
      {next && !busy ? (
        <Button asChild variant="outline" size="sm" className={buttonClass}>
          <Link
            to={artifactRoute(next.kind)}
            params={{ workspaceId, artifactId: next.id }}
            search={search}
            replace
            aria-label="Next artifact"
            aria-keyshortcuts="ArrowRight"
            title="Next artifact (→)"
          >
            Next <ArrowRightIcon aria-hidden />
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={buttonClass}
          disabled={busy || index < 0 || !catalog.nextCursor}
          onClick={() => move("next")}
          aria-label="Next artifact"
          aria-keyshortcuts="ArrowRight"
          title={
            unavailable ??
            (catalog.nextCursor
              ? catalog.error
                ? "Could not load more artifacts. Try again."
                : "Load more artifacts and open the next one."
              : "Last artifact in this list.")
          }
        >
          Next{" "}
          {waiting ? (
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          ) : (
            <ArrowRightIcon aria-hidden />
          )}
        </Button>
      )}
    </nav>
  );
}
