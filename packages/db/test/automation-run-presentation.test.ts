import { describe, expect, test } from "bun:test";
import { automationRunPresentation } from "../src/automation-run-presentation";

const scheduledTaskId = "77777777-7777-4777-8777-777777777777";
const scheduledTaskRunId = "88888888-8888-4888-8888-888888888888";
const sourceId = "99999999-9999-4999-8999-999999999999";

const inbound = (id: string, summary: string) => ({
  id,
  sourceId,
  sourceKind: "github" as const,
  type: "issues.assigned",
  occurredAt: "2026-11-05T14:46:00.000Z",
  subject: "acme/api#42",
  summary,
  url: "https://github.com/acme/api/issues/42",
  actor: { kind: "person" as const, name: "alice" },
  data: {},
  dataTruncated: false,
});

function update(summary: string, events?: { eventCount: number; summaries: string[] }) {
  return {
    kind: "scheduled_occurrence",
    summary,
    payload: {
      type: "scheduled_occurrence",
      text: "Continue this conversation when an issue is assigned to the signed-in user.",
      scheduledTaskId,
      scheduledTaskRunId,
      ...(events
        ? {
            events: {
              occurrenceId: "55555555-5555-4555-8555-555555555555",
              eventCount: events.eventCount,
              gapBefore: false,
              events: events.summaries.map((text, index) =>
                inbound(`11111111-1111-4111-8111-11111111111${index}`, text),
              ),
            },
          }
        : {}),
    },
  };
}

describe("what a chat shows for an automation run", () => {
  test("the automation's name and what the event says happened", () => {
    expect(
      automationRunPresentation(
        update("Issue assigned to you", { eventCount: 1, summaries: ["Fix the login page"] }),
      ),
    ).toEqual({
      name: "Issue assigned to you",
      eventSummaries: ["Fix the login page"],
      eventCount: 1,
    });
  });

  test("a scheduled run is its name alone", () => {
    expect(automationRunPresentation(update("Weekly summary"))).toEqual({
      name: "Weekly summary",
      eventSummaries: [],
      eventCount: 0,
    });
  });

  test("never the instructions an older update repeated as its summary", () => {
    const legacy = update("");
    legacy.summary = legacy.payload.text;
    expect(automationRunPresentation(legacy)).toBeNull();
  });

  test("keeps the first few events, each bounded", () => {
    const presented = automationRunPresentation(
      update("Issue assigned to you", {
        eventCount: 12,
        summaries: ["one", "two", "three", "four", "x".repeat(500)],
      }),
    );
    expect(presented?.eventSummaries).toEqual(["one", "two", "three"]);
    expect(presented?.eventCount).toBe(12);
    const long = automationRunPresentation(
      update("Issue assigned to you", { eventCount: 1, summaries: ["é".repeat(300)] }),
    );
    expect(Buffer.byteLength(long!.eventSummaries[0]!)).toBeLessThanOrEqual(200);
    expect(long!.eventSummaries[0]!.endsWith("…")).toBe(true);
  });

  test("other updates carry none", () => {
    expect(
      automationRunPresentation({ kind: "agent_message", summary: "Hi", payload: {} }),
    ).toBeNull();
  });
});
