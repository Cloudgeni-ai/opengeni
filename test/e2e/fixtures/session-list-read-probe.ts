import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { notifySessionListChanged } from "../../../packages/react/src/app/lib/session-list-invalidation";

// Imported before the real app entry point so this observes every SDK read,
// including response-body consumption and legacy summary projection. A native
// requestfinished event is earlier than completion of the rail's loader.
const pending = new Set<Promise<unknown>>();
let notifications = 0;
let busyChecks = 0;
let completionHeld = false;
let releaseCompletion: (() => void) | undefined;
let nextCompletionGate: Promise<void> | undefined;
const originalRead = OpenGeniBrowserClient.prototype.listSessionSummaryPage;
OpenGeniBrowserClient.prototype.listSessionSummaryPage = function (workspaceId, options = {}) {
  if (options.parentSessionId !== null || options.search)
    return originalRead.call(this, workspaceId, options);
  const gate = nextCompletionGate;
  nextCompletionGate = undefined;
  const read = originalRead.call(this, workspaceId, options);
  const result = gate
    ? read.then(async (value) => {
        completionHeld = true;
        await gate;
        completionHeld = false;
        return value;
      })
    : read;
  pending.add(result);
  // The hook awaits this SDK promise and then its loader promise. Retire the
  // observation in a subsequent task, after those microtask continuations,
  // rather than racing them with the observer's own promise reaction.
  const settled = () => {
    setTimeout(() => pending.delete(result), 0);
  };
  void result.then(settled, settled);
  return result;
};

export function snapshot() {
  return { pending: pending.size, notifications, busyChecks, completionHeld };
}

export function holdNextRootReadCompletion() {
  if (releaseCompletion) throw new Error("A root read completion is already held");
  nextCompletionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
}

export function releaseRootReadCompletion() {
  releaseCompletion?.();
  releaseCompletion = undefined;
}

export function invalidateIdleRootBrowseRead(workspaceId: string, header: string) {
  // This check and notification share one browser task, after settled SDK
  // promises and their hook continuations have drained. No timer, response or
  // module import can slip a new read between the check and the notification.
  if (pending.size > 0) {
    busyChecks += 1;
    return { ...snapshot(), started: null };
  }
  const pageScope: WindowOrWorkerGlobalScope = window;
  const originalFetch = pageScope.fetch;
  let started = false;
  const taggingFetch: WindowOrWorkerGlobalScope["fetch"] = function (this: unknown, input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (
      url.pathname === `/v1/workspaces/${workspaceId}/sessions` &&
      url.searchParams.get("parentSessionId") === "null" &&
      !url.searchParams.get("search") &&
      !url.searchParams.has("cursor")
    ) {
      started = true;
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set(header, "1");
      return originalFetch.call(this, input, { ...init, headers });
    }
    return originalFetch.call(this, input, init);
  };
  pageScope.fetch = taggingFetch;
  try {
    notifications += 1;
    notifySessionListChanged({ workspaceId, sessionId: "remote-change" });
  } finally {
    pageScope.fetch = originalFetch;
  }
  return { ...snapshot(), started };
}
