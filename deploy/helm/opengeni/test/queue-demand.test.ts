import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, testTool } from "./queue-demand-tooling";

const chart = resolve(import.meta.dir, "..");
const tools = Promise.all([testTool("helm"), testTool("promtool")]);
const enabled = {
  fullnameOverride: "fixture",
  config: { OPENGENI_ENVIRONMENT: "fixture" },
  worker: { turns: { autoscaling: { enabled: true, queueDemand: { enabled: true } } } },
  observability: { serviceMonitor: { enabled: true } },
};
type Manifest = { kind: string; metadata: { name: string }; spec: any };
type Input = { series: string; values: string };
const identity = {
  namespace: "fixture",
  release: "fixture",
  environment: "fixture",
  temporal_namespace: "default",
  task_queue: "opengeni-runs-ts-turns",
};
const labelSet = Object.entries(identity)
  .map(([key, value]) => `${key}="${value}"`)
  .join(",");

// Bind the SOURCE fence in the shipped example to this actual rendered fixture.
// Request matchers alone are intentionally insufficient to set that identity.
function bindAdapterSource(expression: string) {
  return expression
    .replaceAll('namespace="opengeni"', 'namespace="fixture"')
    .replaceAll('release="opengeni"', 'release="fixture"')
    .replaceAll('environment="production"', 'environment="fixture"');
}

async function render(values: object = {}, capabilities = true, profiles: string[] = []) {
  const [helm] = await tools;
  const dir = await mkdtemp(join(tmpdir(), "opengeni-queue-render-"));
  try {
    const path = join(dir, "values.json");
    await Bun.write(path, JSON.stringify(values));
    const result = await run([
      helm,
      "template",
      "fixture",
      chart,
      "--namespace",
      "fixture",
      ...profiles.flatMap((profile) => ["-f", join(chart, profile)]),
      "-f",
      path,
      ...(capabilities ? ["--api-versions", "monitoring.coreos.com/v1"] : []),
    ]);
    const manifests =
      result.code === 0
        ? result.stdout
            .split(/^---\s*$/mu)
            .filter((doc) => doc.trim())
            .map((doc) => Bun.YAML.parse(doc) as Manifest)
            .filter((doc) => doc?.kind)
        : [];
    return { ...result, manifests };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function find(manifests: Manifest[], kind: string, name: string) {
  const result = manifests.find((m) => m.kind === kind && m.metadata.name === name);
  if (!result) throw new Error(`Missing ${kind} ${name}`);
  return result;
}

describe("queue demand schema v1 actual Helm rendering", () => {
  test("every shipped profile renders the opt-in with source-bound Object selectors", async () => {
    for (const profile of (await readdir(chart)).filter(
      (name) => name.startsWith("values.") && name.endsWith(".yaml"),
    )) {
      const result = await render(enabled, true, [profile]);
      expect(result.code, `${profile}: ${result.stderr}`).toBe(0);
      const group = find(result.manifests, "PrometheusRule", "fixture-worker-scaler").spec
        .groups[0];
      const hpa = find(result.manifests, "HorizontalPodAutoscaler", "fixture-worker-turns").spec;
      for (const metric of hpa.metrics.filter((m: any) => m.type === "Object"))
        expect(metric.object.metric.selector.matchLabels).toEqual(group.labels);
      expect(hpa.behavior.scaleDown.selectPolicy).toBe("Disabled");
    }
  }, 180_000);
  test("defaults off, preserves historical policies and only adds real UID identity", async () => {
    const defaults = await render();
    expect(defaults.code).toBe(0);
    expect(
      defaults.manifests.some((m) => m.metadata.name === "fixture-opengeni-worker-scaler"),
    ).toBe(false);
    const legacyPolicy = {
      scaleUp: {
        stabilizationWindowSeconds: 60,
        policies: [{ type: "Pods", value: 2, periodSeconds: 60 }],
      },
      scaleDown: {
        stabilizationWindowSeconds: 600,
        policies: [{ type: "Pods", value: 1, periodSeconds: 300 }],
      },
    };
    const legacy = await render({
      worker: { turns: { autoscaling: { enabled: true, behavior: legacyPolicy } } },
    });
    expect(legacy.code).toBe(0);
    const hpa = find(legacy.manifests, "HorizontalPodAutoscaler", "fixture-opengeni-worker-turns");
    expect(hpa.spec.behavior).toEqual(legacyPolicy);
    expect(hpa.spec.metrics).toHaveLength(1);
    const dep = find(defaults.manifests, "Deployment", "fixture-opengeni-worker-turns");
    expect(
      dep.spec.template.spec.containers[0].env.find((e: any) => e.name === "OPENGENI_POD_UID"),
    ).toEqual({ name: "OPENGENI_POD_UID", valueFrom: { fieldRef: { fieldPath: "metadata.uid" } } });
  }, 180_000);

  test("renders one HPA, six exact metrics, full identity isolation and the frozen recovery gate", async () => {
    const result = await render(enabled);
    expect(result.code, result.stderr).toBe(0);
    const hpas = result.manifests.filter((m) => m.kind === "HorizontalPodAutoscaler");
    expect(hpas).toHaveLength(1);
    const hpa = hpas[0]!.spec;
    expect(hpa.minReplicas).toBe(4);
    expect(hpa.maxReplicas).toBe(20);
    expect(hpa.metrics.slice(0, 3)).toEqual([
      {
        type: "Resource",
        resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } },
      },
      {
        type: "Resource",
        resource: { name: "memory", target: { type: "Utilization", averageUtilization: 80 } },
      },
      {
        type: "Pods",
        pods: {
          metric: { name: "opengeni_turns_inflight" },
          target: { type: "AverageValue", averageValue: "8" },
        },
      },
    ]);
    expect(hpa.metrics.slice(3)).toEqual(
      [
        "opengeni_turn_worker_demand",
        "opengeni_turn_worker_queued",
        "opengeni_turn_worker_busy",
      ].map((name) => ({
        type: "Object",
        object: {
          describedObject: { apiVersion: "v1", kind: "Namespace", name: "fixture" },
          metric: { name, selector: { matchLabels: identity } },
          target: { type: "AverageValue", averageValue: name.endsWith("busy") ? "1" : "8" },
        },
      })),
    );
    expect(hpa.behavior).toEqual({
      scaleUp: {
        stabilizationWindowSeconds: 0,
        selectPolicy: "Max",
        policies: [{ type: "Pods", value: 4, periodSeconds: 30 }],
      },
      scaleDown: {
        stabilizationWindowSeconds: 600,
        selectPolicy: "Disabled",
        policies: [{ type: "Pods", value: 1, periodSeconds: 300 }],
      },
    });
    const rules = find(result.manifests, "PrometheusRule", "fixture-worker-scaler");
    expect(rules.spec.groups[0].interval).toBe("15s");
    expect(rules.spec.groups[0].labels).toEqual({
      namespace: "fixture",
      release: "fixture",
      environment: "fixture",
      temporal_namespace: "default",
      task_queue: "opengeni-runs-ts-turns",
    });
    const monitor = find(result.manifests, "ServiceMonitor", "fixture-worker-turns");
    expect(monitor.spec.endpoints[0].relabelings).toContainEqual({
      sourceLabels: ["__meta_kubernetes_pod_uid"],
      targetLabel: "pod_uid",
    });
    const dep = find(result.manifests, "Deployment", "fixture-worker-turns");
    expect(dep.spec.replicas).toBeUndefined();
    expect(dep.spec.template.spec.terminationGracePeriodSeconds).toBe(120);
    const baseline = await render({
      ...enabled,
      worker: { turns: { autoscaling: { enabled: true } } },
    });
    const baselineDep = find(baseline.manifests, "Deployment", "fixture-worker-turns");
    expect(dep.spec.template.spec.containers[0].resources).toEqual(
      baselineDep.spec.template.spec.containers[0].resources,
    );
    const privateBounds = await render({
      ...enabled,
      worker: {
        turns: {
          autoscaling: {
            enabled: true,
            minReplicas: 14,
            maxReplicas: 28,
            queueDemand: { enabled: true },
            behavior: { scaleDown: { selectPolicy: "Max" } },
          },
        },
      },
    });
    const privateHpa = find(
      privateBounds.manifests,
      "HorizontalPodAutoscaler",
      "fixture-worker-turns",
    ).spec;
    expect([privateHpa.minReplicas, privateHpa.maxReplicas]).toEqual([14, 28]);
    expect(privateHpa.behavior.scaleDown.selectPolicy).toBe("Disabled");
    const legacyAlerts = await render({
      ...enabled,
      worker: { turns: { autoscaling: { enabled: true } } },
      observability: { serviceMonitor: { enabled: true }, prometheusRule: { enabled: true } },
    });
    const combinedAlerts = await render({
      ...enabled,
      observability: { serviceMonitor: { enabled: true }, prometheusRule: { enabled: true } },
    });
    expect(find(combinedAlerts.manifests, "PrometheusRule", "fixture").spec).toEqual(
      find(legacyAlerts.manifests, "PrometheusRule", "fixture").spec,
    );
  }, 180_000);

  test("schema and prerequisite failures reject unsupported or unobservable opt-ins", async () => {
    for (const queueDemand of [
      { schemaVersion: 2 },
      { schemaVersion: "1" },
      { targetAverageValue: "0" },
      { targetAverageValue: 8 },
      { enabled: "true" },
      { arbitrary: true },
    ]) {
      const result = await render({ worker: { turns: { autoscaling: { queueDemand } } } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("schema");
    }
    const noCaps = await render(enabled, false);
    expect(noCaps.code).not.toBe(0);
    expect(noCaps.stderr).toContain("Prometheus Operator");
    for (const values of [
      {
        worker: {
          enabled: false,
          turns: { autoscaling: { enabled: true, queueDemand: { enabled: true } } },
        },
      },
      { worker: { turns: { autoscaling: { queueDemand: { enabled: true } } } } },
      { ...enabled, observability: { serviceMonitor: { enabled: false } } },
      {
        ...enabled,
        observability: { serviceMonitor: { enabled: true }, metrics: { enabled: false } },
      },
      {
        ...enabled,
        worker: {
          turns: {
            autoscaling: {
              enabled: true,
              queueDemand: { enabled: true },
              slotSaturationMetric: { enabled: true },
            },
          },
        },
      },
      {
        ...enabled,
        worker: {
          turns: {
            autoscaling: {
              enabled: true,
              queueDemand: { enabled: true },
              customMetrics: [{ type: "External" }],
            },
          },
        },
      },
      { worker: { extraEnv: [{ name: "OPENGENI_POD_UID", value: "fake" }] } },
      { worker: { turns: { autoscaling: { enabled: true, minReplicas: 5, maxReplicas: 4 } } } },
      { worker: { turns: { autoscaling: { enabled: true, minReplicas: 0 } } } },
    ])
      expect((await render(values)).code).not.toBe(0);
    const legacy = await render({
      ...enabled,
      worker: {
        turns: {
          autoscaling: {
            enabled: true,
            queueDemand: { enabled: true },
            customMetrics: [
              {
                type: "Pods",
                pods: {
                  metric: { name: "opengeni_turns_inflight" },
                  target: { type: "AverageValue", averageValue: "8" },
                },
              },
            ],
          },
        },
      },
    });
    expect(legacy.code, legacy.stderr).toBe(0);
    expect(
      find(legacy.manifests, "HorizontalPodAutoscaler", "fixture-worker-turns").spec.metrics,
    ).toHaveLength(6);
  }, 180_000);
});

function inputs(
  options: {
    queue?: number;
    activities?: number[];
    mutate?: (input: Input) => Input | null;
    duplicates?: boolean;
  } = {},
): Input[] {
  const result: Input[] = [
    { series: 'up{job="ksm",instance="ksm"}', values: "1+0x30" },
    {
      series:
        'kube_deployment_status_replicas{namespace="fixture",deployment="fixture-worker-turns",job="ksm",instance="ksm"}',
      values: "2+0x30",
    },
  ];
  for (const [index, suffix] of ["a", "b"].entries()) {
    const pod = `fixture-worker-turns-${suffix}`;
    const uid = `uid-${suffix}`;
    const ksm = `namespace="fixture",pod="${pod}",uid="${uid}",job="ksm",instance="ksm"`;
    result.push(
      { series: `kube_pod_info{${ksm}}`, values: "1+0x30" },
      {
        series: `kube_pod_labels{${ksm},label_app_kubernetes_io_instance="fixture",label_app_kubernetes_io_component="worker-turns"}`,
        values: "1+0x30",
      },
      { series: `kube_pod_status_phase{${ksm},phase="Running"}`, values: "1+0x30" },
    );
    for (const job of options.duplicates ? ["worker", "duplicate"] : ["worker"]) {
      const target = `namespace="fixture",release="fixture",pod="${pod}",pod_uid="${uid}",job="${job}",instance="${suffix}"`;
      const app = `${target},environment="fixture",component="worker-turn",temporal_namespace="default",task_queue="opengeni-runs-ts-turns"`;
      const activity = `${app},worker_pod_uid="${uid}"`;
      result.push(
        { series: `up{${target},opengeni_workload_component="worker-turns"}`, values: "1+0x30" },
        { series: `opengeni_turn_capacity_monitor_fresh{${app}}`, values: "1+0x30" },
        {
          series: `opengeni_turn_capacity_monitor_last_success_timestamp_seconds{${app}}`,
          values: "0+15x30",
        },
        {
          series: `opengeni_turn_eligible_backlog{${app}}`,
          values: `${options.queue ?? (index === 0 ? 8 : 11)}+0x30`,
        },
        {
          series: `opengeni_turn_worker_activities_inflight{${activity}}`,
          values: `${options.activities?.[index] ?? [3, 0][index]}+0x30`,
        },
        {
          series: `opengeni_turn_worker_activities_last_observed_timestamp_seconds{${activity}}`,
          values: "0+15x30",
        },
        {
          series: `opengeni_turn_worker_activities_last_read_success{${activity}}`,
          values: "1+0x30",
        },
      );
    }
  }
  return result
    .map((input) => (options.mutate ? options.mutate(input) : input))
    .filter((input): input is Input => input !== null);
}

test("actual rendered promtool fixtures: complete identity, MAX, failure, rollout, drain, true zero and stalls", async () => {
  const [, promtool] = await tools;
  const rendered = await render(enabled);
  expect(rendered.code, rendered.stderr).toBe(0);
  const groups = find(rendered.manifests, "PrometheusRule", "fixture-worker-scaler").spec.groups;
  const scope =
    'environment="fixture",namespace="fixture",release="fixture",task_queue="opengeni-runs-ts-turns",temporal_namespace="default"';
  const scenarios: any[] = [];
  function scenario(
    name: string,
    input: Input[],
    q?: number,
    r?: number,
    busy?: number,
    evalTime = "2m",
    deadlines = { queue: 165, busy: 180, demand: 165 },
  ) {
    const values: Record<string, number | undefined> = {
      opengeni_turn_worker_queued: q,
      "opengeni:worker_scaler:executing": r,
      opengeni_turn_worker_busy: busy,
      opengeni_turn_worker_demand: q !== undefined && r !== undefined ? q + r : undefined,
    };
    if (q !== undefined)
      values.opengeni_turn_worker_queued_valid_until_timestamp_seconds = deadlines.queue;
    if (busy !== undefined)
      values.opengeni_turn_worker_busy_valid_until_timestamp_seconds = deadlines.busy;
    if (q !== undefined && r !== undefined)
      values.opengeni_turn_worker_demand_valid_until_timestamp_seconds = deadlines.demand;
    scenarios.push({
      name,
      interval: "15s",
      input_series: input,
      promql_expr_test: Object.entries(values).map(([metric, value]) => ({
        expr: `${metric}{namespace="fixture"}`,
        eval_time: evalTime,
        exp_samples:
          value === undefined ? [] : [{ labels: `{__name__="${metric}",${scope}}`, value }],
      })),
    });
  }
  scenario("SDK executing mixed activities, queue MAX not sum", inputs(), 11, 3, 1);
  scenario(
    "stale worker up cannot be refreshed by a comparison expression",
    inputs({
      mutate: (i) =>
        i.series.startsWith("up{") && i.series.includes('job="worker"')
          ? { ...i, values: "1 _ _ _ _ _ _ _ _ _" }
          : i,
    }),
  );
  scenario(
    "stale KSM up cannot be refreshed by a comparison expression",
    inputs({
      mutate: (i) =>
        i.series.startsWith("up{") && i.series.includes('job="ksm"')
          ? { ...i, values: "1 _ _ _ _ _ _ _ _ _" }
          : i,
    }),
    11,
  );
  const oldInventory = inputs({
    mutate: (i) =>
      i.series.startsWith("kube_")
        ? { ...i, values: i.values.split("+")[0]! + " _ _ _ _ _ _ _ _ _" }
        : i,
  });
  scenario(
    "original KSM sample expiry is retained through current recording evaluations",
    oldInventory,
    11,
    3,
    1,
    "45s",
    { queue: 90, busy: 60, demand: 60 },
  );
  scenario(
    "original KSM sample deadline does not slide at sixty seconds",
    oldInventory,
    11,
    undefined,
    undefined,
    "60s",
    { queue: 105, busy: 60, demand: 60 },
  );
  const ksmDuplicate = inputs()
    .filter((i) => i.series.startsWith("kube_") || i.series.startsWith('up{job="ksm"'))
    .map((i) => ({
      ...i,
      series: i.series.replaceAll('instance="ksm"', 'instance="ksm-duplicate"'),
    }));
  scenario(
    "duplicate KSM scrapes preserve complete physical identity",
    [...inputs(), ...ksmDuplicate],
    11,
    3,
    1,
  );
  const duplicateSameInstance = inputs()
    .filter(
      (i) =>
        i.series.startsWith("opengeni_") ||
        (i.series.startsWith("up{") && i.series.includes('job="worker"')),
    )
    .map((i) => ({ ...i, series: i.series.replace(/\}$/u, ',scrape="duplicate"}') }));
  scenario(
    "duplicate worker scrape with same job and instance deduplicates without join error",
    [...inputs(), ...duplicateSameInstance],
    11,
    3,
    1,
  );
  const ksmSameInstance = inputs()
    .filter((i) => i.series.startsWith("kube_") || i.series.startsWith('up{job="ksm"'))
    .map((i) => ({ ...i, series: i.series.replace(/\}$/u, ',scrape="ksm-duplicate"}') }));
  scenario(
    "duplicate KSM scrape with same job and instance preserves unique join identity",
    [...inputs(), ...ksmSameInstance],
    11,
    3,
    1,
  );
  scenario(
    "stale duplicate KSM snapshot cannot poison healthy identity deadlines",
    [
      ...inputs(),
      ...ksmDuplicate.map((i) =>
        i.series.startsWith("kube_")
          ? { ...i, values: i.values.split("+")[0]! + " _ _ _ _ _ _ _ _ _" }
          : i,
      ),
    ],
    11,
    3,
    1,
  );
  scenario(
    "duplicate scrapes never inflate fleet occupancy or queue",
    inputs({ duplicates: true }),
    11,
    3,
    1,
  );
  scenario(
    "actual idle observations produce all zeros",
    inputs({ queue: 0, activities: [0, 0] }),
    0,
    0,
    0,
  );
  scenario(
    "missing SDK agent-only metric does not inflate mixed executing activity count",
    [
      ...inputs(),
      {
        series: 'opengeni_turns_inflight{namespace="fixture",pod="fixture-worker-turns-a"}',
        values: "200+0x30",
      },
    ],
    11,
    3,
    1,
  );
  scenario(
    "one failed queue reader does not suppress healthy Q",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_capacity_monitor_fresh") &&
        i.series.includes('instance="b"')
          ? { ...i, values: "0+0x30" }
          : i,
    }),
    8,
    3,
    1,
  );
  scenario(
    "all queue readers failed never becomes zero",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_capacity_monitor_fresh")
          ? { ...i, values: "0+0x30" }
          : i,
    }),
    undefined,
    3,
    1,
  );
  scenario(
    "one scrape fails, independent queue keeps scale-up lower bound",
    inputs({
      mutate: (i) =>
        i.series.startsWith("up{") && i.series.includes('instance="b"')
          ? { ...i, values: "0+0x30" }
          : i,
    }),
    8,
  );
  for (const [name, metric] of [
    ["queue", "opengeni_turn_capacity_monitor_last_success"],
    ["occupancy", "opengeni_turn_worker_activities_last_observed"],
  ]) {
    for (const [age, values] of [
      ["stale", "1+0x30"],
      ["future", "10+15x30"],
      ["never observed", "0+0x30"],
    ]) {
      scenario(
        `${name} ${age}`,
        inputs({ mutate: (i) => (i.series.startsWith(metric!) ? { ...i, values: values! } : i) }),
        name === "queue" ? undefined : 11,
        name === "queue" ? 3 : undefined,
        name === "queue" ? 1 : undefined,
      );
    }
  }
  for (const metric of [
    "opengeni_turn_eligible_backlog",
    "opengeni_turn_worker_activities_inflight",
  ]) {
    for (const value of ["-1", "NaN", "+Inf", "-Inf"]) {
      scenario(
        `${metric} rejects ${value}`,
        inputs({
          mutate: (i) =>
            i.series.startsWith(metric)
              ? {
                  ...i,
                  values: `${value} ${value} ${value} ${value} ${value} ${value} ${value} ${value} ${value}`,
                }
              : i,
        }),
        metric.includes("backlog") ? undefined : 11,
        metric.includes("backlog") ? 3 : undefined,
        metric.includes("backlog") ? 1 : undefined,
      );
    }
  }
  for (const metric of [
    "kube_pod_info",
    "kube_pod_labels",
    "kube_pod_status_phase",
    "opengeni_turn_worker_activities_inflight",
    "opengeni_turn_worker_activities_last_read_success",
    "opengeni_turn_worker_activities_last_observed_timestamp_seconds",
  ]) {
    scenario(
      `partial ${metric} coverage, not counts-only`,
      inputs({
        mutate: (i) =>
          i.series.startsWith(metric) && i.series.includes('pod="fixture-worker-turns-b"')
            ? null
            : i,
      }),
      11,
    );
  }
  scenario(
    "unknown KSM inventory remains absent",
    inputs({
      mutate: (i) => (i.series.startsWith("kube_") || i.series.includes('job="ksm"') ? null : i),
    }),
    11,
  );
  scenario(
    "missing fresh controller inventory remains absent",
    inputs({ mutate: (i) => (i.series.startsWith("kube_deployment_status_replicas") ? null : i) }),
    11,
  );
  scenario(
    "same pod missing from both discovery and KSM lists cannot become complete",
    inputs({ mutate: (i) => (i.series.includes('pod="fixture-worker-turns-b"') ? null : i) }),
    8,
  );
  scenario(
    "controller lag conservatively blocks complete recommendation",
    inputs({
      mutate: (i) =>
        i.series.startsWith("kube_deployment_status_replicas") ? { ...i, values: "3+0x30" } : i,
    }),
    11,
  );
  scenario(
    "failed KSM scrape remains absent despite cached raw inventory",
    inputs({
      mutate: (i) =>
        i.series.startsWith("up{") && i.series.includes('job="ksm"')
          ? { ...i, values: "0+0x30" }
          : i,
    }),
    11,
  );
  scenario(
    "wrong producer UID, equal counts do not prove identity",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_worker_activities_") &&
        i.series.includes('pod="fixture-worker-turns-b"')
          ? { ...i, series: i.series.replace('worker_pod_uid="uid-b"', 'worker_pod_uid="wrong"') }
          : i,
    }),
    11,
  );
  scenario(
    "empty producer UID remains unidentifiable",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_worker_activities_")
          ? { ...i, series: i.series.replace(/worker_pod_uid="[^"]+"/, 'worker_pod_uid=""') }
          : i,
    }),
    11,
  );
  scenario(
    "missing idle zero is not an observed zero",
    inputs({
      queue: 0,
      activities: [0, 0],
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_worker_activities_inflight") &&
        i.series.includes('instance="b"')
          ? null
          : i,
    }),
    0,
  );
  scenario(
    "producer observation failure remains absent",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_worker_activities_last_read_success") &&
        i.series.includes('instance="b"')
          ? { ...i, values: "0+0x30" }
          : i,
    }),
    11,
  );
  scenario(
    "discovery UID and producer UID must agree",
    inputs({
      mutate: (i) =>
        i.series.includes('pod="fixture-worker-turns-b"') && !i.series.startsWith("kube_")
          ? { ...i, series: i.series.replace('pod_uid="uid-b"', 'pod_uid="replacement"') }
          : i,
    }),
    11,
  );
  scenario(
    "wrong actual task queue is not selected",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_")
          ? { ...i, series: i.series.replace("opengeni-runs-ts-turns", "display-queue") }
          : i,
    }),
  );
  scenario(
    "wrong Temporal namespace is not selected",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_")
          ? {
              ...i,
              series: i.series.replace(
                'temporal_namespace="default"',
                'temporal_namespace="other"',
              ),
            }
          : i,
    }),
  );
  scenario(
    "wrong release is not selected",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_") ||
        (i.series.startsWith("up{") && i.series.includes('job="worker"'))
          ? { ...i, series: i.series.replace('release="fixture"', 'release="other"') }
          : i,
    }),
  );
  scenario(
    "duplicate failed reader cannot contribute a larger cached queue",
    inputs({
      duplicates: true,
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_capacity_monitor_fresh") &&
        i.series.includes('job="duplicate"')
          ? { ...i, values: "0+0x30" }
          : i.series.startsWith("opengeni_turn_eligible_backlog") &&
              i.series.includes('job="duplicate"')
            ? { ...i, values: "300+0x30" }
            : i,
    }),
    11,
    3,
    1,
  );
  scenario(
    "future within five second clock allowance remains valid",
    inputs({
      mutate: (i) => (i.series.includes("timestamp_seconds") ? { ...i, values: "5+15x30" } : i),
    }),
    11,
    3,
    1,
    "2m",
    { queue: 170, busy: 180, demand: 170 },
  );
  scenario(
    "sixty second observation boundary remains absent",
    inputs({
      mutate: (i) => (i.series.includes("timestamp_seconds") ? { ...i, values: "60+0x30" } : i),
    }),
  );
  for (const [age, observed] of [
    [44, 76],
    [45, 75],
    [46, 74],
  ] as const) {
    scenario(
      `queue producer age ${age} seconds: strict 45-second budget`,
      inputs({
        mutate: (i) =>
          i.series.startsWith("opengeni_turn_capacity_monitor_last_success")
            ? { ...i, values: `${observed}+0x30` }
            : i,
      }),
      age < 45 ? 11 : undefined,
      3,
      1,
      "2m",
      { queue: observed + 45, busy: 180, demand: observed + 45 },
    );
  }
  scenario(
    "occupancy retains its separate sixty-second producer budget",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_worker_activities_last_observed")
          ? { ...i, values: "61+0x30" }
          : i,
    }),
    11,
    3,
    1,
    "2m",
    { queue: 165, busy: 121, demand: 121 },
  );
  scenario(
    "queue raw sample retains sixty-second TTL despite 45-second producer budget",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_turn_eligible_backlog")
          ? { ...i, values: `${i.values.split("+")[0]}+0x5 _ _ _ _ _` }
          : i,
    }),
    11,
    3,
    1,
    "2m",
    { queue: 135, busy: 180, demand: 135 },
  );
  const pending = inputs({
    mutate: (i) =>
      i.series.startsWith("kube_pod_status_phase") &&
      i.series.includes('pod="fixture-worker-turns-b"')
        ? { ...i, series: i.series.replace('phase="Running"', 'phase="Pending"') }
        : i.series.startsWith("opengeni_turn_worker_activities_") &&
            i.series.includes('pod="fixture-worker-turns-b"')
          ? null
          : i,
  });
  scenario("fresh Pending nondeleting pod is not required to execute", pending, 11, 3, 1);
  scenario(
    "Unknown physical pod is conservatively still possibly executing",
    inputs({
      activities: [3, 4],
      mutate: (i) =>
        i.series.startsWith("kube_pod_status_phase") &&
        i.series.includes('pod="fixture-worker-turns-b"')
          ? { ...i, series: i.series.replace('phase="Running"', 'phase="Unknown"') }
          : i,
    }),
    11,
    7,
    2,
  );
  const draining = inputs({
    activities: [3, 4],
    mutate: (i) =>
      i.series.startsWith("kube_pod_status_phase") &&
      i.series.includes('pod="fixture-worker-turns-b"')
        ? { ...i, series: i.series.replace('phase="Running"', 'phase="Failed"') }
        : i.series.startsWith("kube_deployment_status_replicas")
          ? { ...i, values: "1+0x30" }
          : i,
  });
  draining.push({
    series:
      'kube_pod_deletion_timestamp{namespace="fixture",pod="fixture-worker-turns-b",uid="uid-b",job="ksm",instance="ksm"}',
    values: "30+0x30",
  });
  scenario("deleting pod with executing activity remains in physical fleet", draining, 11, 7, 2);
  for (const value of ["NaN", "-1", "+Inf", "-Inf", "0", "500"]) {
    scenario(
      `present invalid deletion ${value} cannot be treated as nondeleting during controller lag`,
      inputs({
        activities: [3, 7],
        mutate: (i) =>
          i.series.startsWith("kube_pod_status_phase") && i.series.includes('uid="uid-b"')
            ? { ...i, series: i.series.replace('phase="Running"', 'phase="Failed"') }
            : i,
      }).concat({
        series:
          'kube_pod_deletion_timestamp{namespace="fixture",pod="fixture-worker-turns-b",uid="uid-b",job="ksm",instance="ksm"}',
        values: Array(31).fill(value).join(" "),
      }),
      11,
    );
  }
  scenario(
    "stale present deletion cannot become legitimate absence",
    draining.map((i) =>
      i.series.startsWith("kube_pod_deletion_timestamp")
        ? { ...i, values: "30 _ _ _ _ _ _ _ _ _" }
        : i,
    ),
    11,
  );
  scenario(
    "bounded future deletion event is valid and retains the draining UID",
    draining.map((i) =>
      i.series.startsWith("kube_pod_deletion_timestamp") ? { ...i, values: "5+15x30" } : i,
    ),
    11,
    7,
    2,
  );
  scenario(
    "future deletion event beyond allowance invalidates fleet completeness",
    draining.map((i) =>
      i.series.startsWith("kube_pod_deletion_timestamp") ? { ...i, values: "6+15x30" } : i,
    ),
    11,
  );
  scenario(
    "drain removed from service endpoints blocks R/B, never hides execution",
    draining.filter(
      (i) => !i.series.startsWith("up{") || !i.series.includes('pod="fixture-worker-turns-b"'),
    ),
    8,
  );
  const rollout = inputs({
    mutate: (i) =>
      i.series.startsWith("kube_deployment_status_replicas") ? { ...i, values: "3+0x30" } : i,
  });
  for (const input of inputs({ activities: [2, 0] }).filter((i) =>
    i.series.includes('pod="fixture-worker-turns-a"'),
  ))
    rollout.push({
      ...input,
      series: input.series
        .replaceAll("fixture-worker-turns-a", "fixture-worker-turns-c")
        .replaceAll("uid-a", "uid-c")
        .replaceAll('instance="a"', 'instance="c"'),
    });
  scenario(
    "surge rollout includes old and new UID, dedup only exact physical pods",
    rollout,
    11,
    5,
    2,
  );
  scenario(
    "rollout missing new UID cannot be compensated by old pod",
    rollout.filter(
      (i) =>
        !i.series.startsWith("opengeni_turn_worker_activities_inflight") ||
        !i.series.includes('pod="fixture-worker-turns-c"'),
    ),
    11,
  );
  scenario(
    "stale scrape sample despite fresh producer value",
    inputs({
      mutate: (i) =>
        i.series.startsWith("opengeni_") || i.series.startsWith("up{")
          ? { ...i, values: i.values.split("+")[0]! + " _ _ _ _ _ _ _ _ _" }
          : i,
    }),
    undefined,
  );
  const dir = await mkdtemp(join(tmpdir(), "opengeni-queue-promtool-"));
  try {
    await Bun.write(join(dir, "rules.json"), JSON.stringify({ groups }));
    await Bun.write(
      join(dir, "fixtures.json"),
      JSON.stringify({ rule_files: ["rules.json"], evaluation_interval: "15s", tests: scenarios }),
    );
    const checked = await run([promtool, "check", "rules", join(dir, "rules.json")]);
    expect(checked.code, checked.stdout + checked.stderr).toBe(0);
    const result = await run([promtool, "test", "rules", join(dir, "fixtures.json")]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    console.info(`Validated ${scenarios.length} rendered-rule edge fixtures with real promtool`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);

test("atomic positive stage completion and exact intermediate identity resist independent review counterexamples", async () => {
  const [, promtool] = await tools;
  const rendered = await render(enabled);
  expect(rendered.code, rendered.stderr).toBe(0);
  const group = find(rendered.manifests, "PrometheusRule", "fixture-worker-scaler").spec.groups[0];
  // Assert EVERY recorded-series selector binds the same full source identity,
  // including final consumers. Raw KSM/discovery lack those app labels and are
  // independently bounded by namespace/Deployment/pod/release/component.
  for (const rule of group.rules) {
    for (const match of rule.expr.matchAll(
      /(opengeni(?::worker_scaler:|_turn_worker_)[a-z_]+)\{([^}]+)\}/gu,
    )) {
      for (const [key, value] of Object.entries(identity))
        expect(match[2], `${rule.record} selecting ${match[1]}`).toContain(`${key}="${value}"`);
    }
  }
  const scope = Object.entries(identity)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const expected = (name: string, value?: number, evalTime = "2m") => ({
    expr: `${name}{${labelSet},scaler_stage_complete=""}`,
    eval_time: evalTime,
    exp_samples: value === undefined ? [] : [{ labels: `{__name__="${name}",${scope}}`, value }],
  });
  const checks = (complete = false, time = "2m") => [
    expected("opengeni_turn_worker_queued", 11, time),
    expected("opengeni:worker_scaler:executing", complete ? 3 : undefined, time),
    expected("opengeni_turn_worker_busy", complete ? 1 : undefined, time),
    expected("opengeni_turn_worker_demand", complete ? 14 : undefined, time),
  ];
  const partial = inputs({
    activities: [3, 7],
    mutate: (i) =>
      i.series.startsWith("kube_pod_labels") && i.series.includes('uid="uid-b"') ? null : i,
  });
  const drain = inputs({
    activities: [3, 7],
    mutate: (i) =>
      i.series.startsWith("kube_pod_status_phase") && i.series.includes('uid="uid-b"')
        ? { ...i, series: i.series.replace('phase="Running"', 'phase="Failed"') }
        : i,
  });
  drain.push({
    series:
      'kube_pod_deletion_timestamp{namespace="fixture",pod="fixture-worker-turns-b",uid="uid-b",job="ksm",instance="ksm"}',
    values: "30+0x30",
  });
  const dir = await mkdtemp(join(tmpdir(), "opengeni-queue-review-"));
  let omissionCases = 0;
  try {
    const stages = group.rules
      .filter((rule: any) => rule.expr.includes('"scaler_stage_complete", "true"'))
      .map((rule: any) => rule.record);
    expect(stages).toHaveLength(11);
    stages.push("opengeni:worker_scaler:inventory_stages_complete");
    for (const [index, stage] of stages.entries()) {
      const ruleFile = `omitted-${index}.json`;
      await Bun.write(
        join(dir, ruleFile),
        JSON.stringify({
          groups: [{ ...group, rules: group.rules.filter((rule: any) => rule.record !== stage) }],
        }),
      );
      const tests = [inputs(), partial, drain].flatMap((input, variant) =>
        [false, true].map((stale) => ({
          name: `${stage} ${stale ? "stalled old completion" : "never evaluated"} variant${variant}`,
          input_series: [
            ...input,
            ...(stale
              ? [
                  {
                    series: `${stage}{${labelSet}${stage.endsWith("inventory_stages_complete") ? "" : ',scaler_stage_complete="true"'}}`,
                    values: "1 _ _ _ _ _ _ _ _ _",
                  },
                ]
              : []),
          ],
          promql_expr_test: [...checks(false, "15s"), ...checks()],
        })),
      );
      omissionCases += tests.length;
      const fixture = join(dir, `omission-${index}.json`);
      await Bun.write(
        fixture,
        JSON.stringify({ rule_files: [ruleFile], evaluation_interval: "15s", tests }),
      );
      const result = await run([promtool, "test", "rules", fixture]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
    }
    await Bun.write(join(dir, "rules.json"), JSON.stringify({ groups: [group] }));
    const foreignTests = Object.keys(identity).flatMap((key) =>
      [0, 1, 999].map((value) => ({
        name: `foreign ${key} intermediate/final records ${value} never rebind identity`,
        input_series: [
          ...inputs(),
          ...group.rules.flatMap((rule: any) => {
            const foreign = labelSet.replace(
              `${key}="${identity[key as keyof typeof identity]}"`,
              `${key}="foreign"`,
            );
            // Supply both physical data and a fleet-shaped sample. Nonnegative
            // counters, stale-looking deadlines and valid-looking markers all
            // challenge selectors, not just raw producer identity.
            return [
              {
                series: `${rule.record}{${foreign},pod="fixture-worker-turns-b",uid="uid-b",pod_uid="uid-b",worker_pod_uid="uid-b",component="worker-turn",job="worker",instance="b",phase="Running"}`,
                values: `${value}+0x30`,
              },
              { series: `${rule.record}{${foreign}}`, values: `${value}+0x30` },
              {
                series: `${rule.record}{${foreign},scaler_stage_complete="true"}`,
                values: "1+0x30",
              },
            ];
          }),
        ],
        promql_expr_test: checks(true),
      })),
    );
    await Bun.write(
      join(dir, "foreign.json"),
      JSON.stringify({
        rule_files: ["rules.json"],
        evaluation_interval: "15s",
        tests: foreignTests,
      }),
    );
    const result = await run([promtool, "test", "rules", join(dir, "foreign.json")]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    console.info(
      `Validated ${omissionCases} actual stage omission/stall cases and ${foreignTests.length} foreign-record identity cases`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);

test("real adapter query and inter-stage dependency fences reject evaluation stalls, errors and future samples", async () => {
  const [, promtool] = await tools;
  const rendered = await render(enabled);
  expect(rendered.code, rendered.stderr).toBe(0);
  const group = find(rendered.manifests, "PrometheusRule", "fixture-worker-scaler").spec.groups[0];
  const fragment = Bun.YAML.parse(
    await Bun.file(join(chart, "prometheus-adapter.queue-demand.example.yaml")).text(),
  ) as any;
  const queryTemplate = bindAdapterSource(fragment.rules.custom[1].metricsQuery)
    .replaceAll("<<.Series>>", "opengeni_turn_worker_queued")
    .replaceAll("<<.GroupBy>>", "namespace");
  const query = queryTemplate.replaceAll("<<.LabelMatchers>>", labelSet);
  for (const [key, value] of Object.entries(identity))
    expect(bindAdapterSource(fragment.rules.custom[1].seriesQuery)).toContain(`${key}="${value}"`);
  const dir = await mkdtemp(join(tmpdir(), "opengeni-queue-stall-"));
  const finalLabels =
    '{__name__="opengeni_turn_worker_demand",environment="fixture",namespace="fixture",release="fixture",task_queue="opengeni-runs-ts-turns",temporal_namespace="default"}';
  const queryTest = (
    expr: string,
    evalTime: string,
    value?: number,
    labels = '{namespace="fixture"}',
  ) => ({ expr, eval_time: evalTime, exp_samples: value === undefined ? [] : [{ labels, value }] });
  const deadlineInput = (
    values = "60+15x30",
    labels = labelSet,
    metric = "opengeni_turn_worker_queued",
  ) => ({ series: `${metric}_valid_until_timestamp_seconds{${labels}}`, values });
  try {
    // Simulate a rule group no longer evaluating: only its old final record is
    // present. This is the actual adapter expression, not a lookback surrogate.
    await Bun.write(
      join(dir, "adapter.json"),
      JSON.stringify({
        evaluation_interval: "15s",
        tests: [
          {
            name: "last rule sample becomes absent at exact thirty second boundary",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9 _ _ _ _ _ _ _ _ _" },
              deadlineInput("60 _ _ _ _ _ _ _ _ _"),
            ],
            promql_expr_test: [
              queryTest(query, "15s", 9),
              queryTest(query, "30s"),
              queryTest(query, "2m"),
            ],
          },
          {
            name: "zero is real while fresh and must age out too",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "0 _ _ _ _ _ _ _ _ _" },
              deadlineInput("60 _ _ _ _ _ _ _ _ _"),
            ],
            promql_expr_test: [queryTest(query, "15s", 0), queryTest(query, "30s")],
          },
          ...["NaN", "+Inf", "-Inf", "-1"].map((value) => ({
            name: `adapter rejects ${value}`,
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: value },
              deadlineInput("60"),
            ],
            promql_expr_test: [queryTest(query, "0s")],
          })),
          {
            name: "no rule observation is not zero",
            interval: "15s",
            input_series: [],
            promql_expr_test: [queryTest(query, "2m")],
          },
          {
            name: "release selector does not join a peer release",
            interval: "15s",
            input_series: [
              {
                series: `opengeni_turn_worker_queued{${labelSet.replace('release="fixture"', 'release="other"')}}`,
                values: "999+0x30",
              },
              deadlineInput("60+15x30", labelSet.replace('release="fixture"', 'release="other"')),
            ],
            promql_expr_test: [queryTest(query, "2m")],
          },
          ...Object.keys(identity).flatMap((key) =>
            [labelSet, 'namespace="fixture",release="fixture"', 'namespace="fixture"', ""].flatMap(
              (request) =>
                [true, false].map((ownPresent) => {
                  const foreign = labelSet.replace(
                    `${key}="${identity[key as keyof typeof identity]}"`,
                    `${key}="foreign"`,
                  );
                  return {
                    name: `adapter SOURCE fence rejects foreign ${key}, request ${request || "empty"}, own ${ownPresent}`,
                    input_series: [
                      ...(ownPresent
                        ? [
                            {
                              series: `opengeni_turn_worker_queued{${labelSet}}`,
                              values: "11+0x30",
                            },
                            deadlineInput(),
                          ]
                        : []),
                      { series: `opengeni_turn_worker_queued{${foreign}}`, values: "999+0x30" },
                      deadlineInput("60+15x30", foreign),
                    ],
                    promql_expr_test: [
                      queryTest(
                        queryTemplate.replaceAll("<<.LabelMatchers>>", request),
                        "2m",
                        ownPresent ? 11 : undefined,
                      ),
                    ],
                  };
                }),
            ),
          ),
          ...Object.keys(identity).map((key) => {
            const conflicting = labelSet.replace(
              `${key}="${identity[key as keyof typeof identity]}"`,
              `${key}="foreign"`,
            );
            return {
              name: `conflicting request ${key} cannot override SOURCE identity`,
              input_series: [
                { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "11+0x30" },
                deadlineInput(),
                { series: `opengeni_turn_worker_queued{${conflicting}}`, values: "999+0x30" },
                deadlineInput("60+15x30", conflicting),
              ],
              promql_expr_test: [
                queryTest(queryTemplate.replaceAll("<<.LabelMatchers>>", conflicting), "2m"),
              ],
            };
          }),
          // @ exposes a sample from a later timestamp to validate the future-clock
          // predicate independently of the engine's usual instant-query selection.
          {
            name: "five second future bound is inclusive; greater future rejects",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
              deadlineInput(),
            ],
            promql_expr_test: [
              queryTest(
                query.replaceAll(
                  `opengeni_turn_worker_queued{${labelSet},${labelSet}}`,
                  `opengeni_turn_worker_queued{${labelSet},${labelSet}} @ 120`,
                ),
                "110s",
              ),
              queryTest(
                query.replaceAll(
                  `opengeni_turn_worker_queued{${labelSet},${labelSet}}`,
                  `opengeni_turn_worker_queued{${labelSet},${labelSet}} @ 120`,
                ),
                "115s",
                9,
              ),
              queryTest(query, "2m", 9),
            ],
          },
          ...["NaN", "+Inf", "-Inf", "-1", "0", "500"].map((value) => ({
            name: `invalid/expired/unbounded deadline ${value} cannot support demand`,
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
              deadlineInput(
                `${value} ${value} ${value} ${value} ${value} ${value} ${value} ${value} ${value}`,
              ),
            ],
            promql_expr_test: [queryTest(query, "2m")],
          })),
          {
            name: "missing deadline does not inherit value record freshness",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
            ],
            promql_expr_test: [queryTest(query, "2m")],
          },
          {
            name: "freshly timestamped records cannot extend original expiry",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
              deadlineInput("60+0x30"),
            ],
            promql_expr_test: [
              queryTest(query, "45s", 9),
              queryTest(query, "60s"),
              queryTest(query, "2m"),
            ],
          },
          {
            name: "stalled deadline expires even while value record refreshes",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
              deadlineInput("60 _ _ _ _ _ _ _ _ _"),
            ],
            promql_expr_test: [queryTest(query, "15s", 9), queryTest(query, "30s")],
          },
          {
            name: "deadline requires identical Temporal identity",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "9+0x30" },
              deadlineInput(
                "60+15x30",
                labelSet.replace('temporal_namespace="default"', 'temporal_namespace="other"'),
              ),
            ],
            promql_expr_test: [queryTest(query, "2m")],
          },
        ],
      }),
    );
    const adapter = await run([promtool, "test", "rules", join(dir, "adapter.json")]);
    expect(adapter.code, adapter.stdout + adapter.stderr).toBe(0);
    // The adapter must respect the ORIGINAL producer expiry between the 15s
    // evaluations, even while the latest final count is still freshly recorded.
    // Exercise real rendered raw->rules->adapter, not synthetic final records.
    await Bun.write(join(dir, "complete-rules.json"), JSON.stringify({ groups: [group] }));
    await Bun.write(
      join(dir, "producer-expiry.json"),
      JSON.stringify({
        rule_files: ["complete-rules.json"],
        evaluation_interval: "15s",
        tests: [
          {
            name: "Q original lastSuccess+45 expires between evaluations; R/B stay independently live",
            input_series: inputs({
              mutate: (i) =>
                i.series.startsWith("opengeni_turn_capacity_monitor_last_success")
                  ? { ...i, values: "20+0x30" }
                  : i,
            }),
            promql_expr_test: [
              queryTest(query, "64s", 11),
              queryTest(query, "65s"),
              queryTest(query, "66s"),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_busy"),
                "65s",
                1,
              ),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_demand"),
                "64s",
                14,
              ),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_demand"),
                "65s",
              ),
            ],
          },
          {
            name: "R/B original observation+60 expires between evaluations; Q retains independent source",
            input_series: inputs({
              mutate: (i) =>
                i.series.startsWith("opengeni_turn_worker_activities_last_observed")
                  ? { ...i, values: "20+0x30" }
                  : i,
            }),
            promql_expr_test: [
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_busy"),
                "79s",
                1,
              ),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_busy"),
                "80s",
              ),
              queryTest(query, "80s", 11),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_demand"),
                "79s",
                14,
              ),
              queryTest(
                query.replaceAll("opengeni_turn_worker_queued", "opengeni_turn_worker_demand"),
                "80s",
              ),
            ],
          },
        ],
      }),
    );
    const producerExpiry = await run([
      promtool,
      "test",
      "rules",
      join(dir, "producer-expiry.json"),
    ]);
    expect(producerExpiry.code, producerExpiry.stdout + producerExpiry.stderr).toBe(0);
    // An earlier recording stage can fail while the final stage keeps running.
    // Use the rendered final rule unchanged to prove it cannot re-timestamp an
    // expired upstream sample forever. Raw stages have the same helper fence.
    await Bun.write(
      join(dir, "stage-rules.json"),
      JSON.stringify({
        groups: [
          {
            ...group,
            rules: group.rules.filter((rule: any) => rule.record === "opengeni_turn_worker_demand"),
          },
        ],
      }),
    );
    await Bun.write(
      join(dir, "stages.json"),
      JSON.stringify({
        rule_files: ["stage-rules.json"],
        evaluation_interval: "15s",
        tests: [
          {
            name: "stalled upstream records expire despite a working final stage",
            interval: "15s",
            input_series: [
              {
                series: `opengeni_turn_worker_queued{${labelSet}}`,
                values: "11 _ _ _ _ _ _ _ _ _",
              },
              {
                series: `opengeni:worker_scaler:executing{${labelSet}}`,
                values: "3 _ _ _ _ _ _ _ _ _",
              },
              deadlineInput("60 _ _ _ _ _ _ _ _ _", labelSet, "opengeni_turn_worker_demand"),
            ],
            promql_expr_test: [
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "0s", 14, finalLabels),
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "15s"),
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "30s"),
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "2m"),
            ],
          },
          {
            name: "fresh stage recordings cannot extend original sixty second deadline",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "11+0x30" },
              { series: `opengeni:worker_scaler:executing{${labelSet}}`, values: "3+0x30" },
              deadlineInput("60+0x30", labelSet, "opengeni_turn_worker_demand"),
            ],
            promql_expr_test: [
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "45s", 14, finalLabels),
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "60s"),
              queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "2m"),
            ],
          },
          {
            name: "one missing dependency never becomes zero or lower combined demand",
            interval: "15s",
            input_series: [
              { series: `opengeni_turn_worker_queued{${labelSet}}`, values: "11+0x30" },
            ],
            promql_expr_test: [queryTest('opengeni_turn_worker_demand{namespace="fixture"}', "2m")],
          },
        ],
      }),
    );
    const stages = await run([promtool, "test", "rules", join(dir, "stages.json")]);
    expect(stages.code, stages.stdout + stages.stderr).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);
