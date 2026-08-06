import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import {
  computeTestConcurrencyBudget,
  describeTestConcurrencyBudget,
  detectedMemoryState,
} from "./ci/resource-budget";
import { typecheckProjects } from "./ci/workspace";

// Typecheck the whole workspace with the stable TypeScript 7 compiler. Each
// package/app carries its own tsconfig with the per-package compilerOptions
// (jsx, types, standalone web config, ...), so we drive them individually
// rather than via project references (which would require `composite` +
// declaration emit and fight `noEmit`).
//
// The projects are independent (no cross-project emit), so we run each project's
// `tsc --noEmit` through a bounded worker pool instead of strictly one-at-a-time.
// Wall time drops to roughly the slowest project plus scheduling, while the
// concurrency cap keeps total RSS bounded on memory-constrained hosts. The
// impact planner may pass an exact project subset through repeated `--project`
// arguments; every requested path must still be one of the repository's
// discovered tsconfig roots.
const discoveredProjects = typecheckProjects();
const discoveredProjectSet = new Set(discoveredProjects);

function selectedProjects(args = process.argv.slice(2)): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--project") {
      throw new Error("usage: bun scripts/typecheck.ts [--project <directory>]...");
    }
    const project = args[++index];
    if (!project) throw new Error("missing --project directory");
    if (!discoveredProjectSet.has(project)) {
      throw new Error(`unknown typecheck project: ${project}`);
    }
    if (!selected.includes(project)) selected.push(project);
  }
  return selected.length > 0 ? selected : discoveredProjects;
}

const projects = selectedProjects();

const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const MAX_FAILURE_OUTPUT_BYTES = 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveConcurrency() {
  const memory = detectedMemoryState();
  return computeTestConcurrencyBudget({
    memoryLimitBytes: memory.limitBytes,
    memoryUsageBytes: memory.usageBytes,
    memoryUsageKnown: memory.usageKnown,
    cpuSlots: availableParallelism(),
    requestedMax: positiveInteger(
      process.env.OPENGENI_TYPECHECK_CONCURRENCY,
      4,
      "OPENGENI_TYPECHECK_CONCURRENCY",
    ),
    memoryPerTestMib: positiveInteger(
      process.env.OPENGENI_TYPECHECK_MEMORY_PER_WORKER_MB,
      768,
      "OPENGENI_TYPECHECK_MEMORY_PER_WORKER_MB",
    ),
    source: memory.source,
  });
}

type ProjectResult = { project: string; status: number; output: string };

function typecheckProject(project: string): Promise<ProjectResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [tsc, "--noEmit", "-p", join(project, "tsconfig.json")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    const capture = (chunk: Buffer): void => {
      if (output.length >= MAX_FAILURE_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8", 0, MAX_FAILURE_OUTPUT_BYTES - output.length);
      if (output.length >= MAX_FAILURE_OUTPUT_BYTES) truncated = true;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (err) => {
      output += `\n[typecheck] failed to spawn TypeScript 7: ${String(err)}\n`;
      resolve({ project, status: 1, output });
    });
    child.on("close", (code) =>
      resolve({
        project,
        status: code ?? 1,
        output: truncated
          ? `${output}\n[typecheck] output truncated at ${MAX_FAILURE_OUTPUT_BYTES} bytes\n`
          : output,
      }),
    );
  });
}

const budget = resolveConcurrency();
const concurrency = Math.min(budget.concurrency, Math.max(1, projects.length));
process.stdout.write(
  `[typecheck] ${projects.length} projects; ${describeTestConcurrencyBudget({ ...budget, concurrency })}\n`,
);

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
