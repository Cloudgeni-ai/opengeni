import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

interface Args {
  namespace: string;
  releaseName: string;
  appNamespace: string;
  sourceRevision?: string;
  prometheusUrl?: string;
  grafanaUrl?: string;
  grafanaNamespace: string;
  grafanaPodSelector: string;
  grafanaSidecarContainer: string;
  grafanaDashboardDirectory: string;
  skipLiveApis: boolean;
}

interface KubernetesList<T> {
  items: T[];
}

interface KubernetesMetadata {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface ConfigMap {
  metadata: KubernetesMetadata;
  data?: Record<string, string>;
}

interface Service {
  metadata: KubernetesMetadata;
  spec: { ports?: Array<{ name?: string; port: number }> };
}

const dashboardDirectory = "deploy/observability/dashboards";
const monitoringSelector = "opengeni.ai/monitoring=enabled";
const dashboardSelector = "opengeni.ai/dashboard-source=canonical";
const requiredRules = [
  "opengeni:sandbox_leases:fresh_max",
  "opengeni:sandbox_checkpoint_artifacts:fresh_max",
  "opengeni:workload_node:present",
  "opengeni:node_exporter_instance:info",
  "opengeni:kubelet_instance:info",
  "opengeni:node_memory_psi_stall_ratio",
  "opengeni:node_io_psi_stall_ratio",
  "opengeni:node_swap_out_pages_per_second",
  "OpenGeniSandboxCreateFailureRatio",
  "OpenGeniSandboxInventoryProjectionStale",
  "OpenGeniTurnWorkerMemoryHeadroomLow",
  "OpenGeniTurnWorkerMemoryConsumesReserve",
  "OpenGeniTurnWorkerMemoryGuardDraining",
  "OpenGeniTurnWorkerMemoryGuardFailure",
  "OpenGeniNodeMemoryPressureStalled",
  "OpenGeniNodeIoPressureStalled",
  "OpenGeniNodeSwapThrashing",
  "OpenGeniNodeContainerRuntimeErrors",
  "OpenGeniNodeNotReady",
] as const;

const args = parseArgs(process.argv.slice(2));
const sourceRevision = args.sourceRevision ?? process.env.OPENGENI_SOURCE_REVISION ?? gitHead();
const chartDefinition = Bun.YAML.parse(
  await Bun.file("deploy/observability/Chart.yaml").text(),
) as { name?: string; version?: string };
assert(chartDefinition.name, "observability Chart.yaml has no name");
assert(chartDefinition.version, "observability Chart.yaml has no version");

const release = helmRelease(args.namespace, args.releaseName);
assert(release.status === "deployed", `Helm release is ${release.status}, not deployed`);
assert(
  release.chart === `${chartDefinition.name}-${chartDefinition.version}`,
  `unexpected observability chart: ${release.chart}`,
);
assertMonitoringNamespace(args.namespace);
assertMonitoringNamespace(args.appNamespace);

const dashboardFiles = (await readdir(dashboardDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();
const expectedDashboards = new Map<string, { filename: string; content: string }>();
for (const filename of dashboardFiles) {
  const content = await Bun.file(`${dashboardDirectory}/${filename}`).text();
  const parsed = JSON.parse(content) as { uid?: string };
  assert(parsed.uid, `${filename} has no Grafana UID`);
  expectedDashboards.set(parsed.uid, { filename, content });
}

const configMaps = kubectlJson<KubernetesList<ConfigMap>>([
  "-n",
  args.namespace,
  "get",
  "configmaps",
  "-l",
  dashboardSelector,
  "-o",
  "json",
]).items;
assert(
  configMaps.length === expectedDashboards.size,
  `expected ${expectedDashboards.size} canonical dashboard ConfigMaps, found ${configMaps.length}`,
);

for (const configMap of configMaps) {
  const entries = Object.entries(configMap.data ?? {}).filter(([name]) => name.endsWith(".json"));
  assert(
    entries.length === 1,
    `${configMap.metadata.name} must contain exactly one dashboard JSON`,
  );
  const [filename, content] = entries[0] as [string, string];
  const expected = [...expectedDashboards.values()].find((value) => value.filename === filename);
  assert(expected, `${configMap.metadata.name} contains unexpected dashboard ${filename}`);
  assert(
    content === expected.content,
    `${configMap.metadata.name} dashboard bytes differ from source`,
  );
  const expectedHash = createHash("sha256").update(content).digest("hex");
  assert(
    configMap.metadata.annotations?.["opengeni.ai/content-sha256"] === expectedHash,
    `${configMap.metadata.name} content hash annotation is stale`,
  );
  assert(
    configMap.metadata.annotations?.["opengeni.ai/source-revision"] === sourceRevision,
    `${configMap.metadata.name} source revision does not match ${sourceRevision}`,
  );
}

const applicationServiceMonitors = kubectlJson<KubernetesList<{ metadata: KubernetesMetadata }>>([
  "-n",
  args.appNamespace,
  "get",
  "servicemonitors.monitoring.coreos.com",
  "-l",
  monitoringSelector,
  "-o",
  "json",
]).items;
assert(applicationServiceMonitors.length > 0, "no OpenGeni ServiceMonitor resources were found");

const platformServiceMonitors = kubectlJson<KubernetesList<{ metadata: KubernetesMetadata }>>([
  "-n",
  args.namespace,
  "get",
  "servicemonitors.monitoring.coreos.com",
  "-l",
  monitoringSelector,
  "-o",
  "json",
]).items;
const requiredPlatformApplicationNames = [
  "grafana",
  "kube-state-metrics",
  "prometheus-node-exporter",
] as const;
const requiredPlatformServiceMonitors = requiredPlatformApplicationNames.map((applicationName) => {
  const matches = platformServiceMonitors.filter(
    (serviceMonitor) =>
      serviceMonitor.metadata.labels?.["app.kubernetes.io/name"] === applicationName,
  );
  assert(
    matches.length === 1,
    `expected one selected ${applicationName} ServiceMonitor, found ${matches.length}`,
  );
  return matches[0] as { metadata: KubernetesMetadata };
});

const prometheusRules = kubectlJson<
  KubernetesList<{
    metadata: KubernetesMetadata;
    spec?: { groups?: Array<{ rules?: Array<{ alert?: string; record?: string }> }> };
  }>
>([
  "-n",
  args.appNamespace,
  "get",
  "prometheusrules.monitoring.coreos.com",
  "-l",
  monitoringSelector,
  "-o",
  "json",
]).items;
assert(prometheusRules.length > 0, "no OpenGeni PrometheusRule resources were found");
const declaredRules = new Set(
  prometheusRules.flatMap((rule) =>
    (rule.spec?.groups ?? []).flatMap((group) =>
      (group.rules ?? []).flatMap(
        (entry) => [entry.alert, entry.record].filter(Boolean) as string[],
      ),
    ),
  ),
);
for (const name of requiredRules) {
  assert(declaredRules.has(name), `PrometheusRule resources do not declare ${name}`);
}

if (!args.skipLiveApis) {
  const verifyPrometheus = async (baseUrl: string): Promise<void> => {
    const response = await fetchJson<{
      status: string;
      data?: {
        groups?: Array<{
          rules?: Array<{ name?: string; health?: string; lastError?: string }>;
        }>;
      };
    }>(`${baseUrl}/api/v1/rules`);
    assert(response.status === "success", "Prometheus rules API did not return success");
    const loaded = new Map(
      (response.data?.groups ?? [])
        .flatMap((group) => group.rules ?? [])
        .flatMap((rule) => (rule.name ? [[rule.name, rule] as const] : [])),
    );
    for (const name of requiredRules) {
      const rule = loaded.get(name);
      assert(rule, `Prometheus has not loaded ${name}`);
      assert(
        rule.health === "ok" && !rule.lastError,
        `Prometheus rule ${name} is unhealthy: ${rule.lastError || rule.health || "unknown"}`,
      );
    }

    const targets = await fetchJson<{
      status: string;
      data?: {
        activeTargets?: Array<{
          scrapePool?: string;
          health?: string;
          lastError?: string;
        }>;
      };
    }>(`${baseUrl}/api/v1/targets?state=active`);
    assert(targets.status === "success", "Prometheus targets API did not return success");
    for (const [namespace, serviceMonitor] of [
      ...applicationServiceMonitors.map((item) => [args.appNamespace, item] as const),
      ...requiredPlatformServiceMonitors.map((item) => [args.namespace, item] as const),
    ]) {
      const poolPrefix = `serviceMonitor/${namespace}/${serviceMonitor.metadata.name}/`;
      const matches = (targets.data?.activeTargets ?? []).filter((target) =>
        target.scrapePool?.startsWith(poolPrefix),
      );
      assert(matches.length > 0, `Prometheus discovered no targets for ${poolPrefix}`);
      for (const target of matches) {
        assert(
          target.health === "up" && !target.lastError,
          `${target.scrapePool} is unhealthy: ${target.lastError || target.health || "unknown"}`,
        );
      }
    }
  };
  if (args.prometheusUrl) {
    await verifyPrometheus(args.prometheusUrl);
  } else {
    const prometheusService = selectService(args.namespace, "app=kube-prometheus-stack-prometheus");
    await withPortForward(args.namespace, prometheusService, verifyPrometheus);
  }

  const verifyGrafana = async (baseUrl: string): Promise<void> => {
    const response = await fetchJson<{ database?: string }>(`${baseUrl}/api/health`);
    assert(response.database === "ok", "Grafana health API did not report database=ok");
  };
  if (args.grafanaUrl) {
    await verifyGrafana(args.grafanaUrl);
  } else {
    const grafanaService = selectService(args.namespace, "app.kubernetes.io/name=grafana");
    await withPortForward(args.namespace, grafanaService, verifyGrafana);
  }
  verifyDashboardSidecarFiles(
    args.grafanaNamespace,
    args.grafanaPodSelector,
    args.grafanaSidecarContainer,
    args.grafanaDashboardDirectory,
    expectedDashboards,
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      release: `${args.namespace}/${args.releaseName}`,
      sourceRevision,
      dashboards: [...expectedDashboards.keys()].sort(),
      serviceMonitors: applicationServiceMonitors.map((item) => item.metadata.name).sort(),
      platformServiceMonitors: requiredPlatformServiceMonitors
        .map((item) => item.metadata.name)
        .sort(),
      prometheusRules: prometheusRules.map((item) => item.metadata.name).sort(),
      liveApisVerified: !args.skipLiveApis,
    },
    null,
    2,
  ),
);

function helmRelease(namespace: string, releaseName: string): { chart: string; status: string } {
  const releases = runJson<Array<{ chart: string; name: string; status: string }>>([
    "helm",
    "list",
    "--namespace",
    namespace,
    "--filter",
    `^${releaseName}$`,
    "--output",
    "json",
  ]);
  const matchedRelease = releases.find((item) => item.name === releaseName);
  assert(matchedRelease, `Helm release ${namespace}/${releaseName} was not found`);
  return matchedRelease;
}

function selectService(namespace: string, selector: string): Service {
  const services = kubectlJson<KubernetesList<Service>>([
    "-n",
    namespace,
    "get",
    "services",
    "-l",
    selector,
    "-o",
    "json",
  ]).items;
  assert(
    services.length === 1,
    `expected one service matching ${selector}, found ${services.length}`,
  );
  return services[0] as Service;
}

function assertMonitoringNamespace(namespace: string): void {
  const value = kubectlJson<{ metadata?: KubernetesMetadata }>([
    "get",
    "namespace",
    namespace,
    "-o",
    "json",
  ]);
  assert(
    value.metadata?.labels?.["opengeni.ai/monitoring"] === "enabled",
    `namespace ${namespace} is not labeled opengeni.ai/monitoring=enabled`,
  );
}

function verifyDashboardSidecarFiles(
  namespace: string,
  podSelector: string,
  sidecarContainer: string,
  sidecarDirectory: string,
  dashboardSources: Map<string, { filename: string; content: string }>,
): void {
  const pods = kubectlJson<KubernetesList<{ metadata: KubernetesMetadata }>>([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    podSelector,
    "-o",
    "json",
  ]).items;
  assert(pods.length === 1, `expected one Grafana pod, found ${pods.length}`);
  const podName = pods[0]?.metadata.name;
  assert(podName, "Grafana pod has no name");
  for (const { filename, content } of dashboardSources.values()) {
    const rendered = kubectlText([
      "-n",
      namespace,
      "exec",
      podName,
      "-c",
      sidecarContainer,
      "--",
      "cat",
      `${sidecarDirectory.replace(/\/$/, "")}/${filename}`,
    ]);
    assert(rendered === content, `Grafana dashboard sidecar file ${filename} differs from source`);
  }
}

async function withPortForward(
  namespace: string,
  service: Service,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const servicePort = service.spec.ports?.[0]?.port;
  assert(servicePort, `${service.metadata.name} has no service port`);
  const localPort = await freePort();
  const process = Bun.spawn(
    [
      "kubectl",
      "-n",
      namespace,
      "port-forward",
      `service/${service.metadata.name}`,
      `${localPort}:${servicePort}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const baseUrl = `http://127.0.0.1:${localPort}`;
  try {
    await waitForHttp(baseUrl, process);
    await action(baseUrl);
  } finally {
    process.kill();
    await process.exited;
  }
}

async function waitForHttp(baseUrl: string, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`kubectl port-forward exited early with code ${process.exitCode}`);
    }
    try {
      await fetch(baseUrl, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`timed out waiting for ${baseUrl}`);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = server.port;
  await server.stop(true);
  assert(port !== undefined, "Bun did not allocate a local verification port");
  return port;
}

function kubectlText(commandArgs: string[]): string {
  const result = Bun.spawnSync(["kubectl", ...commandArgs], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`kubectl failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function kubectlJson<T>(commandArgs: string[]): T {
  return runJson<T>(["kubectl", ...commandArgs]);
}

function runJson<T>(command: string[]): T {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0]} failed (${result.exitCode}): ${result.stderr.toString().trim()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as T;
}

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error("--source-revision is required outside an OpenGeni Git checkout");
  }
  return result.stdout.toString().trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    namespace: "observability",
    releaseName: "opengeni-observability",
    appNamespace: "opengeni",
    grafanaNamespace: "observability",
    grafanaPodSelector: "app.kubernetes.io/name=grafana",
    grafanaSidecarContainer: "grafana-sc-dashboard",
    grafanaDashboardDirectory: "/tmp/dashboards/OpenGeni",
    skipLiveApis: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--skip-live-apis") {
      out.skipLiveApis = true;
      continue;
    }
    const [key, inline] = value.split("=", 2);
    const next = inline ?? values[index + 1];
    if (
      ![
        "--namespace",
        "--release",
        "--app-namespace",
        "--source-revision",
        "--prometheus-url",
        "--grafana-url",
        "--grafana-namespace",
        "--grafana-pod-selector",
        "--grafana-sidecar-container",
        "--grafana-dashboard-directory",
      ].includes(key)
    ) {
      throw new Error(`unknown argument: ${value}`);
    }
    if (!next) throw new Error(`${key} requires a value`);
    if (inline === undefined) index += 1;
    if (key === "--namespace") out.namespace = next;
    if (key === "--release") out.releaseName = next;
    if (key === "--app-namespace") out.appNamespace = next;
    if (key === "--source-revision") out.sourceRevision = next;
    if (key === "--prometheus-url") out.prometheusUrl = normalizedBaseUrl(next, key);
    if (key === "--grafana-url") out.grafanaUrl = normalizedBaseUrl(next, key);
    if (key === "--grafana-namespace") out.grafanaNamespace = next;
    if (key === "--grafana-pod-selector") out.grafanaPodSelector = next;
    if (key === "--grafana-sidecar-container") out.grafanaSidecarContainer = next;
    if (key === "--grafana-dashboard-directory") out.grafanaDashboardDirectory = next;
  }
  return out;
}

function normalizedBaseUrl(value: string, argument: string): string {
  const url = new URL(value);
  assert(["http:", "https:"].includes(url.protocol), `${argument} must use HTTP or HTTPS`);
  return url.toString().replace(/\/$/, "");
}
