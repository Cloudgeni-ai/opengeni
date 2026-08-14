import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("sandbox health dashboard", () => {
  test("separates logical outcomes, internal retries, and unknown failure ratio", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./sandbox-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{ title?: string; targets?: Array<{ expr?: string }> }>;
    };
    const titles = new Set(dashboard.panels.map((panel) => panel.title));
    expect(titles).toContain("Logical provisions by outcome and category");
    expect(titles).toContain("Logical provision latency p50 / p95 / p99");
    expect(titles).toContain("Internal provision attempts and transitions");
    expect(titles).toContain("Unknown logical provision failure ratio");

    const expressions = dashboard.panels.flatMap(
      (panel) => panel.targets?.map((target) => target.expr ?? "") ?? [],
    );
    expect(expressions.some((expr) => expr.includes("opengeni_sandbox_provisions_total"))).toBe(
      true,
    );
    expect(
      expressions.some((expr) => expr.includes("opengeni_sandbox_provision_attempts_total")),
    ).toBe(true);
    expect(
      expressions.filter((expr) =>
        expr.includes("opengeni_sandbox_provision_duration_seconds_bucket"),
      ),
    ).toHaveLength(3);
    expect(
      expressions.some(
        (expr) =>
          expr.includes('outcome="failed"') &&
          expr.includes('category="unknown"') &&
          expr.includes("0.000000001"),
      ),
    ).toBe(true);

    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain("provisionId");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain("sandboxGroupId");
  });
});
