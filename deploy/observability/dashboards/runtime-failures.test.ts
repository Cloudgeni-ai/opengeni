import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("runtime failures dashboard", () => {
  test("puts bounded failure and latency signals on one deployment-scoped board", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./runtime-failures.json", import.meta.url), "utf8"),
    ) as RuntimeFailuresDashboard;
    const titles = new Set(dashboard.panels.map((panel) => panel.title));
    for (const title of [
      "Turn outcomes",
      "Turn failure and recovery ratios",
      "MCP lifecycle operations",
      "MCP tool calls by outcome",
      "MCP tool-call p95 by outcome",
      "Failed startup phases",
      "Logical sandbox provision failures",
      "API 5xx by route and status",
      "Core workspace and session read p95",
      "Durable append and live publish p99",
      "Model call outcomes",
      "Incident delivery path",
    ]) {
      expect(titles).toContain(title);
    }

    const serialized = JSON.stringify(dashboard);
    for (const metric of [
      "opengeni_turns_total",
      "opengeni_mcp_lifecycle_operations_total",
      "opengeni_mcp_tool_calls_total",
      "opengeni_mcp_tool_call_duration_seconds_bucket",
      "opengeni_turn_startup_phase_duration_seconds_count",
      "opengeni_sandbox_provisions_total",
      "opengeni_http_requests_total",
      "opengeni_http_request_duration_seconds_bucket",
      "opengeni_session_event_append_seconds_bucket",
      "opengeni_session_event_publish_seconds_bucket",
      "opengeni_model_calls_total",
      "alertmanager_notifications_failed_total",
      "kube_deployment_status_replicas_available",
    ]) {
      expect(serialized).toContain(metric);
    }
    expect(serialized).not.toMatch(/sessionId|turnId|requestId|toolName|serverId/);
  });

  test("pins every panel selector to one namespace, environment, and release", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./runtime-failures.json", import.meta.url), "utf8"),
    ) as RuntimeFailuresDashboard;
    const variables = new Map(
      dashboard.templating.list.map((variable) => [variable.name, variable]),
    );
    for (const name of ["namespace", "environment", "release"]) {
      expect(variables.get(name)?.includeAll).toBe(false);
      expect(variables.get(name)?.multi).toBe(false);
    }

    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        for (const selector of metricSelectors(target.expr)) {
          expect(selector).toContain('namespace="$namespace"');
          expect(selector).toContain('environment="$environment"');
          expect(selector).toContain('release="$release"');
        }
      }
    }
  });
});

interface RuntimeFailuresDashboard {
  panels: Array<{ title?: string; targets?: Array<{ expr: string }> }>;
  templating: {
    list: Array<{
      name: string;
      includeAll?: boolean;
      multi?: boolean;
    }>;
  };
}

function metricSelectors(expression: string): string[] {
  return [...expression.matchAll(/opengeni_[a-zA-Z0-9_:]+\{([^}]*)\}/g)].map(
    (match) => match[1] ?? "",
  );
}
