import {
  boundClientErrorText,
  CLIENT_ERROR_DETAIL_MAX_BYTES,
  scrubClientErrorText,
} from "@opengeni/contracts/client-error-report";
import {
  RecordingTranscriptionError,
  type RecordingTranscriptionCredentials,
  type RecordingTranscriptionProvider,
  type RecordingTranscriptionRequest,
  type RecordingTranscriptionResult,
} from "./recording-transcription";

/** A request that failed, or that its provider hasn't answered in the time it documents. */
export type RecordingTranscriptionRequestFailure = {
  providerId: string;
  model: string;
  /** Our id for the call (the request scope's), when it has one. */
  requestId: string | null;
  /** Which request this was for the same audio, from 1. */
  request: number;
  /** How long it had run, in milliseconds. */
  elapsedMilliseconds: number;
  /**
   * True when it hadn't answered in its provider's documented time; it keeps
   * running beside the next request, and whichever answers first is used.
   */
  overdue: boolean;
  /** What it failed with; null when it is overdue. */
  error: unknown;
  /** The wait before the next request; null when no request follows. */
  retryInMilliseconds: number | null;
};

/**
 * Send one transcription request the way its provider documents it should
 * be sent. A provider that declares `requestTiming` answers within a known
 * multiple of the audio's length (fast transcription: faster than real
 * time), so a request that hasn't answered by then has failed, as has one
 * that fails with a transient error (no answer, a server error, a timeout).
 * Either way the request is sent again after the provider's recommended
 * wait, up to its recommended number of times. A request that is merely
 * late keeps running beside its successor and whichever answers first is
 * used, so a provider that is a little slower than documented costs a
 * second request, never time. Every other request is stopped before this
 * returns. A permanent failure, or a rate limit (which a caller may meet by
 * going to another provider), ends it at once; so does the caller's signal.
 *
 * Without `requestTiming`, or without the audio's length, the request is
 * sent once, as before. Every failed request is reported to `onFailure`.
 */
export async function sendRecordingTranscriptionRequest(input: {
  provider: RecordingTranscriptionProvider;
  request: RecordingTranscriptionRequest;
  credentials: RecordingTranscriptionCredentials | null;
  /** The audio's length; null or 0 when unknown. */
  audioMilliseconds: number | null;
  onFailure?: (failure: RecordingTranscriptionRequestFailure) => void;
}): Promise<RecordingTranscriptionResult> {
  const { provider, request, credentials } = input;
  const timing = provider.requestTiming;
  const expectedMilliseconds =
    timing && input.audioMilliseconds && input.audioMilliseconds > 0
      ? Math.ceil(timing.realTimeFactor * input.audioMilliseconds)
      : null;
  const delays = expectedMilliseconds === null ? [] : (timing?.retryDelaysMilliseconds ?? []);
  const parent = request.signal;
  type Sent = {
    controller: AbortController;
    startedAt: number;
    settled: boolean;
    failed: boolean;
    done: Promise<void>;
  };
  return await new Promise<RecordingTranscriptionResult>((resolve, reject) => {
    const sent: Sent[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let finished = false;
    const later = (milliseconds: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, milliseconds);
      timers.add(timer);
    };
    const onParentAbort = () => {
      // A request in flight ends with the abort and answers it itself.
      if (sent.every((entry) => entry.settled)) finish(() => reject(parent?.reason));
    };
    /** Settle once every other request has stopped, so none outlives the call. */
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      parent?.removeEventListener("abort", onParentAbort);
      const running = sent.filter((entry) => !entry.settled);
      for (const entry of running) {
        entry.controller.abort(new DOMException("Another request answered first", "AbortError"));
      }
      void Promise.allSettled(running.map((entry) => entry.done)).then(settle);
    };
    const report = (
      entry: Sent,
      index: number,
      failure: { overdue: boolean; error: unknown; retryInMilliseconds: number | null },
    ) => {
      try {
        input.onFailure?.({
          providerId: provider.id,
          model: request.model,
          requestId: request.scope?.requestId ?? null,
          request: index + 1,
          elapsedMilliseconds: Math.round(performance.now() - entry.startedAt),
          ...failure,
        });
      } catch {
        // Reporting never changes the outcome.
      }
    };
    /** A request has failed or run past its time: send the next, or give up. */
    const failed = (entry: Sent, index: number, overdue: boolean, error: unknown) => {
      if (entry.failed || finished) return;
      entry.failed = true;
      const delay = delays[index];
      report(entry, index, {
        overdue,
        error: overdue ? null : error,
        retryInMilliseconds: delay ?? null,
      });
      if (delay === undefined) {
        finish(() =>
          reject(
            overdue
              ? new RecordingTranscriptionError(
                  `${provider.name} did not answer in time`,
                  "timeout",
                  true,
                )
              : error,
          ),
        );
        return;
      }
      later(delay, () => send(index + 1));
    };
    const send = (index: number) => {
      // An abort while waiting to retry has already settled it. One before
      // the first request still reaches the provider, which ends it its own way.
      if (finished) return;
      const controller = new AbortController();
      const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
      // Each request is its own: a provider may refuse an identity it has seen.
      const scope =
        request.scope && index > 0
          ? { ...request.scope, requestId: `${request.scope.requestId}:r${index}` }
          : request.scope;
      const entry: Sent = {
        controller,
        startedAt: performance.now(),
        settled: false,
        failed: false,
        done: Promise.resolve(),
      };
      sent.push(entry);
      entry.done = Promise.resolve()
        .then(() =>
          provider.transcribe({ ...request, ...(scope ? { scope } : {}), signal }, credentials),
        )
        .then(
          (result) => {
            entry.settled = true;
            finish(() => resolve(result));
          },
          (error: unknown) => {
            entry.settled = true;
            if (finished) return;
            if (parent?.aborted) {
              finish(() => reject(error));
            } else if (retriedHere(error)) {
              failed(entry, index, false, error);
            } else {
              report(entry, index, { overdue: false, error, retryInMilliseconds: null });
              finish(() => reject(error));
            }
            // A request that has failed while an earlier, late one still
            // runs leaves the answer to it, or to the next request.
          },
        );
      if (expectedMilliseconds !== null) {
        later(expectedMilliseconds, () => {
          if (!entry.settled) failed(entry, index, true, null);
        });
      }
    };
    parent?.addEventListener("abort", onParentAbort, { once: true });
    send(0);
  });
}

/** Transient failures, which the provider documents trying again. */
function retriedHere(error: unknown): boolean {
  return (
    error instanceof RecordingTranscriptionError && error.retryable && error.code !== "rate_limited"
  );
}

const PROVIDER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/u;
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * The log line for a failed request: the provider, which request it was and
 * how long it ran, our error code, and what the provider said (its HTTP
 * status, error code, scrubbed message and request id). Never audio or
 * transcript text. The observability boundary admits each field only under
 * its reviewed name and grammar.
 */
export function recordingTranscriptionFailureLogAttributes(
  failure: RecordingTranscriptionRequestFailure,
): Record<string, string | number> {
  const error = failure.error;
  const detail = error instanceof RecordingTranscriptionError ? error.detail : {};
  const message = detail.providerMessage
    ? boundClientErrorText(
        scrubClientErrorText(detail.providerMessage.slice(0, 16_384)).trim(),
        CLIENT_ERROR_DETAIL_MAX_BYTES.message,
      )
    : "";
  const attributes: Record<string, string | number | undefined> = {
    provider: failure.providerId,
    model: failure.model,
    attempt: failure.request,
    durationMs: failure.elapsedMilliseconds,
    outcome: failure.retryInMilliseconds === null ? "failed" : "retrying",
    reason: failure.overdue
      ? "overdue"
      : error instanceof RecordingTranscriptionError
        ? error.code
        : "unknown",
    delayMs: failure.retryInMilliseconds ?? undefined,
    providerStatus: detail.status,
    providerErrorCode:
      detail.providerCode && PROVIDER_TOKEN.test(detail.providerCode)
        ? detail.providerCode
        : undefined,
    providerErrorMessage: message || undefined,
    providerRequestId:
      detail.requestId && PROVIDER_REQUEST_ID.test(detail.requestId) ? detail.requestId : undefined,
    correlationId:
      failure.requestId && PROVIDER_REQUEST_ID.test(failure.requestId)
        ? failure.requestId
        : undefined,
  };
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    ),
  );
}
