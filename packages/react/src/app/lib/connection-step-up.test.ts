import { describe, expect, test } from "bun:test";
import type { ConnectAttempt, ConnectNavigation } from "@opengeni/connect";
import { ConnectionStepUpNotFinishedError, runConnectionStepUp } from "./connection-step-up";

const MODIFY = "https://www.googleapis.com/auth/gmail.modify";

function attempt(overrides: Partial<ConnectAttempt> = {}): ConnectAttempt {
  return {
    id: "attempt-1",
    workspaceId: "workspace-1",
    providerId: "gmail",
    ownership: "personal",
    revision: 1,
    state: "authorizing",
    credentialsCommitted: false,
    integrationInstalled: false,
    completionRequirement: "connection",
    nextAction: { type: "authorize", url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    requestedScopes: [MODIFY],
    ...overrides,
  } as ConnectAttempt;
}

function harness(states: ConnectAttempt[], first = attempt()) {
  const begins: unknown[] = [];
  const opened: string[] = [];
  const cancels: string[] = [];
  let closed = 0;
  const queue = [...states];
  const transport = {
    begin: async (_workspaceId: string, input: unknown) => {
      begins.push(input);
      return first;
    },
    get: async () => queue.shift() ?? states.at(-1)!,
    cancel: async (_workspaceId: string, attemptId: string) => {
      cancels.push(attemptId);
      return attempt({ state: "cancelled", nextAction: { type: "none" } });
    },
  };
  const navigation: ConnectNavigation = {
    openPopup: (url) => {
      opened.push(url);
      return { close: () => undefined };
    },
    redirect: () => {
      throw new Error("a step-up never leaves the chat");
    },
  };
  const window = {
    navigation,
    close: () => {
      closed += 1;
    },
  };
  const begin = {
    providerId: "gmail",
    ownership: "personal" as const,
    returnUrl: "https://app.example/workspaces/w/sessions/s",
    idempotencyKey: "key-1",
    reconnectAccountId: "conn-1",
    requestedScopes: [MODIFY],
  };
  return {
    transport,
    window,
    begin,
    begins,
    opened,
    cancels,
    closed: () => closed,
  };
}

describe("runConnectionStepUp", () => {
  test("goes straight to the provider's consent and reports when the account has the access", async () => {
    const h = harness([
      attempt({ revision: 1 }),
      attempt({ revision: 2, state: "complete", nextAction: { type: "none" } }),
    ]);
    const outcome = await runConnectionStepUp({
      transport: h.transport,
      workspaceId: "workspace-1",
      begin: h.begin,
      window: h.window,
    });
    expect(outcome.status).toBe("allowed");
    // The sign-in ends on the closing page, never a second copy of the chat.
    expect(h.begins).toEqual([{ ...h.begin, finishInPopup: true }]);
    expect(h.opened).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?x=1"]);
    expect(h.closed()).toBeGreaterThan(0);
  });

  test("a declined consent is reported, and the reserved window is released", async () => {
    const h = harness([
      attempt({
        revision: 2,
        state: "cancelled",
        nextAction: { type: "none" },
        error: { code: "provider_denied", message: "Not allowed", retryable: false },
      }),
    ]);
    await expect(
      runConnectionStepUp({
        transport: h.transport,
        workspaceId: "workspace-1",
        begin: h.begin,
        window: h.window,
      }),
    ).rejects.toBeInstanceOf(ConnectionStepUpNotFinishedError);
    expect(h.closed()).toBeGreaterThan(0);
  });

  test("a step the card can't do in one go hands the same attempt to the full setup", async () => {
    const chooser = attempt({
      state: "account_selection",
      nextAction: { type: "select_account", accounts: [] },
    } as Partial<ConnectAttempt>);
    const h = harness([], chooser);
    const outcome = await runConnectionStepUp({
      transport: h.transport,
      workspaceId: "workspace-1",
      begin: h.begin,
      window: h.window,
    });
    expect(outcome).toEqual({ status: "needs_setup", attempt: chooser });
    expect(h.opened).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  test("pressing again stops following this attempt and cancels it", async () => {
    const h = harness([attempt({ revision: 1 })]);
    const press = new AbortController();
    const running = runConnectionStepUp({
      transport: h.transport,
      workspaceId: "workspace-1",
      begin: h.begin,
      window: h.window,
      signal: press.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    press.abort(new Error("pressed again"));
    await expect(running).rejects.toThrow("pressed again");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.cancels).toEqual(["attempt-1"]);
    expect(h.closed()).toBeGreaterThan(0);
  });
});
