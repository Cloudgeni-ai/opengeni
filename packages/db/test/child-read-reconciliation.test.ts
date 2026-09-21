import { describe, expect, test } from "bun:test";
import {
  historicalChildReadItems,
  historicalChildReadMatches,
} from "../src/child-read-reconciliation";

const sessionId = "e7bca8ed-21ec-49f0-b872-6d525467d47d";
const source = {
  id: crypto.randomUUID(),
  sequence: 2141,
  type: "turn.completed",
  payload: { output: "Exact final answer" },
};
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
describe("conservative historical consumption evidence", () => {
  test("retained whole result text matches the exact source, not a status or high-water cursor", () => {
    const items = historicalChildReadItems(
      "opengeni__session_events",
      JSON.stringify({ sessionId }),
      mcp({
        view: "results",
        sourceExact: true,
        nextAfter: 2148,
        events: [{ sequence: 2141, type: "turn.completed", text: "Exact final answer" }],
      }),
    );
    expect(items).toHaveLength(1);
    expect(historicalChildReadMatches(items[0]!, source)).toBe(true);
    expect(
      historicalChildReadMatches(items[0]!, {
        ...source,
        payload: { output: "Unseen new answer" },
      }),
    ).toBe(false);
    expect(historicalChildReadMatches(items[0]!, { ...source, sequence: 2148 })).toBe(false);
  });
  test("full debug proof requires equal payload and identity", () => {
    const [item] = historicalChildReadItems(
      "opengeni__session_events",
      { sessionId },
      {
        payloadMode: "full",
        truncated: false,
        events: [source],
      },
    );
    expect(historicalChildReadMatches(item!, source)).toBe(true);
    expect(historicalChildReadMatches(item!, { ...source, id: crypto.randomUUID() })).toBe(false);
  });
  test("old waits may prove a complete exact answer, never omitted actionable content", () => {
    const [item] = historicalChildReadItems(
      "opengeni__session_wait",
      { targets: [{ sessionId, afterSequence: 0 }] },
      {
        truncated: false,
        changed: [
          { sessionId, latestSequence: 2148, events: [{ ...source, text: "Exact final answer" }] },
        ],
      },
    );
    expect(historicalChildReadMatches(item!, source)).toBe(true);
    expect(
      historicalChildReadMatches(
        { ...item!, item: { sequence: 2141 } },
        { ...source, type: "session.humanInput.requested", payload: { questions: ["Choose"] } },
      ),
    ).toBe(false);
  });
  test("unknown identities, fragments, errors and explicit loss are unsupported", () => {
    const page = {
      view: "results",
      sourceExact: true,
      events: [{ sequence: 2141, text: "answer" }],
    };
    expect(historicalChildReadItems("other__session_events", { sessionId }, page)).toEqual([]);
    expect(
      historicalChildReadItems("opengeni__session_get", { sessionId }, { lastSequence: 2148 }),
    ).toEqual([]);
    for (const output of [
      { ...page, sourceExact: false },
      { ...page, truncated: true },
      { ...page, events: [{ sequence: 2141, fragment: { offset: 100, complete: true } }] },
      { ...mcp(page), isError: true },
      "invalid JSON",
    ]) {
      expect(historicalChildReadItems("opengeni__session_events", { sessionId }, output)).toEqual(
        [],
      );
    }
  });
});
