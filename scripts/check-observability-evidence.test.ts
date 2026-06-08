import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const scriptPath = new URL("./check-observability-evidence.ts", import.meta.url).pathname;

describe("observability evidence", () => {
  it("passes when metrics and explicit observability proofs are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-observability-"));
    const metrics = writeMetrics(dir);
    const apiLogs = join(dir, "api.log");
    const collectorLogs = join(dir, "collector.log");
    writeFileSync(apiLogs, JSON.stringify({
      message: "HTTP request completed",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
    writeFileSync(collectorLogs, [
      "Metrics {\"otelcol.signal\":\"metrics\"}",
      "Trace ID       : aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ].join("\n"));
    const azureReadback = join(dir, "webtest.json");
    writeFileSync(azureReadback, JSON.stringify({ ok: true }));
    const out = join(dir, "observability.json");

    const result = runScript(metrics, out, [
      "--evidence",
      azureReadback,
      "--api-logs",
      apiLogs,
      "--collector-logs",
      collectorLogs,
      "--synthetic-probe-configured",
      "--alerts-configured",
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.checks[0].evidence).toContain(azureReadback);
    expect(payload.checks[0].metrics.matchedTraceCount).toBe(1);
  });

  it("fails without explicit alert and correlation proof", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-observability-"));
    const metrics = writeMetrics(dir);
    const out = join(dir, "observability.json");

    const result = runScript(metrics, out);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].metrics.alertsConfigured).toBe(false);
  });

  it("reports all matched trace IDs while keeping samples bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "opengeni-observability-"));
    const metrics = writeMetrics(dir);
    const apiLogs = join(dir, "api.log");
    const collectorLogs = join(dir, "collector.log");
    const traceIds = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(32, "a")}`.slice(0, 32));
    writeFileSync(apiLogs, traceIds.map((traceId) => JSON.stringify({
      message: "HTTP request completed",
      traceId,
    })).join("\n"));
    writeFileSync(collectorLogs, [
      "Metrics {\"otelcol.signal\":\"metrics\"}",
      ...traceIds.map((traceId) => `Trace ID       : ${traceId}`),
    ].join("\n"));
    const out = join(dir, "observability.json");

    const result = runScript(metrics, out, [
      "--api-logs",
      apiLogs,
      "--collector-logs",
      collectorLogs,
      "--synthetic-probe-configured",
      "--alerts-configured",
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(readFileSync(out, "utf8"));
    expect(payload.checks[0].metrics.matchedTraceCount).toBe(12);
    expect(payload.checks[0].metrics.matchedTraceSamples).toHaveLength(10);
  });
});

function runScript(metrics: string, out: string, extra: string[] = []): ReturnType<typeof spawnSync<string>> {
  return spawnSync("bun", [
    scriptPath,
    "--metrics", metrics,
    "--out", out,
    ...extra,
  ], { encoding: "utf8" });
}

function writeMetrics(dir: string): string {
  const path = join(dir, "metrics.txt");
  writeFileSync(path, [
    "# HELP opengeni_http_requests_total requests",
    "opengeni_http_requests_total{route=\"/healthz\"} 1",
    "# HELP opengeni_http_request_duration_seconds request duration",
    "opengeni_http_request_duration_seconds_bucket{le=\"1\"} 1",
  ].join("\n"));
  return path;
}
