import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  fingerprint,
  hostileGraph,
  isStrictJson,
} from "../../../packages/contracts/test/hostile-values";
import {
  completedToolCallFromSdkEvent,
  historyRowsToAppend,
  pendingToolCallFromSdkEvent,
} from "../src/activities/agent-turn/history";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";

/**
 * The worker's history and tool-receipt boundaries store what a turn
 * produced. A value JSON cannot carry must never fail the turn there: it is
 * stored converted, and the next turn identifies the stored item exactly as
 * this turn did, so the history guard never sees a changed prefix.
 */
describe("worker protocol JSON boundaries with hostile values", () => {
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const seeds = Array.from({ length: 80 }, (_, index) => index * 613 + 11);

  const hostileItems = (seed: number) => {
    const graphs = [hostileGraph(seed), hostileGraph(seed + 1), hostileGraph(seed + 2)];
    // The history sanitizer reads named providerData fields of each item;
    // the hostile values are the provider detail beneath them.
    const items: Array<Record<string, unknown>> = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Can you check where we run the Claude models?" }],
        [Symbol("request mark")]: "runtime",
      },
      {
        type: "hosted_tool_call",
        id: `srvtoolu_${seed}`,
        name: "web_search_call",
        status: "completed",
        providerData: { type: "web_search_call", detail: graphs[0]!.value },
        [Symbol("search record form")]: "runtime",
      },
      {
        type: "function_call",
        callId: `call-${seed}`,
        name: "tool",
        arguments: "{}",
        providerData: { detail: graphs[1]!.value },
      },
      {
        type: "function_call_result",
        callId: `call-${seed}`,
        name: "tool",
        status: "completed",
        output: { type: "text", text: "done" },
        providerData: { detail: graphs[2]!.value },
      },
    ];
    return { items, graphs };
  };

  test("history rows are stored as JSON and the next turn's guard accepts them", () => {
    for (const seed of seeds) {
      const { items, graphs } = hostileItems(seed);
      const before = fingerprint(items);
      const { rows } = historyRowsToAppend(items, 0);
      expect(rows.length).toBe(items.length);
      for (const row of rows) expect(isStrictJson(row.item)).toBe(true);
      // This turn seeds its guard from the live items; the next turn verifies
      // what storage returns for them.
      const guard = new HistoryPrefixGuard();
      guard.seed(items, items.length);
      const stored = rows.map((row) => JSON.parse(JSON.stringify(row.item)));
      expect(() => guard.verify(stored)).not.toThrow();
      expect(fingerprint(items)).toBe(before);
      for (const graph of graphs) expect(graph.getterCalls()).toBe(0);
    }
  });

  test("pending and completed tool-call receipts", () => {
    for (const seed of seeds) {
      const graph = hostileGraph(seed);
      const pending = pendingToolCallFromSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_call_item",
          rawItem: {
            type: "function_call",
            callId: `call-${seed}`,
            name: "tool",
            arguments: "{}",
            providerData: graph.value,
          },
        },
      });
      expect(pending?.callId).toBe(`call-${seed}`);
      expect(isStrictJson(pending?.callItem)).toBe(true);

      const completed = completedToolCallFromSdkEvent({
        type: "run_item_stream_event",
        item: {
          type: "tool_call_output_item",
          rawItem: {
            type: "function_call_result",
            callId: `call-${seed}`,
            output: graph.value,
            [Symbol("mark")]: true,
          },
        },
      });
      expect(completed?.callId).toBe(`call-${seed}`);
      expect(isStrictJson(completed?.resultItem)).toBe(true);
      expect(graph.getterCalls()).toBe(0);
    }
  });
});
