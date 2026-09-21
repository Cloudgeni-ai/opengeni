import { describe, expect, test } from "bun:test";
import { sessionSystemUpdateBatchHistoryItem } from "@opengeni/contracts";
import {
  LOSSLESS_CONTENT_CODEC_VERSION,
  LOSSLESS_JSON_STRING_PREFIX,
  toPostgresLosslessJson,
  fromPostgresLosslessJson,
} from "../src/lossless-json";
import {
  boundedChildLifecycleEvidence,
  logicalChildReadEvent,
  historicalChildReadItems,
  historicalChildReadMatches,
} from "../src/child-read-reconciliation";

const sessionId = "e7bca8ed-21ec-49f0-b872-6d525467d47d";
const markerLiteral = toPostgresLosslessJson("literal\u0000marker") as string;
const source = {
  id: crypto.randomUUID(),
  sequence: 2141,
  type: "turn.completed",
  payload: { output: "Exact final answer" },
};
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
describe("conservative historical consumption evidence", () => {
  test.each([
    ["NUL", "Answer\u0000tail", LOSSLESS_CONTENT_CODEC_VERSION],
    ["lone surrogate", "Answer\ud800tail", LOSSLESS_CONTENT_CODEC_VERSION],
    ["literal marker", markerLiteral, LOSSLESS_CONTENT_CODEC_VERSION],
    ["null-version literal marker", markerLiteral, null],
  ] as const)(
    "%s survives source, outbox, update and model history as logical content",
    (_label, answer, codecVersion) => {
      const rawPayload =
        codecVersion === null ? { output: answer } : toPostgresLosslessJson({ output: answer });
      const row = { ...source, payload: rawPayload, payloadCodecVersion: codecVersion };
      const evidence = boundedChildLifecycleEvidence([row]);
      expect(evidence).toEqual([
        { sequence: source.sequence, type: source.type, payload: { output: answer } },
      ]);
      expect(evidence[0]).not.toHaveProperty("payloadCodecVersion");
      const logicalPayload = {
        type: "child_terminal_result" as const,
        childSessionId: sessionId,
        status: "idle" as const,
        childEventEvidence: evidence,
      };
      // Both durable envelopes have their OWN version. A source version may never
      // leak into these envelopes and cause a second decode of literal text.
      const outbox = fromPostgresLosslessJson(
        toPostgresLosslessJson(logicalPayload),
        LOSSLESS_CONTENT_CODEC_VERSION,
      );
      const update = fromPostgresLosslessJson(
        toPostgresLosslessJson(outbox),
        LOSSLESS_CONTENT_CODEC_VERSION,
      );
      const history = sessionSystemUpdateBatchHistoryItem([
        {
          id: crypto.randomUUID(),
          kind: "child_terminal_result",
          classification: "success",
          sourceId: sessionId,
          summary: "Child finished",
          payload: update as typeof logicalPayload,
          lineage: {},
        },
      ]);
      const rendered = JSON.parse(history.content.slice(history.content.indexOf("{")));
      expect(rendered.updates[0].payload.childEventEvidence[0].payload.output).toBe(answer);
      const logicalSource = logicalChildReadEvent(row);
      const callPayload = {
        name: "opengeni__session_events",
        arguments: { sessionId },
        note: answer,
      };
      const rawCall = {
        payload: codecVersion === null ? callPayload : toPostgresLosslessJson(callPayload),
        payloadCodecVersion: codecVersion,
      };
      const call = logicalChildReadEvent(rawCall).payload as {
        name: string;
        arguments: unknown;
        note: string;
      };
      expect(call.note).toBe(answer);
      const receipt = {
        view: "results",
        sourceExact: true,
        events: [{ sequence: source.sequence, type: source.type, text: answer }],
      };
      const rawOutput = {
        payload:
          codecVersion === null ? { output: receipt } : toPostgresLosslessJson({ output: receipt }),
        payloadCodecVersion: codecVersion,
      };
      const output = logicalChildReadEvent(rawOutput).payload as { output: unknown };
      const [item] = historicalChildReadItems(call.name, call.arguments, output.output);
      expect(historicalChildReadMatches(item!, logicalSource)).toBe(true);
      if (codecVersion !== null) expect(historicalChildReadMatches(item!, row)).toBe(false);
    },
  );

  test("lifecycle budget counts logical JSON instead of storage encoding", () => {
    const answer = LOSSLESS_JSON_STRING_PREFIX + "a".repeat(3500);
    const raw = toPostgresLosslessJson({ output: answer });
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(8192);
    const evidence = boundedChildLifecycleEvidence([
      { ...source, payload: raw, payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION },
    ]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.payload).toEqual({ output: answer });
    expect(
      boundedChildLifecycleEvidence([
        {
          ...source,
          payload: toPostgresLosslessJson({ output: "\u0000".repeat(2000) }),
          payloadCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        },
      ]),
    ).toEqual([]);
  });
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
