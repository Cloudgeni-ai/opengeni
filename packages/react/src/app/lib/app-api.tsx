// The API calls the session UI makes outside the SDK client, behind a host.
// The web app supplies its authenticated helpers (see app-host.ts); an embed
// supplies its own.
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { useAppHost } from "./app-host";

export type AppApiHost = Readonly<{
  /** Absolute API origin and prefix, or "" for same-origin. */
  apiBaseUrl: string;
  /** An authenticated JSON request to an API path (`/v1/...`). */
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** The same request, returning the raw response. */
  requestResponse: (path: string, init?: RequestInit) => Promise<Response>;
  /**
   * Prepares a client for live voice. `sessionHref` is the page a call belongs
   * to; the web app reloads onto a newer build before starting one.
   */
  voiceRealtimeClient: <C extends { beginSessionRealtime: (...args: never[]) => Promise<unknown> }>(
    client: C,
    sessionHref: () => string,
  ) => C;
}>;

export function useAppApi(): AppApiHost {
  const host = useAppHost().api;
  if (!host) throw new Error("Opengeni app API is not configured");
  return host;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    options: {
      code?: string | undefined;
      retryable?: boolean | undefined;
      outcomeUnknown?: boolean | undefined;
      details?: Record<string, unknown> | undefined;
      message?: string | undefined;
    } = {},
  ) {
    super(options.message ?? `API ${status}: ${body}`);
    this.name = "ApiError";
    this.code = options.code;
    this.retryable = options.retryable === true;
    this.outcomeUnknown = options.outcomeUnknown === true;
    this.details = options.details;
  }

  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;
  readonly details: Record<string, unknown> | undefined;
}

export function apiErrorFromResponseBody(status: number, body: string): ApiError {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error !== "object" || parsed.error === null || Array.isArray(parsed.error)) {
      return new ApiError(status, body);
    }
    const error = parsed.error as Record<string, unknown>;
    return new ApiError(status, body, {
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
      ...(error.retryable === true ? { retryable: true } : {}),
      ...(error.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
      ...(typeof error.details === "object" &&
      error.details !== null &&
      !Array.isArray(error.details)
        ? { details: error.details as Record<string, unknown> }
        : {}),
    });
  } catch {
    return new ApiError(status, body);
  }
}

export function isApiErrorStatus(error: unknown, status: number): boolean {
  return (
    (error instanceof ApiError || error instanceof OpenGeniApiError) && error.status === status
  );
}
