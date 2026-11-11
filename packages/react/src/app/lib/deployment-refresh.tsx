export const DEPLOYMENT_REFRESH_INTERVAL_MS = 60_000;

/** One read at a time; returning to an online, visible tab checks immediately. */
export function startDeploymentRefresh(
  read: (signal: AbortSignal) => Promise<unknown>,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let checkOnSettlement = false;
  const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (!stopped && available()) timer = setTimeout(check, DEPLOYMENT_REFRESH_INTERVAL_MS);
  };
  async function check() {
    clearTimer();
    if (stopped || active || !available()) return;
    const controller = new AbortController();
    active = controller;
    try {
      await read(controller.signal);
    } catch {
      // A failed background read must leave the current app usable.
    } finally {
      active = null;
      if (!stopped && checkOnSettlement) {
        checkOnSettlement = false;
        void check();
      } else schedule();
    }
  }
  const onAvailabilityChange = () => {
    clearTimer();
    if (!available()) {
      active?.abort();
      return;
    }
    if (active?.signal.aborted) checkOnSettlement = true;
    else void check();
  };
  document.addEventListener("visibilitychange", onAvailabilityChange);
  window.addEventListener("online", onAvailabilityChange);
  window.addEventListener("offline", onAvailabilityChange);
  schedule();
  return () => {
    stopped = true;
    clearTimer();
    active?.abort();
    document.removeEventListener("visibilitychange", onAvailabilityChange);
    window.removeEventListener("online", onAvailabilityChange);
    window.removeEventListener("offline", onAvailabilityChange);
  };
}
