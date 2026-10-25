#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitStore } from "../merge-batcher/git";
import { readResultZip } from "../merge-batcher/github";
import { canonical } from "../merge-batcher/model";
import { retryRead } from "../merge-batcher/read-retry";
import {
  BATCH_WORKFLOW,
  sameInventory,
  verifyArtifactBytes,
  verifyBatchUnitProof,
  type ArtifactIdentity,
  type BatchUnitProof,
  type ProviderRun,
} from "./batch-unit-proof";

type Wire = Record<string, any>; // Provider JSON is checked before reuse, never cast to permission.
export interface ProofReads {
  get(path: string): Promise<Wire>;
  archive(id: number): Promise<Uint8Array>;
  tree(sha: string): Promise<string>;
  manifest(sha: string): Promise<BatchUnitProof["manifest"]>;
}
export type ProofContext = Parameters<typeof verifyBatchUnitProof>[1];

// Existence proof, not an inventory/capacity decision: bounded discovery can
// miss an old matching run, in which case the ordinary full suite still runs.
export async function findBatchUnitProof(
  reads: ProofReads,
  context: ProofContext,
): Promise<BatchUnitProof | null> {
  const listing = await reads.get(
    "actions/workflows/batch-ci.yml/runs?event=push&status=success&per_page=100&page=1",
  );
  if (!Array.isArray(listing.workflow_runs)) throw new Error("Malformed Batch run listing");
  let inspected = 0;
  for (const listed of listing.workflow_runs) {
    if (
      listed.path !== BATCH_WORKFLOW ||
      !/^queue\//.test(listed.head_branch ?? "") ||
      !/^[a-f0-9]{40}$/.test(listed.head_sha ?? "")
    )
      continue;
    if (++inspected > 12) break;
    const commit = await reads.get(`git/commits/${listed.head_sha}`);
    if (commit.sha !== listed.head_sha || commit.tree?.sha !== context.tree) continue;
    const run = (await reads.get(
      `actions/runs/${listed.id}/attempts/${listed.run_attempt}`,
    )) as ProviderRun;
    if (
      run.id !== listed.id ||
      run.run_attempt !== listed.run_attempt ||
      run.head_sha !== listed.head_sha
    )
      continue;
    const artifacts: ArtifactIdentity[] = [];
    let total: number | undefined;
    for (let page = 1; page <= 5; page++) {
      const data = await reads.get(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        !Array.isArray(data.artifacts) ||
        data.artifacts.length > 100 ||
        (total !== undefined && total !== data.total_count)
      )
        throw new Error("Incomplete artifact inventory");
      total = data.total_count as number;
      artifacts.push(...data.artifacts);
      if (artifacts.length === total) break;
      if (artifacts.length > total || data.artifacts.length !== 100 || page === 5)
        throw new Error("Incomplete artifact inventory");
    }
    if (new Set(artifacts.map((a) => a.id)).size !== artifacts.length)
      throw new Error("Duplicate artifacts");
    const select = (name: string) => {
      const matches = artifacts.filter((a) => a.name === name);
      if (matches.length !== 1) throw new Error("Missing or ambiguous Batch artifact");
      return matches[0]!;
    };
    const planArtifact = select(`batch-plan-${run.run_attempt}`);
    const resultArtifact = select(`batch-result-${run.run_attempt}`);
    const planBytes = await reads.archive(planArtifact.id);
    verifyArtifactBytes(planArtifact, planBytes, run, planArtifact.name);
    const plan = JSON.parse(readResultZip(planBytes, ["impact-plan.json"], 1_000_000));
    if (!sameInventory(plan.unitTests, context.inventory)) continue;
    const resultBytes = await reads.archive(resultArtifact.id);
    verifyArtifactBytes(resultArtifact, resultBytes, run, resultArtifact.name);
    const manifest = await reads.manifest(run.head_sha);
    if (
      canonical(JSON.parse(readResultZip(planBytes, ["batch.json"], 1_000_000))) !==
      canonical(manifest)
    )
      throw new Error("Batch plan manifest differs from canonical Git provenance");
    const testedTree = await reads.tree(run.head_sha);
    const proof: BatchUnitProof = {
      schemaVersion: 1,
      repository: context.repository,
      mainSha: context.mainSha,
      tree: context.tree,
      testedTree,
      producer: { runId: context.runId, attempt: context.attempt },
      batch: run,
      manifest,
      inventory: plan.unitTests,
      result: JSON.parse(readResultZip(resultBytes)),
      artifacts: [planArtifact, resultArtifact],
    };
    verifyBatchUnitProof(proof, context);
    // A rerun starting while we read the old attempt invalidates this reuse.
    const current = await reads.get(`actions/runs/${run.id}`);
    if (
      current.run_attempt !== run.run_attempt ||
      current.head_sha !== run.head_sha ||
      current.status !== "completed" ||
      current.conclusion !== "success"
    )
      throw new Error("Batch attempt changed");
    return proof;
  }
  return null;
}

export function mainUnitInventory(raw: unknown): string[] {
  const plan = raw as { schemaVersion?: number; mode?: string; unitTests?: unknown } | null;
  if (
    plan?.schemaVersion !== 1 ||
    plan.mode !== "full" ||
    !Array.isArray(plan.unitTests) ||
    !sameInventory(plan.unitTests, plan.unitTests)
  )
    throw new Error("Main plan does not contain complete unit inventory");
  return [...plan.unitTests];
}

// Every optional discovery, Git and filesystem operation belongs inside this
// boundary. Failure to persist even the fallback file still leaves reuse false;
// the unchanged impact plan is sufficient for the ordinary test path.
export async function optionalUnitProof(
  collect: () => Promise<BatchUnitProof | null>,
  persist: (proof: BatchUnitProof | null) => void,
): Promise<BatchUnitProof | null> {
  try {
    const proof = await collect();
    persist(proof);
    return proof;
  } catch {
    try {
      persist(null);
    } catch {
      /* An unwritable optional artifact never grants reuse. */
    }
    return null;
  }
}

async function readContext(): Promise<{ context: ProofContext; git: GitStore }> {
  const env = process.env;
  const gitDir = (await Bun.$`git rev-parse --absolute-git-dir`.text()).trim();
  const git = new GitStore(gitDir);
  const mainSha = (await git.exec(["rev-parse", "HEAD"])).trim();
  const context: ProofContext = {
    repository: env.GITHUB_REPOSITORY ?? "",
    mainSha,
    tree: await git.exec(["rev-parse", `${mainSha}^{tree}`]),
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    inventory: mainUnitInventory(JSON.parse(readFileSync("impact-plan.json", "utf8"))),
  };
  return { context, git };
}

async function main(): Promise<void> {
  const env = process.env;
  if (process.argv[2] === "verify") {
    const { context } = await readContext();
    if (
      env.GITHUB_EVENT_NAME !== "push" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_SHA !== context.mainSha
    )
      throw new Error("Unit proof is only valid for its exact main push");
    const proof = verifyBatchUnitProof(
      JSON.parse(readFileSync("unit-reuse.json", "utf8")),
      context,
    );
    console.log(
      `Complete unit coverage reused from Batch ${proof.batch.id} attempt ${proof.batch.run_attempt}; identical tree ${proof.tree}`,
    );
    return;
  }
  const proof = await optionalUnitProof(
    async () => {
      if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") return null;
      const { context, git } = await readContext();
      if (env.GITHUB_SHA !== context.mainSha) throw new Error("Main source changed");
      if (!/^[\w.-]+\/[\w.-]+$/.test(context.repository) || !env.GITHUB_TOKEN)
        throw new Error("Missing read identity");
      const deadline = AbortSignal.timeout(90_000);
      const base = `https://api.github.com/repos/${context.repository}/`;
      const request = (url: string, authenticated: boolean, redirect: RequestRedirect = "error") =>
        retryRead(fetch, url, {
          redirect,
          signal: deadline,
          headers: {
            Accept: "application/vnd.github+json",
            ...(authenticated ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
          },
        });
      const get = async (path: string) => {
        const response = await request(base + path, true);
        if (!response.ok) throw new Error("Provider read unavailable");
        return response.json() as Promise<Wire>;
      };
      return await findBatchUnitProof(
        {
          get,
          archive: async (id) => {
            const response = await request(base + `actions/artifacts/${id}/zip`, true, "manual");
            if (response.status !== 302 || !response.headers.get("location"))
              throw new Error("Artifact redirect missing");
            const url = new URL(response.headers.get("location")!);
            if (url.protocol !== "https:" || url.username || url.password)
              throw new Error("Invalid artifact location");
            const download = await request(url.href, false);
            if (!download.ok) throw new Error("Artifact download unavailable");
            const bytes = new Uint8Array(await download.arrayBuffer());
            if (bytes.length > 1_000_000) throw new Error("Artifact too large");
            return bytes;
          },
          tree: async (sha) => git.exec(["rev-parse", `${sha}^{tree}`]),
          manifest: async (sha) => git.inspect(sha),
        },
        context,
      );
    },
    (value) => writeFileSync(resolve("unit-reuse.json"), JSON.stringify(value)),
  );
  const reason = proof
    ? `Reused complete Batch unit coverage, run ${proof.batch.id}/${proof.batch.run_attempt}, tested head ${proof.batch.head_sha}, tree ${proof.testedTree}`
    : "Batch proof unavailable, inapplicable or invalid; running ordinary unit suite";
  // Missing outputs also select the ordinary matrix and test steps. Diagnostic
  // filesystem failures must not turn an optional optimization into a CI veto.
  try {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${proof !== null}\n`);
  } catch {
    /* Default is no reuse. */
  }
  try {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${reason}.\n`);
  } catch {
    /* Best-effort diagnostic. */
  }
  console.log(reason);
}
if (import.meta.main) await main();
