import { expect, test } from "bun:test";
import type { SessionQueueSnapshot } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { conversationTimeline } from "../src/conversation-timeline";
import type { ComposerOptimisticMessage } from "../src/hooks/use-composer";
import { fakeClient, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

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
    listEvents: async () =>
      [
        {
          id: "33333333-3333-4333-8333-333333333333",
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          sequence: 1,
          type: "user.message",
          occurredAt: "2026-09-07T00:00:00Z",
          payload: { text: "A complete long message. ".repeat(80) },
        },
      ] as never,
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
