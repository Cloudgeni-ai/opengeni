import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("turn startup dashboard", () => {
  test("separates platform phases from real end-to-end first-byte milestones", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./turn-startup.json", import.meta.url), "utf8"),
    ) as { panels: Array<{ title?: string }>; time?: { from?: string }; timepicker?: unknown };
    const titles = new Set(dashboard.panels.map((panel) => panel.title));

    expect(titles).toContain("Worker preparation p50 / p95 / p99");
    expect(titles).toContain("Selected startup phase p50 / p95 / p99");
    expect(titles).toContain("End-to-end startup milestones p50 / p95 / p99");
    expect(titles).toContain("Platform preparation vs provider think time (p95)");
    expect(dashboard.time?.from).toBe("now-7d");

    const serialized = JSON.stringify(dashboard);
    for (const metric of [
      "opengeni_turn_worker_preparation_duration_seconds",
      "opengeni_turn_startup_phase_duration_seconds",
      "opengeni_turn_startup_milestone_duration_seconds",
      "opengeni_model_request_phase_duration_seconds",
    ]) {
      expect(serialized).toContain(metric);
    }
    expect(serialized).toContain("30d");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain("turnId");
    expect(serialized).not.toContain("requestId");
  });
});
