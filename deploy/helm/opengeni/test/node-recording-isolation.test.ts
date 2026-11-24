import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";

type Scope = { namespace: string; release: string; environment: string; node: string };
type Rule = {
  record?: string;
  alert?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};
type Group = { name: string; labels: Record<string, string>; rules: Rule[] };
type Manifest = { metadata: { name: string }; spec: { groups: Group[] } };

const deployments: Scope[] = [
  { namespace: "apps-shared", release: "alpha", environment: "development", node: "node-a" },
  {
    namespace: "apps-shared",
    release: "alpha-opengeni-extra",
    environment: "staging",
    node: "node-a",
  },
  { namespace: "apps-separate", release: "alpha", environment: "production", node: "node-a" },
  { namespace: "apps-shared", release: "gamma", environment: "development", node: "node-b" },
];
const nodeRecords = [
  "opengeni:workload_node:present",
  "opengeni:node_exporter_instance:info",
  "opengeni:kubelet_instance:info",
  "opengeni:node_memory_psi_stall_ratio",
  "opengeni:node_io_psi_stall_ratio",
  "opengeni:node_system_disk_busy_ratio",
  "opengeni:node_swap_out_pages_per_second",
];
const nodeAlerts = [
  "OpenGeniNodeMemoryPressureStalled",
  "OpenGeniNodeIoPressureStalled",
  "OpenGeniNodeSwapThrashing",
  "OpenGeniNodeContainerRuntimeErrors",
  "OpenGeniNodeNotReady",
];
const runtimeFaultOperations = [
  "create_container",
  "start_container",
  "stop_container",
  "pull_image",
  "run_podsandbox",
  "stop_podsandbox",
];
// The value each node alert renders into its notification annotations at the
// 5m evaluation below: stall ratios, swap-out pages/s and the runtime-error
// increase (NotReady renders no value).
const nodeAlertValues: Record<string, number> = {
  OpenGeniNodeMemoryPressureStalled: 0.2,
  OpenGeniNodeIoPressureStalled: 0.3,
  OpenGeniNodeSwapThrashing: 1,
  OpenGeniNodeContainerRuntimeErrors: 5,
  OpenGeniNodeNotReady: 0,
};

function render(scope: Scope): Manifest {
  const helm = Bun.which("helm");
  if (!helm) throw new Error("helm is required for chart render tests");
  const rendered = execFileSync(
    helm,
    [
      "template",
      scope.release,
      resolve(import.meta.dir, ".."),
      "--namespace",
      scope.namespace,
      "--api-versions",
      "monitoring.coreos.com/v1",
      "--set",
      "observability.prometheusRule.enabled=true",
      "--set-string",
      `config.OPENGENI_ENVIRONMENT=${scope.environment}`,
      "--show-only",
      "templates/prometheusrule.yaml",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return Bun.YAML.parse(rendered) as Manifest;
}

function identity(scope: Scope): Record<string, string> {
  return { namespace: scope.namespace, release: scope.release, environment: scope.environment };
}

function series(name: string, labels: Record<string, string>): string {
  return `${name}{${Object.entries(labels)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

function nodeGroup(manifest: Manifest): Group {
  const group = manifest.spec.groups.find((entry) => entry.name === "opengeni.rules");
  if (!group) throw new Error("Missing canonical Opengeni rule group");
  return {
    ...group,
    rules: group.rules.filter(
      (rule) => nodeRecords.includes(rule.record ?? "") || nodeAlerts.includes(rule.alert ?? ""),
    ),
  };
}

describe("node recording-rule deployment isolation", () => {
  for (const scope of deployments) {
    test(`every node record reference selects ${scope.namespace}/${scope.release}/${scope.environment}`, () => {
      const group = nodeGroup(render(scope));
      expect(group.labels).toEqual(identity(scope));
      expect(group.rules).toHaveLength(nodeRecords.length + nodeAlerts.length);
      expect(
        group.rules.find((rule) => rule.record === "opengeni:workload_node:present")!.expr,
      ).toContain(
        `kube_pod_labels{namespace=${JSON.stringify(scope.namespace)},label_app_kubernetes_io_instance=${JSON.stringify(scope.release)}}`,
      );
      let references = 0;
      for (const rule of group.rules) {
        for (const match of rule.expr.matchAll(/\b(opengeni:[a-z0-9_:]+)(\{[^}]*\})?/g)) {
          references += 1;
          for (const [label, value] of Object.entries(identity(scope))) {
            expect(
              match[2] ?? "",
              `${rule.record ?? rule.alert} uses unscoped ${match[1]}`,
            ).toContain(`${label}=${JSON.stringify(value)}`);
          }
        }
      }
      expect(references).toBeGreaterThan(0);
    });
  }
});

const promtool = process.env.OPENGENI_TEST_PROMTOOL ?? Bun.which("promtool");
test.skipIf(!promtool)(
  "real Prometheus evaluates co-located releases without duplicate joins or borrowed node alerts",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-node-rule-isolation-"));
    try {
      const manifests = deployments.map(render);
      const groups = manifests.map(nodeGroup);
      const ruleFiles = groups.map((_, index) => join(directory, `release-${index}.json`));
      await Promise.all(
        groups.map((group, index) =>
          writeFile(ruleFiles[index]!, JSON.stringify({ groups: [group] })),
        ),
      );
      const platformSeries = [
        ...["node-a", "node-b"].flatMap((node) => [
          {
            series: series("node_uname_info", { instance: `${node}:9100`, nodename: node }),
            values: "1+0x13",
          },
          {
            series: series("node_pressure_memory_stalled_seconds_total", {
              instance: `${node}:9100`,
            }),
            values: node === "node-a" ? "0+12x5 60+0x7" : "0+0x13",
          },
          {
            series: series("node_pressure_io_stalled_seconds_total", { instance: `${node}:9100` }),
            values: node === "node-a" ? "0+18x5 90+0x7" : "0+0x13",
          },
          // The root mount shows as /dev/root (no initramfs); the /boot
          // partition on the same disk identifies the OS disk instead.
          ...[
            ["/dev/root", "/"],
            ["/dev/sda16", "/boot"],
          ].map(([device, mountpoint]) => ({
            series: series("node_filesystem_size_bytes", {
              instance: `${node}:9100`,
              device: device!,
              mountpoint: mountpoint!,
            }),
            values: "1e10+0x13",
          })),
          {
            series: series("node_disk_io_time_seconds_total", {
              instance: `${node}:9100`,
              device: "sda",
            }),
            values: node === "node-a" ? "0+54x5 270+0x7" : "0+0x13",
          },
          {
            series: series("node_vmstat_pswpout", { instance: `${node}:9100` }),
            values: node === "node-a" ? "0+60x5 300+0x7" : "0+0x13",
          },
          {
            series: series("kubelet_node_name", {
              job: "kubelet",
              instance: `${node}:10250`,
              metrics_path: "/metrics",
              node,
            }),
            values: "1+0x13",
          },
          ...runtimeFaultOperations.map((operation_type) => ({
            series: series("kubelet_runtime_operations_errors_total", {
              job: "kubelet",
              instance: `${node}:10250`,
              operation_type,
            }),
            // Errors keep recurring on node-a, so the runtime alert holds and
            // fires after its 10m `for`. One start failure on node-b clears.
            values:
              node === "node-a"
                ? "0+1x13"
                : operation_type === "start_container"
                  ? "0 1+0x12"
                  : "0+0x13",
          })),
          {
            // One status lookup failure every four minutes on a Ready node
            // (15/hour) satisfies the old 5m window for the full 10m hold.
            series: series("kubelet_runtime_operations_errors_total", {
              job: "kubelet",
              instance: `${node}:10250`,
              operation_type: "container_status",
            }),
            values: node === "node-b" ? "0 1+0x3 2+0x3 3+0x3 4" : "0+0x13",
          },
          {
            // Exec probes failing against containers that are starting or
            // stopping across back-to-back rollouts recur for longer than the
            // `for`, but exec_sync alone is not runtime trouble and never pages.
            series: series("kubelet_runtime_operations_errors_total", {
              job: "kubelet",
              instance: `${node}:10250`,
              operation_type: "exec_sync",
            }),
            values: "0+3x13",
          },
          {
            series: series("kube_node_status_condition", {
              node,
              condition: "Ready",
              status: "true",
            }),
            values: node === "node-a" ? "0+0x5 1+0x7" : "1+0x13",
          },
        ]),
      ];
      const tests = [-1, 2, 0].map((omittedWorkload) => {
        const selected = deployments.filter((_, index) => index !== omittedWorkload);
        const workloadSeries = selected.flatMap((scope) => {
          const index = deployments.indexOf(scope);
          const pod = `${manifests[index]!.metadata.name}-worker-turns-synthetic`;
          return [
            {
              series: series("kube_pod_info", {
                namespace: scope.namespace,
                pod,
                node: scope.node,
              }),
              values: "1+0x13",
            },
            {
              series: series("kube_pod_status_phase", {
                namespace: scope.namespace,
                pod,
                phase: "Running",
              }),
              values: "1+0x13",
            },
            {
              series: series("kube_pod_labels", {
                namespace: scope.namespace,
                pod,
                label_app_kubernetes_io_instance: scope.release,
              }),
              values: "1+0x13",
            },
          ];
        });
        return {
          name:
            omittedWorkload === 2
              ? "no borrowed workload from another namespace"
              : omittedWorkload === 0
                ? "no borrowed workload from an overlapping release name"
                : "shared nodes and namespaces",
          interval: "1m",
          input_series: [...platformSeries, ...workloadSeries],
          promql_expr_test: deployments.flatMap((scope) =>
            [
              ["opengeni:node_memory_psi_stall_ratio", 0.2],
              ["opengeni:node_io_psi_stall_ratio", 0.3],
              ["opengeni:node_system_disk_busy_ratio", 0.9],
              ["opengeni:node_swap_out_pages_per_second", 1],
            ].flatMap(([name, value]) => [
              {
                expr: series(String(name), { ...identity(scope), node: "node-a" }),
                eval_time: "5m",
                exp_samples: [
                  { labels: series(String(name), { ...identity(scope), node: "node-a" }), value },
                ],
              },
              {
                expr: series(String(name), { ...identity(scope), node: "node-a" }),
                eval_time: "12m",
                exp_samples: [
                  {
                    labels: series(String(name), { ...identity(scope), node: "node-a" }),
                    value: 0,
                  },
                ],
              },
            ]),
          ),
          alert_rule_test: nodeAlerts.flatMap((alertname) =>
            ["5m", "12m"].map((eval_time) => ({
              alertname,
              eval_time,
              exp_alerts:
                // Pressure alerts fire at 5m and recover by 12m; recurring
                // runtime errors are still pending at 5m and fire by 12m.
                eval_time !== (alertname === "OpenGeniNodeContainerRuntimeErrors" ? "12m" : "5m")
                  ? []
                  : selected
                      .filter((scope) => scope.node === "node-a")
                      .flatMap((scope) => {
                        const runtimeAlert = alertname === "OpenGeniNodeContainerRuntimeErrors";
                        return (runtimeAlert ? runtimeFaultOperations : [undefined]).map(
                          (operation_type) => {
                            const nodeLabels = {
                              node: scope.node,
                              ...(operation_type ? { operation_type } : {}),
                            };
                            return {
                              exp_labels: {
                                ...identity(scope),
                                ...nodeLabels,
                                severity: runtimeAlert ? "warning" : "critical",
                              },
                              exp_annotations: expandAlertAnnotations(
                                groups[deployments.indexOf(scope)]!.rules.find(
                                  (rule) => rule.alert === alertname,
                                )!.annotations!,
                                { value: nodeAlertValues[alertname]!, labels: nodeLabels },
                              ),
                            };
                          },
                        );
                      }),
            })),
          ),
        };
      });
      const testFile = join(directory, "tests.json");
      await writeFile(
        testFile,
        JSON.stringify({ rule_files: ruleFiles, evaluation_interval: "1m", tests }),
      );
      const result = spawnSync(promtool!, ["test", "rules", testFile], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr.slice(0, 2_000)).toBe(0);
      expect(result.stdout).toContain("SUCCESS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

// Node I/O PSI also counts one pod waiting on its own attached volume. The
// critical node alert must page only when the disk behind the OS, kubelet or
// container runtime is busy too, and keep plain PSI where that disk cannot be
// identified.
const ioDiskCases: Array<{
  node: string;
  filesystems: Array<[device: string, mountpoint: string]>;
  disks: Record<string, string>;
  systemDiskBusy?: number;
  fires: boolean;
}> = [
  {
    // A search index rebuilding on its PVC: PVC disk ~62% busy, OS disk idle.
    node: "node-pvc-only",
    filesystems: [
      ["/dev/root", "/"],
      ["/dev/root", "/var/lib/kubelet"],
      ["/dev/sda15", "/boot/efi"],
      ["/dev/sda16", "/boot"],
      ["tmpfs", "/run"],
    ],
    disks: { sda: "0+3x13", sdb: "0+0x13", sdc: "0+37x13" },
    systemDiskBusy: 0.05,
    fires: false,
  },
  {
    node: "node-root-saturated",
    filesystems: [["/dev/nvme0n1p1", "/"]],
    disks: { nvme0n1: "0+57x13", nvme1n1: "0+0x13" },
    systemDiskBusy: 0.95,
    fires: true,
  },
  {
    node: "node-runtime-disk-saturated",
    filesystems: [
      ["/dev/sda1", "/"],
      ["/dev/nvme1n1", "/var/lib/containerd"],
    ],
    disks: { sda: "0+0x13", nvme1n1: "0+57x13" },
    systemDiskBusy: 0.95,
    fires: true,
  },
  {
    // LVM root by mapper name cannot be joined to a disk: keep plain PSI.
    node: "node-system-disk-unknown",
    filesystems: [["/dev/mapper/vg-root", "/"]],
    disks: { "dm-0": "0+0x13", sdc: "0+57x13" },
    fires: true,
  },
];

test.skipIf(!promtool)(
  "node I/O pressure pages on a saturated system disk, not on one pod's saturated volume",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-node-io-disk-"));
    try {
      const scope = deployments[0]!;
      const manifest = render(scope);
      const group = nodeGroup(manifest);
      const ruleFile = join(directory, "rules.json");
      await writeFile(ruleFile, JSON.stringify({ groups: [group] }));
      const input_series = ioDiskCases.flatMap(({ node, filesystems, disks }) => {
        const instance = `${node}:9100`;
        const pod = `${manifest.metadata.name}-worker-turns-${node}`;
        return [
          { series: series("node_uname_info", { instance, nodename: node }), values: "1+0x13" },
          {
            series: series("node_pressure_io_stalled_seconds_total", { instance }),
            values: "0+12x13",
          },
          ...filesystems.map(([device, mountpoint]) => ({
            series: series("node_filesystem_size_bytes", { instance, device, mountpoint }),
            values: "1e10+0x13",
          })),
          ...Object.entries(disks).map(([device, values]) => ({
            series: series("node_disk_io_time_seconds_total", { instance, device }),
            values,
          })),
          {
            series: series("kube_pod_info", { namespace: scope.namespace, pod, node }),
            values: "1+0x13",
          },
          {
            series: series("kube_pod_status_phase", {
              namespace: scope.namespace,
              pod,
              phase: "Running",
            }),
            values: "1+0x13",
          },
          {
            series: series("kube_pod_labels", {
              namespace: scope.namespace,
              pod,
              label_app_kubernetes_io_instance: scope.release,
            }),
            values: "1+0x13",
          },
        ];
      });
      const record = "opengeni:node_system_disk_busy_ratio";
      const annotations = group.rules.find(
        (rule) => rule.alert === "OpenGeniNodeIoPressureStalled",
      )!.annotations!;
      const testFile = join(directory, "tests.json");
      await writeFile(
        testFile,
        JSON.stringify({
          rule_files: [ruleFile],
          evaluation_interval: "1m",
          tests: [
            {
              interval: "1m",
              input_series,
              promql_expr_test: [
                {
                  expr: series(record, identity(scope)),
                  eval_time: "5m",
                  exp_samples: ioDiskCases
                    .filter(({ systemDiskBusy }) => systemDiskBusy !== undefined)
                    .map(({ node, systemDiskBusy }) => ({
                      labels: series(record, { ...identity(scope), node }),
                      value: systemDiskBusy,
                    })),
                },
              ],
              alert_rule_test: [
                {
                  alertname: "OpenGeniNodeIoPressureStalled",
                  eval_time: "5m",
                  exp_alerts: ioDiskCases
                    .filter(({ fires }) => fires)
                    .map(({ node }) => ({
                      exp_labels: { ...identity(scope), node, severity: "critical" },
                      exp_annotations: expandAlertAnnotations(annotations, {
                        value: 0.2,
                        labels: { node },
                      }),
                    })),
                },
              ],
            },
          ],
        }),
      );
      const result = spawnSync(promtool!, ["test", "rules", testFile], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`.slice(0, 4_000)).toBe(0);
      expect(result.stdout).toContain("SUCCESS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
