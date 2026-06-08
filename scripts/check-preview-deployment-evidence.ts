import { readFileSync } from "node:fs";

const requiredFixtures = ["postgres", "temporal", "nats", "minio"] as const;
const requiredDeployments = ["api", "worker", "web"] as const;

type CheckStatus = "passed" | "failed";

interface Args {
  evidence: string;
  environment: string;
  expectedGitSha: string | null;
}

const args = parseArgs(process.argv.slice(2), process.env);
const evidence = parseEvidence(args.evidence);
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
  return `${environment} preview deployment evidence for ${baseUrl}`;
});

runCheck("preview-helm-profile", () => {
  const helm = recordField(evidence, "helm");
  const status = stringField(helm, "status");
  if (status !== "deployed") {
    throw new Error(`helm.status is ${status ?? "<missing>"}, expected deployed`);
  }
  const namespace = stringField(helm, "namespace");
  if (!namespace || !namespace.startsWith("opengeni-preview")) {
    throw new Error(`helm.namespace is ${namespace ?? "<missing>"}, expected opengeni-preview*`);
  }
  const releaseName = stringField(helm, "releaseName");
  if (!releaseName) {
    throw new Error("helm.releaseName is missing");
  }
  const valuesFiles = arrayOfStrings(helm.valuesFiles);
  if (!valuesFiles.includes("deploy/helm/opengeni/values.preview-managed.example.yaml")) {
    throw new Error("preview deploy evidence must include values.preview-managed.example.yaml");
  }
  if (!valuesFiles.some((path) => path.endsWith("/helm-values.generated.yaml") || path === "helm-values.generated.yaml")) {
    throw new Error("preview deploy evidence must include generated runtime Helm values");
  }
  return `${releaseName} is deployed in ${namespace} with preview-managed values`;
});

runCheck("preview-fixtures", () => {
  const fixtures = recordField(evidence, "fixtures");
  for (const fixture of requiredFixtures) {
    if (fixtures[fixture] !== true) {
      throw new Error(`fixture ${fixture} is not enabled`);
    }
  }
  return "preview disposable Postgres, Temporal, NATS, and MinIO fixtures are enabled";
});

runCheck("preview-workloads", () => {
  const deployments = recordField(evidence, "deployments");
  for (const name of requiredDeployments) {
    const deployment = recordField(deployments, name);
    const readyReplicas = numberField(deployment, "readyReplicas");
    const replicas = numberField(deployment, "replicas");
    const image = stringField(deployment, "image");
    if (!replicas || replicas < 1) {
      throw new Error(`${name} replicas is ${replicas ?? "<missing>"}, expected at least 1`);
    }
    if (!readyReplicas || readyReplicas < replicas) {
      throw new Error(`${name} readyReplicas is ${readyReplicas ?? "<missing>"}, expected ${replicas}`);
    }
    if (!image || !image.includes("@sha256:")) {
      throw new Error(`${name} image is not digest-pinned`);
    }
  }
  return "preview API, worker, and web deployments are ready and digest-pinned";
});

runCheck("preview-migration", () => {
  const migration = recordField(evidence, "migration");
  if (migration.completed !== true) {
    throw new Error("migration.completed is not true");
  }
  const image = stringField(migration, "image");
  if (!image || !image.includes("@sha256:")) {
    throw new Error("migration image is not digest-pinned");
  }
  return "preview migration hook completed with a digest-pinned image";
});

const ok = !results.some((result) => result.status === "failed");
console.log(JSON.stringify({
  ok,
  source: args.evidence,
  environment: stringField(evidence, "environment") ?? null,
  baseUrl: stringField(evidence, "baseUrl") ?? null,
  gitSha: stringField(evidence, "gitSha") ?? null,
  images: evidence.images ?? null,
  helm: evidence.helm ?? null,
  fixtures: evidence.fixtures ?? null,
  deployments: evidence.deployments ?? null,
  migration: evidence.migration ?? null,
  results,
}, null, 2));

if (!ok) {
  process.exit(1);
}

function validateImageDigests(record: Record<string, unknown>): void {
  const images = recordField(record, "images");
  for (const component of requiredDeployments) {
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

function runCheck(id: string, fn: () => string): void {
  try {
    results.push({ id, status: "passed", detail: fn() });
  } catch (error) {
    results.push({ id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
}

function parseEvidence(path: string): Record<string, unknown> {
  if (!path) {
    throw new Error("Set --evidence or OPENGENI_PREVIEW_DEPLOYMENT_EVIDENCE");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("preview deployment evidence must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    evidence: env.OPENGENI_PREVIEW_DEPLOYMENT_EVIDENCE ?? "",
    environment: env.OPENGENI_PREVIEW_DEPLOYMENT_ENVIRONMENT ?? "preview-pr",
    expectedGitSha: env.OPENGENI_PREVIEW_DEPLOYMENT_GIT_SHA ?? null,
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

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
