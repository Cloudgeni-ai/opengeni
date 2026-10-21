/**
 * Notices when the page wakes from a suspension it could not observe: a
 * laptop sleep, a frozen tab, or a network that came back. Live streams on a
 * page that slept usually died with it, while the hidden-tab signal never
 * fired (or its grace timer could not run), so they would otherwise wait for
 * a heartbeat timeout before reconnecting.
 *
 * Detection: a light timer compares wall-clock time between ticks (timers do
 * not run while the machine sleeps, but the wall clock moves on), checked
 * again when the page becomes visible, plus the `online`, `resume` (Page
 * Lifecycle) and bfcache `pageshow` events. One shared detector serves every
 * subscriber and stops with the last one.
 */

/** How often the wall clock is sampled while anyone listens. */
export const PAGE_WAKE_CHECK_INTERVAL_MS = 2_000;
/** A tick this long after the previous one means the page was suspended. */
export const PAGE_WAKE_GAP_MS = 15_000;

type PageWakeListener = () => void;

const listeners = new Set<PageWakeListener>();
let stopDetector: (() => void) | null = null;

/** Call `listener` on every detected wake; returns the unsubscribe. */
export function subscribePageWake(listener: PageWakeListener): () => void {
  listeners.add(listener);
  stopDetector ??= startDetector();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopDetector) {
      stopDetector();
      stopDetector = null;
    }
  };
}

function emitPageWake(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One subscriber cannot keep the others asleep.
    }
  }
}

function startDetector(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  let lastTick = Date.now();
  const check = () => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    if (elapsed > PAGE_WAKE_GAP_MS) emitPageWake();
  };
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") check();
  };
  const onPageShow = (event: Event) => {
    lastTick = Date.now();
    if ((event as PageTransitionEvent).persisted) emitPageWake();
  };
  const onResume = () => {
    lastTick = Date.now();
    emitPageWake();
  };
  const timer = setInterval(check, PAGE_WAKE_CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("resume", onResume);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onResume);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onResume);
  };
}
