import { isModelCallFetch } from "./model-provider-transport";

export const MODEL_STREAM_IDLE_TIMEOUT_ERROR_CODE = "opengeni_model_stream_idle_timeout";

/**
 * `bytes`: the provider delivered no response bytes for the window.
 * `progress`: bytes arrived, but only keepalive/heartbeat traffic (SSE
 * comments, `ping`/`keepalive` events, repeated `response.in_progress`) and no
 * model-progress event for the window - a wedged generation behind a live
 * connection.
 */
export type ModelStreamIdleTimeoutKind = "bytes" | "progress";

/**
 * A generic OpenAI-compatible model response stalled while the consumer was
 * waiting for it. This is provider silence, not a run-length cap: every byte
 * resets the byte window and every model-progress event resets the progress
 * window, and time the consumer spends not reading is never counted.
 */
export class ModelStreamIdleTimeoutError extends Error {
  readonly code = MODEL_STREAM_IDLE_TIMEOUT_ERROR_CODE;
  readonly type = MODEL_STREAM_IDLE_TIMEOUT_ERROR_CODE;

  constructor(
    readonly provider: string,
    readonly kind: ModelStreamIdleTimeoutKind,
    readonly idleTimeoutMs: number,
    readonly bytesObserved: number,
  ) {
    super(
      kind === "bytes"
        ? `Model provider ${provider} sent no response bytes for ${Math.round(idleTimeoutMs / 1_000)}s`
        : `Model provider ${provider} sent only keepalive traffic and no response progress for ${Math.round(idleTimeoutMs / 1_000)}s`,
    );
    this.name = "ModelStreamIdleTimeoutError";
  }
}

export type ModelStreamIdleTimeoutInfo = {
  provider: string | null;
  kind: ModelStreamIdleTimeoutKind | null;
  idleTimeoutMs: number | null;
  bytesObserved: number | null;
  message: string;
};

/** Recover the typed idle timeout through SDK/runner `cause` wrappers. */
export function classifyModelStreamIdleTimeoutError(
  error: unknown,
): ModelStreamIdleTimeoutInfo | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (
      value.code === MODEL_STREAM_IDLE_TIMEOUT_ERROR_CODE ||
      value.name === "ModelStreamIdleTimeoutError"
    ) {
      return {
        provider: typeof value.provider === "string" ? value.provider : null,
        kind: value.kind === "bytes" || value.kind === "progress" ? value.kind : null,
        idleTimeoutMs: typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : null,
        bytesObserved: typeof value.bytesObserved === "number" ? value.bytesObserved : null,
        message: typeof value.message === "string" ? value.message : "Model stream idle timeout",
      };
    }
    current = value.cause;
  }
  return null;
}

export type ModelStreamIdlePolicy = {
  /** Maximum wait for the next response byte. */
  idleTimeoutMs: number;
  /** Maximum wait across keepalive-only traffic for the next model-progress event. */
  progressTimeoutMs: number;
};

const KEEPALIVE_EVENT_TYPE =
  /^(?:keepalive|keep_alive|keep-alive|ping|heartbeat|response\.in_progress|response\.queued)$/i;
const MAX_PENDING_LINE_CHARS = 64 * 1024;

/**
 * Incremental SSE classifier: does this chunk complete at least one
 * model-progress `data:` line? SSE comments, `event:` lines, and keepalive
 * event types are not progress. Unknown JSON shapes (e.g. chat completion
 * chunks without a top-level `type`) are progress.
 */
class SseProgressScanner {
  private readonly decoder = new TextDecoder();
  private pending = "";

  push(chunk: Uint8Array): boolean {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let progress = false;
    let newline = this.pending.search(/\r\n|\r|\n/);
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      const width = this.pending.startsWith("\r\n", newline) ? 2 : 1;
      this.pending = this.pending.slice(newline + width);
      if (isProgressLine(line)) progress = true;
      newline = this.pending.search(/\r\n|\r|\n/);
    }
    if (this.pending.length > MAX_PENDING_LINE_CHARS) {
      // A very long single data line (large output item) is itself progress.
      if (this.pending.startsWith("data:")) progress = true;
      this.pending = this.pending.startsWith("data:") ? "data:" : "";
    }
    return progress;
  }
}

function isProgressLine(line: string): boolean {
  if (!line.startsWith("data:")) return false;
  const data = line.slice(5).trim();
  if (data.length === 0) return false;
  if (data === "[DONE]") return true;
  const type = /^\{\s*"type"\s*:\s*"([^"\\]{1,128})"/.exec(data)?.[1];
  return type === undefined || !KEEPALIVE_EVENT_TYPE.test(type);
}

function withBodyIdleTimeout(
  response: Response,
  provider: string,
  policy: ModelStreamIdlePolicy,
): Response {
  const reader = response.body!.getReader();
  const scanner = new SseProgressScanner();
  let bytesObserved = 0;
  // Consumer-waiting time accumulated since the last model-progress event.
  let waitedWithoutProgressMs = 0;
  let settled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (settled) return;
        // Arm only while this consumer is actually waiting on the provider.
        // A fresh timer per read leaves no long-lived losing promise reaction.
        const progressRemainingMs = Math.max(1, policy.progressTimeoutMs - waitedWithoutProgressMs);
        const kind: ModelStreamIdleTimeoutKind =
          progressRemainingMs < policy.idleTimeoutMs ? "progress" : "bytes";
        const deadlineMs = kind === "progress" ? progressRemainingMs : policy.idleTimeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ModelStreamIdleTimeoutError(
                  provider,
                  kind,
                  kind === "progress" ? policy.progressTimeoutMs : policy.idleTimeoutMs,
                  bytesObserved,
                ),
              ),
            deadlineMs,
          );
        });
        const startedAt = performance.now();
        const read = reader.read();
        // The read may settle after an idle timeout; never leave it unhandled.
        read.catch(() => undefined);
        try {
          const chunk = await Promise.race([read, idle]);
          if (chunk.done) {
            settled = true;
            controller.close();
            return;
          }
          bytesObserved += chunk.value.byteLength;
          if (scanner.push(chunk.value)) {
            waitedWithoutProgressMs = 0;
          } else {
            waitedWithoutProgressMs += performance.now() - startedAt;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          settled = true;
          if (error instanceof ModelStreamIdleTimeoutError) {
            // Close the wedged upstream connection; the provider cannot resume
            // this response, and recovery issues a fresh request.
            void reader.cancel(error).catch(() => undefined);
          }
          controller.error(error);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      async cancel(reason) {
        settled = true;
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    // No read-ahead: pull runs only when the consumer asks for bytes, so a
    // slow consumer never manufactures provider silence.
    { highWaterMark: 0 },
  );
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (response.url) {
    Object.defineProperty(wrapped, "url", { value: response.url });
  }
  return wrapped;
}

function positiveMs(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Bound provider silence on a generic model response body. Applies only to
 * model-call requests; other requests and bodiless responses pass through.
 */
export function streamIdleTimeoutModelFetch(
  provider: string,
  policy: { idleTimeoutMs?: number | undefined; progressTimeoutMs?: number | undefined },
  inner: typeof fetch,
): typeof fetch {
  const idleTimeoutMs = positiveMs(policy.idleTimeoutMs);
  if (idleTimeoutMs === null) {
    return inner;
  }
  const resolved: ModelStreamIdlePolicy = {
    idleTimeoutMs,
    // The progress bound is never shorter than the byte bound.
    progressTimeoutMs: Math.max(idleTimeoutMs, positiveMs(policy.progressTimeoutMs) ?? Infinity),
  };
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await inner(input, init);
    if (!response.body || !isModelCallFetch(input)) {
      return response;
    }
    return withBodyIdleTimeout(response, provider, resolved);
  }) as typeof fetch;
}
