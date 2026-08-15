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
});
