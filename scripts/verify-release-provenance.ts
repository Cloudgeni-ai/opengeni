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
  head_sha?: unknown;
  repository?: { full_name?: unknown };
  head_repository?: { full_name?: unknown };
  html_url?: unknown;
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

const sourceShaPattern = /^[0-9a-f]{40}$/;

export type VerifiedReleaseProvenance = {
  producer: ReleaseProducerMetadata;
  artifact: TrustedReleaseArtifact;
};

export type ReleaseProvenanceApi = {
  get(path: string): Promise<unknown>;
};

export async function verifyReleaseProvenance(input: {
  kind: ReleaseProducerKind;
  sourceSha: string;
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
  const sourceSha = string(run.head_sha, "workflow run head SHA");
  if (!sourceShaPattern.test(sourceSha)) {
    throw new Error("workflow run head SHA must be a full lowercase SHA");
  }
  const sourceCommit = asRecord<GitHubCommit>(
    await input.api.get(`/repos/${RELEASE_REPOSITORY}/commits/${sourceSha}`),
  );
  const sourceTreeSha = string(sourceCommit.commit?.tree?.sha, "source tree SHA");
  const commitSha = string(sourceCommit.sha, "source commit SHA");
  if (commitSha !== sourceSha)
    throw new Error("source commit response does not match workflow head SHA");

  const producer = buildReleaseProducerMetadata({
    kind: input.kind,
    runId,
    runAttempt: run.run_attempt as number,
    sourceSha,
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

  if (sourceSha !== input.sourceSha) {
    throw new Error(`release producer source SHA ${sourceSha} does not match ${input.sourceSha}`);
  }

  const artifactsResponse = asRecord<{ artifacts?: unknown }>(
    await input.api.get(`/repos/${RELEASE_REPOSITORY}/actions/runs/${runId}/artifacts`),
  );
  const artifacts = Array.isArray(artifactsResponse.artifacts)
    ? artifactsResponse.artifacts.map((value) => asRecord<GitHubArtifact>(value))
    : [];
  const expectedName = expectedArtifactName(input.kind, input.sourceSha);
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
    producer,
    artifact: buildTrustedReleaseArtifact({
      kind: input.kind,
      sourceSha: input.sourceSha,
      runId,
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
  runId: string;
  output: string;
  outputPrefix: string;
} {
  const output = {
    kind: "candidate" as ReleaseProducerKind,
    sourceSha: "",
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
      if (kind !== "candidate" && kind !== "acceptance") throw new Error("--kind is invalid");
      output.kind = kind;
    } else if (flag === "--source-sha") output.sourceSha = next();
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

if (import.meta.main) await main();
