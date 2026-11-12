import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";

// Optional tooling, not a runtime dependency. CI/operator validation can supply
// the pinned Prometheus binary using OPENGENI_PROMTOOL or its ordinary PATH.
const promtool = process.env.OPENGENI_PROMTOOL ?? Bun.which("promtool");
const alert = "OpenGeniCoreReadLatencyHigh";
const route = "/v1/workspaces/:workspaceId/sessions/:id";
const scope = { namespace: "fixture", release: "fixture", environment: "fixture" };

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

/** Cumulative GET histogram for one core read route, sampled every 30s for 30 minutes. */
function histogram(fast: string, slow: string) {
  const labels = `namespace="fixture",release="fixture",environment="fixture",component="api",method="GET",route="${route}"`;
  const buckets: Array<[string, string]> = [
    ["0.25", fast],
    ["1", fast],
    ["2.5", fast],
    ["5", slow],
    ["+Inf", slow],
  ];
  return [
    ...buckets.map(([le, values]) => ({
      series: `opengeni_http_request_duration_seconds_bucket{${labels},le="${le}"}`,
      values,
    })),
    { series: `opengeni_http_request_duration_seconds_count{${labels}}`, values: slow },
  ];
}

test.skipIf(!promtool)(
  "real Prometheus pages on sustained core read slowness, not on a few-second burst",
  async () => {
    const template = await readFile(
      new URL("../templates/prometheusrule.yaml", import.meta.url),
      "utf8",
    );
    const rule = alertRule(template);
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
    // Two fast reads every 30s; at minute 10 one page load adds nine 2.5-5s reads.
    const burst = histogram("0+2x60", "0+2x19 49+2x40");
    // Every read takes 2.5-5s: p95 interpolates to 4.875s.
    const sustained = histogram("0+0x60", "0+2x60");
    const tests = [
      {
        name: "one slow page-load burst does not page",
        interval: "30s",
        input_series: burst,
        alert_rule_test: ["11m", "14m", "16m", "20m", "29m"].map(quiet),
        promql_expr_test: [
          {
            // The burst does push p95 over 2s for the following window: the
            // left-open 5m range holds 18 fast and 9 slow reads.
            expr: `histogram_quantile(0.95, sum by (le) (rate(opengeni_http_request_duration_seconds_bucket[5m]))) > 2`,
            eval_time: "12m",
            exp_samples: [{ labels: "{}", value: 2.5 + (2.5 * (0.95 * 27 - 18)) / 9 }],
          },
        ],
      },
      {
        name: "sustained slowness pages once it has lasted ten minutes",
        interval: "30s",
        input_series: sustained,
        alert_rule_test: [quiet("8m"), firing("15m", 4.875), firing("29m", 4.875)],
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
        const result = Bun.spawnSync([promtool!, ...command], { cwd: directory });
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
