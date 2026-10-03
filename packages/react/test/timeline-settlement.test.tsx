import { expect, test } from "bun:test";
import { captureTimelineSettlement } from "../src/components/timeline-settlement";
import { buildTimeline, groupTimeline } from "../src/timeline";
import type { SessionEvent } from "@opengeni/sdk";
import { registerDom } from "./render-hook";

registerDom();

test("an earlier pending row cannot mask a later retained answer settling", () => {
  const events: SessionEvent[] = [
    ["turn.started", {}, "earlier"],
    ["agent.toolCall.created", { id: "old", name: "exec_command", arguments: {} }, "earlier"],
    ["user.message", { text: "Next question" }, null],
    ["turn.started", {}, "later"],
    ["agent.toolCall.created", { id: "new", name: "exec_command", arguments: {} }, "later"],
    [
      "agent.message.completed",
      { messageId: "answer", text: "Retained answer", phase: "final_answer" },
      "later",
    ],
    ["turn.completed", {}, "later"],
  ].map(([type, payload, turnId], index) => ({
    id: `event-${index}`,
    workspaceId: "w",
    sessionId: "s",
    sequence: index + 1,
    type,
    payload,
    turnId,
    occurredAt: new Date(index * 1000).toISOString(),
  })) as SessionEvent[];
  const groups = groupTimeline(buildTimeline(events), { readableTurns: true }).map((group) => ({
    key: group.kind === "item" ? group.item.id : group.id,
    group,
  }));
  const scroller = document.createElement("div");
  document.body.append(scroller);
  for (const { key, group } of groups) {
    const row = document.createElement("div");
    row.dataset.ogGroupKey = key;
    if (group.kind === "activity")
      row.innerHTML = '<button data-og-exchange-status="working">Working</button>';
    scroller.append(row);
  }
  try {
    const answer = scroller.lastElementChild;
    expect(captureTimelineSettlement(scroller, groups)?.element === answer).toBe(true);
  } finally {
    scroller.remove();
  }
});
