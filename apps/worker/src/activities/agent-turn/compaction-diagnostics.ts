import type { Observability } from "@opengeni/observability";
import {
  CompactionProviderResponseError,
  type AnthropicRequestSizeError,
  type CompactionNeededError,
} from "@opengeni/runtime";

/** A requested checkpoint is control flow, not a failed worker operation. */
export function logContextCompactionRequest(
  observability: Pick<Observability, "info" | "warn">,
  input: {
    sessionId: string;
    turnId: string | null;
    reason: "operator" | "proactive" | "overflow";
    compactionNeeded: CompactionNeededError | null;
    requestSizeError: AnthropicRequestSizeError | null;
  },
): void {
  const { compactionNeeded, requestSizeError } = input;
  const attributes = {
    op: "context_compaction",
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: input.reason,
    signalSource: compactionNeeded?.signalSource,
    signalTokens: compactionNeeded?.signalTokens,
    thresholdTokens: compactionNeeded?.thresholdTokens,
    ...(compactionNeeded?.historyFootprint
      ? {
          historyFootprintDimension: compactionNeeded.historyFootprint.dimension,
          historyFootprintActual: compactionNeeded.historyFootprint.actual,
          historyFootprintThreshold: compactionNeeded.historyFootprint.threshold,
        }
      : {}),
    ...(requestSizeError ? requestSizeError.requestSize : {}),
  };
  if (compactionNeeded) {
    observability.info("context compaction requested", attributes);
  } else {
    observability.warn("context compaction recovery attempted", {
      ...attributes,
      errorClass: "ContextCompactionError",
      errorCode: requestSizeError ? "model_request_size_exceeded" : "model_context_window_exceeded",
      origin: "worker",
    });
  }
}

export function logContextCompactionFailure(
  observability: Pick<Observability, "error">,
  input: {
    sessionId: string;
    turnId: string | null;
    error: unknown;
  },
): void {
  const { error } = input;
  const providerFailure = error instanceof CompactionProviderResponseError;
  observability.error("context compaction recovery compaction failed", {
    ...input,
    errorClass: "ContextCompactionError",
    errorCode: providerFailure ? "compaction_provider_request_failed" : "compaction_summary_empty",
    ...(providerFailure ? { status: error.status } : {}),
    origin: "worker",
  });
}
