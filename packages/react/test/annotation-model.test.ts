import { describe, expect, test } from "bun:test";
import {
  renderedMarkdownQuote,
  renderedSpansForSourceQuote,
  sourceSpansForRenderedText,
} from "../src/timeline/annotation-alignment";
import {
  annotationFromSelection,
  annotationQuoteText,
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

  test("a selection across bold and a link keeps all of it", () => {
    const text =
      "For the new subscription: do you mean **Claude Max 20x on** [me@example.com](mailto:me@example.com), or another **Codex Pro** account?";
    const annotation = annotationFromSelection(source(text), {
      text: "do you mean Claude Max 20x on me@example.com",
    });
    expect(annotation?.quote).toBe(
      "do you mean **Claude Max 20x on** [me@example.com](mailto:me@example.com)",
    );
    expect(annotation?.source.startOffset).toBe(text.indexOf("do you mean"));
    expect(annotation?.source.contextBefore).toBe("For the new subscription: ");
    expect(annotation && annotationQuoteText(annotation)).toBe(
      "do you mean Claude Max 20x on me@example.com",
    );
  });

  test("a selection starting inside bold text opens the emphasis it closes", () => {
    const annotation = annotationFromSelection(source("Use **bold text** for emphasis here"), {
      text: "text for emphasis",
    });
    expect(annotation?.quote).toBe("**bold text** for emphasis");
  });

  test("a selection across list items and paragraphs maps onto the markdown", () => {
    const text = "Steps:\n\n1. Open the *settings* page\n2. Turn on `calls`\n\nThen wait.";
    // Range.toString() joins rendered blocks without separators.
    const annotation = annotationFromSelection(source(text), {
      text: "settings pageTurn on callsThen",
    });
    expect(annotation?.quote).toBe("*settings* page\n2. Turn on `calls`\n\nThen");
  });

  test("repeated formatted text picks the counted occurrence", () => {
    const text = "Pick **one** thing. Then pick **one** more.";
    const annotation = annotationFromSelection(source(text), { text: "pick one", occurrence: 0 });
    expect(annotation?.source.startOffset).toBe(text.indexOf("pick **one**"));
    expect(annotation?.quote).toBe("pick **one**");
  });

  test("text whose rendering differs from its source keeps the matching part", () => {
    const annotation = annotationFromSelection(source("The area is \\(x^2\\) square metres here"), {
      text: "The area is x2 square metres",
    });
    expect(annotation?.quote).toBe("The area is ");
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

describe("markdown alignment", () => {
  test("finds rendered text in source markdown and back", () => {
    const markdown = "See [the docs](https://example.com/a_(b)) and **ship** it.";
    const spans = sourceSpansForRenderedText(markdown, "the docs and ship");
    expect(spans).toHaveLength(1);
    const quote = markdown.slice(spans[0]!.start, spans[0]!.end);
    expect(quote).toBe("[the docs](https://example.com/a_(b)) and **ship**");
    const rendered = "See the docs and ship it.";
    const back = renderedSpansForSourceQuote(rendered, quote);
    expect(back.map((span) => rendered.slice(span.start, span.end))).toEqual(["the docs and ship"]);
  });

  test("shows quotes the way the message renders them", () => {
    expect(renderedMarkdownQuote("do **this** and [that](https://x.y) with `code` now")).toBe(
      "do this and that with code now",
    );
    expect(renderedMarkdownQuote("- one\n- two")).toBe("one\ntwo");
    expect(renderedMarkdownQuote("snake_case and 2 * 3")).toBe("snake_case and 2 * 3");
  });

  test("tool output quotes are shown verbatim", () => {
    expect(annotationQuoteText({ quote: "__init__ **x**", source: { kind: "tool_output" } })).toBe(
      "__init__ **x**",
    );
  });
});
