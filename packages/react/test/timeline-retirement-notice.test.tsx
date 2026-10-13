import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { buildTimeline } from "../src/timeline";
import { registerDom, renderComponent, flush } from "./render-hook";

registerDom();

const childId = "5ea5c583-efb3-4080-9272-c13a050cf4bd";
const operationId = "2f920545-f2ef-4eca-a79b-44be7f1a8cbd";
function receipt(notificationOnly = true): SessionEvent {
  return {
    id: "receipt",
    workspaceId: "workspace",
    sessionId: "parent",
    sequence: 1,
    type: "system.update.settled",
    turnId: null,
    occurredAt: "2026-10-13T00:00:00.000Z",
    payload: {
      notificationOnly,
      reason: "operator_retirement",
      retirementOperationId: operationId,
      members: [
        {
          id: "child-terminal",
          kind: "child_terminal_result",
          classification: "failure",
          sourceId: childId,
          summary: "Child work was interrupted and retired without replay.",
        },
      ],
    },
  };
}

describe("retired child timeline receipt", () => {
  test("notification-only settlement renders the existing failed-agent row without a user prompt", async () => {
    const events = [receipt()];
    const items = buildTimeline(events);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe("machine-input-batch");
    if (item.kind !== "machine-input-batch") throw new Error("Missing retirement notice");
    expect(item.turnId).toBeNull();
    const opened: string[] = [];
    const rendered = await renderComponent(
      <MessageTimeline events={events} onOpenSession={(id) => opened.push(id)} />,
    );
    expect(rendered.container.textContent).toContain("Agent failed");
    expect(rendered.container.textContent).toContain("interrupted and retired without replay");
    expect(rendered.container.textContent).not.toContain(operationId);
    expect(rendered.container.textContent).not.toContain("Queued");
    const link = rendered.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open agent session"]',
    );
    expect(link).not.toBeNull();
    await act(async () => {
      link!.click();
      await flush();
    });
    expect(opened).toEqual([childId]);
    await rendered.unmount();
  });

  test("ordinary input-settlement metadata remains quiet", () => {
    expect(buildTimeline([receipt(false)])).toEqual([]);
  });
});
