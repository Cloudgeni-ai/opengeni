import { pollConnectAttempt } from "./poll";
import type { ConnectAttempt, ConnectTransport } from "./types";

/** Inject navigation so hosts own routing and this package needs no DOM globals. */
export type ConnectNavigation = {
  openPopup(url: string): { close(): void; readonly closed?: boolean | undefined } | null;
  redirect(url: string): void;
};

export class ConnectPopupClosedError extends Error {
  constructor() {
    super("Sign-in window closed. You can try connecting again.");
    this.name = "ConnectPopupClosedError";
  }
}

/** Invoke directly from a user gesture for popup mode. Persist the opaque
 * attempt ID in host-owned state before redirect mode, then recover/poll on
 * return. Neither URL parameters nor popup messages prove completion. */
export function authorizeConnectAttempt(
  transport: Pick<ConnectTransport, "get">,
  attempt: ConnectAttempt,
  navigation: ConnectNavigation,
  options: { mode: "popup" | "redirect"; signal?: AbortSignal; timeoutMs?: number },
): Promise<ConnectAttempt | null> {
  options.signal?.throwIfAborted();
  if (attempt.nextAction.type !== "authorize") {
    throw new Error("Connect attempt does not require authorization");
  }
  const destination = new URL(attempt.nextAction.url);
  if (destination.protocol !== "https:" || destination.username || destination.password) {
    throw new Error("Connect authorization requires an HTTPS destination without credentials");
  }
  if (
    !attempt.id ||
    !attempt.workspaceId ||
    !Number.isSafeInteger(attempt.revision) ||
    attempt.revision < 1
  )
    throw new Error("Connect authorization requires a scope");
  if (options.mode === "redirect") {
    navigation.redirect(attempt.nextAction.url);
    return Promise.resolve(null);
  }
  const popup = navigation.openPopup(attempt.nextAction.url);
  if (!popup) throw new Error("Connect popup was blocked; retry with redirect mode");
  const observation = new AbortController();
  const closed = new ConnectPopupClosedError();
  const abort = () => observation.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const watch = setInterval(() => {
    try {
      if (popup.closed === true) observation.abort(closed);
    } catch {
      // Some hosts cannot observe their popup after cross-origin navigation.
    }
  }, 250);
  return pollConnectAttempt(transport, attempt.workspaceId, attempt.id, {
    ...options,
    signal: observation.signal,
    minimumRevision: attempt.revision,
  })
    .catch(async (failure: unknown) => {
      if (failure !== closed) throw failure;
      // The callback may have committed just as the provider window closed.
      // Recheck the backend briefly; the window itself is never success evidence.
      const recovery = new AbortController();
      const abortRecovery = () => recovery.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortRecovery, { once: true });
      if (options.signal?.aborted) abortRecovery();
      const deadline = setTimeout(() => recovery.abort(closed), 1_500);
      try {
        return await pollConnectAttempt(transport, attempt.workspaceId, attempt.id, {
          signal: recovery.signal,
          minimumRevision: attempt.revision,
          timeoutMs: 2_000,
        });
      } catch (recoveryFailure) {
        if (recoveryFailure === closed) throw closed;
        throw recoveryFailure;
      } finally {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abortRecovery);
      }
    })
    .finally(() => {
      clearInterval(watch);
      options.signal?.removeEventListener("abort", abort);
      // Window cleanup must never replace the authoritative result or failure.
      try {
        popup.close();
      } catch {
        /* Host navigation may already have disposed it. */
      }
    });
}
