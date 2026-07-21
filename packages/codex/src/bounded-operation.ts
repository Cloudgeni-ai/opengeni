export type CodexOperationFailureReason = "network_error" | "timeout";

/**
 * Bound the complete provider operation, including response-body consumption.
 *
 * AbortController makes native fetch release its socket, while Promise.race is
 * the backstop for injected/custom fetch implementations that ignore `signal`.
 * The losing operation is rejection-handled and can never become an unhandled
 * promise after the caller has received the timeout result.
 */
export async function runBoundedCodexOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: CodexOperationFailureReason }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex operation timeout must be positive");
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
