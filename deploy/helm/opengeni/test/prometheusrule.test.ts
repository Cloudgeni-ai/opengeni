import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SCRAPE_IDENTITY = "and on(namespace, release, environment, component, instance)";
const DEPLOYMENT_SCOPE =
  "namespace={{ .Release.Namespace | quote }},release={{ .Release.Name | quote }},environment={{ $environment | quote }}";

describe("turn-capacity Prometheus alerts", () => {
  test("alerts on cumulative provider-dispatch and first-byte p95 SLOs", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    for (const [name, milestone] of [
      ["OpenGeniTurnStartupProviderDispatchP95High", "provider_dispatch"],
      ["OpenGeniTurnStartupFirstByteP95High", "first_byte"],
    ] as const) {
      const expression = alertExpression(template, name);
      expect(expression).toContain("opengeni_turn_startup_milestone_duration_seconds_bucket");
      expect(expression).toContain(`milestone="${milestone}"`);
      expect(expression).toContain("histogram_quantile(");
      expect(expression).toContain("turnStartupMinSamples");
      for (const selector of metricSelectors(expression)) {
        expect(selector).toContain(DEPLOYMENT_SCOPE);
      }
      expect(expression).not.toContain("sessionId");
      expect(expression).not.toContain("turnId");
    }
    expect(template).not.toContain("OpenGeniTurnStartupQueueP95High");
    expect(template).not.toContain("turnStartupQueueP95Seconds");
    expect(template).toContain("OpenGeniTurnEligibleBacklogOld");
    expect(template).toContain("OpenGeniTurnSlotsSaturated");
  });

  test("renders disjoint startup alert scopes for separate releases and environments", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const expression = alertExpression(template, "OpenGeniTurnStartupFirstByteP95High");
    const production = renderDeploymentScope(expression, {
      namespace: "opengeni-shared",
      release: "release-a",
      environment: "production",
    });
    const staging = renderDeploymentScope(expression, {
      namespace: "opengeni-shared",
      release: "release-b",
      environment: "staging",
    });

    expect(production).toContain(
      'namespace="opengeni-shared",release="release-a",environment="production"',
    );
    expect(production).not.toContain('release="release-b"');
    expect(staging).toContain(
      'namespace="opengeni-shared",release="release-b",environment="staging"',
    );
    expect(staging).not.toContain('environment="production"');
  });

  test("alerts when bounded logical turns terminate failed without first-byte availability", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const availability = alertExpression(template, "OpenGeniTurnStartupFirstByteAvailabilityLow");
    const latency = alertExpression(template, "OpenGeniTurnStartupFirstByteP95High");

    expect(availability).toContain("opengeni_turn_startup_milestone_duration_seconds_count");
    expect(availability).toContain('milestone="first_byte",outcome="completed"');
    expect(availability).toContain('milestone="first_byte",outcome="failed"');
    expect(availability).toContain('outcome=~"completed|failed"');
    expect(availability).not.toContain("opengeni_model_request_phases_total");
    expect(availability).toContain("or on(provider)");
    expect(availability).toContain("0 * sum by (provider)");
    expect(availability).toContain("turnStartupFirstByteAvailabilityRatio");
    expect(availability).toContain("turnStartupMinSamples");
    for (const selector of metricSelectors(availability)) {
      expect(selector).toContain(DEPLOYMENT_SCOPE);
    }
    expect(latency).toContain('milestone="first_byte",outcome="completed"');
    expect(latency).not.toContain('outcome="failed"');
    expect(latency).not.toContain("opengeni_model_request_phases_total");
  });

  test("alerts on actual SuperGrok valid-event idle timeout terminals", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const idleTimeout = alertExpression(template, "OpenGeniSuperGrokResponseStreamIdleTimeout");

    expect(idleTimeout).toContain('provider="supergrok-subscription"');
    expect(idleTimeout).toContain('phase="terminal"');
    expect(idleTimeout).toContain('outcome="timed_out"');
    expect(idleTimeout).not.toContain("requestId");
  });

  test("correlates backlog and freshness before fleet aggregation", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const oldest = alertExpression(template, "OpenGeniTurnEligibleBacklogOld");
    const saturation = alertExpression(template, "OpenGeniTurnSlotsSaturated");

    expect(oldest.split(SCRAPE_IDENTITY)).toHaveLength(4);
    expect(saturation.split(SCRAPE_IDENTITY)).toHaveLength(4);
    for (const expression of [oldest, saturation]) {
      expect(expression.trimStart()).toStartWith("max(");
      expect(expression).not.toContain("and on()");
      expect(expression).not.toMatch(/max\(opengeni_turn_(eligible_backlog|capacity_monitor)/);
    }
  });

  test("detects the worst stale or missing expected turn-worker monitor", async () => {
    const [ruleTemplate, monitorTemplate] = await Promise.all([
      readFile(new URL("../templates/prometheusrule.yaml", import.meta.url), "utf8"),
      readFile(new URL("../templates/servicemonitor.yaml", import.meta.url), "utf8"),
    ]);
    const stale = alertExpression(ruleTemplate, "OpenGeniTurnCapacityMonitorStale");

    expect(stale).toContain("min(opengeni_turn_capacity_monitor_fresh");
    expect(stale).toContain(
      "time() - min(opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
    );
    expect(stale).toContain("min(up{namespace=");
    expect(stale).toContain('opengeni_workload_component="worker-turns"');
    expect(stale).toContain("count(opengeni_turn_capacity_monitor_fresh");
    expect(stale).not.toContain("max(opengeni_turn_capacity_monitor_fresh");
    expect(stale).not.toContain(
      "max(opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
    );
    expect(monitorTemplate).toContain(
      "sourceLabels: [__meta_kubernetes_service_label_app_kubernetes_io_component]\n" +
        "          targetLabel: opengeni_workload_component",
    );
  });
});

function alertExpression(template: string, alertName: string): string {
  const marker = `- alert: ${alertName}\n`;
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`Missing alert ${alertName}`);
  const expressionStart = template.indexOf("          expr: |\n", start);
  const expressionEnd = template.indexOf("          for:", expressionStart);
  if (expressionStart < 0 || expressionEnd < 0) {
    throw new Error(`Missing expression boundaries for ${alertName}`);
  }
  return template.slice(expressionStart + "          expr: |\n".length, expressionEnd);
}

function metricSelectors(expression: string): string[] {
  return [...expression.matchAll(/opengeni_[a-zA-Z0-9_:]+\{([^\n]*)\}/g)].map(
    (match) => match[1] ?? "",
  );
}

function renderDeploymentScope(
  expression: string,
  scope: { namespace: string; release: string; environment: string },
): string {
  return expression
    .replaceAll("{{ .Release.Namespace | quote }}", JSON.stringify(scope.namespace))
    .replaceAll("{{ .Release.Name | quote }}", JSON.stringify(scope.release))
    .replaceAll("{{ $environment | quote }}", JSON.stringify(scope.environment));
}
