import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

interface Args {
  opsRepo: string;
  publicWorkflowRoot: string;
  opsRepoJson: string | null;
  environmentsJson: string | null;
  deploymentEvidenceJson: string | null;
  oidcFederatedCredentialJson: string | null;
  workflowRunJson: string | null;
  evidenceFiles: string[];
  outFile: string;
  oidcTrustScoped: boolean;
  artifactDigestPinned: boolean;
  secretScanPassed: boolean;
}

const requiredEnvironments = ["preview", "staging", "production"];
const args = parseArgs(process.argv.slice(2), process.env);
const repo = args.opsRepoJson ? parseJsonFile(args.opsRepoJson) : ghJson(["repo", "view", args.opsRepo, "--json", "isPrivate,nameWithOwner"]);
const environmentsPayload = args.environmentsJson
  ? parseJsonFile(args.environmentsJson)
  : ghJson(["api", `repos/${args.opsRepo}/environments`]);
const deploymentEvidence = args.deploymentEvidenceJson ? parseJsonFile(args.deploymentEvidenceJson) : null;
const oidcCredential = args.oidcFederatedCredentialJson ? parseJsonFile(args.oidcFederatedCredentialJson) : null;
const workflowRun = args.workflowRunJson ? parseJsonFile(args.workflowRunJson) : null;
const workflowScan = scanPublicWorkflows(args.publicWorkflowRoot);
const environmentNames = extractEnvironmentNames(environmentsPayload);
const deploymentProof = validateDeploymentEvidence(deploymentEvidence, args.opsRepo);
const oidcProof = validateOidcFederatedCredential(oidcCredential, args.opsRepo, "staging");
const workflowProof = validateWorkflowRun(workflowRun);
const metrics = {
  deployedByPrivateOps: repo.isPrivate === true && deploymentProof.valid,
  publicPrSecretsBlocked: workflowScan.pullRequestTargetFiles.length === 0 && workflowScan.pullRequestSecretFiles.length === 0,
  environmentSecretsScoped: requiredEnvironments.every((environment) => environmentNames.includes(environment)),
  oidcTrustScoped: args.oidcTrustScoped || oidcProof.valid,
  artifactDigestPinned: args.artifactDigestPinned || (deploymentProof.valid && workflowProof.digestPinned),
  secretScanPassed: args.secretScanPassed,
  opsRepo: repo.nameWithOwner ?? args.opsRepo,
  opsRepoPrivate: repo.isPrivate === true,
  deploymentEvidenceValid: deploymentProof.valid,
  deploymentEvidenceDetail: deploymentProof.detail,
  oidcEvidenceValid: oidcProof.valid,
  oidcEvidenceDetail: oidcProof.detail,
  workflowRunSucceeded: workflowProof.succeeded,
  workflowDigestStepsSucceeded: workflowProof.digestPinned,
  environments: environmentNames,
  publicWorkflowRoot: args.publicWorkflowRoot,
  pullRequestTargetFiles: workflowScan.pullRequestTargetFiles,
  pullRequestSecretFiles: workflowScan.pullRequestSecretFiles,
};
const ok = metrics.deployedByPrivateOps
  && metrics.publicPrSecretsBlocked
  && metrics.environmentSecretsScoped
  && metrics.oidcTrustScoped
  && metrics.artifactDigestPinned
  && metrics.secretScanPassed;
const output = {
  ok,
  checks: [{
    id: "private-ops-boundary",
    status: ok ? "passed" : "failed",
    detail: ok ? "private ops boundary verified" : "private ops boundary evidence is incomplete",
    evidence: [
      ...(args.opsRepoJson ? [args.opsRepoJson] : []),
      ...(args.environmentsJson ? [args.environmentsJson] : []),
      ...(args.deploymentEvidenceJson ? [args.deploymentEvidenceJson] : []),
      ...(args.oidcFederatedCredentialJson ? [args.oidcFederatedCredentialJson] : []),
      ...(args.workflowRunJson ? [args.workflowRunJson] : []),
      ...args.evidenceFiles,
      args.publicWorkflowRoot,
    ],
    metrics,
  }],
};

await mkdir(dirname(args.outFile), { recursive: true });
await Bun.write(args.outFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));

if (!ok) {
  process.exit(1);
}
process.exit(0);

function scanPublicWorkflows(root: string): { pullRequestTargetFiles: string[]; pullRequestSecretFiles: string[] } {
  if (!existsSync(root)) {
    throw new Error(`workflow root does not exist: ${root}`);
  }
  const pullRequestTargetFiles: string[] = [];
  const pullRequestSecretFiles: string[] = [];
  for (const file of readdirSync(root).filter((name) => /\.(ya?ml)$/.test(name))) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    if (/\bpull_request_target\b/.test(text)) {
      pullRequestTargetFiles.push(path);
    }
    if (/\bpull_request\b/.test(text) && /\bsecrets\./.test(text)) {
      pullRequestSecretFiles.push(path);
    }
  }
  return { pullRequestTargetFiles, pullRequestSecretFiles };
}

function extractEnvironmentNames(payload: Record<string, unknown>): string[] {
  const environments = Array.isArray(payload.environments) ? payload.environments : [];
  return environments.flatMap((environment) => {
    if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
      return [];
    }
    const name = (environment as Record<string, unknown>).name;
    return typeof name === "string" && name ? [name] : [];
  }).sort();
}

function validateDeploymentEvidence(payload: Record<string, unknown> | null, opsRepo: string): { valid: boolean; detail: string } {
  if (!payload) {
    return { valid: false, detail: "missing private ops deployment evidence" };
  }
  if (payload.ok !== true) {
    return { valid: false, detail: "deployment evidence ok is not true" };
  }
  const repo = stringField(payload, "opsRepo");
  if (repo !== opsRepo) {
    return { valid: false, detail: `deployment evidence opsRepo is ${repo ?? "<missing>"}` };
  }
  const environment = stringField(payload, "environment");
  if (!environment) {
    return { valid: false, detail: "deployment evidence environment is missing" };
  }
  const gitSha = stringField(payload, "gitSha");
  if (!gitSha || !/^[0-9a-f]{7,40}$/.test(gitSha)) {
    return { valid: false, detail: "deployment evidence gitSha is missing or invalid" };
  }
  const imageDigests = payload.imageDigests;
  if (!imageDigests || typeof imageDigests !== "object" || Array.isArray(imageDigests)) {
    return { valid: false, detail: "deployment evidence imageDigests is missing" };
  }
  for (const component of ["api", "worker", "web"]) {
    const digest = (imageDigests as Record<string, unknown>)[component];
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { valid: false, detail: `deployment evidence ${component} digest is missing or invalid` };
    }
  }
  return { valid: true, detail: `private ops deployment evidence for ${environment} at ${gitSha}` };
}

function validateOidcFederatedCredential(
  payload: Record<string, unknown> | null,
  opsRepo: string,
  environment: string,
): { valid: boolean; detail: string } {
  if (!payload) {
    return { valid: false, detail: "missing OIDC federated credential evidence" };
  }
  const issuer = stringField(payload, "issuer");
  const subject = stringField(payload, "subject");
  const audiences = payload.audiences;
  if (issuer !== "https://token.actions.githubusercontent.com") {
    return { valid: false, detail: `OIDC issuer is ${issuer ?? "<missing>"}` };
  }
  const expectedSubject = `repo:${opsRepo}:environment:${environment}`;
  if (subject !== expectedSubject) {
    return { valid: false, detail: `OIDC subject is ${subject ?? "<missing>"}, expected ${expectedSubject}` };
  }
  if (!Array.isArray(audiences) || !audiences.includes("api://AzureADTokenExchange")) {
    return { valid: false, detail: "OIDC audience does not include api://AzureADTokenExchange" };
  }
  return { valid: true, detail: `OIDC trust is scoped to ${expectedSubject}` };
}

function validateWorkflowRun(payload: Record<string, unknown> | null): { succeeded: boolean; digestPinned: boolean } {
  if (!payload) {
    return { succeeded: false, digestPinned: false };
  }
  const succeeded = payload.status === "completed" && payload.conclusion === "success";
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const stepNames = jobs.flatMap((job) => {
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      return [];
    }
    const steps = (job as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) {
      return [];
    }
    return steps.flatMap((step) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        return [];
      }
      const record = step as Record<string, unknown>;
      return record.conclusion === "success" && typeof record.name === "string" ? [record.name] : [];
    });
  });
  return {
    succeeded,
    digestPinned: succeeded
      && stepNames.includes("Validate immutable image inputs")
      && stepNames.includes("Deploy digest-pinned images")
      && stepNames.includes("Upload deployment evidence"),
  };
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ghJson(args: string[]): Record<string, unknown> {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function parseJsonFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(values: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    opsRepo: env.OPENGENI_OPS_REPO ?? "Cloudgeni-ai/opengeni-ops",
    publicWorkflowRoot: env.OPENGENI_PUBLIC_WORKFLOW_ROOT ?? ".github/workflows",
    opsRepoJson: env.OPENGENI_OPS_REPO_JSON ?? null,
    environmentsJson: env.OPENGENI_OPS_ENVIRONMENTS_JSON ?? null,
    deploymentEvidenceJson: env.OPENGENI_OPS_DEPLOYMENT_EVIDENCE_JSON ?? null,
    oidcFederatedCredentialJson: env.OPENGENI_OPS_OIDC_FEDERATED_CREDENTIAL_JSON ?? null,
    workflowRunJson: env.OPENGENI_OPS_WORKFLOW_RUN_JSON ?? null,
    evidenceFiles: parseList(env.OPENGENI_OPS_EVIDENCE_FILES ?? ""),
    outFile: env.OPENGENI_PRIVATE_OPS_OUT_FILE ?? ".agent/generated/staging/private-ops-boundary.json",
    oidcTrustScoped: env.OPENGENI_OPS_OIDC_TRUST_SCOPED === "1",
    artifactDigestPinned: env.OPENGENI_OPS_ARTIFACT_DIGEST_PINNED === "1",
    secretScanPassed: env.OPENGENI_OPS_SECRET_SCAN_PASSED === "1",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--ops-repo") {
      out.opsRepo = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--workflow-root") {
      out.publicWorkflowRoot = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--ops-repo-json") {
      out.opsRepoJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--environments-json") {
      out.environmentsJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--deployment-evidence-json") {
      out.deploymentEvidenceJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--oidc-federated-credential-json") {
      out.oidcFederatedCredentialJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--workflow-run-json") {
      out.workflowRunJson = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--evidence") {
      out.evidenceFiles.push(requiredNext(values, ++index, value));
      continue;
    }
    if (value === "--out") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--oidc-trust-scoped") {
      out.oidcTrustScoped = true;
      continue;
    }
    if (value === "--artifact-digest-pinned") {
      out.artifactDigestPinned = true;
      continue;
    }
    if (value === "--secret-scan-passed") {
      out.secretScanPassed = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  for (const file of [out.oidcFederatedCredentialJson, out.workflowRunJson]) {
    if (file && !existsSync(file)) {
      throw new Error(`private ops evidence file does not exist: ${file}`);
    }
  }
  for (const file of out.evidenceFiles) {
    if (!existsSync(file)) {
      throw new Error(`evidence file does not exist: ${file}`);
    }
  }
  return out;
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
