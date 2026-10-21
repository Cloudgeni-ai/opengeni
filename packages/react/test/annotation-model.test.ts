import { describe, expect, test } from "bun:test";
import {
  annotationFromSelection,
  bestQuoteOccurrence,
  occurrenceOffsets,
} from "../src/timeline/annotation-model";
import type { TimelineAnnotationSourceDescriptor } from "../src/timeline/types";

function source(text: string): TimelineAnnotationSourceDescriptor {
  return {
    kind: "assistant_message",
    eventId: "event-1",
    eventType: "agent.message.completed",
    sequence: 7,
    turnId: "turn-1",
    text,
  };
}

describe("annotationFromSelection", () => {
  test("records offsets and context for a selection that matches the source", () => {
    const annotation = annotationFromSelection(
      source("Ship the fix today. Then tell the team."),
      { text: "the fix" },
      "id-1",
    );
    expect(annotation).toEqual({
      id: "id-1",
      quote: "the fix",
      note: "",
      source: {
        kind: "assistant_message",
        eventId: "event-1",
        eventType: "agent.message.completed",
        sequence: 7,
        turnId: "turn-1",
        startOffset: 5,
        endOffset: 12,
        contextBefore: "Ship ",
        contextAfter: " today. Then tell the team.",
      },
    });
  });

  test("picks the occurrence whose surrounding rendered text agrees", () => {
    const text = "Run the tests.\n\nThen run the tests again on CI.";
    const annotation = annotationFromSelection(source(text), {
      text: "the tests",
      textBefore: "Then run ",
      textAfter: " again on CI.",
    });
    expect(annotation?.source.startOffset).toBe(text.lastIndexOf("the tests"));
  });

  test("an explicit occurrence wins over context", () => {
    const text = "a word, a word";
    const annotation = annotationFromSelection(source(text), { text: "a word", occurrence: 1 });
    expect(annotation?.source.startOffset).toBe(8);
  });

  test("a selection across markdown syntax falls back to its longest verbatim part", () => {
    const annotation = annotationFromSelection(source("Use **bold** text for emphasis here"), {
      text: "Use bold text for emphasis",
    });
    expect(annotation?.quote).toBe(" text for emphasis");
  });

  test("rejects empty and unmatched selections", () => {
    expect(annotationFromSelection(source("hello"), { text: "   " })).toBeNull();
    expect(annotationFromSelection(source("hello"), { text: "goodbye" })).toBeNull();
  });
});

describe("bestQuoteOccurrence", () => {
  test("a single occurrence needs no context", () => {
    expect(bestQuoteOccurrence("abc", "b", occurrenceOffsets("abc", "b"), "", "")).toBe(0);
  });
});
