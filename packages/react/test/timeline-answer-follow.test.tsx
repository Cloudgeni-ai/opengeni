/* ----------------------------------------------------------------------------
   A card the person answers hands the view back to the conversation.

   Clicking or focusing inside the timeline means "I'm reading here", so the
   timeline stops following its tip. A connect card is different once the
   person finishes it: the agent continues from that answer, and the answer
   has to arrive in view rather than below the fold behind Jump to latest.
   The card's setup dialog is portaled outside the scroller; its events must
   not count as reading the conversation either.
   -------------------------------------------------------------------------- */
import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { act, type ReactElement } from "react";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();
// Radix decides at import time whether a DOM exists; its portals stay empty
// when imported before the DOM is registered.
const { MessageTimeline, SessionCapabilityFrame } = await import("../src");

let sequence = 0;
const START = Date.now() - 60_000;
function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `answer-follow-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(START + sequence * 5_000).toISOString(),
    turnId,
  };
}

function conversation(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Can you read my notes?" }, null),
    event("turn.started", {}),
    event("tool.auth_needed", {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "notes.example",
      reason: "not_connected",
      capability: {
        id: "mcp:notes",
        name: "Notes",
        kind: "mcp",
        source: "built_in",
        action: "connect",
        rationale: "Read your notes.",
        requiredVariables: [],
      },
    }),
    event("turn.completed", { output: "Connect Notes to continue." }),
  ];
}

function continuation(): SessionEvent[] {
  return [
    event("turn.started", {}, "turn-2"),
    event(
      "agent.message.delta",
      { text: "Here are your notes.", messageId: "answer", phase: "final_answer" },
      "turn-2",
    ),
  ];
}

function Card({ expanded, complete }: { expanded: boolean; complete: boolean }) {
  return (
    <SessionCapabilityFrame
      name="Notes"
      subtitle="Your notes"
      logo={null}
      typeLabel="App"
      description="Read your notes."
      skill={false}
      expanded={expanded}
      complete={complete}
      actionLabel="Connect Notes"
      note=""
      onOpen={() => {}}
      onClose={() => {}}
    >
      <button type="button" data-testid="dialog-action">
        Continue
      </button>
    </SessionCapabilityFrame>
  );
}

function timeline(
  events: SessionEvent[],
  card: { expanded: boolean; complete: boolean },
): ReactElement {
  return (
    <MessageTimeline
      events={events}
      turnSummary={{ rolling: true }}
      renderAuthNeeded={() => <Card {...card} />}
    />
  );
}

function following(container: HTMLElement): string | null {
  return (
    container.querySelector("[data-og-timeline-scroller]")?.getAttribute("data-og-bottom-follow") ??
    null
  );
}

test("finishing a card follows the agent's continuation although focus stays on the card", async () => {
  const events = conversation();
  const view = await renderComponent(timeline(events, { expanded: false, complete: false }));
  try {
    await flush(50);
    expect(following(view.container)).toBe("true");

    // Pressing the card's button is reading the conversation: follow stops.
    const opener = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Notes",
    );
    expect(opener).toBeDefined();
    await act(async () => {
      opener!.focus();
      opener!.click();
    });
    await flush(20);
    expect(following(view.container)).toBe("false");

    // The person finishes the card; focus returns to it and the agent continues.
    await view.rerender(timeline(events, { expanded: false, complete: true }));
    await flush(50);
    const card = view.container.querySelector<HTMLElement>(".og-session-capability-shell");
    expect(card?.getAttribute("data-state")).toBe("complete");
    await act(async () => card!.focus());
    expect(document.activeElement).toBe(card);
    expect(following(view.container)).toBe("true");

    const continued = [...events, ...continuation()];
    await view.rerender(timeline(continued, { expanded: false, complete: true }));
    await flush(50);
    expect(view.container.textContent).toContain("Here are your notes.");
    expect(following(view.container)).toBe("true");

    // Focus somewhere else in the conversation is reading again.
    const elsewhere = view.container.querySelector<HTMLElement>("[data-og-group-key]");
    expect(elsewhere).not.toBeNull();
    elsewhere!.tabIndex = -1;
    await act(async () => elsewhere!.focus());
    await flush(20);
    expect(following(view.container)).toBe("false");
  } finally {
    await view.unmount();
  }
});

test("a card that is already complete when it appears does not move the view", async () => {
  const events = conversation();
  const view = await renderComponent(timeline(events, { expanded: false, complete: true }));
  try {
    await flush(50);
    const elsewhere = view.container.querySelector<HTMLElement>("[data-og-group-key]");
    elsewhere!.tabIndex = -1;
    await act(async () => elsewhere!.focus());
    await flush(20);
    expect(following(view.container)).toBe("false");
    await view.rerender(
      timeline([...events, ...continuation()], { expanded: false, complete: true }),
    );
    await flush(50);
    expect(following(view.container)).toBe("false");
  } finally {
    await view.unmount();
  }
});

test("the card's setup dialog is not reading the conversation", async () => {
  const events = conversation();
  const view = await renderComponent(timeline(events, { expanded: true, complete: false }));
  try {
    await flush(50);
    const action = document.querySelector<HTMLElement>('[data-testid="dialog-action"]');
    expect(action).not.toBeNull();
    // The dialog is portaled outside the scroller, but React still bubbles its
    // events through the timeline's handlers.
    const scroller = view.container.querySelector("[data-og-timeline-scroller]");
    expect(scroller?.contains(action)).toBe(false);
    await act(async () => {
      action!.focus();
      action!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      action!.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      action!.click();
    });
    await flush(20);
    expect(following(view.container)).toBe("true");
  } finally {
    await view.unmount();
  }
});
