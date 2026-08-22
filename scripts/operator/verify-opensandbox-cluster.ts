import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

export interface OpenSandboxClusterVerificationArgs {
  expectZero: boolean;
  output: string | null;
  namespace: string;
  systemNamespace: string;
}

const FORBIDDEN_SANDBOX_ENV = new Set([
  "OPENGENI_DATABASE_URL",
  "OPENGENI_MIGRATIONS_DATABASE_URL",
  "AZURE_CLIENT_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
]);

export function parseOpenSandboxClusterVerificationArgs(
  argv: string[],
): OpenSandboxClusterVerificationArgs {
  const args: OpenSandboxClusterVerificationArgs = {
    expectZero: false,
    output: null,
    namespace: "opensandbox",
    systemNamespace: "opensandbox-system",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--expect-zero") args.expectZero = true;
    else if (value === "--output") args.output = requiredNext(argv, ++index, value);
    else if (value === "--namespace") args.namespace = requiredNext(argv, ++index, value);
    else if (value === "--system-namespace")
      args.systemNamespace = requiredNext(argv, ++index, value);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

export function forbiddenEnvironmentNames(pods: unknown): string[] {
  if (!isRecord(pods) || !Array.isArray(pods.items)) return [];
  const found = new Set<string>();
  for (const pod of pods.items) {
    if (!isRecord(pod) || !isRecord(pod.spec) || !Array.isArray(pod.spec.containers)) continue;
    for (const container of pod.spec.containers) {
      if (!isRecord(container) || !Array.isArray(container.env)) continue;
      for (const entry of container.env) {
        if (
          isRecord(entry) &&
          typeof entry.name === "string" &&
          FORBIDDEN_SANDBOX_ENV.has(entry.name)
        ) {
          found.add(entry.name);
        }
      }
    }
  }
  return [...found].sort();
}

async function main(): Promise<void> {
  const args = parseOpenSandboxClusterVerificationArgs(process.argv.slice(2));
  const service = kubectlJson([
    "-n",
    args.systemNamespace,
    "get",
    "svc",
    "opensandbox-server",
    "-o",
    "json",
  ]);
  const deployment = kubectlJson([
    "-n",
    args.systemNamespace,
    "get",
    "deployment",
    "opensandbox-server",
    "-o",
    "json",
  ]);
  const batchSandboxes = kubectlJson([
    "-n",
    args.namespace,
    "get",
    "batchsandboxes.sandbox.opensandbox.io",
    "-o",
    "json",
  ]);
  const pools = kubectlJson([
    "-n",
    args.namespace,
    "get",
    "pools.sandbox.opensandbox.io",
    "-o",
    "json",
  ]);
  const pods = kubectlJson(["-n", args.namespace, "get", "pods", "-o", "json"]);
  const ingress = kubectlJson([
    "-n",
    args.systemNamespace,
    "get",
    "svc",
    "opensandbox-ingress-gateway",
    "-o",
    "json",
  ]);
  const serviceType = stringAt(service, ["spec", "type"]);
  const ingressType = stringAt(ingress, ["spec", "type"]);
  const serverContainers = arrayAt(deployment, ["spec", "template", "spec", "containers"]);
  const serverApiKeySecretBacked = serverContainers.some((container) =>
    arrayAt(container, ["env"]).some(
      (entry) =>
        stringAt(entry, ["name"]) === "OPENSANDBOX_SERVER_API_KEY" &&
        stringAt(entry, ["valueFrom", "secretKeyRef", "name"]) === "opensandbox-api-key" &&
        stringAt(entry, ["valueFrom", "secretKeyRef", "key"]) === "api-key",
    ),
  );
  const counts = {
    batchSandboxes: arrayAt(batchSandboxes, ["items"]).length,
    pools: arrayAt(pools, ["items"]).length,
    pods: arrayAt(pods, ["items"]).length,
  };
  const forbiddenEnv = forbiddenEnvironmentNames(pods);
  const checks = {
    clusterIpOnly: serviceType === "ClusterIP",
    ingressGatewayClusterIp: ingressType === "ClusterIP",
    lifecycleApiKeySecretBacked: serverApiKeySecretBacked,
    sandboxCredentialsAbsent: forbiddenEnv.length === 0,
    zeroOwnedResources: counts.batchSandboxes === 0 && counts.pools === 0 && counts.pods === 0,
  };
  const passed =
    checks.clusterIpOnly &&
    checks.ingressGatewayClusterIp &&
    checks.lifecycleApiKeySecretBacked &&
    checks.sandboxCredentialsAbsent &&
    (!args.expectZero || checks.zeroOwnedResources);
  const artifact = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    context: kubectlText(["config", "current-context"]).trim(),
    namespaces: { system: args.systemNamespace, sandbox: args.namespace },
    serviceType,
    ingressType,
    counts,
    forbiddenEnvironmentNames: forbiddenEnv,
    checks,
    passed,
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (args.output) await writeFile(args.output, text, { mode: 0o600 });
  console.log(text.trimEnd());
  if (!passed) process.exitCode = 2;
}

function kubectlJson(args: string[]): unknown {
  return JSON.parse(kubectlText(args));
}

function kubectlText(args: string[]): string {
  const result = spawnSync("kubectl", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      "unknown error"
    ).trim();
    throw new Error(`kubectl ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function arrayAt(value: unknown, path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return Array.isArray(current) ? current : [];
}

function stringAt(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return typeof current === "string" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

if (import.meta.main) await main();
