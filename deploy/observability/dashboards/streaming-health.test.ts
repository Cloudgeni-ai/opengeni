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

  test("shows the live first-token warning threshold on the latency chart", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./streaming-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{
        title?: string;
        fieldConfig?: {
          defaults?: {
            thresholds?: { steps?: Array<{ color?: string; value?: number | null }> };
            custom?: { thresholdsStyle?: { mode?: string } };
          };
        };
      }>;
    };
    const ttft = dashboard.panels.find(
      (panel) => panel.title === "Time-to-first-token p99 / p95 / p50 by provider",
    );
    expect(ttft?.fieldConfig?.defaults?.thresholds?.steps).toContainEqual({
      color: "red",
      value: 8,
    });
    expect(ttft?.fieldConfig?.defaults?.custom?.thresholdsStyle?.mode).toBe("line");
  });
});
