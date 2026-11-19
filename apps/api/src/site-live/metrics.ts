import {
  SITE_OPERATIONS,
  SITE_TOOL_METHODS,
  matchSiteOperation,
  type SitePlatformTimingReport,
} from "@opengeni/contracts";

/**
 * Site speed metrics (docs/application-observability.md, "Sites"). Every
 * label is from a closed set: Site operation ids, tool bridge methods, the
 * gateway's own route names, or `other`. Hosts, Sites and viewers never
 * become labels.
 */

export const SITE_RUNTIME_REQUEST_METRIC = {
  name: "opengeni_site_runtime_request_duration_seconds",
  help: "Time the API spends answering one gateway-signed Site request (/v1/site-runtime), by Site operation and status class.",
} as const;

export const SITE_CLIENT_TIMING_METRIC = {
  name: "opengeni_site_client_timing_seconds",
  help: "Speed measured in published Site pages and by the Site gateway, reported in sampled batches: app_load (shell start to app ready), first_data (first Site Data or SQL answer), bridge (one bridge call, by operation), gateway (gateway handling, by route).",
} as const;

export const SITE_DB_OPERATION_METRIC = {
  name: "opengeni_site_db_operation_duration_seconds",
  help: "Round trip from the API to a Site's SQL Durable Object through the gateway, by operation and outcome.",
} as const;

export const SITE_TIMING_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** Gateway route names the gateway reports its own handling time under. */
export const SITE_GATEWAY_ROUTES = [
  "api",
  "shell",
  "version",
  "live",
  "timing",
  "auth",
  "report",
  "internal",
  "frame_host",
  "other",
] as const;

const OPERATION_IDS = new Set(SITE_OPERATIONS.map((operation) => operation.id));
const TOOL_OPS = new Set(SITE_TOOL_METHODS.map((method) => `tools.${method}`));
const GATEWAY_ROUTES = new Set<string>(SITE_GATEWAY_ROUTES);
const OWN_ROUTES = new Set([
  "host",
  "version.html",
  "auth.exchange",
  "auth.logout",
  "auth.view_as",
  "platform.requests",
  "platform.timings",
  "site.reports",
  "live.admit",
]);

/** A closed `op` label for a Site operation, tool method or page measurement. */
export function siteOpLabel(op: string | undefined): string {
  if (!op) return "page";
  if (OPERATION_IDS.has(op) || TOOL_OPS.has(op) || OWN_ROUTES.has(op)) return op;
  if ((SITE_TOOL_METHODS as readonly string[]).includes(op)) return `tools.${op}`;
  return "other";
}

/** The `op` label of one `/v1/site-runtime<suffix>` request, without running it. */
export function siteRuntimeOpLabel(method: string, suffix: string): string {
  if (method === "GET" && suffix === "/host") return "host";
  if (method === "GET" && /^\/versions\/[^/]+\/html$/u.test(suffix)) return "version.html";
  if (method === "POST" && suffix === "/auth/exchange") return "auth.exchange";
  if (method === "POST" && suffix === "/auth/logout") return "auth.logout";
  if (method === "POST" && suffix === "/auth/view-as") return "auth.view_as";
  if (method === "POST" && suffix === "/platform/requests") return "platform.requests";
  if (method === "POST" && suffix === "/platform/timings") return "platform.timings";
  if (method === "POST" && suffix === "/site/reports") return "site.reports";
  if (method === "POST" && suffix === "/live/admit") return "live.admit";
  const tool = /^\/tools\/([a-z]+)$/u.exec(suffix);
  if (tool) return siteOpLabel(tool[1]);
  const sitePath = suffix === "/v1/config/client" ? suffix : `/v1/workspaces/site-host${suffix}`;
  return matchSiteOperation(method, sitePath)?.operation.id ?? "other";
}

export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

type Histogram = (input: {
  name: string;
  help?: string;
  labels?: Record<string, string>;
  value: number;
  buckets?: number[];
}) => void;

/** Record a gateway timing report. Returns how many samples were recorded. */
export function recordSiteTimingReport(
  observe: Histogram,
  report: SitePlatformTimingReport,
): number {
  let recorded = 0;
  for (const series of report.series) {
    const op =
      series.kind === "gateway"
        ? GATEWAY_ROUTES.has(series.op)
          ? series.op
          : "other"
        : series.kind === "bridge"
          ? siteOpLabel(series.op)
          : "page";
    for (const value of series.samples) {
      observe({
        ...SITE_CLIENT_TIMING_METRIC,
        labels: { kind: series.kind, op, outcome: series.outcome },
        value,
        buckets: SITE_TIMING_BUCKETS,
      });
      recorded += 1;
    }
  }
  return recorded;
}
