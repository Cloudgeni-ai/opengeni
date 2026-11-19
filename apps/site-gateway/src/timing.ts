/**
 * Site speed measurement (docs/application-observability.md, "Sites").
 *
 * The gateway measures its own handling time per route, and Site pages send
 * small batched beacons (`POST /_og/timing`) with what the viewer
 * experienced: app load, first data, and each bridge call (operation,
 * duration, outcome). Nothing is forwarded per beacon: the gateway keeps a
 * bounded sample per series in the isolate and reports the samples to the
 * API in signed batches on the Sites domain apex
 * (`POST /v1/site-runtime/platform/timings`), like request counts. Series
 * are closed sets (Site operation ids, tool methods, gateway routes); hosts,
 * Sites and viewers never appear. Losing samples (an evicted isolate, an
 * API that is down) is acceptable; measuring never refuses or delays a
 * request.
 */
import {
  SITE_OPERATIONS,
  SITE_TOOL_METHODS,
  SiteTimingBeacon,
  type SitePlatformTimingReport,
} from "@opengeni/contracts";
import { readBodyCapped, rateLimitKeys, underRateLimit } from "./api";
import { utf8 } from "./crypto";
import type { GatewayConfig, WaitUntil } from "./env";
import { applySecurityHeaders, jsonError } from "./headers";
import { signedApiRequest } from "./signing";
import { isSameOriginRequest, type SiteContext } from "./site-context";

/** Samples kept per series until the next report. */
export const TIMING_SAMPLES_PER_SERIES = 100;
/** Series kept at most; samples for further new series are dropped. */
export const TIMING_MAX_SERIES = 300;
/** One beacon is at most this large. */
const MAX_BEACON_BYTES = 16 * 1024;

export type TimingKind = "app_load" | "first_data" | "bridge" | "gateway";
export type TimingOutcome = "ok" | "error";

type Series = {
  kind: TimingKind;
  op: string;
  outcome: TimingOutcome;
  samples: number[];
  seen: number;
};

const OPERATION_IDS = new Set(SITE_OPERATIONS.map((operation) => operation.id));
const TOOL_METHODS = new Set<string>(SITE_TOOL_METHODS);

const series = new Map<string, Series>();
let windowStartedAt: number | null = null;
let sending: Promise<void> = Promise.resolve();

/** A closed `op` label for a page measurement. */
export function timingOp(kind: TimingKind, op: string | undefined): string {
  if (kind === "app_load" || kind === "first_data") return "page";
  if (!op) return "other";
  if (kind === "gateway") return op;
  if (OPERATION_IDS.has(op)) return op;
  if (TOOL_METHODS.has(op)) return `tools.${op}`;
  if (op.startsWith("tools.") && TOOL_METHODS.has(op.slice("tools.".length))) return op;
  return "other";
}

/**
 * Keep one duration (milliseconds). Each series keeps a uniform sample of
 * at most TIMING_SAMPLES_PER_SERIES values per report window.
 */
export function recordTiming(
  config: Pick<GatewayConfig, "apiOrigin" | "secret" | "sitesDomain" | "platformReportIntervalMs">,
  ctx: WaitUntil,
  kind: TimingKind,
  op: string | undefined,
  outcome: TimingOutcome,
  ms: number,
  now = Date.now(),
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const label = timingOp(kind, op);
  const key = `${kind}|${label}|${outcome}`;
  let entry = series.get(key);
  if (!entry) {
    if (series.size >= TIMING_MAX_SERIES) return;
    entry = { kind, op: label, outcome, samples: [], seen: 0 };
    series.set(key, entry);
  }
  const seconds = Math.min(600, ms / 1000);
  entry.seen += 1;
  if (entry.samples.length < TIMING_SAMPLES_PER_SERIES) entry.samples.push(seconds);
  else {
    // Reservoir sampling: every value has the same chance to be kept.
    const slot = Math.floor(Math.random() * entry.seen);
    if (slot < TIMING_SAMPLES_PER_SERIES) entry.samples[slot] = seconds;
  }
  if (windowStartedAt === null) {
    windowStartedAt = now;
    ctx.waitUntil(delay(config.platformReportIntervalMs).then(() => flushTimings(config)));
  } else if (now - windowStartedAt >= config.platformReportIntervalMs)
    ctx.waitUntil(flushTimings(config));
}

/** Send what is waiting. Never throws; a failed report is dropped. */
export function flushTimings(
  config: Pick<GatewayConfig, "apiOrigin" | "secret" | "sitesDomain">,
): Promise<void> {
  const next = sending.then(async () => {
    if (series.size === 0) {
      windowStartedAt = null;
      return;
    }
    const report: SitePlatformTimingReport = {
      v: 1,
      series: [...series.values()].map(({ kind, op, outcome, samples }) => ({
        kind,
        op,
        outcome,
        samples,
      })),
    };
    series.clear();
    windowStartedAt = null;
    try {
      const response = await fetch(
        await signedApiRequest(
          config,
          { host: config.sitesDomain, session: "", visitor: "", clientIp: "", human: false },
          {
            method: "POST",
            suffix: "/platform/timings",
            body: utf8(JSON.stringify(report)),
            headers: new Headers({ "content-type": "application/json" }),
          },
        ),
      );
      await response.body?.cancel();
    } catch {
      // Measurements are best effort.
    }
  });
  sending = next.catch(() => undefined);
  return sending;
}

/** `POST /_og/timing` on a Site host: the page's batched beacons. Always 204 for a valid beacon. */
export async function handleTimingBeacon(site: SiteContext): Promise<Response> {
  const security = { noindex: true, hsts: site.hsts };
  if (site.request.method !== "POST")
    return jsonError(405, { code: "method_not_allowed", message: "Use POST" }, security);
  if (!isSameOriginRequest(site.request, site.siteOrigin))
    return jsonError(403, { code: "site_cross_origin", message: "Not allowed" }, security);
  if (!(await underRateLimit(site, rateLimitKeys(site, "timing"))))
    return jsonError(
      429,
      { code: "site_rate_limited", message: "Too many requests; slow down", retryable: true },
      { ...security, headers: { "Retry-After": "60" } },
    );
  const body = await readBodyCapped(site.request, MAX_BEACON_BYTES);
  if (body === "too_large")
    return jsonError(413, { code: "too_large", message: "The beacon is too large" }, security);
  let beacon: SiteTimingBeacon;
  try {
    const parsed = SiteTimingBeacon.safeParse(JSON.parse(new TextDecoder().decode(body)));
    if (!parsed.success) throw new Error("invalid");
    beacon = parsed.data;
  } catch {
    return jsonError(422, { code: "validation", message: "Invalid beacon" }, security);
  }
  for (const timing of beacon.timings)
    recordTiming(site.config, site.ctx, timing.kind, timing.op, timing.outcome ?? "ok", timing.ms);
  return new Response(null, {
    status: 204,
    headers: applySecurityHeaders(new Headers({ "Cache-Control": "no-store" }), security),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test support: what is waiting in this isolate. */
export function pendingTimings(): Record<string, number[]> {
  return Object.fromEntries([...series].map(([key, entry]) => [key, [...entry.samples]]));
}

/** Test support: forget everything waiting. */
export function resetTimings(): void {
  series.clear();
  windowStartedAt = null;
  sending = Promise.resolve();
}
