import type { ConsoleMessage, Page, Request, Response } from "playwright";

/** Observe only the reload capability window; never drain unrelated network
 * traffic, alter responses, or authorize extra errors. Request objects bind
 * terminals; console delivery is an independent exact-URL multiset, not a
 * fabricated request/console ID correlation. No cookie authority is inferred.
 */
export function observeReloadCapabilities(
  page: Page,
  expected: { url: string; actorEpoch: string; actorEpochHeader: string; phase: () => string },
) {
  const phase = expected.phase();
  const reads = new Map<Request, { responded: boolean; finished: boolean }>();
  let consoles = 0;
  let problem: string | null = null;
  let sealed = false;
  const startedAt = performance.now();
  let rejectedAtMs: number | null = null;
  let sealedAt: number | null = null;
  let firstLateRequestAfterSealMs: number | null = null;
  const isCapability = (url: string) => new URL(url).pathname.endsWith("/stream-capabilities");
  const reject = (reason: string) => {
    if (problem === null) {
      problem = reason;
      rejectedAtMs = performance.now() - startedAt;
    }
  };
  const request = (read: Request) => {
    if (!isCapability(read.url())) return;
    if (sealedAt !== null && firstLateRequestAfterSealMs === null)
      firstLateRequestAfterSealMs = performance.now() - sealedAt;
    if (
      sealed ||
      reads.size >= 2 ||
      read.url() !== expected.url ||
      read.method() !== "GET" ||
      read.frame() !== page.mainFrame() ||
      !/^\d+$/.test(expected.actorEpoch) ||
      read.headers()[expected.actorEpochHeader] !== expected.actorEpoch ||
      expected.phase() !== phase
    )
      reject(
        `request identity/count mismatch: ${JSON.stringify({
          sealed,
          excess: reads.size >= 2,
          urlMatches: read.url() === expected.url,
          methodMatches: read.method() === "GET",
          frameMatches: read.frame() === page.mainFrame(),
          epochValid: /^\d+$/.test(expected.actorEpoch),
          epochMatches: read.headers()[expected.actorEpochHeader] === expected.actorEpoch,
          phaseMatches: expected.phase() === phase,
        })}`,
      );
    reads.set(read, { responded: false, finished: false });
  };
  const response = (value: Response) => {
    if (!isCapability(value.url())) return;
    const state = reads.get(value.request());
    if (!state || state.responded || value.status() !== 404 || expected.phase() !== phase)
      reject("unmatched or unexpected response");
    else state.responded = true;
  };
  const finished = (read: Request) => {
    const state = reads.get(read);
    if (state) state.finished = true;
  };
  const failed = (read: Request) => {
    if (reads.has(read)) reject("request failed");
  };
  const console = (message: ConsoleMessage) => {
    const url = message.location().url;
    if (message.type() !== "error" || !url || !isCapability(url)) return;
    if (
      url !== expected.url ||
      expected.phase() !== phase ||
      message.text() !==
        "Failed to load resource: the server responded with a status of 404 (Not Found)"
    )
      reject("unmatched console delivery");
    if (++consoles > 2) reject("excess console delivery");
  };
  page.on("request", request);
  page.on("response", response);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  page.on("console", console);
  return {
    async wait(timeoutMs = 5_000) {
      // Freeze identities already dispatched by this gate. Later requests
      // cannot replace a missing read or borrow the two existing allowances.
      sealed = true;
      sealedAt ??= performance.now();
      const requestsAtSeal = reads.size;
      if (reads.size !== 2) reject("request identity/count mismatch: missing dispatches at seal");
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        if (problem) {
          // Failure-only diagnostic window: identities remain sealed and this
          // branch always throws, even if a delayed second request arrives.
          if (problem === "request identity/count mismatch: missing dispatches at seal")
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          throw new Error(
            `reload capability ${problem}; observation=${JSON.stringify({
              requests: reads.size,
              requestsAtSeal,
              firstLateRequestAfterSealMs,
              responded: [...reads.values()].filter((read) => read.responded).length,
              finished: [...reads.values()].filter((read) => read.finished).length,
              consoles,
              sealed,
              rejectedAtMs,
              elapsedMs: performance.now() - startedAt,
              phaseMatches: expected.phase() === phase,
            })}`,
          );
        }
        if (expected.phase() !== phase) throw new Error("reload capability phase changed");
        if ([...reads.values()].every((read) => read.responded && read.finished) && consoles === 2)
          return;
        if (performance.now() >= deadline)
          throw new Error("reload capability response/console timeout");
        // A bounded exact completion predicate, never an elapsed-quiet test.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    dispose() {
      page.off("request", request);
      page.off("response", response);
      page.off("requestfinished", finished);
      page.off("requestfailed", failed);
      page.off("console", console);
    },
  };
}
