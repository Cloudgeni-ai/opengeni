import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

test("rendered drain snapshot alert fires on a fourth failure in a row on Prometheus 2 and 3", async () => {
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
    .find((item: any) => item.alert === "OpenGeniSandboxDrainSnapshotFailing");
  expect(rule).toBeDefined();
  const scope = { namespace: "fixture", release: "fixture", environment: "production" };
  const labels = `namespace="fixture",release="fixture",environment="production",backend="modal"`;
  // Prometheus 3 stores the "3" bucket as le="3.0"; Prometheus 2 keeps le="3".
  const cases = ["3.0", "3"].flatMap((le) => [
    {
      name: `fourth failure in a row (le="${le}")`,
      fourth: true,
      le,
    },
    {
      name: `only first to third failures (le="${le}")`,
      fourth: false,
      le,
    },
  ]);
  const tests = cases.map(({ name, fourth, le }) => ({
    name,
    interval: "1m",
    input_series: [
      {
        series: `opengeni_sandbox_drain_capture_consecutive_failures_count{${labels}}`,
        values: "0x10 1x50",
      },
      {
        series: `opengeni_sandbox_drain_capture_consecutive_failures_bucket{${labels},le="${le}"}`,
        values: fourth ? "0x60" : "0x10 1x50",
      },
    ],
    alert_rule_test: [
      {
        eval_time: "40m",
        alertname: rule.alert,
        exp_alerts: fourth
          ? [
              {
                exp_labels: { ...scope, ...rule.labels },
                exp_annotations: expandAlertAnnotations(rule.annotations, { value: 1 }),
              },
            ]
          : [],
      },
    ],
  }));
  const directory = mkdtempSync(join(tmpdir(), "drain-snapshot-alert-"));
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
