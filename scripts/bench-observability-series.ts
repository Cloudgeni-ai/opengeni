interface Args {
  prometheusUrl: string;
  check: boolean;
}

interface QueryRow {
  metric: Record<string, string>;
  value: [number, string];
}

interface RelabelRule {
  action?: string;
  regex?: string;
  separator?: string;
  sourceLabels?: string[];
}

const args = parseArgs(process.argv.slice(2));
const stackValues = Bun.YAML.parse(await Bun.file("deploy/observability/values.yaml").text())[
  "kube-prometheus-stack"
] as Record<string, any>;
const rows = await prometheusQuery(
  args.prometheusUrl,
  'count by (job, metrics_path, __name__) ({__name__!=""})',
);
const headRows = await prometheusQuery(args.prometheusUrl, "prometheus_tsdb_head_series");
const headSeries = sumRows(headRows);

const categoryTotals = new Map<string, { current: number; projected: number }>();
for (const row of rows) {
  const labels = row.metric;
  const name = labels.__name__ ?? "";
  const count = Number(row.value[1]);
  const category = categoryFor(labels.job ?? "", name);
  const retained = retainedByProfile(category, labels, stackValues);
  const totals = categoryTotals.get(category) ?? { current: 0, projected: 0 };
  totals.current += count;
  if (retained) totals.projected += count;
  categoryTotals.set(category, totals);
}

const currentSamples = [...categoryTotals.values()].reduce((sum, row) => sum + row.current, 0);
const projectedSamples = [...categoryTotals.values()].reduce((sum, row) => sum + row.projected, 0);
const headReduction = projectedSamples > 0 ? headSeries / projectedSamples : 0;
const currentReduction = projectedSamples > 0 ? currentSamples / projectedSamples : 0;
const result = {
  measurement: "instant-vector upper bound; secondary label drops can reduce it further",
  headSeries,
  currentSamples,
  projectedSamples,
  headReduction: Number(headReduction.toFixed(2)),
  currentReduction: Number(currentReduction.toFixed(2)),
  categories: Object.fromEntries(
    [...categoryTotals]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, totals]) => [name, totals]),
  ),
};
console.log(JSON.stringify(result, null, 2));

if (args.check && headReduction < 3.5) {
  throw new Error(
    `projected head-series reduction ${headReduction.toFixed(2)}x is below the 3.5x safety floor`,
  );
}

function retainedByProfile(
  category: string,
  labels: Record<string, string>,
  values: Record<string, any>,
): boolean {
  switch (category) {
    case "kubernetes-api":
      return applyRelabelRules(labels, values.kubeApiServer.serviceMonitor.metricRelabelings);
    case "kubelet": {
      const path = labels.metrics_path ?? "/metrics";
      const rules =
        path === "/metrics/cadvisor"
          ? values.kubelet.serviceMonitor.cAdvisorMetricRelabelings
          : path === "/metrics/probes"
            ? values.kubelet.serviceMonitor.probesMetricRelabelings
            : values.kubelet.serviceMonitor.metricRelabelings;
      return applyRelabelRules(labels, rules);
    }
    case "kube-state-metrics":
      return new Set(values["kube-state-metrics"].metricAllowlist).has(labels.__name__);
    case "node-exporter":
      return applyRelabelRules(
        labels,
        values["prometheus-node-exporter"].prometheus.monitor.metricRelabelings,
      );
    case "temporal":
      return !/.*latency.*_bucket/.test(labels.__name__ ?? "");
    case "grafana":
      return applyRelabelRules(labels, values.grafana.serviceMonitor.metricRelabelings);
    case "alertmanager":
      return applyRelabelRules(labels, values.alertmanager.serviceMonitor.metricRelabelings);
    case "prometheus-operator":
      return applyRelabelRules(labels, values.prometheusOperator.serviceMonitor.metricRelabelings);
    case "prometheus":
      return applyRelabelRules(labels, values.prometheus.serviceMonitor.metricRelabelings);
    default:
      return true;
  }
}

function applyRelabelRules(labels: Record<string, string>, rules: RelabelRule[]): boolean {
  for (const rule of rules ?? []) {
    const value = (rule.sourceLabels ?? [])
      .map((label) => labels[label] ?? "")
      .join(rule.separator ?? ";");
    const matches = new RegExp(`^(?:${rule.regex ?? "(.*)"})$`).test(value);
    if (rule.action === "drop" && matches) return false;
    if (rule.action === "keep" && !matches) return false;
  }
  return true;
}

function categoryFor(job: string, metric: string): string {
  if (/api-server|apiserver/.test(job)) return "kubernetes-api";
  if (/kubelet|cadvisor/.test(job)) return "kubelet";
  if (/kube-state/.test(job)) return "kube-state-metrics";
  if (/node-exporter/.test(job)) return "node-exporter";
  if (/temporal/.test(job)) return "temporal";
  if (/grafana/.test(job) || metric.startsWith("grafana_")) return "grafana";
  if (/alertmanager/.test(job) || metric.startsWith("alertmanager_")) return "alertmanager";
  if (/operator/.test(job) || metric.startsWith("prometheus_operator_")) {
    return "prometheus-operator";
  }
  if (/prometheus/.test(job) || metric.startsWith("prometheus_")) return "prometheus";
  if (/opengeni/.test(job) || metric.startsWith("opengeni_")) return "application";
  return "other";
}

async function prometheusQuery(baseUrl: string, query: string): Promise<QueryRow[]> {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", query);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);
  const body = (await response.json()) as {
    status?: string;
    error?: string;
    data?: { result?: QueryRow[] };
  };
  if (body.status !== "success" || !body.data?.result) {
    throw new Error(`Prometheus query failed: ${body.error ?? "unknown error"}`);
  }
  return body.data.result;
}

function sumRows(queryRows: QueryRow[]): number {
  return queryRows.reduce((sum, row) => sum + Number(row.value[1]), 0);
}

function parseArgs(argv: string[]): Args {
  const out: Args = { prometheusUrl: "http://127.0.0.1:19090", check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") {
      out.check = true;
      continue;
    }
    const [key, inline] = value.split("=", 2);
    if (key !== "--prometheus-url") throw new Error(`unknown argument: ${value}`);
    const next = inline ?? argv[index + 1];
    if (!next) throw new Error("--prometheus-url requires a value");
    if (inline === undefined) index += 1;
    const url = new URL(next);
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new Error("--prometheus-url must use HTTP or HTTPS");
    }
    out.prometheusUrl = url.toString();
  }
  return out;
}
