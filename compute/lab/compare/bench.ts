/**
 * The comparison benchmark's command line. See README.md and
 * docs/benchmark.md for the method.
 *
 *   bun bench.ts latency --system ours --op create:cold --runs 3 --count 30
 *   bun bench.ts latency --system gke --op activate:snapshot --count 20
 *   bun bench.ts rate --system ours --level saved --sandboxes 200 --ladder 5,10,20,50
 *   bun bench.ts summarize results.jsonl
 *   bun bench.ts cleanup --system gke
 */
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { E2b } from "./e2b.ts";
import { Gke } from "./gke.ts";
import { poissonArrivals, RestingSet, runOpenLoop, seededRandom } from "./load.ts";
import { Ours } from "./ours.ts";
import { DEFAULT_CRITERIA, judgeStep, searchSustainedRate, stepWindow } from "./search.ts";
import { formatMs, summarize } from "./stats.ts";
import { type CreateKind, READ_STATE_SCRIPT, type RunResult, type Sandbox, type System, WrongOutputError, writeStateScript } from "./system.ts";

const ECHO = "echo compare-ok";
const ECHO_OUTPUT = "compare-ok\n";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

async function makeSystem(name: string, runLabel: string, withSnapshots: boolean): Promise<System> {
  switch (name) {
    case "ours":
      return new Ours({ address: env("COMPARE_OURS_ADDRESS") });
    case "gke": {
      const gke = new Gke({
        server: env("COMPARE_GKE_SERVER"),
        token: readFileSync(env("COMPARE_GKE_TOKEN_FILE"), "utf8").trim(),
        caFile: env("COMPARE_GKE_CA_FILE"),
        namespace: process.env.COMPARE_GKE_NAMESPACE ?? "compare",
        router: env("COMPARE_GKE_ROUTER"),
        warmPool: process.env.COMPARE_GKE_WARM_POOL ?? "compare-warm",
        coldPool: process.env.COMPARE_GKE_COLD_POOL ?? "compare-cold",
        runLabel,
      });
      await gke.start(withSnapshots);
      return gke as unknown as System;
    }
    case "e2b":
      return new E2b({ apiKey: env("E2B_API_KEY"), template: process.env.COMPARE_E2B_TEMPLATE, name: "e2b-cloud" }) as unknown as System;
    case "front-door":
      return new E2b({
        apiKey: env("COMPARE_FRONT_DOOR_KEY"),
        domain: process.env.COMPARE_FRONT_DOOR_DOMAIN,
        apiUrl: process.env.COMPARE_FRONT_DOOR_API_URL,
        sandboxUrl: process.env.COMPARE_FRONT_DOOR_SANDBOX_URL,
        template: process.env.COMPARE_FRONT_DOOR_TEMPLATE,
        name: "ours-front-door",
      }) as unknown as System;
    default:
      throw new Error(`unknown system ${name}: ours, gke, e2b or front-door`);
  }
}

function expectOutput(run: RunResult, expected: string, what: string) {
  if (run.status !== 0 || run.output !== expected) {
    throw new WrongOutputError(`${what}: status ${run.status}, output ${JSON.stringify(run.output.slice(0, 120))}, expected ${JSON.stringify(expected)}`);
  }
}

/**
 * Runs `work` over `items` with at most `limit` at once. After a failure no
 * new item starts, and it rejects with the first error once the items
 * already started have finished, so callers can clean up after all of them.
 */
export async function eachLimited<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length && !failure) {
      const index = next++;
      try {
        results[index] = await work(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

class Recorder {
  constructor(
    private readonly path: string,
    private readonly common: Record<string, unknown>,
  ) {}

  write(record: Record<string, unknown>) {
    appendFileSync(this.path, `${JSON.stringify({ ...this.common, time: new Date().toISOString(), ...record })}\n`);
  }
}

interface Settings {
  runs: number;
  count: number;
  warmup: number;
  gapMs: number;
  parallel: number;
}

/** Time between runs, after the previous run's sandboxes are removed, so what they held is free again. */
const RUN_GAP_MS = 5000;

async function latencyCreate(system: System, kind: CreateKind, settings: Settings, record: Recorder) {
  for (let run = 1; run <= settings.runs; run++) {
    if (run > 1) await Bun.sleep(RUN_GAP_MS);
    for (let i = 0; i < settings.warmup + settings.count; i++) {
      const started = performance.now();
      const { sandbox, run: result } = await system.create(kind, ECHO, started);
      try {
        expectOutput(result, ECHO_OUTPUT, `create ${sandbox.id}`);
        record.write({ kind: "sample", op: `create:${kind}`, script: "echo", run, i, warmup: i < settings.warmup, sandbox: sandbox.id, ...result, output: undefined });
      } finally {
        await system.remove(sandbox);
      }
      await Bun.sleep(settings.gapMs);
    }
  }
}

/**
 * Creates `count` sandboxes that each wrote a state file, then runs `then`
 * on each before the next is created, so at most `parallel` are new at
 * once. Removes them all if any fails.
 */
async function prepare(
  system: System,
  count: number,
  parallel: number,
  then?: (sandbox: Sandbox) => Promise<void>,
): Promise<{ sandbox: Sandbox; token: string }[]> {
  const made: Sandbox[] = [];
  try {
    return await eachLimited(Array.from({ length: count }), parallel, async () => {
      const { sandbox, run } = await system.create("pool", ECHO, performance.now());
      made.push(sandbox);
      expectOutput(run, ECHO_OUTPUT, `create ${sandbox.id}`);
      const token = randomBytes(12).toString("hex");
      const wrote = await system.run(sandbox, writeStateScript(token), performance.now());
      if (wrote.status !== 0) throw new Error(`writing the state file in ${sandbox.id} failed: ${wrote.status}`);
      await then?.(sandbox);
      return { sandbox, token };
    });
  } catch (error) {
    await eachLimited(made, parallel, (sandbox) => system.remove(sandbox).catch(() => undefined));
    throw error;
  }
}

async function latencyActivate(system: System, level: string, settings: Settings, record: Recorder) {
  if (!system.restLevels.includes(level)) throw new Error(`${system.name} has no level ${level}: ${system.restLevels.join(", ")}`);
  for (let run = 1; run <= settings.runs; run++) {
    if (run > 1) await Bun.sleep(RUN_GAP_MS);
    const prepared = await prepare(system, settings.warmup + settings.count, settings.parallel);
    try {
      for (const [i, { sandbox, token }] of prepared.entries()) {
        for (const [script, expected, label] of [
          [ECHO, ECHO_OUTPUT, "echo"],
          [READ_STATE_SCRIPT, `${token}\n`, "python-state"],
        ] as const) {
          const restStarted = performance.now();
          await system.rest(sandbox, level);
          const restMs = performance.now() - restStarted;
          await Bun.sleep(settings.gapMs);
          const started = performance.now();
          const result = await system.run(sandbox, script, started);
          expectOutput(result, expected, `${label} in ${sandbox.id} from ${level}`);
          record.write({ kind: "sample", op: `activate:${level}`, script: label, run, i, warmup: i < settings.warmup, sandbox: sandbox.id, rest_ms: restMs, ...result, output: undefined });
        }
      }
    } finally {
      await eachLimited(prepared, settings.parallel, ({ sandbox }) => system.remove(sandbox).catch(() => undefined));
    }
  }
}

interface RateSettings {
  level: string;
  sandboxes: number;
  ladder: number[];
  stepMs: number;
  warmupMs: number;
  refinements: number;
  seed: number;
  parallel: number;
  /** The p99 a step must stay under; see docs/benchmark.md for when it is not 1 s. */
  p99LimitMs: number;
  /** Quiet time between putting the N to rest and the first step. */
  settleMs: number;
}

async function rate(system: System, settings: RateSettings, record: Recorder) {
  if (!system.restLevels.includes(settings.level)) throw new Error(`${system.name} has no level ${settings.level}`);
  // Each rests as soon as it is made: a host need not hold all N awake.
  const prepared = await prepare(system, settings.sandboxes, settings.parallel, (sandbox) => system.rest(sandbox, settings.level));
  const sandboxes = prepared.map(({ sandbox }) => sandbox);
  let restErrors = 0;
  try {
    // Let the system finish what putting N to rest started, such as writing it out.
    record.write({ kind: "settle", seconds: settings.settleMs / 1000 });
    await Bun.sleep(settings.settleMs);
    const random = seededRandom(settings.seed);
    const resting = new RestingSet(sandboxes, random);
    let stepIndex = 0;
    const result = await searchSustainedRate(
      settings.ladder,
      async (offered) => {
        stepIndex += 1;
        const window = stepWindow(offered, settings.stepMs - settings.warmupMs, settings.warmupMs);
        const arrivals = poissonArrivals(offered, window.stepMs, seededRandom(settings.seed * 1000 + stepIndex));
        const outcomes = await runOpenLoop(arrivals, async (scheduledAt) => {
          const sandbox = resting.take();
          try {
            const run = await system.run(sandbox, ECHO, scheduledAt);
            expectOutput(run, ECHO_OUTPUT, `echo in ${sandbox.id}`);
            return scheduledAt + run.firstByteMs;
          } finally {
            // Back to rest, then free to be picked again.
            void system.rest(sandbox, settings.level).then(
              () => resting.give(sandbox),
              (error: unknown) => {
                restErrors += 1;
                record.write({ kind: "rest-error", sandbox: sandbox.id, error: String(error) });
              },
            );
          }
        });
        // Steps never overlap: wait until every sandbox rests again.
        const settleBy = performance.now() + 300_000;
        while (resting.size + restErrors < sandboxes.length && performance.now() < settleBy) await Bun.sleep(100);
        const step = judgeStep(offered, outcomes, settings.warmupMs, window.measuredMs, {
          ...DEFAULT_CRITERIA,
          p99LimitMs: settings.p99LimitMs,
        });
        const lag = summarize(outcomes.map((outcome) => outcome.lagMs));
        record.write({ kind: "step", level: settings.level, sandboxes: settings.sandboxes, restErrors, clientLagP99: lag.p99, ...step });
        console.log(`${offered}/s: ${step.holds ? "holds" : `fails (${step.reason})`}, p50 ${formatMs(step.latency?.p50 ?? 0)}, p99 ${formatMs(step.latency?.p99 ?? 0)}, completed ${step.completedRate.toFixed(1)}/s`);
        return step;
      },
      settings.refinements,
    );
    record.write({ kind: "search", level: settings.level, sandboxes: settings.sandboxes, p99LimitMs: settings.p99LimitMs, sustained: result.sustained, errorOnset: result.errorOnset, clientLimited: result.clientLimited, restErrors });
    console.log(`sustained ${result.sustained}/s, errors from ${result.errorOnset ?? "none"}${result.clientLimited ? ", client-limited" : ""}`);
  } finally {
    await eachLimited(sandboxes, settings.parallel, (sandbox) => system.remove(sandbox).catch(() => undefined));
  }
}

/** Prints p50/p90/p99/max per operation and script, without warm-ups. */
export function summarizeFile(path: string): string[] {
  const groups = new Map<string, { all: number[]; done: number[]; byRun: Map<number, number[]> }>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind !== "sample" || record.warmup) continue;
    const key = `${record.system} ${record.op} ${record.script}`;
    let group = groups.get(key);
    if (!group) {
      group = { all: [], done: [], byRun: new Map() };
      groups.set(key, group);
    }
    group.all.push(record.firstByteMs);
    group.done.push(record.doneMs);
    const run = group.byRun.get(record.run) ?? [];
    run.push(record.firstByteMs);
    group.byRun.set(record.run, run);
  }
  const lines: string[] = [];
  for (const [key, group] of groups) {
    const first = summarize(group.all);
    const done = summarize(group.done);
    const medians = [...group.byRun.values()].map((samples) => summarize(samples).p50);
    lines.push(
      `${key}: n=${first.count} p50 ${formatMs(first.p50)} p90 ${formatMs(first.p90)} p99 ${formatMs(first.p99)} max ${formatMs(first.max)}; done p50 ${formatMs(done.p50)}; run p50s ${medians.map(formatMs).join(", ")}`,
    );
  }
  return lines;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      system: { type: "string", default: "ours" },
      op: { type: "string" },
      level: { type: "string" },
      runs: { type: "string", default: "3" },
      count: { type: "string", default: "30" },
      warmup: { type: "string", default: "5" },
      "gap-ms": { type: "string", default: "1000" },
      parallel: { type: "string", default: "8" },
      sandboxes: { type: "string", default: "100" },
      ladder: { type: "string", default: "1,2,5,10,20,50,100,200" },
      "step-seconds": { type: "string", default: "60" },
      "warmup-seconds": { type: "string", default: "10" },
      refinements: { type: "string", default: "3" },
      seed: { type: "string", default: "1" },
      "p99-limit-ms": { type: "string", default: String(DEFAULT_CRITERIA.p99LimitMs) },
      "settle-seconds": { type: "string", default: "120" },
      out: { type: "string", default: "results.jsonl" },
      note: { type: "string", default: "" },
    },
  });
  if (command === "summarize") {
    for (const path of positionals) for (const line of summarizeFile(path)) console.log(line);
    return;
  }
  const runLabel = randomBytes(4).toString("hex");
  const level = values.level ?? values.op?.split(":")[1] ?? "";
  const withSnapshots = level === "snapshot";
  const system = await makeSystem(values.system as string, runLabel, withSnapshots);
  try {
    if (command === "cleanup") {
      const ids = await system.list();
      console.log(`${ids.length} sandboxes on ${system.name}; remove them with the system's own tools if they are this harness's`);
      return;
    }
    const record = new Recorder(values.out as string, { system: system.name, runLabel, note: values.note });
    record.write({ kind: "meta", command, args: values, describe: await system.describe() });
    const settings: Settings = {
      runs: Number(values.runs),
      count: Number(values.count),
      warmup: Number(values.warmup),
      gapMs: Number(values["gap-ms"]),
      parallel: Number(values.parallel),
    };
    if (command === "latency") {
      const [op, arg] = (values.op ?? "").split(":");
      if (op === "create") await latencyCreate(system, arg as CreateKind, settings, record);
      else if (op === "activate") await latencyActivate(system, arg, settings, record);
      else throw new Error("--op is create:cold, create:template, create:pool or activate:LEVEL");
      for (const line of summarizeFile(values.out as string).filter((entry) => entry.startsWith(`${system.name} ${values.op} `))) console.log(line);
    } else if (command === "rate") {
      await rate(
        system,
        {
          level,
          sandboxes: Number(values.sandboxes),
          ladder: (values.ladder as string).split(",").map(Number),
          stepMs: Number(values["step-seconds"]) * 1000,
          warmupMs: Number(values["warmup-seconds"]) * 1000,
          refinements: Number(values.refinements),
          seed: Number(values.seed),
          parallel: settings.parallel,
          p99LimitMs: Number(values["p99-limit-ms"]),
          settleMs: Number(values["settle-seconds"]) * 1000,
        },
        record,
      );
    } else {
      throw new Error("commands: latency, rate, summarize, cleanup");
    }
  } finally {
    await system.close();
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
