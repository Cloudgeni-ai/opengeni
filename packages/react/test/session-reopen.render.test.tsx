import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { SessionConversation } from "../src/components/session-conversation";
import { retainSharedQueries } from "../src/hooks/shared-query";
import { recordObservedSessionSequence } from "../../sdk/src/session-sequence";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

function event(sequence: number, type: string, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: "2026-10-17T00:00:00.000Z",
    clientEventId: null,
    turnId: type === "user.message" ? null : "turn-1",
  } as SessionEvent;
}

const HISTORY = [
  event(1, "user.message", { text: "What changed in the release?" }),
  event(2, "turn.started", {}),
  event(3, "agent.message.completed", { text: "Three fixes shipped.", messageId: "m-1" }),
  event(4, "turn.completed", {}),
];

test("reopening a conversation renders its last timeline at once and the refresh does not move it", async () => {
  let readDelayMs = 0;
  const delayed =
    <T,>(value: () => T) =>
    async (): Promise<T> => {
      if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      const result = value();
      recordObservedSessionSequence(result, "4");
      return result;
    };
  const client = fakeClient({
    getSession: delayed(() => ({ id: SESSION_ID, status: "idle", lastSequence: 4 }) as never),
    getQueue: delayed(() => ({ items: [], pendingInputs: [] }) as never),
    listHumanInputRequests: delayed(() => [] as never),
    listEvents: delayed(() => [...HISTORY] as never),
    streamEvents: async function* () {},
  });
  const release = retainSharedQueries(client);
  const conversation = (
    <SessionConversation
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      modelPicker={false}
    />
  );
  try {
    const first = await renderComponent(conversation);
    await flush(200);
    const settled = first.container.textContent ?? "";
    expect(settled).toContain("What changed in the release?");
    expect(settled).toContain("Three fixes shipped.");
    await first.unmount();

    // Reads now take a slow mobile round trip; the reopen must not wait for them.
    readDelayMs = 300;
    const reopened = await renderComponent(conversation);
    try {
      const atOnce = reopened.container.textContent ?? "";
      expect(atOnce).toContain("What changed in the release?");
      expect(atOnce).toContain("Three fixes shipped.");
      const rowsAtOnce = reopened.container.querySelectorAll("[data-og-group-key]").length;
      expect(rowsAtOnce).toBeGreaterThan(0);
      await flush(500);
      // The background refresh landed without changing what is on screen.
      expect(reopened.container.textContent ?? "").toBe(atOnce);
      expect(reopened.container.querySelectorAll("[data-og-group-key]").length).toBe(rowsAtOnce);
    } finally {
      await reopened.unmount();
    }
  } finally {
    release();
  }
});
