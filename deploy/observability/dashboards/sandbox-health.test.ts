import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("sandbox health dashboard", () => {
  test("shows observed provider loss separately from the deadline backlog", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./sandbox-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{ id: number; title?: string; targets?: Array<{ expr?: string }> }>;
    };
    const loss = dashboard.panels.find(
      (panel) => panel.title === "Provider missing before workspace capture",
    );
    const backlog = dashboard.panels.find((panel) => panel.title === "Deadline rotation backlog");
    expect(loss).toBeDefined();
    expect(backlog).toBeDefined();
    expect(dashboard.panels.filter((panel) => panel.id === loss?.id)).toHaveLength(1);
    expect(loss?.targets?.[0]?.expr).toContain(
      "opengeni_sandbox_provider_missing_before_capture_total",
    );
    expect(loss?.targets?.[0]?.expr).toContain("max by (backend)");
    expect(loss?.targets?.[0]?.expr).toContain("offset 30m");
    expect(loss?.targets?.[0]?.expr).not.toContain("sandbox_rotation_backlog");
    expect(JSON.stringify(loss)).not.toMatch(/workspace_id|session_id|sandbox_group_id/);
  });

  test("shows authorized Modal fallback selection without treating it as restore success", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./sandbox-health.json", import.meta.url), "utf8"),
    ) as {
      panels: Array<{
        id: number;
        title?: string;
        description?: string;
        targets?: Array<{ expr?: string }>;
      }>;
    };
    const fallback = dashboard.panels.find(
      (panel) => panel.title === "Modal checkpoint fallback selected",
    );
    expect(fallback).toBeDefined();
    expect(dashboard.panels.filter((panel) => panel.id === fallback?.id)).toHaveLength(1);
    expect(fallback?.targets?.[0]?.expr).toContain(
      'opengeni_sandbox_checkpoint_fallback_total{backend="modal",outcome="selected"}',
    );
    expect(fallback?.targets?.[0]?.expr).toContain("offset 30m");
    expect(fallback?.description).toContain("does not prove the subsequent restore succeeded");
    expect(JSON.stringify(fallback)).not.toMatch(/workspace_id|session_id|sandbox_group_id/);
  });

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
