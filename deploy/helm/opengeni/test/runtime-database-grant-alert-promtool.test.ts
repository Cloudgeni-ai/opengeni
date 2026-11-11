import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

test("rendered missing runtime grant alert fires only on a persisting degraded posture", async () => {
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
    .find((item: any) => item.alert === "OpenGeniRuntimeDatabaseGrantMissing");
  expect(rule).toBeDefined();
  const scope = { namespace: "fixture", release: "fixture", environment: "production" };
  const series = (component: string, pod: string, environment = "production") =>
    `opengeni_runtime_database_degraded_findings{namespace="fixture",release="fixture",environment="${environment}",component="${component}",pod="${pod}"}`;
  const tests = [
    {
      name: "one pod of a component reports a missing grant for longer than the hold",
      input: [
        { series: series("api", "api-a"), values: "0x5 2x30" },
        { series: series("api", "api-b"), values: "0x35" },
        { series: series("worker-turns", "turns-a"), values: "0x35" },
      ],
      expected: [{ labels: { ...scope, component: "api", ...rule.labels }, value: 2 }],
    },
    {
      name: "a degraded posture younger than the hold does not fire yet",
      input: [{ series: series("api", "api-a"), values: "0x25 1x10" }],
      expected: [],
    },
    {
      name: "another environment does not fire",
      input: [{ series: series("api", "api-a", "staging"), values: "1x35" }],
      expected: [],
    },
  ].map(({ name, input, expected }) => ({
    name,
    interval: "1m",
    input_series: input,
    alert_rule_test: [
      {
        eval_time: "30m",
        alertname: rule.alert,
        exp_alerts: expected.map(({ labels, value }) => ({
          exp_labels: labels,
          exp_annotations: expandAlertAnnotations(rule.annotations, { value }),
        })),
      },
    ],
  }));
  const directory = mkdtempSync(join(tmpdir(), "runtime-grant-alert-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", labels: scope, rules: [rule] }] }),
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
