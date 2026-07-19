import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("worker fleet dashboard scope", () => {
  test("requires one exact namespace, environment, and release for every OpenGeni panel", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./worker-fleet.json", import.meta.url), "utf8"),
    );
    const expressions = collectExpressions(dashboard).filter((expression) =>
      expression.includes("opengeni_"),
    );
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      expect(expression).toContain('namespace="$namespace"');
      expect(expression).toContain('environment="$environment"');
      expect(expression).toContain('release="$release"');
      expect(expression).not.toContain('namespace=~"$namespace"');
      expect(expression).not.toContain('environment=~"$environment"');
      expect(expression).not.toContain('release=~"$release"');
      expect(expression).not.toContain("$release.*");
    }
    const variables = dashboard.templating.list.filter((variable: { name?: string }) =>
      ["namespace", "environment", "release"].includes(variable.name ?? ""),
    );
    expect(variables.map((variable: { name: string }) => variable.name)).toEqual([
      "namespace",
      "environment",
      "release",
    ]);
    for (const variable of variables) {
      expect(variable.includeAll).toBe(false);
      expect(variable.multi).toBe(false);
      expect(variable.current).toEqual({});
      expect(variable.allValue).toBeUndefined();
    }
  });

  test("shows capacity freshness and scopes Kubernetes joins by exact release labels", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./worker-fleet.json", import.meta.url), "utf8"),
    );
    const panels = dashboard.panels as Array<{
      title?: string;
      targets?: Array<{ expr?: string }>;
    }>;
    const byTitle = new Map(panels.map((panel) => [panel.title, panel]));

    expect(byTitle.get("Turn capacity monitor freshness (all workers)")?.targets?.[0]?.expr).toBe(
      'min(opengeni_turn_capacity_monitor_fresh{namespace="$namespace",environment="$environment",release="$release"})',
    );
    expect(byTitle.get("Turn capacity monitor last-success age (max)")?.targets?.[0]?.expr).toBe(
      'max(opengeni_turn_capacity_monitor_last_success_age_seconds{namespace="$namespace",environment="$environment",release="$release"})',
    );

    const infrastructureExpressions = collectExpressions(dashboard).filter(
      (expression) =>
        expression.includes("container_memory_working_set_bytes") ||
        expression.includes("kube_horizontalpodautoscaler_status_current_replicas") ||
        expression.includes("kube_horizontalpodautoscaler_spec_max_replicas"),
    );
    expect(infrastructureExpressions).toHaveLength(3);
    for (const expression of infrastructureExpressions) {
      expect(expression).toContain('label_app_kubernetes_io_instance="$release"');
      expect(expression).toContain(
        'label_app_kubernetes_io_component=~"worker-control|worker-turns"',
      );
      expect(expression).not.toContain('pod=~"$release');
      expect(expression).not.toContain('horizontalpodautoscaler=~"$release');
    }
  });
});

function collectExpressions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectExpressions);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.expr === "string" ? [record.expr] : []),
    ...Object.values(record).flatMap(collectExpressions),
  ];
}
