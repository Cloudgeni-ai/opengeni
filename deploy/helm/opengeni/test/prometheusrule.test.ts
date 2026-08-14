import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SCRAPE_IDENTITY = "and on(namespace, release, environment, component, instance)";

describe("turn-capacity Prometheus alerts", () => {
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

  test("fences the complete OpenSandbox failure catalog to the selected backend", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    expect(template).toContain("{{- if $opensandboxEnabled }}");

    const expected = new Map([
      [
        "OpenGeniOpenSandboxApiThrottled",
        [
          "opengeni_sandbox_provider_api_throttles_total",
          'rest_client_requests_total{namespace="opensandbox-system",code="429"}',
        ],
      ],
      [
        "OpenGeniOpenSandboxTtlRenewalFailed",
        ["opengeni_sandbox_ttl_renewals_total", 'outcome="failed"'],
      ],
      [
        "OpenGeniOpenSandboxPoolDepleted",
        [
          "opensandbox_pool_status_available",
          "opensandbox_pool_spec_buffer_min",
          "opensandbox_pool_spec_pool_max",
        ],
      ],
      [
        "OpenGeniOpenSandboxPodPending",
        ['kube_pod_status_phase{namespace="opensandbox",phase="Pending"}'],
      ],
      ["OpenGeniOpenSandboxImagePullFailed", ["ErrImagePull|ImagePullBackOff|InvalidImageName"]],
      [
        "OpenGeniOpenSandboxControllerError",
        [
          "controller_runtime_reconcile_errors_total",
          "opensandbox-controller-manager",
          "kube_pod_container_status_restarts_total",
        ],
      ],
      [
        "OpenGeniOpenSandboxCapacityExhausted",
        ['kube_pod_status_unschedulable{namespace="opensandbox"}'],
      ],
      [
        "OpenGeniOpenSandboxCleanupStuck",
        [
          "opensandbox_batchsandbox_deletion_timestamp_seconds",
          "opensandbox_batchsandbox_finalizer_info",
        ],
      ],
      [
        "OpenGeniOpenSandboxExpirationOverdue",
        ["opensandbox_batchsandbox_spec_expire_time_seconds"],
      ],
    ]);

    for (const [alert, signals] of expected) {
      const expression = alertExpression(template, alert);
      for (const signal of signals)
        expect(expression, `${alert} missing ${signal}`).toContain(signal);
      expect(expression).not.toMatch(/workspace_id|session_id|sandbox_id|attempt_id/);
    }
    expect(template).toContain(
      "The pinned controller metrics endpoint reports reconcile errors; Kubernetes readiness and restart truth remain independent backstops.",
    );
  });
});

function alertExpression(template: string, alertName: string): string {
  const marker = `- alert: ${alertName}\n`;
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`Missing alert ${alertName}`);
  const expressionStart = template.indexOf("          expr:", start);
  if (expressionStart < 0) {
    throw new Error(`Missing expression boundaries for ${alertName}`);
  }
  const expressionLineEnd = template.indexOf("\n", expressionStart);
  const expressionLine = template.slice(expressionStart, expressionLineEnd);
  if (expressionLine === "          expr: |") {
    const expressionEnd = template.indexOf("          for:", expressionLineEnd);
    if (expressionEnd < 0) throw new Error(`Missing multiline expression end for ${alertName}`);
    return template.slice(expressionLineEnd + 1, expressionEnd);
  }
  return expressionLine.slice("          expr:".length).trim();
}
