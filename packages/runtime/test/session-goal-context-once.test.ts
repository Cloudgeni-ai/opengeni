import { describe, expect, test } from "bun:test";
import {
  SESSION_GOAL_CONTEXT_LABEL,
  collapseRepeatedSessionGoalContexts,
  expandUnchangedSessionGoalContexts,
  isTransientSessionSystemUpdateBatch,
  renderSessionGoalContext,
  renderUserMessageContentForModel,
  sessionSystemUpdateBatchHistoryItem,
  type SessionGoalSnapshot,
  type SessionSystemUpdateKind,
} from "@opengeni/contracts";
import {
  buildCompactionReplacementHistory,
  buildRemoteV2ReplacementHistory,
  type CompactionItem,
} from "../src/context-compaction";
import { projectHistoryForProvider } from "../src/provider-history-adapter";

const capturedAt = "2026-08-01T10:00:00.000Z";
const goalId = "11111111-1111-4111-8111-111111111111";

function goal(
  objectiveRevision: number,
  state: "active" | "paused" | "completed" = "active",
): SessionGoalSnapshot {
  return {
    state,
    goalId,
    objectiveRevision,
    text: `Synthetic long-running objective, revision ${objectiveRevision}. ${"Detail. ".repeat(200)}`,
    successCriteria: "Return current evidence",
    rootConstraints: ["Do not mutate external state"],
    mutationPolicy: "preserve_intent",
    capturedAt,
  };
}

function user(text: string, snapshot?: SessionGoalSnapshot): CompactionItem {
  return {
    type: "message",
    role: "user",
    content: renderUserMessageContentForModel(text, [], undefined, snapshot, capturedAt),
  };
}

let updateCounter = 0;
function batch(kind: SessionSystemUpdateKind, snapshot?: SessionGoalSnapshot): CompactionItem {
  updateCounter += 1;
  const id = `33333333-3333-4333-8333-${String(updateCounter).padStart(12, "0")}`;
  return sessionSystemUpdateBatchHistoryItem(
    [
      {
        id,
        kind,
        classification: "info",
        sourceId: id,
        summary: `${kind} ${updateCounter}`,
        payload:
          kind === "agent_message"
            ? {
                type: "agent_message",
                text: "Please also check the docs.",
                operationId: id,
              }
            : { type: kind },
        lineage: {},
        createdAt: capturedAt,
      },
    ] as Parameters<typeof sessionSystemUpdateBatchHistoryItem>[0],
    snapshot,
    { deliveredAt: capturedAt },
  );
}

const assistant = (text: string): CompactionItem => ({
  type: "message",
  role: "assistant",
  content: text,
});

function goalBlockCount(items: readonly CompactionItem[], snapshot: SessionGoalSnapshot): number {
  const full = renderSessionGoalContext(snapshot)!;
  return items.filter((item) => JSON.stringify(item).includes(JSON.stringify(full).slice(1, -1)))
    .length;
}

describe("session goal context is sent once per distinct goal", () => {
  test("identical goal contexts collapse to a one-line stand-in; changes render in full", () => {
    const g1 = goal(1);
    const g2 = goal(2);
    const items = [
      user("First", g1),
      assistant("ok"),
      user("Second", g1),
      batch("background_command_result", g1),
      user("Third", g2),
      user("Fourth", goal(2, "paused")),
    ];
    const before = structuredClone(items);
    const collapsed = collapseRepeatedSessionGoalContexts(items);
    expect(items).toEqual(before);
    expect(goalBlockCount(collapsed, g1)).toBe(1);
    expect(goalBlockCount(collapsed, g2)).toBe(1);
    expect(goalBlockCount(collapsed, goal(2, "paused"))).toBe(1);
    expect(collapsed[0]).toBe(items[0]);
    const second = JSON.stringify(collapsed[2]);
    expect(second).toContain(
      "Standing session goal unchanged: identical to the full goal text shown earlier (objective revision 1; status active).",
    );
    expect(second).toContain("Second");
    const batchContent = collapsed[3]!.content as string;
    expect(batchContent).toStartWith(
      `${SESSION_GOAL_CONTEXT_LABEL}\nStanding session goal unchanged: identical to the full goal text shown earlier (objective revision 1; status active).\n\n[Opengeni internal updates]\n`,
    );
    const goalChars = renderSessionGoalContext(g1)!.length;
    expect(JSON.stringify(collapsed).length).toBeLessThan(
      JSON.stringify(items).length - 1.8 * goalChars,
    );
    // Request-prefix stability: appending never rewrites earlier projected items.
    const appended = collapseRepeatedSessionGoalContexts([...items, user("Fifth", g2)]);
    expect(appended.slice(0, collapsed.length)).toEqual(collapsed);
    // Idempotent and reversible.
    expect(collapseRepeatedSessionGoalContexts(collapsed)).toEqual(collapsed);
    expect(expandUnchangedSessionGoalContexts(collapsed)).toEqual(items);
  });

  test("a stand-in without its full context earlier in the list is left untouched", () => {
    const collapsed = collapseRepeatedSessionGoalContexts([user("a", goal(1)), user("b", goal(1))]);
    expect(collapseRepeatedSessionGoalContexts([collapsed[1]!])).toEqual([collapsed[1]!]);
    expect(expandUnchangedSessionGoalContexts([collapsed[1]!])).toEqual([collapsed[1]!]);
  });

  test("every provider projection sends the goal once", () => {
    const g = goal(4);
    const items = [
      user("one", g),
      assistant("ok"),
      user("two", g),
      assistant("ok"),
      user("three", g),
    ];
    for (const api of ["responses", "chat", "anthropic-messages"] as const) {
      const projected = projectHistoryForProvider(items, api);
      expect(goalBlockCount(projected, g)).toBe(1);
      expect(JSON.stringify(projected)).toContain("three");
    }
  });

  test("classifies only status-only machine batches as transient", () => {
    expect(isTransientSessionSystemUpdateBatch(batch("background_command_result", goal(1)))).toBe(
      true,
    );
    expect(isTransientSessionSystemUpdateBatch(batch("session_wait_timeout"))).toBe(true);
    expect(isTransientSessionSystemUpdateBatch(batch("agent_message", goal(1)))).toBe(false);
    expect(isTransientSessionSystemUpdateBatch(batch("child_terminal_result"))).toBe(false);
    expect(isTransientSessionSystemUpdateBatch(user("hi", goal(1)))).toBe(false);
  });

  for (const mode of ["portable", "remote_v2"] as const) {
    const rebuild = (items: CompactionItem[]): CompactionItem[] =>
      mode === "portable"
        ? buildCompactionReplacementHistory(items, "Synthetic checkpoint")
        : buildRemoteV2ReplacementHistory(items, {
            type: "compaction",
            encrypted_content: "synthetic-checkpoint",
          });

    test(`${mode} compaction keeps one full goal, drops answered status batches, keeps real input`, () => {
      const g = goal(7);
      const items: CompactionItem[] = [];
      for (let index = 0; index < 12; index += 1) {
        items.push(user(`Human request ${index}`, g));
        items.push(assistant("working"));
        items.push(batch("background_command_result", g));
        items.push(assistant("noted"));
      }
      items.push(batch("agent_message", g));
      items.push(assistant("ack"));
      const current = batch("session_wait_timeout", g);
      items.push(current);

      const replacement = rebuild(items);
      const retained = replacement.filter((item) => item.role === "user" || item.role === "system");
      const text = JSON.stringify(retained);
      expect(goalBlockCount(retained, g)).toBe(1);
      for (let index = 0; index < 12; index += 1) expect(text).toContain(`Human request ${index}`);
      expect(text).toContain("Please also check the docs.");
      expect(text).not.toContain("background_command_result");
      // The newest input is always retained, even when transient.
      expect(text).toContain("session_wait_timeout");
      // The first retained goal-bearing message carries the goal in full.
      const firstGoal = retained.find((item) =>
        JSON.stringify(item).includes(SESSION_GOAL_CONTEXT_LABEL),
      );
      expect(JSON.stringify(firstGoal)).toContain("Synthetic long-running objective, revision 7");

      // Compacting again (from collapsed history) keeps a full goal context.
      const again = rebuild([...replacement, user("Later request", g)]);
      expect(goalBlockCount(again, g)).toBe(1);
    });

    test(`${mode} compaction restores the goal in full when its first copy falls out of the window`, () => {
      const g = goal(9);
      const collapsedHistory = collapseRepeatedSessionGoalContexts([
        user("Old request with a very long body " + "x".repeat(400_000), g),
        assistant("ok"),
        user("Recent request", g),
      ]);
      const replacement = rebuild(collapsedHistory);
      const retained = replacement.filter((item) => item.role === "user");
      expect(JSON.stringify(retained)).toContain("Recent request");
      // The stand-in on the recent request must not be left dangling: the goal
      // is present in full in the retained window.
      expect(goalBlockCount(retained, g)).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(expandUnchangedSessionGoalContexts(retained))).not.toContain(
        "Standing session goal unchanged: identical to the full goal text shown earlier",
      );
    });
  }
});
