import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { turnSummaryLiveMarkState, type TurnSummaryLiveMarkState } from "../src/timeline-model";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

/*
 * A host can lead the live "Working" / "Waiting" / "Paused" row with its own
 * mark. The mark learns the row's state, leaves when the turn settles, and is
 * absent unless the host asks for it.
 */

let sequence = 0;
const START = Date.UTC(2026, 10, 3, 9, 0, 0);

function at(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

function event(
  type: string,
  payload: unknown,
  seconds: number,
  turnId: string | null = "turn-1",
): SessionEvent {
  sequence += 1;
  return {
    id: `mark-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: at(seconds),
    turnId,
  };
}

function running(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Count new users" }, 0, null),
    event("turn.started", {}, 1),
    event("agent.message.delta", { text: "Counting now." }, 1),
    event("agent.toolCall.created", { id: "count", name: "exec_command", arguments: {} }, 3),
  ];
}

function waitingForApproval(): SessionEvent[] {
  return [
    ...running(),
    event("session.requiresAction", {}, 4),
    event("session.status.changed", { status: "requires_action" }, 4),
  ];
}

function completed(): SessionEvent[] {
  return [
    ...running(),
    event("agent.toolCall.output", { id: "count", output: "42" }, 5),
    event("agent.message.delta", { text: "There are 42." }, 6),
    event("turn.completed", {}, 7),
  ];
}

function mark(state: TurnSummaryLiveMarkState) {
  return <i data-mascot={state.waitingOn ? `${state.kind}-${state.waitingOn}` : state.kind} />;
}

describe("live mark", () => {
  test("leads the working row and follows its state", async () => {
    const events = running();
    const view = await renderComponent(
      <MessageTimeline events={events} turnSummary={{ rolling: true, renderLiveMark: mark }} />,
    );
    try {
      await flush(50);
      const slot = () => view.container.querySelector("[data-og-live-mark]");
      const mascot = () => view.container.querySelector("[data-mascot]");
      expect(slot()?.getAttribute("data-og-live-mark")).toBe("working");
      expect(slot()?.getAttribute("aria-hidden")).toBe("true");
      expect(mascot()?.getAttribute("data-mascot")).toBe("working");
      expect(view.container.querySelector("[data-og-exchange-status]")?.textContent).toMatch(
        /^Working/,
      );

      await view.rerender(
        <MessageTimeline
          events={waitingForApproval()}
          turnSummary={{ rolling: true, renderLiveMark: mark }}
        />,
      );
      await flush(50);
      expect(slot()?.getAttribute("data-og-live-mark")).toBe("waiting");
      expect(mascot()?.getAttribute("data-mascot")).toBe("waiting-you");

      await view.rerender(
        <MessageTimeline
          events={events}
          turnSummary={{ rolling: true, renderLiveMark: mark }}
          pause={{ paused: true, since: at(61) }}
        />,
      );
      await flush(50);
      expect(slot()?.getAttribute("data-og-live-mark")).toBe("paused");
      expect(mascot()?.getAttribute("data-mascot")).toBe("paused");

      await view.rerender(
        <MessageTimeline
          events={completed()}
          turnSummary={{ rolling: true, renderLiveMark: mark }}
        />,
      );
      await flush(50);
      expect(slot()).toBeNull();
      expect(mascot()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("is absent by default", async () => {
    const view = await renderComponent(
      <MessageTimeline events={running()} turnSummary={{ rolling: true }} />,
    );
    try {
      await flush(50);
      expect(view.container.querySelector("[data-og-exchange-status]")).not.toBeNull();
      expect(view.container.querySelector("[data-og-live-mark]")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("state follows the row status and ends when it settles", () => {
    expect(turnSummaryLiveMarkState(undefined)).toBeNull();
    expect(turnSummaryLiveMarkState({ kind: "worked" })).toBeNull();
    expect(turnSummaryLiveMarkState({ kind: "working" })).toEqual({ kind: "working" });
    expect(turnSummaryLiveMarkState({ kind: "waiting" })).toEqual({ kind: "waiting" });
    expect(turnSummaryLiveMarkState({ kind: "waiting", waitingOn: "you" })).toEqual({
      kind: "waiting",
      waitingOn: "you",
    });
    expect(turnSummaryLiveMarkState({ kind: "paused" })).toEqual({ kind: "paused" });
  });
});
