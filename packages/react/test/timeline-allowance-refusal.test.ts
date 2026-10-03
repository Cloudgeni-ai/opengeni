import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  creditExhaustedFromEvents,
  groupTimeline,
} from "../src/timeline/projection";
import { CREDIT_EXHAUSTION_MESSAGE } from "../src/lib/format";

function event(sequence: number, type: string, payload: unknown): SessionEvent {
  return {
    id: `allowance-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    turnId: "turn",
    sequence,
    type,
    payload,
    occurredAt: "2026-09-30T12:00:00Z",
  };
}
const refusal = {
  code: "allowance_exhausted",
  scope: "workspace",
  resetsAt: "2026-10-01T00:00:00Z",
  message: "PRIVATE wrapper says buy credits",
};

describe("allowance timeline presentation", () => {
  test.each(["workspace", "member"] as const)(
    "typed %s completion precedes generic budget exhaustion",
    (scope) => {
      const completed = event(2, "turn.completed", {
        ...refusal,
        scope,
        subjectId: "user:member",
        segmentLimit: "budget_exhausted",
      });
      const items = buildTimeline([
        event(1, "agent.message.completed", { messageId: "work", text: "Working" }),
        completed,
      ]);
      const serialized = JSON.stringify(items);
      const notice = items.find((item) => item.kind === "notice");
      // Plain-text consumers keep the canonical sentence; renderers use the
      // structured refusal, so a host can reword or replace the row.
      expect(notice?.kind === "notice" ? notice.text : "").toContain(
        scope === "workspace" ? "organization administrator" : "workspace administrator",
      );
      expect(notice?.kind === "notice" ? notice.allowance : undefined).toMatchObject({
        code: "allowance_exhausted",
        scope,
        resetsAt: "2026-10-01T00:00:00Z",
      });
      expect(serialized).toContain("2026-10-01 00:00 UTC");
      expect(serialized).not.toMatch(/buy credits|subscription/i);
      // The turn summary states the fact once; the notice row carries the remedy.
      expect(items.find((item) => item.kind === "turn-end")).toMatchObject({
        outcome: "failed",
        failureText: "Usage limit reached",
      });
      expect(creditExhaustedFromEvents([completed])).toBe(false);
      expect(
        groupTimeline(items, { readableTurns: true }).some(
          (group) => group.kind === "activity" && group.outcome === "failed",
        ),
      ).toBe(true);
    },
  );

  test("standalone usage exhaustion is visible and coalesces the paired completion or failure", () => {
    const exhausted = event(1, "usage.exhausted", refusal);
    expect(buildTimeline([exhausted]).filter((item) => item.kind === "notice")).toHaveLength(1);
    for (const type of ["turn.completed", "turn.failed"]) {
      const items = buildTimeline([
        exhausted,
        event(2, type, {
          ...refusal,
          segmentLimit: "budget_exhausted",
        }),
      ]);
      expect(items.filter((item) => item.kind === "notice")).toHaveLength(1);
      expect(items.find((item) => item.kind === "turn-end")).toMatchObject({ outcome: "failed" });
    }
  });

  test("non-recurring member refusal and malformed reset never become an add-credits state", () => {
    const member = event(1, "turn.failed", { ...refusal, scope: "member", resetsAt: null });
    expect(JSON.stringify(buildTimeline([member]))).toContain("no automatic reset");
    const malformed = event(2, "turn.completed", {
      ...refusal,
      resetsAt: "invalid",
      segmentLimit: "budget_exhausted",
    });
    expect(creditExhaustedFromEvents([malformed])).toBe(false);
    expect(JSON.stringify(buildTimeline([malformed]))).not.toContain(CREDIT_EXHAUSTION_MESSAGE);
  });

  test("human Retry preserves a later same-turn refusal instead of coalescing it with history", () => {
    const items = buildTimeline([
      event(1, "usage.exhausted", refusal),
      event(2, "turn.completed", { ...refusal, segmentLimit: "budget_exhausted" }),
      event(3, "turn.recovery.requested", { reason: "human_retry" }),
      event(4, "usage.exhausted", refusal),
      event(5, "turn.completed", { ...refusal, segmentLimit: "budget_exhausted" }),
    ]);
    expect(items.filter((item) => item.kind === "notice")).toHaveLength(2);
  });

  test("a queued prompt refused before it starts stays above the limit row", () => {
    const prompt: SessionEvent = {
      ...event(1, "user.message", {
        text: "Draft the checklist",
        routing: "queued_for_execution",
      }),
      turnId: null,
    };
    const items = buildTimeline([
      prompt,
      event(2, "turn.queued", { turnId: "turn", triggerEventId: prompt.id }),
      event(3, "usage.exhausted", { ...refusal, scope: "member" }),
      event(4, "turn.completed", { ...refusal, scope: "member", segmentLimit: "budget_exhausted" }),
    ]);
    const kinds = items.map((item) => item.kind);
    expect(kinds.indexOf("user-message")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("user-message")).toBeLessThan(kinds.indexOf("notice"));
  });

  test("ordinary insufficient credits retain their existing presentation", () => {
    const completed = event(1, "turn.completed", {
      detail: "insufficient OpenGeni credits",
      segmentLimit: "budget_exhausted",
    });
    expect(creditExhaustedFromEvents([completed])).toBe(true);
    expect(buildTimeline([completed]).find((item) => item.kind === "notice")).toMatchObject({
      text: CREDIT_EXHAUSTION_MESSAGE,
    });
  });
});
