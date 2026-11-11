import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

let previousObserver: PropertyDescriptor | undefined;
beforeEach(() => {
  previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
  else Reflect.deleteProperty(globalThis, "IntersectionObserver");
});

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

/** A conversation with some history, whose live stream emits what the test pushes. */
function liveConversation(history: SessionEvent[]) {
  const pending: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let historyLoaded = false;
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
        lastSequence: history.at(-1)?.sequence ?? 0,
      }) as never,
    getQueue: async () => ({ items: [], pendingInputs: [], effectiveControl }) as never,
    listHumanInputRequests: async () => [],
    listEvents: async () => {
      historyLoaded = true;
      return history;
    },
    streamEvents: async function* (_workspace, _session, options) {
      // A reconnect may replay what the history already had.
      yield* history;
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
    updateSessionAttention: async () => ({}) as never,
  });
  return {
    client,
    loaded: () => historyLoaded,
    push: async (...events: SessionEvent[]) => {
      pending.push(...events);
      wake?.();
      await flush(20);
    },
  };
}

test("onEvent hears each new event once, never the history it opened with", async () => {
  const history = [
    event(1, "user.message", { text: "Make the header blue" }),
    event(2, "agent.toolCall.output", { callId: "old", output: "published v4" }),
    event(3, "turn.completed", { output: "Done." }),
  ];
  const conversation = liveConversation(history);
  const heard: Array<[number, string]> = [];
  const view = await renderComponent(
    <SessionConversation
      client={conversation.client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
      onEvent={(next) => heard.push([next.sequence, next.type])}
    />,
  );
  try {
    await waitFor(conversation.loaded, "The history was not read");
    await flush(50);
    expect(heard).toEqual([]);
    await conversation.push(
      event(4, "user.message", { text: "Now make it green" }),
      event(5, "agent.toolCall.output", { callId: "new", output: "published v5" }),
    );
    await waitFor(() => heard.length >= 2, "The new events were not heard");
    await conversation.push(event(6, "turn.completed", { output: "Done." }));
    await waitFor(() => heard.length >= 3, "The turn's end was not heard");
    await flush(50);
    expect(heard).toEqual([
      [4, "user.message"],
      [5, "agent.toolCall.output"],
      [6, "turn.completed"],
    ]);
  } finally {
    await view.unmount();
  }
});
