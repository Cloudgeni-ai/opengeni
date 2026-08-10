import type { GoogleDriveProviderRetryOptions } from "@opengeni/config";
import type { FetchLike } from "@opengeni/network";
import type { Observability } from "@opengeni/observability";

export type GoogleDriveProviderOperation = "list" | "download" | "export";

export class GoogleDriveProviderTransportError extends Error {
  constructor() {
    super("google_drive_provider_transport_failed");
    this.name = "GoogleDriveProviderTransportError";
  }
}

/**
 * Absorb only short, explicitly retryable Drive failures inside one bounded
 * activity. The durable Temporal retry remains authoritative after this local
 * budget is exhausted. Provider bodies, URLs, headers, and credentials never
 * enter logs or metric labels.
 */
export async function fetchGoogleDriveProvider(input: {
  fetchImpl: FetchLike;
  url: string | URL;
  init: RequestInit;
  operation: GoogleDriveProviderOperation;
  policy: GoogleDriveProviderRetryOptions;
  observability: Observability;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<Response> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? Bun.sleep;
  const startedAt = now();
  let lastTransportFailure = false;

  for (let attempt = 1; attempt <= input.policy.attempts; attempt += 1) {
    let response: Response;
    try {
      response = await input.fetchImpl(input.url, {
        ...input.init,
        redirect: "error",
        signal: AbortSignal.timeout(input.policy.requestTimeoutMs),
      });
      lastTransportFailure = false;
    } catch {
      lastTransportFailure = true;
      recordRequest(input.observability, input.operation, "retryable_error");
      const delayMs = retryDelayMs(input.policy, attempt, null);
      if (!canRetry(input.policy, attempt, now() - startedAt, delayMs)) break;
      recordRetry(
        input.observability,
        input.operation,
        "transport",
        attempt,
        input.policy,
        delayMs,
      );
      await sleep(delayMs);
      continue;
    }

    if (!isRetryableStatus(response.status)) {
      recordRequest(
        input.observability,
        input.operation,
        response.ok ? "succeeded" : "terminal_error",
      );
      return response;
    }

    recordRequest(input.observability, input.operation, "retryable_error");
    const delayMs = retryDelayMs(
      input.policy,
      attempt,
      retryAfterDelayMs(response.headers.get("retry-after"), now()),
    );
    if (!canRetry(input.policy, attempt, now() - startedAt, delayMs)) return response;
    await response.body?.cancel().catch(() => undefined);
    recordRetry(
      input.observability,
      input.operation,
      response.status === 429 ? "rate_limited" : "provider_unavailable",
      attempt,
      input.policy,
      delayMs,
    );
    await sleep(delayMs);
  }

  if (lastTransportFailure) throw new GoogleDriveProviderTransportError();
  throw new GoogleDriveProviderTransportError();
}

function canRetry(
  policy: GoogleDriveProviderRetryOptions,
  attempt: number,
  elapsedMs: number,
  delayMs: number,
): boolean {
  return attempt < policy.attempts && elapsedMs + delayMs <= policy.budgetMs;
}

function retryDelayMs(
  policy: GoogleDriveProviderRetryOptions,
  attempt: number,
  retryAfterMs: number | null,
): number {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.min(policy.maxDelayMs, Math.max(exponential, retryAfterMs ?? 0));
}

function retryAfterDelayMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function recordRequest(
  observability: Observability,
  operation: GoogleDriveProviderOperation,
  outcome: "succeeded" | "retryable_error" | "terminal_error",
): void {
  observability.incrementCounter({
    name: "opengeni_google_drive_provider_requests_total",
    help: "Google Drive provider request attempts by operation and bounded outcome.",
    labels: { operation, outcome },
  });
}

function recordRetry(
  observability: Observability,
  operation: GoogleDriveProviderOperation,
  reason: "transport" | "rate_limited" | "provider_unavailable",
  attempt: number,
  policy: GoogleDriveProviderRetryOptions,
  delayMs: number,
): void {
  observability.incrementCounter({
    name: "opengeni_google_drive_provider_retries_total",
    help: "Bounded Google Drive provider retries by operation and reason.",
    labels: { operation, reason },
  });
  observability.observeHistogram({
    name: "opengeni_google_drive_provider_retry_delay_seconds",
    help: "Delay applied before a bounded Google Drive provider retry.",
    labels: { operation, reason },
    value: delayMs / 1_000,
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  });
  observability.warn("Google Drive provider request retry scheduled", {
    provider: "google_drive",
    op: operation,
    outcome: "retry_scheduled",
    reason,
    attempt,
    attempts: policy.attempts,
    delayMs,
  });
}
