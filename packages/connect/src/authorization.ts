import { pollConnectAttempt } from "./poll";
import type { ConnectAttempt, ConnectTransport } from "./types";

/** Inject navigation so hosts own routing and this package needs no DOM globals. */
export type ConnectNavigation = {
  openPopup(url: string): { close(): void } | null;
  redirect(url: string): void;
};

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
  return pollConnectAttempt(transport, attempt.workspaceId, attempt.id, {
    ...options,
    minimumRevision: attempt.revision,
  }).finally(() => {
    // Window cleanup must never replace the authoritative result or failure.
    try {
      popup.close();
    } catch {
      /* Host navigation may already have disposed it. */
    }
  });
}
