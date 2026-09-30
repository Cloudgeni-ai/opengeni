/**
 * Old published SDK compatibility suite.
 *
 * Runs recently PUBLISHED `@opengeni/sdk` versions (installed from npm, outside
 * this repository) against the CURRENT API source over a core embedding flow:
 * test/sdk-compat/old-sdk.compat.ts. Any 5xx, any 409 `API_CONTRACT_CHANGED`,
 * any SDK-thrown contract-mismatch error, or any broken flow step fails the run.
 *
 * Usage (from the repository root):
 *
 *   bun scripts/public-api/sdk-compat.ts                      # default policy (see below)
 *   bun scripts/public-api/sdk-compat.ts --list               # print resolved versions only
 *   bun scripts/public-api/sdk-compat.ts --versions 7.1.1,7.0.0
 *   bun scripts/public-api/sdk-compat.ts --minors 2
 *   bun scripts/public-api/sdk-compat.ts --offline --versions 7.1.1   # cached installs only
 *
 * Environment:
 *   OPENGENI_SDK_COMPAT_VERSIONS=7.1.1,7.0.0   explicit version list (--versions wins)
 *   OPENGENI_SDK_COMPAT_MINORS=3               minor lines under the default policy
 *   OPENGENI_SDK_COMPAT_CACHE_DIR=<dir>        install cache ($TMPDIR/opengeni-sdk-compat)
 *   OPENGENI_SDK_COMPAT_CONCURRENCY=1|2        versions run in parallel (max 2, default 2)
 *   OPENGENI_REQUIRE_REAL_DB=1                 fail (instead of skip) without docker
 *
 * Default version policy: the latest stable patch of each of the last N
 * (default 3) stable minor lines WITHIN the major of the npm dist-tag `latest`.
 * Prereleases (canaries) are ignored. Cross-major versions are only run when
 * listed explicitly; a published SDK of an older major carries an older API
 * contract revision and is expected to be rejected by design.
 *
 * Requires docker (the shared PostgreSQL test container from @opengeni/testing).
 * No Temporal, model, or sandbox is needed: the check stops at API acceptance and
 * durable PostgreSQL state (see the header of the test file).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = "@opengeni/sdk";
const REGISTRY_URL = "https://registry.npmjs.org/@opengeni%2fsdk";
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TEST_FILE = "./test/sdk-compat/old-sdk.compat.ts";
const PER_VERSION_TIMEOUT_MS = 240_000;
const INSTALL_TIMEOUT_MS = 180_000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

type Options = {
  list: boolean;
  offline: boolean;
  versions: string[] | null;
  minors: number;
  concurrency: number;
  cacheDir: string;
};

type VersionResult = {
  version: string;
  status: "pass" | "fail" | "skip";
  seconds: number;
  sdkContract: string;
  contractsVersion: string;
  detail: string;
};

function fail(message: string): never {
  console.error(`[sdk-compat] ${message}`);
  process.exit(1);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer`);
  return parsed;
}

function parseVersionList(value: string): string[] {
  const versions = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const version of versions) {
    if (!SEMVER.test(version)) fail(`not an exact stable version: ${version}`);
  }
  return [...new Set(versions)];
}

function parseOptions(argv: string[]): Options {
  let versions: string[] | null = process.env.OPENGENI_SDK_COMPAT_VERSIONS
    ? parseVersionList(process.env.OPENGENI_SDK_COMPAT_VERSIONS)
    : null;
  let minors = positiveInt(process.env.OPENGENI_SDK_COMPAT_MINORS, 3, "OPENGENI_SDK_COMPAT_MINORS");
  let list = false;
  let offline = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) fail(`${arg} requires a value`);
      return next;
    };
    if (arg === "--list") list = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--versions") versions = parseVersionList(value());
    else if (arg.startsWith("--versions=")) versions = parseVersionList(arg.slice(11));
    else if (arg === "--minors") minors = positiveInt(value(), 3, "--minors");
    else if (arg.startsWith("--minors=")) minors = positiveInt(arg.slice(9), 3, "--minors");
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: bun scripts/public-api/sdk-compat.ts [--list] [--offline] [--versions a,b] [--minors N]",
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  const concurrency = Math.min(
    2,
    positiveInt(process.env.OPENGENI_SDK_COMPAT_CONCURRENCY, 2, "OPENGENI_SDK_COMPAT_CONCURRENCY"),
  );
  const cacheDir = resolve(
    process.env.OPENGENI_SDK_COMPAT_CACHE_DIR ?? join(tmpdir(), "opengeni-sdk-compat"),
  );
  if (cacheDir.startsWith(`${REPO_ROOT}/`) || cacheDir === REPO_ROOT) {
    fail("OPENGENI_SDK_COMPAT_CACHE_DIR must be outside the repository");
  }
  return { list, offline, versions, minors, concurrency, cacheDir };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Latest patch of each of the last `minors` stable minor lines within `major`. */
export function selectPolicyVersions(stable: string[], major: number, minors: number): string[] {
  const latestPerMinor = new Map<number, string>();
  for (const version of stable) {
    const match = SEMVER.exec(version);
    if (!match || Number(match[1]) !== major) continue;
    const minor = Number(match[2]);
    const current = latestPerMinor.get(minor);
    if (!current || compareSemver(version, current) > 0) latestPerMinor.set(minor, version);
  }
  return [...latestPerMinor.values()].sort((a, b) => compareSemver(b, a)).slice(0, minors);
}

async function resolveFromRegistry(minors: number): Promise<string[]> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) fail(`npm registry returned ${response.status} for ${PACKAGE}`);
  const body = (await response.json()) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  const latest = body["dist-tags"]?.latest;
  const latestMatch = latest ? SEMVER.exec(latest) : null;
  if (!latestMatch) fail(`npm dist-tag latest is not a stable version: ${String(latest)}`);
  const stable = Object.keys(body.versions ?? {}).filter((version) => SEMVER.test(version));
  return selectPolicyVersions(stable, Number(latestMatch[1]), minors);
}

function cachedVersions(cacheDir: string): string[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir).filter(
    (entry) => SEMVER.test(entry) && installedVersion(join(cacheDir, entry)) === entry,
  );
}

function installedVersion(dir: string): string | null {
  const manifest = join(dir, "node_modules", "@opengeni", "sdk", "package.json");
  if (!existsSync(manifest)) return null;
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? null;
}

async function resolveVersions(options: Options): Promise<string[]> {
  if (options.versions) return options.versions;
  if (!options.offline) return await resolveFromRegistry(options.minors);
  // Offline without an explicit list: apply the policy to the cached installs,
  // anchored at the highest cached major.
  const cached = cachedVersions(options.cacheDir);
  if (cached.length === 0) fail("--offline needs --versions or a populated install cache");
  const major = Math.max(...cached.map((version) => Number(SEMVER.exec(version)![1])));
  return selectPolicyVersions(cached, major, options.minors);
}

function install(version: string, options: Options): string {
  const dir = join(options.cacheDir, version);
  if (installedVersion(dir) === version) return dir;
  if (options.offline) fail(`${PACKAGE}@${version} is not cached in ${dir} (--offline)`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `opengeni-sdk-compat-${version}`, private: true, type: "module" }, null, 2)}\n`,
  );
  console.log(`[sdk-compat] installing ${PACKAGE}@${version} into ${dir}`);
  const result = spawnSync("bun", ["add", `${PACKAGE}@${version}`, "--exact"], {
    cwd: dir,
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (result.status !== 0 || installedVersion(dir) !== version) {
    fail(
      `bun add ${PACKAGE}@${version} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return dir;
}

function packageFacts(dir: string): {
  entry: string;
  sdkContract: string;
  contractsVersion: string;
} {
  const sdkDir = join(dir, "node_modules", "@opengeni", "sdk");
  const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as {
    main?: string;
    exports?: { ".": { import?: string } };
  };
  const entry = join(sdkDir, manifest.exports?.["."]?.import ?? manifest.main ?? "./dist/index.js");
  if (!existsSync(entry)) fail(`published entry point missing: ${entry}`);
  let sdkContract = "unknown";
  const types = join(sdkDir, "src", "types.ts");
  if (existsSync(types)) {
    const match = /OPENGENI_API_CONTRACT_REVISION\s*=\s*"([^"]+)"/u.exec(
      readFileSync(types, "utf8"),
    );
    if (match) sdkContract = match[1]!;
  }
  const contractsManifest = join(dir, "node_modules", "@opengeni", "contracts", "package.json");
  const contractsVersion = existsSync(contractsManifest)
    ? ((JSON.parse(readFileSync(contractsManifest, "utf8")) as { version?: string }).version ?? "?")
    : "?";
  return { entry, sdkContract, contractsVersion };
}

function dockerAvailable(): boolean {
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

function runVersion(version: string, dir: string): Promise<VersionResult> {
  const facts = packageFacts(dir);
  const started = performance.now();
  return new Promise((resolvePromise) => {
    const child = spawn("bun", ["test", "--timeout", "180000", TEST_FILE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OPENGENI_SDK_COMPAT_MODULE: facts.entry,
        OPENGENI_SDK_COMPAT_VERSION: version,
        OPENGENI_REQUIRE_REAL_DB: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      for (const line of text.split("\n")) {
        if (line.includes("[sdk-compat ")) console.log(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), PER_VERSION_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const seconds = (performance.now() - started) / 1000;
      const failLines = output
        .split("\n")
        .filter((line) => line.includes("[sdk-compat ") && line.includes(" FAIL "));
      const skipped = output
        .split("\n")
        .filter((line) => /\[sdk-compat [^\]]+\] SKIP /u.test(line));
      const passed = code === 0 && /\b1 pass\b/u.test(output) && /\b0 fail\b/u.test(output);
      let detail = failLines.map((line) => line.replace(/^.*?\] FAIL /u, "")).join(" | ");
      if (!passed && !detail) {
        detail = signal
          ? `killed by ${signal} after ${Math.round(seconds)}s`
          : output
              .split("\n")
              .filter((line) => /error|expect|fail/iu.test(line))
              .slice(0, 6)
              .join(" / ") || `bun test exited ${code}`;
      }
      if (passed && skipped.length > 0) {
        detail = skipped.map((line) => line.replace(/^.*?\] SKIP /u, "skip ")).join("; ");
      }
      if (!passed) {
        console.log(`----- ${version} bun test output (tail) -----`);
        console.log(output.split("\n").slice(-60).join("\n"));
      }
      resolvePromise({
        version,
        status: passed ? "pass" : "fail",
        seconds,
        sdkContract: facts.sdkContract,
        contractsVersion: facts.contractsVersion,
        detail,
      });
    });
  });
}

async function runAll(versions: string[], dirs: Map<string, string>, concurrency: number) {
  const results: VersionResult[] = [];
  const queue = [...versions];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let version = queue.shift(); version; version = queue.shift()) {
        results.push(await runVersion(version, dirs.get(version)!));
      }
    }),
  );
  return versions.map((version) => results.find((result) => result.version === version)!);
}

function printTable(results: VersionResult[], currentContract: string): void {
  const rows = [
    ["sdk", "result", "time", "sdk contract", "contracts", "detail"],
    ...results.map((result) => [
      result.version,
      result.status.toUpperCase(),
      `${result.seconds.toFixed(1)}s`,
      result.sdkContract === currentContract ? `${result.sdkContract} (=)` : result.sdkContract,
      result.contractsVersion,
      result.detail.length > 300 ? `${result.detail.slice(0, 300)}...` : result.detail,
    ]),
  ];
  const widths = rows[0]!
    .slice(0, 5)
    .map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  console.log("");
  console.log(`[sdk-compat] current API contract revision: ${currentContract}`);
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => (column < 5 ? cell.padEnd(widths[column]!) : cell))
        .join("  ")
        .trimEnd(),
    );
  }
}

function currentApiContract(): string {
  const source = readFileSync(join(REPO_ROOT, "packages", "contracts", "src", "index.ts"), "utf8");
  return /OPENGENI_API_CONTRACT_REVISION\s*=\s*"([^"]+)"/u.exec(source)?.[1] ?? "unknown";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const versions = await resolveVersions(options);
  if (versions.length === 0) fail("no SDK versions resolved");
  if (options.list) {
    for (const version of versions) console.log(version);
    return;
  }
  console.log(`[sdk-compat] versions: ${versions.join(", ")}`);
  if (!dockerAvailable()) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      fail("docker is unavailable and OPENGENI_REQUIRE_REAL_DB=1");
    }
    console.log("[sdk-compat] SKIP: docker is unavailable (the check needs real PostgreSQL)");
    return;
  }
  const started = performance.now();
  const dirs = new Map(versions.map((version) => [version, install(version, options)]));
  const results = await runAll(versions, dirs, options.concurrency);
  printTable(results, currentApiContract());
  const failed = results.filter((result) => result.status !== "pass");
  console.log(
    `[sdk-compat] ${results.length - failed.length}/${results.length} passed in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  if (failed.length > 0) process.exit(1);
}

if (import.meta.main) await main();
