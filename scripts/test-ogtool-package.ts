#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(repoRoot, "packages/ogtool");
const canonicalCli = join(packageRoot, "dist/bin/ogtool.cjs");

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
    if (!source.includes("COPY --from=browserd-build /src/packages/ogtool/dist/bin/ogtool.cjs")) {
      throw new Error(`${dockerfile} does not consume the canonical package CLI`);
    }
    if (source.includes("docker/ogtool")) {
      throw new Error(`${dockerfile} still consumes the removed image-only CLI copy`);
    }
    for (const required of [
      "/out/codemode-runtime",
      "/opt/opengeni/codemode-runtime",
      "@opengeni/codemode",
      "/usr/local/bin/bun",
    ]) {
      if (!source.includes(required)) {
        throw new Error(
          `${dockerfile} does not install the importable Codemode runtime: ${required}`,
        );
      }
    }
  }
  const workloadDockerfile = await readFile(join(repoRoot, "docker/opengeni.Dockerfile"), "utf8");
  if (!workloadDockerfile.includes("packages/ogtool/package.json packages/ogtool/package.json")) {
    throw new Error(
      "docker/opengeni.Dockerfile does not stage the ogtool workspace manifest before frozen install",
    );
  }

  await run(["bun", "run", "build"], packageRoot);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const staging = join(tempRoot, "staging/package");
  await mkdir(staging, { recursive: true });
  for (const entry of ["LICENSE", "README.md", "package.json", "dist", "src"]) {
    await cp(join(packageRoot, entry), join(staging, entry), { recursive: true });
  }
  const tarball = join(tempRoot, `opengeni-ogtool-${manifest.version}.tgz`);
  await run(["tar", "-czf", tarball, "-C", join(tempRoot, "staging"), "package"], tempRoot);

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
    "dist/bin/ogtool.cjs",
    "dist/index.js",
    "dist/index.d.ts",
    "src/index.ts",
  ]) {
    if (!packedFiles.has(requiredFile)) {
      throw new Error(`packed ogtool tarball is missing ${requiredFile}`);
    }
  }
  const unexpectedTopLevel = (await readdir(join(extracted, "package"))).filter(
    (entry) => !["LICENSE", "README.md", "dist", "package.json", "src"].includes(entry),
  );
  if (unexpectedTopLevel.length > 0) {
    throw new Error(`packed ogtool tarball has unexpected files: ${unexpectedTopLevel.join(", ")}`);
  }
  const packedCli = join(extracted, "package/dist/bin/ogtool.cjs");
  const [sourceHash, packedHash, tarballHash] = await Promise.all([
    sha256(canonicalCli),
    sha256(packedCli),
    sha256(tarball),
  ]);
  if (sourceHash !== packedHash) {
    throw new Error("packed ogtool CLI differs from the canonical image source");
  }

  const [sourceVersion, packedVersion] = await Promise.all([
    run([canonicalCli, "--version"], tempRoot, true),
    run([packedCli, "--version"], tempRoot, true),
  ]);
  if (!packedVersion.trim() || packedVersion.trim() !== sourceVersion.trim()) {
    throw new Error("packed ogtool version differs from its canonical source");
  }

  process.stdout.write(
    `OGTOOL_PACKAGE_PROOF ${JSON.stringify({
      version: packedVersion.trim(),
      canonicalCliSha256: sourceHash,
      tarballSha256: tarballHash,
      standaloneBundledCli: true,
      stockImagesUseCanonicalSource: true,
      stockImagesIncludeImportableCodemode: true,
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
