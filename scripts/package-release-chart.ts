#!/usr/bin/env bun
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function packageReleaseChart(input: {
  chartDirectory: string;
  output: string;
  version: string;
  appVersion: string;
  run?: Spawn;
}): Promise<void> {
  if (!versionPattern.test(input.version)) {
    throw new Error("chart version must be exact semver");
  }
  if (!input.appVersion.trim() || /[\r\n]/.test(input.appVersion)) {
    throw new Error("chart app version must be a nonempty single line");
  }

  const chartDirectory = resolve(input.chartDirectory);
  const output = resolve(input.output);
  const run = input.run ?? spawn;
  const scratch = await mkdtemp(resolve(tmpdir(), "opengeni-release-chart-"));
  try {
    const packaged = resolve(scratch, "packaged");
    const extracted = resolve(scratch, "extracted");
    await mkdir(packaged, { recursive: true });
    await mkdir(extracted, { recursive: true });

    await run(
      [
        "helm",
        "package",
        chartDirectory,
        "--destination",
        packaged,
        "--version",
        input.version,
        "--app-version",
        input.appVersion,
      ],
      process.cwd(),
    );
    const archives = (await readdir(packaged)).filter((name) => name.endsWith(".tgz")).sort();
    if (archives.length !== 1) {
      throw new Error(`Helm must produce exactly one chart archive (found ${archives.length})`);
    }
    const archive = resolve(packaged, archives[0]!);
    await run(["tar", "-xzf", archive, "-C", extracted], process.cwd());

    const roots = (await readdir(extracted)).sort();
    if (roots.length !== 1) {
      throw new Error(`packaged chart must contain exactly one root (found ${roots.length})`);
    }
    const tar = await run(
      [
        "tar",
        "--sort=name",
        "--format=ustar",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-cf",
        "-",
        roots[0],
      ],
      extracted,
    );
    const gzip = gzipSync(tar, { level: 9 });
    // Node emits zero mtime today, but set the RFC 1952 field explicitly so
    // chart identity cannot drift with a runtime implementation detail.
    gzip.fill(0, 4, 8);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, gzip, { mode: 0o644 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type Spawn = (argv: string[], cwd: string) => Promise<Buffer>;

async function spawn(argv: string[], cwd: string): Promise<Buffer> {
  const child = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv[0]} failed with exit ${exitCode}: ${stderr.trim()}`);
  }
  return Buffer.from(stdout);
}

function parseArgs(values: string[]): {
  chartDirectory: string;
  output: string;
  version: string;
  appVersion: string;
} {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? "<missing>"}`);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (parsed.has(flag)) throw new Error(`${flag} may be supplied only once`);
    parsed.set(flag, value);
  }
  const allowed = new Set(["--chart", "--output", "--version", "--app-version"]);
  for (const flag of parsed.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
  }
  const required = (flag: string) => {
    const value = parsed.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    chartDirectory: required("--chart"),
    output: required("--output"),
    version: required("--version"),
    appVersion: required("--app-version"),
  };
}

if (import.meta.main) {
  await packageReleaseChart(parseArgs(process.argv.slice(2)));
}
