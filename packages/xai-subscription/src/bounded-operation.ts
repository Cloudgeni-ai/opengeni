export type XaiOperationFailureReason = "network_error" | "timeout";

export async function runBoundedXaiOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: XaiOperationFailureReason }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("xAI operation timeout must be positive");
  }
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const work = operation(controller.signal).then(
    (value) => ({ ok: true as const, value }),
    () => ({
      ok: false as const,
      reason:
        timedOut || controller.signal.aborted ? ("timeout" as const) : ("network_error" as const),
    }),
  );
  const deadline = new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}