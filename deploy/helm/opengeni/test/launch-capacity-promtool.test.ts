import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional tooling, not a runtime dependency. CI/operator validation can supply
// the pinned Prometheus binary using OPENGENI_PROMTOOL or its ordinary PATH.
const promtool = process.env.OPENGENI_PROMTOOL ?? Bun.which("promtool");
const records = [
  "opengeni:turn_capacity_monitor:fresh",
  "opengeni:turn_eligible_backlog:fresh_max",
  "opengeni:turn_eligible_backlog_oldest_age_seconds:fresh_max",
];
const alerts = [
  "OpenGeniTurnEligibleBacklogOld",
  "OpenGeniTurnEligibleBacklogCritical",
  "OpenGeniTurnSlotsSaturated",
  "OpenGeniTurnCapacityMonitorStale",
  "OpenGeniTurnWorkerPodPending",
  "OpenGeniTurnWorkersAtScalingCeiling",
];
const scope = { namespace: "fixture", release: "fixture", environment: "fixture" };
type Input = { series: string; values: string };

function rule(template: string, kind: "record" | "alert", name: string): Record<string, any> {
  const marker = `        - ${kind}: ${name}\n`;
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${kind} ${name}`);
  const rest = template.slice(start + marker.length);
  const next = rest.search(/\n        - (?:record|alert):/);
  const block = template.slice(start, next < 0 ? undefined : start + marker.length + next);
  const fixture = block
    .replaceAll("{{ .Release.Namespace | quote }}", '"fixture"')
    .replaceAll("{{ .Release.Name | quote }}", '"fixture"')
    .replaceAll("{{ $environment | quote }}", '"fixture"')
    .replaceAll("{{ $fullName }}", "fixture")
    .split("\n")
    .map((line) => line.slice(8))
    .join("\n");
  try {
    return (Bun.YAML.parse(fixture) as Array<Record<string, any>>)[0]!;
  } catch (error) {
    throw new Error(`Cannot parse fixture rule ${name}`, { cause: error });
  }
}

function inputs(
  options: {
    age?: string;
    backlog?: string;
    slots?: string;
    timestamps?: string;
    available?: string;
    drop?: (series: string) => boolean;
    ceiling?: boolean;
    pending?: boolean;
  } = {},
): Input[] {
  const result: Input[] = [];
  for (const instance of ["worker-a", "worker-b"]) {
    const identity = `namespace="fixture",release="fixture",instance="${instance}"`;
    const app = `${identity},environment="fixture",component="worker-turn"`;
    result.push(
      { series: `up{${identity},opengeni_workload_component="worker-turns"}`, values: "1+0x20" },
      { series: `opengeni_turn_capacity_monitor_fresh{${app}}`, values: "1+0x20" },
      {
        series: `opengeni_turn_capacity_monitor_last_success_timestamp_seconds{${app}}`,
        values: options.timestamps ?? "0+30x20",
      },
      { series: `opengeni_turn_eligible_backlog{${app}}`, values: options.backlog ?? "5+0x20" },
      {
        series: `opengeni_turn_eligible_backlog_oldest_age_seconds{${app}}`,
        values: options.age ?? "0+0x20",
      },
      { series: `opengeni_turn_slot_saturation_ratio{${app}}`, values: options.slots ?? "0+0x20" },
    );
  }
  result.push({
    series:
      'kube_deployment_status_replicas_available{namespace="fixture",deployment="fixture-worker-turns"}',
    values: options.available ?? "2+0x20",
  });
  if (options.ceiling)
    result.push(
      {
        series:
          'kube_horizontalpodautoscaler_status_current_replicas{namespace="fixture",horizontalpodautoscaler="fixture-worker-turns"}',
        values: "2+0x20",
      },
      {
        series:
          'kube_horizontalpodautoscaler_spec_max_replicas{namespace="fixture",horizontalpodautoscaler="fixture-worker-turns"}',
        values: "2+0x20",
      },
    );
  if (options.pending)
    result.push(
      {
        series:
          'kube_pod_status_phase{namespace="fixture",pod="pending-turn-worker",phase="Pending"}',
        values: "1+0x20",
      },
      {
        series:
          'kube_pod_labels{namespace="fixture",pod="pending-turn-worker",label_app_kubernetes_io_instance="fixture",label_app_kubernetes_io_component="worker-turns"}',
        values: "1+0x20",
      },
    );
  return result.filter((input) => !options.drop?.(input.series));
}

test.skipIf(!promtool)(
  "real Prometheus validates launch capacity absence, MAX, tier timing and deduplication",
  async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const rules = [
      ...records.map((name) => rule(template, "record", name)),
      ...alerts.map((name) => rule(template, "alert", name)),
    ];
    const byName = new Map(
      rules.filter((entry) => entry.alert).map((entry) => [entry.alert, entry]),
    );
    function expectations(evalTime: string, firing: string[] = []) {
      return alerts.map((name) => ({
        eval_time: evalTime,
        alertname: name,
        exp_alerts: firing.includes(name)
          ? [
              {
                exp_labels: {
                  ...scope,
                  ...byName.get(name)!.labels,
                  ...(name === "OpenGeniTurnWorkerPodPending"
                    ? { pod: "pending-turn-worker" }
                    : {}),
                },
                exp_annotations: byName.get(name)!.annotations,
              },
            ]
          : [],
      }));
    }
    const scenarios: Record<string, any>[] = [];
    function scenario(name: string, source: Input[], firing: string[] = [], evalTime = "2m") {
      scenarios.push({
        name,
        interval: "30s",
        input_series: source,
        alert_rule_test: expectations(evalTime, firing),
      });
      return scenarios.at(-1)!;
    }
    const healthy = scenario(
      "complete idle telemetry is known zero, not stale",
      inputs({ backlog: "0+0x20" }),
    );
    healthy.promql_expr_test = [
      {
        expr: 'opengeni:turn_eligible_backlog:fresh_max{namespace="fixture"}',
        eval_time: "2m",
        exp_samples: [
          {
            labels:
              '{__name__="opengeni:turn_eligible_backlog:fresh_max",environment="fixture",namespace="fixture",release="fixture"}',
            value: 0,
          },
        ],
      },
    ];
    const maximum = scenario("duplicated global queue inventory uses MAX, not SUM", inputs());
    maximum.promql_expr_test = [
      {
        expr: 'opengeni:turn_eligible_backlog:fresh_max{namespace="fixture"}',
        eval_time: "2m",
        exp_samples: [
          {
            labels:
              '{__name__="opengeni:turn_eligible_backlog:fresh_max",environment="fixture",namespace="fixture",release="fixture"}',
            value: 5,
          },
        ],
      },
    ];
    for (const [age, firing] of [
      [30, [alerts[2]!]],
      [90, [alerts[0]!]],
      [120, [alerts[0]!]],
      [121, [alerts[1]!]],
    ] as const) {
      scenario(
        `age tier ${age} seconds`,
        inputs({ age: `${age}+0x20`, slots: "1+0x20", ceiling: true }),
        [...firing],
      );
    }
    scenario("warning waits for one minute", inputs({ age: "90+0x20" }), [], "30s");
    scenario(
      "warning fires at its one-minute hold",
      inputs({ age: "90+0x20" }),
      [alerts[0]!],
      "1m",
    );
    scenario("critical is not an instant page", inputs({ age: "121+0x20" }), [], "0s");
    scenario(
      "critical fires at its 30-second hold",
      inputs({ age: "121+0x20" }),
      [alerts[1]!],
      "30s",
    );
    scenario("transient queue-age blip never fires", inputs({ age: "90 90 0+0x18" }));
    for (const [name, options] of [
      [
        "lost scrape target",
        { drop: (series: string) => series.startsWith("up{") && series.includes("worker-b") },
      ],
      [
        "missing monitor",
        {
          drop: (series: string) =>
            series.startsWith("opengeni_turn_capacity_monitor_fresh{") &&
            series.includes("worker-b"),
        },
      ],
      [
        "missing timestamp",
        {
          drop: (series: string) =>
            series.startsWith("opengeni_turn_capacity_monitor_last_success_timestamp_seconds{") &&
            series.includes("worker-b"),
        },
      ],
      [
        "missing backlog",
        {
          drop: (series: string) =>
            series.startsWith("opengeni_turn_eligible_backlog{") && series.includes("worker-b"),
        },
      ],
      [
        "missing age",
        {
          drop: (series: string) =>
            series.startsWith("opengeni_turn_eligible_backlog_oldest_age_seconds{") &&
            series.includes("worker-b"),
        },
      ],
      ["unobserved ready replica", { available: "3+0x20" }],
      [
        "missing deployment observation",
        {
          drop: (series: string) => series.startsWith("kube_deployment_status_replicas_available{"),
        },
      ],
      ["stale queue sample", { timestamps: "0+0x20" }],
      ["implausibly future queue sample", { timestamps: "300+30x20" }],
    ] as const) {
      const incomplete = scenario(name, inputs({ age: "121+0x20", ...options }), [alerts[3]!]);
      incomplete.promql_expr_test = [
        {
          expr: 'opengeni:turn_eligible_backlog:fresh_max{namespace="fixture"}',
          eval_time: "2m",
          exp_samples: [],
        },
      ];
    }
    scenario(
      "staleness warns after 60-second expiry plus 30-second hold",
      inputs({ timestamps: "0+0x20" }),
      [alerts[3]!],
      "90s",
    );
    const down = inputs({ age: "121+0x20" });
    down.find(
      (input) => input.series.startsWith("up{") && input.series.includes("worker-b"),
    )!.values = "0+0x20";
    scenario("down scrape is unknown, not healthy empty queue", down, [alerts[3]!]);
    const swapped = inputs({ age: "121+0x20" });
    const timestamp = swapped.find(
      (input) =>
        input.series.startsWith("opengeni_turn_capacity_monitor_last_success_timestamp_seconds{") &&
        input.series.includes("worker-b"),
    )!;
    timestamp.series = timestamp.series.replace("worker-b", "foreign-worker");
    scenario("equal counts cannot hide a foreign timestamp identity", swapped, [alerts[3]!]);
    scenario(
      "ceiling and growing queue replace slot warning",
      inputs({ age: "20+0x20", backlog: "1+1x20", slots: "1+0x20", ceiling: true }),
      [alerts[5]!],
    );
    scenario(
      "flat queue at ceiling does not trigger growth alert",
      inputs({ age: "20+0x20", slots: "1+0x20", ceiling: true }),
      [alerts[2]!],
    );
    scenario("absent HPA is not a scaling ceiling", inputs({ age: "20+0x20", backlog: "1+1x20" }));
    scenario(
      "Pending worker does not warn on a short blip",
      inputs({ backlog: "0+0x20", pending: true }),
      [],
      "90s",
    );
    scenario("Pending worker warns at two minutes", inputs({ backlog: "0+0x20", pending: true }), [
      alerts[4]!,
    ]);
    const directory = await mkdtemp(join(tmpdir(), "opengeni-launch-promtool-"));
    try {
      await writeFile(
        join(directory, "rules.yaml"),
        Bun.YAML.stringify({
          groups: [{ name: "fixture", interval: "30s", labels: scope, rules }],
        }),
      );
      await writeFile(
        join(directory, "tests.yaml"),
        Bun.YAML.stringify({
          rule_files: ["rules.yaml"],
          evaluation_interval: "30s",
          tests: scenarios,
        }),
      );
      for (const command of [
        ["check", "rules", "rules.yaml"],
        ["test", "rules", "tests.yaml"],
      ]) {
        const result = Bun.spawnSync([promtool!, ...command], { cwd: directory });
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
      }
      expect(scenarios.length).toBeGreaterThanOrEqual(25);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
