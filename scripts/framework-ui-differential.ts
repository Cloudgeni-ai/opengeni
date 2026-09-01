#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareFrameworkUiTraces,
  FRAMEWORK_UI_DIFFERENTIAL_NORMALIZATION_VERSION,
  runFrameworkUiSensitivityProbes,
  type FrameworkUiRawTrace,
} from "./framework-ui-differential-lib";
import { rewriteEntryPointsToDist } from "./rewrite-entry-points";
import { rewriteWorkspaceDependenciesToConcrete } from "./rewrite-workspace-deps";
import type { PackageJson } from "./publishable-workspaces";

type PackageManifest = PackageJson & {
  name: string;
  version: string;
  files?: string[];
  exports?: Record<string, unknown>;
};

type PackedPackage = Readonly<{
  name: string;
  version: string;
  tarball: string;
  bytes: number;
  sha256: string;
}>;

type SourceIdentity = Readonly<{
  sha: string;
  treeSha: string;
  workingTreeSha256: string;
  clean: boolean;
}>;

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-framework-ui-differential-"));
const baselineRoot = join(tempRoot, "baseline-source");
const candidateWorktreeRoot = join(tempRoot, "candidate-source");
const logPath = join(tempRoot, "runner.log");
let baselineWorktreeAdded = false;
let candidateWorktreeAdded = false;
let retained = false;

try {
  const baseSha =
    args.baseSha ??
    (await git(["merge-base", "HEAD", "origin/main"], repoRoot).catch(() =>
      git(["rev-parse", "HEAD"], repoRoot),
    ));
  const candidateRoot = args.candidateSha ? candidateWorktreeRoot : repoRoot;

  progress(`creating immutable baseline worktree at ${baseSha}`);
  await run(["git", "worktree", "add", "--detach", baselineRoot, baseSha], repoRoot);
  baselineWorktreeAdded = true;
  if (args.candidateSha) {
    progress(`creating immutable candidate worktree at ${args.candidateSha}`);
    await run(
      ["git", "worktree", "add", "--detach", candidateWorktreeRoot, args.candidateSha],
      repoRoot,
    );
    candidateWorktreeAdded = true;
  }

  const baselineIdentity = await sourceIdentity(baselineRoot);
  const candidateIdentity = await sourceIdentity(candidateRoot);
  if (!baselineIdentity.clean || baselineIdentity.sha !== baseSha) {
    throw new Error("baseline worktree is not the requested immutable source");
  }
  if (
    args.candidateSha &&
    (!candidateIdentity.clean || candidateIdentity.sha !== args.candidateSha)
  ) {
    throw new Error("candidate worktree is not the requested immutable source");
  }

  const evidenceRoot = resolve(
    args.output ??
      join(
        repoRoot,
        ".agent/evidence/framework-ui",
        candidateIdentity.clean ? candidateIdentity.sha : "development",
        "differential",
      ),
  );
  await mkdir(evidenceRoot, { recursive: true });

  progress("installing and building the baseline package closure sequentially");
  await prepareSource(baselineRoot, ["contracts", "sdk", "react"], "baseline");
  await assertCleanTrackedSource(baselineRoot, "baseline");

  progress("installing and building the candidate React package closure sequentially");
  await prepareSource(candidateRoot, ["contracts", "sdk", "ui", "react"], "candidate");
  if (args.candidateSha) await assertCleanTrackedSource(candidateRoot, "candidate");

  progress("packing release-shaped baseline and candidate tarballs");
  const baselinePackages = await packLane("baseline", baselineRoot, ["contracts", "sdk", "react"]);
  const candidatePackages = await packLane("candidate", candidateRoot, [
    "contracts",
    "sdk",
    "ui",
    "react",
  ]);

  progress("running the public React regression oracle against baseline and candidate");
  const baselineTrace = await runConsumer("baseline", baselineRoot, baselinePackages);
  const candidateTrace = await runConsumer("candidate", candidateRoot, candidatePackages);
  const comparison = compareFrameworkUiTraces(baselineTrace, candidateTrace);
  const sensitivity = runFrameworkUiSensitivityProbes(comparison.baseline);
  if (sensitivity.some(({ detected }) => !detected)) {
    throw new Error("one or more differential sensitivity probes produced a false PASS");
  }

  const manifestPath = join(repoRoot, "test/fixtures/framework-session/state-manifest.ts");
  const manifestSha256 = sha256(await readFile(manifestPath));
  const environment = {
    scope: "react_public_api_regression",
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    node: process.version,
    normalizationVersion: FRAMEWORK_UI_DIFFERENTIAL_NORMALIZATION_VERSION,
    fixtureManifestSha256: manifestSha256,
    baseline: baselineIdentity,
    candidate: candidateIdentity,
  };
  const classificationLedger = comparison.equal
    ? [
        {
          classification: "exact_match",
          path: "$",
          rationale: "Normalized public traces are exactly equal; no correction or waiver applied.",
        },
      ]
    : comparison.differences.map((difference) => ({
        classification: "unclassified_defect",
        ...difference,
      }));
  const report = {
    schemaVersion: 1,
    verdict: comparison.equal ? "PASS" : "FAIL",
    environment,
    packageTarballs: {
      baseline: baselinePackages.map(packageEvidence),
      candidate: candidatePackages.map(packageEvidence),
    },
    sensitivity,
    differenceCount: comparison.differences.length,
    differences: comparison.differences,
    classificationLedger,
  };

  await Promise.all([
    writeJson(join(evidenceRoot, "environment.json"), environment),
    writeFile(join(evidenceRoot, "base-sha.txt"), `${baselineIdentity.sha}\n`),
    writeFile(join(evidenceRoot, "head-sha.txt"), `${candidateIdentity.sha}\n`),
    writeJson(join(evidenceRoot, "packages.json"), report.packageTarballs),
    writeJson(join(evidenceRoot, "baseline.raw.json"), baselineTrace),
    writeJson(join(evidenceRoot, "candidate.raw.json"), candidateTrace),
    writeJson(join(evidenceRoot, "baseline.normalized.json"), comparison.baseline),
    writeJson(join(evidenceRoot, "candidate.normalized.json"), comparison.candidate),
    writeJson(join(evidenceRoot, "diff.json"), {
      equal: comparison.equal,
      differences: comparison.differences,
    }),
    writeJson(join(evidenceRoot, "classification-ledger.json"), classificationLedger),
    writeJson(join(evidenceRoot, "sensitivity.json"), sensitivity),
    writeJson(join(evidenceRoot, "report.json"), report),
    cp(logPath, join(evidenceRoot, "runner.log")),
  ]);

  if (!comparison.equal) {
    retained = true;
    throw new Error(
      `framework UI differential found ${comparison.differences.length} unclassified difference(s); evidence: ${evidenceRoot}`,
    );
  }

  process.stdout.write(
    `[framework-ui-differential] PASS baseline=${baselineIdentity.sha} candidate=${candidateIdentity.sha} evidence=${evidenceRoot}\n`,
  );
} catch (error) {
  process.stderr.write(`[framework-ui-differential] FAIL ${errorText(error)}\n`);
  if (args.keepTemp || retained) {
    process.stderr.write(`[framework-ui-differential] retained temporary root ${tempRoot}\n`);
    retained = true;
  }
  throw error;
} finally {
  if (candidateWorktreeAdded) {
    await run(["git", "worktree", "remove", "--force", candidateWorktreeRoot], repoRoot).catch(
      () => {},
    );
  }
  if (baselineWorktreeAdded) {
    await run(["git", "worktree", "remove", "--force", baselineRoot], repoRoot).catch(() => {});
  }
  if (!retained && !args.keepTemp) await rm(tempRoot, { recursive: true, force: true });
}

async function prepareSource(
  root: string,
  packages: readonly string[],
  lane: string,
): Promise<void> {
  await runLogged(["bun", "install", "--frozen-lockfile"], root, lane);
  for (const packageName of packages) {
    await runLogged(["bun", "run", "build"], join(root, "packages", packageName), lane);
  }
}

async function packLane(
  lane: string,
  root: string,
  packageNames: readonly string[],
): Promise<PackedPackage[]> {
  const laneRoot = join(tempRoot, lane);
  const stagingRoot = join(laneRoot, "packages");
  const tarballRoot = join(laneRoot, "tarballs");
  await Promise.all([
    mkdir(stagingRoot, { recursive: true }),
    mkdir(tarballRoot, { recursive: true }),
  ]);
  const versions = await workspaceVersions(root);
  const packages: PackedPackage[] = [];
  for (const packageName of packageNames) {
    const sourceRoot = join(root, "packages", packageName);
    const sourceManifest = JSON.parse(
      await readFile(join(sourceRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const destination = join(stagingRoot, packageName);
    await mkdir(destination, { recursive: true });
    for (const item of ["README.md", "dist", "src", "styles"]) {
      const source = join(sourceRoot, item);
      if (existsSync(source)) await cp(source, join(destination, item), { recursive: true });
    }
    const packageLicense = join(sourceRoot, "LICENSE");
    const license = existsSync(packageLicense) ? packageLicense : join(root, "LICENSE");
    if (existsSync(license)) await cp(license, join(destination, "LICENSE"));

    const manifest = structuredClone(sourceManifest);
    delete manifest.devDependencies;
    rewriteWorkspaceDependenciesToConcrete(manifest, versions);
    rewriteEntryPointsToDist(manifest);
    await writeJson(join(destination, "package.json"), manifest);

    const packed = await runLogged(
      ["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", tarballRoot],
      destination,
      lane,
      true,
    );
    const filename = packed
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!filename)
      throw new Error(`bun pm pack did not report a filename for ${sourceManifest.name}`);
    const tarball = join(tarballRoot, basename(filename));
    const bytes = (await stat(tarball)).size;
    packages.push(
      Object.freeze({
        name: sourceManifest.name,
        version: sourceManifest.version,
        tarball,
        bytes,
        sha256: sha256(await readFile(tarball)),
      }),
    );
  }
  return packages;
}

async function runConsumer(
  lane: "baseline" | "candidate",
  sourceRoot: string,
  packages: readonly PackedPackage[],
): Promise<FrameworkUiRawTrace> {
  const consumerRoot = join(tempRoot, lane, "consumer");
  await mkdir(consumerRoot, { recursive: true });
  const reactSource = JSON.parse(
    await readFile(join(sourceRoot, "packages/react/package.json"), "utf8"),
  ) as PackageManifest;
  const packageByName = new Map(packages.map((item) => [item.name, item]));
  const dependencies: Record<string, string> = {
    "@happy-dom/global-registrator":
      reactSource.devDependencies?.["@happy-dom/global-registrator"] ?? "20.10.2",
    react: reactSource.peerDependencies?.react ?? "^19.2.5",
    "react-dom": reactSource.peerDependencies?.["react-dom"] ?? "^19.2.5",
  };
  for (const packageInfo of packages) {
    dependencies[packageInfo.name] = `file:${packageInfo.tarball}`;
  }
  await writeJson(join(consumerRoot, "package.json"), {
    name: `opengeni-framework-ui-${lane}-consumer`,
    private: true,
    type: "module",
    dependencies,
    overrides: Object.fromEntries(
      packages.map((packageInfo) => [packageInfo.name, `file:${packageInfo.tarball}`]),
    ),
  });
  await Promise.all([
    cp(
      join(repoRoot, "test/fixtures/framework-session/react-oracle-driver.ts"),
      join(consumerRoot, "react-oracle-driver.ts"),
    ),
    cp(
      join(repoRoot, "test/fixtures/framework-session/state-manifest.ts"),
      join(consumerRoot, "state-manifest.ts"),
    ),
  ]);
  await runLogged(["bun", "install"], consumerRoot, lane);
  await runLogged(["bun", "install", "--frozen-lockfile"], consumerRoot, lane);
  const output = await runLogged(["bun", "react-oracle-driver.ts"], consumerRoot, lane, true);
  const trace = JSON.parse(output) as FrameworkUiRawTrace;
  const consoleErrors = Array.isArray(trace.consoleErrors) ? trace.consoleErrors : [];
  if (consoleErrors.length > 0) {
    throw new Error(
      `${lane} React regression oracle emitted console errors: ${JSON.stringify(consoleErrors)}`,
    );
  }
  const resources = trace.finalResources;
  if (
    typeof resources !== "object" ||
    resources === null ||
    Object.values(resources).some((value) => value !== 0)
  ) {
    throw new Error(`${lane} React regression oracle did not return every resource counter to zero`);
  }
  if (!packageByName.has("@opengeni/react") || !packageByName.has("@opengeni/sdk")) {
    throw new Error(`${lane} consumer package closure is incomplete`);
  }
  return trace;
}

async function workspaceVersions(root: string): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const group of ["apps", "packages"]) {
    const directory = join(root, group);
    if (!existsSync(directory)) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(await readFile(path, "utf8")) as Partial<PackageManifest>;
      if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
    }
  }
  return versions;
}

async function sourceIdentity(root: string): Promise<SourceIdentity> {
  const [sha, treeSha, statusOutput] = await Promise.all([
    git(["rev-parse", "HEAD"], root),
    git(["rev-parse", "HEAD^{tree}"], root),
    git(["status", "--porcelain=v1", "--untracked-files=all"], root),
  ]);
  const hash = createHash("sha256");
  hash.update(await run(["git", "diff", "--binary", "HEAD"], root, true));
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], root);
  for (const path of untracked.split("\n").filter(Boolean).sort()) {
    hash.update(`\0${path}\0`);
    hash.update(await readFile(join(root, path)));
  }
  return Object.freeze({
    sha,
    treeSha,
    workingTreeSha256: hash.digest("hex"),
    clean: statusOutput.length === 0,
  });
}

async function assertCleanTrackedSource(root: string, lane: string): Promise<void> {
  const diff = await run(["git", "diff", "--name-only"], root, true);
  if (diff.trim()) {
    throw new Error(`${lane} install/build changed tracked source:\n${diff.trim()}`);
  }
}

async function git(command: string[], cwd: string): Promise<string> {
  return (await run(["git", ...command], cwd, true)).trim();
}

async function runLogged(
  command: string[],
  cwd: string,
  lane: string,
  capture = false,
): Promise<string> {
  await appendFile(logPath, `[${lane}] ${cwd}$ ${command.join(" ")}\n`);
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  await appendFile(logPath, `${stdout}${stderr}`);
  if (exitCode !== 0) {
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  if (!capture && stdout) process.stdout.write(stdout);
  if (!capture && stderr) process.stderr.write(stderr);
  return stdout;
}

async function run(command: string[], cwd: string, capture = false): Promise<string> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    if (stdout) process.stderr.write(stdout);
    if (stderr) process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
  if (!capture && stderr) process.stderr.write(stderr);
  return stdout;
}

function packageEvidence(packageInfo: PackedPackage): Omit<PackedPackage, "tarball"> & {
  filename: string;
} {
  return {
    name: packageInfo.name,
    version: packageInfo.version,
    filename: basename(packageInfo.tarball),
    bytes: packageInfo.bytes,
    sha256: packageInfo.sha256,
  };
}

function parseArgs(values: string[]): {
  baseSha?: string;
  candidateSha?: string;
  output?: string;
  keepTemp: boolean;
} {
  const parsed: {
    baseSha?: string;
    candidateSha?: string;
    output?: string;
    keepTemp: boolean;
  } = { keepTemp: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--keep-temp") parsed.keepTemp = true;
    else if (value === "--base-sha") parsed.baseSha = requiredArg(values, ++index, value);
    else if (value === "--candidate-sha") {
      parsed.candidateSha = requiredArg(values, ++index, value);
    } else if (value === "--output") parsed.output = requiredArg(values, ++index, value);
    else throw new Error(`unknown argument: ${value}`);
  }
  return parsed;
}

function requiredArg(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function progress(message: string): void {
  process.stdout.write(`[framework-ui-differential] ${message}\n`);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
