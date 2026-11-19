import {
  authorizeConnectAttempt,
  type ConnectAttempt,
  type ConnectNavigation,
  type ConnectTransport,
} from "@opengeni/connect";

/** What asking a connected account's provider for more access ended with. */
export type ConnectionStepUpOutcome =
  /** The provider granted it and the account was updated. */
  | { status: "allowed"; attempt: ConnectAttempt }
  /**
   * The provider asks for something the card can't do in one step (for
   * example choosing an account): the full setup continues this attempt.
   */
  | { status: "needs_setup"; attempt: ConnectAttempt };

/** The person declined, or the provider failed or the attempt expired. */
export class ConnectionStepUpNotFinishedError extends Error {
  constructor(readonly attempt: ConnectAttempt) {
    super(attempt.error?.message ?? "More access was not allowed.");
    this.name = "ConnectionStepUpNotFinishedError";
  }
}

const ENDED = new Set<ConnectAttempt["state"]>(["cancelled", "expired", "failed", "uncertain"]);

/**
 * Ask the provider of a connected account for more access in one step: start
 * the reconnect that requests it, then send the window the person's click
 * reserved straight to the provider's consent page, and follow the attempt
 * until the backend says how it ended. The window ends on Opengeni's own
 * closing page (`finishInPopup`), never on a second copy of the app.
 *
 * `window` must be reserved synchronously in the click
 * (`reserveBrowserConnectNavigation`); it is always released here. Aborting
 * `signal` (the person pressed again) stops following and cancels the
 * attempt when it can, so a fresh one can start.
 */
export async function runConnectionStepUp(input: {
  transport: Pick<ConnectTransport, "begin" | "get" | "cancel">;
  workspaceId: string;
  begin: Omit<Parameters<ConnectTransport["begin"]>[1], "finishInPopup">;
  window: { navigation: ConnectNavigation; close(): void };
  signal?: AbortSignal | undefined;
}): Promise<ConnectionStepUpOutcome> {
  const { transport, workspaceId, signal } = input;
  let attempt: ConnectAttempt | null = null;
  try {
    attempt = await transport.begin(
      workspaceId,
      { ...input.begin, finishInPopup: true },
      signal ? { signal } : undefined,
    );
    let result = attempt;
    if (attempt.state !== "complete" && attempt.nextAction.type === "authorize") {
      const followed = await authorizeConnectAttempt(transport, attempt, input.window.navigation, {
        mode: "popup",
        ...(signal ? { signal } : {}),
      });
      if (followed) result = followed;
    }
    if (result.state === "complete") return { status: "allowed", attempt: result };
    if (ENDED.has(result.state)) throw new ConnectionStepUpNotFinishedError(result);
    return { status: "needs_setup", attempt: result };
  } catch (error) {
    if (signal?.aborted && attempt) {
      // Best effort: a newer press starts its own attempt either way.
      const started = attempt;
      void transport
        .cancel(workspaceId, started.id, {
          expectedRevision: started.revision,
          idempotencyKey: crypto.randomUUID(),
        })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    input.window.close();
  }
}
