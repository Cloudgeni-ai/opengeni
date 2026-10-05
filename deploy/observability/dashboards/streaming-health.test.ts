import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("streaming health dashboard", () => {
  test("shows provider valid-event liveness without request identity", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./streaming-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{ title?: string }>;
    };
    const titles = new Set(dashboard.panels.map((panel) => panel.title));
    expect(titles).toContain("Oldest in-flight request: seconds since a valid event");
    expect(titles).toContain("Provider valid-event gap p95 / p50");
    expect(titles).toContain("Provider request terminal outcomes");

    const serialized = JSON.stringify(dashboard);
    for (const metric of [
      "opengeni_model_request_oldest_no_event_age_seconds",
      "opengeni_model_request_stream_event_gap_seconds_bucket",
      "opengeni_model_request_phases_total",
    ]) {
      expect(serialized).toContain(metric);
    }
    expect(serialized).not.toContain("requestId");
    expect(serialized).not.toContain("sessionId");
  });

  test("keeps absolute TTFT as an unalerted view and splits OpenGeni from provider latency", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./streaming-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{
        title?: string;
        targets?: Array<{ expr?: string }>;
        fieldConfig?: {
          defaults?: {
            thresholds?: { steps?: Array<{ color?: string; value?: number | null }> };
            custom?: { thresholdsStyle?: { mode?: string } };
          };
        };
      }>;
    };
    const byTitle = (title: string) => dashboard.panels.find((panel) => panel.title === title);
    const absolute = byTitle(
      "User-perceived time-to-first-token p99 / p95 / p50 by provider (absolute)",
    );
    expect(absolute?.targets?.[0]?.expr).toContain("opengeni_stream_ttft_seconds_bucket");
    // No alert reads the absolute view, so it must not draw a stale alert line.
    expect(absolute?.fieldConfig?.defaults?.custom?.thresholdsStyle?.mode).toBe("off");

    const provider = byTitle("Provider TTFT p90 / p50 by provider (dispatch -> first delta)");
    const exprs = (provider?.targets ?? []).map((target) => target.expr ?? "");
    expect(exprs.some((expr) => expr.includes('content="any"'))).toBe(true);
    expect(exprs.some((expr) => expr.includes('content="text"'))).toBe(true);

    const baseline = byTitle("Provider TTFT p90: last 30m vs trailing 24h baseline");
    expect(JSON.stringify(baseline?.targets)).toContain(
      "opengeni:model_provider_ttft_seconds:p90_24h_baseline",
    );

    const ours = byTitle("OpenGeni pre-dispatch p95 / p50 (model entry -> provider dispatch)");
    expect(ours?.targets?.[0]?.expr).toContain(
      "opengeni_model_request_pre_dispatch_seconds_bucket",
    );
    expect(ours?.fieldConfig?.defaults?.thresholds?.steps).toContainEqual({
      color: "red",
      value: 2,
    });
  });
});
