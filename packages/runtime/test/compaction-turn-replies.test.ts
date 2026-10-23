import { describe, expect, test } from "bun:test";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET,
  RETAINED_REPLY_MAX_TOKENS,
  USER_MESSAGE_TRUNCATION_MARKER,
  buildCompactionReplacement,
  buildCompactionReplacementHistory,
  buildRemoteV2Replacement,
  buildRemoteV2ReplacementHistory,
  estimateTextTokens,
  isCompactionSummary,
  type CompactionItem,
  type CompactionTurnContext,
} from "../src/context-compaction";
import { RETAINED_REPLY_TURN_FIELD, sanitizeHistoryItemsForModel } from "../src/history-sanitizer";

// Turn ids as the worker reads them from session_history_items.turn_id.
const T0 = "00000000-0000-4000-8000-000000000a00";
const T1 = "00000000-0000-4000-8000-000000000a01";
const T2 = "00000000-0000-4000-8000-000000000a02";
const T3 = "00000000-0000-4000-8000-000000000a03";

const BLOB: CompactionItem = { type: "compaction", encrypted_content: "blob" };

function user(text: string): CompactionItem {
  return { type: "message", role: "user", content: text };
}

function assistant(text: string, phase?: "commentary" | "final_answer"): CompactionItem {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    ...(phase ? { phase } : {}),
    content: [{ type: "output_text", text }],
  };
}

function updates(text: string): CompactionItem {
  return { type: "message", role: "system", content: `[Opengeni internal updates]\n${text}` };
}

function call(id: string): CompactionItem {
  return { type: "function_call", callId: id, name: "shell", arguments: "{}" };
}

function result(id: string): CompactionItem {
  return { type: "function_call_result", callId: id, status: "completed", output: "ok" };
}

function itemText(item: CompactionItem): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
}

/** Persisted rows: each item with the turn that wrote it. */
function rows(entries: ReadonlyArray<[string | null, CompactionItem]>): {
  items: CompactionItem[];
  itemTurnIds: (string | null)[];
} {
  return {
    items: entries.map(([, item]) => item),
    itemTurnIds: entries.map(([turnId]) => turnId),
  };
}

type Mode = "portable" | "remote v2";
const MODES: readonly Mode[] = ["portable", "remote v2"];

/** The model-visible rebuild through the long-standing builders (turns as the last argument). */
function rebuildHistory(
  mode: Mode,
  items: CompactionItem[],
  turns?: CompactionTurnContext,
): CompactionItem[] {
  return mode === "portable"
    ? buildCompactionReplacementHistory(items, "SUMMARY", undefined, undefined, undefined, turns)
    : buildRemoteV2ReplacementHistory(items, BLOB, undefined, undefined, turns);
}

function rebuild(mode: Mode, items: CompactionItem[], turns?: CompactionTurnContext) {
  return mode === "portable"
    ? buildCompactionReplacement(items, "SUMMARY", undefined, undefined, undefined, turns)
    : buildRemoteV2Replacement(items, BLOB, undefined, undefined, turns);
}

function shape(history: CompactionItem[]): string[] {
  return history.map((item) => {
    if (item.type === "compaction" || isCompactionSummary(item)) return "<checkpoint>";
    return `${String(item.role)}: ${itemText(item).replace("[Opengeni internal updates]\n", "")}`;
  });
}

describe("compaction pairs a retained request only with its own turn's reply", () => {
  for (const mode of MODES) {
    test(`${mode}: a finished person turn followed by machine-only turns keeps its answer (layout E)`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("what did we decide about the cache key?")],
        [T1, assistant("I'll look it up.", "commentary")],
        [T1, call("c1")],
        [T1, result("c1")],
        [
          T1,
          {
            ...assistant("We kept one key per session.", "final_answer"),
            id: "msg_provider_1",
            providerData: { opaque: true },
          },
        ],
        [T2, updates("a worker finished")],
        [T2, assistant("Noted.")],
        [T3, updates("ci is green")],
        [T3, call("c2")],
      ]);
      const history = rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T3 });
      expect(shape(history)).toEqual([
        "user: what did we decide about the cache key?",
        "assistant: We kept one key per session.",
        "system: a worker finished",
        "system: ci is green",
        "<checkpoint>",
      ]);
      // Only the text survives: no provider ids or provider data of the dropped
      // response. The copy records its turn for later compactions; the model
      // wire never sees that field.
      const reply = {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "We kept one key per session." }],
      };
      expect(history[1]).toEqual({ ...reply, [RETAINED_REPLY_TURN_FIELD]: T1 });
      const wire = sanitizeHistoryItemsForModel(history);
      expect(wire[1]).toEqual(reply);
      expect(JSON.stringify(wire)).not.toContain(RETAINED_REPLY_TURN_FIELD);
    });

    test(`${mode}: the running turn's request stays open after updates arrive mid-turn (layout A)`, () => {
      // An approval or human-input answer resumed T2 and delivered pending
      // updates into the same turn, after its mid-turn assistant text.
      const { items, itemTurnIds } = rows([
        [T1, user("old")],
        [T1, assistant("old answer", "final_answer")],
        [T2, user("Run the migration")],
        [T2, assistant("Migration applied to staging.")],
        [T2, call("c1")],
        [T2, result("c1")],
        [T2, updates("approval granted")],
        [T2, call("c2")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }))).toEqual([
        "user: old",
        "assistant: old answer",
        "user: Run the migration",
        "system: approval granted",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: a human turn that coalesced updates before its reply keeps that reply (layout B)`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("what is the cache key?")],
        [T1, updates("ci is green")],
        [T1, assistant("One key per session.", "final_answer")],
        [T2, user("next question")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }))).toEqual([
        "user: what is the cache key?",
        "assistant: One key per session.",
        "system: ci is green",
        "user: next question",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: a reply is retained once, after the turn's last request`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("first ask")],
        [T1, user("also check the logs")],
        [T1, assistant("Both done.", "final_answer")],
        [T2, user("thanks")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }))).toEqual([
        "user: first ask",
        "user: also check the logs",
        "assistant: Both done.",
        "user: thanks",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: a reply from another turn is never borrowed`, () => {
      // T1 gave no answer (for example it was superseded); T2's reply stays with T2.
      const { items, itemTurnIds } = rows([
        [T1, user("do A")],
        [T2, user("actually do B")],
        [T2, assistant("Did B.", "final_answer")],
        [T3, user("next")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T3 }))).toEqual([
        "user: do A",
        "user: actually do B",
        "assistant: Did B.",
        "user: next",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: without known turn ids no reply is kept (legacy rows)`, () => {
      const entries: Array<[string | null, CompactionItem]> = [
        [null, user("what is the cache key?")],
        [null, assistant("One key per session.", "final_answer")],
        [null, updates("later")],
      ];
      const { items, itemTurnIds } = rows(entries);
      const expected = ["user: what is the cache key?", "system: later", "<checkpoint>"];
      expect(shape(rebuildHistory(mode, items))).toEqual(expected);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T3 }))).toEqual(
        expected,
      );
      // A known reply is not attached to a request whose own turn is unknown.
      const mixed = rows([
        [null, user("what is the cache key?")],
        [T1, assistant("One key per session.", "final_answer")],
        [T2, updates("later")],
      ]);
      expect(shape(rebuildHistory(mode, mixed.items, { ...mixed, activeTurnId: T2 }))).toEqual(
        expected,
      );
    });

    test(`${mode}: retained replies overshoot the retained budget by at most one bounded reply (layout D)`, () => {
      const budget =
        mode === "portable"
          ? COMPACT_USER_MESSAGE_MAX_TOKENS
          : REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET;
      const entries: Array<[string | null, CompactionItem]> = [];
      const turns: string[] = [];
      for (let index = 0; index < 60; index += 1) {
        const turnId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        turns.push(turnId);
        entries.push([turnId, user(`q${index} ${"x".repeat(1_700 * 4)}`)]);
        entries.push([turnId, assistant(`a${index} ${"y".repeat(3_000 * 4)} end${index}`)]);
      }
      const { items, itemTurnIds } = rows(entries);
      const { history, turnIds } = rebuild(mode, items, { itemTurnIds, activeTurnId: T3 });
      const retained = history.filter(
        (item) => item.type === "message" && !isCompactionSummary(item),
      );
      const replies = retained.filter((item) => item.role === "assistant");
      expect(replies.length).toBeGreaterThan(0);
      for (const reply of replies) {
        expect(estimateTextTokens(itemText(reply))).toBeLessThanOrEqual(RETAINED_REPLY_MAX_TOKENS);
        expect(itemText(reply)).toContain(USER_MESSAGE_TRUNCATION_MARKER.trim());
      }
      const total = retained.reduce((sum, item) => sum + estimateTextTokens(itemText(item)), 0);
      expect(total).toBeLessThanOrEqual(budget + RETAINED_REPLY_MAX_TOKENS);
      // Every retained request is directly followed by its own turn's reply.
      for (let index = 0; index < history.length; index += 1) {
        if (history[index]!.role !== "user" || isCompactionSummary(history[index])) continue;
        const number = /^q(\d+) /.exec(itemText(history[index]!))![1];
        expect(itemText(history[index + 1]!)).toEndWith(` end${number}`);
        // The copy's row has no turn id; the copy records its turn instead.
        expect(turnIds[index + 1]).toBeNull();
        expect(history[index + 1]![RETAINED_REPLY_TURN_FIELD]).toBe(turnIds[index]!);
        expect(turnIds[index]).toBe(turns[Number(number)]!);
      }
    });

    test(`${mode}: a request that fills the whole budget still keeps a bounded reply`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("q".repeat(90_000 * 4))],
        [T1, assistant("r".repeat(40_000))],
        [T2, updates("later")],
      ]);
      const history = rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 });
      const reply = history.find((item) => item.role === "assistant");
      expect(reply).toBeDefined();
      expect(estimateTextTokens(itemText(reply!))).toBeLessThanOrEqual(RETAINED_REPLY_MAX_TOKENS);
    });

    test(`${mode}: a request made after its turn's reply is not paired with that earlier reply`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("first ask")],
        [T1, assistant("First answer.", "final_answer")],
        [T1, user("a follow-up the turn never answered")],
        [T2, user("next")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }))).toEqual([
        "user: first ask",
        "assistant: First answer.",
        "user: a follow-up the turn never answered",
        "user: next",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: a recorded reply copy pairs only with a request of its own turn`, () => {
      const copy = (turnId: string, text: string): CompactionItem => ({
        ...assistant(text, "final_answer"),
        [RETAINED_REPLY_TURN_FIELD]: turnId,
      });
      const { items, itemTurnIds } = rows([
        [T0, user("set up staging")],
        [null, copy(T0, "Staging is up.")],
        [T1, user("deploy the fix")],
        // A copy recorded for another turn is not borrowed by T1.
        [null, copy(T0, "Unrelated copy.")],
        [T2, user("status?")],
      ]);
      expect(shape(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }))).toEqual([
        "user: set up staging",
        "assistant: Unrelated copy.",
        "user: deploy the fix",
        "user: status?",
        "<checkpoint>",
      ]);
    });

    test(`${mode}: turn ids align with the rebuilt history`, () => {
      const { items, itemTurnIds } = rows([
        [T1, user("ask")],
        [T1, assistant("answer", "final_answer")],
        [T2, updates("child finished")],
        [T2, call("c1")],
      ]);
      const { history, turnIds } = rebuild(mode, items, { itemTurnIds, activeTurnId: T2 });
      expect(history).toEqual(rebuildHistory(mode, items, { itemTurnIds, activeTurnId: T2 }));
      expect(turnIds).toEqual([T1, null, T2, null]);
      expect(history[1]![RETAINED_REPLY_TURN_FIELD]).toBe(T1);
    });
  }

  test("repeated compactions keep each request paired with its own reply", () => {
    // Compaction 1 runs inside T1: T0 is finished, T1's request is still open.
    const first = rows([
      [T0, user("set up staging")],
      [T0, assistant("Staging is up.", "final_answer")],
      [T1, user("deploy the fix")],
      [T1, assistant("Deploying now.", "commentary")],
      [T1, call("c1")],
      [T1, result("c1")],
    ]);
    const one = buildCompactionReplacement(first.items, "S1", undefined, undefined, undefined, {
      itemTurnIds: first.itemTurnIds,
      activeTurnId: T1,
    });
    expect(shape(one.history)).toEqual([
      "user: set up staging",
      "assistant: Staging is up.",
      "user: deploy the fix",
      "<checkpoint>",
    ]);
    // The database stores the summary row under the compacting turn.
    const persistedOne = one.turnIds.map((turnId, index) =>
      isCompactionSummary(one.history[index]) ? T1 : turnId,
    );
    expect(persistedOne).toEqual([T0, null, T1, T1]);

    // T1 finishes after the checkpoint, then T2 starts and compacts again.
    const secondItems = [
      ...one.history,
      assistant("Deployed to staging.", "final_answer"),
      user("and production?"),
      assistant("Checking the release window.", "commentary"),
    ];
    const secondTurnIds = [...persistedOne, T1, T2, T2];
    const two = buildCompactionReplacement(secondItems, "S2", undefined, undefined, undefined, {
      itemTurnIds: secondTurnIds,
      activeTurnId: T2,
    });
    expect(shape(two.history)).toEqual([
      "user: set up staging",
      "assistant: Staging is up.",
      "user: deploy the fix",
      "assistant: Deployed to staging.",
      "user: and production?",
      "<checkpoint>",
    ]);
    expect(two.turnIds).toEqual([T0, null, T1, null, T2, null]);
    expect(two.history.map((item) => item[RETAINED_REPLY_TURN_FIELD] ?? null)).toEqual([
      null,
      T0,
      null,
      T1,
      null,
      null,
    ]);

    // A third compaction (remote v2) in a later turn still keeps both pairs once.
    const thirdItems = [...two.history, user("status?")];
    const thirdTurnIds = [...two.turnIds.slice(0, -1), T2, T3];
    const three = buildRemoteV2Replacement(thirdItems, BLOB, undefined, undefined, {
      itemTurnIds: thirdTurnIds,
      activeTurnId: T3,
    });
    expect(shape(three.history)).toEqual([
      "user: set up staging",
      "assistant: Staging is up.",
      "user: deploy the fix",
      "assistant: Deployed to staging.",
      "user: and production?",
      "user: status?",
      "<checkpoint>",
    ]);
    expect(three.turnIds).toEqual([T0, null, T1, null, T2, T3, null]);
  });
});
