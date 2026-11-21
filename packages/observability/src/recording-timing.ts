import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Attributes, Observability } from "./index";
import { withTraceContext } from "./trace-context";

export type RecordingTimingStage =
  | "chunk_put"
  | "stop_to_last_put"
  | "client_finalize"
  | "finalize"
  | "queue_wait"
  | "audio_prepare"
  | "audio_normalize"
  | "provider_request"
  | "provider_retry_wait"
  | "worker_processing"
  | "worker_retry"
  | "transcript_long_poll_wait"
  | "transcript_list_work"
  | "client_transcript_wait"
  | "capture_end_to_transcript"
  | "stop_to_transcript"
  | "stop_to_composer";

export type RecordingTimingContext = {
  recordingKey: string;
  recordingPurpose?: "dictation" | "meeting" | undefined;
  attempt?: number | undefined;
};

export function recordingTimingContext(
  recordingId: string,
  purpose?: "dictation" | "meeting",
): RecordingTimingContext {
  const hash = createHash("sha256").update(recordingId.toLowerCase()).digest("hex").slice(0, 32);
  return { recordingKey: `rec_${hash}`, recordingPurpose: purpose };
}

const buckets = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 900, 3600,
];

type Outcome = "complete" | "failed" | "cancelled" | "retry" | "timeout" | "ready";

/** An already measured stage (client durations and queue waits). No client clock is trusted. */
export function recordRecordingTiming(
  observability: Observability | null | undefined,
  context: RecordingTimingContext,
  stage: RecordingTimingStage,
  durationMs: number,
  attributes: Attributes = {},
  outcome: Outcome = "complete",
): void {
  if (!observability || !Number.isFinite(durationMs) || durationMs < 0) return;
  const fields = { ...context, ...attributes, outcome, durationMs };
  try {
    observe(observability, context, stage, durationMs, outcome);
    const span = observability.startSpan(`recording.${stage}`, fields, {
      startTimeMs: Date.now() - durationMs,
    });
    span.end();
    if (attributes.recordingTimingSource === "client") {
      withTraceContext(span, () => observability.info(`recording ${stage}`, fields));
    }
  } catch {
    // Timing observations never affect the recording pipeline.
  }
}

function observe(
  observability: Observability,
  context: RecordingTimingContext,
  stage: RecordingTimingStage,
  durationMs: number,
  outcome: Outcome,
): void {
  observability.observeHistogram({
    name: "opengeni_recording_stage_duration_seconds",
    help: "Wall time of recording stages in seconds; concurrent stages can overlap.",
    labels: { stage, purpose: context.recordingPurpose ?? "unknown", outcome },
    buckets,
    value: durationMs / 1_000,
  });
}

export function startRecordingTiming(
  observability: Observability | null | undefined,
  context: RecordingTimingContext,
  stage: RecordingTimingStage,
  attributes: Attributes = {},
): (outcome?: Outcome) => void {
  if (!observability) return () => undefined;
  const started = performance.now();
  try {
    const span = observability.startSpan(`recording.${stage}`, { ...context, ...attributes });
    return (outcome = "complete") => {
      const durationMs = performance.now() - started;
      try {
        observe(observability, context, stage, durationMs, outcome);
        span.end({ attributes: { outcome, durationMs } });
      } catch {
        // Observability is best effort.
      }
    };
  } catch {
    return () => undefined;
  }
}

type ActiveTiming = {
  observability: Observability;
  context: RecordingTimingContext;
  providerRegion: (provider: string) => string | undefined;
};
const activeTiming = new AsyncLocalStorage<ActiveTiming>();

/** Bind nested audio and provider work to this recording, including parallel pieces. */
export function withRecordingTiming<T>(timing: ActiveTiming, work: () => T): T {
  return activeTiming.run(timing, work);
}

export function startActiveRecordingTiming(
  stage: RecordingTimingStage,
  attributes: Attributes = {},
): ((outcome?: Outcome) => void) | undefined {
  const timing = activeTiming.getStore();
  if (!timing) return undefined;
  let region: string | undefined;
  if (typeof attributes.provider === "string") {
    try {
      region = timing.providerRegion(attributes.provider);
    } catch {
      // A diagnostic lookup cannot fail a provider request.
    }
  }
  return startRecordingTiming(timing.observability, timing.context, stage, {
    ...attributes,
    recordingProviderRegion: region,
  });
}

export function recordActiveRecordingTiming(
  stage: RecordingTimingStage,
  durationMs: number,
  attributes: Attributes = {},
): void {
  const timing = activeTiming.getStore();
  if (timing)
    recordRecordingTiming(timing.observability, timing.context, stage, durationMs, attributes);
}

export function measureRecordingTiming<T>(
  stage: RecordingTimingStage,
  work: () => Promise<T>,
): Promise<T> {
  const end = startActiveRecordingTiming(stage);
  if (!end) return work();
  return (async () => {
    try {
      const result = await work();
      end();
      return result;
    } catch (error) {
      end("failed");
      throw error;
    }
  })();
}
