import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Dialog } from "radix-ui";
import { cn } from "../lib/cn";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";

/* ----------------------------------------------------------------------------
   Screenshot lightbox

   A single, app-level lightbox the computer_call / view_image renderers open by
   `src`. Built on Radix Dialog so it is focus-trapped, ESC-closable, and
   scroll-locked — fixing the v1 mockup's broken expand (an absolutely-positioned
   <img> that overflowed its row). The image is centered, constrained to the
   viewport (`max-w/max-h` + `object-contain`), and sits on a dimmed backdrop.

   Consumers render `<LightboxProvider>` once near the timeline; renderers call
   `useLightbox().open(src)`.
   -------------------------------------------------------------------------- */

type LightboxController = {
  open: (
    src: string,
    caption?: string,
    source?: HTMLElement | null,
    label?: string,
    downloadFilename?: string,
    controlLabels?: LightboxControlLabels,
    releaseSource?: () => void,
  ) => void;
};

export type LightboxControlLabels = {
  download?: string | undefined;
  close?: string | undefined;
  previous?: string | undefined;
  next?: string | undefined;
};

const LightboxContext = createContext<LightboxController | null>(null);

/** One image the open lightbox can page to, resolved only when it is shown. */
export type LightboxGalleryImage = {
  src: string;
  caption?: string | undefined;
  label?: string | undefined;
  /** Releases a source owned by this load, such as an object URL. */
  release?: (() => void) | undefined;
};

export type LightboxGalleryEntry = {
  /** Whether this entry currently resolves to an image; defaults to yes. */
  isImage?: (() => Promise<boolean>) | undefined;
  load: () => Promise<LightboxGalleryImage | null>;
};

type RegisteredGalleryEntry = {
  element: HTMLElement;
  entry: { current: LightboxGalleryEntry };
};

type LightboxGalleryRegistry = {
  register: (item: RegisteredGalleryEntry) => () => void;
};

const LightboxGalleryContext = createContext<LightboxGalleryRegistry | null>(null);

/** Images in one timeline page together; elsewhere the whole document does. */
const GALLERY_ROOT_SELECTOR = "[data-og-timeline-scroller]";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
      null
  );
}

/**
 * Adds the element's image to the lightbox gallery so an open lightbox can page
 * to it with the arrow controls, in document order. The entry is resolved only
 * when it is shown, so deferred images that never scrolled into view still page.
 * A lightbox opened from inside the element starts at this entry.
 */
export function useLightboxGalleryItem(
  ref: RefObject<HTMLElement | null>,
  entry: LightboxGalleryEntry | null,
): void {
  const registry = useContext(LightboxGalleryContext);
  const latest = useRef(entry);
  latest.current = entry;
  const enabled = entry !== null;
  useEffect(() => {
    const element = ref.current;
    if (!registry || !element || !enabled) return;
    return registry.register({
      element,
      entry: latest as { current: LightboxGalleryEntry },
    });
  }, [registry, ref, enabled]);
}

/** Open the app-level screenshot lightbox. No-op outside a `LightboxProvider`. */
export function useLightbox(): LightboxController {
  return useContext(LightboxContext) ?? NOOP;
}

/**
 * The lightbox controller when one is mounted, or `null` outside a
 * `LightboxProvider`. Lets a media primitive degrade to a non-interactive image
 * (rather than a dead "Expand" button that announces an action it cannot do).
 */
export function useLightboxOptional(): LightboxController | null {
  return useContext(LightboxContext);
}

const NOOP: LightboxController = { open: () => {} };

/** @internal Owns one optional retained lightbox source and releases it exactly once. */
export function createLightboxSourceOwner() {
  let releaseCurrent: (() => void) | null = null;
  return {
    replace(release?: (() => void) | undefined) {
      const previous = releaseCurrent;
      releaseCurrent = release ?? null;
      previous?.();
    },
    release() {
      const release = releaseCurrent;
      releaseCurrent = null;
      release?.();
    },
  };
}

/**
 * The app-level screenshot lightbox. Render once near the timeline; renderers
 * call `useLightbox().open(src)`.
 *
 * Idempotent by design: when an ancestor `LightboxProvider` already exists (e.g.
 * a `MessageTimeline` mounted inside an app that already wraps its shell), this
 * one becomes a pass-through and does NOT mount a second focus-trapping Dialog.
 * That keeps `MessageTimeline` self-sufficient (it owns its own provider) while
 * composing cleanly when nested.
 */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const ancestor = useContext(LightboxContext);
  if (ancestor) {
    return <>{children}</>;
  }
  return <LightboxRoot>{children}</LightboxRoot>;
}

function LightboxRoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    src: string;
    caption?: string;
    label: string;
    downloadFilename?: string;
    controlLabels?: LightboxControlLabels;
  } | null>(null);
  const [tokenSource, setTokenSource] = useState<HTMLElement | null>(null);
  const sourceOwner = useMemo(() => createLightboxSourceOwner(), []);
  const portalStyle = usePortalTokenStyle(tokenSource);
  const entries = useRef(new Set<RegisteredGalleryEntry>());
  const [gallery, setGallery] = useState<{
    items: RegisteredGalleryEntry[];
    index: number;
  } | null>(null);
  // Fences stale gallery discovery and navigation after a newer open or step.
  const generation = useRef(0);

  const registry = useMemo<LightboxGalleryRegistry>(
    () => ({
      register(item) {
        entries.current.add(item);
        return () => {
          entries.current.delete(item);
        };
      },
    }),
    [],
  );

  const releaseCurrentSource = useCallback(() => {
    sourceOwner.release();
  }, [sourceOwner]);

  // Unmount also fences in-flight discovery and paging, so a load that settles
  // afterwards releases its own source instead of handing it to a dead owner.
  useEffect(
    () => () => {
      generation.current++;
      releaseCurrentSource();
    },
    [releaseCurrentSource],
  );

  const discoverGallery = useCallback((source: HTMLElement, token: number) => {
    const root = source.closest(GALLERY_ROOT_SELECTOR) ?? source.ownerDocument.body;
    const candidates = [...entries.current]
      .filter((item) => item.element.isConnected && root.contains(item.element))
      .sort((a, b) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    // The innermost entry holding the clicked image comes last in document order.
    const current = candidates.filter((item) => item.element.contains(source)).pop();
    if (!current) return;
    void Promise.all(
      candidates.map((item) =>
        item === current
          ? Promise.resolve(true)
          : (item.entry.current.isImage?.() ?? Promise.resolve(true)).catch(() => false),
      ),
    ).then((images) => {
      if (generation.current !== token) return;
      const items = candidates.filter((_, index) => images[index]);
      if (items.length > 1) setGallery({ items, index: items.indexOf(current) });
    });
  }, []);

  const open = useCallback(
    (
      src: string,
      caption?: string,
      source?: HTMLElement | null,
      label = "Screenshot",
      downloadFilename?: string,
      controlLabels?: LightboxControlLabels,
      releaseSource?: () => void,
    ) => {
      const token = ++generation.current;
      sourceOwner.replace(releaseSource);
      setTokenSource(source ?? null);
      setGallery(null);
      setState({
        src,
        label,
        ...(caption ? { caption } : {}),
        ...(downloadFilename ? { downloadFilename } : {}),
        ...(controlLabels ? { controlLabels } : {}),
      });
      if (source) discoverGallery(source, token);
    },
    [sourceOwner, discoverGallery],
  );

  const close = useCallback(() => {
    generation.current++;
    releaseCurrentSource();
    setState(null);
    setTokenSource(null);
    setGallery(null);
  }, [releaseCurrentSource]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (!gallery) return;
      const token = ++generation.current;
      const count = gallery.items.length;
      void (async () => {
        // Skip entries that no longer resolve, but never loop past the start.
        for (let offset = 1; offset < count; offset++) {
          const index = (((gallery.index + delta * offset) % count) + count) % count;
          const image = await gallery.items[index]!.entry.current.load().catch(() => null);
          if (generation.current !== token) {
            image?.release?.();
            return;
          }
          if (!image) continue;
          sourceOwner.replace(image.release);
          setGallery({ items: gallery.items, index });
          setState((previous) =>
            previous
              ? {
                  src: image.src,
                  label: image.label ?? previous.label,
                  ...(image.caption ? { caption: image.caption } : {}),
                  ...(previous.controlLabels ? { controlLabels: previous.controlLabels } : {}),
                }
              : previous,
          );
          return;
        }
      })();
    },
    [gallery, sourceOwner],
  );

  const galleryOpen = state !== null && gallery !== null;
  useEffect(() => {
    if (!galleryOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      // Arrow keys typed into a field move its caret; they never page images.
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [galleryOpen, step]);

  const controller = useMemo<LightboxController>(() => ({ open }), [open]);

  return (
    <LightboxContext.Provider value={controller}>
      <LightboxGalleryContext.Provider value={registry}>{children}</LightboxGalleryContext.Provider>
      <Dialog.Root open={state !== null} onOpenChange={(next) => !next && close()}>
        <AnimatePresence>
          {state !== null ? (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="og-root fixed inset-0 z-50 bg-black/90 backdrop-blur-md"
                  style={portalStyle}
                />
              </Dialog.Overlay>
              <Dialog.Content
                asChild
                forceMount
                aria-label={state.label}
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  // Content is a full-inset centering wrapper layered above the
                  // Overlay, so Radix's own click-outside (which fires on the
                  // Overlay) can never see a backdrop click — every click lands on
                  // Content. We make Content's own backdrop dismiss: a click whose
                  // target is the wrapper itself (not the figure) closes it, so the
                  // figcaption's "click outside to close" affordance is real.
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      close();
                    }
                  }}
                  className="og-root fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12"
                  style={portalStyle}
                >
                  <Dialog.Title className="sr-only">{state.label}</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    {state.caption ?? `Expanded ${state.label.toLowerCase()}`}
                  </Dialog.Description>
                  {gallery ? (
                    <LightboxStepButton
                      direction="previous"
                      label={state.controlLabels?.previous ?? "Previous image"}
                      onClick={() => step(-1)}
                    />
                  ) : null}
                  {/* The figure is one self-contained object: image, caption, and
                      its own close control. The close button anchors to a wrapper
                      sized to the IMAGE (w-fit), so it hugs the real top-right
                      corner regardless of aspect ratio — never floating into the
                      empty space of a wide figure column. */}
                  <figure className="m-0 flex max-h-full max-w-5xl flex-col items-center gap-3">
                    <div className="relative flex min-h-0 w-fit max-w-full">
                      {/* A plain <img>: this SDK is framework-agnostic, with no host Image component. */}
                      <img
                        src={state.src}
                        alt={state.caption ?? state.label}
                        className="min-h-0 max-h-[82vh] w-auto max-w-full rounded-og-md border border-white/10 object-contain shadow-og-lg"
                      />
                      <ScreenshotLightboxControls
                        src={state.src}
                        downloadFilename={state.downloadFilename}
                        controlLabels={state.controlLabels}
                      />
                    </div>
                    {gallery ? (
                      <figcaption className="flex max-w-2xl flex-col items-center gap-1 text-center font-og-mono text-og-xs">
                        {state.caption ? (
                          <span className="text-white/55">{state.caption}</span>
                        ) : null}
                        <span className="tabular-nums text-white/35" aria-live="polite">
                          {gallery.index + 1} of {gallery.items.length}
                        </span>
                      </figcaption>
                    ) : state.caption ? (
                      <figcaption className="max-w-2xl text-center font-og-mono text-og-xs text-white/55">
                        {state.caption}
                      </figcaption>
                    ) : (
                      <figcaption className="font-og-mono text-og-xs uppercase tracking-[0.1em] text-white/35">
                        Esc or click outside to close
                      </figcaption>
                    )}
                  </figure>
                  {gallery ? (
                    <LightboxStepButton
                      direction="next"
                      label={state.controlLabels?.next ?? "Next image"}
                      onClick={() => step(1)}
                    />
                  ) : null}
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </AnimatePresence>
      </Dialog.Root>
    </LightboxContext.Provider>
  );
}

/** Pages the open lightbox to the neighboring gallery image, wrapping around. */
function LightboxStepButton({
  direction,
  label,
  onClick,
}: {
  direction: "previous" | "next";
  label: string;
  onClick: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "absolute top-1/2 z-10 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-full",
        "border border-white/15 bg-black/60 text-white/70 backdrop-blur",
        "transition-colors hover:border-white/30 hover:text-white",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/50",
        direction === "previous" ? "left-3 sm:left-6" : "right-3 sm:right-6",
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}

/** @internal Exact controls rendered by an open screenshot lightbox. */
export function ScreenshotLightboxControls({
  src,
  downloadFilename,
  controlLabels,
}: {
  src: string;
  downloadFilename?: string | undefined;
  controlLabels?: LightboxControlLabels | undefined;
}) {
  return (
    <div className="absolute -right-3 -top-3 flex items-center gap-2">
      {downloadFilename ? (
        <a
          href={src}
          download={downloadFilename}
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-full",
            "border border-white/15 bg-black/60 text-white/70 backdrop-blur",
            "transition-colors hover:border-white/30 hover:text-white",
          )}
          aria-label={controlLabels?.download ?? `Download ${downloadFilename}`}
        >
          <DownloadIcon className="size-4" />
        </a>
      ) : null}
      <Dialog.Close
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-full",
          "border border-white/15 bg-black/60 text-white/70 backdrop-blur",
          "transition-colors hover:border-white/30 hover:text-white",
        )}
        aria-label={controlLabels?.close ?? "Close"}
      >
        <XIcon className="size-4" />
      </Dialog.Close>
    </div>
  );
}
