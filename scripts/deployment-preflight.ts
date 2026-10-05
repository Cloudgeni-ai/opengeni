import {
  DeploymentProfileId,
  ProductOverlayId,
  type DeploymentContract,
  type PreflightCheckId,
  contractForProfile,
  missingRuntimeEnvVars,
  parseDeploymentContract,
  preflightChecksFor,
  requiredRuntimeEnvVars,
} from "@opengeni/deployment";
import { spawnSync } from "node:child_process";
import net from "node:net";

import {
  publicEndpointOrigin,
  publicProbeErrorDiagnostic,
  probeHostPort,
} from "./deployment-preflight-diagnostics";

interface Args {
  profile: string;
  productOverlay: string;
  productAccessMode: string | null;
  accessMode: string | null;
  publicBaseUrl: string | null;
  json: boolean;
  list: boolean;
  checkEnv: boolean;
  live: boolean;
}

interface LiveProbeResult {
  id: PreflightCheckId | "api-health";
  status: "passed" | "failed" | "skipped";
  detail: string;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  for (const profile of DeploymentProfileId.options) {
    console.log(profile);
  }
  process.exit(0);
}

const profileId = DeploymentProfileId.parse(args.profile);
const overlay = ProductOverlayId.parse(args.productOverlay);
const hasAccessSelection =
  args.productAccessMode !== null || args.accessMode !== null || args.publicBaseUrl !== null;
if (hasAccessSelection && profileId !== "azure-container-apps") {
  throw new Error(
    "Preflight access selectors are supported only for the azure-container-apps profile",
  );
}
if (hasAccessSelection && (args.productAccessMode === null || args.accessMode === null)) {
  throw new Error("--product-access-mode and --access-mode must be supplied together");
}
const baseContract = contractForProfile(profileId, overlay);
const contract = hasAccessSelection
  ? parseDeploymentContract({
      ...baseContract,
      access: { ...baseContract.access, mode: args.accessMode },
      product: {
        ...baseContract.product,
        accessMode: args.productAccessMode,
        ...(args.publicBaseUrl !== null || args.productAccessMode === "managed"
          ? {
              publicBaseUrl:
                args.publicBaseUrl ??
                process.env.OPENGENI_PUBLIC_BASE_URL ??
                baseContract.product.publicBaseUrl,
            }
          : {}),
      },
    })
  : baseContract;
const checks = preflightChecksFor(contract);
const requiredEnvVars = requiredRuntimeEnvVars(contract);
const missingEnvVars = args.checkEnv ? missingRuntimeEnvVars(contract) : [];
const liveResults = args.live ? await runLiveProbes(contract) : [];
const containerApps = contract.runtime.platform === "azure-container-apps";
const liveFailed = liveResults.some(
  (result) =>
    result.status === "failed" ||
    (containerApps &&
      result.status === "skipped" &&
      checks.some((check) => check.id === result.id && check.required)),
);
const liveProbeScope =
  "Partial operator-side CLI/TCP/HTTP checks only; not workload connectivity, protocol authentication, storage read/write, migration success, or conformance proof.";

if (args.json) {
  console.log(
    JSON.stringify(
      {
        profile: contract.profile,
        runtime: contract.runtime,
        modes: {
          database: contract.database.mode,
          temporal: contract.temporal.mode,
          nats: contract.nats.mode,
          objectStorage: contract.objectStorage.mode,
          secrets: contract.secrets.mode,
          access: contract.access.mode,
          productAccess: contract.product.accessMode,
          billing: contract.product.billingMode,
          entitlements: contract.product.entitlementsMode,
          usageLimits: contract.product.usageLimitsMode,
          sandbox: contract.sandbox.backend,
          observability: contract.observability.backend,
        },
        requiredEnvVars,
        ...(args.checkEnv
          ? {
              missingEnvVars,
              envOk: missingEnvVars.length === 0,
            }
          : {}),
        checks,
        liveResults: args.live ? liveResults : undefined,
        ...(containerApps && args.live ? { liveProbeScope } : {}),
      },
      null,
      2,
    ),
  );
  if (args.live && liveFailed) {
    process.exit(1);
  }
  if (args.checkEnv && missingEnvVars.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

console.log(`OpenGeni deployment preflight: ${contract.profile}`);
console.log("");
console.log("Runtime");
console.log(`  platform: ${contract.runtime.platform}`);
console.log(`  cloud: ${contract.runtime.cloud}`);
if (contract.runtime.namespace) {
  console.log(`  namespace: ${contract.runtime.namespace}`);
}
console.log("");
console.log("Dependency modes");
console.log(`  database: ${contract.database.mode}`);
console.log(`  temporal: ${contract.temporal.mode}`);
console.log(`  nats: ${contract.nats.mode}`);
console.log(`  object storage: ${contract.objectStorage.mode} (${contract.objectStorage.api})`);
console.log(`  secrets: ${contract.secrets.mode}`);
console.log(`  access: ${contract.access.mode}`);
console.log(`  product access: ${contract.product.accessMode}`);
console.log(`  billing: ${contract.product.billingMode}`);
console.log(`  entitlements: ${contract.product.entitlementsMode}`);
console.log(`  usage limits: ${contract.product.usageLimitsMode}`);
console.log(`  sandbox: ${contract.sandbox.backend}`);
console.log(`  observability: ${contract.observability.backend}`);
console.log("");
console.log("Required runtime environment");
for (const name of requiredEnvVars) {
  console.log(`  - ${name}`);
}
if (args.checkEnv) {
  console.log("");
  if (missingEnvVars.length === 0) {
    console.log("Environment check: ok");
  } else {
    console.log("Environment check: missing required variables");
    for (const name of missingEnvVars) {
      console.log(`  - ${name}`);
    }
    process.exitCode = 2;
  }
}
console.log("");
console.log("Required checks");
for (const item of checks) {
  const marker = item.required ? "required" : "optional";
  console.log(`  - ${item.id} (${marker}): ${item.description}`);
}

if (args.live) {
  console.log("");
  console.log("Live probes");
  if (containerApps) console.log(`  ${liveProbeScope}`);
  for (const result of liveResults) {
    console.log(`  - ${result.id}: ${result.status} - ${result.detail}`);
  }
  if (liveFailed) {
    process.exitCode = 1;
  }
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    profile: "local-compose",
    productOverlay: "none",
    productAccessMode: null,
    accessMode: null,
    publicBaseUrl: null,
    json: false,
    list: false,
    checkEnv: false,
    live: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--json") {
      out.json = true;
      continue;
    }
    if (value === "--list") {
      out.list = true;
      continue;
    }
    if (value === "--check-env") {
      out.checkEnv = true;
      continue;
    }
    if (value === "--live") {
      out.live = true;
      continue;
    }
    if (value === "--profile") {
      const next = values[index + 1];
      if (!next) {
        throw new Error("--profile requires a value");
      }
      out.profile = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--profile=")) {
      out.profile = value.slice("--profile=".length);
      continue;
    }
    if (value === "--product-overlay") {
      const next = values[index + 1];
      if (!next) {
        throw new Error("--product-overlay requires a value");
      }
      out.productOverlay = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--product-overlay=")) {
      out.productOverlay = value.slice("--product-overlay=".length);
      continue;
    }
    if (
      value === "--product-access-mode" ||
      value === "--access-mode" ||
      value === "--public-base-url"
    ) {
      const next = values[++index];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === "--product-access-mode") out.productAccessMode = next;
      else if (value === "--access-mode") out.accessMode = next;
      else out.publicBaseUrl = next;
      continue;
    }
    if (value.startsWith("--product-access-mode=")) {
      out.productAccessMode = value.slice("--product-access-mode=".length);
      continue;
    }
    if (value.startsWith("--access-mode=")) {
      out.accessMode = value.slice("--access-mode=".length);
      continue;
    }
    if (value.startsWith("--public-base-url=")) {
      out.publicBaseUrl = value.slice("--public-base-url=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return out;
}

async function runLiveProbes(deploymentContract: DeploymentContract): Promise<LiveProbeResult[]> {
  const results: LiveProbeResult[] = [];
  if (deploymentContract.runtime.platform === "kubernetes") {
    results.push(runKubectlNamespaceProbe(deploymentContract.runtime.namespace));
  }
  if (deploymentContract.runtime.platform === "azure-container-apps") {
    results.push(runAzureContainerAppsContextProbe());
  }

  const databaseUrl = process.env.OPENGENI_DATABASE_URL;
  results.push(
    databaseUrl
      ? await tcpUrlProbe("postgres-connectivity", databaseUrl, 5432)
      : skipped("postgres-connectivity", "OPENGENI_DATABASE_URL is not set in this environment."),
  );

  const temporalHost = process.env.OPENGENI_TEMPORAL_HOST;
  results.push(
    temporalHost
      ? await tcpHostPortProbe("temporal-connectivity", temporalHost, 7233)
      : skipped("temporal-connectivity", "OPENGENI_TEMPORAL_HOST is not set in this environment."),
  );

  const natsUrl = process.env.OPENGENI_NATS_URL;
  results.push(
    natsUrl
      ? await tcpUrlProbe("nats-pubsub", natsUrl, 4222)
      : skipped("nats-pubsub", "OPENGENI_NATS_URL is not set in this environment."),
  );

  const objectEndpoint = process.env.OPENGENI_OBJECT_STORAGE_ENDPOINT;
  results.push(
    deploymentContract.runtime.platform === "azure-container-apps"
      ? skipped(
          "object-storage-read-write",
          "Azure Blob read/write and signed browser/sandbox URLs require real conformance; an HTTP reachability probe is not storage proof.",
        )
      : objectEndpoint
        ? await httpReachabilityProbe("object-storage-read-write", objectEndpoint)
        : skipped(
            "object-storage-read-write",
            "OPENGENI_OBJECT_STORAGE_ENDPOINT is not set in this environment.",
          ),
  );

  const apiBaseUrl = process.env.OPENGENI_API_BASE_URL;
  if (apiBaseUrl) {
    try {
      results.push(
        await httpReachabilityProbe(
          "api-health",
          new URL("/healthz", apiBaseUrl).toString(),
          deploymentContract.runtime.platform === "azure-container-apps",
        ),
      );
    } catch (error) {
      results.push(
        failed("api-health", `invalid API base URL: ${publicProbeErrorDiagnostic(error)}`),
      );
    }
  }

  return results;
}

function runAzureContainerAppsContextProbe(): LiveProbeResult {
  const id = "azure-container-apps-context";
  for (const command of [
    ["account", "show", "--query", "state", "--output", "tsv", "--only-show-errors"],
    ["containerapp", "job", "execution", "show", "--help"],
  ]) {
    const result = spawnSync("az", command, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error)
      return failed(id, `Azure CLI unavailable: ${publicProbeErrorDiagnostic(result.error)}`);
    if (result.status !== 0) {
      return failed(
        id,
        `Azure CLI prerequisite failed (exit ${result.status ?? "unknown"}); verify az login, the selected subscription, and Container Apps job command availability.`,
      );
    }
    if (command[0] === "account" && result.stdout.trim() !== "Enabled") {
      return failed(id, "The selected Azure subscription is not enabled.");
    }
  }
  return passed(
    id,
    "Azure CLI has an enabled signed-in subscription and job commands; resource permissions, registration, and deployment readiness remain unverified.",
  );
}

function runKubectlNamespaceProbe(namespace: string | undefined): LiveProbeResult {
  const kubectlArgs = namespace ? ["get", "namespace", namespace] : ["version", "--client=true"];
  const result = spawnSync("kubectl", kubectlArgs, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return failed("kubernetes-context", result.error.message);
  }
  if (result.status !== 0) {
    return failed(
      "kubernetes-context",
      compactDetail(result.stderr || result.stdout || "kubectl probe failed"),
    );
  }
  return passed(
    "kubernetes-context",
    namespace ? `namespace ${namespace} is reachable` : "kubectl client is available",
  );
}

async function tcpUrlProbe(
  id: PreflightCheckId,
  rawUrl: string,
  defaultPort: number,
): Promise<LiveProbeResult> {
  try {
    const url = new URL(rawUrl);
    const port = Number(url.port || defaultPort);
    return await tcpConnectProbe(id, url.hostname, port);
  } catch (error) {
    return failed(id, `invalid URL: ${publicProbeErrorDiagnostic(error)}`);
  }
}

async function tcpHostPortProbe(
  id: PreflightCheckId,
  hostPort: string,
  defaultPort: number,
): Promise<LiveProbeResult> {
  const parsed = probeHostPort(hostPort, defaultPort);
  if (!parsed) {
    return failed(id, "invalid host:port value");
  }
  return await tcpConnectProbe(id, parsed.host, parsed.port);
}

async function tcpConnectProbe(
  id: PreflightCheckId,
  host: string,
  port: number,
): Promise<LiveProbeResult> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(failed(id, `timed out connecting to ${host}:${port}`));
    }, 5_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve(passed(id, `connected to ${host}:${port}`));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      resolve(
        failed(id, `failed to connect to ${host}:${port}: ${publicProbeErrorDiagnostic(error)}`),
      );
    });
  });
}

async function httpReachabilityProbe(
  id: LiveProbeResult["id"],
  endpoint: string,
  requireSuccess = false,
): Promise<LiveProbeResult> {
  const publicEndpoint = publicEndpointOrigin(endpoint);
  if (publicEndpoint.startsWith("[")) return failed(id, publicEndpoint);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status >= 200 && response.status < (requireSuccess ? 300 : 500)) {
      return passed(id, `HTTP ${response.status} from ${publicEndpoint}`);
    }
    return failed(id, `HTTP ${response.status} from ${publicEndpoint}`);
  } catch (error) {
    return failed(id, `failed to reach ${publicEndpoint}: ${publicProbeErrorDiagnostic(error)}`);
  }
}

function passed(id: LiveProbeResult["id"], detail: string): LiveProbeResult {
  return { id, status: "passed", detail };
}

function failed(id: LiveProbeResult["id"], detail: string): LiveProbeResult {
  return { id, status: "failed", detail };
}

function skipped(id: LiveProbeResult["id"], detail: string): LiveProbeResult {
  return { id, status: "skipped", detail };
}

function compactDetail(value: string): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-3).join(" ");
  return tail.length > 600 ? `${tail.slice(0, 600)}...` : tail;
}
