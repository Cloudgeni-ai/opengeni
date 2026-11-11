import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

const scope = { namespace: "fixture", release: "fixture", environment: "production" };
const crash = "OpenGeniTurnWorkerCrashLoop";
const loss = "OpenGeniModalProviderMissingBeforeCapture";
type Input = { series: string; values: string };

test("rendered alerts distinguish repeated crashes and overlapping loss evidence", async () => {
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
        "--set-string",
        "config.OPENGENI_SANDBOX_BACKEND=modal",
        "--show-only",
        "templates/prometheusrule.yaml",
      ],
      { encoding: "utf8" },
    ),
  ) as any;
  const all = manifest.spec.groups.flatMap((group: any) => group.rules);
  const rules = all.filter((rule: any) => [crash, loss].includes(rule.alert));
  expect(
    all.find((rule: any) => rule.alert === "OpenGeniNodeContainerRuntimeErrors").labels.severity,
  ).toBe("warning");
  const byName = new Map<string, any>(rules.map((rule: any) => [rule.alert, rule]));
  const worker = (pod: string, values: string, instance = "ksm-a"): Input[] => [
    {
      series: `kube_pod_container_status_restarts_total{namespace="fixture",pod="${pod}",container="worker",instance="${instance}"}`,
      values,
    },
    {
      series: `kube_pod_labels{namespace="fixture",pod="${pod}",label_app_kubernetes_io_instance="fixture",label_app_kubernetes_io_component="worker-turns",instance="${instance}"}`,
      values: "1+0x30",
    },
  ];
  const counter = (values: string): Input => ({
    series:
      'opengeni_sandbox_provider_missing_before_capture_total{namespace="fixture",release="fixture",environment="production",backend="modal",instance="worker-a"}',
    values,
  });
  const durable = (values: string): Input => ({
    series:
      'opengeni:sandbox_recovery_observations_recent:fresh_max{namespace="fixture",release="fixture",environment="production",kind="provider_missing_before_capture"}',
    values,
  });
  const cases: any[] = [];
  function scenario(
    name: string,
    inputs: Input[],
    firing?: { alert: string; value: number; pod?: string },
  ) {
    cases.push({
      name,
      interval: "30s",
      input_series: inputs,
      alert_rule_test: [crash, loss].map((alertname) => ({
        eval_time: "8m",
        alertname,
        exp_alerts:
          firing?.alert === alertname
            ? [
                {
                  exp_labels: {
                    ...scope,
                    ...byName.get(alertname).labels,
                    ...(firing.pod ? { pod: firing.pod } : {}),
                  },
                  exp_annotations: expandAlertAnnotations(byName.get(alertname).annotations, {
                    value: firing.value,
                    labels: firing.pod ? { pod: firing.pod } : {},
                  }),
                },
              ]
            : [],
      })),
      ...(firing?.alert === loss
        ? {
            promql_expr_test: [
              {
                expr: byName.get(loss).expr,
                eval_time: "8m",
                exp_samples: [{ labels: "{}", value: firing.value }],
              },
            ],
          }
        : {}),
    });
  }
  scenario(
    "one observed restart does not become a crash loop through extrapolation",
    worker("worker-a", "0+0x5 1+0x25"),
  );
  scenario("isolated restarts across pods are not a per-pod crash loop", [
    ...worker("worker-a", "0+0x5 1+0x25"),
    ...worker("worker-b", "0+0x5 1+0x25"),
  ]);
  scenario(
    "two observed restarts on one pod remain critical",
    worker("worker-a", "0+0x3 1+0x3 2+0x23"),
    { alert: crash, value: 2, pod: "worker-a" },
  );
  scenario("duplicate kube-state-metrics replicas do not double restart counts", [
    ...worker("worker-a", "0+0x5 1+0x25"),
    ...worker("worker-a", "0+0x5 1+0x25", "ksm-b"),
  ]);
  scenario("a restart counter reset is not a crash", worker("worker-a", "5+0x5 0+0x25"));
  scenario(
    "two crashes after a counter reset remain critical",
    worker("worker-a", "5+0x3 0+0x3 2+0x23"),
    { alert: crash, value: 2, pod: "worker-a" },
  );
  scenario(
    "one loss observed in both sources counts once",
    [counter("1+0x30"), durable("1+0x30")],
    { alert: loss, value: 1 },
  );
  scenario("durable count survives worker counter disappearance", [durable("2+0x30")], {
    alert: loss,
    value: 2,
  });
  scenario(
    "first counter sample still detects loss before durable observation",
    [counter("1+0x30"), durable("0+0x30")],
    { alert: loss, value: 1 },
  );
  scenario("counter fallback works when durable monitor is unavailable", [counter("1+0x30")], {
    alert: loss,
    value: 1,
  });
  scenario("zero or absent observations do not fire", [counter("0+0x30"), durable("0+0x30")]);
  scenario("no telemetry does not fabricate a loss", []);
  const directory = mkdtempSync(join(tmpdir(), "alert-accuracy-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", labels: scope, rules }] }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({
        rule_files: ["rules.yaml"],
        evaluation_interval: "30s",
        tests: cases,
      }),
    );
    const result = Bun.spawnSync([promtool!, "test", "rules", "tests.yaml"], { cwd: directory });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
