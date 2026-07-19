import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  NUMERIC_PERFORMANCE_BUDGETS,
  REAL_DEVICE_REQUIREMENTS,
  TIMING_SENSITIVE_REQUIREMENTS,
  WORKBENCH_ACCEPTANCE_REQUIREMENTS,
  type AcceptanceEnvironment,
} from "./workbench-acceptance-contract";

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const requiredImages = ["api", "worker", "web", "relay", "migration"] as const;
const forbiddenKeyPattern =
  /^(authorization|cookie|password|secret|api[_-]?key|access[_-]?token|signed[_-]?url)$/i;
const forbiddenValuePatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /(?:^|[?&])(sig|signature|token|se|sp|sv)=[^&\s]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

type ImageDigests = Record<(typeof requiredImages)[number], string>;

export type EvidenceRef = {
  url: string;
  sha256: string;
  artifact: string;
};

export type AcceptanceMeasurement = {
  unit: "ms" | "fps" | "score" | "bytes";
  sampleCount: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  worst: number;
};

export type AcceptanceResult = {
  requirementId: string;
  environment: AcceptanceEnvironment;
  status: "passed";
  observedAt: string;
  detail: string;
  attempts: number;
  retries: 0;
  skipped: 0;
  evidence: EvidenceRef[];
  repetitions?: number;
  seed?: string;
  device?: {
    real: boolean;
    name: string;
    os: string;
    osVersion: string;
    browser: string;
    browserVersion: string;
    viewport: string;
    input: string;
    assistiveTechnology?: string;
  };
  measurement?: AcceptanceMeasurement;
};

export type WorkbenchAcceptanceBundle = {
  schemaVersion: 1;
  generatedAt: string;
  candidate: { sourceSha: string; imageDigests: ImageDigests };
  staging: {
    sourceSha: string;
    imageDigests: ImageDigests;
    deploymentUrl: string;
    evidenceUrl: string;
  };
  production: {
    sourceSha: string;
    imageDigests: ImageDigests;
    deploymentUrl: string;
    evidenceUrl: string;
  };
  productionCanary: {
    sourceSha: string;
    startedAt: string;
    endedAt: string;
    expectedCycles: number;
    passedCycles: number;
    failedCycles: 0;
    skippedCycles: 0;
    missingCycles: 0;
    lateCycles: 0;
    sloBreaches: 0;
    evidenceUrl: string;
    evidence: EvidenceRef[];
  };
  knownDefects: [];
  visualPasses: {
    desktop: VisualPass[];
    mobile: VisualPass[];
  };
  results: AcceptanceResult[];
};

export type VisualPass = {
  pass: number;
  observedAt: string;
  reviewer: string;
  resolvedDefects: string[];
  before: EvidenceRef[];
  after: EvidenceRef[];
};

export type AcceptanceBundleExpectations = {
  sourceSha: string;
  stagingEvidenceUrl?: string;
  productionEvidenceUrl?: string;
  productionCanaryEvidenceUrl?: string;
};

export function validateWorkbenchAcceptanceBundle(
  value: unknown,
  expected: AcceptanceBundleExpectations,
): WorkbenchAcceptanceBundle {
  const errors: string[] = [];
  const bundle = record(value, "bundle", errors) as Partial<WorkbenchAcceptanceBundle>;

  if (!shaPattern.test(expected.sourceSha)) {
    errors.push("expected source SHA must be 40 lowercase hexadecimal characters");
  }
  if (bundle.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  isoDate(bundle.generatedAt, "generatedAt", errors);
  scanForSecrets(value, "$", errors);

  const candidate = record(bundle.candidate, "candidate", errors);
  const candidateSha = string(candidate.sourceSha, "candidate.sourceSha", errors);
  if (candidateSha !== expected.sourceSha) {
    errors.push(`candidate.sourceSha must equal expected source ${expected.sourceSha}`);
  }
  const candidateImages = imageDigests(candidate.imageDigests, "candidate.imageDigests", errors);

  const staging = environmentBinding(bundle.staging, "staging", expected.sourceSha, errors);
  const production = environmentBinding(
    bundle.production,
    "production",
    expected.sourceSha,
    errors,
  );
  if (candidateImages && staging?.imageDigests) {
    sameImages(candidateImages, staging.imageDigests, "candidate and staging", errors);
  }
  if (candidateImages && production?.imageDigests) {
    sameImages(candidateImages, production.imageDigests, "candidate and production", errors);
  }
  if (staging?.imageDigests && production?.imageDigests) {
    sameImages(staging.imageDigests, production.imageDigests, "staging and production", errors);
  }
  if (expected.stagingEvidenceUrl && staging?.evidenceUrl !== expected.stagingEvidenceUrl) {
    errors.push("staging.evidenceUrl does not match the release input");
  }
  if (
    expected.productionEvidenceUrl &&
    production?.evidenceUrl !== expected.productionEvidenceUrl
  ) {
    errors.push("production.evidenceUrl does not match the release input");
  }

  if (!Array.isArray(bundle.knownDefects) || bundle.knownDefects.length !== 0) {
    errors.push("knownDefects must be an empty array");
  }

  validateCanary(
    bundle.productionCanary,
    expected.sourceSha,
    expected.productionCanaryEvidenceUrl,
    errors,
  );
  validateVisualPasses(bundle.visualPasses, errors);
  validateResults(bundle.results, errors);

  if (errors.length > 0) {
    throw new Error(
      `workbench acceptance bundle is invalid (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n- ${errors.join("\n- ")}`,
    );
  }
  return value as WorkbenchAcceptanceBundle;
}

function environmentBinding(
  value: unknown,
  name: "staging" | "production",
  expectedSha: string,
  errors: string[],
): { sourceSha: string; imageDigests: ImageDigests | null; evidenceUrl: string } | null {
  const item = record(value, name, errors);
  const sourceSha = string(item.sourceSha, `${name}.sourceSha`, errors);
  if (sourceSha !== expectedSha) errors.push(`${name}.sourceSha must equal ${expectedSha}`);
  const images = imageDigests(item.imageDigests, `${name}.imageDigests`, errors);
  httpsUrl(item.deploymentUrl, `${name}.deploymentUrl`, errors);
  const evidenceUrl = httpsUrl(item.evidenceUrl, `${name}.evidenceUrl`, errors);
  return { sourceSha, imageDigests: images, evidenceUrl };
}

function validateCanary(
  value: unknown,
  sourceSha: string,
  expectedUrl: string | undefined,
  errors: string[],
): void {
  const canary = record(value, "productionCanary", errors);
  if (string(canary.sourceSha, "productionCanary.sourceSha", errors) !== sourceSha) {
    errors.push(`productionCanary.sourceSha must equal ${sourceSha}`);
  }
  const startedAt = isoDate(canary.startedAt, "productionCanary.startedAt", errors);
  const endedAt = isoDate(canary.endedAt, "productionCanary.endedAt", errors);
  if (startedAt !== null && endedAt !== null && endedAt - startedAt < 72 * 60 * 60 * 1000) {
    errors.push("production canary window must span at least 72 hours");
  }
  const expectedCycles = positiveInteger(
    canary.expectedCycles,
    "productionCanary.expectedCycles",
    errors,
  );
  const passedCycles = positiveInteger(
    canary.passedCycles,
    "productionCanary.passedCycles",
    errors,
  );
  if (expectedCycles !== null && passedCycles !== null && passedCycles !== expectedCycles) {
    errors.push("production canary passedCycles must equal expectedCycles");
  }
  if (expectedCycles !== null && expectedCycles < 72) {
    errors.push("production canary must contain at least 72 scheduled cycles");
  }
  for (const field of [
    "failedCycles",
    "skippedCycles",
    "missingCycles",
    "lateCycles",
    "sloBreaches",
  ] as const) {
    if (canary[field] !== 0) errors.push(`productionCanary.${field} must be 0`);
  }
  const url = httpsUrl(canary.evidenceUrl, "productionCanary.evidenceUrl", errors);
  if (expectedUrl && url !== expectedUrl) {
    errors.push("productionCanary.evidenceUrl does not match the release input");
  }
  evidenceRefs(canary.evidence, "productionCanary.evidence", errors);
}

function validateVisualPasses(value: unknown, errors: string[]): void {
  const passes = record(value, "visualPasses", errors);
  for (const kind of ["desktop", "mobile"] as const) {
    const items = Array.isArray(passes[kind]) ? passes[kind] : [];
    if (!Array.isArray(passes[kind])) errors.push(`visualPasses.${kind} must be an array`);
    if (items.length < 10) errors.push(`visualPasses.${kind} must contain at least 10 passes`);
    const numbers = new Set<number>();
    for (const [index, raw] of items.entries()) {
      const path = `visualPasses.${kind}[${index}]`;
      const item = record(raw, path, errors);
      const pass = positiveInteger(item.pass, `${path}.pass`, errors);
      if (pass !== null) {
        if (numbers.has(pass)) errors.push(`${path}.pass duplicates pass ${pass}`);
        numbers.add(pass);
      }
      isoDate(item.observedAt, `${path}.observedAt`, errors);
      nonempty(item.reviewer, `${path}.reviewer`, errors);
      if (!Array.isArray(item.resolvedDefects)) {
        errors.push(`${path}.resolvedDefects must be an array`);
      } else if (item.resolvedDefects.length === 0) {
        errors.push(`${path}.resolvedDefects must contain at least one resolved defect`);
      } else {
        for (const [defectIndex, defect] of item.resolvedDefects.entries()) {
          nonempty(defect, `${path}.resolvedDefects[${defectIndex}]`, errors);
        }
      }
      evidenceRefs(item.before, `${path}.before`, errors);
      evidenceRefs(item.after, `${path}.after`, errors);
      if (sameEvidenceRefs(item.before, item.after)) {
        errors.push(`${path}.before and ${path}.after must reference distinct evidence`);
      }
    }
    for (let pass = 1; pass <= 10; pass += 1) {
      if (!numbers.has(pass)) errors.push(`visualPasses.${kind} is missing pass ${pass}`);
    }
  }
}

function validateResults(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("results must be an array");
    return;
  }
  const byKey = new Map<string, AcceptanceResult>();
  for (const [index, raw] of value.entries()) {
    const path = `results[${index}]`;
    const item = record(raw, path, errors);
    const requirementId = string(item.requirementId, `${path}.requirementId`, errors);
    const environment = item.environment;
    if (
      environment !== "staging" &&
      environment !== "production" &&
      environment !== "cross-environment"
    ) {
      errors.push(`${path}.environment is invalid`);
      continue;
    }
    const key = `${requirementId}@${environment}`;
    if (byKey.has(key)) errors.push(`duplicate acceptance result ${key}`);
    byKey.set(key, item as AcceptanceResult);
    if (item.status !== "passed") errors.push(`${key} status must be passed`);
    isoDate(item.observedAt, `${path}.observedAt`, errors);
    nonempty(item.detail, `${path}.detail`, errors);
    if (item.attempts !== 1) errors.push(`${key} attempts must be exactly 1`);
    if (item.retries !== 0) errors.push(`${key} retries must be 0`);
    if (item.skipped !== 0) errors.push(`${key} skipped must be 0`);
    evidenceRefs(item.evidence, `${path}.evidence`, errors);

    if (TIMING_SENSITIVE_REQUIREMENTS.has(requirementId)) {
      if (!Number.isInteger(item.repetitions) || (item.repetitions as number) < 100) {
        errors.push(`${key} must record at least 100 consecutive repetitions`);
      }
      nonempty(item.seed, `${path}.seed`, errors);
    }
    if (REAL_DEVICE_REQUIREMENTS.has(requirementId)) {
      validateRealDevice(item.device, `${path}.device`, errors);
    }
    const budget = NUMERIC_PERFORMANCE_BUDGETS[requirementId];
    if (budget) validateMeasurement(item.measurement, budget, key, errors);
  }

  const allowedKeys = new Set(
    WORKBENCH_ACCEPTANCE_REQUIREMENTS.flatMap((item) =>
      item.environments.map((environment) => `${item.id}@${environment}`),
    ),
  );
  for (const key of byKey.keys()) {
    if (!allowedKeys.has(key)) errors.push(`unexpected acceptance result ${key}`);
  }
  for (const requirement of WORKBENCH_ACCEPTANCE_REQUIREMENTS) {
    for (const environment of requirement.environments) {
      const key = `${requirement.id}@${environment}`;
      if (!byKey.has(key)) errors.push(`missing acceptance result ${key}`);
    }
  }
}

function validateMeasurement(
  value: unknown,
  budget: (typeof NUMERIC_PERFORMANCE_BUDGETS)[string],
  key: string,
  errors: string[],
): void {
  const measurement = record(value, `${key}.measurement`, errors);
  if (measurement.unit !== budget.unit) {
    errors.push(`${key} measurement unit must be ${budget.unit}`);
  }
  const minimumSamples = budget.unit === "bytes" ? 1 : 100;
  if (
    !Number.isInteger(measurement.sampleCount) ||
    (measurement.sampleCount as number) < minimumSamples
  ) {
    errors.push(`${key} measurement must contain at least ${minimumSamples} samples`);
  }
  for (const field of ["p50", "p75", "p95", "p99", "worst"] as const) {
    if (
      typeof measurement[field] !== "number" ||
      !Number.isFinite(measurement[field]) ||
      measurement[field] < 0
    ) {
      errors.push(`${key} measurement.${field} must be finite and nonnegative`);
    }
  }
  const ordered = [
    measurement.p50,
    measurement.p75,
    measurement.p95,
    measurement.p99,
    measurement.worst,
  ];
  if (ordered.every((observed) => typeof observed === "number" && Number.isFinite(observed))) {
    const direction = budget.direction === "maximum" ? 1 : -1;
    for (let index = 1; index < ordered.length; index += 1) {
      if ((ordered[index]! - ordered[index - 1]!) * direction < 0) {
        errors.push(
          `${key} measurement percentiles and worst value are not ordered for a ${budget.direction} budget`,
        );
        break;
      }
    }
  }
  const observed = measurement[budget.statistic];
  if (typeof observed !== "number" || !Number.isFinite(observed)) return;
  if (budget.direction === "maximum" && observed > budget.limit) {
    errors.push(`${key} ${budget.statistic} ${observed} exceeds ${budget.limit} ${budget.unit}`);
  }
  if (budget.direction === "minimum" && observed < budget.limit) {
    errors.push(`${key} ${budget.statistic} ${observed} is below ${budget.limit} ${budget.unit}`);
  }
}

function validateRealDevice(value: unknown, path: string, errors: string[]): void {
  const device = record(value, path, errors);
  if (device.real !== true) errors.push(`${path}.real must be true (emulation is insufficient)`);
  for (const field of [
    "name",
    "os",
    "osVersion",
    "browser",
    "browserVersion",
    "viewport",
    "input",
  ]) {
    nonempty(device[field], `${path}.${field}`, errors);
  }
}

function imageDigests(value: unknown, path: string, errors: string[]): ImageDigests | null {
  const images = record(value, path, errors);
  const output = {} as ImageDigests;
  for (const name of requiredImages) {
    const digest = string(images[name], `${path}.${name}`, errors);
    if (!digestPattern.test(digest)) errors.push(`${path}.${name} must be a sha256 image digest`);
    output[name] = digest;
  }
  return output;
}

function sameImages(
  left: ImageDigests,
  right: ImageDigests,
  label: string,
  errors: string[],
): void {
  for (const name of requiredImages) {
    if (left[name] !== right[name]) errors.push(`${label} ${name} image digests differ`);
  }
}

function evidenceRefs(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must contain at least one immutable evidence reference`);
    return;
  }
  for (const [index, raw] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const item = record(raw, itemPath, errors);
    httpsUrl(item.url, `${itemPath}.url`, errors);
    const sha256 = string(item.sha256, `${itemPath}.sha256`, errors);
    if (!hashPattern.test(sha256)) errors.push(`${itemPath}.sha256 must be lowercase SHA-256`);
    nonempty(item.artifact, `${itemPath}.artifact`, errors);
  }
}

function sameEvidenceRefs(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
    return false;
  }
  const identities = (items: unknown[]) =>
    items
      .map((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
        const item = raw as Record<string, unknown>;
        return `${String(item.url ?? "")}\u0000${String(item.sha256 ?? "")}\u0000${String(item.artifact ?? "")}`;
      })
      .sort();
  const leftIdentities = identities(left);
  const rightIdentities = identities(right);
  return (
    leftIdentities.length === rightIdentities.length &&
    leftIdentities.every((identity, index) => identity === rightIdentities[index])
  );
}

function httpsUrl(value: unknown, path: string, errors: string[]): string {
  const text = string(value, path, errors);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") errors.push(`${path} must use HTTPS`);
    if (url.username || url.password || url.search || url.hash) {
      errors.push(`${path} must not contain credentials, query parameters, or fragments`);
    }
  } catch {
    errors.push(`${path} must be an absolute URL`);
  }
  return text;
}

function record(value: unknown, path: string, errors: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  return value as Record<string, any>;
}

function string(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return "";
  }
  return value;
}

function nonempty(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function isoDate(value: unknown, path: string, errors: string[]): number | null {
  const text = string(value, path, errors);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    errors.push(`${path} must be an ISO timestamp`);
    return null;
  }
  return timestamp;
}

function positiveInteger(value: unknown, path: string, errors: string[]): number | null {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    errors.push(`${path} must be a positive integer`);
    return null;
  }
  return value as number;
}

function scanForSecrets(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeyPattern.test(key)) errors.push(`${path}.${key} is a forbidden secret field`);
      scanForSecrets(item, `${path}.${key}`, errors);
    }
    return;
  }
  if (typeof value === "string") {
    for (const pattern of forbiddenValuePatterns) {
      if (pattern.test(value)) {
        errors.push(`${path} appears to contain secret material`);
        break;
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const raw = await readFile(resolve(args.bundle), "utf8");
  if (raw.length > 20 * 1024 * 1024) throw new Error("acceptance bundle exceeds 20 MiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("acceptance bundle is not valid JSON", { cause: error });
  }
  const bundle = validateWorkbenchAcceptanceBundle(parsed, {
    sourceSha: args.sourceSha,
    ...(args.stagingEvidenceUrl ? { stagingEvidenceUrl: args.stagingEvidenceUrl } : {}),
    ...(args.productionEvidenceUrl ? { productionEvidenceUrl: args.productionEvidenceUrl } : {}),
    ...(args.productionCanaryEvidenceUrl
      ? { productionCanaryEvidenceUrl: args.productionCanaryEvidenceUrl }
      : {}),
  });
  console.log(
    JSON.stringify({
      ok: true,
      sourceSha: bundle.candidate.sourceSha,
      resultCount: bundle.results.length,
      desktopVisualPasses: bundle.visualPasses.desktop.length,
      mobileVisualPasses: bundle.visualPasses.mobile.length,
      productionCanaryCycles: bundle.productionCanary.passedCycles,
    }),
  );
}

function parseArgs(values: string[]): {
  bundle: string;
  sourceSha: string;
  stagingEvidenceUrl: string | null;
  productionEvidenceUrl: string | null;
  productionCanaryEvidenceUrl: string | null;
} {
  const output = {
    bundle: "",
    sourceSha: "",
    stagingEvidenceUrl: null as string | null,
    productionEvidenceUrl: null as string | null,
    productionCanaryEvidenceUrl: null as string | null,
  };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const next = () => {
      const value = values[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--bundle") output.bundle = next();
    else if (flag === "--source-sha") output.sourceSha = next();
    else if (flag === "--staging-evidence-url") output.stagingEvidenceUrl = next();
    else if (flag === "--production-evidence-url") output.productionEvidenceUrl = next();
    else if (flag === "--production-canary-evidence-url") {
      output.productionCanaryEvidenceUrl = next();
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!output.bundle) throw new Error("--bundle is required");
  if (!output.sourceSha) throw new Error("--source-sha is required");
  return output;
}

if (import.meta.main) await main();
