import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const gateStatuses = ["passed", "failed", "skipped"] as const;
const gateScopes = [
  "local",
  "preview",
  "staging",
  "production-canary",
  "customer-ready",
  "real-payments",
] as const;

type GateStatus = typeof gateStatuses[number];
type GateScope = typeof gateScopes[number];

const customerReadyExpandedScopes: GateScope[] = [
  "local",
  "preview",
  "staging",
  "production-canary",
  "real-payments",
  "customer-ready",
];

const mandatoryGateIdsByScope: Record<GateScope, string[]> = {
  local: [
    "local-check-workspace-billing",
  ],
  preview: [
    "preview-deployment",
    "preview-managed-smoke",
    "preview-stripe-checkout",
    "preview-conformance",
    "preview-usage-ledger",
    "preview-web-console-smoke",
  ],
  staging: [
    "staging-managed-smoke",
    "staging-stripe-checkout",
    "staging-conformance",
    "staging-usage-ledger",
    "staging-github-private-resource",
    "staging-breaking-unscoped-routes",
    "staging-web-console-smoke",
  ],
  "production-canary": [
    "production-canary",
  ],
  "real-payments": [
    "stripe-live-mode-readonly-preflight",
  ],
  "customer-ready": [
    "staging-load-soak",
    "staging-backup-restore",
    "staging-rollback",
    "staging-operational-readiness",
    "private-ops-boundary",
  ],
};

interface EvidenceManifest {
  releaseName: string;
  gitSha: string;
  imageTag?: string;
  images: Record<string, {
    image: string;
    digest: string;
  }>;
  gates: Array<{
    id: string;
    status: GateStatus;
    requiredFor: GateScope[];
    evidence: string[];
    detail?: string;
  }>;
}

interface Args {
  manifest: string;
  requireScopes: GateScope[];
  allowDifferentGitSha: boolean;
  allowDirty: boolean;
}

const args = parseArgs(process.argv.slice(2));
const failures: string[] = [];
const manifest = parseManifest(JSON.parse(readFileSync(args.manifest, "utf8")), failures);
const currentGitSha = gitSha();
const effectiveRequireScopes = expandRequireScopes(args.requireScopes);

if (!args.allowDifferentGitSha && manifest.gitSha !== currentGitSha) {
  failures.push(`manifest gitSha ${manifest.gitSha} does not match current HEAD ${currentGitSha}`);
}

if (!args.allowDirty && gitDirty()) {
  failures.push("working tree has uncommitted changes; commit or pass --allow-dirty for non-release dry-runs");
}

for (const [component, image] of Object.entries(manifest.images)) {
  if (!image.image.includes("@")) {
    failures.push(`image ${component} is not digest-pinned in image field: ${image.image}`);
  }
  if (!image.image.endsWith(`@${image.digest}`)) {
    failures.push(`image ${component} digest field does not match image ref`);
  }
}

const requireScopes = new Set(effectiveRequireScopes);
const gateIds = new Set<string>();
for (const gate of manifest.gates) {
  if (gateIds.has(gate.id)) {
    failures.push(`duplicate gate id ${gate.id}`);
  }
  gateIds.add(gate.id);
  const required = gate.requiredFor.some((scope) => requireScopes.has(scope));
  if (!required) {
    continue;
  }
  if (gate.status !== "passed") {
    failures.push(`required gate ${gate.id} is ${gate.status}${gate.detail ? `: ${gate.detail}` : ""}`);
  }
  if (gate.evidence.length === 0) {
    failures.push(`required gate ${gate.id} has no evidence files`);
  }
  for (const path of gate.evidence) {
    if (!existsSync(path)) {
      failures.push(`required gate ${gate.id} evidence file does not exist: ${path}`);
      continue;
    }
    const evidenceFailure = failedJsonEvidence(path, gate, manifest);
    if (evidenceFailure) {
      failures.push(`required gate ${gate.id} evidence ${path} failed: ${evidenceFailure}`);
    }
  }
  if (gate.id === "production-canary" && gate.status === "passed" && gate.evidence.every((path) => !path.endsWith(".json"))) {
    failures.push("required gate production-canary must include structured JSON canary evidence");
  }
}

for (const gateId of mandatoryGateIdsFor(effectiveRequireScopes)) {
  const gate = manifest.gates.find((candidate) => candidate.id === gateId);
  if (!gate) {
    failures.push(`required scopes ${effectiveRequireScopes.join(",")} are missing mandatory gate ${gateId}`);
    continue;
  }
  if (!gate.requiredFor.some((scope) => requireScopes.has(scope))) {
    failures.push(`mandatory gate ${gateId} is not marked required for any requested scope (${effectiveRequireScopes.join(",")})`);
  }
}

if (failures.length > 0) {
  console.error("Release evidence check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  releaseName: manifest.releaseName,
  gitSha: manifest.gitSha,
  requestedScopes: args.requireScopes,
  requiredScopes: effectiveRequireScopes,
  gatesChecked: manifest.gates.filter((gate) => gate.requiredFor.some((scope) => requireScopes.has(scope))).map((gate) => gate.id),
}, null, 2));

function parseArgs(values: string[]): Args {
  const out: Args = {
    manifest: process.env.OPENGENI_RELEASE_EVIDENCE_MANIFEST ?? "",
    requireScopes: parseScopes(process.env.OPENGENI_RELEASE_EVIDENCE_REQUIRE ?? "local,staging"),
    allowDifferentGitSha: false,
    allowDirty: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--manifest") {
      out.manifest = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--require") {
      out.requireScopes = parseScopes(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--allow-different-git-sha") {
      out.allowDifferentGitSha = true;
      continue;
    }
    if (value === "--allow-dirty") {
      out.allowDirty = true;
      continue;
    }
    if (value.startsWith("--manifest=")) {
      out.manifest = value.slice("--manifest=".length);
      continue;
    }
    if (value.startsWith("--require=")) {
      out.requireScopes = parseScopes(value.slice("--require=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.manifest) {
    throw new Error("Set --manifest or OPENGENI_RELEASE_EVIDENCE_MANIFEST");
  }
  if (out.requireScopes.length === 0) {
    throw new Error("--require must include at least one scope");
  }
  return out;
}

function parseScopes(value: string): GateScope[] {
  const scopes = value.split(",").map((scope) => scope.trim()).filter(Boolean);
  return scopes.map((scope) => {
    if (!isGateScope(scope)) {
      throw new Error(`Unknown release evidence scope: ${scope}`);
    }
    return scope;
  });
}

function expandRequireScopes(scopes: GateScope[]): GateScope[] {
  const out = new Set<GateScope>();
  for (const scope of scopes) {
    if (scope === "customer-ready") {
      for (const expanded of customerReadyExpandedScopes) {
        out.add(expanded);
      }
      continue;
    }
    out.add(scope);
  }
  return [...out];
}

function mandatoryGateIdsFor(scopes: GateScope[]): string[] {
  const ids = new Set<string>();
  for (const scope of scopes) {
    for (const id of mandatoryGateIdsByScope[scope]) {
      ids.add(id);
    }
  }
  return [...ids];
}

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function gitDirty(): boolean {
  const result = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git status --porcelain failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim().length > 0;
}

function failedJsonEvidence(path: string, gate: EvidenceManifest["gates"][number], manifest: EvidenceManifest): string | null {
  if (!path.endsWith(".json")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (parsed && typeof parsed === "object" && "ok" in parsed && parsed.ok === false) {
    return "top-level ok is false";
  }
  if (parsed && typeof parsed === "object" && "results" in parsed && Array.isArray(parsed.results)) {
    const failed = parsed.results.filter((result) => result && typeof result === "object" && "status" in result && result.status === "failed");
    if (failed.length > 0) {
      return `${failed.length} result(s) are failed`;
    }
  }
  if (gate.id === "production-canary") {
    return productionCanaryEvidenceFailure(parsed, manifest);
  }
  if (gate.id === "preview-deployment") {
    return previewDeploymentEvidenceFailure(parsed, manifest);
  }
  return null;
}

function previewDeploymentEvidenceFailure(parsed: unknown, manifest: EvidenceManifest): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "preview deployment evidence must be a JSON object";
  }
  const record = parsed as Record<string, unknown>;
  const environment = stringValue(record.environment);
  if (environment !== "preview-pr" && environment !== "preview-branch") {
    return `preview deployment environment is ${environment ?? "<missing>"}, expected preview-pr or preview-branch`;
  }
  const baseUrl = stringValue(record.baseUrl);
  if (!baseUrl) {
    return "preview deployment baseUrl is missing";
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "https:") {
      return `preview deployment baseUrl must be https, got ${parsedUrl.protocol}`;
    }
  } catch (error) {
    return `preview deployment baseUrl is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  const gitSha = stringValue(record.gitSha);
  if (gitSha !== manifest.gitSha) {
    return `preview deployment gitSha ${gitSha ?? "<missing>"} does not match manifest ${manifest.gitSha}`;
  }
  const imageFailure = productionCanaryImageFailure(record.images, manifest.images);
  if (imageFailure) {
    return imageFailure.replace("production canary", "preview deployment");
  }
  const helm = objectValue(record.helm);
  if (stringValue(helm.status) !== "deployed") {
    return `preview deployment helm.status is ${stringValue(helm.status) ?? "<missing>"}, expected deployed`;
  }
  const valuesFiles = Array.isArray(helm.valuesFiles) ? helm.valuesFiles.filter((value): value is string => typeof value === "string") : [];
  if (!valuesFiles.includes("deploy/helm/opengeni/values.preview-managed.example.yaml")) {
    return "preview deployment did not prove values.preview-managed.example.yaml was applied";
  }
  if (!valuesFiles.some((path) => path.endsWith("/helm-values.generated.yaml") || path === "helm-values.generated.yaml")) {
    return "preview deployment did not prove generated runtime Helm values were applied";
  }
  const fixtures = objectValue(record.fixtures);
  for (const fixture of ["postgres", "temporal", "nats", "minio"]) {
    if (fixtures[fixture] !== true) {
      return `preview deployment fixture ${fixture} is not enabled`;
    }
  }
  const deployments = objectValue(record.deployments);
  for (const component of ["api", "worker", "web"]) {
    const deployment = objectValue(deployments[component]);
    const ready = numberValue(deployment.readyReplicas);
    const replicas = numberValue(deployment.replicas);
    const image = stringValue(deployment.image);
    if (!replicas || replicas < 1) {
      return `preview deployment ${component} replicas is ${replicas ?? "<missing>"}`;
    }
    if (!ready || ready < replicas) {
      return `preview deployment ${component} readyReplicas is ${ready ?? "<missing>"}, expected ${replicas}`;
    }
    if (!image || !image.includes("@sha256:")) {
      return `preview deployment ${component} image is not digest-pinned`;
    }
  }
  const migration = objectValue(record.migration);
  if (migration.completed !== true) {
    return "preview deployment migration.completed is not true";
  }
  const migrationImage = stringValue(migration.image);
  if (!migrationImage || !migrationImage.includes("@sha256:")) {
    return "preview deployment migration image is not digest-pinned";
  }
  return null;
}

function productionCanaryEvidenceFailure(parsed: unknown, manifest: EvidenceManifest): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "production canary evidence must be a JSON object";
  }
  const record = parsed as Record<string, unknown>;
  const environment = stringValue(record.environment);
  if (environment !== "production") {
    return `production canary environment is ${environment ?? "<missing>"}, expected production`;
  }
  const baseUrl = stringValue(record.baseUrl);
  if (!baseUrl) {
    return "production canary baseUrl is missing";
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "https:") {
      return `production canary baseUrl must be https, got ${parsedUrl.protocol}`;
    }
  } catch (error) {
    return `production canary baseUrl is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  const gitSha = stringValue(record.gitSha);
  if (gitSha !== manifest.gitSha) {
    return `production canary gitSha ${gitSha ?? "<missing>"} does not match manifest ${manifest.gitSha}`;
  }
  const imageFailure = productionCanaryImageFailure(record.images, manifest.images);
  if (imageFailure) {
    return imageFailure;
  }
  const required = [
    "production-deployment",
    "production-health",
    "managed-canary-smoke",
    "production-conformance",
    "billing-readonly",
    "observability-canary",
    "rollback-readiness",
  ];
  const results = Array.isArray(record.results) ? record.results : Array.isArray(record.checks) ? record.checks : [];
  for (const id of required) {
    const check = results.find((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
    if (!check) {
      return `production canary evidence is missing ${id}`;
    }
    if (check.status !== "passed") {
      return `production canary check ${id} is ${stringValue(check.status) ?? "<missing>"}`;
    }
  }
  return null;
}

function productionCanaryImageFailure(raw: unknown, manifestImages: EvidenceManifest["images"]): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "production canary images must be an object";
  }
  const images = raw as Record<string, unknown>;
  for (const component of ["api", "worker", "web"]) {
    const manifestImage = manifestImages[component];
    if (!manifestImage) {
      return `manifest is missing ${component} image required for production canary`;
    }
    const image = images[component];
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      return `production canary image ${component} is missing`;
    }
    const digest = stringValue((image as Record<string, unknown>).digest);
    if (digest !== manifestImage.digest) {
      return `production canary image ${component} digest ${digest ?? "<missing>"} does not match manifest ${manifestImage.digest}`;
    }
    const ref = stringValue((image as Record<string, unknown>).image);
    if (!ref || !ref.endsWith(`@${digest}`)) {
      return `production canary image ${component} is not digest-pinned`;
    }
  }
  return null;
}

function parseManifest(raw: unknown, failures: string[]): EvidenceManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    failures.push("manifest must be an object");
    return emptyManifest();
  }
  const record = raw as Record<string, unknown>;
  const releaseName = stringValue(record.releaseName);
  if (!releaseName) {
    failures.push("manifest releaseName must be a non-empty string");
  }
  const gitSha = stringValue(record.gitSha);
  if (!gitSha || !/^[0-9a-f]{7,40}$/.test(gitSha)) {
    failures.push("manifest gitSha must be a 7-40 character lowercase hex SHA");
  }
  const images = parseImages(record.images, failures);
  const gates = parseGates(record.gates, failures);
  const imageTag = stringValue(record.imageTag);
  return {
    releaseName: releaseName || "<invalid>",
    gitSha: gitSha || "0000000",
    ...(imageTag ? { imageTag } : {}),
    images,
    gates,
  };
}

function parseImages(raw: unknown, failures: string[]): EvidenceManifest["images"] {
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    failures.push("manifest images must be an object when present");
    return {};
  }
  const images: EvidenceManifest["images"] = {};
  for (const [component, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      failures.push(`image ${component} must be an object`);
      continue;
    }
    const image = stringValue((value as Record<string, unknown>).image);
    const digest = stringValue((value as Record<string, unknown>).digest);
    if (!image) {
      failures.push(`image ${component}.image must be a non-empty string`);
    }
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      failures.push(`image ${component}.digest must be a sha256 digest`);
    }
    images[component] = { image: image || "<invalid>", digest: digest || "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
  }
  return images;
}

function parseGates(raw: unknown, failures: string[]): EvidenceManifest["gates"] {
  if (!Array.isArray(raw) || raw.length === 0) {
    failures.push("manifest gates must be a non-empty array");
    return [];
  }
  const gates: EvidenceManifest["gates"] = [];
  for (const [index, gate] of raw.entries()) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      failures.push(`gate ${index} must be an object`);
      continue;
    }
    const record = gate as Record<string, unknown>;
    const id = stringValue(record.id);
    if (!id) {
      failures.push(`gate ${index}.id must be a non-empty string`);
    }
    const status = stringValue(record.status);
    if (!isGateStatus(status)) {
      failures.push(`gate ${id || index}.status must be passed, failed, or skipped`);
    }
    const requiredFor = Array.isArray(record.requiredFor)
      ? record.requiredFor.flatMap((scope) => {
        const value = stringValue(scope);
        if (isGateScope(value)) {
          return [value];
        }
        failures.push(`gate ${id || index}.requiredFor contains unknown scope ${value || "<invalid>"}`);
        return [];
      })
      : [];
    if (requiredFor.length === 0) {
      failures.push(`gate ${id || index}.requiredFor must include at least one scope`);
    }
    const evidence = record.evidence === undefined
      ? []
      : Array.isArray(record.evidence)
        ? record.evidence.flatMap((path) => {
          const value = stringValue(path);
          return value ? [value] : [];
        })
        : [];
    if (record.evidence !== undefined && !Array.isArray(record.evidence)) {
      failures.push(`gate ${id || index}.evidence must be an array when present`);
    }
    const detail = stringValue(record.detail);
    gates.push({
      id: id || `<invalid-${index}>`,
      status: isGateStatus(status) ? status : "failed",
      requiredFor,
      evidence,
      ...(detail ? { detail } : {}),
    });
  }
  return gates;
}

function emptyManifest(): EvidenceManifest {
  return { releaseName: "<invalid>", gitSha: "0000000", images: {}, gates: [] };
}

function isGateStatus(value: unknown): value is GateStatus {
  return typeof value === "string" && gateStatuses.includes(value as GateStatus);
}

function isGateScope(value: unknown): value is GateScope {
  return typeof value === "string" && gateScopes.includes(value as GateScope);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}
