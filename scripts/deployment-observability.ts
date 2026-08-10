export type ObservabilityStackProfile = "single-node" | "production";

interface ObservabilityStackOptions {
  profile?: ObservabilityStackProfile;
  namespace?: string;
  releaseName?: string;
  appNamespace?: string;
  appReleaseName?: string;
  environment?: string;
}

export interface ObservabilityStackPlan {
  profile: ObservabilityStackProfile;
  namespace: string;
  releaseName: string;
  appNamespace: string;
  appReleaseName: string;
  environment: string;
  chartPath: "deploy/observability";
  chartVersion: "0.1.4";
  kubePrometheusStackVersion: "87.16.1";
  valuesFiles: string[];
  applicationValuesFile: "deploy/observability/opengeni.values.example.yaml";
  installCommands: string[];
  verifyCommands: string[];
  destroyCommands: string[];
  notes: string[];
}

interface Args {
  profile: string;
  namespace: string;
  releaseName: string;
  appNamespace: string;
  appReleaseName: string;
  environment?: string;
  json: boolean;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const plan = observabilityStackPlanFor({
    profile: parseProfile(args.profile),
    namespace: args.namespace,
    releaseName: args.releaseName,
    appNamespace: args.appNamespace,
    appReleaseName: args.appReleaseName,
    environment: args.environment,
  });

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }

  console.log(`OpenGeni observability stack plan: ${plan.profile}`);
  console.log(`Wrapper chart: ${plan.chartPath} ${plan.chartVersion}`);
  console.log(`kube-prometheus-stack: ${plan.kubePrometheusStackVersion}`);
  console.log(`Namespace/release: ${plan.namespace}/${plan.releaseName}`);
  console.log(`Application namespace/release: ${plan.appNamespace}/${plan.appReleaseName}`);
  console.log(`Environment label: ${plan.environment}`);
  printList("Profile values", plan.valuesFiles);
  console.log(`\nApplication values: ${plan.applicationValuesFile}`);
  printList("Install", plan.installCommands);
  printList("Verify", plan.verifyCommands);
  printList("Destroy", plan.destroyCommands);
  printList("Notes", plan.notes);
}

export function observabilityStackPlanFor(
  input: ObservabilityStackOptions = {},
): ObservabilityStackPlan {
  const profile = parseProfile(input.profile ?? "single-node");
  const namespace = validateKubernetesDnsLabel(input.namespace ?? "observability", "namespace");
  const releaseName = validateKubernetesDnsLabel(
    input.releaseName ?? "opengeni-observability",
    "release name",
  );
  const appNamespace = validateKubernetesDnsLabel(
    input.appNamespace ?? "opengeni",
    "application namespace",
  );
  const appReleaseName = validateKubernetesDnsLabel(
    input.appReleaseName ?? "opengeni",
    "application release name",
  );
  const environment = validateEnvironment(
    input.environment ?? (profile === "production" ? "production" : "self-hosted"),
  );
  const profileValues =
    profile === "production" ? "deploy/observability/values.production.example.yaml" : null;
  const valuesFiles = profileValues ? [profileValues] : [];
  const valuesArgs = valuesFiles.map((path) => ` --values ${path}`).join("");
  const revisionExpression = "${OPENGENI_SOURCE_REVISION:-$(git rev-parse HEAD)}";
  const sourceRevision = `"opengeni.sourceRevision=${revisionExpression}"`;
  const grafanaSourceRevision = `"kube-prometheus-stack.grafana.podAnnotations.opengeni\\.ai/source-revision=${revisionExpression}"`;

  return {
    profile,
    namespace,
    releaseName,
    appNamespace,
    appReleaseName,
    environment,
    chartPath: "deploy/observability",
    chartVersion: "0.1.4",
    kubePrometheusStackVersion: "87.16.1",
    valuesFiles,
    applicationValuesFile: "deploy/observability/opengeni.values.example.yaml",
    installCommands: [
      "helm repo add prometheus-community https://prometheus-community.github.io/helm-charts",
      "helm dependency build deploy/observability",
      `kubectl create namespace ${namespace} --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl label namespace ${namespace} opengeni.ai/monitoring=enabled --overwrite`,
      `kubectl create namespace ${appNamespace} --dry-run=client -o yaml | kubectl apply -f -`,
      `kubectl label namespace ${appNamespace} opengeni.ai/monitoring=enabled --overwrite`,
      `helm upgrade --install ${releaseName} deploy/observability --namespace ${namespace}${valuesArgs} --set-string kube-prometheus-stack.prometheus.prometheusSpec.externalLabels.environment=${environment} --set-string ${sourceRevision} --set-string ${grafanaSourceRevision} --wait --timeout 20m`,
    ],
    verifyCommands: [
      `bun run deployment:observability-verify -- --namespace ${namespace} --release ${releaseName} --app-namespace ${appNamespace}`,
    ],
    destroyCommands: [`helm uninstall ${releaseName} --namespace ${namespace} --ignore-not-found`],
    notes: [
      "The observability wrapper installs kube-prometheus-stack separately from the OpenGeni application chart.",
      "Install the wrapper first so the Prometheus Operator CRDs exist before the OpenGeni chart renders ServiceMonitor and PrometheusRule resources.",
      "Integrate deploy/observability/opengeni.values.example.yaml into the next ordinary OpenGeni application release with its exact chart version and authoritative values; the observability plan never upgrades or rolls back application workloads and never runs application hooks.",
      "Prometheus discovers monitoring resources only in namespaces labeled opengeni.ai/monitoring=enabled.",
      "Canonical dashboard ConfigMaps are rendered directly from deploy/observability/dashboards; do not maintain a second dashboard copy in an environment overlay.",
      "Keep Grafana ingress, administrator credentials, Alertmanager receivers, remote-write endpoints, and environment-only dashboards or rules in a private values overlay.",
      "The default stack is persistent but single-replica. Review storage classes, capacity, backup policy, and high-availability requirements before production use.",
      "Before uninstalling, export any Grafana UI state and confirm the cluster's PVC and volume reclaim policies.",
    ],
  };
}

function parseProfile(value: string): ObservabilityStackProfile {
  if (value === "single-node" || value === "production") return value;
  throw new Error(`unsupported observability profile: ${value}`);
}

function validateKubernetesDnsLabel(value: string, description: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`${description} must be a Kubernetes DNS label`);
  }
  return value;
}

function validateEnvironment(value: string): string {
  if (!/^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error("environment must be a shell-safe label");
  }
  return value;
}

function printList(title: string, values: string[]): void {
  console.log(`\n${title}`);
  if (values.length === 0) {
    console.log("  - none");
    return;
  }
  for (const value of values) {
    console.log(`  - ${value}`);
  }
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    profile: "single-node",
    namespace: "observability",
    releaseName: "opengeni-observability",
    appNamespace: "opengeni",
    appReleaseName: "opengeni",
    json: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      out.json = true;
      continue;
    }
    const [key, inline] = value.split("=", 2);
    const next = inline ?? values[index + 1];
    if (
      ![
        "--profile",
        "--namespace",
        "--release",
        "--app-namespace",
        "--app-release",
        "--environment",
      ].includes(key)
    ) {
      throw new Error(`unknown argument: ${value}`);
    }
    if (!next) {
      throw new Error(`${key} requires a value`);
    }
    if (inline === undefined) index += 1;
    if (key === "--profile") out.profile = next;
    if (key === "--namespace") out.namespace = next;
    if (key === "--release") out.releaseName = next;
    if (key === "--app-namespace") out.appNamespace = next;
    if (key === "--app-release") out.appReleaseName = next;
    if (key === "--environment") out.environment = next;
  }

  return out;
}
