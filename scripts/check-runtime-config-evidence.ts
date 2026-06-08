import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
  outFile: string;
  environment: string;
  baseUrl: string;
  clientConfigJson: string | null;
  configMapJson: string | null;
  runtimeSecretKeysJson: string | null;
  runtimeEnvJson: string | null;
  expectedProductAccessMode: string;
  expectedAuthMode: string;
  expectedReasoningEffort: string;
  requiredRuntimeComponents: string[];
}

const args = parseArgs(process.argv.slice(2), process.env);
const failures: string[] = [];
const evidence: string[] = [];

const clientConfig = await readClientConfig(args, evidence, failures);
const configMapData = readConfigMapData(args.configMapJson, evidence, failures);
const runtimeSecretKeys = readRuntimeSecretKeys(args.runtimeSecretKeysJson, evidence, failures);
const runtimeEnv = readRuntimeEnv(args.runtimeEnvJson, evidence, failures);
const overlapKeys = [...new Set(Object.keys(configMapData).filter((key) => runtimeSecretKeys.includes(key)))].sort();

validateClientConfig(clientConfig, failures);
validateConfigMap(configMapData, failures);
validateSecretOverlap(overlapKeys, failures);
validateRuntimeEnv(runtimeEnv, failures);

const ok = failures.length === 0;
const output = {
  ok,
  environment: args.environment,
  baseUrl: args.baseUrl,
  generatedAt: new Date().toISOString(),
  checks: [{
    id: "runtime-config",
    status: ok ? "passed" : "failed",
    detail: ok ? "runtime config matches expected managed staging posture" : "runtime config evidence failed",
    evidence,
    metrics: {
      clientConfigMatchesExpected: failures.every((failure) => !failure.startsWith("client config ")),
      configMapMatchesExpected: failures.every((failure) => !failure.startsWith("configmap ")),
      configSecretOverlapAbsent: overlapKeys.length === 0,
      runtimeEnvMatchesExpected: failures.every((failure) => !failure.startsWith("runtime env ")),
      expectedProductAccessMode: args.expectedProductAccessMode,
      expectedAuthMode: args.expectedAuthMode,
      expectedReasoningEffort: args.expectedReasoningEffort,
      clientDefaultReasoningEffort: stringField(clientConfig, "defaultReasoningEffort"),
      clientProductAccessMode: stringField(clientConfig, "productAccessMode"),
      clientAuthMode: stringField(recordField(clientConfig, "auth", false), "mode"),
      configReasoningEffort: configMapData.OPENGENI_OPENAI_REASONING_EFFORT ?? null,
      secretConfigOverlapKeys: overlapKeys,
      runtimeComponents: Object.keys(runtimeEnv).sort(),
      requiredRuntimeComponents: args.requiredRuntimeComponents,
    },
    ...(failures.length > 0 ? { failures } : {}),
  }],
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

async function readClientConfig(args: Args, evidence: string[], failures: string[]): Promise<Record<string, unknown>> {
  if (args.clientConfigJson) {
    evidence.push(args.clientConfigJson);
    return parseJsonObject(args.clientConfigJson, "client config", failures);
  }
  if (!args.baseUrl) {
    failures.push("client config baseUrl is missing");
    return {};
  }
  const url = new URL("/v1/config/client", args.baseUrl);
  url.searchParams.set("runtimeConfigProbe", `${Date.now()}`);
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const text = await response.text();
  if (!response.ok) {
    failures.push(`client config fetch returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failures.push("client config response must be a JSON object");
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    failures.push(`client config response is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function readConfigMapData(path: string | null, evidence: string[], failures: string[]): Record<string, string> {
  if (!path) {
    failures.push("configmap evidence is missing");
    return {};
  }
  evidence.push(path);
  const parsed = parseJsonObject(path, "configmap", failures);
  const data = recordField(parsed, "data", false);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function readRuntimeSecretKeys(path: string | null, evidence: string[], failures: string[]): string[] {
  if (!path) {
    failures.push("runtime secret key evidence is missing");
    return [];
  }
  evidence.push(path);
  const parsed = parseJsonObject(path, "runtime secret keys", failures);
  if ("data" in parsed) {
    failures.push("runtime secret key evidence must be sanitized; raw Kubernetes Secret data is not accepted");
    return [];
  }
  const keys = arrayField(parsed, "keys", false) ?? arrayField(parsed, "secretKeys", false);
  if (!keys) {
    failures.push("runtime secret key evidence must include keys or secretKeys");
    return [];
  }
  return keys.flatMap((key) => typeof key === "string" && key.trim() ? [key.trim()] : []).sort();
}

function readRuntimeEnv(path: string | null, evidence: string[], failures: string[]): Record<string, Record<string, string>> {
  if (!path) {
    failures.push("runtime env evidence is missing");
    return {};
  }
  evidence.push(path);
  const parsed = parseJsonObject(path, "runtime env", failures);
  const components = recordField(parsed, "components", false);
  const source = Object.keys(components).length > 0 ? components : parsed;
  const out: Record<string, Record<string, string>> = {};
  for (const [component, value] of Object.entries(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const env = "env" in value && value.env && typeof value.env === "object" && !Array.isArray(value.env)
      ? value.env as Record<string, unknown>
      : value as Record<string, unknown>;
    out[component] = {};
    for (const [key, envValue] of Object.entries(env)) {
      if (typeof envValue === "string") {
        out[component][key] = envValue;
      }
    }
  }
  return out;
}

function validateClientConfig(clientConfig: Record<string, unknown>, failures: string[]): void {
  if (stringField(clientConfig, "productAccessMode") !== args.expectedProductAccessMode) {
    failures.push(`client config productAccessMode is ${stringField(clientConfig, "productAccessMode") ?? "<missing>"}, expected ${args.expectedProductAccessMode}`);
  }
  const authMode = stringField(recordField(clientConfig, "auth", false), "mode");
  if (authMode !== args.expectedAuthMode) {
    failures.push(`client config auth.mode is ${authMode ?? "<missing>"}, expected ${args.expectedAuthMode}`);
  }
  const defaultReasoningEffort = stringField(clientConfig, "defaultReasoningEffort");
  if (defaultReasoningEffort !== args.expectedReasoningEffort) {
    failures.push(`client config defaultReasoningEffort is ${defaultReasoningEffort ?? "<missing>"}, expected ${args.expectedReasoningEffort}`);
  }
  const allowed = arrayField(clientConfig, "allowedReasoningEfforts", false);
  if (!allowed?.includes(args.expectedReasoningEffort)) {
    failures.push(`client config allowedReasoningEfforts does not include ${args.expectedReasoningEffort}`);
  }
}

function validateConfigMap(configMapData: Record<string, string>, failures: string[]): void {
  const value = configMapData.OPENGENI_OPENAI_REASONING_EFFORT;
  if (value !== args.expectedReasoningEffort) {
    failures.push(`configmap OPENGENI_OPENAI_REASONING_EFFORT is ${value ?? "<missing>"}, expected ${args.expectedReasoningEffort}`);
  }
}

function validateSecretOverlap(overlapKeys: string[], failures: string[]): void {
  if (overlapKeys.length > 0) {
    failures.push(`runtime secret overlaps configmap key(s): ${overlapKeys.join(", ")}`);
  }
}

function validateRuntimeEnv(runtimeEnv: Record<string, Record<string, string>>, failures: string[]): void {
  for (const component of args.requiredRuntimeComponents) {
    const env = runtimeEnv[component];
    if (!env) {
      failures.push(`runtime env component ${component} is missing`);
      continue;
    }
    const value = env.OPENGENI_OPENAI_REASONING_EFFORT;
    if (value !== args.expectedReasoningEffort) {
      failures.push(`runtime env ${component}.OPENGENI_OPENAI_REASONING_EFFORT is ${value ?? "<missing>"}, expected ${args.expectedReasoningEffort}`);
    }
  }
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    outFile: env.OPENGENI_RUNTIME_CONFIG_OUT_FILE ?? ".agent/generated/staging/runtime-config.json",
    environment: env.OPENGENI_RUNTIME_CONFIG_ENVIRONMENT ?? "staging",
    baseUrl: env.OPENGENI_RUNTIME_CONFIG_BASE_URL ?? env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    clientConfigJson: env.OPENGENI_RUNTIME_CONFIG_CLIENT_CONFIG_JSON ?? null,
    configMapJson: env.OPENGENI_RUNTIME_CONFIG_CONFIGMAP_JSON ?? null,
    runtimeSecretKeysJson: env.OPENGENI_RUNTIME_CONFIG_SECRET_KEYS_JSON ?? null,
    runtimeEnvJson: env.OPENGENI_RUNTIME_CONFIG_RUNTIME_ENV_JSON ?? null,
    expectedProductAccessMode: env.OPENGENI_RUNTIME_CONFIG_EXPECT_PRODUCT_ACCESS_MODE ?? "managed",
    expectedAuthMode: env.OPENGENI_RUNTIME_CONFIG_EXPECT_AUTH_MODE ?? "managedSession",
    expectedReasoningEffort: env.OPENGENI_RUNTIME_CONFIG_EXPECT_REASONING_EFFORT ?? "low",
    requiredRuntimeComponents: parseList(env.OPENGENI_RUNTIME_CONFIG_REQUIRED_COMPONENTS ?? "api,worker"),
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--environment") {
      out.environment = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--client-config-json") {
      out.clientConfigJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--configmap-json") {
      out.configMapJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--runtime-secret-keys-json") {
      out.runtimeSecretKeysJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--runtime-env-json") {
      out.runtimeEnvJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-product-access-mode") {
      out.expectedProductAccessMode = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-auth-mode") {
      out.expectedAuthMode = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-reasoning-effort") {
      out.expectedReasoningEffort = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--required-runtime-components") {
      out.requiredRuntimeComponents = parseList(requiredNext(values, ++index, value));
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.baseUrl && !out.clientConfigJson) {
    throw new Error("Set --base-url, --client-config-json, OPENGENI_RUNTIME_CONFIG_BASE_URL, or OPENGENI_RUNTIME_CONFIG_CLIENT_CONFIG_JSON");
  }
  if (out.requiredRuntimeComponents.length === 0) {
    throw new Error("At least one runtime component is required");
  }
  return out;
}

function parseJsonObject(path: string, label: string, failures: string[]): Record<string, unknown> {
  if (!existsSync(path)) {
    failures.push(`${label} file does not exist: ${path}`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failures.push(`${label} must be a JSON object`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    failures.push(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function recordField(record: Record<string, unknown>, field: string, required: boolean): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (required) {
      throw new Error(`${field} must be an object`);
    }
    return {};
  }
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, field: string, required: boolean): unknown[] | null {
  const value = record[field];
  if (!Array.isArray(value)) {
    if (required) {
      throw new Error(`${field} must be an array`);
    }
    return null;
  }
  return value;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
