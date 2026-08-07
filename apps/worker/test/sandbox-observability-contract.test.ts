import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { OPENGENI_OBSERVABILITY_DISTRIBUTION } from "@opengeni/observability";

const dashboardsDir = "deploy/observability/dashboards";
const rulePath = "deploy/helm/opengeni/templates/prometheusrule.yaml";

type Dashboard = {
  uid: string;
  panels: Array<{ id: number; targets?: Array<{ expr?: string }> }>;
};

async function dashboard(name: string): Promise<Dashboard> {
  return JSON.parse(await Bun.file(`${dashboardsDir}/${name}`).text()) as Dashboard;
}

describe("sandbox observability contract", () => {
  test("all dashboards parse with unique UIDs and panel IDs", async () => {
    const files = (await readdir(dashboardsDir)).filter((name) => name.endsWith(".json"));
    const parsed = await Promise.all(files.map(dashboard));
    expect(new Set(parsed.map(({ uid }) => uid)).size).toBe(parsed.length);
    for (const value of parsed) {
      const ids = value.panels.map(({ id }) => id);
      expect(new Set(ids).size, `${value.uid} has duplicate panel IDs`).toBe(ids.length);
    }
  });

  test("the optional wrapper pins one durable, single-source monitoring stack", async () => {
    const chart = Bun.YAML.parse(await Bun.file("deploy/observability/Chart.yaml").text()) as {
      dependencies?: Array<{
        name?: string;
        repository?: string;
        version?: string;
        condition?: string;
      }>;
    };
    expect(chart.dependencies).toEqual([
      {
        name: "kube-prometheus-stack",
        repository: "https://prometheus-community.github.io/helm-charts",
        version: "87.16.1",
        condition: "kube-prometheus-stack.enabled",
      },
    ]);

    const values = Bun.YAML.parse(await Bun.file("deploy/observability/values.yaml").text()) as any;
    const stack = values["kube-prometheus-stack"];
    expect(stack.enabled).toBe(true);
    expect(stack.prometheus.prometheusSpec.retention).toBe("7d");
    expect(
      stack.prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests
        .storage,
    ).toBe("8Gi");
    expect(
      stack.alertmanager.alertmanagerSpec.storage.volumeClaimTemplate.spec.resources.requests
        .storage,
    ).toBe("2Gi");
    expect(stack.grafana.persistence).toMatchObject({ enabled: true, size: "2Gi" });
    expect(stack.grafana.sidecar.dashboards.provider.foldersFromFilesStructure).toBe(true);
    expect(values.opengeni.dashboards.folder).toBe("/tmp/dashboards/OpenGeni");
    const monitoringSelector = {
      [OPENGENI_OBSERVABILITY_DISTRIBUTION.monitoringNamespaceLabel]:
        OPENGENI_OBSERVABILITY_DISTRIBUTION.monitoringNamespaceLabelValue,
    };
    expect(stack.prometheus.prometheusSpec.serviceMonitorSelector.matchLabels).toEqual({
      "opengeni.ai/monitoring": "enabled",
    });
    expect(stack.prometheus.prometheusSpec.ruleSelector.matchLabels).toEqual({
      "opengeni.ai/monitoring": "enabled",
    });
    expect(stack.prometheus.prometheusSpec.serviceMonitorNamespaceSelector.matchLabels).toEqual(
      monitoringSelector,
    );
    expect(stack.prometheus.prometheusSpec.ruleNamespaceSelector.matchLabels).toEqual(
      monitoringSelector,
    );
    expect(stack.grafana.sidecar.dashboards.label).toBe(
      OPENGENI_OBSERVABILITY_DISTRIBUTION.grafanaDashboardLabel,
    );
    expect(stack.grafana.sidecar.dashboards.labelValue).toBe(
      OPENGENI_OBSERVABILITY_DISTRIBUTION.grafanaDashboardLabelValue,
    );
    expect(stack.grafana.sidecar.dashboards.searchNamespace).toBe("");
    expect(stack.grafana.sidecar.dashboards.resource).toBe("configmap");
    expect(stack.grafana.sidecar.datasources.resource).toBe("configmap");
    expect(stack.grafana.rbac.namespaced).toBe(true);

    const template = await Bun.file(
      "deploy/observability/templates/dashboard-configmaps.yaml",
    ).text();
    expect(template).toContain('.Files.Glob "dashboards/*.json"');
    expect(template).toContain("opengeni.ai/content-sha256");
    expect(template).not.toContain("streaming-health.json:");
  });

  test("the canonical sandbox board covers every operational lifecycle plane", async () => {
    const value = await dashboard("sandbox-health.json");
    expect(value.uid).toBe("opengeni-sandbox-health");
    const expressions = value.panels
      .flatMap(({ targets = [] }) => targets.map(({ expr = "" }) => expr))
      .join("\n");
    for (const required of [
      "opengeni:sandbox_leases:fresh_max",
      "opengeni_sandbox_inventory_refresh_timestamp_seconds",
      "opengeni_sandbox_inventory_refresh_failures_total",
      "opengeni_sandbox_creates_total",
      "opengeni_sandbox_create_duration_seconds_bucket",
      "opengeni_sandbox_operations_total",
      "opengeni_sandbox_operation_duration_seconds_bucket",
      "opengeni_sandbox_warming_timeouts_total",
      "opengeni_sandbox_orphans_terminated_total",
      "opengeni:sandbox_checkpoint_artifacts:fresh_max",
      "opengeni_sandbox_checkpoint_artifact_operations_total",
      "opengeni:sandbox_rotation_backlog:fresh_max",
      "opengeni:sandbox_leases_expired_draining:fresh_max",
      "opengeni:retained_processes_active:fresh_max",
      "opengeni:retained_processes_terminal_owner_backlog:fresh_max",
      "opengeni_retained_process_reconciliation_total",
    ]) {
      expect(expressions, `missing sandbox dashboard signal ${required}`).toContain(required);
    }
    expect(expressions).not.toMatch(/\bsum\s*(?:by\s*\([^)]*\))?\s*\(\s*opengeni_sandbox_leases\b/);
    expect(expressions).not.toMatch(/session_id|workspace_id|sandbox_id|provider_instance_id/);
  });

  test("worker fleet consumes the fresh lease recording rule", async () => {
    const value = await dashboard("worker-fleet.json");
    const expressions = value.panels
      .flatMap(({ targets = [] }) => targets.map(({ expr = "" }) => expr))
      .join("\n");
    expect(expressions).toContain("opengeni:sandbox_leases:fresh_max");
    for (const required of [
      "opengeni_turn_worker_memory_guard_utilization_ratio",
      "opengeni_turn_worker_memory_guard_target_ratio",
      "opengeni_turn_worker_memory_guard_process_rss_ratio",
      "opengeni:node_memory_psi_stall_ratio",
      "opengeni:node_io_psi_stall_ratio",
      "opengeni:node_swap_out_pages_per_second",
      "kubelet_runtime_operations_errors_total",
      "kube_node_status_condition",
      "opengeni:workload_node:present",
    ]) {
      expect(expressions, `missing worker fleet signal ${required}`).toContain(required);
    }
    expect(expressions).not.toMatch(/\bsum\s*(?:by\s*\([^)]*\))?\s*\(\s*opengeni_sandbox_leases\b/);
  });

  test("memory headroom and hosting-node alerts are part of the canonical safety catalog", async () => {
    const source = await Bun.file(rulePath).text();
    for (const required of [
      "opengeni:workload_node:present",
      "opengeni:node_exporter_instance:info",
      "opengeni:node_memory_psi_stall_ratio",
      "opengeni:node_io_psi_stall_ratio",
      "opengeni:node_swap_out_pages_per_second",
      "OpenGeniTurnWorkerMemoryHeadroomLow",
      "OpenGeniTurnWorkerMemoryConsumesReserve",
      "OpenGeniTurnWorkerMemoryGuardDraining",
      "OpenGeniTurnWorkerMemoryGuardFailure",
      "OpenGeniNodeMemoryPressureStalled",
      "OpenGeniNodeIoPressureStalled",
      "OpenGeniNodeSwapThrashing",
      "OpenGeniNodeContainerRuntimeErrors",
      "OpenGeniNodeNotReady",
    ]) {
      expect(source, `missing canonical rule ${required}`).toContain(required);
    }
    expect(source).toContain('pod=~"{{ $fullName }}-.*"');
    expect(source).toContain("node_pressure_memory_stalled_seconds_total");
    expect(source).toContain("node_pressure_io_stalled_seconds_total");
    expect(source).toContain("node_vmstat_pswpout");
    expect(source).toContain("kubelet_runtime_operations_errors_total");
    expect(source).toContain('kube_node_status_condition{condition="Ready", status="true"}');
  });

  test("recording rules bind every inventory family to its exact refresh domain", async () => {
    const source = await Bun.file(rulePath).text();
    const mappings = [
      ["opengeni:sandbox_leases:fresh_max", "opengeni_sandbox_leases", "leases"],
      [
        "opengeni:sandbox_checkpoint_artifacts:fresh_max",
        "opengeni_sandbox_checkpoint_artifacts",
        "checkpoint_artifacts",
      ],
      [
        "opengeni:sandbox_rotation_backlog:fresh_max",
        "opengeni_sandbox_rotation_backlog",
        "rotation_backlog",
      ],
      [
        "opengeni:retained_processes_active:fresh_max",
        "opengeni_retained_processes_active",
        "retained_processes",
      ],
      [
        "opengeni:retained_processes_terminal_owner_backlog:fresh_max",
        "opengeni_retained_processes_terminal_owner_backlog",
        "retained_processes",
      ],
      [
        "opengeni:sandbox_leases_expired_draining:fresh_max",
        "opengeni_sandbox_leases_expired_draining",
        "expired_drains",
      ],
    ] as const;
    for (const [record, family, domain] of mappings) {
      const start = source.indexOf(`- record: ${record}`);
      expect(start, `missing recording rule ${record}`).toBeGreaterThanOrEqual(0);
      const remainder = source.slice(start + 1);
      const next = remainder.search(/\n\s+- (?:record|alert): /);
      const block = source.slice(start, next < 0 ? undefined : start + 1 + next);
      expect(block).toContain(family);
      expect(block).toContain(`domain="${domain}"`);
      expect(block).toContain("and on (job, instance)");
    }
  });

  test("alerts match emitted drain buckets and fail closed on every absent domain", async () => {
    const source = await Bun.file(rulePath).text();
    expect(source).toContain('age_bucket=~"5m_1h|1h_1d|gte_1d"');
    expect(source).toContain("OpenGeniSandboxOperationFailureRatio");
    expect(source).toContain('opengeni_sandbox_operations_total{outcome=~"ok|failed"}[10m]');
    expect(source).toContain("must cover at least three sandbox reaper periods");
    expect(source).toContain("$inventoryFreshnessSeconds");
    expect(source).not.toMatch(/5m_to_15m|gt_15m/);
    for (const domain of [
      "leases",
      "checkpoint_artifacts",
      "rotation_backlog",
      "retained_processes",
      "expired_drains",
    ]) {
      expect(source).toContain(
        `absent(opengeni_sandbox_inventory_refresh_timestamp_seconds{domain="${domain}"})`,
      );
    }
  });

  test("custom chart rules append after the canonical safety catalog", async () => {
    const source = await Bun.file(rulePath).text();
    const canonical = source.indexOf("- alert: OpenGeniSandboxCreateFailureRatio");
    const custom = source.indexOf("with ((.Values.observability).prometheusRule).rules");
    expect(canonical).toBeGreaterThanOrEqual(0);
    expect(custom).toBeGreaterThan(canonical);
    expect(source).not.toContain("{{- else }}");
  });
});
