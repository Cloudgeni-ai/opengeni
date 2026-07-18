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
