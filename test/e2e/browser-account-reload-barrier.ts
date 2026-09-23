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
  const isCapability = (url: string) => new URL(url).pathname.endsWith("/stream-capabilities");
  const reject = (reason: string) => {
    problem ??= reason;
  };
  const request = (read: Request) => {
    if (!isCapability(read.url())) return;
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
      reject("request identity/count mismatch");
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
      if (reads.size !== 2) reject("request identity/count mismatch");
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        if (problem) throw new Error(`reload capability ${problem}`);
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
