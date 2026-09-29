import { expect, test } from "bun:test";
import type { SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { conversationTimeline } from "../src/conversation-timeline";
import type { ComposerOptimisticMessage } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
import { latestQuestionClient } from "./fixtures/latest-question-client";

registerDom();

for (const mode of ["pending", "started", "withdrawn"] as const) {
  test(`Latest question reaches the real ${mode} destination through SessionConversation`, async () => {
    const { client, turn, reads } = latestQuestionClient(mode);
    const view = await renderComponent(
      <SessionConversation client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    try {
      await flush(100);
      if (mode === "pending") {
        const queueButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.includes("1 queued"),
        );
        if (queueButton?.getAttribute("aria-expanded") === "true")
          await actRun(() => queueButton.click());
      }
      const latest = view.container.querySelector<HTMLButtonElement>("[data-og-jump-to-question]");
      expect(latest).not.toBeNull();
      await actRun(() => latest!.click());
      await flush(120);
      expect(reads.some((read) => read.includeTypes?.includes("user.message"))).toBe(true);
      if (mode === "pending") {
        expect((document.activeElement as HTMLElement)?.dataset.queueTurnId).toBe(turn.id);
        expect(
          view.container.querySelector('[data-og-session-chrome-panel="queue"]'),
        ).not.toBeNull();
        expect(
          view.container.querySelector("[data-og-timeline-scroller]")?.textContent,
        ).not.toContain("Newest queued question");
      } else {
        const prompts = [...view.container.querySelectorAll("[data-og-prompt]")].map(
          (item) => item.textContent,
        );
        expect(
          prompts.some((text) =>
            text?.includes(
              mode === "started" ? "Newest queued question" : "Previous valid question",
            ),
          ),
        ).toBe(true);
        if (mode === "withdrawn")
          expect(prompts.some((text) => text?.includes("Newest queued question"))).toBe(false);
      }
    } finally {
      await view.unmount();
    }
  });
}

test("queued delivery failures remain visible and retryable; acknowledged queue items are not duplicated", () => {
  const turn = fakeTurn();
  const message: ComposerOptimisticMessage = {
    clientEventId: "client-event",
    delivery: "send",
    destination: "queue",
    text: "queued test",
    annotations: [],
    resources: [],
    occurredAt: "2026-09-07T00:00:00Z",
    state: "failed",
    error: "Offline",
  };
  let retried = "";
  const failed = conversationTimeline(
    [],
    { queue: [], snapshot: null },
    {
      optimisticMessages: [message],
      retryOptimisticMessage: (id) => {
        retried = id;
      },
    },
  );
  expect(failed).toHaveLength(1);
  const item = failed[0]!;
  if (item.kind !== "user-message") throw Error("Expected visible delivery failure");
  item.delivery?.onRetry?.();
  expect(retried).toBe(message.clientEventId);
  expect(
    conversationTimeline(
      [],
      { queue: [], snapshot: null },
      {
        optimisticMessages: [{ ...message, state: "sending" }],
      },
    ),
  ).toHaveLength(0);
  expect(
    conversationTimeline(
      [],
      { queue: [turn], snapshot: null },
      {
        optimisticMessages: [{ ...message, state: "queued", turnId: turn.id }],
      },
    ),
  ).toHaveLength(0);
});

test("complete conversation loads queue and provides queue actions beside composer", async () => {
  let streams = 0;
  let latestQuestionLookups = 0;
  let snapshot: SessionQueueSnapshot = {
    version: 1,
    effectiveControl: {
      state: "active",
      controlVersion: 1,
      controlEtag: "control-1",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    activePersonalConnections: [],
    stoppingPreviousAttempt: false,
    items: [
      fakeTurn({ prompt: "first queued prompt" }),
      fakeTurn({ prompt: "second queued prompt" }),
    ],
    pendingInputs: [],
    pendingInputAttachment: null,
  };
  const client = fakeClient({
    listEvents: async (_workspace, _session, options) => {
      if (options?.includeTypes?.includes("user.message")) {
        latestQuestionLookups++;
        expect(options.mode).toBe("forensic");
      }
      return [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "user.message",
          occurredAt: "2026-09-07T00:00:00Z",
          payload: { text: "A complete long message. ".repeat(80) },
        },
      ] as never;
    },
    getSession: async () =>
      ({
        id: SESSION_ID,
        status: "running",
        activeTurnId: "active",
        effectiveControl: snapshot.effectiveControl,
      }) as never,
    getQueue: async () => snapshot,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    deleteQueueItem: async (_workspace, _session, id) => {
      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        items: snapshot.items.filter((turn) => turn.id !== id),
      };
      return { snapshot, replay: false } as never;
    },
    listHumanInputRequests: async () => [],
    streamEvents: async function* (_workspace, _session, options) {
      streams++;
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  const view = await renderComponent(
    <SessionConversation
      sessionId={SESSION_ID}
      client={client}
      workspaceId={WORKSPACE_ID}
      userMessageDisclosureLabels={{ showMore: "Afficher davantage", showLess: "Réduire" }}
    />,
  );
  try {
    await flush(100);
    const latestQuestion = view.container.querySelector<HTMLButtonElement>(
      "[data-og-jump-to-question]",
    );
    expect(latestQuestion).not.toBeNull();
    expect(view.container.querySelectorAll("[data-og-jump-to-question]")).toHaveLength(1);
    await actRun(() => latestQuestion!.click());
    await flush(30);
    expect(latestQuestionLookups).toBe(1);
    const disclosure = view.container.querySelector<HTMLButtonElement>(
      "[data-og-user-message-disclosure]",
    )!;
    expect(disclosure.textContent).toBe("Afficher davantage");
    await actRun(() => disclosure.click());
    expect(disclosure.textContent).toBe("Réduire");
    await view.rerender(
      <SessionConversation sessionId={SESSION_ID} client={client} workspaceId={WORKSPACE_ID} />,
    );
    expect(disclosure.textContent).toBe("Show less");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    await actRun(() => disclosure.click());
    expect(disclosure.textContent).toBe("Show more");
    expect(streams).toBe(1);
    expect(view.container.querySelector("textarea")).not.toBeNull();
    const surface = view.container.querySelector("[data-og-conversation]");
    expect(surface?.classList.contains("bg-og-bg")).toBe(true);
    expect(surface?.classList.contains("text-og-fg")).toBe(true);
    expect(view.container.textContent).toContain("2 queued");
    const button = [...view.container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("2 queued"),
    );
    expect(button).toBeDefined();
    if (button!.getAttribute("aria-expanded") !== "true") {
      await actRun(() => button!.click());
    }
    await flush(50);
    expect(view.container.textContent).toContain("first queued prompt");
    expect(view.container.textContent).toContain("second queued prompt");
    await flush(300);
    const remove = view.container.querySelector<HTMLButtonElement>(
      "[aria-label='Remove queued prompt 1']",
    )!;
    await actRun(() => remove.click());
    await flush(400);
    expect(view.container.textContent).not.toContain("first queued prompt");
    expect(view.container.textContent).toContain("second queued prompt");
  } finally {
    await view.unmount();
  }
});
