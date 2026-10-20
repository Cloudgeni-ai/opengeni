import type { ConnectAttempt, ConnectTransport } from "./types";

/** Polling without an explicit timeout or an attempt expiry stops after this. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Keep polling this long past the attempt's expiry, so clock skew between
 * this client and the backend never ends a wait before the backend itself
 * reports the attempt as expired. */
const EXPIRY_GRACE_MS = 120_000;
/** Larger delays overflow setTimeout and fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export class ConnectWaitTimedOutError extends Error {
  constructor() {
    super("Sign-in did not finish in time. You can try connecting again.");
    this.name = "ConnectWaitTimedOutError";
  }
}

/** Read-only continuation. The backend remains authoritative for expiry and
 * completion; redirects and popup messages are never completion evidence.
 *
 * Without an explicit `timeoutMs`, polling lasts as long as the attempt itself
 * (its `expiresAt`, plus a grace period), because a sign-in can take the
 * person several minutes, for example in a system browser opened by a
 * desktop app. The backend reports the attempt as expired once it is. */
export async function pollConnectAttempt(
  transport: Pick<ConnectTransport, "get">,
  workspaceId: string,
  attemptId: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    minimumRevision?: number;
    /** The attempt's own expiry, used as the deadline when no timeoutMs is given. */
    expiresAt?: string;
  } = {},
): Promise<ConnectAttempt> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armedExpiry: string | undefined;
  const arm = (expiresAt: string | undefined) => {
    if (options.timeoutMs !== undefined) {
      if (timer === undefined) timer = setTimeout(timedOut, timeoutMs);
      return;
    }
    const expiry = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) {
      if (timer === undefined) timer = setTimeout(timedOut, timeoutMs);
      return;
    }
    if (expiresAt === armedExpiry) return;
    armedExpiry = expiresAt;
    clearTimeout(timer);
    timer = setTimeout(
      timedOut,
      Math.min(MAX_TIMER_MS, Math.max(DEFAULT_TIMEOUT_MS, expiry - Date.now() + EXPIRY_GRACE_MS)),
    );
  };
  const timedOut = () => abort.abort(new ConnectWaitTimedOutError());
  arm(options.expiresAt);
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
      arm(result.expiresAt);
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
