import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Target = { expr: string; legendFormat: string; instant: boolean };
type Panel = { id: number; targets?: Target[]; options?: { content?: string } };
type Dashboard = {
  panels: Panel[];
  templating: { list: Array<{ name: string; multi?: boolean; includeAll?: boolean }> };
};
const dashboard = JSON.parse(
  await readFile(new URL("./api-latency.json", import.meta.url), "utf8"),
) as Dashboard;
const targets = dashboard.panels.flatMap((panel) => panel.targets ?? []);
const query = (id: number, index = 0) =>
  dashboard.panels.find((panel) => panel.id === id)!.targets![index]!.expr;

test("API latency comparisons retain deployment, method and route identity", () => {
  for (const variable of ["namespace", "environment", "release"]) {
    expect(dashboard.templating.list.find((entry) => entry.name === variable)).toMatchObject({
      multi: false,
      includeAll: false,
    });
  }
  for (const target of targets) {
    for (const selector of target.expr.matchAll(/opengeni_http_\w+\{([^}]+)\}/g)) {
      expect(selector[1]).toContain('namespace="$namespace"');
      expect(selector[1]).toContain('environment="$environment"');
      expect(selector[1]).toContain('release="$release"');
      expect(selector[1]).toContain('component="api"');
      expect(selector[1]).toContain('method=~"$method"');
      expect(selector[1]).toContain('route=~"$route"');
    }
    expect(target.expr).toMatch(/sum by \((?:le, )?method, route(?:, status)?\)/);
    expect(target.expr).not.toContain("or vector(0)");
    expect(target.expr).not.toContain("clamp_min");
  }
  expect(query(3)).toContain('le="0.5"');
  expect(query(2)).toContain('status_class="2xx"');
  expect(query(2, 1)).toContain("offset $__range");
  expect(query(7)).not.toContain("status_class");
  expect(dashboard.panels[0]?.options?.content).toContain("mixed rollout");
});

// Execute the dashboard's own expressions in Prometheus. No separate query
// implementation: a bad aggregate, selector, offset or denominator fails here.
const promtool = process.env.OPENGENI_TEST_PROMTOOL ?? Bun.which("promtool");
test.skipIf(!promtool)(
  "Prometheus separates slow successes, errors, legacy samples and other deployments",
  async () => {
    const render = (expr: string) =>
      expr
        .replaceAll("$namespace", "apps")
        .replaceAll("$environment", "staging")
        .replaceAll("$release", "opengeni")
        .replaceAll("$method", "POST")
        .replaceAll("$route", "/sessions")
        .replaceAll("$__rate_interval", "5m")
        .replaceAll("$__range", "5m");
    const scope = {
      namespace: "apps",
      environment: "staging",
      release: "opengeni",
      component: "api",
      method: "POST",
      route: "/sessions",
    };
    const series = (metric: string, labels: Record<string, string>, perMinute: number) => ({
      series: `${metric}{${Object.entries({ ...scope, ...labels })
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(",")}}`,
      values: `0+${perMinute}x10`,
    });
    const histogram = (
      labels: Record<string, string>,
      total: number,
      fast: number,
      errors = false,
    ) => [
      ...["0.005", "0.01", "0.25", "0.5", "1", "2.5", "+Inf"].map((le) =>
        series(
          "opengeni_http_request_duration_seconds_bucket",
          { ...labels, le },
          le === "0.005"
            ? 0
            : errors
              ? total
              : Number(le) < 0.5
                ? 0
                : Number(le) < 2.5
                  ? fast
                  : total,
        ),
      ),
      series("opengeni_http_request_duration_seconds_count", labels, total),
    ];
    // Two replicas have very different traffic weights; averaging their P95s
    // would give a different result from the correct aggregated histogram.
    const successes = [
      ...histogram({ instance: "a", status_class: "2xx" }, 50, 40),
      ...histogram({ instance: "b", status_class: "2xx" }, 150, 60),
    ];
    const changingSuccesses = successes.map((entry) => {
      const after = Number(entry.values.match(/^0\+(\d+)x10$/)![1]);
      const before = after === 0 ? 0 : entry.series.includes('instance="a"') ? 25 : 75;
      return {
        ...entry,
        values: Array.from(
          { length: 11 },
          (_, minute) => Math.min(minute, 5) * before + Math.max(0, minute - 5) * after,
        ).join(" "),
      };
    });
    const legacy = histogram({ instance: "old" }, 1_000, 1_000, true);
    const input = [
      ...successes,
      ...histogram({ instance: "a", status_class: "4xx" }, 10_000, 10_000, true),
      ...legacy,
      ...["namespace", "environment", "release", "method", "route", "component"].flatMap((key) =>
        histogram(
          { instance: `foreign-${key}`, status_class: "2xx", [key]: "other" },
          50_000,
          50_000,
          true,
        ),
      ),
      series("opengeni_http_requests_total", { instance: "a", status: "200" }, 50),
      series("opengeni_http_requests_total", { instance: "b", status: "200" }, 150),
      series("opengeni_http_requests_total", { instance: "a", status: "404" }, 10_000),
    ];
    const labels = '{method="POST",route="/sessions"}';
    const expression = (expr: string, value: number) => ({
      expr: render(expr),
      eval_time: "10m",
      exp_samples: [{ labels, value }],
    });
    const fixture = {
      rule_files: [],
      fuzzy_compare: true,
      evaluation_interval: "1m",
      tests: [
        {
          interval: "1m",
          input_series: input,
          promql_expr_test: [
            expression(query(2), 2.35),
            expression(query(2, 1), 2.35),
            expression(query(3), 0.5),
            expression(query(4), 1_000),
            expression(query(4, 1), 1_000),
            expression(query(5, 0), 0.5),
            expression(query(5, 1), 2.35),
            expression(query(5, 2), 2.47),
            expression(query(7), 0.005 + (0.005 * 0.95 * 11_200) / 11_000),
            expression(query(7, 1), 0.005 + (0.005 * 0.95 * 11_200) / 11_000),
            {
              expr: render(query(6)),
              eval_time: "10m",
              exp_samples: [
                { labels: '{method="POST",route="/sessions",status="200"}', value: 200 / 60 },
                { labels: '{method="POST",route="/sessions",status="404"}', value: 10_000 / 60 },
              ],
            },
            {
              expr: render(query(8)),
              eval_time: "10m",
              exp_samples: [
                { labels: '{method="POST",route="/sessions",status="200"}', value: 1_000 },
                { labels: '{method="POST",route="/sessions",status="404"}', value: 50_000 },
              ],
            },
          ],
        },
        {
          interval: "1m",
          input_series: changingSuccesses,
          promql_expr_test: [
            expression(query(2), 2.35),
            expression(query(2, 1), 0.4875),
            expression(query(4), 1_000),
            expression(query(4, 1), 500),
          ],
        },
        // Old processes continue the historical view but cannot manufacture
        // success-only latency or samples, including during a rolling upgrade.
        {
          interval: "1m",
          input_series: legacy,
          promql_expr_test: [
            ...[query(2), query(3), query(4)].map((expr) => ({
              expr: render(expr),
              eval_time: "10m",
              exp_samples: [],
            })),
            expression(query(7), 0.00975),
          ],
        },
        {
          interval: "1m",
          input_series: [],
          promql_expr_test: targets.map(({ expr }) => ({
            expr: render(expr),
            eval_time: "10m",
            exp_samples: [],
          })),
        },
      ],
    };
    const directory = await mkdtemp(join(tmpdir(), "opengeni-api-latency-"));
    try {
      const file = join(directory, "test.yml");
      await writeFile(file, Bun.YAML.stringify(fixture));
      const result = spawnSync(promtool!, ["test", "rules", file], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
