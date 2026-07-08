import {
  DeploymentProfileId,
  ProductOverlayId,
  type DeploymentContract,
  type PreflightCheckId,
  contractForProfile,
  missingRuntimeEnvVars,
  preflightChecksFor,
  requiredRuntimeEnvVars,
} from "@opengeni/deployment";
import { spawnSync } from "node:child_process";
import net from "node:net";

interface Args {
  profile: string;
  productOverlay: string;
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
const contract = contractForProfile(profileId, overlay);
const checks = preflightChecksFor(contract);
const requiredEnvVars = requiredRuntimeEnvVars(contract);
const missingEnvVars = args.checkEnv ? missingRuntimeEnvVars(contract) : [];
const liveResults = args.live ? await runLiveProbes(contract) : [];

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
      },
      null,
      2,
    ),
  );
  if (args.live && liveResults.some((result) => result.status === "failed")) {
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
  for (const result of liveResults) {
    console.log(`  - ${result.id}: ${result.status} - ${result.detail}`);
  }
  if (liveResults.some((result) => result.status === "failed")) {
    process.exitCode = 1;
  }
}

function parseArgs(values: string[]): Args {
  const out: Args = {
    profile: "local-compose",
    productOverlay: "none",
    json: false,
    list: false,
    checkEnv: false,
    live: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
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
    throw new Error(`Unknown argument: ${value}`);
  }

  return out;
}

async function runLiveProbes(contract: DeploymentContract): Promise<LiveProbeResult[]> {
  const results: LiveProbeResult[] = [];
  if (contract.runtime.platform === "kubernetes") {
    results.push(runKubectlNamespaceProbe(contract.runtime.namespace));
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
    objectEndpoint
      ? await httpReachabilityProbe("object-storage-read-write", objectEndpoint)
      : skipped(
          "object-storage-read-write",
          "OPENGENI_OBJECT_STORAGE_ENDPOINT is not set in this environment.",
        ),
  );

  const apiBaseUrl = process.env.OPENGENI_API_BASE_URL;
  if (apiBaseUrl) {
    results.push(
      await httpReachabilityProbe("api-health", new URL("/healthz", apiBaseUrl).toString()),
    );
  }

  return results;
}

function runKubectlNamespaceProbe(namespace: string | undefined): LiveProbeResult {
  const args = namespace ? ["get", "namespace", namespace] : ["version", "--client=true"];
  const result = spawnSync("kubectl", args, {
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
    return failed(id, `invalid URL: ${errorMessage(error)}`);
  }
}

async function tcpHostPortProbe(
  id: PreflightCheckId,
  hostPort: string,
  defaultPort: number,
): Promise<LiveProbeResult> {
  const parsed = parseHostPort(hostPort, defaultPort);
  if (!parsed) {
    return failed(id, `invalid host:port value: ${hostPort}`);
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
      resolve(failed(id, `failed to connect to ${host}:${port}: ${error.message}`));
    });
  });
}

async function httpReachabilityProbe(
  id: LiveProbeResult["id"],
  endpoint: string,
): Promise<LiveProbeResult> {
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status >= 200 && response.status < 500) {
      return passed(id, `HTTP ${response.status} from ${redactUrl(endpoint)}`);
    }
    return failed(id, `HTTP ${response.status} from ${redactUrl(endpoint)}`);
  } catch (error) {
    return failed(id, `failed to reach ${redactUrl(endpoint)}: ${errorMessage(error)}`);
  }
}

function parseHostPort(value: string, defaultPort: number): { host: string; port: number } | null {
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      return { host: url.hostname, port: Number(url.port || defaultPort) };
    } catch {
      return null;
    }
  }
  const [host, rawPort] = value.split(":");
  if (!host) {
    return null;
  }
  const port = Number(rawPort || defaultPort);
  return Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "redacted";
    }
    if (url.password) {
      url.password = "redacted";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/([^:@/]+):([^@/]+)@/, "//redacted:redacted@");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactDetail(value: string): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-3).join(" ");
  return tail.length > 600 ? `${tail.slice(0, 600)}...` : tail;
}
