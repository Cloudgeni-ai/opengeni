import { describe, expect, test } from "bun:test";
import {
  notificationPlainText,
  parseNotificationText,
  timelineGroupIndexAtSequence,
} from "../src/timeline-model";
import type { TimelineGroup } from "../src/timeline/types";

describe("notification text", () => {
  test("paragraphs, bullets and inline marks; only https links link", () => {
    expect(
      parseNotificationText(
        "Deployed **all** services.\nSee `smoke`.\n\n- api\n- web: [notes](https://example.com/n)\n- [x](http://insecure)",
      ),
    ).toEqual([
      {
        kind: "paragraph",
        spans: [
          { kind: "text", text: "Deployed " },
          { kind: "bold", text: "all" },
          { kind: "text", text: " services.\nSee " },
          { kind: "code", text: "smoke" },
          { kind: "text", text: "." },
        ],
      },
      {
        kind: "bullets",
        items: [
          [{ kind: "text", text: "api" }],
          [
            { kind: "text", text: "web: " },
            { kind: "link", text: "notes", href: "https://example.com/n" },
          ],
          [{ kind: "text", text: "[x](http://insecure)" }],
        ],
      },
    ]);
    expect(notificationPlainText("**Done**\n- a\n- b")).toBe("Done\n• a\n• b");
    expect(parseNotificationText("  \n\n")).toEqual([]);
  });

  test("source links lose hosted-search tracking and keep page parameters", () => {
    expect(
      parseNotificationText(
        "See [the rule](https://example.com/rules/4-1?_t_q=which+rule&utm_source=openai)",
      ),
    ).toEqual([
      {
        kind: "paragraph",
        spans: [
          { kind: "text", text: "See " },
          { kind: "link", text: "the rule", href: "https://example.com/rules/4-1" },
        ],
      },
    ]);
    expect(notificationPlainText("- https://example.com/watch?v=abc&utm_source=openai")).toBe(
      "• https://example.com/watch?v=abc",
    );
  });
});

describe("landing on a moment", () => {
  const item = (id: string, sequence: number) =>
    ({
      kind: "item",
      item: {
        kind: "user-message",
        id,
        text: id,
        sourceEvents: [{ eventId: id, sequence }],
      },
    }) as unknown as TimelineGroup;
  const groups = [item("a", 10), item("b", 20), item("c", 30)];

  test("lands on the group holding the moment, else the last one before it", () => {
    expect(timelineGroupIndexAtSequence(groups, 20)).toBe(1);
    expect(timelineGroupIndexAtSequence(groups, 25)).toBe(1);
    expect(timelineGroupIndexAtSequence(groups, 99)).toBe(2);
    // Older than everything loaded: the caller loads older history first.
    expect(timelineGroupIndexAtSequence(groups, 5)).toBe(-1);
  });
});
