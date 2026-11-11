import type { Page, Request } from "playwright";

const CAPACITY = 128;
const PATH = "/v1/workspaces/:workspace/knowledge/entries/search";
const PHASES = [
  "setup",
  "sign-in",
  "response-wait",
  "response-assertion",
  "quiescence",
  "browser-assertion",
] as const;
const BROWSER_KINDS = [
  "installed",
  "listener-added",
  "listener-removed",
  "listener-invoked",
  "listener-returned",
  "listener-threw",
  "event-dispatch",
  "event-returned",
  "visibilitychange",
  "focus",
  "blur",
  "pagehide",
  "pageshow",
  "DOMContentLoaded",
  "snapshot",
] as const;
type Phase = (typeof PHASES)[number];
type BrowserKind = (typeof BROWSER_KINDS)[number];
type Method = "GET" | "POST" | "OPTIONS" | "HEAD" | "other";
type RequestIdentity = {
  requestId: number;
  method: Method;
  path: typeof PATH;
  hasQuery: boolean;
  matchesWaiter: boolean;
};
type BrowserEntry = {
  kind: BrowserKind;
  ms: number;
  iteration: number | null;
  visibility: "visible" | "hidden" | "unavailable";
  readyState: "loading" | "interactive" | "complete" | "unavailable";
  focused: boolean;
  knownListeners: number | null;
  listenerId: number | null;
};
export type FiniteReviewDiagnosticsWindow = Window & {
  __opengeniFiniteReviewReadDiagnostics?: {
    markIteration(iteration: number): void;
    snapshot(): unknown;
  };
};
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;
const milliseconds = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER / 1000
    ? Math.round(value * 1000) / 1000
    : null;

/** Return one literal route, never an origin, userinfo, identifier, query or fragment. */
export function finiteReviewDiagnosticPath(value: unknown): typeof PATH | null {
  return finiteReviewDiagnosticURL(value)?.path ?? null;
}

function finiteReviewDiagnosticURL(
  value: unknown,
): Omit<RequestIdentity, "requestId" | "method"> | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value, "http://diagnostic.invalid");
    return /^https?:$/u.test(url.protocol) &&
      /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/search$/u.test(url.pathname)
      ? {
          path: PATH,
          hasQuery: url.search !== "",
          matchesWaiter: value.endsWith("/knowledge/entries/search"),
        }
      : null;
  } catch {
    return null;
  }
}

/** Serialized by Playwright: keep this function self-contained and synchronous. */
export function installFiniteReviewBrowserCapture({ capacity }: { capacity: number }) {
  if (window.top !== window) return;
  const target = window as FiniteReviewDiagnosticsWindow;
  const eventName = "opengeni:knowledge-review-updated";
  const limit = Number.isInteger(capacity) ? Math.max(1, Math.min(128, capacity)) : 128;
  const events: BrowserEntry[] = [];
  let dropped = 0;
  let iteration: number | null = null;
  let listenerOrdinal = 0;
  let knownListeners = 0;
  let unknownOptions = false;
  let registrations = 0;
  let removals = 0;
  let invocations = 0;
  const listeners = new WeakMap<
    EventListener,
    { wrapper: EventListener; id: number; capture: [boolean, boolean] }
  >();
  const add = window.addEventListener;
  const remove = window.removeEventListener;
  const dispatch = window.dispatchEvent;
  const record = (kind: BrowserKind, listenerId: number | null = null) => {
    // Observation must never replace an application callback's result/error.
    try {
      if (events.length === limit) {
        events.shift();
        dropped++;
      }
      events.push({
        kind,
        listenerId,
        iteration,
        ms: performance.now(),
        visibility:
          document.visibilityState === "visible"
            ? "visible"
            : document.visibilityState === "hidden"
              ? "hidden"
              : "unavailable",
        readyState: document.readyState,
        focused: document.hasFocus(),
        knownListeners: unknownOptions ? null : knownListeners,
      });
    } catch {
      /* Best-effort diagnostics only. */
    }
  };
  window.addEventListener = function (
    this: Window,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (this !== window || type !== eventName || listener === null)
      return Reflect.apply(add, this, [type, listener, options]);
    if (typeof listener !== "function") {
      const result = Reflect.apply(add, this, [type, listener, options]);
      registrations++;
      unknownOptions = true;
      record("listener-added");
      return result;
    }
    let entry = listeners.get(listener);
    if (!entry) {
      const id = ++listenerOrdinal;
      const wrapper: EventListener = function (this: EventTarget, event) {
        invocations++;
        record("listener-invoked", id);
        let returned = false;
        try {
          const result = Reflect.apply(listener, this, [event]);
          returned = true;
          return result;
        } finally {
          record(returned ? "listener-returned" : "listener-threw", id);
        }
      };
      entry = { wrapper, id, capture: [false, false] };
      listeners.set(listener, entry);
    }
    // One wrapper per original function preserves native duplicate, removal,
    // once, passive and signal semantics. Forward options without reading any
    // getters. Only omitted/boolean options have a known registration count.
    const result = Reflect.apply(add, this, [type, entry.wrapper, options]);
    registrations++;
    if (options === undefined || typeof options === "boolean") {
      const index = options === true ? 1 : 0;
      if (!entry.capture[index]) {
        entry.capture[index] = true;
        knownListeners++;
      }
    } else unknownOptions = true;
    record("listener-added", entry.id);
    return result;
  } as typeof window.addEventListener;
  window.removeEventListener = function (
    this: Window,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    const entry =
      this === window && type === eventName && typeof listener === "function"
        ? listeners.get(listener)
        : undefined;
    const result = Reflect.apply(remove, this, [type, entry?.wrapper ?? listener, options]);
    if (entry) {
      removals++;
      if (options === undefined || typeof options === "boolean") {
        const index = options === true ? 1 : 0;
        if (entry.capture[index]) {
          entry.capture[index] = false;
          knownListeners--;
        }
      } else unknownOptions = true;
      record("listener-removed", entry.id);
    } else if (
      this === window &&
      type === eventName &&
      listener !== null &&
      typeof listener !== "function"
    ) {
      removals++;
      unknownOptions = true;
      record("listener-removed");
    }
    return result;
  } as typeof window.removeEventListener;
  window.dispatchEvent = function (event) {
    if (this !== window || event.type !== eventName) return Reflect.apply(dispatch, this, [event]);
    record("event-dispatch");
    const result = Reflect.apply(dispatch, this, [event]);
    record("event-returned");
    return result;
  };
  for (const kind of ["focus", "blur", "pagehide", "pageshow", "DOMContentLoaded"] as const)
    Reflect.apply(add, window, [kind, () => record(kind)]);
  document.addEventListener("visibilitychange", () => record("visibilitychange"));
  target.__opengeniFiniteReviewReadDiagnostics = {
    markIteration(value) {
      iteration = Number.isInteger(value) && value >= 0 && value < 100 ? value : null;
    },
    snapshot() {
      record("snapshot");
      return {
        events: events.map((entry) => ({ ...entry })),
        dropped,
        registrations,
        removals,
        invocations,
        knownListeners: unknownOptions ? null : knownListeners,
      };
    },
  };
  record("installed");
}

/** Allowlist the page boundary as well; no arbitrary browser-provided strings. */
export function sanitizeFiniteReviewBrowserCapture(value: unknown) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const entries = Array.isArray(raw.events) ? raw.events : [];
  const events: BrowserEntry[] = [];
  for (const entry of entries.slice(-CAPACITY)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (!BROWSER_KINDS.includes(record.kind as BrowserKind) || milliseconds(record.ms) === null)
      continue;
    events.push({
      kind: record.kind as BrowserKind,
      ms: milliseconds(record.ms)!,
      iteration: integer(record.iteration, 0, 99),
      listenerId: integer(record.listenerId, 1),
      visibility:
        record.visibility === "visible" || record.visibility === "hidden"
          ? record.visibility
          : "unavailable",
      readyState:
        record.readyState === "loading" ||
        record.readyState === "interactive" ||
        record.readyState === "complete"
          ? record.readyState
          : "unavailable",
      focused: record.focused === true,
      knownListeners: integer(record.knownListeners),
    });
  }
  return {
    available: value !== null && value !== undefined,
    clock: "document-monotonic-ms" as const,
    events,
    dropped: integer(raw.dropped),
    registrations: integer(raw.registrations),
    removals: integer(raw.removals),
    invocations: integer(raw.invocations),
    knownListeners: integer(raw.knownListeners),
  };
}

export function createFiniteReviewReadDiagnostics(
  page: Page,
  options: {
    now?: () => number;
    emit?: (value: unknown) => void;
    capacity?: number;
  } = {},
) {
  const now = options.now ?? (() => performance.now());
  const start = now();
  const capacity = Number.isInteger(options.capacity)
    ? Math.max(1, Math.min(CAPACITY, options.capacity!))
    : CAPACITY;
  const events: Array<{
    kind: string;
    ms: number;
    iteration: number | null;
    phase: Phase;
    requestId?: number;
    method?: Method;
    path?: typeof PATH;
    status?: number | null;
    hasQuery?: boolean;
    matchesWaiter?: boolean;
  }> = [];
  const requests = new WeakMap<Request, RequestIdentity>();
  let ordinal = 0;
  let dropped = 0;
  let phase: Phase = "setup";
  let iteration: number | null = null;
  let emitted = false;
  const record = (
    kind: string,
    fields: Partial<RequestIdentity> & { status?: number | null } = {},
  ) => {
    if (events.length === capacity) {
      events.shift();
      dropped++;
    }
    events.push({
      kind,
      ms: milliseconds(Math.max(0, now() - start)) ?? 0,
      iteration,
      phase,
      ...fields,
    });
  };
  page.on("request", (request) => {
    const route = finiteReviewDiagnosticURL(request.url());
    if (!route) return;
    const requestId = ++ordinal;
    const rawMethod = request.method();
    const method =
      rawMethod === "GET" || rawMethod === "POST" || rawMethod === "OPTIONS" || rawMethod === "HEAD"
        ? rawMethod
        : "other";
    const identity: RequestIdentity = { requestId, method, ...route };
    requests.set(request, identity);
    record("request-dispatch", identity);
  });
  page.on("response", (response) => {
    const identity = requests.get(response.request());
    if (identity)
      record("response", {
        ...identity,
        matchesWaiter: response.url().endsWith("/knowledge/entries/search"),
        status: integer(response.status(), 100, 599),
      });
  });
  const terminal = (request: Request, kind: "requestfinished" | "requestfailed") => {
    const identity = requests.get(request);
    if (identity) record(kind, identity);
  };
  page.on("requestfinished", (request) => terminal(request, "requestfinished"));
  page.on("requestfailed", (request) => terminal(request, "requestfailed"));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) record("document-committed");
  });
  page.on("close", () => record("page-closed"));
  page.on("crash", () => record("page-crashed"));
  return {
    async install() {
      await page.addInitScript(installFiniteReviewBrowserCapture, { capacity });
    },
    mark(value: number | null, nextPhase: Phase) {
      iteration = integer(value, 0, 99);
      phase = PHASES.includes(nextPhase) ? nextPhase : "setup";
      record("phase");
    },
    snapshot() {
      return {
        clock: "runner-monotonic-ms" as const,
        events: events.map((entry) => ({ ...entry })),
        dropped,
      };
    },
    async rethrowFailure(error: unknown): Promise<never> {
      if (!emitted) {
        emitted = true;
        try {
          let browser: unknown = null;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            // Bound only the best-effort failure snapshot, never the test's
            // response waiter. A hung/crashed document still yields runner data.
            browser = await Promise.race([
              page.evaluate(
                () =>
                  (
                    window as FiniteReviewDiagnosticsWindow
                  ).__opengeniFiniteReviewReadDiagnostics?.snapshot() ?? null,
              ),
              new Promise<null>((resolve) => {
                deadline = setTimeout(() => resolve(null), 1000);
              }),
            ]);
          } catch {
            /* Closed/crashed document: retain runner evidence. */
          } finally {
            if (deadline !== undefined) clearTimeout(deadline);
          }
          const value = {
            schema: "finite-review-read/v1",
            failure: true,
            correlation: "separate-clocks; exact-network-ids; no-event-to-request-causal-claim",
            listenerState:
              "native-options-forwarded-unread; non-default-registration-count-unknown; invocation-is-synchronous-function-callback-entry",
            runner: this.snapshot(),
            browser: sanitizeFiniteReviewBrowserCapture(browser),
          };
          (
            options.emit ??
            ((evidence) =>
              console.error(`[finite-review-read-diagnostics] ${JSON.stringify(evidence)}`))
          )(value);
        } catch {
          /* Diagnostics must not mask the original error, including writer failures. */
        }
      }
      throw error;
    },
  };
}
