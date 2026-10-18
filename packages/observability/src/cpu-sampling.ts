import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * On-demand CPU sampling for live processes. Sending the configured signal
 * (default SIGUSR2) samples the whole JavaScript VM for a bounded window and
 * reports where the event loop was busy: the hottest functions overall and,
 * for every continuous busy stretch above a threshold, its dominant stacks.
 * This attributes event-loop stalls without restarting the process or
 * attaching a debugger.
 */

export type CpuSampleFrame = Readonly<{
  name?: string;
  sourceURL?: string;
  line?: number;
  column?: number;
}>;

export type CpuSampleTrace = Readonly<{
  /** Seconds, monotonic. */
  timestamp: number;
  /** Innermost frame first. */
  frames: readonly CpuSampleFrame[];
}>;

export type CpuSamplingCount = Readonly<{ label: string; samples: number }>;

export type CpuSamplingBlock = Readonly<{
  /** Milliseconds since the profile started. */
  startOffsetMs: number;
  durationMs: number;
  samples: number;
  topStacks: readonly CpuSamplingCount[];
  topInclusive: readonly CpuSamplingCount[];
}>;

export type CpuSamplingSummary = Readonly<{
  windowMs: number;
  sampleIntervalMs: number;
  samples: number;
  busyMs: number;
  topSelf: readonly CpuSamplingCount[];
  topInclusive: readonly CpuSamplingCount[];
  blocks: readonly CpuSamplingBlock[];
}>;

export type AnalyzeCpuSamplesOptions = Readonly<{
  windowMs: number;
  sampleIntervalMs: number;
  /** Busy stretches at least this long are reported individually. */
  minBlockMs?: number;
  maxBlocks?: number;
  topCount?: number;
  stackDepth?: number;
}>;

const UNKNOWN_LINE = 4_294_967_295;

/** Pure analysis of sampled stacks; exported for tests and offline use. */
export function analyzeCpuSamples(
  traces: readonly CpuSampleTrace[],
  options: AnalyzeCpuSamplesOptions,
): CpuSamplingSummary {
  const minBlockMs = options.minBlockMs ?? 100;
  const maxBlocks = options.maxBlocks ?? 20;
  const topCount = options.topCount ?? 15;
  const stackDepth = options.stackDepth ?? 14;
  const sorted = [...traces]
    .filter((trace) => Number.isFinite(trace.timestamp) && trace.frames.length > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  for (const trace of sorted) {
    increment(self, frameLabel(trace.frames[0]!));
    for (const label of new Set(trace.frames.map(frameLabel))) increment(inclusive, label);
  }

  // Samples are only taken while JavaScript runs, so a gap well above the
  // sampling interval means the event loop was free in between.
  const gapSeconds = Math.max(options.sampleIntervalMs * 10, 10) / 1_000;
  const runs: CpuSampleTrace[][] = [];
  let current: CpuSampleTrace[] = [];
  for (const trace of sorted) {
    const previous = current.at(-1);
    if (previous && trace.timestamp - previous.timestamp > gapSeconds) {
      runs.push(current);
      current = [];
    }
    current.push(trace);
  }
  if (current.length > 0) runs.push(current);

  const origin = sorted[0]?.timestamp ?? 0;
  let busyMs = 0;
  const blocks: CpuSamplingBlock[] = [];
  for (const run of runs) {
    const durationMs =
      (run.at(-1)!.timestamp - run[0]!.timestamp) * 1_000 + options.sampleIntervalMs;
    busyMs += durationMs;
    if (durationMs < minBlockMs) continue;
    const stacks = new Map<string, number>();
    const runInclusive = new Map<string, number>();
    for (const trace of run) {
      increment(stacks, trace.frames.slice(0, stackDepth).map(frameLabel).join(" < "));
      for (const label of new Set(trace.frames.map(frameLabel))) increment(runInclusive, label);
    }
    blocks.push({
      startOffsetMs: Math.round((run[0]!.timestamp - origin) * 1_000),
      durationMs: Math.round(durationMs),
      samples: run.length,
      topStacks: top(stacks, 5),
      topInclusive: top(runInclusive, topCount),
    });
  }
  blocks.sort((left, right) => right.durationMs - left.durationMs);
  return {
    windowMs: options.windowMs,
    sampleIntervalMs: options.sampleIntervalMs,
    samples: sorted.length,
    busyMs: Math.round(busyMs),
    topSelf: top(self, topCount),
    topInclusive: top(inclusive, topCount),
    blocks: blocks.slice(0, maxBlocks),
  };
}

export type CpuSamplingSignalOptions = Readonly<{
  log: (message: string, attributes: Record<string, string | number>) => void;
  signal?: NodeJS.Signals;
  durationMs?: number;
  sampleIntervalMicros?: number;
  outputDirectory?: string;
}>;

/**
 * Installs the signal trigger when running on Bun. Returns an uninstaller.
 * Overlapping triggers are ignored while a capture is in progress.
 */
export function installCpuSamplingSignal(options: CpuSamplingSignalOptions): () => void {
  if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") return () => undefined;
  const signal = options.signal ?? "SIGUSR2";
  let running = false;
  const handler = () => {
    if (running) return;
    running = true;
    void captureAndReport(options)
      .catch((error: unknown) => {
        options.log("cpu sampling profile failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  process.on(signal, handler);
  return () => {
    process.off(signal, handler);
  };
}

/** Samples the VM for durationMs and analyzes the result. */
export async function captureCpuSamplingProfile(
  durationMs: number,
  sampleIntervalMicros = 1_000,
): Promise<CpuSamplingSummary> {
  const jsc = (await import("bun:jsc")) as unknown as {
    profile: (
      callback: () => Promise<void>,
      sampleInterval: number,
    ) => Promise<{ stackTraces: unknown }>;
  };
  const result = await jsc.profile(async () => {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }, sampleIntervalMicros);
  const traces = (result.stackTraces as { traces?: CpuSampleTrace[] } | undefined)?.traces ?? [];
  return analyzeCpuSamples(traces, {
    windowMs: durationMs,
    sampleIntervalMs: sampleIntervalMicros / 1_000,
  });
}

async function captureAndReport(options: CpuSamplingSignalOptions): Promise<void> {
  const durationMs = options.durationMs ?? 30_000;
  options.log("cpu sampling profile started", { durationMs });
  const summary = await captureCpuSamplingProfile(durationMs, options.sampleIntervalMicros);
  const directory = options.outputDirectory ?? tmpdir();
  await mkdir(directory, { recursive: true });
  const path = join(directory, `opengeni-cpu-profile-${process.pid}-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(summary, null, 2));
  options.log("cpu sampling profile completed", {
    cpuProfilePath: path,
    cpuProfileWindowMs: summary.windowMs,
    cpuProfileSamples: summary.samples,
    cpuProfileBusyMs: summary.busyMs,
    cpuProfileLongestBlockMs: summary.blocks[0]?.durationMs ?? 0,
    cpuProfileBlocksOver100Ms: summary.blocks.length,
    cpuProfileTopSelf: logSafeFrames(
      summary.topSelf
        .slice(0, 8)
        .map((entry) => `${entry.samples} ${entry.label}`)
        .join(" | "),
    ),
    cpuProfileLongestBlockTopStack: logSafeFrames(
      summary.blocks[0]?.topStacks[0]?.label.slice(0, 1_500) ?? "",
    ),
  });
}

/**
 * Structured logs publish only allow-listed attributes; frame labels must fit
 * the code-location grammar there, so any other character becomes `?`.
 */
function logSafeFrames(text: string): string {
  return text.replace(/[^\w$<>()[\]:./@ |#*,-]/g, "?").slice(0, 2_000);
}

function frameLabel(frame: CpuSampleFrame): string {
  const name = frame.name && frame.name.length > 0 ? frame.name : "(anonymous)";
  if (!frame.sourceURL) return name;
  // Production bundles are whitespace-minified, so the column locates the frame.
  const line =
    frame.line !== undefined && frame.line !== UNKNOWN_LINE
      ? `:${frame.line}${frame.column !== undefined && frame.column !== UNKNOWN_LINE ? `:${frame.column}` : ""}`
      : "";
  return `${name} ${basename(frame.sourceURL)}${line}`;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, count: number): CpuSamplingCount[] {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([label, samples]) => ({ label, samples }));
}
