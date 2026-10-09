import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

test("rendered MCP latency alert allows bounded polling and still detects slow tools", async () => {
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
  const rule = manifest.spec.groups
    .flatMap((group: any) => group.rules)
    .find((item: any) => item.alert === "OpenGeniMcpToolLatencyHigh");
  const scope = { namespace: "fixture", release: "fixture", environment: "production" };
  const cases = [
    { tool: "command_read", duration: 50 },
    { tool: "command_wait", duration: 45 },
    { tool: "command_read", duration: 90, value: 117 },
    { tool: "command_wait", duration: 90, value: 117 },
    { tool: "session_create", duration: 20, value: 29 },
    { tool: "external", duration: 20, value: 29 },
    { tool: "external", duration: 3 },
    { tool: "command_read", duration: 90, lowVolume: true },
  ].map(({ tool, duration, value, lowVolume }) => {
    const labels = `namespace="fixture",release="fixture",environment="production",tool="${tool}",outcome="success"`;
    const values = lowVolume ? "0+0.1x30" : "0+60x30";
    return {
      name: `${tool} ${duration}s ${lowVolume ? "low volume" : "ordinary volume"}`,
      interval: "1m",
      input_series: [
        // Match durationHistogramBuckets in packages/observability/src/index.ts.
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
          values: le === "+Inf" || Number(le) >= duration ? values : "0+0x30",
        })),
        { series: `opengeni_mcp_tool_call_duration_seconds_count{${labels}}`, values },
      ],
      alert_rule_test: [
        {
          eval_time: "20m",
          alertname: rule.alert,
          exp_alerts:
            value === undefined
              ? []
              : [
                  {
                    exp_labels: { ...scope, ...rule.labels, tool },
                    exp_annotations: expandAlertAnnotations(rule.annotations, {
                      value,
                      labels: { tool },
                    }),
                  },
                ],
        },
      ],
    };
  });
  const directory = mkdtempSync(join(tmpdir(), "mcp-poll-alert-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({
        groups: [{ name: "fixture", labels: scope, rules: [rule] }],
      }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({
        rule_files: ["rules.yaml"],
        evaluation_interval: "30s",
        tests: cases,
      }),
    );
    const result = Bun.spawnSync([promtool, "test", "rules", "tests.yaml"], { cwd: directory });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
