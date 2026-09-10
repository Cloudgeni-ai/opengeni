import type { ConnectAttempt, ConnectTransport } from "./types";

/** Read-only continuation. The backend remains authoritative for expiry and
 * completion; redirects and popup messages are never completion evidence. */
export async function pollConnectAttempt(
  transport: Pick<ConnectTransport, "get">,
  workspaceId: string,
  attemptId: string,
  options: { signal?: AbortSignal; timeoutMs?: number; minimumRevision?: number } = {},
): Promise<ConnectAttempt> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (
    !workspaceId ||
    !attemptId ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000 ||
    !Number.isSafeInteger(options.minimumRevision ?? 1) ||
    (options.minimumRevision ?? 1) < 1
  ) {
    throw new Error("Connect polling requires a scope and a bounded timeout");
  }
  const abort = new AbortController();
  const cancel = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => abort.abort(new Error("Connect polling timed out")), timeoutMs);
  let revision = options.minimumRevision ?? 1;
  try {
    while (true) {
      abort.signal.throwIfAborted();
      const result = await abortable(
        transport.get(workspaceId, attemptId, { signal: abort.signal }),
        abort.signal,
      );
      if (
        result.workspaceId !== workspaceId ||
        result.id !== attemptId ||
        !Number.isSafeInteger(result.revision) ||
        result.revision < Math.max(1, revision)
      ) {
        throw new Error("Connect polling response scope or revision mismatch");
      }
      revision = result.revision;
      if (
        ["complete", "cancelled", "expired", "failed", "uncertain"].includes(result.state) ||
        !["authorize", "wait"].includes(result.nextAction.type)
      )
        return result;
      const requested = result.nextAction.type === "wait" ? result.nextAction.pollAfterMs : 1000;
      const delay = Number.isFinite(requested) ? Math.min(60_000, Math.max(250, requested)) : 1000;
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          clearTimeout(wait);
          reject(abort.signal.reason);
        };
        const wait = setTimeout(() => {
          abort.signal.removeEventListener("abort", stop);
          resolve();
        }, delay);
        abort.signal.addEventListener("abort", stop, { once: true });
        if (abort.signal.aborted) stop();
      });
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
