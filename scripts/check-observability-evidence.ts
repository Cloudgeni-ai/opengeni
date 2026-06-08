import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

interface Args {
  metricsFile: string;
  outFile: string;
  evidenceFiles: string[];
  apiLogsFile: string | null;
  collectorLogsFile: string | null;
  syntheticProbeConfigured: boolean;
  alertsConfigured: boolean;
  metricsDashboardVerified: boolean;
  traceCorrelationVerified: boolean;
  logCorrelationVerified: boolean;
}

const args = parseArgs(process.argv.slice(2), process.env);
const metricsText = readFileSync(args.metricsFile, "utf8");
const apiLogsText = args.apiLogsFile ? readFileSync(args.apiLogsFile, "utf8") : "";
const collectorLogsText = args.collectorLogsFile ? readFileSync(args.collectorLogsFile, "utf8") : "";
const hasRequestCounter = metricsText.includes("opengeni_http_requests_total");
const hasDurationHistogram = metricsText.includes("opengeni_http_request_duration_seconds_bucket");
const collectorReceivedMetrics = /otelcol\.signal["=:\s]+metrics|\bMetrics\b/.test(collectorLogsText);
const correlation = correlateApiLogsWithCollector(apiLogsText, collectorLogsText);
const metrics = {
  syntheticProbeConfigured: args.syntheticProbeConfigured,
  alertsConfigured: args.alertsConfigured,
  metricsDashboardVerified: (args.metricsDashboardVerified || collectorReceivedMetrics) && hasRequestCounter && hasDurationHistogram,
  traceCorrelationVerified: args.traceCorrelationVerified || correlation.matchedTraceCount > 0,
  logCorrelationVerified: args.logCorrelationVerified || (correlation.apiTraceLogCount > 0 && correlation.matchedTraceCount > 0),
  metricsFileHasRequestCounter: hasRequestCounter,
  metricsFileHasDurationHistogram: hasDurationHistogram,
  collectorReceivedMetrics,
  apiTraceLogCount: correlation.apiTraceLogCount,
  matchedTraceCount: correlation.matchedTraceCount,
  matchedTraceSamples: correlation.matchedTraceSamples,
};
const ok = metrics.syntheticProbeConfigured
  && metrics.alertsConfigured
  && metrics.metricsDashboardVerified
  && metrics.traceCorrelationVerified
  && metrics.logCorrelationVerified;

const output = {
  ok,
  checks: [{
    id: "observability-alerts",
    status: ok ? "passed" : "failed",
    detail: ok ? "observability and alert evidence verified" : "observability or alert evidence is incomplete",
    evidence: [
      args.metricsFile,
      ...(args.apiLogsFile ? [args.apiLogsFile] : []),
      ...(args.collectorLogsFile ? [args.collectorLogsFile] : []),
      ...args.evidenceFiles,
    ],
    metrics,
  }],
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    metricsFile: env.OPENGENI_OBSERVABILITY_METRICS_FILE ?? "",
    outFile: env.OPENGENI_OBSERVABILITY_OUT_FILE ?? ".agent/generated/staging/observability-alerts.json",
    evidenceFiles: parseList(env.OPENGENI_OBSERVABILITY_EVIDENCE_FILES ?? ""),
    apiLogsFile: env.OPENGENI_OBSERVABILITY_API_LOGS_FILE ?? null,
    collectorLogsFile: env.OPENGENI_OBSERVABILITY_COLLECTOR_LOGS_FILE ?? null,
    syntheticProbeConfigured: env.OPENGENI_SYNTHETIC_PROBE_CONFIGURED === "1",
    alertsConfigured: env.OPENGENI_ALERTS_CONFIGURED === "1",
    metricsDashboardVerified: env.OPENGENI_METRICS_DASHBOARD_VERIFIED === "1",
    traceCorrelationVerified: env.OPENGENI_TRACE_CORRELATION_VERIFIED === "1",
    logCorrelationVerified: env.OPENGENI_LOG_CORRELATION_VERIFIED === "1",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--metrics") {
      out.metricsFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--evidence") {
      out.evidenceFiles.push(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--api-logs") {
      out.apiLogsFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--collector-logs") {
      out.collectorLogsFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--synthetic-probe-configured") {
      out.syntheticProbeConfigured = true;
      continue;
    }
    if (value === "--alerts-configured") {
      out.alertsConfigured = true;
      continue;
    }
    if (value === "--metrics-dashboard-verified") {
      out.metricsDashboardVerified = true;
      continue;
    }
    if (value === "--trace-correlation-verified") {
      out.traceCorrelationVerified = true;
      continue;
    }
    if (value === "--log-correlation-verified") {
      out.logCorrelationVerified = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.metricsFile) {
    throw new Error("Set --metrics or OPENGENI_OBSERVABILITY_METRICS_FILE");
  }
  if (!existsSync(out.metricsFile)) {
    throw new Error(`metrics file does not exist: ${out.metricsFile}`);
  }
  for (const file of [out.apiLogsFile, out.collectorLogsFile]) {
    if (file && !existsSync(file)) {
      throw new Error(`observability log file does not exist: ${file}`);
    }
  }
  for (const file of out.evidenceFiles) {
    if (!existsSync(file)) {
      throw new Error(`evidence file does not exist: ${file}`);
    }
  }
  return out;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function correlateApiLogsWithCollector(apiLogsText: string, collectorLogsText: string): {
  apiTraceLogCount: number;
  matchedTraceCount: number;
  matchedTraceSamples: string[];
} {
  if (!apiLogsText || !collectorLogsText) {
    return { apiTraceLogCount: 0, matchedTraceCount: 0, matchedTraceSamples: [] };
  }
  const traceIds = new Set<string>();
  for (const line of apiLogsText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const traceId = parsed.traceId;
      if (typeof traceId === "string" && /^[0-9a-f]{32}$/.test(traceId)) {
        traceIds.add(traceId);
      }
    } catch {
      const match = line.match(/"traceId"\s*:\s*"([0-9a-f]{32})"/);
      if (match) {
        traceIds.add(match[1]!);
      }
    }
  }
  const matchedTraceIds = [...traceIds].filter((traceId) => collectorLogsText.includes(traceId));
  return {
    apiTraceLogCount: traceIds.size,
    matchedTraceCount: matchedTraceIds.length,
    matchedTraceSamples: matchedTraceIds.slice(0, 10),
  };
}
