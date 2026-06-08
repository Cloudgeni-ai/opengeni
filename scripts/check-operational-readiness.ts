import { existsSync, readFileSync } from "node:fs";

const requiredChecks = [
  "load-soak",
  "backup-restore",
  "rollback",
  "observability-alerts",
  "private-ops-boundary",
  "runtime-config",
] as const;

type RequiredCheckId = typeof requiredChecks[number];

type CheckStatus = "passed" | "failed" | "skipped";

type CheckResult = {
  id: string;
  status: CheckStatus;
  detail: string;
};

interface Args {
  evidence: string;
  environment: string | null;
  allowHttp: boolean;
  minLoadSeconds: number;
  minLoadRequests: number;
  minCompletedSessions: number;
  maxErrorRate: number;
  maxP95Ms: number;
  maxRestoreRpoSeconds: number;
  maxRollbackSeconds: number;
}

const args = parseArgs(process.argv.slice(2), process.env);
const results: CheckResult[] = [];
const evidence = parseEvidence(args.evidence);
const checks = new Map<string, Record<string, unknown>>();

if (Array.isArray(evidence.checks)) {
  for (const check of evidence.checks) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      continue;
    }
    const id = stringField(check as Record<string, unknown>, "id");
    if (id) {
      checks.set(id, check as Record<string, unknown>);
    }
  }
}

runCheck("top-level-evidence", () => {
  if (evidence.ok === false) {
    throw new Error("top-level ok is false");
  }
  const environment = stringField(evidence, "environment");
  if (!environment) {
    throw new Error("environment is missing");
  }
  if (args.environment && environment !== args.environment) {
    throw new Error(`environment is ${environment}, expected ${args.environment}`);
  }
  const baseUrl = stringField(evidence, "baseUrl");
  if (!baseUrl) {
    throw new Error("baseUrl is missing");
  }
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.protocol !== "https:" && !args.allowHttp) {
    throw new Error(`baseUrl must be https, got ${parsedUrl.protocol}`);
  }
  const generatedAt = stringField(evidence, "generatedAt");
  if (!generatedAt || Number.isNaN(new Date(generatedAt).getTime())) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  return `${environment} operational evidence for ${baseUrl}`;
});

for (const required of requiredChecks) {
  runCheck(required, () => validateRequiredCheck(required));
}

const ok = !results.some((result) => result.status === "failed");
console.log(JSON.stringify({
  ok,
  source: args.evidence,
  environment: stringField(evidence, "environment") ?? null,
  requiredChecks,
  results,
}, null, 2));

if (!ok) {
  process.exit(1);
}

function validateRequiredCheck(id: RequiredCheckId): string {
  const check = checks.get(id);
  if (!check) {
    throw new Error(`missing required operational check ${id}`);
  }
  const status = stringField(check, "status");
  if (status !== "passed") {
    throw new Error(`check status is ${status ?? "<missing>"}, expected passed`);
  }
  validateEvidenceFiles(check);
  const metrics = recordField(check, "metrics");
  switch (id) {
    case "load-soak":
      return validateLoadSoak(metrics);
    case "backup-restore":
      return validateBackupRestore(metrics);
    case "rollback":
      return validateRollback(metrics);
    case "observability-alerts":
      return validateObservability(metrics);
    case "private-ops-boundary":
      return validatePrivateOps(metrics);
    case "runtime-config":
      return validateRuntimeConfig(metrics);
  }
}

function validateLoadSoak(metrics: Record<string, unknown>): string {
  const durationSeconds = numberField(metrics, "durationSeconds");
  const requests = numberField(metrics, "requests");
  const sessionsCompleted = numberField(metrics, "sessionsCompleted");
  const errorRate = numberField(metrics, "errorRate");
  const p95Ms = numberField(metrics, "p95Ms");
  if (durationSeconds < args.minLoadSeconds) {
    throw new Error(`durationSeconds ${durationSeconds} is below ${args.minLoadSeconds}`);
  }
  if (requests < args.minLoadRequests) {
    throw new Error(`requests ${requests} is below ${args.minLoadRequests}`);
  }
  if (sessionsCompleted < args.minCompletedSessions) {
    throw new Error(`sessionsCompleted ${sessionsCompleted} is below ${args.minCompletedSessions}`);
  }
  if (errorRate > args.maxErrorRate) {
    throw new Error(`errorRate ${errorRate} is above ${args.maxErrorRate}`);
  }
  if (p95Ms > args.maxP95Ms) {
    throw new Error(`p95Ms ${p95Ms} is above ${args.maxP95Ms}`);
  }
  return `${requests} requests over ${durationSeconds}s, p95=${p95Ms}ms, errorRate=${errorRate}`;
}

function validateBackupRestore(metrics: Record<string, unknown>): string {
  assertTrue(metrics, "backupPolicyEnabled");
  assertTrue(metrics, "restoreDrillCompleted");
  assertTrue(metrics, "restoredDatabaseValidated");
  assertTrue(metrics, "restoredObjectStorageValidated");
  const rpoSeconds = numberField(metrics, "rpoSeconds");
  if (rpoSeconds > args.maxRestoreRpoSeconds) {
    throw new Error(`rpoSeconds ${rpoSeconds} is above ${args.maxRestoreRpoSeconds}`);
  }
  return `restore drill completed with rpoSeconds=${rpoSeconds}`;
}

function validateRollback(metrics: Record<string, unknown>): string {
  assertTrue(metrics, "digestPinnedRollback");
  assertTrue(metrics, "previousArtifactRestored");
  assertTrue(metrics, "postRollbackConformancePassed");
  assertTrue(metrics, "forwardRollConformancePassed");
  const rollbackSeconds = numberField(metrics, "rollbackSeconds");
  if (rollbackSeconds > args.maxRollbackSeconds) {
    throw new Error(`rollbackSeconds ${rollbackSeconds} is above ${args.maxRollbackSeconds}`);
  }
  return `rollback and forward roll completed in ${rollbackSeconds}s`;
}

function validateObservability(metrics: Record<string, unknown>): string {
  assertTrue(metrics, "syntheticProbeConfigured");
  assertTrue(metrics, "alertsConfigured");
  assertTrue(metrics, "metricsDashboardVerified");
  assertTrue(metrics, "traceCorrelationVerified");
  assertTrue(metrics, "logCorrelationVerified");
  return "synthetic probe, alerts, dashboards, logs, and traces verified";
}

function validatePrivateOps(metrics: Record<string, unknown>): string {
  assertTrue(metrics, "deployedByPrivateOps");
  assertTrue(metrics, "publicPrSecretsBlocked");
  assertTrue(metrics, "environmentSecretsScoped");
  assertTrue(metrics, "oidcTrustScoped");
  assertTrue(metrics, "artifactDigestPinned");
  assertTrue(metrics, "secretScanPassed");
  return "private ops boundary and public PR no-secret policy verified";
}

function validateRuntimeConfig(metrics: Record<string, unknown>): string {
  assertTrue(metrics, "clientConfigMatchesExpected");
  assertTrue(metrics, "configMapMatchesExpected");
  assertTrue(metrics, "configSecretOverlapAbsent");
  assertTrue(metrics, "runtimeEnvMatchesExpected");
  const expectedReasoningEffort = stringField(metrics, "expectedReasoningEffort");
  const clientReasoningEffort = stringField(metrics, "clientDefaultReasoningEffort");
  const configReasoningEffort = stringField(metrics, "configReasoningEffort");
  if (!expectedReasoningEffort) {
    throw new Error("expectedReasoningEffort is missing");
  }
  if (clientReasoningEffort !== expectedReasoningEffort) {
    throw new Error(`clientDefaultReasoningEffort is ${clientReasoningEffort ?? "<missing>"}, expected ${expectedReasoningEffort}`);
  }
  if (configReasoningEffort !== expectedReasoningEffort) {
    throw new Error(`configReasoningEffort is ${configReasoningEffort ?? "<missing>"}, expected ${expectedReasoningEffort}`);
  }
  return `runtime config resolves expected reasoning effort ${expectedReasoningEffort}`;
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

function runCheck(id: string, fn: () => string): void {
  try {
    results.push({ id, status: "passed", detail: fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

function parseEvidence(path: string): Record<string, unknown> {
  if (!path) {
    throw new Error("Set --evidence or OPENGENI_OPERATIONAL_READINESS_EVIDENCE");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("operational readiness evidence must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    evidence: env.OPENGENI_OPERATIONAL_READINESS_EVIDENCE ?? "",
    environment: env.OPENGENI_OPERATIONAL_READINESS_ENVIRONMENT ?? null,
    allowHttp: env.OPENGENI_OPERATIONAL_READINESS_ALLOW_HTTP === "1",
    minLoadSeconds: numberEnv(env.OPENGENI_LOAD_SOAK_MIN_SECONDS, 1_800),
    minLoadRequests: numberEnv(env.OPENGENI_LOAD_SOAK_MIN_REQUESTS, 500),
    minCompletedSessions: numberEnv(env.OPENGENI_LOAD_SOAK_MIN_COMPLETED_SESSIONS, 25),
    maxErrorRate: numberEnv(env.OPENGENI_LOAD_SOAK_MAX_ERROR_RATE, 0.01),
    maxP95Ms: numberEnv(env.OPENGENI_LOAD_SOAK_MAX_P95_MS, 5_000),
    maxRestoreRpoSeconds: numberEnv(env.OPENGENI_BACKUP_RESTORE_MAX_RPO_SECONDS, 3_600),
    maxRollbackSeconds: numberEnv(env.OPENGENI_ROLLBACK_MAX_SECONDS, 900),
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
    if (value === "--allow-http") {
      out.allowHttp = true;
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
    throw new Error(`Unknown argument: ${value}`);
  }
  return out;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected numeric environment value, got ${value}`);
  }
  return parsed;
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

function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
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
