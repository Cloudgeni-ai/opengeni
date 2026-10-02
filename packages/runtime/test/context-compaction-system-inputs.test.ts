import { describe, expect, test } from "bun:test";
import {
  renderUserMessageContentForModel,
  sessionSystemUpdateBatchHistoryItem,
  type SessionGoalSnapshot,
} from "@opengeni/contracts";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET,
  buildCompactionReplacementHistory,
  buildRemoteV2ReplacementHistory,
  buildSummaryItem,
  type CompactionItem,
} from "../src/context-compaction";

const capturedAt = "2026-08-01T10:00:00.000Z";
const goalId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const updateId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";

function goal(
  state: "active" | "paused" | "completed",
  objectiveRevision: number,
): SessionGoalSnapshot {
  return {
    state,
    goalId,
    objectiveRevision,
    text: "Inspect the revised synthetic task",
    successCriteria: "Return current evidence",
    rootConstraints: ["Do not mutate external state"],
    mutationPolicy: "review_changes",
    capturedAt,
  };
}

function acceptedBatch(snapshot?: SessionGoalSnapshot): CompactionItem {
  return sessionSystemUpdateBatchHistoryItem(
    [
      {
        id: updateId,
        kind: "agent_message",
        classification: "info",
        sourceId,
        summary: "Revised read-only task",
        payload: {
          type: "agent_message",
          text: "Inspect the new task; report the already completed observations accurately.",
          operationId,
        },
        lineage: {},
        createdAt: capturedAt,
      },
    ],
    snapshot,
    { deliveredAt: capturedAt },
  );
}

const checkpoint = { type: "compaction", encrypted_content: "synthetic-checkpoint" };

for (const mode of ["portable", "remote_v2"] as const) {
  const rebuild = (
    items: CompactionItem[],
    retainedItemTokens?: (item: CompactionItem) => number,
  ): CompactionItem[] =>
    mode === "portable"
      ? buildCompactionReplacementHistory(items, "Synthetic checkpoint", retainedItemTokens)
      : buildRemoteV2ReplacementHistory(items, checkpoint, retainedItemTokens);

  describe(`${mode} system-input retention`, () => {
    for (const state of ["active", "paused", "completed"] as const) {
      test(`retains the exact ${state} accepted goal and agent-message batch after older user intent`, () => {
        const historicalUser: CompactionItem = {
          type: "message",
          role: "user",
          content: renderUserMessageContentForModel(
            "Earlier task",
            [],
            undefined,
            goal("active", 2),
          ),
        };
        const current = acceptedBatch(goal(state, 5));
        const original = [historicalUser, current];
        const before = structuredClone(original);

        const replacement = rebuild(original);

        expect(replacement.slice(0, -1)).toEqual(original);
        expect(replacement[1]).toEqual(current);
        expect(replacement[1]?.role).toBe("system");
        expect(replacement[1]?.content).toContain(`objective revision 5; status ${state}`);
        expect(replacement[1]?.content).toContain("Do not mutate external state");
        expect(replacement[1]?.content).toContain(updateId);
        expect(replacement[1]?.content).toContain(operationId);
        expect(original).toEqual(before);
      });
    }

    test("keeps an agent-message turn without a standing goal and preserves its role", () => {
      const current = acceptedBatch({ state: "none", capturedAt });
      const replacement = rebuild([current]);
      expect(replacement.slice(0, -1)).toEqual([current]);
      expect(replacement[0]?.role).toBe("system");
    });

    test("shares the existing retention budget and prioritizes the newest system input", () => {
      const budget =
        mode === "portable"
          ? COMPACT_USER_MESSAGE_MAX_TOKENS
          : REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET;
      const older: CompactionItem = { type: "message", role: "user", content: "Old task" };
      const newest: CompactionItem = { type: "message", role: "system", content: "New task" };
      const replacement = rebuild([older, newest], (item) => (item === older ? budget : 10));
      expect(replacement.slice(0, -1)).toEqual([newest]);
    });

    test("repeated compaction retains each message once without tool replay or old summaries", () => {
      const current = acceptedBatch(goal("active", 5));
      const original: CompactionItem[] = [
        buildSummaryItem("Earlier checkpoint"),
        current,
        { type: "function_call", callId: "synthetic-call", name: "inspect", arguments: "{}" },
        { type: "function_call_result", callId: "synthetic-call", output: "Completed evidence" },
        { type: "message", role: "assistant", content: "The observation completed" },
      ];
      const before = structuredClone(original);
      const first = rebuild(original);
      const second = rebuild(first);
      expect(first.slice(0, -1)).toEqual([current]);
      expect(second.slice(0, -1)).toEqual([current]);
      expect(second.filter((item) => item.role === "system")).toHaveLength(1);
      expect(original).toEqual(before);
    });
  });
}
