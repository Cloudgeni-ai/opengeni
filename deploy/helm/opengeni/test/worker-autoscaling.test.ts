import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helm = process.env.OPENGENI_TEST_HELM ?? Bun.which("helm");
const promtool = process.env.OPENGENI_TEST_PROMTOOL ?? Bun.which("promtool");
const scope = { namespace: "apps", release: "alpha", environment: "azure-managed" };
const demand = "opengeni:turn_autoscaling_demand:fresh_total";

function render(extra: string[] = []) {
  if (!helm) throw new Error("helm is required for chart render tests");
  return execFileSync(
    helm,
    [
      "template",
      "alpha",
      resolve(import.meta.dir, ".."),
      "--namespace",
      "apps",
      "--api-versions",
      "monitoring.coreos.com/v1",
      "--api-versions",
      "keda.sh/v1alpha1",
      "--set",
      "worker.turns.autoscaling.enabled=true",
      "--set",
      "fullnameOverride=alpha",
      "--set",
      "worker.turns.autoscaling.keda.enabled=true",
      "--set",
      "worker.turns.autoscaling.keda.demandEnabled=true",
      "--set",
      "worker.turns.autoscaling.keda.serverAddress=http://prometheus:9090",
      "--set",
      "observability.prometheusRule.enabled=true",
      "--set-string",
      "config.OPENGENI_ENVIRONMENT=azure-managed",
      "--set-string",
      "config.OPENGENI_TURN_WORKER_CONCURRENCY_MODE=fixed",
      "--set-string",
      "config.OPENGENI_TURN_WORKER_MAX_CONCURRENT_TURNS=32",
      "--set-string",
      "config.OPENGENI_TURN_WORKER_MIN_MEMORY_SAFE_TURNS=20",
      "--set-string",
      "config.OPENGENI_TURN_WORKER_BASELINE_MEMORY_BUDGET_MIB=1536",
      "--set-string",
      "config.OPENGENI_VIDEO_RECONCILIATION_CONTROL_QUEUE_ENABLED=true",
      ...extra,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
}

function documents(text: string): any[] {
  const parsed = Bun.YAML.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
}

describe("single-owner fail-safe worker elasticity", () => {
  test("transition retains one resource-only owner, without claiming pure demand", () => {
    const resources = documents(
      render(["--set", "worker.turns.autoscaling.keda.demandEnabled=false"]),
    );
    const scaler = resources.find((entry) => entry.kind === "ScaledObject");
    expect(scaler.spec.triggers.map((trigger: any) => trigger.type)).toEqual(["memory", "cpu"]);
    expect(scaler.spec.fallback).toBeUndefined();
    expect(resources.some((entry) => entry.metadata?.name.endsWith("worker-autoscaling"))).toBe(
      false,
    );
    expect(
      resources.some(
        (entry) =>
          entry.kind === "HorizontalPodAutoscaler" && entry.metadata.name.endsWith("worker-turns"),
      ),
    ).toBe(false);
  });
  test("renders one ScaledObject, no legacy turn HPA or replica repinning", () => {
    const resources = documents(render());
    const scaler = resources.find((entry) => entry.kind === "ScaledObject");
    expect(resources.filter((entry) => entry.kind === "ScaledObject")).toHaveLength(1);
    expect(
      resources.filter(
        (entry) =>
          entry.kind === "HorizontalPodAutoscaler" && entry.metadata.name.endsWith("worker-turns"),
      ),
    ).toHaveLength(0);
    expect(
      resources.find(
        (entry) => entry.kind === "Deployment" && entry.metadata.name.endsWith("worker-turns"),
      ).spec.replicas,
    ).toBeUndefined();
    expect(scaler.spec.fallback.behavior).toBe("currentReplicasIfHigher");
    const [pressure, memory, cpu] = scaler.spec.triggers;
    expect(pressure.metadata.ignoreNullValues).toBe("false");
    expect(pressure.metadata.query).toContain("timestamp(");
    expect(pressure.metadata.query).not.toContain("vector(0)");
    expect(memory).toMatchObject({
      type: "memory",
      metricType: "AverageValue",
      metadata: { value: "2560Mi" },
    });
    expect(cpu).toMatchObject({
      type: "cpu",
      metricType: "Utilization",
      metadata: { value: "70" },
    });
  });

  test("rejects an overlapping custom autoscaler and missing addon CRDs", () => {
    expect(() =>
      render(["--set", "worker.turns.autoscaling.slotSaturationMetric.enabled=true"]),
    ).toThrow();
    const args = [
      "template",
      "alpha",
      resolve(import.meta.dir, ".."),
      "--set",
      "worker.turns.autoscaling.keda.enabled=true",
      "--set",
      "worker.turns.autoscaling.enabled=true",
    ];
    expect(() => execFileSync(helm!, args, { encoding: "utf8", stdio: "pipe" })).toThrow();
  });
});

type FixtureOptions = {
  occupancy?: number[];
  queue?: number[];
  missingPod?: boolean;
  missingUp?: boolean;
  stale?: boolean;
  failed?: boolean;
  desired?: number;
  duplicatePod?: boolean;
};

function series(metric: string, labels: Record<string, string>, value: number) {
  return {
    series: `${metric}{${Object.entries(labels)
      .map(([key, val]) => `${key}=${JSON.stringify(val)}`)
      .join(",")}}`,
    values: `${value}+0x2`,
  };
}

function fixture(options: FixtureOptions = {}) {
  const inputs = [
    series(
      "kube_deployment_spec_replicas",
      { namespace: "apps", deployment: "alpha-worker-turns" },
      options.desired ?? 3,
    ),
    series(
      "kube_deployment_status_replicas",
      { namespace: "apps", deployment: "alpha-worker-turns" },
      3,
    ),
  ];
  for (let pod = 0; pod < 3; pod += 1) {
    if (options.missingPod && pod === 2) continue;
    const labels = {
      ...scope,
      component: "worker-turn",
      job: "alpha-worker-turns",
      pod: `turn-${pod}`,
      instance: `instance-${pod}`,
    };
    const metrics = [
      series("opengeni_turns_inflight", labels, options.occupancy?.[pod] ?? 20),
      series("opengeni_turn_eligible_backlog", labels, options.queue?.[pod] ?? [2, 3, 3][pod]!),
      series("opengeni_turn_capacity_monitor_fresh", labels, options.failed && pod === 2 ? 0 : 1),
      series(
        "opengeni_turn_capacity_monitor_last_success_timestamp_seconds",
        labels,
        options.stale && pod === 2 ? -100 : 0,
      ),
    ];
    inputs.push(...metrics);
    if (!(options.missingUp && pod === 2)) {
      inputs.push(
        series(
          "up",
          { namespace: "apps", release: "alpha", job: "alpha-worker-turns", pod: labels.pod },
          1,
        ),
      );
    }
    if (options.duplicatePod && pod === 0) {
      inputs.push(
        ...metrics.map((entry) => ({
          ...entry,
          series: entry.series.replace("instance-0", "duplicate-0"),
        })),
      );
    }
  }
  // A co-located release must never contribute occupancy, queue or freshness.
  inputs.push(
    series(
      "opengeni_turns_inflight",
      {
        ...scope,
        release: "beta",
        component: "worker-turn",
        job: "beta-worker-turns",
        pod: "beta-0",
        instance: "beta-0",
      },
      999,
    ),
  );
  return inputs;
}

test.skipIf(!promtool)(
  "Prometheus deduplicates pressure and fails closed on incomplete or stale evidence",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-worker-autoscaling-"));
    try {
      const rule = documents(render()).find(
        (entry) =>
          entry.kind === "PrometheusRule" && entry.metadata.name.endsWith("worker-autoscaling"),
      );
      const ruleFile = join(directory, "rules.json");
      await writeFile(ruleFile, JSON.stringify(rule.spec));
      const cases: Array<[string, FixtureOptions, number | null]> = [
        ["global queue max, not sum", {}, 63],
        ["deduplicate duplicate target", { duplicatePod: true }, 63],
        ["queued work blocks downscale", { occupancy: [1, 2, 2], queue: [1, 1, 1] }, 60],
        ["healthy idle is zero", { occupancy: [0, 0, 0], queue: [0, 0, 0] }, 0],
        ["missing worker", { missingPod: true }, null],
        ["missing scrape", { missingUp: true }, null],
        ["failed monitor", { failed: true }, null],
        ["stale timestamp despite fresh gauge", { stale: true }, null],
        ["new pending replica", { desired: 4 }, null],
      ];
      const testFile = join(directory, "fixtures.json");
      await writeFile(
        testFile,
        JSON.stringify({
          rule_files: [ruleFile],
          evaluation_interval: "15s",
          tests: cases.map(([name, options, expected]) => ({
            name,
            interval: "15s",
            input_series: fixture(options),
            promql_expr_test: [
              {
                expr: demand,
                eval_time: "30s",
                exp_samples:
                  expected === null
                    ? []
                    : [
                        {
                          labels: `${demand}{namespace="apps",release="alpha",environment="azure-managed"}`,
                          value: expected,
                        },
                      ],
              },
              ...(name === "global queue max, not sum"
                ? [
                    ["replicas:desired", 3],
                    ["replicas:observed", 3],
                    ["queue:fresh_max", 3],
                    ["occupancy:fresh_sum", 60],
                    ["pressure:fresh_total", 63],
                  ].map(([suffix, value]) => ({
                    expr: `opengeni:turn_autoscaling_${suffix}`,
                    eval_time: "30s",
                    exp_samples: [
                      {
                        labels: `opengeni:turn_autoscaling_${suffix}{namespace="apps",release="alpha",environment="azure-managed"}`,
                        value,
                      },
                    ],
                  }))
                : []),
            ],
          })),
        }),
      );
      const result = spawnSync(promtool!, ["test", "rules", testFile], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`.slice(0, 6_000)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
