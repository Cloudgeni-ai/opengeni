import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testTool } from "./queue-demand-tooling";

test("automation rules deduplicate API replicas and sum only this deployment's automation spend", async () => {
  const [helm, promtool] = await Promise.all([testTool("helm"), testTool("promtool")]);
  const rendered = execFileSync(
    helm,
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
  );
  type Group = {
    name: string;
    labels: Record<string, string>;
    rules: Array<{ record?: string; expr: string }>;
  };
  const manifest = Bun.YAML.parse(rendered) as { spec: { groups: Group[] } };
  const groups = manifest.spec.groups
    .map((group) => ({
      ...group,
      rules: group.rules.filter((rule) => rule.record?.startsWith("opengeni:automation_")),
    }))
    .filter((group) => group.rules.length);
  expect(groups.flatMap((group) => group.rules)).toHaveLength(3);
  const labels = 'environment="production",namespace="fixture",release="fixture"';
  const runSeries = (instance: string, release = "fixture") =>
    `opengeni_automation_runs_total{environment="production",namespace="fixture",release="${release}",outcome="ok",trigger_kind="event",instance="${instance}"}`;
  const costSeries = (instance: string, source: string, payer = "deployment") =>
    `opengeni_model_provider_cost_micros_total{${labels},source="${source}",payer="${payer}",instance="${instance}"}`;
  const directory = mkdtempSync(join(tmpdir(), "opengeni-automation-rules-"));
  try {
    writeFileSync(join(directory, "rules.yml"), Bun.YAML.stringify({ groups }));
    writeFileSync(
      join(directory, "test.yml"),
      Bun.YAML.stringify({
        rule_files: ["rules.yml"],
        evaluation_interval: "30s",
        fuzzy_compare: true,
        tests: [
          {
            interval: "30s",
            input_series: [
              { series: runSeries("api-a"), values: "0+1x150" },
              { series: runSeries("api-b"), values: "0+1x150" },
              { series: runSeries("api-other", "another"), values: "0+500x150" },
              { series: costSeries("worker-a", "schedule"), values: "0+1000x150" },
              { series: costSeries("worker-b", "schedule"), values: "0+2000x150" },
              { series: costSeries("worker-b", "web"), values: "0+5000x150" },
              { series: costSeries("worker-c", "schedule", "external"), values: "0+4000x150" },
            ],
            promql_expr_test: [
              {
                eval_time: "70m",
                expr: "opengeni:automation_runs:increase1h",
                exp_samples: [
                  {
                    labels: `opengeni:automation_runs:increase1h{${labels},outcome="ok",trigger_kind="event"}`,
                    value: 120,
                  },
                ],
              },
              {
                eval_time: "70m",
                expr: "opengeni:automation_provider_cost_usd:increase1h",
                exp_samples: [
                  {
                    labels: `opengeni:automation_provider_cost_usd:increase1h{${labels},payer="deployment"}`,
                    value: 0.36,
                  },
                  {
                    labels: `opengeni:automation_provider_cost_usd:increase1h{${labels},payer="external"}`,
                    value: 0.48,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const result = Bun.spawnSync([promtool, "test", "rules", "test.yml"], { cwd: directory });
    expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
