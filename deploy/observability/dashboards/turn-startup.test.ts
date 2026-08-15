import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("turn startup dashboard", () => {
  test("separates platform phases from real end-to-end first-byte milestones", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./turn-startup.json", import.meta.url), "utf8"),
    ) as TurnStartupDashboard;
    const titles = new Set(dashboard.panels.map((panel) => panel.title));

    expect(titles).toContain("Worker preparation p50 / p95 / p99");
    expect(titles).toContain("Selected startup phase p50 / p95 / p99");
    expect(titles).toContain("End-to-end startup milestones p50 / p95 / p99");
    expect(titles).toContain("First-byte availability and pre-byte failure pressure");
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

  test("pins every deployment metric selector to one namespace, environment, and release", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./turn-startup.json", import.meta.url), "utf8"),
    ) as TurnStartupDashboard;
    const variables = new Map(
      dashboard.templating.list.map((variable) => [variable.name, variable]),
    );

    for (const name of ["namespace", "environment", "release"]) {
      expect(variables.get(name)?.includeAll).toBe(false);
      expect(variables.get(name)?.multi).toBe(false);
    }
    expect(variableQuery(variables, "environment")).toContain('namespace="$namespace"');
    expect(variableQuery(variables, "release")).toContain('namespace="$namespace"');
    expect(variableQuery(variables, "release")).toContain('environment="$environment"');
    for (const name of ["provider", "backend", "phase"]) {
      const query = variableQuery(variables, name);
      expect(query).toContain('namespace="$namespace"');
      expect(query).toContain('environment="$environment"');
      expect(query).toContain('release="$release"');
    }

    const selected = {
      namespace: "opengeni-a",
      environment: "production",
      release: "release-a",
    };
    const disjointDeployments = [
      { ...selected, environment: "staging" },
      { ...selected, release: "release-b" },
      { ...selected, namespace: "opengeni-b" },
    ];
    for (const panel of dashboard.panels) {
      for (const target of panel.targets ?? []) {
        for (const selector of metricSelectors(target.expr)) {
          const scope = deploymentScope(selector);
          expect(scope).toEqual({
            namespace: "$namespace",
            environment: "$environment",
            release: "$release",
          });
          expect(matchesScope(selected, selected)).toBe(true);
          for (const other of disjointDeployments) {
            expect(matchesScope(other, selected)).toBe(false);
          }
        }
      }
    }
  });

  test("keeps successful first-byte latency separate from pre-byte availability evidence", async () => {
    const dashboard = JSON.parse(
      await readFile(new URL("./turn-startup.json", import.meta.url), "utf8"),
    ) as TurnStartupDashboard;
    const latency = dashboard.panels.find(
      (panel) => panel.title === "End-to-end startup milestones p50 / p95 / p99",
    );
    const availability = dashboard.panels.find(
      (panel) => panel.title === "First-byte availability and pre-byte failure pressure",
    );
    const latencyExpressions = (latency?.targets ?? []).map((target) => target.expr).join("\n");
    const availabilityExpressions = (availability?.targets ?? [])
      .map((target) => target.expr)
      .join("\n");

    expect(latencyExpressions).toContain("opengeni_turn_startup_milestone_duration_seconds_bucket");
    expect(latencyExpressions).toContain('outcome="completed"');
    expect(latencyExpressions).not.toContain("opengeni_model_request_phases_total");
    expect(availabilityExpressions).toContain(
      "opengeni_turn_startup_milestone_duration_seconds_count",
    );
    expect(availabilityExpressions).toContain('milestone="first_byte",outcome="completed"');
    expect(availabilityExpressions).toContain('milestone="first_byte",outcome="failed"');
    expect(availabilityExpressions).toContain('outcome=~"completed|failed"');
    expect(availabilityExpressions).not.toContain("opengeni_model_request_phases_total");
    expect(availabilityExpressions).toContain("or on(provider)");
    expect(availabilityExpressions).toContain("0 * sum by (provider)");
  });
});

interface TurnStartupDashboard {
  panels: Array<{ title?: string; targets?: Array<{ expr: string }> }>;
  templating: {
    list: Array<{
      name: string;
      query?: string | { query?: string };
      includeAll?: boolean;
      multi?: boolean;
    }>;
  };
  time?: { from?: string };
  timepicker?: unknown;
}

function variableQuery(
  variables: Map<string, TurnStartupDashboard["templating"]["list"][number]>,
  name: string,
): string {
  const query = variables.get(name)?.query;
  return typeof query === "string" ? query : (query?.query ?? "");
}

function metricSelectors(expression: string): string[] {
  return [...expression.matchAll(/opengeni_[a-zA-Z0-9_:]+\{([^}]*)\}/g)].map(
    (match) => match[1] ?? "",
  );
}

function deploymentScope(selector: string): Record<string, string> {
  return Object.fromEntries(
    [...selector.matchAll(/(?:^|,)(namespace|environment|release)="([^"]+)"/g)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

function matchesScope(
  candidate: { namespace: string; environment: string; release: string },
  selected: { namespace: string; environment: string; release: string },
): boolean {
  return (
    candidate.namespace === selected.namespace &&
    candidate.environment === selected.environment &&
    candidate.release === selected.release
  );
}
