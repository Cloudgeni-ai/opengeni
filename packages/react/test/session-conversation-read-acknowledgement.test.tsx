import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act } from "react";
import { SessionConversation } from "../src/components/session-conversation";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

type Observed = { callback: IntersectionObserverCallback; targets: Element[] };
let observers: Observed[] = [];
let previousObserver: PropertyDescriptor | undefined;
let previousHasFocus: PropertyDescriptor | undefined;
let previousVisibility: PropertyDescriptor | undefined;
let focused = true;
let visibility: DocumentVisibilityState = "visible";

beforeAll(() => {
  previousHasFocus = Object.getOwnPropertyDescriptor(document, "hasFocus");
  previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "hasFocus", { configurable: true, value: () => focused });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterAll(() => {
  // The DOM registered for this file may already be gone with its overrides.
  if (typeof document === "undefined") return;
  if (previousHasFocus) Object.defineProperty(document, "hasFocus", previousHasFocus);
  else Reflect.deleteProperty(document, "hasFocus");
  if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});
beforeEach(() => {
  observers = [];
  focused = true;
  visibility = "visible";
  previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      private readonly observed: Observed;
      constructor(callback: IntersectionObserverCallback) {
        this.observed = { callback, targets: [] };
        observers.push(this.observed);
      }
      observe(target: Element) {
        this.observed.targets.push(target);
      }
      disconnect() {
        observers = observers.filter((each) => each !== this.observed);
      }
    },
  });
});
afterEach(() => {
  if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
  else Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

async function setTimelineOnScreen(isIntersecting: boolean) {
  await act(async () => {
    for (const observed of observers) {
      observed.callback(
        observed.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
    }
  });
}

async function setForeground(next: { focused?: boolean; visibility?: DocumentVisibilityState }) {
  await act(async () => {
    if (next.focused !== undefined) focused = next.focused;
    if (next.visibility !== undefined) visibility = next.visibility;
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await flush(10);
  }
}

function event(sequence: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date(0).toISOString(),
    turnId: "turn-1",
    clientEventId: null,
  } as unknown as SessionEvent;
}

/** A conversation whose live stream emits what the test pushes. */
function liveConversation() {
  const acknowledged: number[] = [];
  const pending: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  const effectiveControl = {
    state: "running",
    directState: "running",
    override: null,
    primaryBlocker: null,
    settlement: null,
  };
  const client = fakeClient({
    getSession: async () =>
      ({
        id: SESSION_ID,
        status: "idle",
        effectiveControl,
        unread: false,
        lastSequence: 1,
      }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [], effectiveControl }) as never,
    listHumanInputRequests: async () => [],
    listEvents: async () => [event(1, "user.message", { text: "What changed?" })],
    streamEvents: async function* (_workspace, _session, options) {
      while (!options?.signal?.aborted) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    updateSessionAttention: async (workspaceId, sessionId, request) => {
      expect([workspaceId, sessionId]).toEqual([WORKSPACE_ID, SESSION_ID]);
      expect(request.unread).toBe(false);
      acknowledged.push(request.acknowledgedThroughSequence ?? -1);
      return {} as never;
    },
  });
  return {
    client,
    acknowledged,
    push: async (...events: SessionEvent[]) => {
      pending.push(...events);
      wake?.();
      await flush(20);
    },
  };
}

const reply = (sequence: number) =>
  event(sequence, "agent.message.completed", { text: "Two things.", phase: "final_answer" });
const completed = (sequence: number) =>
  event(sequence, "turn.completed", { output: "Two things." });

test("a reply the person watches is acknowledged through the observed timeline", async () => {
  const conversation = liveConversation();
  const view = await renderComponent(
    <SessionConversation
      client={conversation.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(() => observers.length > 0, "The timeline was not observed");
    expect(observers[0]!.targets[0]!.hasAttribute("data-og-timeline-scroller")).toBe(true);
    await setTimelineOnScreen(true);
    await conversation.push(reply(2), completed(3));
    await waitFor(
      () => conversation.acknowledged.includes(3),
      "The watched reply was not acknowledged",
    );
    expect(conversation.acknowledged.every((sequence) => sequence === 2 || sequence === 3)).toBe(
      true,
    );
  } finally {
    await view.unmount();
  }
});

test("a hidden timeline, background tab or unfocused window acknowledges nothing", async () => {
  const conversation = liveConversation();
  const view = await renderComponent(
    <SessionConversation
      client={conversation.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />,
  );
  try {
    await waitFor(() => observers.length > 0, "The timeline was not observed");
    // The host hides the timeline (for example a collapsed composer bar).
    await setTimelineOnScreen(false);
    await conversation.push(reply(2));
    await flush(50);
    expect(conversation.acknowledged).toEqual([]);

    // On screen, but the window lost focus.
    await setForeground({ focused: false });
    await setTimelineOnScreen(true);
    await conversation.push(completed(3));
    await flush(50);
    expect(conversation.acknowledged).toEqual([]);

    // Focused again, but the tab is in the background.
    await setForeground({ focused: true, visibility: "hidden" });
    await flush(50);
    expect(conversation.acknowledged).toEqual([]);

    // Back in front: the person sees it now.
    await setForeground({ visibility: "visible" });
    await waitFor(
      () => conversation.acknowledged.includes(3),
      "The reply was not acknowledged once seen",
    );
  } finally {
    await view.unmount();
  }
});

test("readAcknowledgement={false} never marks the conversation read", async () => {
  const conversation = liveConversation();
  const view = await renderComponent(
    <SessionConversation
      client={conversation.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
      readAcknowledgement={false}
    />,
  );
  try {
    await waitFor(() => observers.length > 0, "The timeline was not observed");
    await setTimelineOnScreen(true);
    await conversation.push(reply(2), completed(3));
    await flush(50);
    expect(conversation.acknowledged).toEqual([]);
  } finally {
    await view.unmount();
  }
});
