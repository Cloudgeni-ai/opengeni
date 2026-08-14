import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("Google Drive sync dashboard", () => {
  test("scopes every OpenGeni panel to one exact namespace, environment, and release", async () => {
    const dashboard = await loadDashboard();
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

  test("contains the required release health signals", async () => {
    const dashboard = await loadDashboard();
    const titles = new Set(
      (dashboard.panels as Array<{ title?: string }>).map((panel) => panel.title),
    );
    for (const title of [
      "Run rate by outcome",
      "Failure ratio (15m)",
      "Reconnect required (15m)",
      "p95 terminal batch duration by outcome",
      "Provider attempts and retries",
      "Explicit sync limit hits",
      "Terminal failures by bounded reason",
    ]) {
      expect(titles).toContain(title);
    }

    const expressions = collectExpressions(dashboard).join("\n");
    for (const metric of [
      "opengeni_knowledge_source_sync_runs_total",
      "opengeni_knowledge_source_sync_terminal_batch_duration_seconds_bucket",
      "opengeni_knowledge_source_sync_provider_requests_total",
      "opengeni_google_drive_provider_requests_total",
      "opengeni_google_drive_provider_retries_total",
      "opengeni_knowledge_source_sync_limit_hits_total",
      "opengeni_knowledge_source_sync_reconnect_required_total",
      "opengeni_knowledge_source_sync_failures_total",
    ]) {
      expect(expressions).toContain(metric);
    }
  });
});

async function loadDashboard(): Promise<any> {
  return JSON.parse(await readFile(new URL("./google-drive-sync.json", import.meta.url), "utf8"));
}

function collectExpressions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectExpressions);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.expr === "string" ? [record.expr] : []),
    ...Object.values(record).flatMap(collectExpressions),
  ];
}
