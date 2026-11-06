import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src/components/message-timeline";
import { registerDom, renderComponent } from "./render-hook";

registerDom();

const INSTRUCTIONS =
  "Continue this conversation when a ticket is assigned to the signed-in user. Confirm through list_my_tickets.";

let sequence = 0;
function event(type: string, payload: unknown = {}, turnId: string | null = "run"): SessionEvent {
  sequence += 1;
  return {
    id: `row-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 10, 5, 14) + sequence * 1000).toISOString(),
  } as SessionEvent;
}

function automationRun(member: Record<string, unknown>, answer: string): SessionEvent[] {
  return [
    event("system.update.delivered", {
      members: [
        {
          id: "update-1",
          kind: "scheduled_occurrence",
          sourceId: "run-1",
          classification: "info",
          ...member,
        },
      ],
    }),
    event("turn.started"),
    event("agent.toolCall.created", { id: "call-1", name: "get_ticket", arguments: {} }),
    event("agent.toolCall.output", { id: "call-1", output: "{}" }),
    event("agent.message.completed", { phase: "final_answer", text: answer }),
    event("turn.completed"),
  ];
}

const named = {
  summary: "Ticket assigned to you",
  automation: {
    name: "Ticket assigned to you",
    eventSummaries: ["T-4907 Refund request"],
    eventCount: 1,
  },
};

/** A turn's work row, in the chat's readable turns and in the plain timeline. */
const WORK_ROW = "[data-og-work-id], [data-og-work-header]";
const TIMELINES = [
  { turnSummary: { rolling: true } },
  { turnSummary: { rolling: true }, agentSignals: false },
  {},
] as const;

describe("an automation run in the chat", () => {
  test("reads as one line saying what happened, then the answer", async () => {
    const r = await renderComponent(
      <MessageTimeline events={automationRun(named, "Contoso wants a refund.")} />,
    );
    const row = r.container.querySelector("[data-og-automation-run]");
    expect(row?.textContent).toContain("Ticket assigned to you: T-4907 Refund request");
    expect(row?.querySelector("button")).toBeNull();
    expect(r.container.textContent).toContain("Contoso wants a refund.");
    expect(r.container.textContent).not.toContain("Continue this conversation");
    await r.unmount();
  });

  test("an older run never shows its instructions", async () => {
    const r = await renderComponent(
      <MessageTimeline events={automationRun({ summary: INSTRUCTIONS }, "Done.")} />,
    );
    expect(r.container.querySelector("[data-og-automation-run]")?.textContent).toContain(
      "Automation run",
    );
    expect(r.container.textContent).not.toContain("Continue this conversation");
    await r.unmount();
  });

  test("a run with nothing to say is only its line", async () => {
    for (const props of TIMELINES) {
      const r = await renderComponent(
        <MessageTimeline events={automationRun(named, "NO_REPLY")} {...props} />,
      );
      expect(r.container.querySelector("[data-og-automation-run]")?.textContent).toContain(
        "Ticket assigned to you: T-4907 Refund request",
      );
      expect(r.container.querySelector(WORK_ROW)).toBeNull();
      expect(r.container.textContent).not.toContain("NO_REPLY");
      await r.unmount();
    }
  });

  test("a run's work is never drawn under its line", async () => {
    const events = automationRun(named, "Contoso wants a refund.");
    for (const props of TIMELINES) {
      const r = await renderComponent(<MessageTimeline events={events} {...props} />);
      expect(r.container.querySelector("[data-og-automation-run]")).not.toBeNull();
      expect(r.container.querySelector(WORK_ROW)).toBeNull();
      expect(r.container.textContent).toContain("Contoso wants a refund.");
      await r.unmount();
    }
  });

  test("a turn a person started keeps its work row", async () => {
    const r = await renderComponent(
      <MessageTimeline
        events={[
          event("user.message", { text: "Check T-2" }, "chat"),
          event("turn.started", {}, "chat"),
          event("agent.toolCall.created", { id: "c2", name: "get_ticket", arguments: {} }, "chat"),
          event("agent.toolCall.output", { id: "c2", output: "{}" }, "chat"),
          event("agent.message.completed", { phase: "final_answer", text: "Open." }, "chat"),
          event("turn.completed", {}, "chat"),
          ...automationRun(named, "Contoso wants a refund."),
        ]}
        turnSummary={{ rolling: true }}
      />,
    );
    expect(r.container.querySelectorAll("[data-og-work-id]")).toHaveLength(1);
    expect(r.container.querySelector("[data-og-automation-run]")).not.toBeNull();
    await r.unmount();
  });
});
