import { flushSync } from "react-dom";

/**
 * Live `prefers-reduced-motion` check for JS-driven motion (scroll glides,
 * streaming word reveals). CSS animations are already neutralized globally in
 * styles/index.css; this lets the imperative paths skip their work entirely.
 */
let query: MediaQueryList | null | undefined;

export function prefersReducedMotion(): boolean {
  if (query === undefined) {
    query =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }
  return query?.matches ?? false;
}

/** Test seam: forget the cached MediaQueryList so a stubbed matchMedia applies. */
export function resetReducedMotionCache(): void {
  query = undefined;
}

type ViewTransitionResult = { finished: Promise<void> };
type ViewTransitionCallback = () => void;
type ViewTransitionOptions = {
  update: ViewTransitionCallback;
  types?: string[];
};
type ViewTransitionStarter = {
  (callback: ViewTransitionCallback): ViewTransitionResult;
  (options: ViewTransitionOptions): ViewTransitionResult;
};

/** Active VT type for markdown crystallize — scoped CSS, not a full-page blink. */
export const MARKDOWN_CRYSTALLIZE_VT_TYPE = "og-md-crystallize";

/**
 * Run a DOM update inside the browser View Transition API when available.
 * Snapshots the before/after paint and cross-fades (or custom CSS morphs)
 * between them — the platform "morph" primitive React's experimental
 * `<ViewTransition>` wraps. Falls back to a synchronous update.
 */
export function runViewTransition(update: () => void, options?: { types?: string[] }): void {
  if (prefersReducedMotion()) {
    update();
    return;
  }
  const doc = typeof document !== "undefined" ? document : null;
  const start = doc
    ? ((doc as Document & { startViewTransition?: ViewTransitionStarter }).startViewTransition ??
      null)
    : null;
  if (typeof start !== "function") {
    update();
    return;
  }
  const types = options?.types;
  if (types && types.length > 0) {
    try {
      Reflect.apply(start, doc, [
        {
          update: () => {
            flushSync(update);
          },
          types,
        },
      ]);
      return;
    } catch {
      // Older engines only accept the callback form.
    }
  }
  Reflect.apply(start, doc, [
    () => {
      flushSync(update);
    },
  ]);
}
