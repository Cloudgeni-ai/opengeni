import { describe, expect, test } from "bun:test";
import {
  MODEL_TIMELINE_ANNOTATIONS_FIELD,
  numberTimelineAnnotations,
  renderTimelineAnnotationsForModel,
} from "@opengeni/contracts";
import { durableUserHistoryItem, memoryTextForStorage } from "../src";

function syntheticExactText(): string {
  const tokenLike = ["sk", "-", "synthetic_", "Z".repeat(24)].join("");
  const urlLike = [
    "https://example.test/?",
    "sig",
    "=synthetic-signed-value&",
    "token",
    "=synthetic-query-value",
  ].join("");
  const pemLike = [
    "-----BEGIN ",
    "PRIVATE ",
    "KEY-----\nsynthetic\n-----END ",
    "PRIVATE ",
    "KEY-----\n",
  ].join("");
  return [
    "\n  const header = ",
    JSON.stringify(["Bear", "er ", tokenLike].join("")),
    ";\n",
    `TOKEN=${tokenLike}\n`,
    `${urlLike}\n`,
    pemLike,
    "tabs\tand  repeated spaces 👩🏽‍💻",
  ].join("");
}

describe("exact DB-bound content", () => {
  test("durable user history preserves accepted prompt text exactly", () => {
    const text = syntheticExactText();
    expect(durableUserHistoryItem(text, [])).toEqual({
      type: "message",
      role: "user",
      content: text,
    });
  });

  test("workspace memory preserves arbitrary accepted text exactly", () => {
    const text = syntheticExactText();
    expect(memoryTextForStorage(text)).toBe(text);
  });

  test("durable user history retains structured annotations beside deterministic model text", () => {
    const annotations = numberTimelineAnnotations([
      {
        id: "00000000-0000-4000-8000-000000000301",
        source: {
          kind: "tool_output",
          eventId: "00000000-0000-4000-8000-000000000302",
          eventType: "agent.toolCall.output",
          sequence: 12,
          turnId: "00000000-0000-4000-8000-000000000303",
          startOffset: 0,
          endOffset: 2,
          contextBefore: "",
          contextAfter: "",
          label: "exec_command",
        },
        quote: "ok",
        note: "Use this result.",
      },
    ]);
    expect(durableUserHistoryItem("Continue", [], annotations)).toEqual({
      type: "message",
      role: "user",
      content: renderTimelineAnnotationsForModel("Continue", annotations),
      [MODEL_TIMELINE_ANNOTATIONS_FIELD]: annotations,
    });
  });
});
