import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

interface Args {
  manifest: string;
  sourceRevision: string;
}

interface Resource {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
  rules?: Array<{ resources?: string[] }>;
  spec?: Record<string, any>;
}

const args = parseArgs(process.argv.slice(2));
const parsed = Bun.YAML.parse(readFileSync(args.manifest, "utf8"));
const resources = (Array.isArray(parsed) ? parsed : [parsed]).filter(
  (resource): resource is Resource => Boolean(resource?.kind && resource?.metadata?.name),
);

const grafanaClusterRoles = resources.filter(
  (resource) =>
    resource.kind === "ClusterRole" &&
    resource.metadata?.labels?.["app.kubernetes.io/name"] === "grafana",
);
assert(
  grafanaClusterRoles.length === 0,
  `Grafana must not receive cluster-scoped RBAC: ${grafanaClusterRoles
    .map((resource) => resource.metadata?.name)
    .join(", ")}`,
);

const grafanaRole = exactlyOne(
  resources.filter(
    (resource) =>
      resource.kind === "Role" &&
      resource.metadata?.labels?.["app.kubernetes.io/name"] === "grafana",
  ),
  "namespaced Grafana Role",
);
assert(grafanaRole.metadata?.namespace, "Grafana Role must be namespace-scoped");

const grafanaDeployment = exactlyOne(
  resources.filter(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata?.labels?.["app.kubernetes.io/name"] === "grafana",
  ),
  "Grafana Deployment",
);
const grafanaPodSpec = (grafanaDeployment.spec?.template?.spec ?? {}) as {
  containers?: Array<{
    name?: string;
    env?: Array<{ name?: string; value?: string }>;
  }>;
  initContainers?: Array<{
    name?: string;
    env?: Array<{ name?: string; value?: string }>;
  }>;
};
const deploymentContainers = grafanaPodSpec.containers ?? [];
const initContainers = grafanaPodSpec.initContainers ?? [];
assert(
  grafanaDeployment.spec?.template?.metadata?.annotations?.["opengeni.ai/source-revision"] ===
    args.sourceRevision,
  "Grafana pod must roll with the dashboard source revision",
);
assert(
  !deploymentContainers.some((container) => container.name === "grafana-sc-dashboard"),
  "Grafana dashboard discovery must not retain a steady sidecar",
);
assert(
  !deploymentContainers.some((container) => container.name === "grafana-sc-datasources"),
  "Grafana datasource discovery must not retain a steady sidecar",
);
assertInitCollector(initContainers, "grafana-init-sc-dashboard");
assertInitCollector(initContainers, "grafana-init-sc-datasources");

const serviceMonitors = resources.filter(
  (resource) => resource.kind === "ServiceMonitor",
) as Resource[];
const apiServerMonitor = serviceMonitorEndingIn(serviceMonitors, "-apiserver");
assertMetricRetention(apiServerMonitor, "/metrics", "apiserver_request_total", true);
assertMetricRetention(
  apiServerMonitor,
  "/metrics",
  "apiserver_request_duration_seconds_bucket",
  false,
  { le: "0.1" },
);

const kubeletMonitor = serviceMonitorEndingIn(serviceMonitors, "-kubelet");
assertMetricRetention(
  kubeletMonitor,
  "/metrics/cadvisor",
  "container_memory_working_set_bytes",
  true,
);
assertMetricRetention(kubeletMonitor, "/metrics/cadvisor", "container_memory_kernel_usage", false);
assertMetricRetention(
  kubeletMonitor,
  "/metrics",
  "kubelet_runtime_operations_duration_seconds_bucket",
  true,
  { le: "1" },
);
assertMetricRetention(
  kubeletMonitor,
  "/metrics/probes",
  "prober_probe_duration_seconds_bucket",
  false,
  { le: "1" },
);

const nodeExporterMonitor = exactlyOne(
  serviceMonitors.filter(
    (resource) =>
      resource.metadata?.labels?.["app.kubernetes.io/name"] === "prometheus-node-exporter",
  ),
  "node-exporter ServiceMonitor",
);
assertMetricRetention(
  nodeExporterMonitor,
  "/metrics",
  "node_pressure_memory_stalled_seconds_total",
  true,
);
assertMetricRetention(nodeExporterMonitor, "/metrics", "node_network_carrier_changes_total", false);

const grafanaMonitor = exactlyOne(
  serviceMonitors.filter(
    (resource) => resource.metadata?.labels?.["app.kubernetes.io/name"] === "grafana",
  ),
  "Grafana ServiceMonitor",
);
assertMetricRetention(grafanaMonitor, "/metrics", "grafana_build_info", true);
assertMetricRetention(grafanaMonitor, "/metrics", "grafana_feature_toggles_info", false);

const referencedMetrics = collectReferencedMetrics(resources);
const kubeStateMetricsDeployment = exactlyOne(
  resources.filter(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata?.labels?.["app.kubernetes.io/name"] === "kube-state-metrics",
  ),
  "kube-state-metrics Deployment",
);
const kubeStateArgs = (kubeStateMetricsDeployment.spec?.template?.spec?.containers?.[0]?.args ??
  []) as string[];
const allowlistArgument = kubeStateArgs.find((value) => value.startsWith("--metric-allowlist="));
assert(allowlistArgument, "kube-state-metrics must render an explicit metric allowlist");
const kubeStateAllowlist = new Set(
  allowlistArgument.slice("--metric-allowlist=".length).split(","),
);
for (const metric of referencedMetrics) {
  if (metric.startsWith("kube_") && !metric.includes(":")) {
    assert(
      kubeStateAllowlist.has(metric),
      `kube-state-metrics allowlist would remove referenced metric ${metric}`,
    );
  }
}

const prometheusMonitor = serviceMonitorEndingIn(serviceMonitors, "-prometheus");
const alertmanagerMonitor = serviceMonitorEndingIn(serviceMonitors, "-alertmanager");
const operatorMonitor = exactlyOne(
  serviceMonitors.filter(
    (resource) =>
      resource.metadata?.labels?.["app.kubernetes.io/component"] === "prometheus-operator",
  ),
  "Prometheus Operator ServiceMonitor",
);
assertMetricRetention(
  prometheusMonitor,
  "/metrics",
  "reloader_last_reload_successful",
  true,
  {},
  "reloader-web",
);
assertMetricRetention(
  alertmanagerMonitor,
  "/metrics",
  "reloader_last_reload_successful",
  true,
  {},
  "reloader-web",
);
for (const monitor of [
  apiServerMonitor,
  kubeletMonitor,
  nodeExporterMonitor,
  grafanaMonitor,
  prometheusMonitor,
  alertmanagerMonitor,
  operatorMonitor,
]) {
  assertMetricRetention(monitor, "/metrics", "go_memstats_heap_alloc_bytes", true);
  assertMetricRetention(monitor, "/metrics", "process_open_fds", true);
}
for (const metric of referencedMetrics) {
  const histogramLabels = metric.endsWith("_bucket") ? { le: "+Inf" } : {};
  if (/^(?:apiserver_|aggregator_)/.test(metric) && !metric.includes(":")) {
    assertMetricRetention(apiServerMonitor, "/metrics", metric, true, histogramLabels);
  }
  if (/^(?:kubelet_|storage_operation_|volume_manager_)/.test(metric)) {
    assertMetricRetention(kubeletMonitor, "/metrics", metric, true, histogramLabels);
  }
  if (metric.startsWith("container_") && metric !== "container_state") {
    assertMetricRetention(kubeletMonitor, "/metrics/cadvisor", metric, true);
  }
  if (metric.startsWith("node_") && !metric.includes(":")) {
    assertMetricRetention(nodeExporterMonitor, "/metrics", metric, true);
  }
  if (metric.startsWith("grafana_")) {
    assertMetricRetention(grafanaMonitor, "/metrics", metric, true, histogramLabels);
  }
  if (metric.startsWith("prometheus_operator_")) {
    assertMetricRetention(operatorMonitor, "/metrics", metric, true, histogramLabels);
  } else if (metric.startsWith("prometheus_") && !metric.includes(":")) {
    assertMetricRetention(prometheusMonitor, "/metrics", metric, true, histogramLabels);
  }
  if (metric.startsWith("alertmanager_")) {
    assertMetricRetention(alertmanagerMonitor, "/metrics", metric, true, histogramLabels);
  }
}

const prometheus = exactlyOne(
  resources.filter((resource) => resource.kind === "Prometheus"),
  "Prometheus custom resource",
);
for (const selectorName of ["serviceMonitorNamespaceSelector", "ruleNamespaceSelector"]) {
  assert(
    prometheus.spec?.[selectorName]?.matchLabels?.["opengeni.ai/monitoring"] === "enabled",
    `Prometheus ${selectorName} must require opengeni.ai/monitoring=enabled`,
  );
}

for (const applicationName of ["grafana", "kube-state-metrics", "prometheus-node-exporter"]) {
  const serviceMonitor = exactlyOne(
    resources.filter(
      (resource) =>
        resource.kind === "ServiceMonitor" &&
        resource.metadata?.labels?.["app.kubernetes.io/name"] === applicationName,
    ),
    `${applicationName} ServiceMonitor`,
  );
  assert(
    serviceMonitor.metadata?.labels?.["opengeni.ai/monitoring"] === "enabled",
    `${applicationName} ServiceMonitor must carry opengeni.ai/monitoring=enabled`,
  );
}

const dashboardsDirectory = "deploy/observability/dashboards";
const dashboardFiles = readdirSync(dashboardsDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const dashboardConfigMaps = resources.filter(
  (resource) =>
    resource.kind === "ConfigMap" &&
    resource.metadata?.labels?.["opengeni.ai/dashboard-source"] === "canonical",
);
assert(
  dashboardConfigMaps.length === dashboardFiles.length,
  `expected ${dashboardFiles.length} canonical dashboard ConfigMaps, found ${dashboardConfigMaps.length}`,
);

for (const filename of dashboardFiles) {
  const source = readFileSync(`${dashboardsDirectory}/${filename}`, "utf8");
  const configMap = dashboardConfigMaps.find((resource) => resource.data?.[filename] !== undefined);
  assert(configMap, `rendered manifest is missing dashboard ${filename}`);
  assert(configMap.data?.[filename] === source, `${filename} rendered bytes differ from source`);
  assert(
    configMap.metadata?.annotations?.grafana_folder === "/tmp/dashboards/OpenGeni",
    `${filename} has the wrong Grafana folder annotation`,
  );
  assert(
    configMap.metadata?.annotations?.["opengeni.ai/content-sha256"] === sha256(source),
    `${filename} has a stale content hash`,
  );
  assert(
    configMap.metadata?.annotations?.["opengeni.ai/source-revision"] === args.sourceRevision,
    `${filename} has the wrong source revision`,
  );
}

console.log(
  JSON.stringify({
    ok: true,
    manifest: args.manifest,
    dashboards: dashboardFiles,
    grafanaRbac: "namespaced",
    prometheusNamespaceSelectors: "opengeni.ai/monitoring=enabled",
  }),
);

function assertInitCollector(
  candidateContainers: Array<{
    name?: string;
    env?: Array<{ name?: string; value?: string }>;
  }>,
  name: string,
): void {
  const collector = candidateContainers.find((container) => container.name === name);
  assert(collector, `missing Grafana init collector ${name}`);
  const environment = new Map((collector.env ?? []).map((entry) => [entry.name, entry.value]));
  assert(environment.get("RESOURCE") === "configmap", `${name} must read ConfigMaps only`);
  assert(environment.get("NAMESPACE") !== "ALL", `${name} must not watch every namespace`);
  assert(environment.get("METHOD") === "LIST", `${name} must perform one finite list`);
}

function serviceMonitorEndingIn(monitors: Resource[], suffix: string): Resource {
  return exactlyOne(
    monitors.filter((resource) => resource.metadata?.name?.endsWith(suffix)),
    `${suffix} ServiceMonitor`,
  );
}

function assertMetricRetention(
  serviceMonitor: Resource,
  path: string,
  metricName: string,
  expected: boolean,
  labels: Record<string, string> = {},
  endpointPort?: string,
): void {
  const endpoints = (serviceMonitor.spec?.endpoints ?? []) as Array<{
    path?: string;
    port?: string;
    metricRelabelings?: Array<{
      action?: string;
      regex?: string;
      separator?: string;
      sourceLabels?: string[];
    }>;
  }>;
  const endpoint = endpoints.find(
    (candidate) =>
      (candidate.path ?? "/metrics") === path &&
      (endpointPort === undefined || candidate.port === endpointPort),
  );
  assert(endpoint, `${serviceMonitor.metadata?.name} has no ${path} endpoint`);
  const sample = { __name__: metricName, ...labels };
  let retained = true;
  for (const rule of endpoint.metricRelabelings ?? []) {
    const value = (rule.sourceLabels ?? [])
      .map((label) => sample[label as keyof typeof sample] ?? "")
      .join(rule.separator ?? ";");
    const matches = new RegExp(`^(?:${rule.regex ?? "(.*)"})$`).test(value);
    if (rule.action === "drop" && matches) {
      retained = false;
      break;
    }
    if (rule.action === "keep" && !matches) {
      retained = false;
      break;
    }
  }
  assert(
    retained === expected,
    `${serviceMonitor.metadata?.name} ${path} must ${expected ? "retain" : "drop"} ${metricName}`,
  );
}

function collectReferencedMetrics(renderedResources: Resource[]): Set<string> {
  const expressions: string[] = [];
  for (const resource of renderedResources) {
    if (resource.kind === "PrometheusRule") {
      const groups = (resource.spec?.groups ?? []) as Array<{
        rules?: Array<{ expr?: string }>;
      }>;
      for (const group of groups) {
        for (const rule of group.rules ?? []) {
          if (typeof rule.expr === "string") expressions.push(rule.expr);
        }
      }
    }
    if (resource.kind === "ConfigMap") {
      for (const [filename, source] of Object.entries(resource.data ?? {})) {
        if (!filename.endsWith(".json")) continue;
        collectDashboardQueries(JSON.parse(source), expressions);
      }
    }
  }

  const metrics = new Set<string>();
  for (const expression of expressions) {
    for (const match of expression.matchAll(/\b([A-Za-z_:][A-Za-z0-9_:]*)\s*(?=\{|\[)/g)) {
      if (match[1]) metrics.add(match[1]);
    }
    for (const match of expression.matchAll(/label_values\(\s*([A-Za-z_:][A-Za-z0-9_:]*)/g)) {
      if (match[1]) metrics.add(match[1]);
    }
    // Also capture bare platform metric selectors (for example `kube_job_failed
    // == 1`) that have neither a label matcher nor a range selector.
    for (const match of expression.matchAll(
      /(?<![A-Za-z0-9_:])((?:alertmanager|aggregator|apiserver|container|grafana|kube|kubelet|node|prometheus|prometheus_operator|storage_operation|volume_manager)_[A-Za-z0-9_:]+)\b/g,
    )) {
      if (match[1]) metrics.add(match[1]);
    }
  }
  return metrics;
}

function collectDashboardQueries(value: unknown, expressions: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectDashboardQueries(entry, expressions);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "expr" || key === "query") && typeof entry === "string") {
      expressions.push(entry);
    } else {
      collectDashboardQueries(entry, expressions);
    }
  }
}

function exactlyOne(values: Resource[], description: string): Resource {
  assert(values.length === 1, `expected one ${description}, found ${values.length}`);
  return values[0] as Resource;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(values: string[]): Args {
  let manifest = "";
  let sourceRevision = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const [key, inline] = value.split("=", 2);
    const next = inline ?? values[index + 1];
    if (!["--manifest", "--source-revision"].includes(key)) {
      throw new Error(`unknown argument: ${value}`);
    }
    if (!next) throw new Error(`${key} requires a value`);
    if (inline === undefined) index += 1;
    if (key === "--manifest") manifest = next;
    if (key === "--source-revision") sourceRevision = next;
  }
  if (!manifest) throw new Error("--manifest is required");
  if (!sourceRevision) throw new Error("--source-revision is required");
  return { manifest, sourceRevision };
}
