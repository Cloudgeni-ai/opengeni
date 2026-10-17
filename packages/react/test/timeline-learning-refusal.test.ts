import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { LEARNING_REFUSAL_META_KEY } from "@opengeni/contracts/learning-refusal";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();
const skillId = "21a78814-7662-4252-b40a-b57971b244e7";
let sequence = 0;

function event(type: string, payload: unknown): SessionEvent {
  sequence += 1;
  return {
    id: `learning-refusal-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    turnId: "turn",
    sequence,
    type,
    payload,
    occurredAt: "2026-10-17T11:19:00Z",
  };
}

function refusedSave(id: string, fact: unknown) {
  return [
    event("agent.toolCall.created", { id, name: "skill_save", arguments: { skillId } }),
    event("agent.toolCall.output", {
      id,
      output: {
        isError: true,
        content: [{ type: "text", text: "Nothing was saved." }],
        _meta: { [LEARNING_REFUSAL_META_KEY]: fact },
      },
    }),
  ];
}

describe("learning refusal timeline notice", () => {
  test("a refused save is told to the person once per turn, outside the work row", () => {
    const fact = { destination: "skill", reason: "not_permitted", skillId } as const;
    const items = buildTimeline(englishText, [
      event("user.message", { text: "Always remember to pick the smaller model for grunt work" }),
      event("agent.toolCall.created", { id: "read", name: "skill_read", arguments: {} }),
      event("agent.toolCall.output", { id: "read", output: "Skill text" }),
      event("agent.message.completed", { text: "Updating the Skill.", phase: "commentary" }),
      ...refusedSave("call-1", fact),
      // The agent retried the same change: still one notice.
      ...refusedSave("call-2", fact),
      event("agent.message.completed", { text: "I'll let you know when it finishes." }),
      event("turn.completed", {}),
    ]);
    const notices = items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    if (notice.kind !== "notice") throw new Error("not a notice");
    expect(notice.tone).toBe("failed");
    expect(notice.learningRefusal).toEqual(fact);
    expect(notice.text).toContain("Not saved to Skills");
    expect(notice.text).toContain("isn't allowed to change this Skill");
    // Never folded away with the turn's work: it stays beside the answer,
    // whether settled turns fold into one row or not.
    for (const readableTurns of [false, true]) {
      const groups = groupTimeline(englishText, items, { readableTurns });
      expect(groups.some((group) => group.kind === "item" && group.item === notice)).toBe(true);
    }
    expect(
      groupTimeline(englishText, items, { readableTurns: false }).map((group) =>
        group.kind === "item" ? group.item.kind : group.kind,
      ),
    ).toEqual(["user-message", "turn", "notice", "agent-message"]);
  });

  test("different destinations each get their notice; ordinary failures get none", () => {
    const items = buildTimeline(englishText, [
      ...refusedSave("call-1", { destination: "skill", reason: "not_permitted", skillId }),
      event("agent.toolCall.created", { id: "call-2", name: "instruction_policy_save" }),
      event("agent.toolCall.output", {
        id: "call-2",
        output: {
          isError: true,
          content: [{ type: "text", text: "{}" }],
          _meta: {
            [LEARNING_REFUSAL_META_KEY]: { destination: "instruction", reason: "not_permitted" },
          },
        },
      }),
      event("agent.toolCall.created", { id: "call-3", name: "exec" }),
      event("agent.toolCall.output", {
        id: "call-3",
        output: { isError: true, content: [{ type: "text", text: "boom" }] },
      }),
    ]);
    const notices = items.filter((item) => item.kind === "notice");
    expect(notices.map((notice) => notice.kind === "notice" && notice.text)).toEqual([
      expect.stringContaining("Not saved to Skills"),
      expect.stringContaining("Not saved to workspace instructions"),
    ]);
  });
});
