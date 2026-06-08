import { existsSync, readFileSync } from "node:fs";

const requiredChecks = [
  "production-deployment",
  "production-health",
  "managed-canary-smoke",
  "production-conformance",
  "billing-readonly",
  "observability-canary",
  "rollback-readiness",
] as const;

type RequiredCheckId = typeof requiredChecks[number];
type CheckStatus = "passed" | "failed" | "skipped";

interface Args {
  evidence: string;
  environment: string;
  expectedGitSha: string | null;
}

const args = parseArgs(process.argv.slice(2), process.env);
const evidence = parseEvidence(args.evidence);
const checks = indexChecks(evidence);
const results: Array<{ id: string; status: CheckStatus; detail: string }> = [];

runCheck("top-level-evidence", () => {
  if (evidence.ok === false) {
    throw new Error("top-level ok is false");
  }
  const environment = stringField(evidence, "environment");
  if (environment !== args.environment) {
    throw new Error(`environment is ${environment ?? "<missing>"}, expected ${args.environment}`);
  }
  const baseUrl = stringField(evidence, "baseUrl");
  if (!baseUrl) {
    throw new Error("baseUrl is missing");
  }
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`baseUrl must be https, got ${parsedUrl.protocol}`);
  }
  const generatedAt = stringField(evidence, "generatedAt");
  if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const gitSha = stringField(evidence, "gitSha");
  if (!gitSha || !/^[0-9a-f]{7,40}$/.test(gitSha)) {
    throw new Error("gitSha must be a 7-40 character lowercase hex SHA");
  }
  if (args.expectedGitSha && gitSha !== args.expectedGitSha) {
    throw new Error(`gitSha is ${gitSha}, expected ${args.expectedGitSha}`);
  }
  validateImageDigests(evidence);
  return `${environment} production canary evidence for ${baseUrl}`;
});

for (const required of requiredChecks) {
  runCheck(required, () => validateRequiredCheck(required));
}

const ok = !results.some((result) => result.status === "failed");
console.log(JSON.stringify({
  ok,
  source: args.evidence,
  environment: stringField(evidence, "environment") ?? null,
  baseUrl: stringField(evidence, "baseUrl") ?? null,
  gitSha: stringField(evidence, "gitSha") ?? null,
  images: evidence.images ?? null,
  requiredChecks,
  results,
}, null, 2));

if (!ok) {
  process.exit(1);
}

function validateRequiredCheck(id: RequiredCheckId): string {
  const check = checks.get(id);
  if (!check) {
    throw new Error(`missing required production canary check ${id}`);
  }
  const status = stringField(check, "status");
  if (status !== "passed") {
    throw new Error(`check status is ${status ?? "<missing>"}, expected passed`);
  }
  validateEvidenceFiles(check);
  const metrics = recordField(check, "metrics");
  switch (id) {
    case "production-deployment":
      assertTrue(metrics, "deployedByPrivateOps");
      assertTrue(metrics, "productionEnvironmentScoped");
      assertTrue(metrics, "artifactDigestPinned");
      assertTrue(metrics, "apiDigestPinned");
      assertTrue(metrics, "workerDigestPinned");
      assertTrue(metrics, "webDigestPinned");
      return "production deployment uses private ops, protected production scope, and digest-pinned artifacts";
    case "production-health":
      assertTrue(metrics, "healthOk");
      assertTrue(metrics, "clientConfigProduction");
      assertTrue(metrics, "authModeManaged");
      assertTrue(metrics, "httpsOnly");
      return "production health, client config, managed auth mode, and HTTPS verified";
    case "managed-canary-smoke":
      assertTrue(metrics, "emailVerified");
      assertTrue(metrics, "accountWorkspaceResolved");
      assertTrue(metrics, "apiKeyCreated");
      assertTrue(metrics, "canaryWorkspaceIsInternal");
      return "internal managed canary account, workspace, email, and API key verified";
    case "production-conformance":
      assertTrue(metrics, "noSkippedChecks");
      assertTrue(metrics, "sessionRun");
      assertTrue(metrics, "eventReplay");
      assertTrue(metrics, "sseReplay");
      assertTrue(metrics, "mcpToolSession");
      assertTrue(metrics, "scheduledTask");
      assertTrue(metrics, "objectStorage");
      return "production API/session/SSE/MCP/schedule/object-storage conformance verified";
    case "billing-readonly":
      assertTrue(metrics, "billingEndpointReadable");
      assertTrue(metrics, "creditStateReadable");
      assertTrue(metrics, "noLiveChargeCreated");
      return "production billing canary is read-only and did not create a live charge";
    case "observability-canary":
      assertTrue(metrics, "syntheticProbeConfigured");
      assertTrue(metrics, "alertsConfigured");
      assertTrue(metrics, "metricsVisible");
      assertTrue(metrics, "traceCorrelationVerified");
      assertTrue(metrics, "logCorrelationVerified");
      return "production observability probe, alerts, metrics, traces, and logs verified";
    case "rollback-readiness":
      assertTrue(metrics, "previousArtifactKnown");
      assertTrue(metrics, "rollbackPlanDocumented");
      assertTrue(metrics, "rollbackCredentialsAvailable");
      assertTrue(metrics, "currentArtifactRestorable");
      return "production rollback readiness verified without executing a destructive rollback";
  }
}

function validateImageDigests(record: Record<string, unknown>): void {
  const images = recordField(record, "images");
  for (const component of ["api", "worker", "web"]) {
    const image = recordField(images, component);
    const digest = stringField(image, "digest");
    const ref = stringField(image, "image");
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`images.${component}.digest must be a sha256 digest`);
    }
    if (!ref || !ref.endsWith(`@${digest}`)) {
      throw new Error(`images.${component}.image must be digest-pinned with ${digest}`);
    }
  }
}

function validateEvidenceFiles(check: Record<string, unknown>): void {
  const evidenceFiles = check.evidence;
  if (!Array.isArray(evidenceFiles) || evidenceFiles.length === 0) {
    throw new Error("check evidence must include at least one file path");
  }
  for (const value of evidenceFiles) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("check evidence contains an invalid path");
    }
    if (!existsSync(value)) {
      throw new Error(`check evidence file does not exist: ${value}`);
    }
  }
}

function indexChecks(record: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const checks = record.checks;
  if (!Array.isArray(checks)) {
    return out;
  }
  for (const check of checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      continue;
    }
    const id = stringField(check as Record<string, unknown>, "id");
    if (id) {
      out.set(id, check as Record<string, unknown>);
    }
  }
  return out;
}

function runCheck(id: string, fn: () => string): void {
  try {
    results.push({ id, status: "passed", detail: fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

function parseEvidence(path: string): Record<string, unknown> {
  if (!path) {
    throw new Error("Set --evidence or OPENGENI_PRODUCTION_CANARY_EVIDENCE");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("production canary evidence must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    evidence: env.OPENGENI_PRODUCTION_CANARY_EVIDENCE ?? "",
    environment: env.OPENGENI_PRODUCTION_CANARY_ENVIRONMENT ?? "production",
    expectedGitSha: env.OPENGENI_PRODUCTION_CANARY_GIT_SHA ?? null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--evidence") {
      out.evidence = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--environment") {
      out.environment = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--expected-git-sha") {
      out.expectedGitSha = requiredNext(values, ++index, value);
      continue;
    }
    if (value.startsWith("--evidence=")) {
      out.evidence = value.slice("--evidence=".length);
      continue;
    }
    if (value.startsWith("--environment=")) {
      out.environment = value.slice("--environment=".length);
      continue;
    }
    if (value.startsWith("--expected-git-sha=")) {
      out.expectedGitSha = value.slice("--expected-git-sha=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertTrue(record: Record<string, unknown>, field: string): void {
  if (record[field] !== true) {
    throw new Error(`${field} must be true`);
  }
}
