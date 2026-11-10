import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

test("expected tool waits and retained interactions do not page; failed and uncertain calls do", async () => {
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
  const rules = manifest.spec.groups.flatMap((group: any) => group.rules);
  expect(rules.some((rule: any) => rule.alert === "OpenGeniMcpToolLatencyHigh")).toBe(false);
  expect(rules.some((rule: any) => rule.alert === "OpenGeniSandboxesHeldByIdleInteractions")).toBe(
    false,
  );
  // Retain the inventory recording rules: operator diagnosis and cost review
  // do not require a warning notification or automatic session termination.
  expect(
    rules.some((rule: any) => rule.record === "opengeni:sandbox_leases_interaction_only:fresh_max"),
  ).toBe(true);
  const failure = rules.find((rule: any) => rule.alert === "OpenGeniMcpToolFailureRatio");
  const uncertain = rules.find((rule: any) => rule.alert === "OpenGeniMcpToolOutcomeUncertain");
  expect(failure).toBeDefined();
  expect(uncertain).toBeDefined();
  const scope = { namespace: "fixture", release: "fixture", environment: "production" };
  const scopeLabels = 'namespace="fixture",release="fixture",environment="production"';
  const cases = [
    { tool: "command_read", duration: 50 },
    { tool: "command_wait", duration: 45 },
    { tool: "run_on", duration: 1800 },
    { tool: "external", duration: 300 },
  ].map(({ tool, duration }) => {
    const labels = `${scopeLabels},tool="${tool}",outcome="success"`;
    return {
      name: `successful ${tool} taking ${duration}s is not an operator failure`,
      interval: "1m",
      input_series: [
        ...[
          0.01,
          0.05,
          0.1,
          0.25,
          0.5,
          1,
          2.5,
          5,
          10,
          30,
          60,
          120,
          300,
          900,
          1800,
          3600,
          "+Inf",
        ].map((le) => ({
          series: `opengeni_mcp_tool_call_duration_seconds_bucket{${labels},le="${le}"}`,
          values: le === "+Inf" || Number(le) >= duration ? "0+60x45" : "0+0x45",
        })),
        { series: `opengeni_mcp_tool_call_duration_seconds_count{${labels}}`, values: "0+60x45" },
        { series: `opengeni_mcp_tool_calls_total{${labels}}`, values: "0+60x45" },
        {
          series: `opengeni:sandbox_leases_interaction_only:fresh_max{${scopeLabels},idle_bucket="gte_6h"}`,
          values: "100x45",
        },
      ],
      promql_expr_test: [
        { expr: 'ALERTS{alertstate="firing"}', eval_time: "40m", exp_samples: [] },
      ],
    };
  });
  const faultCases = [
    { outcome: "timeout", failed: 15, success: 45, rule: failure, value: 0.25 },
    { outcome: "outcome_uncertain", failed: 1, success: 99, rule: uncertain, value: 5 },
  ].map(({ outcome, failed, success, rule, value }) => ({
    name: `actionable ${outcome} still alerts`,
    interval: "1m",
    input_series: [
      {
        series: `opengeni_mcp_tool_calls_total{${scopeLabels},outcome="${outcome}"}`,
        values: `0+${failed}x30`,
      },
      {
        series: `opengeni_mcp_tool_calls_total{${scopeLabels},outcome="success"}`,
        values: `0+${success}x30`,
      },
    ],
    alert_rule_test: [
      {
        eval_time: "20m",
        alertname: rule.alert,
        exp_alerts: [
          {
            exp_labels: { ...scope, ...rule.labels },
            exp_annotations: expandAlertAnnotations(rule.annotations, { value, labels: {} }),
          },
        ],
      },
    ],
  }));
  const directory = mkdtempSync(join(tmpdir(), "mcp-actionable-alert-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({
        groups: [
          {
            name: "fixture",
            labels: scope,
            rules: rules.filter(
              (rule: any) =>
                rule.alert &&
                (rule.alert.startsWith("OpenGeniMcp") ||
                  rule.alert.startsWith("OpenGeniSandboxDrain") ||
                  rule.expr.includes("opengeni:sandbox_leases_interaction_only:fresh_max")),
            ),
          },
        ],
      }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({
        rule_files: ["rules.yaml"],
        evaluation_interval: "30s",
        tests: [...cases, ...faultCases],
      }),
    );
    const result = Bun.spawnSync([promtool, "test", "rules", "tests.yaml"], { cwd: directory });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
