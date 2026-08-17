#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeSandboxFileDownloads, type SandboxFileDownload } from "@opengeni/runtime";

const counts = integerListArgument("--counts", [0, 1, 5, 20]);
const roundTripLatenciesMs = integerListArgument("--round-trip-ms", [0, 20, 100]);
const samples = integerArgument("--samples", 3);
const parallelism = integerArgument("--parallelism", 4);
const payloadBytes = integerArgument("--payload-bytes", 4 * 1024);
const eventRoundTripMs = integerArgument("--event-round-trip-ms", 0);

if (samples < 1 || samples > 20) throw new Error("--samples must be between 1 and 20");
if (parallelism < 1 || parallelism > 8) {
  throw new Error("--parallelism must be between 1 and the agent's 8-slot admission bound");
}
if (payloadBytes < 1 || payloadBytes > 1024 * 1024) {
  throw new Error("--payload-bytes must be between 1 and 1048576");
}
if (eventRoundTripMs < 0 || eventRoundTripMs > 1_000) {
  throw new Error("--event-round-trip-ms must be between 0 and 1000");
}
if (!Bun.which("curl")) throw new Error("curl is required for the exact materialization command");

type Strategy = "bounded-batch" | "bounded-parallel" | "serial";
const strategies = strategyListArgument("--strategies", [
  "bounded-batch",
  "bounded-parallel",
  "serial",
]);
type ScenarioResult = {
  commandBytes: number;
  commandConcurrency: number;
  commandCount: number;
  count: number;
  elapsedMs: number;
  failures: number;
  phase: "cold" | "warm";
  roundTripMs: number;
  strategy: Strategy;
};

const results: ScenarioResult[] = [];
for (const count of counts) {
  for (const roundTripMs of roundTripLatenciesMs) {
    for (let sample = 0; sample < samples; sample += 1) {
      const order = sample % 2 === 0 ? [...strategies].reverse() : [...strategies];
      for (const strategy of order) {
        results.push(
          ...(await runScenario({
            count,
            roundTripMs,
            strategy,
            parallelism,
            payloadBytes,
            eventRoundTripMs,
          })),
        );
      }
    }
  }
}

const correctness = await runRepairScenario({
  count: Math.max(20, ...counts),
  parallelism,
  payloadBytes,
});
const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  invariant:
    "Every selected file remains present, byte-identical, integrity-verified, read-only, and repairable; only independent command scheduling changes.",
  configuration: {
    counts,
    parallelism,
    payloadBytes,
    roundTripLatenciesMs,
    eventRoundTripMs,
    samples,
    strategies,
  },
  measurements: summarize(results),
  correctness,
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

async function runScenario(input: {
  count: number;
  roundTripMs: number;
  strategy: Strategy;
  parallelism: number;
  payloadBytes: number;
  eventRoundTripMs: number;
}): Promise<ScenarioResult[]> {
  const fixture = await createFixture(
    input.count,
    input.payloadBytes,
    input.roundTripMs,
    input.eventRoundTripMs,
  );
  try {
    const measurements: ScenarioResult[] = [];
    for (const phase of ["cold", "warm"] as const) {
      fixture.resetMaxConcurrency();
      const startedAt = performance.now();
      const failures = await materialize(
        fixture.session,
        fixture.downloads,
        input.strategy,
        input.parallelism,
        fixture.runtimeContext,
      );
      const elapsedMs = performance.now() - startedAt;
      await fixture.assertExact();
      measurements.push({
        commandBytes: fixture.commandBytes(),
        commandConcurrency: fixture.maxConcurrency(),
        commandCount: fixture.commandCount(),
        count: input.count,
        elapsedMs,
        failures: failures.length,
        phase,
        roundTripMs: input.roundTripMs,
        strategy: input.strategy,
      });
    }
    return measurements;
  } finally {
    await fixture.close();
  }
}

async function runRepairScenario(input: {
  count: number;
  parallelism: number;
  payloadBytes: number;
}) {
  const fixture = await createFixture(input.count, input.payloadBytes, 20);
  try {
    const coldFailures = await materialize(
      fixture.session,
      fixture.downloads,
      "bounded-batch",
      input.parallelism,
    );
    await fixture.assertExact();
    if (input.count > 0) {
      await chmod(fixture.target(0), 0o644);
      await writeFile(fixture.target(0), "mutated");
    }
    if (input.count > 1) await unlink(fixture.target(1));
    const repairFailures = await materialize(
      fixture.session,
      fixture.downloads,
      "bounded-batch",
      input.parallelism,
    );
    await fixture.assertExact();
    return {
      count: input.count,
      coldFailures: coldFailures.length,
      repairFailures: repairFailures.length,
      mutatedTargetRepaired: input.count > 0,
      missingTargetRepaired: input.count > 1,
      passed: coldFailures.length === 0 && repairFailures.length === 0,
    };
  } finally {
    await fixture.close();
  }
}

async function materialize(
  session: Parameters<typeof materializeSandboxFileDownloads>[0],
  downloads: SandboxFileDownload[],
  strategy: Strategy,
  concurrencyLimit: number,
  runtimeContext?: Parameters<typeof materializeSandboxFileDownloads>[2],
) {
  if (strategy === "serial") {
    return (await materializeSandboxFileDownloads(session, downloads, runtimeContext)).failures;
  }
  return (
    await materializeSandboxFileDownloads(session, downloads, {
      ...runtimeContext,
      ...(strategy === "bounded-batch" ? { batchCommands: true } : {}),
      maxConcurrency: concurrencyLimit,
    })
  ).failures;
}

async function createFixture(
  count: number,
  fixturePayloadBytes: number,
  roundTripMs: number,
  serializedEventRoundTripMs = 0,
) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-connected-files-"));
  const workspace = join(root, "workspace");
  const sources = join(root, "sources");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sources, { recursive: true })]);
  const expected = new Map<number, Uint8Array>();
  const downloads: SandboxFileDownload[] = [];
  for (let index = 0; index < count; index += 1) {
    const content = new TextEncoder().encode(
      `${String(index).padStart(4, "0")}:${"x".repeat(Math.max(0, fixturePayloadBytes - 5))}`,
    );
    const source = join(sources, `source-${index}.txt`);
    await writeFile(source, content);
    expected.set(index, content);
    downloads.push({
      fileId: `file-${index}`,
      mountPath: `.opengeni/files/file-${index}`,
      filename: `input-${index}.txt`,
      url: pathToFileURL(source).href,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  let active = 0;
  let maxActive = 0;
  let commandBytes = 0;
  let commandCount = 0;
  let eventTail = Promise.resolve();
  const runtimeContext =
    serializedEventRoundTripMs > 0
      ? {
          onRuntimeEvent: publishEvents,
          onRuntimeEvents: publishEvents,
        }
      : undefined;
  function publishEvents() {
    const published = eventTail.then(async () => {
      await Bun.sleep(serializedEventRoundTripMs);
    });
    eventTail = published.catch(() => undefined);
    return published;
  }
  const session = {
    exec: async ({ cmd }: { cmd: string }) => {
      commandCount += 1;
      commandBytes += Buffer.byteLength(cmd, "utf8");
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (roundTripMs > 0) await Bun.sleep(roundTripMs);
        const process = Bun.spawn(["/bin/sh", "-c", cmd], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return { stdout, stderr, output: `${stdout}${stderr}`, exitCode };
      } finally {
        active -= 1;
      }
    },
  } as Parameters<typeof materializeSandboxFileDownloads>[0];
  const target = (index: number) =>
    join(workspace, ".opengeni", "files", `file-${index}`, `input-${index}.txt`);
  return {
    downloads,
    session,
    runtimeContext,
    target,
    maxConcurrency: () => maxActive,
    commandBytes: () => commandBytes,
    commandCount: () => commandCount,
    resetMaxConcurrency: () => {
      maxActive = active;
      commandBytes = 0;
      commandCount = 0;
    },
    assertExact: async () => {
      for (let index = 0; index < count; index += 1) {
        const actual = await readFile(target(index));
        const wanted = expected.get(index);
        if (!wanted || !actual.equals(wanted)) throw new Error(`file ${index} was not preserved`);
        if (((await lstat(target(index))).mode & 0o222) !== 0) {
          throw new Error(`file ${index} remained writable`);
        }
      }
    },
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}

function summarize(samplesToSummarize: ScenarioResult[]) {
  const groups = new Map<string, ScenarioResult[]>();
  for (const result of samplesToSummarize) {
    const key = `${result.count}:${result.roundTripMs}:${result.strategy}:${result.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const elapsed = group.map((result) => result.elapsedMs).sort((left, right) => left - right);
    return {
      count: first.count,
      phase: first.phase,
      roundTripMs: first.roundTripMs,
      strategy: first.strategy,
      commandBytes: distribution(
        group.map((result) => result.commandBytes).sort((left, right) => left - right),
      ),
      commandConcurrency: Math.max(...group.map((result) => result.commandConcurrency)),
      commandCount: distribution(
        group.map((result) => result.commandCount).sort((left, right) => left - right),
      ),
      failures: group.reduce((total, result) => total + result.failures, 0),
      elapsedMs: distribution(elapsed),
    };
  });
}

function distribution(ordered: number[]) {
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((item) => Number.parseInt(item, 10));
  if (parsed.length === 0 || parsed.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`${name} must be a comma-separated list of non-negative integers`);
  }
  return [...new Set(parsed)];
}

function strategyListArgument(name: string, fallback: Strategy[]): Strategy[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",");
  if (
    parsed.length === 0 ||
    parsed.some(
      (item): item is string =>
        item !== "bounded-batch" && item !== "bounded-parallel" && item !== "serial",
    )
  ) {
    throw new Error(`${name} must contain bounded-batch, bounded-parallel, or serial`);
  }
  return [...new Set(parsed)] as Strategy[];
}
