import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("runtime failures dashboard", () => {
  test("puts bounded failure and latency signals on one deployment-scoped board", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./runtime-failures.json", import.meta.url), "utf8"),
    ) as RuntimeFailuresDashboard;
    const titles = new Set(dashboard.panels.map((panel) => panel.title));
    for (const title of [
      "Firing critical alerts",
      "Firing warnings",
      "App scrape health",
      "Synthetic probe age",
      "Turn-worker restarts · 15m",
      "Recovery exhausted · range",
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
      "opengeni_turn_worker_death_recoveries_total",
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
      "kube_cronjob_status_last_successful_time",
      "kube_pod_container_status_restarts_total",
      "kube_pod_labels",
      "ALERTS",
    ]) {
      expect(serialized).toContain(metric);
    }
    expect(serialized).not.toMatch(/sessionId|turnId|requestId|toolName|serverId/);
  });

  test("makes healthy zeroes and missing telemetry visually distinct", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./runtime-failures.json", import.meta.url), "utf8"),
    ) as RuntimeFailuresDashboard;
    const panels = new Map(dashboard.panels.map((panel) => [panel.title, panel]));

    expect(panels.get("Firing critical alerts")?.targets?.[0]?.expr).toContain("or vector(0)");
    expect(panels.get("Firing warnings")?.targets?.[0]?.expr).toContain("or vector(0)");
    const exhaustedRecovery = panels.get("Recovery exhausted · range")?.targets?.[0]?.expr ?? "";
    expect(exhaustedRecovery).toContain("or on() (0 * count(up{");
    expect(exhaustedRecovery).toContain("opengeni_workload_component");
    const scrapeHealth = panels.get("App scrape health")?.targets?.[0]?.expr ?? "";
    expect(scrapeHealth).not.toContain("or vector(0)");
    expect(scrapeHealth).toContain("opengeni_workload_component");
    expect(panels.get("Synthetic probe age")?.targets?.[0]?.expr).not.toContain("or vector(0)");

    const ratio = panels.get("Turn failure and recovery ratios");
    expect(ratio?.targets).toHaveLength(2);
    for (const target of ratio?.targets ?? []) {
      expect(target.expr).toContain("or vector(0)");
      expect(target.expr).toContain("clamp_min");
    }
  });

  test("attributes worker restarts to the selected release", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./runtime-failures.json", import.meta.url), "utf8"),
    ) as RuntimeFailuresDashboard;
    const restarts = dashboard.panels.find((panel) => panel.title === "Turn-worker restarts · 15m");
    const expression = restarts?.targets?.[0]?.expr ?? "";
    expect(expression).toContain("kube_pod_container_status_restarts_total");
    expect(expression).toContain("kube_pod_labels");
    expect(expression).toContain('label_app_kubernetes_io_instance="$release"');
    expect(expression).toContain('label_app_kubernetes_io_component="worker-turns"');
    expect(expression).toContain("* on(namespace, pod) group_left()");
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
    expect(variables.get("namespace")?.definition).toContain("opengeni_workload_component");
    expect(variables.get("namespace")?.definition).not.toContain("opengeni_turns_total");

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
      definition?: string;
    }>;
  };
}

function metricSelectors(expression: string): string[] {
  return [...expression.matchAll(/opengeni_[a-zA-Z0-9_:]+\{([^}]*)\}/g)].map(
    (match) => match[1] ?? "",
  );
}
