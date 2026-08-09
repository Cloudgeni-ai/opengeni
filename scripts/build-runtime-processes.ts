#!/usr/bin/env bun

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessTarget = "api" | "worker";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const targets: ProcessTarget[] =
  requested.length === 0
    ? ["api", "worker"]
    : requested.map((target) => {
        if (target !== "api" && target !== "worker") {
          throw new Error(`Unknown runtime process target: ${target}`);
        }
        return target;
      });

async function checkedBuild(options: BuildConfig): Promise<void> {
  const result = await Bun.build(options);
  if (result.success) return;
  for (const log of result.logs) console.error(log);
  throw new Error(`Runtime process bundle failed for ${options.entrypoints.join(", ")}`);
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

const sharedBuild = {
  target: "bun" as const,
  format: "esm" as const,
  splitting: true,
  minify: { syntax: true, whitespace: true, identifiers: false },
  // Bun retains linked source maps in-process for stack remapping. Production
  // bundles preserve symbol names instead; shipping detached maps would add a
  // large permanent RSS tax to every API/worker replica.
  sourcemap: "none" as const,
};

async function buildApi(): Promise<void> {
  const outdir = join(repositoryRoot, "apps/api/dist/process");
  await rm(outdir, { recursive: true, force: true });
  await checkedBuild({
    ...sharedBuild,
    entrypoints: [join(repositoryRoot, "apps/api/src/index.ts")],
    outdir,
    external: ["better-auth", "better-auth/*", "@better-auth/*"],
  });
  await copyDirectory(join(repositoryRoot, "agent/install"), join(outdir, "assets/agent-install"));
  await copyDirectory(
    join(repositoryRoot, "packages/runtime/src/bundled_hashicorp_terraform_skills"),
    join(outdir, "assets/runtime/bundled_hashicorp_terraform_skills"),
  );
}

async function buildWorker(): Promise<void> {
  const outdir = join(repositoryRoot, "apps/worker/dist/process");
  await rm(outdir, { recursive: true, force: true });
  await checkedBuild({
    ...sharedBuild,
    entrypoints: [join(repositoryRoot, "apps/worker/src/index.ts")],
    outdir,
    external: ["@temporalio/*"],
  });

  // Generate with the worker package's own Temporal dependency, then colocate
  // the deterministic artifact where the bundled entrypoint expects it.
  const workflowBuild = Bun.spawn({
    cmd: ["bun", "scripts/build-workflow-bundle.ts"],
    cwd: join(repositoryRoot, "apps/worker"),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await workflowBuild.exited) !== 0) {
    throw new Error("Temporal workflow bundle generation failed");
  }
  await cp(
    join(repositoryRoot, "apps/worker/dist/workflow-bundle.js"),
    join(outdir, "workflow-bundle.js"),
  );
  await copyDirectory(
    join(repositoryRoot, "packages/runtime/src/bundled_hashicorp_terraform_skills"),
    join(outdir, "assets/runtime/bundled_hashicorp_terraform_skills"),
  );
  await copyDirectory(
    join(repositoryRoot, "packages/runtime/src/bundled_skill_library"),
    join(outdir, "assets/runtime/bundled_skill_library"),
  );
}

for (const target of targets) {
  if (target === "api") await buildApi();
  else await buildWorker();
  process.stdout.write(`[runtime-process] built ${target}\n`);
}
