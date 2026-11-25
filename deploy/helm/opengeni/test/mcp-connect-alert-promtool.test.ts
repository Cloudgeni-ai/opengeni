import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

// Every turn connects each of its accounts again, so one account whose sign-in
// Opengeni already refused (outcome auth_needed) fails on every turn. The person
// already sees it needs a reconnect; it must not page operators or dilute the
// ratio of real connection failures.
test("connects refused for a known-broken sign-in never page; real connect failures still do", async () => {
  const [helm, promtool] = await Promise.all([testTool("helm"), testTool("promtool")]);
  const manifest = Bun.YAML.parse(
    execFileSync(
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
    ),
  ) as any;
  const rules = manifest.spec.groups
    .flatMap((group: any) => group.rules)
    .filter((rule: any) =>
      ["OpenGeniMcpBestEffortConnectFailureRatio", "OpenGeniMcpStrictConnectFailed"].includes(
        rule.alert,
      ),
    );
  expect(rules).toHaveLength(2);
  const ratio = rules.find(
    (rule: any) => rule.alert === "OpenGeniMcpBestEffortConnectFailureRatio",
  );
  const strict = rules.find((rule: any) => rule.alert === "OpenGeniMcpStrictConnectFailed");
  const scope = { namespace: "fixture", release: "fixture", environment: "production" };
  const scopeLabels = 'namespace="fixture",release="fixture",environment="production"';
  const connects = (policy: string, perMinute: Record<string, number>) =>
    Object.entries(perMinute).map(([outcome, count]) => ({
      series: `opengeni_mcp_lifecycle_operations_total{${scopeLabels},phase="connect",policy="${policy}",outcome="${outcome}"}`,
      values: `0+${count}x30`,
    }));
  const quiet = (name: string, perMinute: Record<string, number>) => ({
    name,
    interval: "1m",
    input_series: connects("best_effort", perMinute),
    promql_expr_test: [{ expr: 'ALERTS{alertstate="firing"}', eval_time: "20m", exp_samples: [] }],
  });
  const tests = [
    // Two accounts refused a credential and one unreachable server out of 13
    // connects per minute: 23% when refusals counted as failures, 9% now.
    quiet("known-broken sign-ins do not page", { completed: 10, auth_needed: 2, failed: 1 }),
    quiet("only known-broken sign-ins do not page", { auth_needed: 5 }),
    {
      name: "real failures still page beside known-broken sign-ins, without dilution",
      interval: "1m",
      input_series: connects("best_effort", { completed: 10, failed: 4, auth_needed: 20 }),
      alert_rule_test: [
        {
          eval_time: "20m",
          alertname: ratio.alert,
          exp_alerts: [
            {
              exp_labels: { ...scope, ...ratio.labels },
              exp_annotations: expandAlertAnnotations(ratio.annotations, {
                value: 4 / 14,
                labels: {},
              }),
            },
          ],
        },
      ],
    },
    {
      name: "a required server refused a credential still pages",
      interval: "1m",
      input_series: connects("strict", { completed: 10, auth_needed: 1 }),
      alert_rule_test: [
        {
          eval_time: "20m",
          alertname: strict.alert,
          exp_alerts: [
            {
              exp_labels: { ...scope, ...strict.labels },
              exp_annotations: expandAlertAnnotations(strict.annotations, {
                value: 5,
                labels: {},
              }),
            },
          ],
        },
      ],
    },
  ];
  const directory = mkdtempSync(join(tmpdir(), "mcp-connect-alert-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", labels: scope, rules }] }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({ rule_files: ["rules.yaml"], evaluation_interval: "30s", tests }),
    );
    const result = Bun.spawnSync([promtool, "test", "rules", "tests.yaml"], { cwd: directory });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
