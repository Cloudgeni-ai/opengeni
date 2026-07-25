#!/usr/bin/env bun
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const workflowPattern = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const artifactPrefix = "release-acceptance-input-";

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

type GitHubArtifact = {
  id?: unknown;
  name?: unknown;
  digest?: unknown;
  expired?: unknown;
  expires_at?: unknown;
  workflow_run?: { id?: unknown; run_id?: unknown };
};

export type OperatorAcceptanceProvenance = {
  schemaVersion: 1;
  repository: string;
  workflowPath: string;
  runId: number;
  runAttempt: number;
  headSha: string;
  runUrl: string;
  artifact: {
    id: number;
    name: string;
    digest: string;
    expiresAt: string;
    url: string;
    archiveDownloadUrl: string;
  };
};

export type OperatorAcceptanceApi = {
  get(path: string): Promise<unknown>;
};

export async function verifyOperatorAcceptanceProvenance(input: {
  repository: string;
  workflowPath: string;
  sourceSha: string;
  runId: number | string;
  api: OperatorAcceptanceApi;
  now?: number;
}): Promise<OperatorAcceptanceProvenance> {
  const repository = trustedRepository(input.repository);
  const workflowPath = trustedWorkflow(input.workflowPath);
  if (!shaPattern.test(input.sourceSha)) {
    throw new Error("source SHA must be 40 lowercase hexadecimal characters");
  }
  const requestedRunId = positiveInteger(input.runId, "requested workflow run id");
  const run = record<GitHubRun>(
    await input.api.get(`/repos/${repository}/actions/runs/${requestedRunId}`),
    "operator workflow run",
  );
  const runId = positiveInteger(run.id, "operator workflow run id");
  if (runId !== requestedRunId) {
    throw new Error("operator workflow run response ID does not match the requested run");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("operator acceptance workflow must be completed successfully");
  }
  if (run.event !== "workflow_dispatch") {
    throw new Error("operator acceptance workflow must use workflow_dispatch");
  }
  if (run.path !== workflowPath) {
    throw new Error("operator acceptance workflow path is not the protected configured path");
  }
  if (run.head_branch !== "main") {
    throw new Error("operator acceptance workflow must run from main");
  }
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error("operator acceptance workflow repository identity is not trusted");
  }
  const headSha = text(run.head_sha, "operator workflow head SHA");
  if (!shaPattern.test(headSha)) {
    throw new Error("operator workflow head SHA must be 40 lowercase hexadecimal characters");
  }
  const expectedRunUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  if (run.html_url !== expectedRunUrl) {
    throw new Error("operator acceptance workflow URL is not canonical");
  }

  const comparison = record<GitHubComparison>(
    await input.api.get(`/repos/${repository}/compare/${headSha}...main`),
    "operator main ancestry comparison",
  );
  if (
    (comparison.status !== "ahead" && comparison.status !== "identical") ||
    comparison.merge_base_commit?.sha !== headSha
  ) {
    throw new Error("operator workflow head is no longer an ancestor of operator main");
  }

  const artifactsResponse = record<{ artifacts?: unknown }>(
    await input.api.get(`/repos/${repository}/actions/runs/${runId}/artifacts`),
    "operator artifact response",
  );
  const expectedName = `${artifactPrefix}${input.sourceSha}`;
  const artifacts = Array.isArray(artifactsResponse.artifacts)
    ? artifactsResponse.artifacts.map((value) => record<GitHubArtifact>(value, "operator artifact"))
    : [];
  const matches = artifacts.filter(
    (artifact) => artifact.name === expectedName && artifact.expired === false,
  );
  if (matches.length !== 1) {
    throw new Error(
      `operator workflow must expose exactly one unexpired ${expectedName} artifact (found ${matches.length})`,
    );
  }
  const artifact = matches[0]!;
  const artifactRunId = positiveInteger(
    artifact.workflow_run?.id ?? artifact.workflow_run?.run_id,
    "operator artifact workflow run id",
  );
  if (artifactRunId !== runId) {
    throw new Error("operator acceptance artifact is not owned by the selected run");
  }
  const artifactId = positiveInteger(artifact.id, "operator artifact id");
  const digest = text(artifact.digest, "operator artifact digest");
  if (!digestPattern.test(digest)) {
    throw new Error("operator acceptance artifact digest must be exact SHA-256");
  }
  const expiresAt = text(artifact.expires_at, "operator artifact expiry");
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration) || expiration <= (input.now ?? Date.now())) {
    throw new Error("operator acceptance artifact is expired or has an invalid expiry");
  }

  return {
    schemaVersion: 1,
    repository,
    workflowPath,
    runId,
    runAttempt: positiveInteger(run.run_attempt, "operator workflow run attempt"),
    headSha,
    runUrl: expectedRunUrl,
    artifact: {
      id: artifactId,
      name: expectedName,
      digest,
      expiresAt,
      url: `${expectedRunUrl}/artifacts/${artifactId}`,
      archiveDownloadUrl: `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.OPERATOR_GITHUB_TOKEN;
  if (!token) throw new Error("OPERATOR_GITHUB_TOKEN is required");
  const provenance = await verifyOperatorAcceptanceProvenance({
    ...args,
    api: githubApi(token, process.env.GITHUB_API_URL ?? "https://api.github.com"),
  });
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `repository=${provenance.repository}`,
        `run_id=${provenance.runId}`,
        `run_attempt=${provenance.runAttempt}`,
        `head_sha=${provenance.headSha}`,
        `artifact_id=${provenance.artifact.id}`,
        `artifact_name=${provenance.artifact.name}`,
        `artifact_digest=${provenance.artifact.digest}`,
        `artifact_url=${provenance.artifact.url}`,
      ].join("\n") + "\n",
      "utf8",
    );
  }
  console.log(JSON.stringify({ ok: true, provenance }));
}

function githubApi(token: string, baseUrl: string): OperatorAcceptanceApi {
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
      if (!response.ok)
        throw new Error(`GitHub operator provenance API returned ${response.status}`);
      return response.json();
    },
  };
}

function parseArgs(values: string[]): {
  repository: string;
  workflowPath: string;
  sourceSha: string;
  runId: string;
  output: string;
} {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? "<missing>"}`);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (parsed.has(flag)) throw new Error(`${flag} may be supplied only once`);
    parsed.set(flag, value);
  }
  const allowed = new Set([
    "--repository",
    "--workflow-path",
    "--source-sha",
    "--run-id",
    "--output",
  ]);
  for (const flag of parsed.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
  }
  const required = (flag: string) => {
    const value = parsed.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    repository: required("--repository"),
    workflowPath: required("--workflow-path"),
    sourceSha: required("--source-sha"),
    runId: required("--run-id"),
    output: required("--output"),
  };
}

function trustedRepository(value: string): string {
  if (!repositoryPattern.test(value) || value.includes("..")) {
    throw new Error("operator repository must be an exact owner/name slug");
  }
  return value;
}

function trustedWorkflow(value: string): string {
  if (!workflowPattern.test(value) || value.includes("..")) {
    throw new Error("operator workflow must be a canonical workflow path");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid`);
  return number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function record<T>(value: unknown, label: string): T & Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as T & Record<string, unknown>;
}

if (import.meta.main) await main();
