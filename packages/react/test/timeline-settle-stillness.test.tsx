import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

let sequence = 0;
const START = Date.now() - 60_000;
function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `still-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(START + sequence * 5_000).toISOString(),
    turnId,
  };
}

const ANSWER = "Hello. What can I help you with?";

test("a declared answer stays below the work row, in the same element, while its turn settles", async () => {
  sequence = 0;
  const user = event("user.message", { text: "hey" }, null);
  const started = event("turn.started", {});
  const reasoning = event("agent.reasoning.delta", { text: "The person greets me." });
  const delta = event("agent.message.delta", {
    text: ANSWER,
    messageId: "answer",
    phase: "final_answer",
  });
  const completed = event("agent.message.completed", {
    text: ANSWER,
    messageId: "answer",
    phase: "final_answer",
  });
  const ended = event("turn.completed", { output: ANSWER });
  const idle = event("session.status.changed", { status: "idle" }, null);
  const steps = [
    [user, started, reasoning, delta],
    [user, started, reasoning, delta, completed],
    [user, started, reasoning, delta, completed, ended],
    [user, started, reasoning, delta, completed, ended, idle],
  ];
  const view = await renderComponent(
    <MessageTimeline events={steps[0]!} turnSummary={{ rolling: true }} />,
  );
  try {
    const answer = () =>
      [...view.container.querySelectorAll("p")].find((node) => node.textContent === ANSWER);
    const status = () => view.container.querySelector("[data-og-exchange-status]");
    await flush(50);
    const first = answer();
    expect(first).toBeDefined();
    const expectedStatus = ["working", "working", "worked", "worked"];
    for (const [index, events] of steps.entries()) {
      if (index > 0) {
        await view.rerender(<MessageTimeline events={events} turnSummary={{ rolling: true }} />);
        // The answer never leaves the page, not even for the settling frame.
        expect(answer()).toBe(first);
        await flush(50);
      }
      expect(answer()).toBe(first);
      const row = status();
      expect(row?.getAttribute("data-og-exchange-status")).toBe(expectedStatus[index]!);
      // The work row sits above the answer in every state.
      expect(row!.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  } finally {
    await view.unmount();
  }
});
