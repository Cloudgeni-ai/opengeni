import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Meetings and transcription dashboard", () => {
  test("scopes every Opengeni panel to one exact namespace, environment, and release", async () => {
    const dashboard = await loadDashboard();
    const expressions = collectExpressions(dashboard).filter((expression) =>
      expression.includes("opengeni_"),
    );
    expect(expressions.length).toBeGreaterThan(20);
    for (const expression of expressions) {
      for (const selector of expression.match(/opengeni_[a-z_]+\{[^}]*\}/gu) ?? []) {
        expect(selector).toContain('namespace="$namespace"');
        expect(selector).toContain('environment="$environment"');
        expect(selector).toContain('release="$release"');
      }
      // Every metric is selected with the scope, never bare (grouping labels aside).
      expect(expression.replace(/\b(?:by|without|ignoring|on)\s*\([^)]*\)/gu, "")).not.toMatch(
        /opengeni_[a-z_]+(?![a-z_{])/u,
      );
      expect(expression).not.toContain('=~"$');
    }
    const variables = dashboard.templating.list.filter((variable: { name?: string }) =>
      ["namespace", "environment", "release"].includes(variable.name ?? ""),
    );
    expect(variables.map((variable: { name: string }) => variable.name)).toEqual([
      "namespace",
      "environment",
      "release",
    ]);
    for (const variable of variables) {
      expect(variable.includeAll).toBe(false);
      expect(variable.multi).toBe(false);
      expect(variable.current).toEqual({});
    }
  });

  test("prices compute and storage from editable cloud rates", async () => {
    const dashboard = await loadDashboard();
    const prices = dashboard.templating.list.filter(
      (variable: { type?: string }) => variable.type === "textbox",
    );
    expect(prices.map((variable: { name: string }) => variable.name)).toEqual([
      "cpu_hour_usd",
      "memory_gb_hour_usd",
      "storage_gb_month_usd",
    ]);
    for (const price of prices) expect(Number(price.query)).toBeGreaterThan(0);
    const expressions = collectExpressions(dashboard).join("\n");
    for (const name of ["$cpu_hour_usd", "$memory_gb_hour_usd", "$storage_gb_month_usd"]) {
      expect(expressions).toContain(name);
    }
  });

  test("charts only metrics Opengeni emits", async () => {
    const dashboard = await loadDashboard();
    const used = new Set(
      collectExpressions(dashboard)
        .flatMap((expression) => expression.match(/opengeni_recording_[a-z_]+/gu) ?? [])
        .map((name) => name.replace(/_bucket$/u, "")),
    );
    const sources = (
      await Promise.all(
        [
          "../../../apps/worker/src/activities/recording-usage.ts",
          "../../../apps/api/src/routes/recordings.ts",
        ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
      )
    ).join("\n");
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(sources).toContain(`"${name}"`);
  });

  const promtool = process.env.OPENGENI_TEST_PROMTOOL ?? Bun.which("promtool");
  test.skipIf(!promtool)("Prometheus evaluates every panel and prices an audio hour", async () => {
    const dashboard = await loadDashboard();
    const render = (expr: string) =>
      expr
        .replaceAll("$namespace", "apps")
        .replaceAll("$environment", "staging")
        .replaceAll("$release", "opengeni")
        .replaceAll("$__rate_interval", "5m")
        .replaceAll("$__range", "5m")
        .replaceAll("$cpu_hour_usd", "0.0316")
        .replaceAll("$memory_gb_hour_usd", "0.0042")
        .replaceAll("$storage_gb_month_usd", "0.02");
    const scope = 'namespace="apps",environment="staging",release="opengeni"';
    const path = 'purpose="meeting",provider="scribe",model="v2",funding="workspace_key"';
    const panel = (title: string) =>
      (dashboard.panels as Array<{ title: string; targets?: Array<{ expr: string }> }>).find(
        (item) => item.title === title,
      )!.targets![0]!.expr;
    const fixture = {
      rule_files: [],
      evaluation_interval: "1m",
      tests: [
        {
          interval: "1m",
          input_series: [
            // An hour of meeting audio a minute, using 36 CPU-seconds and
            // holding 1 GiB for 60 seconds of it.
            {
              series: `opengeni_recording_audio_seconds_total{${scope},${path}}`,
              values: "0+3600x10",
            },
            {
              series: `opengeni_recording_stage_cpu_seconds_total{${scope},${path},stage="diarize"}`,
              values: "0+36x10",
            },
            {
              series: `opengeni_recording_stage_memory_byte_seconds_total{${scope},${path},stage="diarize"}`,
              values: `0+${60 * 1024 * 1024 * 1024}x10`,
            },
            {
              series: `opengeni_recording_provider_cost_usd_total{${scope},${path}}`,
              values: "0+1x10",
            },
          ],
          promql_expr_test: [
            {
              expr: render(panel("Our compute cost per meeting hour")),
              eval_time: "10m",
              exp_samples: [{ labels: "{}", value: (36 / 3600) * 0.0316 + (60 / 3600) * 0.0042 }],
            },
            {
              expr: render(panel("Provider cost per meeting hour")),
              eval_time: "10m",
              exp_samples: [{ labels: "{}", value: 1 }],
            },
          ],
        },
        {
          interval: "1m",
          input_series: [],
          promql_expr_test: collectExpressions(dashboard).map((expr) => ({
            expr: render(expr),
            eval_time: "10m",
            exp_samples: [],
          })),
        },
      ],
    };
    const directory = await mkdtemp(join(tmpdir(), "opengeni-meetings-dashboard-"));
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
  });
});

async function loadDashboard(): Promise<any> {
  return JSON.parse(
    await readFile(new URL("./meetings-transcription.json", import.meta.url), "utf8"),
  );
}

function collectExpressions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectExpressions);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.expr === "string" ? [record.expr] : []),
    ...Object.values(record).flatMap(collectExpressions),
  ];
}
