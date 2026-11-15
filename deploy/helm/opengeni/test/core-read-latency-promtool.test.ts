import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservability } from "@opengeni/observability";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

const alert = "OpenGeniCoreReadLatencyHigh";
const route = "/v1/workspaces/:workspaceId/sessions/:id";
const scope = { namespace: "fixture", release: "fixture", environment: "fixture" };
/** Scrapes every 30s for 30 minutes. */
const steps = 60;

function alertRule(template: string): Record<string, any> {
  const marker = `        - alert: ${alert}\n`;
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`Missing alert ${alert}`);
  const rest = template.slice(start + marker.length);
  const next = rest.search(/\n        (?:- (?:record|alert):|#)/);
  const block = template.slice(start, next < 0 ? undefined : start + marker.length + next);
  const parsed = (
    Bun.YAML.parse(
      block
        .replaceAll("{{ .Release.Namespace | quote }}", '"fixture"')
        .replaceAll("{{ .Release.Name | quote }}", '"fixture"')
        .replaceAll("{{ $environment | quote }}", '"fixture"')
        .split("\n")
        .map((line) => line.slice(8))
        .join("\n"),
    ) as Array<Record<string, any>>
  )[0]!;
  // Helm renders `{{ "{{ ... }}" }}` to the literal Prometheus template action.
  parsed.annotations = Object.fromEntries(
    Object.entries(parsed.annotations as Record<string, string>).map(([key, text]) => [
      key,
      text.replace(/\{\{ "((?:[^"\\]|\\.)*)" \}\}/g, (_, inner: string) =>
        JSON.parse(`"${inner}"`),
      ),
    ]),
  );
  return parsed;
}

async function coreReadRule(): Promise<Record<string, any>> {
  return alertRule(
    await readFile(new URL("../templates/prometheusrule.yaml", import.meta.url), "utf8"),
  );
}

/** The latency, in seconds, that the alert compares the p95 against. */
function threshold(rule: Record<string, any>): number {
  const match = /\)\s*>\s*([0-9.]+)\s*\n\s*and on\(route\)/.exec(rule.expr as string);
  if (!match) throw new Error(`Cannot find the p95 threshold of ${alert}`);
  return Number(match[1]);
}

/**
 * The bucket bounds the API really exports for this histogram, read from its
 * own Prometheus exposition, so the fixtures below cannot drift from them.
 */
async function apiReadBuckets(): Promise<number[]> {
  const observability = createObservability(
    {
      serviceName: "opengeni",
      environment: "fixture",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: true,
      observabilityOtlpHeaders: "",
    },
    { component: "api", now: () => 1 },
  );
  observability.recordHttpRequest({ method: "GET", route, status: 200, durationSeconds: 0.1 });
  const bounds = (await observability.prometheusMetrics())
    .split("\n")
    .filter((line) => line.startsWith("opengeni_http_request_duration_seconds_bucket{"))
    .map((line) => /le="([^"]+)"/.exec(line)?.[1])
    .filter((le): le is string => le !== undefined && le !== "+Inf")
    .map(Number);
  expect(bounds.length).toBeGreaterThan(0);
  return bounds;
}

/** Reads of one duration; `count(step)` is the cumulative number seen by that scrape. */
type Reads = { seconds: number; count: (step: number) => number };
const steady = (seconds: number, perScrape: number): Reads => ({
  seconds,
  count: (step) => perScrape * step,
});
/** `total` reads of one duration, all recorded just before scrape `at`. */
const burst = (seconds: number, total: number, at: number): Reads => ({
  seconds,
  count: (step) => (step >= at ? total : 0),
});

/** Cumulative GET histogram for one core read route, over the API's real buckets. */
function histogram(buckets: number[], reads: Reads[]) {
  const labels = `namespace="fixture",release="fixture",environment="fixture",component="api",method="GET",route="${route}"`;
  const values = (bound: number) =>
    Array.from({ length: steps + 1 }, (_, step) =>
      reads
        .filter(({ seconds }) => seconds <= bound)
        .reduce((total, { count }) => total + count(step), 0),
    ).join(" ");
  return [
    ...[...buckets, Infinity].map((bound) => ({
      series: `opengeni_http_request_duration_seconds_bucket{${labels},le="${bound === Infinity ? "+Inf" : bound}"}`,
      values: values(bound),
    })),
    { series: `opengeni_http_request_duration_seconds_count{${labels}}`, values: values(Infinity) },
  ];
}

test("the p95 threshold is an exact bucket bound of the API's request histogram", async () => {
  // histogram_quantile interpolates linearly inside a bucket. Without a bound
  // at the threshold, "p95 above 2s" only measured how far into the 1-2.5s
  // bucket the 95th percentile read landed: it paged when a third of reads
  // took 1-2s and none took 2s, and stayed quiet when a tenth took 2.2s.
  expect(await apiReadBuckets()).toContain(threshold(await coreReadRule()));
});

test("real Prometheus pages on sustained core reads over 2 seconds, and only on those", async () => {
  const [promtool, rule, buckets] = await Promise.all([
    testTool("promtool"),
    coreReadRule(),
    apiReadBuckets(),
  ]);
  expect(threshold(rule)).toBe(2);
  const firing = (evalTime: string, value: number) => ({
    eval_time: evalTime,
    alertname: alert,
    exp_alerts: [
      {
        exp_labels: { ...scope, ...rule.labels, route },
        exp_annotations: expandAlertAnnotations(rule.annotations, {
          value,
          labels: { route },
        }),
      },
    ],
  });
  const quiet = (evalTime: string) => ({ eval_time: evalTime, alertname: alert, exp_alerts: [] });
  const p95 = `histogram_quantile(0.95, sum by (le) (rate(opengeni_http_request_duration_seconds_bucket[5m])))`;
  const tests = [
    {
      name: "one slow page-load burst does not page",
      interval: "30s",
      // Two fast reads every 30s; at minute 10 one page load adds nine 3s reads.
      input_series: histogram(buckets, [steady(0.1, 2), burst(3, 9, 20)]),
      alert_rule_test: ["11m", "14m", "16m", "20m", "29m"].map(quiet),
      promql_expr_test: [
        {
          // The burst does push p95 over 2s for the following window: the
          // left-open 5m range holds 18 fast and 9 slow reads.
          expr: `${p95} > 2`,
          eval_time: "12m",
          exp_samples: [{ labels: "{}", value: 2.5 + (2.5 * (0.95 * 27 - 18)) / 9 }],
        },
      ],
    },
    {
      name: "sustained slowness pages once it has lasted ten minutes",
      interval: "30s",
      // Every read takes 3s: p95 interpolates to 4.875s inside the 2.5-5s bucket.
      input_series: histogram(buckets, [steady(3, 2)]),
      alert_rule_test: [quiet("8m"), firing("15m", 4.875), firing("29m", 4.875)],
    },
    {
      name: "a third of reads taking 1-2 seconds, and none over 2, does not page",
      interval: "30s",
      // Each scrape: two 0.2s reads and one 1.5s read, so p95 interpolates to
      // 1 + (0.95 * 3 - 2) = 1.85s inside the 1-2s bucket. Interpolated across
      // a 1-2.5s bucket this read as p95 2.275s and paged.
      input_series: histogram(buckets, [steady(0.2, 2), steady(1.5, 1)]),
      alert_rule_test: ["11m", "15m", "29m"].map(quiet),
      promql_expr_test: [
        // In whole milliseconds: promtool compares samples exactly.
        {
          expr: `round(1000 * ${p95})`,
          eval_time: "15m",
          exp_samples: [{ labels: "{}", value: 1850 }],
        },
      ],
    },
    {
      name: "a tenth of reads taking over 2 seconds pages",
      interval: "30s",
      // Each scrape: nine 0.2s reads and one 2.2s read, so more than 5% of
      // reads exceed 2s. Interpolated across a 1-2.5s bucket this read as
      // p95 1.75s and never paged.
      input_series: histogram(buckets, [steady(0.2, 9), steady(2.2, 1)]),
      alert_rule_test: [quiet("8m"), firing("15m", 2.25), firing("29m", 2.25)],
    },
  ];
  const directory = await mkdtemp(join(tmpdir(), "opengeni-core-read-promtool-"));
  try {
    await writeFile(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({
        groups: [{ name: "fixture", interval: "30s", labels: scope, rules: [rule] }],
      }),
    );
    await writeFile(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({ rule_files: ["rules.yaml"], evaluation_interval: "30s", tests }),
    );
    for (const command of [
      ["check", "rules", "rules.yaml"],
      ["test", "rules", "tests.yaml"],
    ]) {
      const result = Bun.spawnSync([promtool, ...command], { cwd: directory });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
