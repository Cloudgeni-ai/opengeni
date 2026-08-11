#!/usr/bin/env bun
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildReleaseProducerMetadata,
  buildTrustedReleaseArtifact,
  expectedArtifactName,
  expectedWorkflowPath,
  RELEASE_REPOSITORY,
  type ReleaseProducerKind,
  type ReleaseProducerMetadata,
  type TrustedReleaseArtifact,
} from "./release-provenance";

type GitHubRun = {
  id?: unknown;
  run_attempt?: unknown;
  path?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  repository?: { full_name?: unknown };
  head_repository?: { full_name?: unknown };
  html_url?: unknown;
};

type GitHubComparison = {
  status?: unknown;
  merge_base_commit?: { sha?: unknown };
};

type GitHubCommit = {
  sha?: unknown;
  commit?: { tree?: { sha?: unknown } };
};

type GitHubArtifact = {
  id?: unknown;
  name?: unknown;
  digest?: unknown;
  expired?: unknown;
  expires_at?: unknown;
  workflow_run?: { id?: unknown; run_id?: unknown };
};

type GitHubRef = {
  ref?: unknown;
  object?: { type?: unknown; sha?: unknown };
};

type GitHubRelease = {
  id?: unknown;
  tag_name?: unknown;
  name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  immutable?: unknown;
  author?: { id?: unknown; login?: unknown; type?: unknown };
  published_at?: unknown;
  html_url?: unknown;
};

type GitHubJob = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
};

const sourceShaPattern = /^[0-9a-f]{40}$/;
const releaseControllerTagPrefix = "opengeni-release-head-";
const releaseControllerReleaseNamePrefix = "Retained OpenGeni release head ";
const candidateAdmissionJobName =
  "Admit exact reviewed release tree / Verify exact reviewed release tree";
const githubActionsBot = { id: 41898282, login: "github-actions[bot]", type: "Bot" } as const;

export type VerifiedReleaseProvenance = {
  controller: {
    headBranch: string;
    headSha: string;
    retainedRef?: {
      name: string;
      sha: string;
    };
    immutableRelease?: {
      id: number;
      tagName: string;
      name: string;
      publishedAt: string;
      url: string;
    };
    admissionJob?: {
      id: number;
      name: string;
      url: string;
    };
  };
  producer: ReleaseProducerMetadata;
  artifact: TrustedReleaseArtifact;
};

export type ReleaseProvenanceApi = {
  get(path: string): Promise<unknown>;
};

export async function verifyReleaseProvenance(input: {
  kind: ReleaseProducerKind;
  sourceSha: string;
  controllerSha?: string;
  runId: number | string;
  api: ReleaseProvenanceApi;
  now?: number;
}): Promise<VerifiedReleaseProvenance> {
  const requestedRunId = positiveInteger(input.runId, "requested workflow run id");
  const run = asRecord<GitHubRun>(
    await input.api.get(`/repos/${RELEASE_REPOSITORY}/actions/runs/${requestedRunId}`),
  );
  const runId = positiveInteger(run.id, "workflow run id");
  if (runId !== requestedRunId)
    throw new Error("workflow run response ID does not match the requested run");
  if (run.status !== "completed") throw new Error("release producer workflow is not completed");
  const headRepository = string(
    (run.head_repository as { full_name?: unknown } | undefined)?.full_name,
    "workflow head repository",
  );
  if (headRepository !== RELEASE_REPOSITORY) {
    throw new Error("release producer head repository is not the trusted repository");
  }
  const headBranch = string(run.head_branch, "workflow controller ref");
  const runHeadSha = string(run.head_sha, "workflow run head SHA");
  if (!sourceShaPattern.test(runHeadSha)) {
    throw new Error("workflow run head SHA must be a full lowercase SHA");
  }
  let retainedController:
    | Pick<
        VerifiedReleaseProvenance["controller"],
        "retainedRef" | "immutableRelease" | "admissionJob"
      >
    | undefined;
  if (input.kind === "candidate" || input.kind === "acceptance") {
    const controllerSha = input.controllerSha;
    if (typeof controllerSha !== "string" || !sourceShaPattern.test(controllerSha)) {
      throw new Error("expected release controller SHA must be a full lowercase SHA");
    }
    if (runHeadSha !== controllerSha) {
      throw new Error("release workflow head does not match the expected controller SHA");
    }
    const retainedControllerRef = `${releaseControllerTagPrefix}${controllerSha}`;
    if (headBranch !== retainedControllerRef) {
      throw new Error("release workflow must run from its retained controller ref");
    }
    retainedController = await verifyRetainedController(
      input.api,
      controllerSha,
      input.kind === "candidate"
        ? {
            runId,
            runAttempt: positiveInteger(run.run_attempt, "workflow run attempt"),
          }
        : undefined,
    );
  } else if (headBranch !== "main") {
    throw new Error("release producer workflow must run from main");
  }
  if (input.kind === "package") {
    const comparison = asRecord<GitHubComparison>(
      await input.api.get(`/repos/${RELEASE_REPOSITORY}/compare/${runHeadSha}...main`),
    );
    if (
      (comparison.status !== "ahead" && comparison.status !== "identical") ||
      comparison.merge_base_commit?.sha !== runHeadSha
    ) {
      throw new Error("release producer workflow head is no longer an ancestor of main");
    }
  }
  const sourceCommit = asRecord<GitHubCommit>(
    await input.api.get(`/repos/${RELEASE_REPOSITORY}/commits/${input.sourceSha}`),
  );
  const sourceTreeSha = string(sourceCommit.commit?.tree?.sha, "source tree SHA");
  const commitSha = string(sourceCommit.sha, "source commit SHA");
  if (commitSha !== input.sourceSha)
    throw new Error("source commit response does not match the requested source SHA");

  const producer = buildReleaseProducerMetadata({
    kind: input.kind,
    runId,
    runAttempt: run.run_attempt as number,
    sourceSha: input.sourceSha,
    sourceTreeSha,
    repository: string(
      (run.repository as { full_name?: unknown } | undefined)?.full_name,
      "run repository",
    ),
    workflowPath: string(run.path, "workflow path"),
    event: string(run.event, "workflow event"),
    conclusion: string(run.conclusion, "workflow conclusion"),
    runUrl: string(run.html_url, "workflow run URL"),
  });

  const artifactsResponse = asRecord<{ artifacts?: unknown }>(
    await input.api.get(`/repos/${RELEASE_REPOSITORY}/actions/runs/${runId}/artifacts`),
  );
  const artifacts = Array.isArray(artifactsResponse.artifacts)
    ? artifactsResponse.artifacts.map((value) => asRecord<GitHubArtifact>(value))
    : [];
  const expectedName = expectedArtifactName(
    input.kind,
    input.sourceSha,
    runId,
    producer.runAttempt,
  );
  const matches = artifacts.filter(
    (artifact) => artifact.name === expectedName && artifact.expired === false,
  );
  if (matches.length !== 1) {
    throw new Error(
      `release producer must expose exactly one unexpired ${expectedName} artifact (found ${matches.length})`,
    );
  }
  const artifact = matches[0]!;
  const artifactRunId = artifact.workflow_run?.id ?? artifact.workflow_run?.run_id;
  if (positiveInteger(artifactRunId, "artifact workflow run id") !== runId) {
    throw new Error("release artifact is not owned by the selected workflow run");
  }
  return {
    controller: {
      headBranch,
      headSha: runHeadSha,
      ...retainedController,
    },
    producer,
    artifact: buildTrustedReleaseArtifact({
      kind: input.kind,
      sourceSha: input.sourceSha,
      runId,
      runAttempt: producer.runAttempt,
      artifact: {
        id: positiveInteger(artifact.id, "artifact id"),
        name: string(artifact.name, "artifact name"),
        digest: string(artifact.digest, "artifact digest"),
        expires_at: string(artifact.expires_at, "artifact expiry"),
      },
      now: input.now,
    }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to verify release provenance");
  const api = githubApi(token, process.env.GITHUB_API_URL ?? "https://api.github.com");
  const verified = await verifyReleaseProvenance({
    kind: args.kind,
    sourceSha: args.sourceSha,
    ...(args.controllerSha ? { controllerSha: args.controllerSha } : {}),
    runId: args.runId,
    api,
  });
  const serialized = `${JSON.stringify(verified, null, 2)}\n`;
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    const prefix = args.outputPrefix ? `${args.outputPrefix}_` : "";
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `${prefix}controller_head_branch=${verified.controller.headBranch}`,
        `${prefix}controller_head_sha=${verified.controller.headSha}`,
        `${prefix}run_id=${verified.producer.runId}`,
        `${prefix}run_attempt=${verified.producer.runAttempt}`,
        `${prefix}source_tree_sha=${verified.producer.sourceTreeSha}`,
        `${prefix}artifact_id=${verified.artifact.id}`,
        `${prefix}artifact_name=${verified.artifact.name}`,
        `${prefix}artifact_digest=${verified.artifact.digest}`,
        `${prefix}artifact_url=${verified.artifact.url}`,
        `${prefix}run_url=${verified.producer.runUrl}`,
      ].join("\n") + "\n",
      "utf8",
    );
  }
  console.log(JSON.stringify({ ok: true, kind: args.kind, provenance: verified }));
}

function githubApi(token: string, baseUrl: string): ReleaseProvenanceApi {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async get(path: string): Promise<unknown> {
      const response = await fetch(`${base}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
      });
      if (!response.ok) throw new Error(`GitHub provenance API returned ${response.status}`);
      return response.json();
    },
  };
}

function parseArgs(values: string[]): {
  kind: ReleaseProducerKind;
  sourceSha: string;
  controllerSha: string;
  runId: string;
  output: string;
  outputPrefix: string;
} {
  const output = {
    kind: "candidate" as ReleaseProducerKind,
    sourceSha: "",
    controllerSha: "",
    runId: "",
    output: "",
    outputPrefix: "",
  };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const next = () => {
      const value = values[++index];
      if (!value) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (flag === "--kind") {
      const kind = next();
      if (kind !== "candidate" && kind !== "acceptance" && kind !== "package") {
        throw new Error("--kind is invalid");
      }
      output.kind = kind;
    } else if (flag === "--source-sha") output.sourceSha = next();
    else if (flag === "--controller-sha") output.controllerSha = next();
    else if (flag === "--run-id") output.runId = next();
    else if (flag === "--output") output.output = next();
    else if (flag === "--output-prefix") output.outputPrefix = next();
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!output.sourceSha) throw new Error("--source-sha is required");
  if (!output.runId) throw new Error("--run-id is required");
  if (!output.output) throw new Error("--output is required");
  if (!/^[0-9a-f]{40}$/.test(output.sourceSha)) {
    throw new Error("--source-sha must be 40 lowercase hexadecimal characters");
  }
  if (
    (output.kind === "candidate" || output.kind === "acceptance") &&
    !/^[0-9a-f]{40}$/.test(output.controllerSha)
  ) {
    throw new Error("--controller-sha is required for candidate and acceptance provenance");
  }
  if (output.kind === "package" && output.controllerSha) {
    throw new Error("--controller-sha is not valid for package provenance");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(output.runId))
    throw new Error("--run-id must be a positive integer");
  if (expectedWorkflowPath(output.kind).length === 0)
    throw new Error("canonical workflow is missing");
  return output;
}

function asRecord<T>(value: unknown): T & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub provenance API returned an object where one was required");
  }
  return value as T & Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid`);
  return number;
}

async function verifyRetainedController(
  api: ReleaseProvenanceApi,
  controllerSha: string,
  admission?: { runId: number; runAttempt: number },
): Promise<
  Pick<VerifiedReleaseProvenance["controller"], "retainedRef" | "immutableRelease" | "admissionJob">
> {
  const tagName = `${releaseControllerTagPrefix}${controllerSha}`;
  const [refValue, releaseValue] = await Promise.all([
    api.get(`/repos/${RELEASE_REPOSITORY}/git/ref/tags/${tagName}`),
    api.get(`/repos/${RELEASE_REPOSITORY}/releases/tags/${tagName}`),
  ]);

  const ref = asRecord<GitHubRef>(refValue);
  if (
    ref.ref !== `refs/tags/${tagName}` ||
    ref.object?.type !== "commit" ||
    ref.object.sha !== controllerSha
  ) {
    throw new Error("release candidate controller tag is not an exact immutable commit ref");
  }

  const release = asRecord<GitHubRelease>(releaseValue);
  const releaseId = positiveInteger(release.id, "controller immutable release id");
  const expectedReleaseName = `${releaseControllerReleaseNamePrefix}${controllerSha}`;
  const expectedReleaseUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tagName}`;
  const publishedAt = string(release.published_at, "controller immutable release publication time");
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("controller immutable release publication time is invalid");
  }
  if (
    release.tag_name !== tagName ||
    release.name !== expectedReleaseName ||
    release.draft !== false ||
    release.prerelease !== true ||
    release.immutable !== true ||
    release.author?.id !== githubActionsBot.id ||
    release.author.login !== githubActionsBot.login ||
    release.author.type !== githubActionsBot.type ||
    release.html_url !== expectedReleaseUrl
  ) {
    throw new Error(
      "release candidate controller does not have canonical immutable release evidence",
    );
  }

  let admissionJob: VerifiedReleaseProvenance["controller"]["admissionJob"];
  if (admission) {
    const jobsValue = await api.get(
      `/repos/${RELEASE_REPOSITORY}/actions/runs/${admission.runId}/attempts/${admission.runAttempt}/jobs?per_page=100`,
    );
    const jobs = asRecord<{ total_count?: unknown; jobs?: unknown }>(jobsValue);
    const records = Array.isArray(jobs.jobs)
      ? jobs.jobs.map((value) => asRecord<GitHubJob>(value))
      : [];
    if (positiveInteger(jobs.total_count, "candidate workflow job count") !== records.length) {
      throw new Error("candidate workflow job listing is incomplete");
    }
    const admissionJobs = records.filter((job) => job.name === candidateAdmissionJobName);
    if (admissionJobs.length !== 1) {
      throw new Error("candidate workflow does not contain exactly one controller admission job");
    }
    const record = admissionJobs[0]!;
    const admissionId = positiveInteger(record.id, "candidate controller admission job id");
    const expectedJobUrl = `https://github.com/${RELEASE_REPOSITORY}/actions/runs/${admission.runId}/job/${admissionId}`;
    if (
      record.status !== "completed" ||
      record.conclusion !== "success" ||
      record.html_url !== expectedJobUrl
    ) {
      throw new Error("candidate controller admission job did not complete successfully");
    }
    admissionJob = {
      id: admissionId,
      name: candidateAdmissionJobName,
      url: expectedJobUrl,
    };
  }

  return {
    retainedRef: { name: tagName, sha: controllerSha },
    immutableRelease: {
      id: releaseId,
      tagName,
      name: expectedReleaseName,
      publishedAt: new Date(Date.parse(publishedAt)).toISOString(),
      url: expectedReleaseUrl,
    },
    ...(admissionJob ? { admissionJob } : {}),
  };
}

if (import.meta.main) await main();
