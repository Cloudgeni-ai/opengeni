import type { ArtifactCatalogItem, RetainedArtifactReference } from "@opengeni/sdk";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, Loader2Icon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { isRetainedImageContentType, useRetainedImageObjectUrl } from "../../../artifacts";
import {
  useZoomPan,
  useZoomPanShortcuts,
  ZoomControls,
  ZoomPanSurface,
  type ZoomPanController,
} from "../../../components/zoom-pan-image";
import { createWorkspaceRetainedArtifactLoader } from "../../../timeline";
import { Button } from "../../../ui/button";
import { containedPortal } from "../../../ui/portal-container";
import { userErrorText } from "../../../ui/api-error";
import { useAppContext } from "../../app-context";
import { EditableArtifactSurface } from "../../lib/app-surfaces";
import { artifactKey, isEditableArtifactKind } from "../../lib/artifact-catalog";
import { saveRetainedArtifact } from "../../lib/retained-artifact-download";
import { toast } from "../../lib/toast";
import { LoadingPanel } from "../common";
import { ArtifactTypeIcon } from "./artifact-page-chrome";
import {
  cachedRetainedArtifactLoader,
  cachedRetainedMetadata,
  retainedImageCache,
  retainedImageScope,
} from "./retained-image-cache";

const RetainedArtifactRoute = lazy(() =>
  import("../../routes/retained-artifact").then((module) => ({
    default: module.RetainedArtifactRoute,
  })),
);
const ArtifactDetailRoute = lazy(() =>
  import("../../routes/artifacts").then((module) => ({ default: module.ArtifactDetailRoute })),
);

const DialogContainedPortal = containedPortal(Dialog.Portal);

/** Images on either side of the one on screen start loading, so stepping is instant. */
const PRELOAD_NEIGHBOURS = 1;
/** A horizontal touch drag at least this long steps to the neighbouring artifact. */
const SWIPE_DISTANCE = 48;

type AppClient = ReturnType<typeof useAppContext>["client"];
type ImageSources = ReturnType<typeof imageSources>;

/** Keys typed here move a caret, a menu or a grid selection; they never step artifacts. */
function ownsArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="listbox"], [role="grid"], [role="slider"]',
    ) !== null
  );
}

function imageSources(client: AppClient, accessKeyVersion: number, workspaceId: string) {
  const cache = retainedImageCache(client);
  return {
    metadata: (artifactId: string) =>
      cachedRetainedMetadata(
        cache,
        retainedImageScope(accessKeyVersion, workspaceId, artifactId),
        () => client.getRetainedArtifact(workspaceId, artifactId),
      ),
    load: cachedRetainedArtifactLoader(
      cache,
      accessKeyVersion,
      workspaceId,
      createWorkspaceRetainedArtifactLoader(client, workspaceId),
    ),
  };
}

function useImageSources(workspaceId: string): ImageSources {
  const { client, accessKeyVersion } = useAppContext();
  return useMemo(
    () => imageSources(client, accessKeyVersion, workspaceId),
    [client, accessKeyVersion, workspaceId],
  );
}

/**
 * Warms the page's retained-image cache for an image the viewer may step to
 * next, so its bytes are already here when it is shown. Failures are ignored:
 * showing the image asks again and reports them.
 */
function preloadImage(sources: ImageSources, artifactId: string) {
  void sources
    .metadata(artifactId)
    .then((artifact) => {
      if (!artifact.available || !isRetainedImageContentType(artifact.contentType)) return null;
      return sources.load(artifact, new AbortController().signal);
    })
    .then((source) => {
      // A signed URL warms the browser's own cache instead.
      if (source && !(source instanceof Uint8Array) && source.url.trim()) {
        const image = new Image();
        image.src = source.url;
      }
    })
    .catch(() => {});
}

/**
 * One large viewer for the artifacts a list shows. It steps through exactly
 * that list in its order, so search, filters and sorting carry over, with the
 * previous/next buttons, the Left/Right arrow keys or a swipe. Images fill the
 * window; every other kind shows the preview it has in the session panel. A
 * Radix dialog over the whole window, like an artifact's full view, so Escape
 * closes it and focus returns to the list.
 */
export function ArtifactViewer({
  workspaceId,
  items,
  currentKey,
  onCurrentKeyChange,
  onClose,
  actions,
}: {
  workspaceId: string;
  items: readonly ArtifactCatalogItem[];
  /** `artifactKey` of the artifact on screen. */
  currentKey: string;
  onCurrentKeyChange: (key: string) => void;
  onClose: () => void;
  /** The current artifact's own menu (Open, Copy link, …), at the end of the header. */
  actions?: ReactNode;
}) {
  const index = items.findIndex((item) => artifactKey(item) === currentKey);
  const item = index >= 0 ? items[index]! : null;
  const content = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const sources = useImageSources(workspaceId);
  // Zoom belongs to the image on screen: stepping starts the next one fitted.
  const zoom = useZoomPan(currentKey);

  // The artifact left the list (archived, deleted, refreshed away): nothing to show.
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);

  const step = useCallback(
    (delta: 1 | -1) => {
      const next = index >= 0 ? items[index + delta] : undefined;
      if (next) onCurrentKeyChange(artifactKey(next));
    },
    [index, items, onCurrentKeyChange],
  );

  const isImage = item?.kind === "image";
  useZoomPanShortcuts(zoom, isImage);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey) return;
      const target = event.target;
      // Keys in another dialog (a share confirmation), a field or a menu stay
      // there, and so do keys inside a document or Site being worked on.
      if (!(target instanceof Node) || !content.current?.contains(target)) return;
      if (ownsArrowKeys(target)) return;
      if (!isImage && body.current?.contains(target)) return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isImage, step]);

  useEffect(() => {
    if (index < 0) return;
    for (let offset = 1; offset <= PRELOAD_NEIGHBOURS; offset++) {
      for (const neighbour of [items[index + offset], items[index - offset]]) {
        if (neighbour?.kind === "image") preloadImage(sources, neighbour.id);
      }
    }
  }, [index, items, sources]);

  // A horizontal swipe on a touch screen steps too.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent) => {
    // A zoomed image pans under the finger instead.
    const zoomed = zoom.view !== null && !zoom.view.fit;
    swipe.current =
      event.pointerType === "touch" && !zoomed ? { x: event.clientX, y: event.clientY } : null;
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  };

  if (!item) return null;
  const count = items.length;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogContainedPortal>
        <Dialog.Content
          ref={content}
          data-artifact-fullscreen
          data-artifact-viewer
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // The keys work at once, and no button lights up a focus ring.
            event.preventDefault();
            content.current?.focus();
          }}
          className="fixed inset-0 z-50 flex h-dvh w-dvw flex-col overflow-hidden bg-surface text-left text-fg outline-hidden"
        >
          <div
            data-window-drag
            className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/80 bg-surface/95 px-2 sm:px-3"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 pointer-coarse:size-11"
              aria-label="Close"
              title="Close (Esc)"
              onClick={onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
            <ArtifactTypeIcon kind={item.kind} className="size-4 shrink-0 text-fg-subtle" />
            <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-medium">
              {item.title}
            </Dialog.Title>
            {item.kind === "image" ? (
              <ZoomControls
                controller={zoom}
                className="mr-1 hidden border-r border-border/80 pr-2 sm:flex"
              />
            ) : null}
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label="Previous"
                title="Previous (←)"
                disabled={index === 0}
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </Button>
              <span
                data-artifact-viewer-position
                aria-live="polite"
                className="min-w-14 text-center text-xs text-fg-muted tabular-nums"
              >
                {index + 1} of {count}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label="Next"
                title="Next (→)"
                disabled={index === count - 1}
                onClick={() => step(1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </Button>
              {item.kind === "image" ? (
                <ImageDownloadButton
                  key={item.id}
                  workspaceId={workspaceId}
                  sources={sources}
                  item={item}
                />
              ) : null}
              {actions}
            </div>
          </div>
          <div
            ref={body}
            data-artifact-viewer-body
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-2"
            {...(item.kind === "image" ? { onPointerDown, onPointerUp } : {})}
          >
            <ViewerBody key={artifactKey(item)} workspaceId={workspaceId} item={item} zoom={zoom} />
          </div>
        </Dialog.Content>
      </DialogContainedPortal>
    </Dialog.Root>
  );
}

/** The image itself, or the preview the artifact has in the session panel. */
function ViewerBody({
  workspaceId,
  item,
  zoom,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  zoom: ZoomPanController;
}) {
  if (item.kind === "image")
    return <ViewerImage workspaceId={workspaceId} item={item} zoom={zoom} />;
  if (isEditableArtifactKind(item.kind))
    return <EditableArtifactSurface workspaceId={workspaceId} artifactId={item.id} embedded />;
  return (
    <Suspense fallback={<LoadingPanel label="Opening artifact" />}>
      {item.kind === "site" ? (
        <ArtifactDetailRoute workspaceId={workspaceId} artifactId={item.id} embedded />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RetainedArtifactRoute workspaceId={workspaceId} artifactId={item.id} embedded />
        </div>
      )}
    </Suspense>
  );
}

/** True once a wait is long enough to notice, so a cached image never flashes a spinner. */
function useNoticeable(waiting: boolean) {
  const [noticeable, setNoticeable] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setNoticeable(false);
      return;
    }
    const timer = setTimeout(() => setNoticeable(true), 250);
    return () => clearTimeout(timer);
  }, [waiting]);
  return noticeable;
}

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; artifact: RetainedArtifactReference }
  | { kind: "failed" };

function usableImage(artifact: { available: boolean }, artifactId: string) {
  const reference = artifact as RetainedArtifactReference;
  return (
    artifact.available &&
    reference.artifactId === artifactId &&
    isRetainedImageContentType(reference.contentType)
  );
}

function ViewerImage({
  workspaceId,
  item,
  zoom,
}: {
  workspaceId: string;
  item: ArtifactCatalogItem;
  zoom: ZoomPanController;
}) {
  const { client, accessKeyVersion } = useAppContext();
  const sources = useImageSources(workspaceId);
  const scope = retainedImageScope(accessKeyVersion, workspaceId, item.id);
  const [retry, setRetry] = useState(0);
  // A preloaded neighbour starts from what this page already has.
  const [state, setState] = useState<ImageState>(() => {
    const cached = retainedImageCache(client).peek<RetainedArtifactReference>(`${scope}meta`);
    return cached && usableImage(cached, item.id)
      ? { kind: "ready", artifact: cached }
      : { kind: "loading" };
  });
  useEffect(() => {
    let active = true;
    void sources
      .metadata(item.id)
      .then((artifact) => {
        if (!active) return;
        setState((current) =>
          !usableImage(artifact, item.id)
            ? { kind: "failed" }
            : current.kind === "ready" && current.artifact === artifact
              ? current
              : { kind: "ready", artifact: artifact as RetainedArtifactReference },
        );
      })
      .catch(() => {
        if (active) setState({ kind: "failed" });
      });
    return () => {
      active = false;
    };
  }, [sources, item.id, retry]);
  // Retry means "fetch again": never answer it from the cache.
  const retryFresh = () => {
    retainedImageCache(client).forget(scope);
    setState({ kind: "loading" });
    setRetry((value) => value + 1);
  };
  const noticeable = useNoticeable(state.kind === "loading");
  if (state.kind === "failed") return <ImageUnavailable title={item.title} onRetry={retryFresh} />;
  if (state.kind === "loading") return <ImageLoading visible={noticeable} />;
  return (
    <ZoomableImage
      key={`${state.artifact.sha256}:${retry}`}
      artifact={state.artifact}
      load={sources.load}
      alt={item.title}
      onRetry={retryFresh}
      zoom={zoom}
    />
  );
}

function ImageLoading({ visible }: { visible: boolean }) {
  return (
    <div role="status" className="absolute inset-0 grid place-items-center text-fg-subtle">
      {visible ? <Loader2Icon aria-hidden className="size-5 animate-spin" /> : null}
      <span className="sr-only">Loading image…</span>
    </div>
  );
}

function ImageUnavailable({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div role="status" className="absolute inset-0 grid place-items-center p-6 text-center">
      <p className="text-sm text-fg-muted">
        {title} couldn't be shown.{" "}
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </p>
    </div>
  );
}

/**
 * The image fitted to the window (small screenshots enlarged up to 2x), with
 * zoom and pan: click for actual size, Cmd/Ctrl + wheel, pinch, the header's
 * buttons or Cmd/Ctrl + plus, minus and zero.
 */
function ZoomableImage({
  artifact,
  load,
  alt,
  onRetry,
  zoom,
}: {
  artifact: RetainedArtifactReference;
  load: ImageSources["load"];
  alt: string;
  onRetry: () => void;
  zoom: ZoomPanController;
}) {
  const image = useRetainedImageObjectUrl(artifact, load);
  const [failed, setFailed] = useState(false);
  const noticeable = useNoticeable(image.kind === "loading");
  if (image.kind === "loading") return <ImageLoading visible={noticeable} />;
  if (image.kind !== "ready" || failed) return <ImageUnavailable title={alt} onRetry={onRetry} />;
  return (
    <ZoomPanSurface
      controller={zoom}
      src={image.url}
      alt={alt}
      naturalSize={artifact.dimensions ?? null}
      onError={() => setFailed(true)}
      imageClassName="rounded-md shadow-og-lg"
      labels={{ zoomIn: "Show at actual size", fit: "Fit to window" }}
    />
  );
}

function ImageDownloadButton({
  workspaceId,
  sources,
  item,
}: {
  workspaceId: string;
  sources: ImageSources;
  item: ArtifactCatalogItem;
}) {
  const { client } = useAppContext();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const artifact = await sources.metadata(item.id);
      if (!usableImage(artifact, item.id)) throw new Error("This image is no longer available.");
      const reference = artifact as RetainedArtifactReference;
      // Usually the bytes on screen, already in the page's cache.
      const source = await sources.load(reference, new AbortController().signal);
      const bytes =
        source instanceof Uint8Array
          ? source
          : (await client.downloadRetainedArtifact(workspaceId, reference)).bytes;
      saveRetainedArtifact(reference, bytes, item.title);
    } catch (error) {
      toast.error("Couldn't download the image", { description: userErrorText(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="pointer-coarse:size-11"
      aria-label="Download"
      title="Download"
      disabled={busy}
      onClick={() => void download()}
    >
      <DownloadIcon aria-hidden="true" />
    </Button>
  );
}
