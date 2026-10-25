import type { FeedbackRecentError } from "@opengeni/sdk";

/** As many as a feedback report carries. */
const FEEDBACK_RECENT_ERRORS_MAX = 10;

/* ----------------------------------------------------------------------------
   The last few errors the app showed the person, kept in memory so a
   feedback report can say what went wrong just before it was sent.
   -------------------------------------------------------------------------- */

let recent: FeedbackRecentError[] = [];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function currentScreen(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return clip(window.location.pathname, 500);
}

/** Remember an error the person was shown (an error toast, a failed action). */
export function recordRecentError(error: {
  title?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
  code?: string | undefined;
}): void {
  const message = (error.message ?? error.title ?? "").trim();
  if (!message) return;
  const title = error.title?.trim();
  const screen = currentScreen();
  const entry: FeedbackRecentError = {
    at: new Date().toISOString(),
    message: clip(message, 1000),
    ...(title && title !== message ? { title: clip(title, 200) } : {}),
    ...(error.code ? { code: clip(error.code, 120) } : {}),
    ...(error.status !== undefined && error.status >= 0 && error.status <= 999
      ? { status: Math.trunc(error.status) }
      : {}),
    ...(screen ? { screen } : {}),
  };
  recent = [...recent, entry].slice(-FEEDBACK_RECENT_ERRORS_MAX);
}

/** The remembered errors, oldest first. */
export function recentErrors(): FeedbackRecentError[] {
  return [...recent];
}

/** Tests only. */
export function clearRecentErrors(): void {
  recent = [];
}

type ErrorToast = (title: unknown, data?: { description?: unknown } | undefined) => unknown;
const recorded = new WeakSet<object>();

/**
 * Remember every error toast shown through this toast object (the app's one
 * sonner instance), whichever part of the app shows it. Call once at startup.
 */
export function recordErrorToasts(toast: { error: (...args: never[]) => unknown }): void {
  if (recorded.has(toast)) return;
  recorded.add(toast);
  const target = toast as unknown as { error: ErrorToast };
  const show = target.error;
  target.error = (title, data) => {
    recordRecentError({
      title: typeof title === "string" ? title : undefined,
      message: typeof data?.description === "string" ? data.description : undefined,
    });
    return show(title, data);
  };
}
