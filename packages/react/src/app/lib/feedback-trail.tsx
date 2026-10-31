import type {
  FeedbackBreadcrumb,
  FeedbackRecentException,
  FeedbackRecentRequest,
} from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   What happened in the app just before a feedback report: its latest API
   requests with the server's reference for each, errors nobody caught, files
   that failed to load, and the screens the person moved through. Kept in
   memory only, as many as a report carries, and sent only with a report.
   Addresses never keep their query string, which can carry tokens.
   -------------------------------------------------------------------------- */

/** As many of each as a feedback report carries. */
export const FEEDBACK_TRAIL_LIMITS = { requests: 20, exceptions: 10, breadcrumbs: 30 } as const;

let requests: FeedbackRecentRequest[] = [];
let exceptions: FeedbackRecentException[] = [];
let breadcrumbs: FeedbackBreadcrumb[] = [];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An address without its query or fragment; data and blob addresses keep only their scheme. */
export function addressWithoutQuery(address: string): string {
  if (/^(data|blob):/iu.test(address)) return `${address.slice(0, address.indexOf(":"))}:`;
  return address.split(/[?#]/u)[0] ?? address;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * Start timing one API request; call the result once with its status (null
 * when no response arrived) and the server's correlation id. A request the app
 * cancelled itself is not worth reporting: pass aborted. Sending feedback
 * itself is left out.
 */
export function beginFeedbackRequest(
  method: string,
  pathname: string,
): (status: number | null, detail?: { correlationId?: string | null; aborted?: boolean }) => void {
  const path = addressWithoutQuery(pathname);
  if (/\/feedback$/u.test(path)) return () => {};
  const startedAt = now();
  const at = new Date().toISOString();
  let finished = false;
  return (status, detail) => {
    if (finished) return;
    finished = true;
    if (status === null && detail?.aborted) return;
    const correlationId = detail?.correlationId?.trim();
    const entry: FeedbackRecentRequest = {
      at,
      method: /^[A-Z]{1,10}$/u.test(method.toUpperCase()) ? method.toUpperCase() : "GET",
      path: clip(path || "/", 300),
      status: status !== null && status >= 0 && status <= 999 ? Math.trunc(status) : 0,
      durationMs: Math.max(0, Math.min(86_400_000, Math.round(now() - startedAt))),
      ...(correlationId ? { correlationId: clip(correlationId, 128) } : {}),
    };
    requests = [...requests, entry].slice(-FEEDBACK_TRAIL_LIMITS.requests);
  };
}

/** Remember an error nobody caught, a rejected promise nobody handled, or a file that failed to load. */
export function recordFeedbackException(input: {
  kind: FeedbackRecentException["kind"];
  message: string;
  stack?: string | undefined;
  source?: string | undefined;
}): void {
  const message = input.message.trim() || "Unknown error";
  const stack = input.stack?.trim();
  const source = input.source?.trim();
  const entry: FeedbackRecentException = {
    at: new Date().toISOString(),
    kind: input.kind,
    message: clip(message, 1000),
    ...(stack ? { stack: clip(stack, 4000) } : {}),
    ...(source ? { source: clip(addressWithoutQuery(source), 500) } : {}),
  };
  exceptions = [...exceptions, entry].slice(-FEEDBACK_TRAIL_LIMITS.exceptions);
}

/** Remember a step: a screen opened, the app hidden or shown, the network lost or back. */
export function recordFeedbackBreadcrumb(kind: FeedbackBreadcrumb["kind"], label: string): void {
  const text = label.trim();
  if (!text) return;
  const last = breadcrumbs.at(-1);
  if (last?.kind === kind && last.label === clip(text, 200)) return;
  breadcrumbs = [
    ...breadcrumbs,
    { at: new Date().toISOString(), kind, label: clip(text, 200) },
  ].slice(-FEEDBACK_TRAIL_LIMITS.breadcrumbs);
}

/** Remember that the page in view changed. */
export function recordFeedbackNavigation(pathname: string): void {
  recordFeedbackBreadcrumb("navigation", addressWithoutQuery(pathname) || "/");
}

/** Everything remembered, oldest first in each list. */
export function feedbackTrail(): {
  recentRequests: FeedbackRecentRequest[];
  recentExceptions: FeedbackRecentException[];
  breadcrumbs: FeedbackBreadcrumb[];
} {
  return {
    recentRequests: [...requests],
    recentExceptions: [...exceptions],
    breadcrumbs: [...breadcrumbs],
  };
}

/** Tests only. */
export function clearFeedbackTrail(): void {
  requests = [];
  exceptions = [];
  breadcrumbs = [];
}

function errorText(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      message: `${value.name}: ${value.message}`,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value === "string") return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

type TrailWindow = Pick<Window, "addEventListener"> & {
  location: { pathname: string };
  document?: { visibilityState?: string } | undefined;
};

const installed = new WeakSet<object>();

/**
 * Listen for uncaught errors, unhandled rejections, files that fail to load,
 * the network dropping and the page being hidden. Call once at startup;
 * navigation is recorded by whoever owns the router (recordFeedbackNavigation).
 */
export function installFeedbackTrail(target: TrailWindow): void {
  if (installed.has(target)) return;
  installed.add(target);
  recordFeedbackNavigation(target.location.pathname);
  // Capture phase: a failed <img> or <script> load does not bubble to window.
  target.addEventListener(
    "error",
    (event: Event) => {
      const element = event.target as
        | { tagName?: unknown; src?: unknown; href?: unknown; currentSrc?: unknown }
        | null
        | undefined;
      if (element && element !== (target as unknown) && typeof element.tagName === "string") {
        const address = [element.currentSrc, element.src, element.href].find(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        recordFeedbackException({
          kind: "resource",
          message: `A ${element.tagName.toLowerCase()} failed to load`,
          source: address,
        });
        return;
      }
      const failure = event as ErrorEvent;
      const text = errorText(failure.error ?? failure.message);
      recordFeedbackException({
        kind: "error",
        message: failure.message || text.message,
        stack: text.stack,
        source: failure.filename
          ? `${addressWithoutQuery(failure.filename)}:${failure.lineno ?? 0}:${failure.colno ?? 0}`
          : undefined,
      });
    },
    true,
  );
  target.addEventListener("unhandledrejection", (event: Event) => {
    const text = errorText((event as PromiseRejectionEvent).reason);
    // A request the app cancelled on purpose is not a fault.
    if (/^AbortError\b/u.test(text.message)) return;
    recordFeedbackException({ kind: "unhandled_rejection", ...text });
  });
  target.addEventListener("offline", () => recordFeedbackBreadcrumb("network", "Went offline"));
  target.addEventListener("online", () => recordFeedbackBreadcrumb("network", "Back online"));
  target.addEventListener("visibilitychange", () => {
    const state = target.document?.visibilityState;
    if (state === "hidden") recordFeedbackBreadcrumb("lifecycle", "Page hidden");
    else if (state === "visible") recordFeedbackBreadcrumb("lifecycle", "Page shown");
  });
}

const SESSION_PATH =
  /\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/iu;

/** The chat a console path shows, such as /workspaces/<id>/sessions/<id>. */
export function sessionIdInPath(pathname: string): string | undefined {
  return SESSION_PATH.exec(pathname)?.[1]?.toLowerCase();
}
