export const RELEASE_REPOSITORY = "Cloudgeni-ai/opengeni" as const;
export const RELEASE_CANDIDATE_WORKFLOW = ".github/workflows/release-candidate.yml" as const;
export const RELEASE_ACCEPTANCE_WORKFLOW = ".github/workflows/release-acceptance.yml" as const;
export const RELEASE_CANDIDATE_ARTIFACT_PREFIX = "release-candidate-" as const;
export const RELEASE_ACCEPTANCE_ARTIFACT_PREFIX = "release-acceptance-" as const;

export type ReleaseProducerKind = "candidate" | "acceptance";

export type ReleaseProducerMetadata = {
  repository: typeof RELEASE_REPOSITORY;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  event: "workflow_dispatch";
  conclusion: "success";
  sourceSha: string;
  sourceTreeSha: string;
  runUrl: string;
};

export type TrustedReleaseArtifact = {
  id: number;
  name: string;
  digest: string;
  expiresAt: string;
  url: string;
  archiveDownloadUrl: string;
};

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const runIdPattern = /^[1-9][0-9]{0,19}$/;
const urlPattern = /^https:\/\/github\.com\/Cloudgeni-ai\/opengeni\/actions\/runs\/[1-9][0-9]*$/;

export function expectedWorkflowPath(kind: ReleaseProducerKind): string {
  return kind === "candidate" ? RELEASE_CANDIDATE_WORKFLOW : RELEASE_ACCEPTANCE_WORKFLOW;
}

export function expectedArtifactName(kind: ReleaseProducerKind, sourceSha: string): string {
  if (!shaPattern.test(sourceSha)) throw new Error("source SHA must be a full lowercase SHA");
  return `${kind === "candidate" ? RELEASE_CANDIDATE_ARTIFACT_PREFIX : RELEASE_ACCEPTANCE_ARTIFACT_PREFIX}${sourceSha}`;
}

export function buildReleaseProducerMetadata(input: {
  kind: ReleaseProducerKind;
  runId: number | string;
  runAttempt: number | string;
  sourceSha: string;
  sourceTreeSha: string;
  repository?: string;
  workflowPath?: string;
  event?: string;
  conclusion?: string;
  runUrl?: string;
}): ReleaseProducerMetadata {
  const runId = positiveInteger(input.runId, "runId");
  const runAttempt = positiveInteger(input.runAttempt, "runAttempt");
  const repository = input.repository ?? RELEASE_REPOSITORY;
  const workflowPath = input.workflowPath ?? expectedWorkflowPath(input.kind);
  const event = input.event ?? "workflow_dispatch";
  const conclusion = input.conclusion ?? "success";
  const runUrl = input.runUrl ?? `${githubServerUrl()}/${RELEASE_REPOSITORY}/actions/runs/${runId}`;

  if (repository !== RELEASE_REPOSITORY) {
    throw new Error(`release producer repository must be ${RELEASE_REPOSITORY}`);
  }
  if (workflowPath !== expectedWorkflowPath(input.kind)) {
    throw new Error(`release ${input.kind} producer workflow is not canonical`);
  }
  if (event !== "workflow_dispatch") {
    throw new Error("release producer must be a manually dispatched workflow run");
  }
  if (conclusion !== "success") {
    throw new Error("release producer must have a successful conclusion");
  }
  if (!shaPattern.test(input.sourceSha)) {
    throw new Error("release producer sourceSha must be 40 lowercase hexadecimal characters");
  }
  if (!shaPattern.test(input.sourceTreeSha)) {
    throw new Error("release producer sourceTreeSha must be 40 lowercase hexadecimal characters");
  }
  if (!urlPattern.test(runUrl)) {
    throw new Error("release producer runUrl must be the canonical GitHub Actions run URL");
  }
  const expectedRunUrl = `${githubServerUrl()}/${RELEASE_REPOSITORY}/actions/runs/${runId}`;
  if (runUrl !== expectedRunUrl) {
    throw new Error("release producer runUrl does not match the producer run id");
  }

  return {
    repository: RELEASE_REPOSITORY,
    workflowPath,
    runId,
    runAttempt,
    event: "workflow_dispatch",
    conclusion: "success",
    sourceSha: input.sourceSha,
    sourceTreeSha: input.sourceTreeSha,
    runUrl,
  };
}

export function validateReleaseProducerMetadata(
  value: unknown,
  expected?: {
    kind?: ReleaseProducerKind;
    sourceSha?: string;
    sourceTreeSha?: string;
  },
): ReleaseProducerMetadata {
  const item = record(value, "release producer");
  exactKeys(
    item,
    [
      "repository",
      "workflowPath",
      "runId",
      "runAttempt",
      "event",
      "conclusion",
      "sourceSha",
      "sourceTreeSha",
      "runUrl",
    ],
    "release producer",
  );
  const kind = expected?.kind;
  const metadata = buildReleaseProducerMetadata({
    kind: kind ?? kindFromWorkflow(item.workflowPath),
    runId: item.runId as number,
    runAttempt: item.runAttempt as number,
    sourceSha: item.sourceSha as string,
    sourceTreeSha: item.sourceTreeSha as string,
    repository: item.repository as string,
    workflowPath: item.workflowPath as string,
    event: item.event as string,
    conclusion: item.conclusion as string,
    runUrl: item.runUrl as string,
  });
  if (expected?.kind && metadata.workflowPath !== expectedWorkflowPath(expected.kind)) {
    throw new Error("release producer workflow does not match the expected producer kind");
  }
  if (expected?.sourceSha && metadata.sourceSha !== expected.sourceSha) {
    throw new Error("release producer source SHA does not match the expected source");
  }
  if (expected?.sourceTreeSha && metadata.sourceTreeSha !== expected.sourceTreeSha) {
    throw new Error("release producer source tree SHA does not match the expected source tree");
  }
  return metadata;
}

export function buildTrustedReleaseArtifact(input: {
  kind: ReleaseProducerKind;
  sourceSha: string;
  runId: number | string;
  artifact: {
    id: number | string;
    name: string;
    digest: string;
    expires_at: string;
  };
  now?: number;
}): TrustedReleaseArtifact {
  const runId = positiveInteger(input.runId, "runId");
  const id = positiveInteger(input.artifact.id, "artifact.id");
  const expectedName = expectedArtifactName(input.kind, input.sourceSha);
  if (input.artifact.name !== expectedName) {
    throw new Error(`release artifact must be named ${expectedName}`);
  }
  if (!digestPattern.test(input.artifact.digest)) {
    throw new Error("release artifact digest must be an exact sha256 digest");
  }
  const expiresAt = input.artifact.expires_at;
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= (input.now ?? Date.now())) {
    throw new Error("release artifact is expired or has an invalid expiry");
  }
  const base = `${githubServerUrl()}/${RELEASE_REPOSITORY}/actions/runs/${runId}`;
  return {
    id,
    name: input.artifact.name,
    digest: input.artifact.digest,
    expiresAt,
    url: `${base}/artifacts/${id}`,
    archiveDownloadUrl: `${githubApiUrl()}/repos/${RELEASE_REPOSITORY}/actions/artifacts/${id}/zip`,
  };
}

export function validateTrustedReleaseArtifact(
  value: unknown,
  expected: {
    kind: ReleaseProducerKind;
    sourceSha: string;
    runId: number;
    now?: number;
  },
): TrustedReleaseArtifact {
  const item = record(value, "trusted release artifact");
  exactKeys(
    item,
    ["id", "name", "digest", "expiresAt", "url", "archiveDownloadUrl"],
    "trusted release artifact",
  );
  const id = positiveInteger(item.id as number, "artifact.id");
  const name = string(item.name, "artifact.name");
  const digest = string(item.digest, "artifact.digest");
  const expiresAt = string(item.expiresAt, "artifact.expiresAt");
  const url = string(item.url, "artifact.url");
  const archiveDownloadUrl = string(item.archiveDownloadUrl, "artifact.archiveDownloadUrl");
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= (expected.now ?? Date.now())) {
    throw new Error("trusted release artifact is expired or has an invalid expiry");
  }
  const expectedName = expectedArtifactName(expected.kind, expected.sourceSha);
  if (name !== expectedName)
    throw new Error(`trusted release artifact must be named ${expectedName}`);
  if (!digestPattern.test(digest)) throw new Error("trusted release artifact digest is invalid");
  const expectedUrl = `${githubServerUrl()}/${RELEASE_REPOSITORY}/actions/runs/${expected.runId}/artifacts/${id}`;
  const expectedArchiveDownloadUrl = `${githubApiUrl()}/repos/${RELEASE_REPOSITORY}/actions/artifacts/${id}/zip`;
  if (url !== expectedUrl) throw new Error("trusted release artifact URL is not canonical");
  if (archiveDownloadUrl !== expectedArchiveDownloadUrl) {
    throw new Error("trusted release artifact archive URL is not canonical");
  }
  return { id, name, digest, expiresAt, url, archiveDownloadUrl };
}

function kindFromWorkflow(value: unknown): ReleaseProducerKind {
  if (value === RELEASE_CANDIDATE_WORKFLOW) return "candidate";
  if (value === RELEASE_ACCEPTANCE_WORKFLOW) return "acceptance";
  throw new Error("release producer workflow is not canonical");
}

function positiveInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || !runIdPattern.test(String(parsed))) {
    throw new Error(`release producer ${label} must be a positive integer`);
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} must contain exactly: ${canonical.join(", ")}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function githubServerUrl(): string {
  return "https://github.com";
}

function githubApiUrl(): string {
  return "https://api.github.com";
}
