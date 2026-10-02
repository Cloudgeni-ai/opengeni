import { expect, test } from "bun:test";
import type { SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { Markdown } from "../src/components/markdown";
import { OpenGeniLinkProvider } from "../src/components/open-geni-links";
import { conversationTimeline } from "../src/conversation-timeline";
import type { ComposerOptimisticMessage } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
import { latestQuestionClient } from "./fixtures/latest-question-client";
import { archivedTranscriptEvents } from "./fixtures/archived-transcript";

registerDom();

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await flush(10);
  }
}

test("imported archives retain the timeline and expose no execution controls", async () => {
  let mutations = 0;
  const client = fakeClient({
    getSession: async () =>
      ({
        id: SESSION_ID,
        status: "idle",
        importedArchive: {
          importId: "old-host/chat-42",
          importedAt: "2026-10-01T06:30:00.000Z",
          readOnly: true,
        },
      }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    listHumanInputRequests: async () => [],
    streamEvents: async function* () {},
    listEvents: async () => archivedTranscriptEvents(),
    sendMessage: async () => {
      mutations++;
      throw new Error("must not send");
    },
    steerMessage: async () => {
      mutations++;
      throw new Error("must not steer");
    },
  });
  const view = await renderComponent(
    <SessionConversation
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await flush(100);
    expect(view.container.textContent).toContain("Archived conversation · Read only");
    expect(view.container.textContent).toContain("Will users still see their past chats?");
    expect(view.container.textContent).toContain("日本語もそのまま残ります。");
    expect(view.container.querySelector("textarea")).toBeNull();
    expect(view.container.querySelector("[data-og-conversation-composer]")).toBeNull();
    expect(view.container.querySelector("[data-og-conversation-inputs]")).toBeNull();
    expect(mutations).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("an outer host resolver overrides conversation download defaults", async () => {
  const client = fakeClient({
    getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
    streamEvents: async function* () {},
    listEvents: async () =>
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          sequence: 1,
          type: "user.message",
          occurredAt: "2026-09-30T10:00:00Z",
          payload: { text: "Show file" },
        },
      ] as never,
  });
  const view = await renderComponent(
    <OpenGeniLinkProvider resolveLink={() => ({ href: "/host-file-panel" })}>
      <SessionConversation
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        modelPicker={false}
        renderMessageText={() => (
          <Markdown>{"[File](artifact:33333333-3333-4333-8333-333333333333)"}</Markdown>
        )}
      />
    </OpenGeniLinkProvider>,
  );
  try {
    await flush(100);
    expect(view.container.querySelector('a[href="/host-file-panel"]')).not.toBeNull();
    expect(view.container.querySelector('button[title="Open file"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("proxy sandbox capability disables default downloads in the complete conversation", async () => {
  const base = fakeClient({});
  for (const enabled of [false, true]) {
    const client = fakeClient({
      getClientConfig: async () => ({ ...(await base.getClientConfig()), sandboxFiles: enabled }),
      getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
      getQueue: async () => ({ items: [], pendingInputs: [] }) as never,
      streamEvents: async function* () {},
      listEvents: async () =>
        [
          {
            id: "33333333-3333-4333-8333-333333333333",
            workspaceId: WORKSPACE_ID,
            sessionId: SESSION_ID,
            sequence: 1,
            type: "user.message",
            occurredAt: "2026-09-30T10:00:00Z",
            payload: { text: "Show code" },
          },
        ] as never,
    });
    const view = await renderComponent(
      <SessionConversation
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        modelPicker={false}
        renderMessageText={() => <Markdown>{"[Code](sandbox:src/a)"}</Markdown>}
      />,
    );
    try {
      await flush(100);
      expect(view.container.querySelector('button[title="Open src/a"]') !== null).toBe(enabled);
      expect(view.container.querySelector('a[href^="sandbox:"]')).toBeNull();
    } finally {
      await view.unmount();
    }
  }
});

test("contextual navigation stays unavailable when initial history has no mounted prompt", async () => {
  const fixture = latestQuestionClient("pending");
  const listEvents = fixture.client.listEvents;
  let releaseHistory!: () => void;
  const history = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  fixture.client.listEvents = async (...args) => {
    if (!args[2]?.includeTypes) await history;
    return listEvents(...args);
  };
  const view = await renderComponent(
    <SessionConversation
      client={fixture.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
    />,
  );
  try {
    await flush(100);
    expect(view.container.querySelector("[data-og-jump-to-question]")).toBeNull();
    releaseHistory();
    await waitFor(
      () => view.container.querySelector("[data-og-wide-table-message]") !== null,
      "history did not render",
    );
    expect(view.container.querySelector("[data-og-jump-to-question]")).toBeNull();
    expect(fixture.reads.some((read) => read.includeTypes?.includes("user.message"))).toBe(false);
  } finally {
    releaseHistory();
    await view.unmount();
  }
});

for (const mode of [
  "pending",
  "started",
  "withdrawn",
  "legacy-running",
  "legacy-settled",
] as const) {
  test(`unmounted ${mode} prompts do not cause global navigation through SessionConversation`, async () => {
    const { client, turn, reads } = latestQuestionClient(mode);
    const view = await renderComponent(
      <SessionConversation client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    try {
      await waitFor(
        () => view.container.querySelector("[data-og-wide-table-message]") !== null,
        "history did not render",
      );
      if (mode === "pending") {
        const queueButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.includes("1 queued"),
        );
        if (queueButton?.getAttribute("aria-expanded") === "true")
          await actRun(() => queueButton.click());
      }
      expect(view.container.querySelector("[data-og-prompt]")).toBeNull();
      expect(view.container.querySelector("[data-og-jump-to-question]")).toBeNull();
      expect(reads.some((read) => read.includeTypes?.includes("user.message"))).toBe(false);
      expect((document.activeElement as HTMLElement)?.dataset.queueTurnId).not.toBe(turn.id);
    } finally {
      await view.unmount();
    }
  });
}

test("Jump to start loads history without redirecting focus to a pending queue item", async () => {
  const fixture = latestQuestionClient("pending");
  const view = await renderComponent(
    <SessionConversation
      client={fixture.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
    />,
  );
  try {
    await flush(100);
    const queueButton = view.container.querySelector<HTMLButtonElement>(
      '[data-og-session-chrome-signal="queue"]',
    )!;
    if (queueButton.getAttribute("aria-expanded") === "true")
      await actRun(() => queueButton.click());
    const scroller = view.container.querySelector<HTMLElement>("[data-og-timeline-scroller]")!;
    await actRun(() =>
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true })),
    );
    await flush(20);
    const start = view.container.querySelector<HTMLButtonElement>("[data-og-jump-to-start]");
    expect(start).not.toBeNull();
    expect(view.container.querySelector("[data-og-jump-to-question]")).toBeNull();
    await actRun(() => start!.click());
    await flush(40);
    await flush(80);
    expect((document.activeElement as HTMLElement)?.dataset.queueTurnId).not.toBe(fixture.turn.id);
    expect(view.container.querySelector('[data-og-session-chrome-open="true"]')).toBeNull();
    expect(view.container.querySelector("[data-og-prompt]")?.textContent).toContain(
      "Previous valid question",
    );
  } finally {
    await view.unmount();
  }
});

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

test("definitively refused messages offer editing, not an unchanged retry", () => {
  let edits = 0;
  const items = conversationTimeline(
    [],
    { queue: [], snapshot: null },
    {
      optimisticMessages: [
        {
          clientEventId: "refused-credit-message",
          delivery: "send",
          destination: "chat",
          text: "preserved prompt",
          annotations: [],
          resources: [],
          occurredAt: new Date(0).toISOString(),
          state: "failed",
          error: "Out of credits",
          retryable: false,
        },
      ],
      retryOptimisticMessage: () => {
        throw Error("A credit refusal must not expose Retry");
      },
      restoreOptimisticMessage: () => {
        edits += 1;
      },
    },
  );
  const item = items[0]!;
  if (item.kind !== "user-message") throw Error("Expected refused message");
  expect(item.delivery?.onRetry).toBeUndefined();
  item.delivery?.onEdit?.();
  expect(edits).toBe(1);
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
    expect(latestQuestion).toBeNull();
    expect(latestQuestionLookups).toBe(0);
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

test("complete conversation surfaces tool approvals and wires attachments when uploads are enabled", async () => {
  const decisions: unknown[] = [];
  const base = fakeClient({});
  const client = fakeClient({
    getClientConfig: async () => ({
      ...(await base.getClientConfig()),
      fileUploads: { enabled: true, maxSizeBytes: 1_000_000 },
    }),
    listEvents: async () =>
      [
        {
          id: "33333333-3333-4333-8333-333333333334",
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "session.requiresAction",
          turnId: "44444444-4444-4444-8444-444444444444",
          occurredAt: "2026-09-07T00:00:00Z",
          payload: {
            approvals: [{ rawItem: { callId: "call-1", name: "deploy" }, name: "deploy" }],
          },
        },
      ] as never,
    getSession: async () => ({ id: SESSION_ID, status: "requires_action" }) as never,
    getQueue: async () =>
      ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
    getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
    listHumanInputRequests: async () => [],
    sendApprovalDecision: async (_workspace, _session, decision) => {
      decisions.push(decision);
      return {} as never;
    },
    streamEvents: async function* (_workspace, _session, options) {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    },
  });
  const view = await renderComponent(
    <SessionConversation sessionId={SESSION_ID} client={client} workspaceId={WORKSPACE_ID} />,
  );
  try {
    await flush(200);
    expect(view.container.querySelector("[aria-label='Attach files']")).not.toBeNull();
    const approve = [...view.container.querySelectorAll("button")].find(
      (node) => node.textContent === "Approve",
    );
    expect(approve).toBeDefined();
    await actRun(() => approve!.click());
    await flush(50);
    expect(decisions).toMatchObject([{ approvalId: "call-1", decision: "approve" }]);
  } finally {
    await view.unmount();
  }
});

test("the model picker follows the proxy's modelSelection flag and the modelPicker prop", async () => {
  const base = fakeClient({});
  const clientWith = (modelSelection: boolean | undefined) =>
    fakeClient({
      getClientConfig: async () =>
        ({
          ...(await base.getClientConfig()),
          ...(modelSelection === undefined ? {} : { modelSelection }),
        }) as never,
      getSession: async () => ({ id: SESSION_ID, status: "idle" }) as never,
      getQueue: async () =>
        ({ version: 1, effectiveControl: null, items: [], pendingInputs: [] }) as never,
      getWorkspaceModelCatalog: async () => ({ models: [] }) as never,
      listHumanInputRequests: async () => [],
      streamEvents: async function* (_workspace, _session, options) {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield* [];
      },
    });
  const picker = (container: HTMLElement) =>
    container.querySelector(
      "[aria-label='Model and effort'], [aria-label='Loading model catalog…']",
    );
  for (const [modelSelection, prop, expected] of [
    [undefined, undefined, true],
    [false, undefined, false],
    [false, true, true],
    [undefined, false, false],
  ] as const) {
    const view = await renderComponent(
      <SessionConversation
        sessionId={SESSION_ID}
        client={clientWith(modelSelection)}
        workspaceId={WORKSPACE_ID}
        {...(prop === undefined ? {} : { modelPicker: prop })}
      />,
    );
    try {
      await flush(150);
      expect(picker(view.container) !== null).toBe(expected);
    } finally {
      await view.unmount();
    }
  }
});
