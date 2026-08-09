#!/usr/bin/env bun

import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { provePackedArtifactKernelBrowser } from "./packed-artifact-kernel-browser-proof";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import { workspaceVersionMap, type PackageJson } from "./publishable-workspaces";

const repoRoot = resolve(import.meta.dir, "..");
const modalities = ["spreadsheet", "document", "presentation"] as const;
const temporaryRoot = await mkdtemp(join(tmpdir(), "opengeni-packed-modality-wasm-"));
const keep = process.env.OPENGENI_KEEP_ARTIFACT_KERNEL_WASM_CONSUMER === "1";
let passed = false;

try {
  const stagingRoot = join(temporaryRoot, "staging");
  const tarballRoot = join(temporaryRoot, "tarballs");
  const consumerRoot = join(temporaryRoot, "consumer");
  await Promise.all(
    [stagingRoot, tarballRoot, consumerRoot].map((path) => mkdir(path, { recursive: true })),
  );

  const versions = workspaceVersionMap();
  const contractsRoot = join(repoRoot, "packages/contracts");
  const sdkRoot = join(repoRoot, "packages/sdk");
  await run(["bun", "run", "build"], contractsRoot);
  await run(["bun", "run", "build"], sdkRoot);
  const contractsTarball = await packBuiltWorkspace(
    contractsRoot,
    stagingRoot,
    tarballRoot,
    versions,
  );
  const sdkTarball = await packBuiltWorkspace(sdkRoot, stagingRoot, tarballRoot, versions);

  const kernelDependencies: Record<string, string> = {};
  for (const modality of modalities) {
    const packageRoot = join(repoRoot, "packages", `artifact-kernel-wasm-${modality}`);
    await run(["bun", "run", "build"], packageRoot);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    const packed = await runCapture(
      ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
      packageRoot,
    );
    const filename = packed.trim().split("\n").filter(Boolean).at(-1);
    if (!filename) throw new Error(`bun pm pack did not report ${manifest.name}`);
    const tarball = join(tarballRoot, basename(filename));
    const contents = (await runCapture(["tar", "-tzf", tarball], consumerRoot)).split("\n");
    const stem = `artifact_kernel_${modality}`;
    for (const required of [
      "package/package.json",
      "package/dist/artifact-kernel-runtime.json",
      "package/dist/index.js",
      "package/dist/index.d.ts",
      `package/dist/${stem}.js`,
      `package/dist/${stem}.d.ts`,
      `package/dist/${stem}_bg.wasm`,
      `package/dist/${stem}_bg.wasm.d.ts`,
    ]) {
      if (!contents.includes(required)) throw new Error(`${manifest.name} is missing ${required}`);
    }
    for (const other of modalities.filter((candidate) => candidate !== modality)) {
      if (contents.some((path) => path.includes(`artifact_kernel_${other}`))) {
        throw new Error(`${manifest.name} contains the unrelated ${other} kernel`);
      }
    }
    kernelDependencies[manifest.name] = `file:${tarball}`;
  }

  await writeFile(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "opengeni-packed-modality-wasm-consumer",
        private: true,
        version: "0.0.0",
        type: "module",
        dependencies: {
          "@opengeni/contracts": `file:${contractsTarball}`,
          "@opengeni/sdk": `file:${sdkTarball}`,
          ...kernelDependencies,
        },
        overrides: { "@opengeni/contracts": `file:${contractsTarball}` },
      },
      null,
      2,
    )}\n`,
  );
  await run(["bun", "install", "--ignore-scripts"], consumerRoot);
  await provePackedArtifactKernelBrowser(consumerRoot);
  passed = true;
  process.stdout.write(
    "[artifact-kernel-wasm-consumer] PASS packed SDK Worker + real spreadsheet/document/presentation WASM + fail-closed negatives\n",
  );
} finally {
  if (passed && !keep) {
    await rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `[artifact-kernel-wasm-consumer] artifacts retained at ${temporaryRoot}\n`,
    );
  }
}

async function packBuiltWorkspace(
  sourceRoot: string,
  stagingRoot: string,
  tarballRoot: string,
  versions: ReadonlyMap<string, string>,
): Promise<string> {
  const source = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  ) as PackageJson;
  if (typeof source.name !== "string") throw new Error(`${sourceRoot} has no package name`);
  const destination = join(stagingRoot, source.name.replace("@opengeni/", ""));
  await mkdir(destination, { recursive: true });
  for (const entry of ["LICENSE", "README.md", "dist"]) {
    if (existsSync(join(sourceRoot, entry))) {
      await cp(join(sourceRoot, entry), join(destination, entry), { recursive: true });
    }
  }
  const manifest = structuredClone(source);
  delete manifest.devDependencies;
  rewriteWorkspaceDependenciesToConcrete(manifest, versions);
  rewriteEntryPointsToDist(manifest);
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const packed = await runCapture(
    ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
    destination,
  );
  const filename = packed.trim().split("\n").filter(Boolean).at(-1);
  if (!filename) throw new Error(`bun pm pack did not report ${source.name}`);
  return join(tarballRoot, basename(filename));
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
}

async function runCapture(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn({ cmd: command, cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  return stdout;
}
