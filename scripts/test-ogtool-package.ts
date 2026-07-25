#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(repoRoot, "packages/ogtool");
const canonicalCli = join(packageRoot, "bin/ogtool.cjs");

async function run(command: string[], cwd: string, capture = false): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : Promise.resolve(""),
    capture ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  if (exitCode !== 0) {
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  return stdout;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-ogtool-package-"));
let passed = false;

try {
  const mode = (await stat(canonicalCli)).mode & 0o777;
  if ((mode & 0o111) === 0) throw new Error("canonical ogtool CLI is not executable");

  for (const dockerfile of ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"]) {
    const source = await readFile(join(repoRoot, dockerfile), "utf8");
    if (!source.includes("packages/ogtool/bin/ogtool.cjs")) {
      throw new Error(`${dockerfile} does not consume the canonical package CLI`);
    }
    if (source.includes("docker/ogtool")) {
      throw new Error(`${dockerfile} still consumes the removed image-only CLI copy`);
    }
  }
  const workloadDockerfile = await readFile(join(repoRoot, "docker/opengeni.Dockerfile"), "utf8");
  if (!workloadDockerfile.includes("packages/ogtool/package.json packages/ogtool/package.json")) {
    throw new Error(
      "docker/opengeni.Dockerfile does not stage the ogtool workspace manifest before frozen install",
    );
  }

  await run(["bun", "run", "build"], packageRoot);
  const packedJson = await run(
    ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", tempRoot],
    packageRoot,
    true,
  );
  const packed = JSON.parse(packedJson) as Array<{ filename?: string }>;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report the ogtool tarball");
  const tarball = join(tempRoot, basename(filename));

  const extracted = join(tempRoot, "extracted");
  await mkdir(extracted, { recursive: true });
  await run(["tar", "-xzf", tarball, "-C", extracted], tempRoot);
  const packedFiles = new Set(
    await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: join(extracted, "package"), onlyFiles: true }),
    ),
  );
  for (const requiredFile of [
    "LICENSE",
    "README.md",
    "package.json",
    "bin/ogtool.cjs",
    "dist/index.js",
    "dist/index.d.ts",
    "src/index.ts",
  ]) {
    if (!packedFiles.has(requiredFile)) {
      throw new Error(`packed ogtool tarball is missing ${requiredFile}`);
    }
  }
  const unexpectedTopLevel = (await readdir(join(extracted, "package"))).filter(
    (entry) => !["LICENSE", "README.md", "bin", "dist", "package.json", "src"].includes(entry),
  );
  if (unexpectedTopLevel.length > 0) {
    throw new Error(`packed ogtool tarball has unexpected files: ${unexpectedTopLevel.join(", ")}`);
  }
  const packedCli = join(extracted, "package/bin/ogtool.cjs");
  const [sourceHash, packedHash, tarballHash] = await Promise.all([
    sha256(canonicalCli),
    sha256(packedCli),
    sha256(tarball),
  ]);
  if (sourceHash !== packedHash) {
    throw new Error("packed ogtool CLI differs from the canonical image source");
  }

  const prefix = join(tempRoot, "global-prefix");
  await run(
    ["npm", "install", "--offline", "--ignore-scripts", "--global", "--prefix", prefix, tarball],
    tempRoot,
  );
  const globalVersion = (
    await run([join(prefix, "bin/ogtool"), "--version"], tempRoot, true)
  ).trim();
  if (!globalVersion) throw new Error("globally installed ogtool returned no version");

  const execVersion = (
    await run(
      [
        "npm",
        "exec",
        "--offline",
        "--yes",
        `--package=file:${tarball}`,
        "--",
        "ogtool",
        "--version",
      ],
      tempRoot,
      true,
    )
  ).trim();
  if (execVersion !== globalVersion) {
    throw new Error(`npm exec version ${execVersion} differs from global ${globalVersion}`);
  }

  process.stdout.write(
    `OGTOOL_PACKAGE_PROOF ${JSON.stringify({
      version: globalVersion,
      canonicalCliSha256: sourceHash,
      tarballSha256: tarballHash,
      offlineGlobalInstall: true,
      offlineNpmExec: true,
      stockImagesUseCanonicalSource: true,
      workloadImageStagesWorkspaceManifest: true,
    })}\n`,
  );
  passed = true;
} finally {
  if (process.env.OPENGENI_KEEP_OGTOOL_PACKAGE_PROOF === "1") {
    process.stdout.write(`ogtool package proof retained at ${tempRoot}\n`);
  } else {
    await rm(tempRoot, { recursive: true, force: true });
  }
  if (!passed) process.exitCode = 1;
}
