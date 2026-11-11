import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

// A p99 over fewer than 100 observations is just the slowest one, so a quiet
// deployment must not page on one slow write. These tests render the chart's
// real rules and drive them through promtool.

const scope = { namespace: "fixture", release: "fixture", environment: "production" };
const scopeLabels = 'namespace="fixture",release="fixture",environment="production"';
const appendHigh = "OpenGeniEventAppendLatencyHigh";
const appendCritical = "OpenGeniEventAppendLatencyCritical";
const publishHigh = "OpenGeniEventPublishLatencyHigh";
const ttftRegression = "OpenGeniModelProviderTtftRegression";
const minutes = 40;

// Match STREAM_IO_BUCKETS and MODEL_REQUEST_PRE_DISPATCH_BUCKETS in
// apps/worker/src/observability-metrics.ts.
const streamBuckets = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const preDispatchBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120];

type Input = { series: string; values: string };
/** Observations of one duration; `count(minute)` is the cumulative number seen. */
type Observations = { seconds: number; count: (minute: number) => number };

const steady = (seconds: number, perMinute: number): Observations => ({
  seconds,
  count: (minute) => perMinute * minute,
});
/** One observation, recorded between minute `after` and the next scrape. */
const once = (seconds: number, after: number): Observations => ({
  seconds,
  count: (minute) => (minute > after ? 1 : 0),
});

function histogram(
  metric: string,
  buckets: number[],
  observations: Observations[],
  extraLabels = "",
): Input[] {
  const labels = `${scopeLabels}${extraLabels}`;
  const series = (bound: number) =>
    Array.from({ length: minutes + 1 }, (_, minute) =>
      observations
        .filter(({ seconds }) => seconds <= bound)
        .reduce((total, { count }) => total + count(minute), 0),
    ).join(" ");
  return [
    ...buckets.map((le) => ({
      series: `${metric}_bucket{${labels},le="${le}"}`,
      values: series(le),
    })),
    { series: `${metric}_bucket{${labels},le="+Inf"}`, values: series(Infinity) },
    { series: `${metric}_count{${labels}}`, values: series(Infinity) },
  ];
}

let helmBinary: string | undefined;
let promtoolBinary: string | undefined;
async function tools() {
  [helmBinary, promtoolBinary] = await Promise.all([testTool("helm"), testTool("promtool")]);
}

function renderRules(): any[] {
  const manifest = Bun.YAML.parse(
    execFileSync(
      helmBinary!,
      [
        "template",
        "fixture",
        resolve(import.meta.dir, ".."),
        "--namespace",
        "fixture",
        "--api-versions",
        "monitoring.coreos.com/v1",
        "--set",
        "observability.prometheusRule.enabled=true",
        "--show-only",
        "templates/prometheusrule.yaml",
      ],
      { encoding: "utf8" },
    ),
  ) as any;
  return manifest.spec.groups.flatMap((group: any) => group.rules);
}

function runPromtool(rules: any[], cases: any[]) {
  const directory = mkdtempSync(join(tmpdir(), "quantile-volume-guard-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", labels: scope, rules }] }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({ rule_files: ["rules.yaml"], evaluation_interval: "30s", tests: cases }),
    );
    const result = Bun.spawnSync([promtoolBinary!, "test", "rules", "tests.yaml"], {
      cwd: directory,
    });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("streaming p99 alerts stay silent on low volume and fire on sustained slow traffic", async () => {
  await tools();
  const names = [appendHigh, appendCritical, publishHigh];
  const byName = new Map<string, any>(
    renderRules()
      .filter((rule: any) => names.includes(rule.alert))
      .map((rule: any) => [rule.alert, rule]),
  );
  expect([...byName.keys()].sort()).toEqual([...names].sort());
  const append = (observations: Observations[]) =>
    histogram("opengeni_session_event_append_seconds", streamBuckets, observations);
  const publish = (observations: Observations[]) =>
    histogram("opengeni_session_event_publish_seconds", streamBuckets, observations);
  // The unguarded p99 of each rule, so every quiet case also proves that the
  // volume guard (not an unremarkable p99) is what keeps it silent.
  const rawP99AboveThreshold = (alert: string) => {
    const metric = alert === publishHigh ? "publish" : "append";
    const window = alert === appendCritical ? "5m" : "10m";
    const threshold = { [appendHigh]: 1, [appendCritical]: 2, [publishHigh]: 0.5 }[alert];
    return `histogram_quantile(0.99, sum by (le) (rate(opengeni_session_event_${metric}_seconds_bucket{${scopeLabels}}[${window}]))) > bool ${threshold}`;
  };

  const cases: any[] = [];
  function scenario(
    name: string,
    evalTime: string,
    inputs: Input[],
    firing: Record<string, number>,
    slowButQuiet: string[] = [],
  ) {
    cases.push({
      name,
      interval: "1m",
      input_series: inputs,
      alert_rule_test: names.map((alertname) => ({
        eval_time: evalTime,
        alertname,
        exp_alerts:
          firing[alertname] === undefined
            ? []
            : [
                {
                  exp_labels: { ...scope, ...byName.get(alertname).labels },
                  exp_annotations: expandAlertAnnotations(byName.get(alertname).annotations, {
                    value: firing[alertname]!,
                  }),
                },
              ],
      })),
      promql_expr_test: slowButQuiet.flatMap((alertname) => [
        // The p99 really is above the threshold...
        {
          expr: rawP99AboveThreshold(alertname),
          eval_time: evalTime,
          exp_samples: [{ labels: "{}", value: 1 }],
        },
        // ...but the rule's condition does not hold.
        { expr: byName.get(alertname).expr, eval_time: evalTime, exp_samples: [] },
      ]),
    });
  }

  scenario(
    "one slow append and one slow publish among about 24 per 10 minutes stay silent",
    "25m",
    [...append([steady(0.04, 2.4), once(4, 22)]), ...publish([steady(0.004, 2.4), once(0.8, 22)])],
    {},
    names,
  );
  scenario(
    "25 appends per 10 minutes with one slow write in every 5 minutes stays silent",
    "30m",
    append([steady(0.04, 2.3), steady(2.4, 0.2)]),
    {},
    [appendHigh, appendCritical],
  );
  scenario(
    "sustained slow traffic just under 100 per window stays silent",
    "30m",
    [
      ...append([steady(0.04, 8.1), steady(4, 0.9)]),
      ...publish([steady(0.004, 8.1), steady(0.8, 0.9)]),
    ],
    {},
    names,
  );
  scenario(
    "sustained slow appends at 300 per 10 minutes fire the warning and the critical tier",
    "30m",
    [...append([steady(0.04, 27), steady(4, 3)]), ...publish([steady(0.004, 30)])],
    { [appendHigh]: 4.75, [appendCritical]: 4.75 },
  );
  scenario(
    "sustained slow appends at 120 per 10 minutes warn, but 60 in 5 minutes cannot page",
    "30m",
    append([steady(0.04, 10.8), steady(4, 1.2)]),
    { [appendHigh]: 4.75 },
    [appendCritical],
  );
  scenario(
    "sustained slow publishes at 300 per 10 minutes fire",
    "30m",
    [...append([steady(0.04, 30)]), ...publish([steady(0.004, 27), steady(0.8, 3)])],
    { [publishHigh]: 0.95 },
  );
  scenario(
    "healthy traffic at volume stays silent",
    "30m",
    [...append([steady(0.04, 30)]), ...publish([steady(0.004, 30)])],
    {},
  );
  runPromtool(
    names.map((name) => byName.get(name)),
    cases,
  );
}, 180_000);

test("one slow pre-dispatch request does not hide a provider TTFT regression", async () => {
  await tools();
  const rule = renderRules().find((item: any) => item.alert === ttftRegression);
  const provider = 'provider="fixture-provider"';
  // The alert reads the chart's recording rules; feed their outputs directly:
  // a provider at 4x its own baseline with plenty of requests.
  const regressed: Input[] = [
    [`opengeni:model_provider_ttft_seconds:p90_30m`, 20],
    [`opengeni:model_provider_ttft_seconds:p90_24h_baseline`, 5],
    [`opengeni:model_provider_ttft_requests:30m`, 100],
    [`opengeni:model_provider_ttft_requests:24h_baseline`, 1000],
  ].map(([metric, value]) => ({
    series: `${metric}{${scopeLabels},${provider}}`,
    values: `${value}+0x${minutes}`,
  }));
  const preDispatch = (observations: Observations[]) =>
    histogram(
      "opengeni_model_request_pre_dispatch_seconds",
      preDispatchBuckets,
      observations,
      `,${provider}`,
    );
  const alert = (firing: boolean) => ({
    eval_time: "25m",
    alertname: ttftRegression,
    exp_alerts: firing
      ? [
          {
            exp_labels: { ...scope, ...rule.labels, provider: "fixture-provider" },
            exp_annotations: expandAlertAnnotations(rule.annotations, {
              value: 20,
              labels: { provider: "fixture-provider" },
            }),
          },
        ]
      : [],
  });
  runPromtool(
    [rule],
    [
      {
        name: "a single slow pre-dispatch request among a few does not suppress the alert",
        interval: "1m",
        input_series: [...regressed, ...preDispatch([steady(0.1, 0.5), once(8, 15)])],
        alert_rule_test: [alert(true)],
        promql_expr_test: [
          {
            expr: `histogram_quantile(0.95, sum by (le) (rate(opengeni_model_request_pre_dispatch_seconds_bucket{${scopeLabels}}[15m]))) > bool 2`,
            eval_time: "25m",
            exp_samples: [{ labels: "{}", value: 1 }],
          },
        ],
      },
      {
        name: "sustained slow pre-dispatch at volume still attributes the slowness to Opengeni",
        interval: "1m",
        input_series: [...regressed, ...preDispatch([steady(0.1, 2), steady(8, 0.5)])],
        alert_rule_test: [alert(false)],
      },
    ],
  );
}, 180_000);
