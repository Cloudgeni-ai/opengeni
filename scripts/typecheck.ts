import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join } from "node:path";

// Typecheck the whole workspace with tsgo (TypeScript 7 native compiler). Each
// package/app carries its own tsconfig with the per-package compilerOptions
// (jsx, types, standalone web config, ...), so we drive them individually
// rather than via project references (which would require `composite` +
// declaration emit and fight `noEmit`).
//
// tsgo replaced the old 18x sequential `tsc --noEmit` chain. The projects are
// independent (no cross-project emit), so we run them through a bounded worker
// pool instead of strictly one-at-a-time: wall time drops to roughly the
// slowest project plus scheduling, while the concurrency cap keeps total RSS
// bounded on memory-constrained hosts. Override the width with
// OPENGENI_TYPECHECK_CONCURRENCY (defaults to ~half the available cores, min 2,
// max 8). Keep this list in sync with the per-package `typecheck` scripts.
const projects = [
  "packages/contracts",
  "packages/agent-proto",
  "packages/codex",
  "packages/config",
  "packages/deployment",
  "packages/db",
  "packages/events",
  "packages/github",
  "packages/storage",
  "packages/documents",
  "packages/observability",
  "packages/runtime",
  "packages/core",
  "packages/sdk",
  "packages/react",
  "packages/testing",
  "apps/api",
  "apps/worker",
  "apps/web",
  "examples/northstar-support",
];

const tsgo = join(process.cwd(), "node_modules", ".bin", "tsgo");

function resolveConcurrency(): number {
  const override = Number.parseInt(process.env.OPENGENI_TYPECHECK_CONCURRENCY ?? "", 10);
  if (Number.isFinite(override) && override > 0) {
    return Math.min(override, projects.length);
  }
  const cores = availableParallelism();
  const half = Math.floor(cores / 2);
  return Math.max(2, Math.min(8, half, projects.length));
}

type ProjectResult = { project: string; status: number; output: string };

function typecheckProject(project: string): Promise<ProjectResult> {
  return new Promise((resolve) => {
    const child = spawn(tsgo, ["--noEmit", "-p", join(project, "tsconfig.json")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => {
      output += `\n[typecheck] failed to spawn tsgo: ${String(err)}\n`;
      resolve({ project, status: 1, output });
    });
    child.on("close", (code) => resolve({ project, status: code ?? 1, output }));
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
