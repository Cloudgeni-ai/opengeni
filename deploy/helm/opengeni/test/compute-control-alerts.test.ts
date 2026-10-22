import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  computeMetricNames,
  selectedMetrics,
} from "../../../observability/dashboards/compute-metrics";
import { expandAlertAnnotations, expandAlertTemplate } from "./prometheus-alert-template";
import { run, testTool } from "./queue-demand-tooling";

// Opengeni compute's alerts: the control service's, from the replicas the
// ServiceMonitor scrapes, and its hosts', from the metrics the service passes
// on to Prometheus. A host's series carry no release labels; each host alert
// is scoped by the release's leader listing the host in
// compute_fleet_host_info.

type Rule = {
  alert?: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};
type Group = { name: string; labels: Record<string, string>; rules: Rule[] };

const tools = Promise.all([testTool("helm"), testTool("promtool", "3.5.0")]);

const enabled = [
  "postgres.enabled=true",
  "computeControl.enabled=true",
  "computeControl.image.tag=sha-0123456789abcdef0123456789abcdef01234567",
  "computeControl.database.existingSecret=compute-db",
  "computeControl.keys.existingSecret=compute-keys",
  "computeControl.hostsTls.secretName=compute-hosts-tls",
  "computeControl.hostUrl=https://compute-control.example.com:8443",
  "computeControl.archive=gs://example-archive/archive",
  "computeControl.metrics.port=9464",
  "observability.serviceMonitor.enabled=true",
  "observability.prometheusRule.enabled=true",
];
const hostsTo = "computeControl.metrics.hostsTo=http://prometheus:9090/api/v1/otlp/v1/metrics";

async function render(sets: string[]): Promise<Group[]> {
  const [helm] = await tools;
  const result = await run([
    helm,
    "template",
    "fixture",
    resolve(import.meta.dir, ".."),
    "--namespace",
    "fixture",
    "--api-versions",
    "monitoring.coreos.com/v1",
    ...sets.flatMap((set) => ["--set", set]),
    "--show-only",
    "templates/compute-control-prometheusrule.yaml",
  ]);
  if (result.code !== 0) {
    if (result.stderr.includes("could not find template")) return [];
    throw new Error(result.stderr);
  }
  const manifest = Bun.YAML.parse(result.stdout) as { spec: { groups: Group[] } } | null;
  return manifest?.spec.groups ?? [];
}

function alerts(groups: Group[]): Map<string, Rule> {
  return new Map(
    groups
      .flatMap((group) => group.rules)
      .flatMap((rule) => (rule.alert ? [[rule.alert, rule]] : [])),
  );
}

const scope = { namespace: "fixture", release: "fixture", environment: "production" };
const own = 'namespace="fixture",release="fixture"';
const other = 'namespace="fixture",release="other"';

type Case = {
  name: string;
  series: { series: string; values: string }[];
  alert: string;
  at: string;
  fires: { labels?: Record<string, string>; value?: number }[];
};

async function evaluate(groups: Group[], cases: Case[]) {
  const [, promtool] = await tools;
  const rules = alerts(groups);
  const directory = await mkdtemp(join(tmpdir(), "compute-control-alerts-"));
  try {
    await writeFile(join(directory, "rules.yaml"), Bun.YAML.stringify({ groups }));
    await writeFile(
      join(directory, "tests.yaml"),
      Bun.YAML.stringify({
        rule_files: ["rules.yaml"],
        evaluation_interval: "30s",
        tests: cases.map((item) => {
          const rule = rules.get(item.alert);
          if (!rule) throw new Error(`no alert ${item.alert}`);
          return {
            name: item.name,
            interval: "30s",
            input_series: item.series,
            alert_rule_test: [
              {
                eval_time: item.at,
                alertname: item.alert,
                exp_alerts: item.fires.map(({ labels = {}, value = 0 }) => ({
                  exp_labels: { ...scope, ...rule.labels, ...labels },
                  exp_annotations: expandAlertAnnotations(rule.annotations ?? {}, {
                    value,
                    labels,
                  }),
                })),
              },
            ],
          };
        }),
      }),
    );
    const checked = await run([promtool, "check", "rules", "rules.yaml"], directory);
    expect(checked.code, checked.stdout + checked.stderr).toBe(0);
    const tested = await run([promtool, "test", "rules", "tests.yaml"], directory);
    expect(tested.code, tested.stdout + tested.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A host this release's leader lists, and one only another release does. */
const fleet = [
  { series: `compute_fleet_host_info{${own},host_name="h1",state="live"}`, values: "1x60" },
  { series: `compute_fleet_host_info{${other},host_name="h2",state="live"}`, values: "1x60" },
];

describe("compute alerts", () => {
  test("need the control service's metrics, ServiceMonitor and rules", async () => {
    expect(
      await render(enabled.filter((set) => !set.startsWith("observability.serviceMonitor"))),
    ).toEqual([]);
    expect(
      await render(enabled.filter((set) => !set.startsWith("computeControl.metrics.port"))),
    ).toEqual([]);
    expect(
      await render(enabled.filter((set) => !set.startsWith("observability.prometheusRule"))),
    ).toEqual([]);
  }, 180_000);

  test("host alerts need the hosts' metrics", async () => {
    const without = [...alerts(await render(enabled)).keys()];
    const all = [...alerts(await render([...enabled, hostsTo])).keys()];
    expect(without).toContain("OpenGeniComputeControlDown");
    expect(without).not.toContain("OpenGeniComputeHostAlarm");
    expect(all).toContain("OpenGeniComputeHostAlarm");
    expect(all.length).toBeGreaterThan(without.length);
  }, 60_000);

  test("query only metrics compute emits", async () => {
    const emitted = computeMetricNames();
    for (const [name, rule] of alerts(await render([...enabled, hostsTo]))) {
      for (const metric of selectedMetrics(rule.expr)) {
        if (metric === "up") continue;
        expect(emitted.has(metric), `${name}: ${metric}`).toBe(true);
      }
    }
  }, 60_000);

  test("every alert carries plain-language notification copy", async () => {
    const required = ["summary", "headline", "user_impact", "next_step"];
    const allowed = new Set([...required, "value", "description", "action", "runbook_url"]);
    for (const [name, rule] of alerts(await render([...enabled, hostsTo]))) {
      const annotations = rule.annotations ?? {};
      for (const key of required) expect(annotations[key]?.trim(), `${name} ${key}`).toBeTruthy();
      for (const key of Object.keys(annotations))
        expect(allowed.has(key), `${name} ${key}`).toBe(true);
      const sample = {
        value: 0.5,
        labels: { host_name: "compute-host-abcd", compute_alarm: "copy_lost" },
      };
      const headline = expandAlertTemplate(annotations.headline!, sample);
      expect(headline.length, `${name} headline`).toBeLessThanOrEqual(70);
      expect(headline).not.toMatch(/^Open[Gg]eni\b/);
      for (const [key, text] of Object.entries(annotations)) {
        expect(text, `${name}.${key}`).not.toMatch(/\bOpenGeni\b/);
        expect(() => expandAlertTemplate(text, sample), `${name}.${key}`).not.toThrow();
      }
      if (rule.expr.trim().startsWith("absent(")) expect(annotations.value).toBeUndefined();
      if (rule.labels?.severity === "critical") {
        expect(annotations.runbook_url, `${name} runbook`).toMatch(
          /^https:\/\/github\.com\/Cloudgeni-ai\/opengeni\/blob\/main\/compute\/docs\/operations\.md#[a-z0-9-]+$/,
        );
      }
    }
  }, 60_000);

  test("fire on what they describe, for this release's hosts only", async () => {
    const groups = await render([...enabled, hostsTo]);
    await evaluate(groups, [
      {
        name: "control down",
        series: [
          {
            series: `up{${own},opengeni_workload_component="compute-control",pod="a"}`,
            values: "0x20",
          },
          {
            series: `up{${other},opengeni_workload_component="compute-control",pod="b"}`,
            values: "1x20",
          },
        ],
        alert: "OpenGeniComputeControlDown",
        at: "6m",
        fires: [{}],
      },
      {
        name: "control up",
        series: [
          {
            series: `up{${own},opengeni_workload_component="compute-control",pod="a"}`,
            values: "0x20",
          },
          {
            series: `up{${own},opengeni_workload_component="compute-control",pod="b"}`,
            values: "1x20",
          },
        ],
        alert: "OpenGeniComputeControlDown",
        at: "6m",
        fires: [],
      },
      {
        name: "no replica leads",
        series: [
          { series: `compute_control_leader{${own},pod="a"}`, values: "0x20" },
          { series: `compute_control_leader{${own},pod="b"}`, values: "0x20" },
        ],
        alert: "OpenGeniComputeNoLeader",
        at: "6m",
        fires: [{}],
      },
      {
        name: "a host lost",
        series: [
          {
            series: `compute_control_hosts_given_up_total{${own},pod="a",cause="lost"}`,
            values: "0x5 1x20",
          },
          {
            series: `compute_control_hosts_given_up_total{${own},pod="a",cause="removed"}`,
            values: "0x20",
          },
        ],
        alert: "OpenGeniComputeHostGivenUp",
        at: "5m",
        fires: [{ value: 1 }],
      },
      {
        name: "a drained host removed as planned",
        series: [
          {
            series: `compute_control_hosts_given_up_total{${own},pod="a",cause="lost"}`,
            values: "0x20",
          },
          {
            series: `compute_control_hosts_given_up_total{${own},pod="a",cause="removed"}`,
            values: "0x5 1x20",
          },
        ],
        alert: "OpenGeniComputeHostGivenUp",
        at: "5m",
        fires: [],
      },
      {
        name: "an alarm on this release's host",
        series: [
          ...fleet,
          {
            series: `compute_alarm_count_total{job="compute-host",instance="h1",host_name="h1",compute_alarm="copy_lost"}`,
            values: "0x10 1x20",
          },
          {
            series: `compute_alarm_count_total{job="compute-host",instance="h2",host_name="h2",compute_alarm="copy_lost"}`,
            values: "0x10 1x20",
          },
        ],
        alert: "OpenGeniComputeHostAlarm",
        at: "7m",
        fires: [{ labels: { host_name: "h1", compute_alarm: "copy_lost" }, value: 1 }],
      },
      {
        name: "a live host without metrics",
        series: [
          ...fleet,
          { series: `compute_fleet_host_info{${own},host_name="h3",state="live"}`, values: "1x60" },
          {
            series: `compute_fleet_host_info{${own},host_name="h4",state="draining"}`,
            values: "1x60",
          },
          {
            series: `compute_sample_age_seconds{job="compute-host",host_name="h1"}`,
            values: "1x60",
          },
        ],
        alert: "OpenGeniComputeHostMetricsMissing",
        at: "20m",
        fires: [{ labels: { host_name: "h3" }, value: 1 }],
      },
      {
        name: "a stuck agent",
        series: [
          ...fleet,
          {
            series: `compute_sample_age_seconds{job="compute-host",host_name="h1"}`,
            values: "0+30x30",
          },
          {
            series: `compute_sample_age_seconds{job="compute-host",host_name="h2"}`,
            values: "0+30x30",
          },
        ],
        alert: "OpenGeniComputeHostAgentStuck",
        at: "10m",
        fires: [{ labels: { host_name: "h1" }, value: 600 }],
      },
      {
        name: "memory pressure",
        series: [
          ...fleet,
          {
            // 300 ms of every second stalled.
            series: `compute_host_pressure_stall_microseconds_total{job="compute-host",host_name="h1",compute_resource="memory",compute_pressure="full"}`,
            values: "0+9000000x60",
          },
          {
            series: `compute_host_pressure_stall_microseconds_total{job="compute-host",host_name="h1",compute_resource="memory",compute_pressure="some"}`,
            values: "0+29000000x60",
          },
        ],
        alert: "OpenGeniComputeHostMemoryPressure",
        at: "20m",
        fires: [{ labels: { host_name: "h1" }, value: 0.3 }],
      },
      {
        name: "API failures with enough requests",
        series: [
          {
            series: `compute_control_requests_total{${own},pod="a",method="POST",route="/v1/sandboxes",outcome="ok"}`,
            values: "0+9x60",
          },
          {
            series: `compute_control_requests_total{${own},pod="a",method="POST",route="/v1/sandboxes",outcome="host"}`,
            values: "0+1x60",
          },
        ],
        alert: "OpenGeniComputeApiErrors",
        at: "25m",
        fires: [{ value: 0.1 }],
      },
      {
        name: "too few requests to call",
        series: [
          {
            series: `compute_control_requests_total{${own},pod="a",method="POST",route="/v1/sandboxes",outcome="host"}`,
            values: "0+0.02x60",
          },
        ],
        alert: "OpenGeniComputeApiErrors",
        at: "25m",
        fires: [],
      },
      {
        name: "renewals late",
        series: [
          {
            series: `compute_fleet_host_renewal_age_seconds{${own},pod="a",host_name="h1"}`,
            values: "1 8 1 1x60",
          },
          {
            series: `compute_fleet_host_renewal_age_seconds{${own},pod="a",host_name="h5"}`,
            values: "1 8 1 1x10 9 1x50",
          },
        ],
        alert: "OpenGeniComputeHostRenewalsLate",
        at: "20m",
        fires: [],
      },
      // Late at 30s, then every four minutes until 16 minutes, then on time:
      // pending from 30s, firing from 10.5 minutes, and resolved once no
      // five-minute window holds a late renewal, at 21 minutes.
      ...(
        [
          ["10m", false],
          ["11m", true],
          ["20m", true],
          ["21m", false],
        ] as const
      ).map(([at, fires]) => ({
        name: `renewals late every four minutes, then on time, at ${at}`,
        series: [
          {
            series: `compute_fleet_host_renewal_age_seconds{${own},pod="a",host_name="h1"}`,
            values: "1 8 1 1 1 1 1 1" + " 8 1 1 1 1 1 1 1".repeat(4) + " 1x40",
          },
        ],
        alert: "OpenGeniComputeHostRenewalsLate",
        at,
        fires: fires ? [{ labels: { host_name: "h1" }, value: 8 }] : [],
      })),
      {
        name: "disk almost full",
        series: [
          {
            series: `compute_fleet_host_disk_bytes{${own},pod="a",host_name="h1"}`,
            values: "1000x60",
          },
          {
            series: `compute_fleet_host_disk_free_bytes{${own},pod="a",host_name="h1"}`,
            values: "50x60",
          },
          {
            series: `compute_fleet_host_disk_bytes{${own},pod="a",host_name="h2"}`,
            values: "1000x60",
          },
          {
            series: `compute_fleet_host_disk_free_bytes{${own},pod="a",host_name="h2"}`,
            values: "500x60",
          },
        ],
        alert: "OpenGeniComputeHostDiskLow",
        at: "20m",
        fires: [{ labels: { host_name: "h1" }, value: 0.05 }],
      },
    ]);
  }, 180_000);
});
