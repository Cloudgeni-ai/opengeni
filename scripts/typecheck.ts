import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Typecheck the whole workspace with tsgo (TypeScript 7 native compiler),
// one project at a time. Each package/app carries its own tsconfig with the
// per-package compilerOptions (jsx, types, standalone web config, ...), so we
// drive them individually rather than via project references (which would
// require `composite` + declaration emit and fight `noEmit`).
//
// tsgo replaced the old 18x sequential `tsc --noEmit` chain: same coverage,
// ~5x faster wall time and bounded per-process RSS. Keep this list in sync
// with the per-package `typecheck` scripts.
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
];

const tsgo = join(process.cwd(), "node_modules", ".bin", "tsgo");

for (const project of projects) {
  process.stdout.write(`[typecheck] ${project}\n`);
  const result = spawnSync(tsgo, ["--noEmit", "-p", join(project, "tsconfig.json")], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`[typecheck] FAILED in ${project}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("[typecheck] all projects clean\n");
