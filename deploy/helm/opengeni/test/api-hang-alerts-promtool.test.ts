import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandAlertAnnotations } from "./prometheus-alert-template";
import { testTool } from "./queue-demand-tooling";

// A hung API pod is often killed by its liveness probe before the hung
// requests complete, so neither the request-latency alerts nor
// OpenGeniServiceDown see it. These two alerts cover that gap: repeated
// event-loop blocks, and in-place container restarts outside the turn workers.

const scope = { namespace: "fixture", release: "fixture", environment: "production" };

async function renderedRules(set: string[] = []) {
  const [helm, promtool] = await Promise.all([testTool("helm"), testTool("promtool")]);
  const args = [
    "template",
    "fixture",
    resolve(import.meta.dir, ".."),
    "--namespace",
    "fixture",
    "--api-versions",
    "monitoring.coreos.com/v1",
    "--set",
    "observability.prometheusRule.enabled=true",
    ...set.flatMap((value) => ["--set", value]),
    "--show-only",
    "templates/prometheusrule.yaml",
  ];
  const manifest = Bun.YAML.parse(execFileSync(helm, args, { encoding: "utf8" })) as any;
  const rules = manifest.spec.groups.flatMap((group: any) => group.rules);
  const rule = (name: string) => {
    const found = rules.find((item: any) => item.alert === name);
    if (!found) throw new Error(`Missing alert ${name}`);
    return found;
  };
  return { promtool, rule };
}

function runPromtool(promtool: string, rules: any[], tests: any[]) {
  const directory = mkdtempSync(join(tmpdir(), "opengeni-api-hang-promtool-"));
  try {
    writeFileSync(
      join(directory, "rules.yaml"),
      Bun.YAML.stringify({ groups: [{ name: "fixture", interval: "30s", labels: scope, rules }] }),
    );
    writeFileSync(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({ rule_files: ["rules.yaml"], evaluation_interval: "30s", tests }),
    );
    for (const command of [
      ["check", "rules", "rules.yaml"],
      ["test", "rules", "tests.yaml"],
    ]) {
      const result = Bun.spawnSync([promtool, ...command], { cwd: directory });
      expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Scrapes every 30s: `blocks` maps scrape index to the worst delay in seconds. */
function lag(pod: string, blocks: Record<number, number>, steps = 80) {
  return {
    series: `opengeni_nodejs_eventloop_lag_max_seconds{namespace="fixture",release="fixture",environment="production",component="api",pod="${pod}"}`,
    values: Array.from({ length: steps }, (_, step) => blocks[step] ?? 0.1).join(" "),
  };
}

test("repeated multi-second API event-loop blocks page; one block or routine stalls do not", async () => {
  const { promtool, rule: find } = await renderedRules();
  const rule = find("OpenGeniApiEventLoopBlocked");
  expect(rule.expr).toContain("opengeni_nodejs_eventloop_lag_max_seconds");
  expect(rule.expr).toContain('component="api"');
  expect(rule.expr).toContain("> 5)[10m:30s]");
  expect(rule.expr).toContain(">= 2");
  const alertname = rule.alert;
  const at = (minutes: number) => `${minutes * 60}s`;
  const quiet = (minutes: number) => ({ eval_time: at(minutes), alertname, exp_alerts: [] });
  const firing = (minutes: number, pod: string, value: number) => ({
    eval_time: at(minutes),
    alertname,
    exp_alerts: [
      {
        exp_labels: { ...scope, ...rule.labels, pod },
        exp_annotations: expandAlertAnnotations(rule.annotations, { value, labels: { pod } }),
      },
    ],
  });
  runPromtool(
    promtool,
    [rule],
    [
      {
        // Blocks of 5-6.5s every couple of minutes on one pod, as before a
        // liveness restart: pages from the second block until ten minutes
        // after the last one.
        name: "a pod freezing repeatedly pages",
        interval: "30s",
        input_series: [lag("api-a", { 20: 6.2, 24: 5.8, 32: 6.4 }), lag("api-b", {})],
        alert_rule_test: [
          quiet(11),
          firing(12, "api-a", 2),
          firing(16.5, "api-a", 3),
          firing(21.5, "api-a", 2),
          quiet(26.5),
        ],
      },
      {
        name: "one long block does not page",
        interval: "30s",
        input_series: [lag("api-a", { 20: 9 })],
        alert_rule_test: [quiet(11), quiet(15), quiet(30)],
      },
      {
        name: "routine 3-4 second stalls do not page",
        interval: "30s",
        input_series: [lag("api-a", { 10: 3.6, 12: 4.2, 14: 3.9, 16: 4.1, 18: 3.3 })],
        alert_rule_test: [quiet(8), quiet(10), quiet(15)],
      },
      {
        name: "blocks further apart than ten minutes do not page",
        interval: "30s",
        input_series: [lag("api-a", { 10: 6, 32: 6 })],
        alert_rule_test: [quiet(16), quiet(17), quiet(30)],
      },
      {
        name: "single blocks on different pods do not page",
        interval: "30s",
        input_series: [lag("api-a", { 20: 6 }), lag("api-b", { 22: 6 })],
        alert_rule_test: [quiet(11.5), quiet(15)],
      },
    ],
  );
});

test("the event-loop thresholds follow chart values", async () => {
  const { rule: find } = await renderedRules([
    "observability.prometheusRule.apiEventLoopBlockedSeconds=2.5",
    "observability.prometheusRule.apiEventLoopBlockedMinBlocks=3",
    "observability.serviceMonitor.interval=15s",
  ]);
  const rule = find("OpenGeniApiEventLoopBlocked");
  expect(rule.expr).toContain("> 2.5)[10m:15s]");
  expect(rule.expr).toContain(">= 3");
  expect(rule.annotations.summary).toContain("more than 2.5 seconds at least 3 times");
});

function restarts(pod: string, container: string, values: string) {
  return {
    series: `kube_pod_container_status_restarts_total{namespace="fixture",pod="${pod}",container="${container}"}`,
    values,
  };
}
function releasePod(name: string, component: string, ownerKind = "ReplicaSet", instance = "fixture") {
  return [
    {
      series: `kube_pod_labels{namespace="fixture",pod="${name}",label_app_kubernetes_io_instance="${instance}",label_app_kubernetes_io_component="${component}"}`,
      values: "1x60",
    },
    {
      series: `kube_pod_owner{namespace="fixture",pod="${name}",owner_kind="${ownerKind}",owner_name="${name}-owner"}`,
      values: "1x60",
    },
  ];
}

test("an in-place restart of a release service pages, outside turn workers and Jobs", async () => {
  const { promtool, rule: find } = await renderedRules();
  const rule = find("OpenGeniServiceRestarted");
  const alertname = rule.alert;
  const restartAt20 = "0x20 1x40";
  const firing = (podName: string, container: string) => ({
    eval_time: "12m",
    alertname,
    exp_alerts: [
      {
        exp_labels: { ...scope, ...rule.labels, pod: podName, container },
        exp_annotations: expandAlertAnnotations(rule.annotations, {
          value: 1,
          labels: { pod: podName, container },
        }),
      },
    ],
  });
  const quiet = (evalTime: string) => ({ eval_time: evalTime, alertname, exp_alerts: [] });
  runPromtool(
    promtool,
    [rule],
    [
      {
        name: "an API liveness restart pages, then clears",
        interval: "30s",
        input_series: [...releasePod("api-a", "api"), restarts("api-a", "api", restartAt20)],
        alert_rule_test: [quiet("9m"), firing("api-a", "api"), quiet("25m")],
      },
      {
        name: "turn workers, Jobs, other releases and steady pods do not page here",
        interval: "30s",
        input_series: [
          ...releasePod("turns-a", "worker-turns"),
          restarts("turns-a", "worker", restartAt20),
          ...releasePod("migrate-a", "migrate", "Job"),
          restarts("migrate-a", "migrate", restartAt20),
          ...releasePod("other-api", "api", "ReplicaSet", "other"),
          restarts("other-api", "api", restartAt20),
          ...releasePod("web-a", "web"),
          restarts("web-a", "web", "3x60"),
        ],
        alert_rule_test: [quiet("12m"), quiet("20m")],
      },
    ],
  );
});
