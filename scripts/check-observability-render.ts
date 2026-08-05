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
const deploymentContainers = (grafanaDeployment.spec?.template?.spec?.containers ?? []) as Array<{
  name?: string;
  env?: Array<{ name?: string; value?: string }>;
}>;
assertSidecar(deploymentContainers, "grafana-sc-dashboard");
assertSidecar(deploymentContainers, "grafana-sc-datasources");

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

function assertSidecar(
  candidateContainers: Array<{
    name?: string;
    env?: Array<{ name?: string; value?: string }>;
  }>,
  name: string,
): void {
  const sidecar = candidateContainers.find((container) => container.name === name);
  assert(sidecar, `missing Grafana sidecar ${name}`);
  const environment = new Map((sidecar.env ?? []).map((entry) => [entry.name, entry.value]));
  assert(environment.get("RESOURCE") === "configmap", `${name} must read ConfigMaps only`);
  assert(environment.get("NAMESPACE") !== "ALL", `${name} must not watch every namespace`);
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
