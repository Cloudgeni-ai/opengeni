import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dockerfile = await readFile(
  new URL("../docker/opengeni.Dockerfile", import.meta.url),
  "utf8",
);
const sourceBase = dockerfile
  .split("FROM oven/bun:${BUN_VERSION} AS source-base\n")[1]!
  .split("\nFROM ")[0]!;
const sourceLines = sourceBase.split("\n");
const runIndex = sourceLines.findIndex((line) => line.startsWith("RUN "));
if (runIndex < 0) throw new Error("source-base install instruction is missing");
const runLines = [sourceLines[runIndex]!.slice(4)];
for (let index = runIndex; sourceLines[index]!.endsWith("\\"); index += 1) {
  runLines.push(sourceLines[index + 1]!);
}
// Execute the actual Docker RUN recipe with its default POSIX shell. Only Bun
// and sleep are replaced; mktemp and shell control flow remain real.
const installRecipe = runLines.join("\n");

type Trace = { installs: Array<{ args: string[]; cache: string | null }>; sleeps: string[][] };

async function executeInstall(statuses: number[], sleepStatus = 0) {
  const fixture = await mkdtemp(join(tmpdir(), "opengeni-frozen-install-"));
  const bin = join(fixture, "bin");
  const existingCache = join(fixture, "existing-cache");
  const tracePath = join(fixture, "trace.json");
  try {
    await mkdir(bin);
    await mkdir(existingCache);
    await writeFile(join(existingCache, "preserve"), "existing cache survives");
    await writeFile(tracePath, JSON.stringify({ installs: [], sleeps: [] }));
    const stub = `#!${process.execPath}
const path = process.env.OPENGENI_INSTALL_TEST_TRACE;
const trace = await Bun.file(path).json();
const command = process.argv[1].split('/').at(-1);
let status;
if (command === 'bun') {
  const statuses = JSON.parse(process.env.OPENGENI_INSTALL_TEST_STATUSES);
  const index = trace.installs.length;
  trace.installs.push({args: process.argv.slice(2), cache: process.env.BUN_INSTALL_CACHE_DIR ?? null});
  status = statuses[Math.min(index, statuses.length - 1)];
} else {
  trace.sleeps.push(process.argv.slice(2));
  status = Number(process.env.OPENGENI_INSTALL_TEST_SLEEP_STATUS);
}
await Bun.write(path, JSON.stringify(trace));
process.exit(status);
`;
    for (const command of ["bun", "sleep"]) {
      await writeFile(join(bin, command), stub);
      await chmod(join(bin, command), 0o755);
    }
    const child = Bun.spawn(["/bin/sh", "-c", installRecipe], {
      cwd: fixture,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TMPDIR: fixture,
        BUN_INSTALL_CACHE_DIR: existingCache,
        OPENGENI_INSTALL_TEST_TRACE: tracePath,
        OPENGENI_INSTALL_TEST_STATUSES: JSON.stringify(statuses),
        OPENGENI_INSTALL_TEST_SLEEP_STATUS: String(sleepStatus),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    const trace = JSON.parse(await readFile(tracePath, "utf8")) as Trace;
    expect(stderr).toBe("");
    for (const call of trace.installs) expect(call.args).toEqual(["install", "--frozen-lockfile"]);
    expect(trace.installs[0]!.cache).toBe(existingCache);
    expect(await readFile(join(existingCache, "preserve"), "utf8")).toBe("existing cache survives");
    const retryCaches = trace.installs.slice(1).map((call) => call.cache);
    expect(new Set(retryCaches).size).toBe(retryCaches.length);
    for (const cache of retryCaches) {
      expect(cache).not.toBe(existingCache);
      expect(cache!.startsWith(`${fixture}/`)).toBe(true);
      expect((await stat(cache!)).mode & 0o777).toBe(0o700);
    }
    return { exitCode, trace };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe("workload source-base frozen install recovery", () => {
  test("successful first install exits immediately without retry or delay", async () => {
    const { exitCode, trace } = await executeInstall([0]);
    expect(exitCode).toBe(0);
    expect(trace.installs).toHaveLength(1);
    expect(trace.sleeps).toEqual([]);
  });

  test("recovers on the second frozen attempt with a private cache", async () => {
    const { exitCode, trace } = await executeInstall([1, 0]);
    expect(exitCode).toBe(0);
    expect(trace.installs).toHaveLength(2);
    expect(trace.sleeps).toEqual([["5"]]);
  });

  test("recovers on the third and final attempt", async () => {
    const { exitCode, trace } = await executeInstall([1, 7, 0]);
    expect(exitCode).toBe(0);
    expect(trace.installs).toHaveLength(3);
    expect(trace.sleeps).toEqual([["5"], ["10"]]);
  });

  test("persistent failure stops after three attempts and preserves terminal status", async () => {
    const { exitCode, trace } = await executeInstall([1, 7, 42, 0]);
    expect(exitCode).toBe(42);
    expect(trace.installs).toHaveLength(3);
    expect(trace.sleeps).toEqual([["5"], ["10"]]);
  });

  test("a failed backoff fails closed before another install", async () => {
    const { exitCode, trace } = await executeInstall([1, 0], 19);
    expect(exitCode).toBe(19);
    expect(trace.installs).toHaveLength(1);
    expect(trace.sleeps).toEqual([["5"]]);
  });
});
