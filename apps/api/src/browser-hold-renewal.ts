import type { Observability } from "@opengeni/observability";
import {
  BROWSER_HOLD_RENEWAL_INTERVAL_MS,
  type BrowserHoldRenewal,
} from "./routes/browser-sessions";

/**
 * Renews, every `intervalMs`, the idle hold of every browser an agent session
 * holds while it works or waits (see `renewBrowserHolds`), so the browser's
 * controller does not release it as unused while its agent is busy elsewhere
 * or deliberately waiting. Each API process runs one; their renewals overlap
 * harmlessly because a hold only ever extends. One pass at a time; returns a
 * stop function that waits for the pass in flight.
 */
export function startBrowserHoldRenewalPump(
  renew: () => Promise<BrowserHoldRenewal>,
  observability?: Pick<Observability, "error" | "warn">,
  intervalMs = BROWSER_HOLD_RENEWAL_INTERVAL_MS,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = renew()
      .then((renewal) => {
        // More browsers are held than one pass renews: the least recently
        // used ones fall back to their plain idle release.
        if (renewal.capped) {
          observability?.warn("Browser hold renewal reached its per-pass limit", {
            listed: renewal.listed,
            held: renewal.held,
          });
        }
      })
      .catch((error: unknown) => {
        observability?.error("Browser hold renewal failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  queueMicrotask(tick);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
