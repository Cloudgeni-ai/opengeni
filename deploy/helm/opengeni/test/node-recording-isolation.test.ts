import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  { namespace: "apps-shared", release: "beta", environment: "staging", node: "node-b" },
  { namespace: "apps-separate", release: "alpha", environment: "production", node: "node-a" },
];
const nodeRecords = [
  "opengeni:workload_node:present",
  "opengeni:node_exporter_instance:info",
  "opengeni:kubelet_instance:info",
  "opengeni:node_memory_psi_stall_ratio",
  "opengeni:node_io_psi_stall_ratio",
  "opengeni:node_swap_out_pages_per_second",
];
const nodeAlerts = [
  "OpenGeniNodeMemoryPressureStalled",
  "OpenGeniNodeIoPressureStalled",
  "OpenGeniNodeSwapThrashing",
  "OpenGeniNodeContainerRuntimeErrors",
  "OpenGeniNodeNotReady",
];

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
  if (!group) throw new Error("Missing canonical OpenGeni rule group");
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
          {
            series: series("kubelet_runtime_operations_errors_total", {
              job: "kubelet",
              instance: `${node}:10250`,
              operation_type: "create_container",
            }),
            values: node === "node-a" ? "0+1x5 5+0x7" : "0+0x13",
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
      const tests = [false, true].map((omitSeparateWorkload) => {
        const selected = deployments.filter((_, index) => !omitSeparateWorkload || index !== 2);
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
          ];
        });
        return {
          name: omitSeparateWorkload
            ? "no borrowed workload from another namespace"
            : "shared nodes and namespaces",
          interval: "1m",
          input_series: [...platformSeries, ...workloadSeries],
          promql_expr_test: deployments.flatMap((scope) =>
            [
              ["opengeni:node_memory_psi_stall_ratio", 0.2],
              ["opengeni:node_io_psi_stall_ratio", 0.3],
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
                eval_time === "12m"
                  ? []
                  : selected
                      .filter((scope) => scope.node === "node-a")
                      .map((scope) => ({
                        exp_labels: {
                          ...identity(scope),
                          node: scope.node,
                          severity: "critical",
                          ...(alertname === "OpenGeniNodeContainerRuntimeErrors"
                            ? { operation_type: "create_container" }
                            : {}),
                        },
                        exp_annotations: groups[deployments.indexOf(scope)]!.rules.find(
                          (rule) => rule.alert === alertname,
                        )!.annotations,
                      })),
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
