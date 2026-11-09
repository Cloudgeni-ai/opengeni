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
    event("agent.message.completed", { phase: "final", text: answer }),
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

  test("a run with nothing for the person is not drawn", async () => {
    const r = await renderComponent(<MessageTimeline events={automationRun(named, "NO_REPLY")} />);
    expect(r.container.querySelector("[data-og-automation-run]")).toBeNull();
    expect(r.container.textContent).not.toContain("NO_REPLY");
    await r.unmount();
  });

  test("without agent signals there is no work row under it", async () => {
    const events = automationRun(named, "Contoso wants a refund.");
    const full = await renderComponent(<MessageTimeline events={events} />);
    expect(full.container.querySelector("[data-og-work-header]")).not.toBeNull();
    await full.unmount();
    const simple = await renderComponent(<MessageTimeline events={events} agentSignals={false} />);
    expect(simple.container.querySelector("[data-og-automation-run]")).not.toBeNull();
    expect(simple.container.querySelector("[data-og-work-header]")).toBeNull();
    expect(simple.container.textContent).toContain("Contoso wants a refund.");
    await simple.unmount();
  });
});
