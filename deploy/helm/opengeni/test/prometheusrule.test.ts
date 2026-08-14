import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SCRAPE_IDENTITY = "and on(namespace, release, environment, component, instance)";

describe("turn-capacity Prometheus alerts", () => {
  test("alerts on cumulative queue, provider-dispatch, and first-byte p95 SLOs", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    for (const [name, milestone] of [
      ["OpenGeniTurnStartupQueueP95High", "queue"],
      ["OpenGeniTurnStartupProviderDispatchP95High", "provider_dispatch"],
      ["OpenGeniTurnStartupFirstByteP95High", "first_byte"],
    ] as const) {
      const expression = alertExpression(template, name);
      expect(expression).toContain("opengeni_turn_startup_milestone_duration_seconds_bucket");
      expect(expression).toContain(`milestone="${milestone}"`);
      expect(expression).toContain("histogram_quantile(");
      expect(expression).toContain("turnStartupMinSamples");
      expect(expression).not.toContain("sessionId");
      expect(expression).not.toContain("turnId");
    }
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
