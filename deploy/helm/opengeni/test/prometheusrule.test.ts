import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const SCRAPE_IDENTITY = "and on(namespace, release, environment, component, instance)";
const DEPLOYMENT_SCOPE =
  "namespace={{ .Release.Namespace | quote }},release={{ .Release.Name | quote }},environment={{ $environment | quote }}";

describe("turn-capacity Prometheus alerts", () => {
  test("labels the complete rule group with exact deployment identity", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );

    const groupStart = template.indexOf("    - name: opengeni.rules\n");
    const rulesStart = template.indexOf("      rules:\n", groupStart);
    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(rulesStart).toBeGreaterThan(groupStart);
    expect(template.slice(groupStart, rulesStart)).toContain(`      labels:
        namespace: {{ .Release.Namespace | quote }}
        environment: {{ $environment | quote }}
        release: {{ .Release.Name | quote }}`);
  });

  test("keeps cumulative startup latency out of paging alerts", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    for (const name of [
      "OpenGeniTurnStartupQueueP95High",
      "OpenGeniTurnStartupProviderDispatchP95High",
      "OpenGeniTurnStartupFirstByteP95High",
    ]) {
      expect(template).not.toContain(name);
    }
    for (const value of [
      "turnStartupQueueP95Seconds",
      "turnStartupProviderDispatchP95Seconds",
      "turnStartupFirstByteP95Seconds",
    ]) {
      expect(template).not.toContain(value);
    }
    expect(template).not.toContain("opengeni_turn_startup_milestone_duration_seconds_bucket");
    expect(template).toContain("OpenGeniTurnStartupFirstByteAvailabilityLow");
    expect(template).toContain("OpenGeniTurnEligibleBacklogOld");
    expect(template).toContain("OpenGeniTurnSlotsSaturated");
    expect(template).toContain("OpenGeniTurnCapacityMonitorStale");
  });

  test("renders disjoint startup alert scopes for separate releases and environments", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const expression = alertExpression(template, "OpenGeniTurnStartupFirstByteAvailabilityLow");
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

  test("alerts on bounded runtime, tool, lifecycle, API, and recovery failures", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const expected = new Map([
      ["OpenGeniTurnFailureRatioHigh", ["opengeni_turns_total", 'outcome="failed"']],
      ["OpenGeniTurnRecoveryRatioHigh", ["opengeni_turns_total", 'outcome="recovering"']],
      [
        "OpenGeniTurnWorkerDeathRecovered",
        ["opengeni_turn_worker_death_recoveries_total", 'outcome="recovering"'],
      ],
      [
        "OpenGeniTurnWorkerDeathRecoveryExhausted",
        ["opengeni_turn_worker_death_recoveries_total", 'outcome="exhausted"'],
      ],
      [
        "OpenGeniModelCallFailureRatioHigh",
        ["opengeni_model_calls_total", 'outcome="failed"', "sum by (provider)"],
      ],
      [
        "OpenGeniMcpStrictConnectFailed",
        ["opengeni_mcp_lifecycle_operations_total", 'policy="strict"', 'outcome="failed"'],
      ],
      [
        "OpenGeniMcpCloseFailed",
        ["opengeni_mcp_lifecycle_operations_total", 'phase="close"', 'outcome="failed"'],
      ],
      [
        "OpenGeniMcpBestEffortConnectFailureRatio",
        ["opengeni_mcp_lifecycle_operations_total", 'policy="best_effort"'],
      ],
      [
        "OpenGeniMcpToolFailureRatio",
        [
          "opengeni_mcp_tool_calls_total",
          'outcome=~"provider_declared_error|auth_needed|outcome_uncertain|timeout|thrown_transport_error|thrown_protocol_error"',
        ],
      ],
      ["OpenGeniMcpToolOutcomeUncertain", ["outcome_uncertain"]],
      ["OpenGeniMcpToolLatencyHigh", ["opengeni_mcp_tool_call_duration_seconds_bucket"]],
      ["OpenGeniHttp5xxRatioHigh", ["opengeni_http_requests_total", 'status=~"5.."']],
      [
        "OpenGeniCoreReadLatencyHigh",
        [
          "opengeni_http_request_duration_seconds_bucket",
          'method="GET"',
          'route=~"/v1/workspaces/:workspaceId|/v1/workspaces/:workspaceId/sessions|/v1/workspaces/:workspaceId/sessions/:id"',
        ],
      ],
    ]);

    for (const [alert, signals] of expected) {
      const expression = alertExpression(template, alert);
      for (const signal of signals)
        expect(expression, `${alert} missing ${signal}`).toContain(signal);
      for (const selector of metricSelectors(expression))
        expect(selector).toContain(DEPLOYMENT_SCOPE);
      expect(expression).not.toMatch(/workspace_id|session_id|turn_id|tool_name|server_id/);
      if (alert === "OpenGeniMcpToolFailureRatio") {
        expect(expression).not.toContain("cancelled");
      }
    }
  });

  test("alerts on release-owned turn-worker restarts and crash loops", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );

    for (const [alert, threshold] of [
      ["OpenGeniTurnWorkerRestarted", "> 0"],
      ["OpenGeniTurnWorkerCrashLoop", "> 1"],
    ] as const) {
      const expression = alertExpression(template, alert);
      expect(expression).toContain("kube_pod_container_status_restarts_total");
      expect(expression).toContain("kube_pod_labels");
      expect(expression).toContain("label_app_kubernetes_io_instance={{ .Release.Name | quote }}");
      expect(expression).toContain('label_app_kubernetes_io_component="worker-turns"');
      expect(expression).toContain("* on(namespace, pod) group_left()");
      expect(expression).toContain(threshold);
      expect(expression).not.toMatch(/workspace_id|session_id|turn_id|attempt_id/);
    }
  });

  test("scopes streaming alerts to the exact deployment", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    for (const alert of [
      "OpenGeniStreamingFirstTokenSlow",
      "OpenGeniEventAppendLatencyHigh",
      "OpenGeniEventPublishLatencyHigh",
    ]) {
      for (const selector of metricSelectors(alertExpression(template, alert))) {
        expect(selector).toContain(DEPLOYMENT_SCOPE);
      }
    }
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

  test("alerts on durable recovery backlog only while its global projection is fresh", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const backlog = alertExpression(template, "OpenGeniSessionRecoveryBacklogStale");
    const stale = alertExpression(template, "OpenGeniSessionRecoveryMonitorStale");

    expect(backlog).toContain("opengeni_session_recovery_backlog");
    expect(backlog).toContain("opengeni_session_recovery_monitor_fresh");
    expect(backlog.split(SCRAPE_IDENTITY)).toHaveLength(3);
    expect(backlog.trimStart()).toStartWith("max(");
    expect(backlog).not.toContain("and on()");
    expect(backlog).toContain('component="worker-control"');
    expect(backlog).not.toMatch(/session_id|workspace_id|attempt_id/);
    expect(stale).toContain("absent(opengeni_session_recovery_monitor_fresh");
    expect(stale).toContain("min(opengeni_session_recovery_monitor_fresh");
    expect(stale).toContain(
      "time() - min(opengeni_session_recovery_monitor_last_success_timestamp_seconds",
    );
    expect(stale).not.toContain("max(opengeni_session_recovery_monitor_fresh");
    expect(stale).not.toContain(
      "max(opengeni_session_recovery_monitor_last_success_timestamp_seconds",
    );
    for (const expression of [backlog, stale]) {
      for (const selector of metricSelectors(expression)) {
        expect(selector).toContain(DEPLOYMENT_SCOPE);
      }
    }
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
        "OpenGeniOpenSandboxInventoryStale",
        ['opengeni_sandbox_inventory_refresh_timestamp_seconds{domain="opensandbox_kubernetes"}'],
      ],
      [
        "OpenGeniOpenSandboxPodPending",
        ['opengeni:opensandbox_workload_pods:fresh_max{condition="pending"}'],
      ],
      [
        "OpenGeniOpenSandboxImagePullFailed",
        ['opengeni:opensandbox_workload_pods:fresh_max{condition="image_pull"}'],
      ],
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
        ['opengeni:opensandbox_workload_pods:fresh_max{condition="unschedulable"}'],
      ],
      ["OpenGeniOpenSandboxCleanupStuck", ["opengeni:opensandbox_cleanup_stuck:fresh_max"]],
      [
        "OpenGeniOpenSandboxExpirationOverdue",
        ["opengeni:opensandbox_expiration_overdue:fresh_max"],
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
    expect(template).not.toMatch(/opensandbox_batchsandbox_(?:status|deletion|finalizer|spec)/);
  });
});

describe("Codex pool Prometheus alerts", () => {
  test("deduplicates low-pool counters by deployment and workspace", async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );

    for (const alertName of [
      "OpenGeniCodexCredentialPoolEmpty",
      "OpenGeniCodexCredentialPoolSingle",
    ]) {
      const expression = alertExpression(template, alertName);
      expect(expression).toContain(
        "sum by (namespace, release, environment, component, workspace_key)",
      );
      expect(expression).not.toContain("pod");
      expect(expression).not.toContain("instance");
      for (const selector of metricSelectors(expression)) {
        expect(selector).toContain(DEPLOYMENT_SCOPE);
      }
    }

    expect(template).toContain('Workspace pool {{ "{{ $labels.workspace_key }}" }} observed zero');
    expect(template).toContain(
      'Workspace pool {{ "{{ $labels.workspace_key }}" }} observed exactly one',
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
