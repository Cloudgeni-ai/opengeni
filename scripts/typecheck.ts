import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import {
  computeTestConcurrencyBudget,
  describeTestConcurrencyBudget,
  detectedMemoryLimit,
  detectedMemoryUsage,
} from "./ci/resource-budget";
import { typecheckProjects } from "./ci/workspace";

// Typecheck the whole workspace with tsgo (TypeScript 7 native compiler). Each
// package/app carries its own tsconfig with the per-package compilerOptions
// (jsx, types, standalone web config, ...), so we drive them individually
// rather than via project references (which would require `composite` +
// declaration emit and fight `noEmit`).
//
// tsgo replaced the old 18x sequential `tsc --noEmit` chain. The projects are
// independent (no cross-project emit), so we run them through a bounded worker
// pool instead of strictly one-at-a-time. Project discovery comes from the
// workspace manifests, and both full and impacted runs use the same cgroup-
// aware budget. One worker is the safe default: measurements retained a
// 25-second full run while reducing the recovered ~4.3 GiB multi-worker cgroup
// peak to roughly 1.6 GiB. Measured larger runners may explicitly raise the
// bounded cap.
const discovered = typecheckProjects();
const requestedProjects = new Set<string>();
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--project" || !process.argv[index + 1]) {
    throw new Error("usage: bun scripts/typecheck.ts [--project <workspace-dir>]...");
  }
  requestedProjects.add(process.argv[++index] as string);
}
for (const project of requestedProjects) {
  if (!discovered.includes(project)) throw new Error(`unknown typecheck project: ${project}`);
}
const projects =
  requestedProjects.size === 0
    ? discovered
    : discovered.filter((project) => requestedProjects.has(project));

const tsgo = join(process.cwd(), "node_modules", ".bin", "tsgo");

function resolveConcurrency(): number {
  const requestedMax = Number(process.env.OPENGENI_TYPECHECK_CONCURRENCY ?? "1");
  const memoryPerWorkerMib = Number(process.env.OPENGENI_TYPECHECK_MEMORY_PER_WORKER_MB ?? "640");
  if (!Number.isSafeInteger(requestedMax) || requestedMax < 1) {
    throw new Error("OPENGENI_TYPECHECK_CONCURRENCY must be a positive integer");
  }
  if (!Number.isSafeInteger(memoryPerWorkerMib) || memoryPerWorkerMib < 256) {
    throw new Error("OPENGENI_TYPECHECK_MEMORY_PER_WORKER_MB must be an integer >= 256");
  }
  const limit = detectedMemoryLimit();
  const usage = detectedMemoryUsage();
  const budget = computeTestConcurrencyBudget({
    memoryLimitBytes: limit.bytes,
    memoryUsageBytes: usage.bytes,
    memoryUsageKnown: usage.source !== "usage-unavailable",
    cpuSlots: availableParallelism(),
    requestedMax,
    memoryPerTestMib: memoryPerWorkerMib,
    source: `${limit.source}+${usage.source}`,
  });
  process.stdout.write(`[typecheck] ${describeTestConcurrencyBudget(budget)}\n`);
  return Math.max(1, Math.min(budget.concurrency, projects.length));
}

type ProjectResult = { project: string; status: number; output: string };

const MAX_FAILURE_OUTPUT_BYTES = 1024 * 1024;

function typecheckProject(project: string): Promise<ProjectResult> {
  return new Promise((resolve) => {
    const child = spawn(tsgo, ["--noEmit", "-p", join(project, "tsconfig.json")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (outputBytes >= MAX_FAILURE_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_FAILURE_OUTPUT_BYTES - outputBytes;
      const retained = chunk.subarray(0, remaining);
      output += retained.toString("utf8");
      outputBytes += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      output += `\n[typecheck] failed to spawn tsgo: ${String(err)}\n`;
      resolve({ project, status: 1, output });
    });
    child.on("close", (code) => {
      if (truncated) output += "\n[typecheck] output truncated at 1 MiB\n";
      resolve({ project, status: code ?? 1, output });
    });
  });
}

const concurrency = resolveConcurrency();
process.stdout.write(`[typecheck] ${projects.length} projects, concurrency ${concurrency}\n`);

const queue = [...projects];
const failures: ProjectResult[] = [];

async function worker(): Promise<void> {
  for (;;) {
    const project = queue.shift();
    if (project === undefined) {
      return;
    }
    const result = await typecheckProject(project);
    if (result.status === 0) {
      process.stdout.write(`[typecheck] ok   ${project}\n`);
    } else {
      process.stdout.write(`[typecheck] FAIL ${project}\n`);
      failures.push(result);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`\n===== [typecheck] ${failure.project} =====\n`);
    process.stderr.write(failure.output.trimEnd() + "\n");
  }
  process.stderr.write(`\n[typecheck] FAILED in ${failures.map((f) => f.project).join(", ")}\n`);
  process.exit(1);
}

process.stdout.write("[typecheck] all projects clean\n");
