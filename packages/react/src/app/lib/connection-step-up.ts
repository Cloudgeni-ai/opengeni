import {
  authorizeConnectAttempt,
  type ConnectAttempt,
  type ConnectNavigation,
  type ConnectTransport,
} from "@opengeni/connect";

import { connectProviderAcceptsRequestedScopes } from "@opengeni/contracts/connect";
import {
  nativeConnectApiInput,
  type NativeConnectRequest,
} from "../components/capabilities/native-connect-setup";
import type { ConnectRecoveryTarget } from "./connect-recovery-account";

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

/** An attempt nothing will finish any more, so it can't confuse a later setup. */
function cancelLeftover(
  transport: Pick<ConnectTransport, "cancel">,
  workspaceId: string,
  attempt: ConnectAttempt,
) {
  if (attempt.state === "complete" || ENDED.has(attempt.state)) return;
  void Promise.resolve()
    .then(() =>
      transport.cancel(workspaceId, attempt.id, {
        expectedRevision: attempt.revision,
        idempotencyKey: crypto.randomUUID(),
      }),
    )
    .catch(() => undefined);
}

/**
 * Ask the provider of a connected account for more access in one step: start
 * the reconnect that requests it, then send the window the person's click
 * reserved straight to the provider's consent page, and follow the attempt
 * until the backend says how it ended. The window ends on Opengeni's own
 * closing page (`finishInPopup`), never on a second copy of the app.
 *
 * `window` must be reserved synchronously in the click
 * (`reserveBrowserConnectNavigation`); it is always released here. Aborting
 * `signal` (the person pressed again) stops following. Whenever it ends
 * without the provider's answer (aborted, failed to follow), the attempt is
 * cancelled when it can be, so a later setup never finds it pending.
 */
export async function runConnectionStepUp(input: {
  transport: Pick<ConnectTransport, "begin" | "get" | "cancel">;
  workspaceId: string;
  begin: Parameters<ConnectTransport["begin"]>[1];
  window: { navigation: ConnectNavigation; close(): void };
  signal?: AbortSignal | undefined;
}): Promise<ConnectionStepUpOutcome> {
  const { transport, workspaceId, signal } = input;
  let attempt: ConnectAttempt | null = null;
  try {
    // Not aborted mid-request: the attempt would exist without its id here.
    attempt = await transport.begin(workspaceId, { ...input.begin, finishInPopup: true });
    signal?.throwIfAborted();
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
    // Best effort: a newer press starts its own attempt either way.
    if (attempt && !(error instanceof ConnectionStepUpNotFinishedError)) {
      cancelLeftover(transport, workspaceId, attempt);
    }
    throw error;
  } finally {
    input.window.close();
  }
}

/** What pressing a step-up card ended with, for the chat to act on. */
export type CardStepUpOutcome =
  /** The provider granted the access; the agent was told to carry on. */
  | { status: "allowed" }
  /** The card can't do it in one step: the setup dialog takes this request. */
  | { status: "resume_in_dialog"; request: NativeConnectRequest }
  /** Not an account the card can step up (for example held by a connector). */
  | { status: "not_handled" };

/**
 * The step-up a card runs for its connected account, after the click
 * reserved the consent window: find the exact account, ask its provider for
 * the card's scopes in that window, and tell the agent to carry on once the
 * account has them. Anything the card can't finish itself is handed back,
 * and the reserved window is always closed.
 */
export async function stepUpFromCard(input: {
  connectionId: string;
  scopes: readonly string[];
  window: { navigation: ConnectNavigation; close(): void };
  transport: ConnectTransport;
  findTarget: () => Promise<ConnectRecoveryTarget<{
    id: string;
    providerId: string;
    ownership: "personal" | "workspace";
    label?: string | undefined;
  }> | null>;
  returnUrl: string;
  /** Tell the agent to carry on once allowed (a card); an approval resumes it itself. */
  continueAfterSetup?: (() => Promise<unknown>) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<CardStepUpOutcome> {
  try {
    const target = await input.findTarget();
    if (
      !target ||
      target.via !== "native" ||
      !connectProviderAcceptsRequestedScopes(target.account.providerId)
    ) {
      return { status: "not_handled" };
    }
    const { account } = target;
    const request: NativeConnectRequest = {
      scope: { workspaceId: target.workspaceId, transport: input.transport },
      providerId: account.providerId,
      ownership: account.ownership,
      reconnectAccountId: account.id,
      requestedScopes: [...input.scopes],
      ...(account.label ? { displayName: account.label } : {}),
      returnUrl: input.returnUrl,
      finishInPopup: true,
      idempotencyKey: crypto.randomUUID(),
    };
    const outcome = await runConnectionStepUp({
      transport: input.transport,
      workspaceId: target.workspaceId,
      // The dialog's own body, so a hand-off to it replays the same start.
      begin: nativeConnectApiInput(request),
      window: input.window,
      signal: input.signal,
    });
    if (outcome.status === "needs_setup") return { status: "resume_in_dialog", request };
    // Same continuation as after setup from the dialog: the server checks the
    // account now has what the card asked for and wakes the agent at most once
    // per card. It never fails the finished step-up.
    const continueAfterSetup = input.continueAfterSetup;
    if (continueAfterSetup)
      void Promise.resolve()
        .then(continueAfterSetup)
        .catch(() => undefined);
    return { status: "allowed" };
  } finally {
    input.window.close();
  }
}
