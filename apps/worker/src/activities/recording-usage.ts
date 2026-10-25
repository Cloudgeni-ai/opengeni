import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { Attributes, Observability } from "@opengeni/observability";

/**
 * What a recording's processing costs this deployment, stage by stage:
 * wall time, the CPU and peak memory of the programs it runs (ffmpeg and the
 * speaker models do the heavy work), and the provider time it waits on.
 *
 * - prepare: download the chunks and write one seekable file per track.
 * - convert: re-encode a track or cut it into pieces a model accepts.
 * - diarize: our speaker models (decoding included).
 * - transcribe: waiting on the transcription provider.
 * - segment: cut a dictation into the voice input's pieces.
 * - finish: store the transcript and settle its charge.
 */
export const RECORDING_USAGE_STAGES = [
  "prepare",
  "convert",
  "diarize",
  "transcribe",
  "segment",
  "finish",
] as const;
export type RecordingUsageStage = (typeof RECORDING_USAGE_STAGES)[number];

export type RecordingStageUsage = {
  /** Time spent in the stage; stages that run side by side overlap. */
  wallSeconds: number;
  /** User plus system CPU of the programs the stage ran. */
  cpuSeconds: number;
  /** The most memory the stage's programs held at once. */
  peakMemoryBytes: number;
  /** Peak memory times run time, summed: what reserving that memory costs. */
  memoryByteSeconds: number;
  processes: number;
};

/** A finished child process's own accounting, as Bun reports it. */
export type ProcessResourceUsage = {
  cpuTime: { total: bigint | number };
};

export type MeasuredProcess = {
  pid: number;
  exited: Promise<number>;
  resourceUsage(): ProcessResourceUsage | undefined;
};

/** How often a running program's memory high-water mark is read. */
const MEMORY_SAMPLE_MILLISECONDS = 100;

export class RecordingUsage {
  readonly #stages = new Map<RecordingUsageStage, RecordingStageUsage>();

  #stage(stage: RecordingUsageStage): RecordingStageUsage {
    let usage = this.#stages.get(stage);
    if (!usage) {
      usage = {
        wallSeconds: 0,
        cpuSeconds: 0,
        peakMemoryBytes: 0,
        memoryByteSeconds: 0,
        processes: 0,
      };
      this.#stages.set(stage, usage);
    }
    return usage;
  }

  addWall(stage: RecordingUsageStage, seconds: number): void {
    this.#stage(stage).wallSeconds += Math.max(0, seconds);
  }

  /** Programs that ran together, such as a decoder piped into a model. */
  addProcesses(
    stage: RecordingUsageStage,
    processes: ReadonlyArray<{ cpuSeconds: number; maxRssBytes: number; wallSeconds: number }>,
  ): void {
    if (processes.length === 0) return;
    const usage = this.#stage(stage);
    let memory = 0;
    for (const process of processes) {
      usage.cpuSeconds += Math.max(0, process.cpuSeconds);
      usage.memoryByteSeconds +=
        Math.max(0, process.maxRssBytes) * Math.max(0, process.wallSeconds);
      memory += Math.max(0, process.maxRssBytes);
      usage.processes += 1;
    }
    usage.peakMemoryBytes = Math.max(usage.peakMemoryBytes, memory);
  }

  stages(): ReadonlyMap<RecordingUsageStage, Readonly<RecordingStageUsage>> {
    return this.#stages;
  }
}

const active = new AsyncLocalStorage<{
  usage: RecordingUsage;
  stage: RecordingUsageStage | null;
}>();

/** Account the processing `work` does to `usage`. */
export async function withRecordingUsage<T>(
  usage: RecordingUsage,
  work: () => Promise<T>,
): Promise<T> {
  return await active.run({ usage, stage: null }, work);
}

/** Run `work` as `stage` of the recording being processed, if any. */
export async function measureRecordingStage<T>(
  stage: RecordingUsageStage,
  work: () => Promise<T>,
): Promise<T> {
  const store = active.getStore();
  if (!store) return await work();
  const started = performance.now();
  try {
    return await active.run({ usage: store.usage, stage }, work);
  } finally {
    store.usage.addWall(stage, (performance.now() - started) / 1_000);
  }
}

/**
 * Count programs just started for the current stage once they exit. Call it
 * right after spawning them, so it sees the stage they were started in.
 */
export function trackRecordingProcesses(processes: readonly MeasuredProcess[]): void {
  const store = active.getStore();
  if (!store?.stage) return;
  const { usage, stage } = store;
  const started = performance.now();
  void Promise.all(
    processes.map(async (process) => {
      const peak = sampleMemoryHighWater(process.pid);
      await process.exited;
      const wallSeconds = (performance.now() - started) / 1_000;
      const maxRssBytes = peak.stop();
      const resources = process.resourceUsage();
      return resources
        ? { cpuSeconds: Number(resources.cpuTime.total) / 1_000_000, maxRssBytes, wallSeconds }
        : null;
    }),
  ).then(
    (measured) =>
      usage.addProcesses(
        stage,
        measured.filter((item): item is NonNullable<typeof item> => item !== null),
      ),
    () => undefined,
  );
}

/**
 * A running program's peak memory, from Linux's VmHWM. The rusage maximum
 * can't be used: on exec Linux keeps the high-water mark of the memory the
 * child was spawned with, which is the whole worker's. Samples taken before
 * the program replaced the worker's image are skipped for the same reason.
 * Other systems report 0.
 */
function sampleMemoryHighWater(pid: number): { stop(): number } {
  if (process.platform !== "linux") return { stop: () => 0 };
  let peak = 0;
  let reading = false;
  const sample = () => {
    if (reading) return;
    reading = true;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const name = /^Name:\s+(.*)$/mu.exec(status)?.[1];
      const highWater = /^VmHWM:\s+(\d+) kB$/mu.exec(status)?.[1];
      if (name && name !== workerName() && highWater) {
        peak = Math.max(peak, Number(highWater) * 1024);
      }
    } catch {
      // Exited between samples.
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(sample, MEMORY_SAMPLE_MILLISECONDS);
  timer.unref?.();
  setTimeout(sample, 10).unref?.();
  return {
    stop() {
      clearInterval(timer);
      return peak;
    },
  };
}

let ownName: string | null = null;
function workerName(): string {
  ownName ??= readFileSync("/proc/self/status", "utf8").match(/^Name:\s+(.*)$/mu)?.[1] ?? "";
  return ownName;
}

/** Read a child's output stream, keeping only its last `limit` characters. */
export async function readTail(
  stream: ReadableStream<Uint8Array> | null | undefined,
  limit: number,
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text = (text + decoder.decode(chunk, { stream: true })).slice(-limit);
  }
  return (text + decoder.decode()).slice(-limit);
}

/** Run a program for the current stage, the way the dictation segmenter expects. */
export async function runMeasuredCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stderr: string; spawnError: boolean; cancelled: boolean }> {
  let child;
  try {
    child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch {
    return { exitCode: null, stderr: "", spawnError: true, cancelled: signal?.aborted ?? false };
  }
  trackRecordingProcesses([child]);
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, readTail(child.stderr, 65_536)]);
    return {
      exitCode: child.signalCode ? null : exitCode,
      stderr: stderr.trim(),
      spawnError: false,
      cancelled: signal?.aborted ?? false,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export type RecordingUsageLabels = {
  purpose: "meeting" | "dictation";
  provider: string;
  model: string;
  /** Who pays the provider: deployment, workspace_key, workspace_subscription or none. */
  funding: string;
};

export type RecordingProcessingReport = RecordingUsageLabels & {
  outcome: "complete" | "failed" | "retry" | "skipped";
  errorCode: string | null;
  audioSeconds: number;
  wallSeconds: number;
  queueSeconds: number | null;
  preparedBytes: number;
  providerCostUsd: number | null;
  credits: number | null;
  diarization: string | null;
  speakers: number | null;
  ourDiarizerFailed: boolean;
  stages: ReadonlyMap<RecordingUsageStage, Readonly<RecordingStageUsage>>;
};

const DURATION_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1_200, 1_800, 3_600];
const MEMORY_BUCKETS = [
  16, 32, 64, 128, 256, 512, 768, 1_024, 1_536, 2_048, 3_072, 4_096, 8_192,
].map((megabytes) => megabytes * 1024 * 1024);
const AUDIO_BUCKETS = [10, 30, 60, 300, 900, 1_800, 3_600, 7_200, 14_400];

/**
 * Publish one version's processing as metrics, and log it whole so a single
 * recording can be looked at. Telemetry failures never reach the recording.
 */
export function reportRecordingProcessing(
  observability: Observability,
  report: RecordingProcessingReport,
  context: Attributes,
): void {
  try {
    const labels = {
      purpose: report.purpose,
      provider: report.provider,
      model: report.model,
      funding: report.funding,
    };
    observability.incrementCounter({
      name: "opengeni_recording_transcripts_total",
      help: "Transcript versions processed, by outcome and closed error code.",
      labels: { ...labels, outcome: report.outcome, error_code: report.errorCode ?? "" },
    });
    observability.observeHistogram({
      name: "opengeni_recording_processing_seconds",
      help: "Wall time of one transcript version's processing attempt.",
      labels: { purpose: report.purpose, provider: report.provider, outcome: report.outcome },
      value: report.wallSeconds,
      buckets: DURATION_BUCKETS,
    });
    if (report.queueSeconds !== null) {
      observability.observeHistogram({
        name: "opengeni_recording_queue_seconds",
        help: "Time a transcript version waited between being asked for and first being worked on.",
        labels: { purpose: report.purpose },
        value: report.queueSeconds,
        buckets: DURATION_BUCKETS,
      });
    }
    for (const [stage, usage] of report.stages) {
      const stageLabels = { ...labels, stage };
      observability.incrementCounter({
        name: "opengeni_recording_stage_cpu_seconds_total",
        help: "CPU seconds the programs of a recording processing stage used.",
        labels: stageLabels,
        amount: usage.cpuSeconds,
      });
      observability.incrementCounter({
        name: "opengeni_recording_stage_wall_seconds_total",
        help: "Wall seconds spent in a recording processing stage.",
        labels: stageLabels,
        amount: usage.wallSeconds,
      });
      observability.incrementCounter({
        name: "opengeni_recording_stage_memory_byte_seconds_total",
        help: "Peak memory times run time of a stage's programs, in byte-seconds.",
        labels: stageLabels,
        amount: usage.memoryByteSeconds,
      });
      if (usage.processes > 0) {
        observability.observeHistogram({
          name: "opengeni_recording_stage_peak_memory_bytes",
          help: "The most memory a stage's programs held at once, per transcript version.",
          labels: { purpose: report.purpose, stage },
          value: usage.peakMemoryBytes,
          buckets: MEMORY_BUCKETS,
        });
      }
    }
    if (report.outcome === "complete") {
      observability.incrementCounter({
        name: "opengeni_recording_audio_seconds_total",
        help: "Seconds of audio transcribed.",
        labels,
        amount: report.audioSeconds,
      });
      observability.observeHistogram({
        name: "opengeni_recording_audio_duration_seconds",
        help: "Length of the audio of each transcribed version.",
        labels: { purpose: report.purpose },
        value: report.audioSeconds,
        buckets: AUDIO_BUCKETS,
      });
      if (report.providerCostUsd !== null) {
        observability.incrementCounter({
          name: "opengeni_recording_provider_cost_usd_total",
          help: "Transcription provider spend at list price, in US dollars.",
          labels,
          amount: report.providerCostUsd,
        });
      }
      if (report.credits !== null) {
        observability.incrementCounter({
          name: "opengeni_recording_credits_total",
          help: "Opengeni credits charged for transcripts.",
          labels,
          amount: report.credits,
        });
      }
      if (report.diarization !== null) {
        observability.incrementCounter({
          name: "opengeni_recording_diarization_total",
          help: "How completed meeting transcripts told speakers apart.",
          labels: { ...labels, diarization: report.diarization },
        });
      }
      if (report.speakers !== null) {
        observability.observeHistogram({
          name: "opengeni_recording_speakers",
          help: "Speakers found per completed meeting transcript.",
          labels: { provider: report.provider },
          value: report.speakers,
          buckets: [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20],
        });
      }
    }
    if (report.ourDiarizerFailed) {
      observability.incrementCounter({
        name: "opengeni_recording_diarizer_fallbacks_total",
        help: "Tracks where our speaker models failed and the model's own speakers were used.",
        labels: { provider: report.provider },
      });
    }
    if (report.preparedBytes > 0) {
      observability.incrementCounter({
        name: "opengeni_recording_stored_bytes_total",
        help: "Bytes of recording audio written to object storage, by kind.",
        labels: { purpose: report.purpose, kind: "prepared" },
        amount: report.preparedBytes,
      });
    }
    const stages: Attributes = {};
    for (const [stage, usage] of report.stages) {
      stages[`${stage}WallSeconds`] = round(usage.wallSeconds);
      if (usage.processes === 0) continue;
      stages[`${stage}CpuSeconds`] = round(usage.cpuSeconds);
      stages[`${stage}PeakMemoryMegabytes`] = round(usage.peakMemoryBytes / 1024 / 1024);
    }
    observability.info("recording processed", {
      ...context,
      purpose: report.purpose,
      providerId: report.provider,
      model: report.model,
      funding: report.funding,
      outcome: report.outcome,
      ...(report.errorCode ? { errorCode: report.errorCode } : {}),
      audioSeconds: round(report.audioSeconds),
      wallSeconds: round(report.wallSeconds),
      ...(report.queueSeconds !== null ? { queueSeconds: round(report.queueSeconds) } : {}),
      ...stages,
    });
  } catch {
    // Product execution never inherits an observability failure.
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
