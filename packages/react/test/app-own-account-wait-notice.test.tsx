import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  ModelAccountChoiceOption,
  SessionEvent,
  SessionModelAccountChoiceResponse,
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
const { OwnAccountWaitNotice } =
  await import("../src/app/components/session/own-account-wait-notice");
const { ownAccountWithRoom, waitingTurnStartedWithoutViewer } =
  await import("../src/app/lib/own-account-wait");
afterAll(() => GlobalRegistrator.unregister());

const VIEWER = "user-1";
const TURN = "turn-1";
const MODEL = "codex/gpt-6.1-sol";
const NOW = new Date("2026-11-25T08:00:00.000Z");

function event(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  turnId: string | null = TURN,
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

// As production records a meeting-notes turn: queued by a service, then a usage wait.
const queuedBy = (initiator: Record<string, unknown>) =>
  event(4, "turn.queued", { source: "user", turnId: TURN, initiator });
const serviceQueued = queuedBy({
  kind: "service",
  subjectId: "meeting-summary",
  label: "Opengeni meeting notes",
});
const usageWait = event(7, "codex.capacity.waiting", {
  waitReason: "no_eligible_capacity",
  resetsAt: "2026-11-30T12:31:14.000Z",
});
const waiting = { status: "waiting_capacity" as const, activeTurnId: TURN };
const viewer = { viewerSubjectId: VIEWER, paused: false };

function account(extra: Partial<ModelAccountChoiceOption> = {}): ModelAccountChoiceOption {
  return {
    provider: "codex",
    connectionId: "00000000-0000-4000-8000-000000000001",
    label: null,
    accountEmail: "iuliia@example.com",
    planType: "plus",
    status: "active",
    personal: true,
    source: "personal",
    allowedModelIds: null,
    choosable: true,
    refusal: null,
    usage: null,
    ...extra,
  };
}

function choiceWith(...accounts: ModelAccountChoiceOption[]): SessionModelAccountChoiceResponse {
  return {
    binding: null,
    bindings: [],
    accounts,
    personal: {
      connectionsAllowed: true,
      fallbackAllowed: false,
      fallbackOptIn: false,
    },
  };
}

test("a usage wait on a turn someone else started is one the viewer can take over", () => {
  expect(waitingTurnStartedWithoutViewer(waiting, [serviceQueued, usageWait], viewer)).toBe(true);
  // Another person's turn, too.
  expect(
    waitingTurnStartedWithoutViewer(
      waiting,
      [queuedBy({ kind: "subject", subjectId: "user-2" }), usageWait],
      viewer,
    ),
  ).toBe(true);
  // A pause releases the wait and leaves the chat idle on the same turn.
  expect(
    waitingTurnStartedWithoutViewer(
      { status: "idle", activeTurnId: TURN },
      [serviceQueued, usageWait],
      {
        ...viewer,
        paused: true,
      },
    ),
  ).toBe(true);
});

test("the viewer's own turn, other waits and missing evidence are not", () => {
  // Their own turn already may use their account.
  expect(
    waitingTurnStartedWithoutViewer(
      waiting,
      [queuedBy({ kind: "subject", subjectId: VIEWER }), usageWait],
      viewer,
    ),
  ).toBe(false);
  // No initiator in the loaded events, or no viewer.
  expect(waitingTurnStartedWithoutViewer(waiting, [usageWait], viewer)).toBe(false);
  expect(
    waitingTurnStartedWithoutViewer(waiting, [serviceQueued, usageWait], {
      viewerSubjectId: null,
      paused: false,
    }),
  ).toBe(false);
  // A wait that needs someone to act, or one for an earlier turn.
  expect(
    waitingTurnStartedWithoutViewer(
      waiting,
      [
        serviceQueued,
        event(7, "codex.capacity.waiting", {
          waitReason: "pinned_account_disabled",
        }),
      ],
      viewer,
    ),
  ).toBe(false);
  expect(
    waitingTurnStartedWithoutViewer(
      waiting,
      [
        serviceQueued,
        event(7, "codex.capacity.waiting", { waitReason: "no_eligible_capacity" }, "turn-0"),
      ],
      viewer,
    ),
  ).toBe(false);
  // Running, or idle without a pause.
  expect(
    waitingTurnStartedWithoutViewer(
      { ...waiting, status: "running" },
      [serviceQueued, usageWait],
      viewer,
    ),
  ).toBe(false);
  expect(
    waitingTurnStartedWithoutViewer(
      { ...waiting, status: "idle" },
      [serviceQueued, usageWait],
      viewer,
    ),
  ).toBe(false);
});

test("only the viewer's own active account with room for the model counts", () => {
  const at = { provider: "codex", model: MODEL, now: NOW };
  expect(ownAccountWithRoom(choiceWith(account()), at)?.planType).toBe("plus");
  expect(
    ownAccountWithRoom(choiceWith(account({ allowedModelIds: ["gpt-6.1-sol"] })), at),
  ).not.toBeNull();
  expect(ownAccountWithRoom(null, at)).toBeNull();
  expect(
    ownAccountWithRoom(choiceWith(account({ personal: false, source: "organization" })), at),
  ).toBeNull();
  expect(ownAccountWithRoom(choiceWith(account({ choosable: false })), at)).toBeNull();
  expect(ownAccountWithRoom(choiceWith(account({ status: "reauth_required" })), at)).toBeNull();
  expect(ownAccountWithRoom(choiceWith(account({ provider: "claude" })), at)).toBeNull();
  expect(ownAccountWithRoom(choiceWith(account({ allowedModelIds: ["gpt-6.1"] })), at)).toBeNull();
  const exhausted = (exhaustedUntil: string | null, windowReset: string | null) =>
    account({
      usage: {
        observedAt: "2026-11-25T07:00:00.000Z",
        source: "usage_endpoint",
        windows: windowReset
          ? [
              {
                id: "primary",
                usedPercent: 100,
                resetsAt: windowReset,
                status: "exhausted",
              },
            ]
          : [],
        exhaustedUntil,
        exhaustedKind: exhaustedUntil ? "quota" : null,
      },
    });
  expect(
    ownAccountWithRoom(choiceWith(exhausted("2026-11-25T09:00:00.000Z", null)), at),
  ).toBeNull();
  expect(
    ownAccountWithRoom(choiceWith(exhausted(null, "2026-11-25T09:00:00.000Z")), at),
  ).toBeNull();
  // A limit that already reset no longer counts.
  expect(
    ownAccountWithRoom(
      choiceWith(exhausted("2026-11-24T13:00:00.000Z", "2026-11-24T13:00:00.000Z")),
      at,
    ),
  ).not.toBeNull();
});

async function renderNotice(
  choice: SessionModelAccountChoiceResponse,
  props: {
    onContinue?: () => void;
    pending?: boolean;
    error?: string | null;
  } = {},
) {
  const client = Object.assign(fakeClient({}), {
    getSessionModelAccount: async () => choice,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
        <OwnAccountWaitNotice
          workspaceId={WORKSPACE_ID}
          sessionId="session-1"
          model={MODEL}
          events={[serviceQueued, usageWait]}
          onContinue={props.onContinue ?? (() => undefined)}
          pending={props.pending}
          error={props.error}
        />
      </OpenGeniProvider>,
    ),
  );
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the notice says why the viewer's account is not used and continues on it", async () => {
  let continued = 0;
  const view = await renderNotice(choiceWith(account()), {
    onContinue: () => continued++,
  });
  try {
    const notice = view.container.querySelector('[data-testid="own-account-wait-notice"]')!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain(
      "This chat started automatically, so it can’t use your own ChatGPT account.",
    );
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="own-account-wait-continue"]',
    )!;
    expect(button.textContent).toBe("Continue on my account");
    await act(async () => button.click());
    expect(continued).toBe(1);
  } finally {
    await view.cleanup();
  }
});

test("the notice shows progress and errors, and nothing without an own account with room", async () => {
  const busy = await renderNotice(choiceWith(account()), {
    pending: true,
    error: "Try again.",
  });
  try {
    const button = busy.container.querySelector<HTMLButtonElement>(
      '[data-testid="own-account-wait-continue"]',
    )!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Continuing…");
    expect(busy.container.querySelector('[role="alert"]')?.textContent).toBe("Try again.");
  } finally {
    await busy.cleanup();
  }
  const none = await renderNotice(choiceWith(account({ personal: false, source: "organization" })));
  try {
    expect(none.container.querySelector('[data-testid="own-account-wait-notice"]')).toBeNull();
  } finally {
    await none.cleanup();
  }
});
