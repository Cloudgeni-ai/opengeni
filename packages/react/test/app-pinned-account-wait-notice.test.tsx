import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ModelAccountChoiceOption,
  SessionEvent,
  SessionModelAccountChoiceResponse,
  SetSessionModelAccountChoiceRequest,
} from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { fakeClient, WORKSPACE_ID } from "./fake-client";

{
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}
const { OpenGeniProvider } = await import("../src");
const { PinnedAccountWaitNotice, pinnedAccountWaitCopy } =
  await import("../src/app/components/session/pinned-account-wait-notice");
const { pinnedAccountWait } = await import("../src/app/lib/pinned-account-wait");
afterAll(() => GlobalRegistrator.unregister());

const RESET = "2026-11-28T18:00:00.000Z";

function waitEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  turnId = "turn-1",
): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session-1",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: "2026-11-24T07:00:00.000Z",
  } as unknown as SessionEvent;
}

function option(connectionId: string, label: string | null, extra = {}): ModelAccountChoiceOption {
  return {
    provider: "claude",
    connectionId,
    label,
    accountEmail: null,
    planType: null,
    status: "active",
    personal: false,
    source: "organization",
    allowedModelIds: null,
    choosable: true,
    refusal: null,
    ...extra,
  };
}

function pinnedChoice(): SessionModelAccountChoiceResponse {
  return {
    binding: { provider: "claude", choice: "explicit", connectionId: "pinned-1" },
    bindings: [{ provider: "claude", choice: "explicit", connectionId: "pinned-1" }],
    accounts: [option("pinned-1", "Team Max"), option("other-1", "Team Pro")],
    personal: { connectionsAllowed: true, fallbackAllowed: true, fallbackOptIn: false },
  };
}

const waiting = { status: "waiting_capacity" as const, activeTurnId: "turn-1" };
const claudeWait = (payload: Record<string, unknown> = {}) =>
  waitEvent(4, "turn.capacity_waiting", {
    provider: "claude-subscription",
    waitReason: "pinned_account_unavailable",
    earliestResetAt: RESET,
    ...payload,
  });

test("a waiting chat's newest pinned-account wait is read with its provider and reset", () => {
  expect(pinnedAccountWait(waiting, [claudeWait()])).toEqual({
    provider: "claude",
    reason: "pinned_account_unavailable",
    resetsAt: RESET,
  });
  expect(
    pinnedAccountWait(waiting, [
      waitEvent(2, "codex.capacity.waiting", {
        waitReason: "pinned_account_disabled",
      }),
    ]),
  ).toEqual({ provider: "codex", reason: "pinned_account_disabled", resetsAt: null });
  // Not waiting, a busy pool, a newer non-pinned wait or another turn's wait: none.
  expect(pinnedAccountWait({ ...waiting, status: "running" }, [claudeWait()])).toBeNull();
  expect(
    pinnedAccountWait(waiting, [claudeWait({ waitReason: "no_eligible_capacity" })]),
  ).toBeNull();
  expect(
    pinnedAccountWait(waiting, [
      claudeWait(),
      waitEvent(5, "turn.capacity_waiting", {
        provider: "claude-subscription",
        waitReason: "no_eligible_capacity",
      }),
    ]),
  ).toBeNull();
  expect(pinnedAccountWait({ ...waiting, activeTurnId: "turn-2" }, [claudeWait()])).toBeNull();
});

test("the notice names the pinned account and when it has room again", () => {
  const wait = pinnedAccountWait(waiting, [claudeWait()])!;
  const at = { now: new Date("2026-11-24T07:15:00.000Z"), locale: "en-GB", timeZone: "UTC" };
  expect(pinnedAccountWaitCopy(wait, pinnedChoice(), at)).toEqual({
    headline: "This chat is pinned to the Claude account “Team Max”, which is out of capacity.",
    resetText: "Resets Sat 18:00.",
  });
  // An account this person cannot see is not named.
  expect(pinnedAccountWaitCopy(wait, { ...pinnedChoice(), accounts: [] }, at).headline).toBe(
    "This chat is pinned to one Claude account, which is out of capacity.",
  );
  expect(
    pinnedAccountWaitCopy({ ...wait, reason: "pinned_account_disabled" }, pinnedChoice(), at),
  ).toEqual({
    headline: "This chat is pinned to the Claude account “Team Max”, which is turned off.",
    resetText: null,
  });
});

test("one click returns the chat to automatic account choice for the waiting turn", async () => {
  const requests: SetSessionModelAccountChoiceRequest[] = [];
  let choice = pinnedChoice();
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => choice,
    setSessionModelAccount: async (
      _workspaceId: string,
      _sessionId: string,
      request: SetSessionModelAccountChoiceRequest,
    ) => {
      requests.push(request);
      choice = {
        ...choice,
        binding: { provider: "claude", choice: "automatic", connectionId: null },
        bindings: [{ provider: "claude", choice: "automatic", connectionId: null }],
      };
      return {
        changed: true,
        appliedTo: "waiting_turn" as const,
        provider: "claude",
        connectionId: null,
        choice: "automatic" as const,
      };
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const events = [claudeWait()];
  await act(async () =>
    root.render(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <PinnedAccountWaitNotice
          workspaceId={WORKSPACE_ID}
          sessionId="session-1"
          wait={pinnedAccountWait(waiting, events)!}
          events={events}
          canChoose
        />
      </OpenGeniProvider>,
    ),
  );
  try {
    const notice = container.querySelector('[data-testid="pinned-account-wait-notice"]')!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(
      "This chat is pinned to the Claude account “Team Max”, which is out of capacity.",
    );
    expect(notice.textContent).not.toContain("model");
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="pinned-account-wait-automatic"]',
    )!;
    expect(button.textContent).toBe("Use automatic account choice");
    await act(async () => button.click());
    expect(requests).toEqual([{ connectionId: null, provider: "claude" }]);
    expect(notice.textContent).toContain(
      "Switched to automatic account choice; the waiting turn continues on another account.",
    );
    expect(container.querySelector('[data-testid="pinned-account-wait-automatic"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a person who cannot manage the chat is told who can, without the button", async () => {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => pinnedChoice(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const events = [claudeWait()];
  await act(async () =>
    root.render(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <PinnedAccountWaitNotice
          workspaceId={WORKSPACE_ID}
          sessionId="session-1"
          wait={pinnedAccountWait(waiting, events)!}
          events={events}
          canChoose={false}
        />
      </OpenGeniProvider>,
    ),
  );
  try {
    expect(container.textContent).toContain(
      "Someone who can manage this chat can switch it to automatic account choice.",
    );
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
