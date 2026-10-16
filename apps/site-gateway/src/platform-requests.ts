/**
 * Platform usage: the gateway counts every request it serves for a Site
 * host (cache hits included) and reports the counts to the API in signed
 * batches on the Sites domain apex (`POST /v1/site-runtime/platform/requests`).
 *
 * Counts live in the isolate. A batch is sent once the oldest unsent count
 * is `intervalMs` old (a delayed `waitUntil` sends it even when traffic
 * stops) or `flushAt` requests are waiting. A failed batch keeps its report
 * id and is retried with the next batch, so the API (which records each
 * host once per report id) never counts it twice. Everything is bounded: an
 * isolate that is evicted, or an API that stays down, loses at most the
 * unsent counts. Counting never refuses or delays a request.
 */
import { randomToken, utf8 } from "./crypto";
import type { GatewayConfig, WaitUntil } from "./env";
import { signedApiRequest } from "./signing";

/** At most this many hosts per report (the API's limit). */
export const PLATFORM_REPORT_MAX_HOSTS = 500;
/** Hosts kept waiting at most; counts for further new hosts are dropped. */
export const PLATFORM_PENDING_MAX_HOSTS = 5_000;
/** Failed reports kept for retry at most. */
export const PLATFORM_RETRY_MAX_REPORTS = 20;
/** Send once this many requests are waiting. */
export const PLATFORM_FLUSH_AT_REQUESTS = 1_000;

type Report = { v: 1; reportId: string; hosts: { host: string; requests: number }[] };

const pending = new Map<string, number>();
let pendingRequests = 0;
/** When the oldest unsent count arrived, or null when nothing waits. */
let windowStartedAt: number | null = null;
let retries: Report[] = [];
let sending: Promise<void> = Promise.resolve();

/** Count one served request for `host`; may send a batch through `ctx.waitUntil`. */
export function countSiteRequest(
  config: Pick<GatewayConfig, "apiOrigin" | "secret" | "sitesDomain" | "platformReportIntervalMs">,
  ctx: WaitUntil,
  host: string,
  now = Date.now(),
): void {
  const key = host.toLowerCase();
  if (!pending.has(key) && pending.size >= PLATFORM_PENDING_MAX_HOSTS) return;
  pending.set(key, (pending.get(key) ?? 0) + 1);
  pendingRequests += 1;
  if (windowStartedAt === null) {
    windowStartedAt = now;
    // Send this window even if no further request arrives in this isolate.
    ctx.waitUntil(delay(config.platformReportIntervalMs).then(() => flushSiteRequests(config)));
  }
  if (
    pendingRequests >= PLATFORM_FLUSH_AT_REQUESTS ||
    now - windowStartedAt >= config.platformReportIntervalMs
  )
    ctx.waitUntil(flushSiteRequests(config));
}

/** Send everything waiting (and earlier failed reports). Never throws. */
export function flushSiteRequests(
  config: Pick<GatewayConfig, "apiOrigin" | "secret" | "sitesDomain">,
): Promise<void> {
  // One send at a time per isolate: each flush runs after the previous one.
  const next = sending.then(async () => {
    for (const report of takeReports())
      if (!(await sendReport(config, report))) keepForRetry(report);
  });
  sending = next.catch(() => undefined);
  return sending;
}

function takeReports(): Report[] {
  const reports = retries;
  retries = [];
  const entries = [...pending.entries()];
  pending.clear();
  pendingRequests = 0;
  windowStartedAt = null;
  for (let index = 0; index < entries.length; index += PLATFORM_REPORT_MAX_HOSTS)
    reports.push({
      v: 1,
      reportId: randomToken(16),
      hosts: entries
        .slice(index, index + PLATFORM_REPORT_MAX_HOSTS)
        .map(([host, requests]) => ({ host, requests })),
    });
  return reports;
}

function keepForRetry(report: Report): void {
  if (retries.length < PLATFORM_RETRY_MAX_REPORTS) retries.push(report);
}

async function sendReport(
  config: Pick<GatewayConfig, "apiOrigin" | "secret" | "sitesDomain">,
  report: Report,
): Promise<boolean> {
  try {
    const response = await fetch(
      await signedApiRequest(
        config,
        { host: config.sitesDomain, session: "", visitor: "", clientIp: "", human: false },
        {
          method: "POST",
          suffix: "/platform/requests",
          body: utf8(JSON.stringify(report)),
          headers: new Headers({ "content-type": "application/json" }),
        },
      ),
    );
    await response.body?.cancel();
    // A refused report (4xx) will never be accepted: drop it.
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test support: what is waiting in this isolate. */
export function pendingSiteRequests(): {
  hosts: Record<string, number>;
  requests: number;
  retries: number;
} {
  return {
    hosts: Object.fromEntries(pending),
    requests: pendingRequests,
    retries: retries.length,
  };
}

/** Test support: forget everything waiting. */
export function resetSiteRequestCounts(): void {
  pending.clear();
  pendingRequests = 0;
  windowStartedAt = null;
  retries = [];
  sending = Promise.resolve();
}
