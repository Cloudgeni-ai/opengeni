import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, testTool } from "./queue-demand-tooling";

type Scope = { namespace: string; release: string; environment: string };
type Rule = { record?: string; alert?: string; expr: string; labels?: Record<string, string> };
type Group = { name: string; labels?: Record<string, string>; rules: Rule[] };
type Manifest = { metadata: { name: string }; spec: { groups: Group[] } };
type Input = { series: string; values: string };

// The chart already uses native group labels. Prometheus 2.55 cannot load that
// format; evaluate expression compatibility there with the equivalent labels
// materialized on individual rules. This is not legacy chart qualification.
function groupsForEngine(groups: Group[], legacy: boolean): Group[] {
  return legacy
    ? groups.map(({ labels, ...group }) => ({
        ...group,
        rules: group.rules.map((rule) => ({ ...rule, labels: { ...labels, ...rule.labels } })),
      }))
    : groups;
}

const tools = Promise.all([
  testTool("helm"),
  testTool("promtool", "3.5.0"),
  testTool("promtool", "2.55.1"),
]);
const deployments: Scope[] = [
  { namespace: "apps-shared", release: "alpha", environment: "development" },
  { namespace: "apps-shared", release: "alpha-opengeni-extra", environment: "development" },
  { namespace: "apps-separate", release: "alpha", environment: "development" },
];

async function render(scope: Scope, backend = "none", scaler = false): Promise<Manifest> {
  const [helm] = await tools;
  const result = await run([
    helm!,
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
    "--set-string",
    `config.OPENGENI_SANDBOX_BACKEND=${backend}`,
    ...(scaler
      ? [
          "--set",
          "worker.turns.autoscaling.enabled=true,worker.turns.autoscaling.queueDemand.enabled=true,observability.serviceMonitor.enabled=true",
        ]
      : []),
    "--show-only",
    scaler ? "templates/worker-scaler-prometheusrule.yaml" : "templates/prometheusrule.yaml",
  ]);
  expect(result.code, result.stderr).toBe(0);
  return Bun.YAML.parse(result.stdout) as Manifest;
}

function series(name: string, labels: Record<string, string>): string {
  return `${name}{${Object.entries(labels)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

// Scan the closed metric-name families under test, consuming quoted strings and
// entire selectors atomically. Unlike a greedy brace regex this sees bare
// metrics, colon recording references and absent(), without matching names in
// label values. Actual PromQL syntax is checked by both pinned engines below.
function selectors(expression: string): Array<{ name: string; labels: string }> {
  const result: Array<{ name: string; labels: string }> = [];
  const tokens =
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#[^\n]*|\b(opengeni[_:][a-zA-Z0-9_:]+|up)\b\s*(\{(?:[^{}"'`]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)*\})?/g;
  for (const match of expression.matchAll(tokens)) {
    if (match[1]) result.push({ name: match[1], labels: match[2] ?? "" });
  }
  return result;
}

function hasExactMatcher(selector: string, label: string, value: string): boolean {
  const matchers =
    /([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/g;
  return [...selector.matchAll(matchers)].some(
    (match) => match[1] === label && match[2] === "=" && match[3] === JSON.stringify(value),
  );
}

describe("rendered Prometheus rule release isolation", () => {
  test("the selector guard includes bare/colon/absent selectors, not quoted metric names", () => {
    expect(
      selectors(
        'opengeni_bare + opengeni:record{kind="opengeni_fake",note="escaped\\\"up"} or absent(opengeni_inventory{domain="leases"}) or up{job=~".*opengeni.*"}',
      ),
    ).toEqual([
      { name: "opengeni_bare", labels: "" },
      { name: "opengeni:record", labels: '{kind="opengeni_fake",note="escaped\\\"up"}' },
      { name: "opengeni_inventory", labels: '{domain="leases"}' },
      { name: "up", labels: '{job=~".*opengeni.*"}' },
    ]);
    expect(
      hasExactMatcher(
        '{note=`namespace="apps-shared"`,namespace=~"apps-shared"}',
        "namespace",
        "apps-shared",
      ),
    ).toBe(false);
    expect(
      hasExactMatcher('{namespace="apps-shared",release="alpha"}', "namespace", "apps-shared"),
    ).toBe(true);
  });

  for (const scope of deployments) {
    test(`worker-scaler Opengeni inputs also isolate ${scope.namespace}/${scope.release}`, async () => {
      const manifest = await render(scope, "none", true);
      let references = 0;
      for (const group of manifest.spec.groups)
        for (const rule of group.rules) {
          for (const selector of selectors(rule.expr)) {
            // The scaler also probes kube-state-metrics up targets via job/instance
            // joins to its already-fenced Pod inventory, not Opengeni scrape targets.
            if (selector.name === "up" && !selector.labels.includes("opengeni_workload_component"))
              continue;
            references += 1;
            const identity =
              selector.name === "up"
                ? { namespace: scope.namespace, release: scope.release }
                : scope;
            for (const [label, value] of Object.entries(identity)) {
              expect(
                hasExactMatcher(selector.labels, label, value),
                `${rule.record}: ${selector.name} lacks ${label}`,
              ).toBe(true);
            }
          }
        }
      expect(references).toBeGreaterThan(10);
    }, 30_000);
    for (const backend of ["none", "modal", "opensandbox"]) {
      test(`all canonical selectors isolate ${scope.namespace}/${scope.release}/${backend}`, async () => {
        const manifest = await render(scope, backend);
        const missing: string[] = [];
        let references = 0;
        for (const group of manifest.spec.groups) {
          expect(group.labels).toEqual(scope);
          for (const rule of group.rules) {
            for (const selector of selectors(rule.expr)) {
              references += 1;
              const identity =
                selector.name === "up"
                  ? { namespace: scope.namespace, release: scope.release }
                  : scope;
              for (const [label, value] of Object.entries(identity)) {
                if (!hasExactMatcher(selector.labels, label, value)) {
                  missing.push(`${rule.record ?? rule.alert}: ${selector.name} lacks ${label}`);
                }
              }
              // Exporter default labels are not labels on Prometheus' up metric.
              if (selector.name === "up") expect(selector.labels).not.toContain("environment=");
            }
          }
        }
        expect(references).toBeGreaterThan(100);
        expect(missing).toEqual([]);
      }, 30_000);
    }
  }
});

const alertNames = [
  "OpenGeniServiceDown",
  "OpenGeniTurnStuck",
  "OpenGeniSandboxCreateFailureRatio",
  "OpenGeniSandboxRotationOverdue",
  "OpenGeniSandboxInventoryProjectionStale",
  "OpenGeniWorkerMemoryNearLimit",
  "OpenGeniHpaAtMaxReplicas",
];
const recordNames = [
  "opengeni:sandbox_leases:fresh_max",
  "opengeni:sandbox_rotation_backlog:fresh_max",
];

function inputs(manifests: Manifest[], broken: number, missingDomain = false): Input[] {
  return deployments.flatMap((scope, index) => {
    const bad = index === broken;
    const scrape = {
      namespace: scope.namespace,
      release: scope.release,
      job: `${manifests[index]!.metadata.name}-worker`,
      instance: `worker-${index}:9464`,
    };
    const app = { ...scrape, environment: scope.environment, component: "worker-control" };
    const fullname = manifests[index]!.metadata.name;
    const pod = `${fullname}-worker-turns-fixture`;
    const samples: Input[] = [
      { series: series("up", scrape), values: bad && !missingDomain ? "0+0x20 1+0x20" : "1+0x40" },
      {
        series: series("opengeni_turn_oldest_no_progress_age_seconds", app),
        values: bad && !missingDomain ? "1000+0x20 0+0x20" : "0+0x40",
      },
      {
        series: series("opengeni_sandbox_creates_total", { ...app, outcome: "failed" }),
        values: bad && !missingDomain ? "0+10x20 200+0x20" : "0+0x40",
      },
      {
        series: series("opengeni_sandbox_creates_total", { ...app, outcome: "completed" }),
        values: bad && !missingDomain ? "0+0x20 0+10x20" : "0+10x40",
      },
      {
        series: series("opengeni_sandbox_leases", { ...app, liveness: "alive" }),
        values: "9+0x40",
      },
      {
        series: series("opengeni_sandbox_rotation_backlog", { ...app, kind: "overdue" }),
        values: bad && !missingDomain ? "7+0x20 0+0x20" : "0+0x40",
      },
      {
        series: series("container_memory_working_set_bytes", {
          namespace: scope.namespace,
          pod,
          container: "worker",
        }),
        values: bad && !missingDomain ? "99+0x20 50+0x20" : "50+0x40",
      },
      {
        series: series("kube_pod_labels", {
          namespace: scope.namespace,
          pod,
          label_app_kubernetes_io_instance: scope.release,
        }),
        values: "1+0x40",
      },
      {
        series: series("kube_pod_container_resource_limits", {
          namespace: scope.namespace,
          pod,
          container: "worker",
          resource: "memory",
        }),
        values: "100+0x40",
      },
      {
        series: series("kube_horizontalpodautoscaler_status_current_replicas", {
          namespace: scope.namespace,
          horizontalpodautoscaler: `${fullname}-worker-turns`,
        }),
        values: bad && !missingDomain ? "2+0x20 1+0x20" : "1+0x40",
      },
      {
        series: series("kube_horizontalpodautoscaler_spec_max_replicas", {
          namespace: scope.namespace,
          horizontalpodautoscaler: `${fullname}-worker-turns`,
        }),
        values: "2+0x40",
      },
    ];
    for (const domain of [
      "leases",
      "checkpoint_artifacts",
      "rotation_backlog",
      "retained_processes",
      "expired_drains",
    ]) {
      samples.push({
        series: series("opengeni_sandbox_inventory_refresh_timestamp_seconds", { ...app, domain }),
        // A fresh foreign projection must neither mask local staleness nor fill
        // an absent local domain. The other domains remain independently fresh.
        values:
          bad && domain === "leases"
            ? `${missingDomain ? "_x20" : "-1000+0x20"} 1260+60x20`
            : "0+60x40",
      });
    }
    // Old environment-labelled series may survive a config rollout on the
    // same scrape target. They are not evidence about the configured release.
    const foreign = { ...app, environment: "historical" };
    samples.push(
      {
        series: series("opengeni_turn_oldest_no_progress_age_seconds", foreign),
        values: "1000+0x40",
      },
      {
        series: series("opengeni_sandbox_creates_total", { ...foreign, outcome: "failed" }),
        values: "0+50x40",
      },
      {
        series: series("opengeni_sandbox_rotation_backlog", { ...foreign, kind: "overdue" }),
        values: "99+0x40",
      },
      {
        series: series("opengeni_sandbox_inventory_refresh_timestamp_seconds", {
          ...foreign,
          domain: "leases",
        }),
        values: "-1000+0x40",
      },
    );
    return samples;
  });
}

test("real Prometheus never borrows another release's failure or fresh inventory", async () => {
  const [, ...engines] = await tools;
  const manifests = await Promise.all(deployments.map((scope) => render(scope)));
  const catalogs = await Promise.all(
    deployments.flatMap((scope) =>
      ["none", "modal", "opensandbox"].map((backend) => render(scope, backend)),
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), "opengeni-release-rule-isolation-"));
  try {
    const ruleFiles = manifests.map((_, index) => join(directory, `release-${index}.json`));
    const tests = [-1, 0, 1, 2].flatMap((broken) =>
      [false, true].map((missingDomain) => ({
        name: `${broken < 0 ? "healthy" : `failure in release ${broken}`} / ${missingDomain ? "missing domain" : "stale domain"}`,
        interval: "1m",
        input_series: inputs(manifests, broken, missingDomain),
        promql_expr_test: deployments.flatMap((scope, index) => [
          ...alertNames.flatMap((alertname) =>
            ["15m", "35m"].map((eval_time) => ({
              expr: `count(${series("ALERTS", { ...scope, alertname, alertstate: "firing" })}) or vector(0)`,
              eval_time,
              exp_samples: [
                {
                  labels: "{}",
                  value:
                    eval_time === "15m" &&
                    index === broken &&
                    (!missingDomain || alertname === "OpenGeniSandboxInventoryProjectionStale")
                      ? 1
                      : 0,
                },
              ],
            })),
          ),
          {
            expr: series("opengeni:sandbox_rotation_backlog:fresh_max", {
              ...scope,
              kind: "overdue",
            }),
            eval_time: "15m",
            exp_samples: [
              {
                labels: series("opengeni:sandbox_rotation_backlog:fresh_max", {
                  ...scope,
                  kind: "overdue",
                }),
                value: index === broken && !missingDomain ? 7 : 0,
              },
            ],
          },
          {
            expr: `count(${series("opengeni:sandbox_leases:fresh_max", scope)}) or vector(0)`,
            eval_time: "15m",
            exp_samples: [{ labels: "{}", value: index === broken ? 0 : 1 }],
          },
        ]),
      })),
    );
    const fixture = join(directory, "tests.json");
    await writeFile(
      fixture,
      JSON.stringify({ rule_files: ruleFiles, evaluation_interval: "1m", tests }),
    );
    for (const [engineIndex, engine] of engines.entries()) {
      for (const [index, manifest] of manifests.entries()) {
        const group = manifest.spec.groups[0]!;
        await writeFile(
          ruleFiles[index]!,
          JSON.stringify({
            groups: groupsForEngine(
              [
                {
                  ...group,
                  rules: group.rules.filter(
                    (rule) =>
                      alertNames.includes(rule.alert ?? "") ||
                      recordNames.includes(rule.record ?? ""),
                  ),
                },
              ],
              engineIndex === 1,
            ),
          }),
        );
      }
      // Validate the complete rendered catalog as well as the evaluation subset.
      for (const [index, manifest] of catalogs.entries()) {
        const catalog = join(directory, `catalog-${index}.json`);
        await writeFile(
          catalog,
          JSON.stringify({ groups: groupsForEngine(manifest.spec.groups, engineIndex === 1) }),
        );
        const checked = await run([engine!, "check", "rules", catalog]);
        expect(checked.code, checked.stdout + checked.stderr).toBe(0);
      }
      const result = await run([engine!, "test", "rules", fixture]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
